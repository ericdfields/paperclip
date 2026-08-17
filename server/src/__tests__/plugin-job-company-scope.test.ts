/**
 * Company-scoped plugin jobs.
 *
 * Regression coverage for the defect where a scheduled job got no invocation
 * scope at all: `runJob` shipped without a company, the worker's
 * `AsyncLocalStorage` was never populated, and so every company-scoped host
 * call the handler made (`config.get`, `secrets.resolve`, `issues.*`, company
 * `state.*`) was refused with "company context is required" — on every tick,
 * forever, while the scheduler still recorded the run as succeeded.
 *
 * These run against a real embedded Postgres because the fan-out set is a SQL
 * anti-join over `plugin_company_settings`, and getting that join wrong is the
 * difference between "runs for the right tenants" and "runs for tenants that
 * disabled the plugin".
 *
 * @see doc/plugins/PLUGIN_SPEC.md §17.1 — Job scope
 */

import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  createDb,
  pluginCompanySettings,
  pluginJobs,
  pluginJobRuns,
  plugins,
} from "@paperclipai/db";
import { pluginJobStore } from "../services/plugin-job-store.js";
import { createPluginJobScheduler } from "../services/plugin-job-scheduler.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin job company-scope tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

/** The `job` payload of a captured `runJob` RPC call. */
type CapturedJob = {
  jobKey: string;
  runId: string;
  trigger: string;
  scheduledAt: string;
  companyId: string | null;
};

describeEmbeddedPostgres("company-scoped plugin jobs", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-job-company-scope-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginJobRuns);
    await db.delete(pluginJobs);
    await db.delete(pluginCompanySettings);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin(): Promise<string> {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: "paperclip.job-company-scope-test",
      packageName: "@paperclipai/plugin-job-company-scope-test",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: "paperclip.job-company-scope-test",
        apiVersion: 1,
        version: "0.0.1",
        displayName: "Job Company Scope Test",
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder: 1,
    });
    return pluginId;
  }

  async function seedCompany(name: string, status = "active"): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name,
      status,
      issuePrefix: issuePrefix(companyId),
    });
    return companyId;
  }

  /**
   * A scheduler wired to the real store and DB, with the worker faked so the
   * test can read exactly what the `runJob` RPC would have carried.
   */
  function createHarness(options: { runJob?: () => Promise<void> } = {}) {
    const jobStore = pluginJobStore(db);
    const captured: CapturedJob[] = [];

    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, method: string, params: any) => {
        if (method === "runJob") {
          captured.push(params.job as CapturedJob);
          if (options.runJob) await options.runJob();
        }
        return null;
      }),
    } as any;

    const scheduler = createPluginJobScheduler({ db, jobStore, workerManager });
    return { jobStore, workerManager, scheduler, captured };
  }

  /** Insert a due job row directly — the scheduler picks up anything past `nextRunAt`. */
  async function seedDueJob(
    pluginId: string,
    scope: "instance" | "company",
  ): Promise<string> {
    const jobId = randomUUID();
    await db.insert(pluginJobs).values({
      id: jobId,
      pluginId,
      jobKey: "sweep",
      schedule: "*/5 * * * *",
      scope,
      status: "active",
      nextRunAt: new Date(Date.now() - 60_000),
    });
    return jobId;
  }

  async function runsForJob(jobId: string) {
    return db
      .select()
      .from(pluginJobRuns)
      .where(eq(pluginJobRuns.jobId, jobId))
      .orderBy(asc(pluginJobRuns.companyId));
  }

  // -------------------------------------------------------------------------
  // Manifest → DB
  // -------------------------------------------------------------------------

  it("defaults a job with no declared scope to instance scope", async () => {
    const pluginId = await seedPlugin();
    const jobStore = pluginJobStore(db);

    await jobStore.syncJobDeclarations(pluginId, [
      { jobKey: "sweep", displayName: "Sweep", schedule: "*/5 * * * *" },
    ]);

    const [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
    expect(job?.scope).toBe("instance");
  });

  it("persists a declared company scope, and a later change to it", async () => {
    const pluginId = await seedPlugin();
    const jobStore = pluginJobStore(db);

    await jobStore.syncJobDeclarations(pluginId, [
      { jobKey: "sweep", displayName: "Sweep", schedule: "*/5 * * * *", scope: "company" },
    ]);
    let [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
    expect(job?.scope).toBe("company");

    // A plugin that narrows the job back to instance scope must actually lose
    // the company fan-out — a stale `scope` would keep minting scopes the
    // manifest no longer asks for.
    await jobStore.syncJobDeclarations(pluginId, [
      { jobKey: "sweep", displayName: "Sweep", schedule: "*/5 * * * *", scope: "instance" },
    ]);
    [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.pluginId, pluginId));
    expect(job?.scope).toBe("instance");
  });

  // -------------------------------------------------------------------------
  // The fan-out set
  // -------------------------------------------------------------------------

  it("counts a company with no settings row as enabled, and excludes disabled and non-active companies", async () => {
    const pluginId = await seedPlugin();
    const jobStore = pluginJobStore(db);

    const enabledByDefault = await seedCompany("no settings row");
    const explicitlyEnabled = await seedCompany("enabled = true");
    const disabled = await seedCompany("enabled = false");
    const paused = await seedCompany("paused", "paused");

    await db.insert(pluginCompanySettings).values([
      { pluginId, companyId: explicitlyEnabled, enabled: true },
      { pluginId, companyId: disabled, enabled: false },
    ]);

    const ids = await jobStore.listEnabledCompanyIds(pluginId);

    expect([...ids].sort()).toEqual([enabledByDefault, explicitlyEnabled].sort());
    expect(ids).not.toContain(disabled);
    expect(ids).not.toContain(paused);
  });

  it("does not let another plugin's disable row shrink this plugin's fan-out", async () => {
    const pluginId = await seedPlugin();
    const otherPluginId = randomUUID();
    await db.insert(plugins).values({
      id: otherPluginId,
      pluginKey: "paperclip.other",
      packageName: "@paperclipai/plugin-other",
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {},
      status: "ready",
      installOrder: 2,
    });

    const companyId = await seedCompany("disabled for the other plugin only");
    await db.insert(pluginCompanySettings).values({
      pluginId: otherPluginId,
      companyId,
      enabled: false,
    });

    const jobStore = pluginJobStore(db);
    await expect(jobStore.listEnabledCompanyIds(pluginId)).resolves.toEqual([companyId]);
    await expect(jobStore.listEnabledCompanyIds(otherPluginId)).resolves.toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Dispatch — the actual defect
  // -------------------------------------------------------------------------

  it("sends a companyId with runJob for every enabled company, and records it on the run", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const jobId = await seedDueJob(pluginId, "company");

    const { scheduler, captured } = createHarness();
    await scheduler.tick();

    expect(captured).toHaveLength(2);
    expect(captured.map((job) => job.companyId).sort()).toEqual([companyA, companyB].sort());
    for (const job of captured) {
      expect(job.jobKey).toBe("sweep");
      expect(job.trigger).toBe("schedule");
    }

    const runs = await runsForJob(jobId);
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.companyId).sort()).toEqual([companyA, companyB].sort());
    expect(runs.every((run) => run.status === "succeeded")).toBe(true);
  });

  it("skips a company that has disabled the plugin", async () => {
    const pluginId = await seedPlugin();
    const included = await seedCompany("included");
    const excluded = await seedCompany("excluded");
    await db.insert(pluginCompanySettings).values({
      pluginId,
      companyId: excluded,
      enabled: false,
    });
    await seedDueJob(pluginId, "company");

    const { scheduler, captured } = createHarness();
    await scheduler.tick();

    expect(captured.map((job) => job.companyId)).toEqual([included]);
  });

  it("dispatches nothing — and does not fail — when a company-scoped job has no enabled companies", async () => {
    const pluginId = await seedPlugin();
    const jobId = await seedDueJob(pluginId, "company");

    const { scheduler, captured } = createHarness();
    await scheduler.tick();

    expect(captured).toHaveLength(0);
    await expect(runsForJob(jobId)).resolves.toHaveLength(0);

    // The pointer still advances, so the job is not stuck permanently due.
    const [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.id, jobId));
    expect(job?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it("leaves an instance-scoped job unscoped — one run, companyId null", async () => {
    const pluginId = await seedPlugin();
    await seedCompany("A");
    await seedCompany("B");
    const jobId = await seedDueJob(pluginId, "instance");

    const { scheduler, captured } = createHarness();
    await scheduler.tick();

    expect(captured).toHaveLength(1);
    expect(captured[0]?.companyId).toBeNull();

    const runs = await runsForJob(jobId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.companyId).toBeNull();
  });

  it("records a run as failed when the handler throws, per company", async () => {
    const pluginId = await seedPlugin();
    await seedCompany("A");
    await seedCompany("B");
    const jobId = await seedDueJob(pluginId, "company");

    const { scheduler } = createHarness({
      runJob: async () => {
        throw new Error("handler exploded");
      },
    });
    await scheduler.tick();

    const runs = await runsForJob(jobId);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === "failed")).toBe(true);
    expect(runs.every((run) => run.error === "handler exploded")).toBe(true);
    expect(runs.every((run) => run.companyId !== null)).toBe(true);
  });

  it("does not let one company's failure suppress another company's run", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany("A");
    const companyB = await seedCompany("B");
    const jobId = await seedDueJob(pluginId, "company");

    const failFor = [companyA, companyB].sort()[0]!;
    const jobStore = pluginJobStore(db);
    const workerManager = {
      isRunning: vi.fn(() => true),
      call: vi.fn(async (_pluginId: string, _method: string, params: any) => {
        if (params.job.companyId === failFor) throw new Error("only this company fails");
        return null;
      }),
    } as any;
    const scheduler = createPluginJobScheduler({ db, jobStore, workerManager });

    await scheduler.tick();

    const runs = await runsForJob(jobId);
    expect(runs).toHaveLength(2);
    const byCompany = new Map(runs.map((run) => [run.companyId, run.status]));
    expect(byCompany.get(failFor)).toBe("failed");
    expect([...byCompany.values()].filter((status) => status === "succeeded")).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Manual trigger
  // -------------------------------------------------------------------------

  it("refuses to trigger a company-scoped job without a company", async () => {
    const pluginId = await seedPlugin();
    await seedCompany("A");
    const jobId = await seedDueJob(pluginId, "company");

    const { scheduler } = createHarness();
    await expect(scheduler.triggerJob(jobId, "manual")).rejects.toThrow(
      /company-scoped/,
    );
    await expect(runsForJob(jobId)).resolves.toHaveLength(0);
  });

  it("refuses to trigger a company-scoped job for a company that disabled the plugin", async () => {
    const pluginId = await seedPlugin();
    const disabled = await seedCompany("disabled");
    await db.insert(pluginCompanySettings).values({
      pluginId,
      companyId: disabled,
      enabled: false,
    });
    const jobId = await seedDueJob(pluginId, "company");

    const { scheduler } = createHarness();
    await expect(scheduler.triggerJob(jobId, "manual", disabled)).rejects.toThrow(
      /not enabled for company/,
    );
    await expect(runsForJob(jobId)).resolves.toHaveLength(0);
  });

  it("refuses to trigger an instance-scoped job for a company", async () => {
    const pluginId = await seedPlugin();
    const companyId = await seedCompany("A");
    const jobId = await seedDueJob(pluginId, "instance");

    const { scheduler } = createHarness();
    await expect(scheduler.triggerJob(jobId, "manual", companyId)).rejects.toThrow(
      /instance-scoped/,
    );
    await expect(runsForJob(jobId)).resolves.toHaveLength(0);
  });

  it("triggers a company-scoped job for one enabled company", async () => {
    const pluginId = await seedPlugin();
    const companyA = await seedCompany("A");
    await seedCompany("B");
    const jobId = await seedDueJob(pluginId, "company");

    const { scheduler, captured } = createHarness();
    const result = await scheduler.triggerJob(jobId, "manual", companyA);

    expect(result.companyId).toBe(companyA);

    // The dispatch is intentionally backgrounded; wait for it to land.
    await vi.waitFor(async () => {
      const runs = await runsForJob(jobId);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.status).toBe("succeeded");
    });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.companyId).toBe(companyA);
    expect(captured[0]?.trigger).toBe("manual");
  });
});
