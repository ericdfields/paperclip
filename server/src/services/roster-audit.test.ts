import { describe, expect, it } from "vitest";
import { auditRoster } from "./roster-audit.js";

describe("roster audit", () => {
  it("reports drift without recommending destructive actions", () => {
    const report = auditRoster(
      [{ id: "repo-1", name: "CEO", role: "lead" }, { name: "Missing", role: "engineer" }],
      [
        { id: "repo-1", name: "CEO", role: "lead", status: "idle", hasCostHistory: true },
        { id: "db-1", name: "Live", role: "engineer", status: "error", hasCostHistory: false },
      ],
    );
    expect(report.repoOnlyAgents).toHaveLength(1);
    expect(report.dbOnlyAgents).toHaveLength(1);
    expect(report.agentsWithNoCostHistory).toHaveLength(1);
    expect(report.agentsInError).toHaveLength(1);
    expect(report.remediation.action).toBe("operator_review_only");
  });
});
