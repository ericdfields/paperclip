import { and, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies, costEvents } from "@paperclipai/db";

/** Bumped only when a catalog entry or alias changes. Runtime pricing lookups are intentionally not used. */
export const PRICING_CATALOG_VERSION = "2026-08-19.v1";

type Price = { inputCentsPerMillion: number; cachedInputCentsPerMillion?: number; outputCentsPerMillion: number };

const CATALOG: Record<string, Price> = {
  "anthropic:claude-sonnet-4-5": { inputCentsPerMillion: 300, cachedInputCentsPerMillion: 30, outputCentsPerMillion: 1500 },
  "anthropic:claude-opus-4-1": { inputCentsPerMillion: 1500, cachedInputCentsPerMillion: 150, outputCentsPerMillion: 7500 },
  "openai:gpt-4o": { inputCentsPerMillion: 250, cachedInputCentsPerMillion: 125, outputCentsPerMillion: 1000 },
  "openai:gpt-4o-mini": { inputCentsPerMillion: 15, cachedInputCentsPerMillion: 8, outputCentsPerMillion: 60 },
  "openai:gpt-5": { inputCentsPerMillion: 125, cachedInputCentsPerMillion: 13, outputCentsPerMillion: 1000 },
  "google:gemini-2-5-pro": { inputCentsPerMillion: 125, cachedInputCentsPerMillion: 13, outputCentsPerMillion: 1000 },
};

const ALIASES: Record<string, string> = {
  "claude-sonnet-4-5-20250929": "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929[1m]": "claude-sonnet-4-5",
  "claude-opus-4-1-20250805": "claude-opus-4-1",
  "gpt-4o-2024-05-13": "gpt-4o",
  "gpt-4o-mini-2024-07-18": "gpt-4o-mini",
};

export function normalizePricingIdentifier(value: string | null | undefined): string {
  return (value ?? "")
    .trim().toLowerCase().replace(/^models[/:]/, "").replace(/^anthropic[/:]/, "")
    .replace(/^openai[/:]/, "").replace(/^google[/:]/, "").replace(/\[1m\]$/, "")
    .replace(/\s+/g, "-");
}

export function resolveCatalogPrice(provider: string, biller: string | null | undefined, model: string) {
  const providerKey = normalizePricingIdentifier(provider || biller);
  const modelKey = ALIASES[normalizePricingIdentifier(model)] ?? normalizePricingIdentifier(model);
  const key = `${providerKey}:${modelKey}`;
  const price = CATALOG[key] ?? CATALOG[`${normalizePricingIdentifier(biller)}:${modelKey}`];
  return price ? { ...price, key, catalogVersion: PRICING_CATALOG_VERSION } : null;
}

export function catalogCostCents(input: {
  provider: string; biller?: string | null; model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number;
}) {
  const price = resolveCatalogPrice(input.provider, input.biller, input.model);
  if (!price) return null;
  const uncachedInput = Math.max(0, input.inputTokens - input.cachedInputTokens);
  const cents = (uncachedInput * price.inputCentsPerMillion
    + input.cachedInputTokens * (price.cachedInputCentsPerMillion ?? price.inputCentsPerMillion)
    + input.outputTokens * price.outputCentsPerMillion) / 1_000_000;
  return { costCents: Math.max(0, Math.ceil(cents)), pricingCatalogVersion: price.catalogVersion };
}

export function classifyCost(input: {
  provider: string; biller?: string | null; model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; costCents: number; billingType?: string | null; costStatus?: string | null;
}) {
  if (input.costStatus === "unpriced") return { costStatus: "unpriced" as const, pricingCatalogVersion: null, costCents: input.costCents };
  if (input.billingType === "subscription_included") return { costStatus: "reported" as const, pricingCatalogVersion: null, costCents: 0 };
  if (input.costCents > 0) return { costStatus: "reported" as const, pricingCatalogVersion: null, costCents: input.costCents };
  const estimated = catalogCostCents(input);
  return estimated ? { costStatus: "reported" as const, ...estimated } : { costStatus: "unpriced" as const, pricingCatalogVersion: null, costCents: 0 };
}

export async function repairHistoricalPricing(db: Db, input: { companyId: string; apply: boolean }) {
  const rows = await db.select().from(costEvents).where(and(
    eq(costEvents.companyId, input.companyId),
    or(eq(costEvents.costStatus, "unpriced"), isNull(costEvents.pricingCatalogVersion)),
  ));
  const matched: string[] = [];
  if (input.apply) {
    await db.transaction(async (tx) => {
      for (const row of rows) {
        const estimate = catalogCostCents(row);
        if (!estimate) continue;
        await tx.update(costEvents).set({ costCents: estimate.costCents, costStatus: "reported", pricingCatalogVersion: estimate.pricingCatalogVersion }).where(eq(costEvents.id, row.id));
        matched.push(row.id);
      }
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const agentTotals = await tx.select({ agentId: costEvents.agentId, total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)` }).from(costEvents).where(and(eq(costEvents.companyId, input.companyId), gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end))).groupBy(costEvents.agentId);
      for (const total of agentTotals) await tx.update(agents).set({ spentMonthlyCents: Number(total.total), updatedAt: now }).where(eq(agents.id, total.agentId));
      const [companyTotal] = await tx.select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)` }).from(costEvents).where(and(eq(costEvents.companyId, input.companyId), gte(costEvents.occurredAt, start), lt(costEvents.occurredAt, end)));
      await tx.update(companies).set({ spentMonthlyCents: Number(companyTotal?.total ?? 0), updatedAt: now }).where(eq(companies.id, input.companyId));
    });
  } else {
    for (const row of rows) if (catalogCostCents(row)) matched.push(row.id);
  }
  return { companyId: input.companyId, dryRun: !input.apply, catalogVersion: PRICING_CATALOG_VERSION, scanned: rows.length, confidentlyMatched: matched.length, updatedEventIds: input.apply ? matched : [] };
}
