import { describe, expect, it } from "vitest";
import {
  PRICING_CATALOG_VERSION,
  catalogCostCents,
  classifyCost,
  normalizePricingIdentifier,
  resolveCatalogPrice,
} from "./pricing-catalog.js";

describe("pricing catalog", () => {
  it("normalizes provider prefixes, dated ids, and the 1m suffix", () => {
    expect(normalizePricingIdentifier("models/openai:gpt-4o[1m]")).toBe("gpt-4o");
    expect(resolveCatalogPrice("openai", "OpenAI", "gpt-4o-2024-05-13[1m]")?.catalogVersion)
      .toBe(PRICING_CATALOG_VERSION);
  });

  it("calculates catalog pricing using cached input separately", () => {
    expect(catalogCostCents({
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      outputTokens: 1_000_000,
    })).toEqual({ costCents: 1188, pricingCatalogVersion: PRICING_CATALOG_VERSION });
  });

  it("does not guess unknown models and preserves explicit unpriced events", () => {
    expect(catalogCostCents({ provider: "unknown", model: "mystery", inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 })).toBeNull();
    expect(classifyCost({ provider: "openai", model: "gpt-4o", inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, costCents: 0, billingType: "subscription_included", costStatus: "unpriced" }))
      .toMatchObject({ costStatus: "unpriced", costCents: 0 });
  });
});
