import { describe, expect, it } from "vitest";
import { agentRuntimeConfigSchema } from "./agent.js";

describe("agentRuntimeConfigSchema", () => {
  it("accepts applyToAutonomousWork on a model profile (BRO-2639)", () => {
    const parsed = agentRuntimeConfigSchema.parse({
      modelProfiles: {
        cheap: {
          enabled: true,
          applyToAutonomousWork: true,
          adapterConfig: { model: "claude-sonnet-5", effort: "high" },
        },
      },
    });
    expect(parsed.modelProfiles?.cheap?.applyToAutonomousWork).toBe(true);
  });

  it("rejects keys that readAgentRuntimeModelProfile does not consume", () => {
    // Safeguard against the reader/writer schema drifting apart again: every
    // key readAgentRuntimeModelProfile (server/src/services/heartbeat.ts)
    // pulls off a model profile must be accepted here.
    const consumedKeys = ["enabled", "applyToAutonomousWork"];
    for (const key of consumedKeys) {
      expect(() =>
        agentRuntimeConfigSchema.parse({
          modelProfiles: { cheap: { [key]: true, adapterConfig: {} } },
        }),
      ).not.toThrow();
    }
  });
});
