import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  ENVIRONMENT_LEASE_CLEANUP_STATUSES,
  ENVIRONMENT_LEASE_STATUSES,
  ISSUE_TREE_HOLD_STATUSES,
  WAKEUP_REQUEST_STATUSES,
} from "@paperclipai/shared";

const expected = {
  agent_wakeup_requests_status_check: WAKEUP_REQUEST_STATUSES,
  environment_leases_status_check: ENVIRONMENT_LEASE_STATUSES,
  environment_leases_cleanup_status_check: ENVIRONMENT_LEASE_CLEANUP_STATUSES,
  issue_tree_holds_status_check: ISSUE_TREE_HOLD_STATUSES,
} as const;

describe("status category constraints", () => {
  it("pins every database check to its shared status constant", async () => {
    const migration = await readFile(new URL("./migrations/0227_status_category_checks.sql", import.meta.url), "utf8");

    for (const [name, statuses] of Object.entries(expected)) {
      const statement = migration.split("--> statement-breakpoint").find((part) => part.includes(`ADD CONSTRAINT \"${name}\"`));
      expect(statement, name).toBeDefined();
      const values = [...statement!.matchAll(/'([^']+)'/g)].map((match) => match[1]);
      expect(values, name).toEqual([...statuses]);
      expect(statement, name).toContain("NOT VALID");
      expect(migration).toContain(`VALIDATE CONSTRAINT \"${name}\"`);
    }
  });
});
