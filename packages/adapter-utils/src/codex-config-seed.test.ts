import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  describeCodexSeedSanitization,
  seedSanitizedCodexConfigToml,
  stripInheritedCodexModelSelection,
} from "./codex-config-seed.js";

// The real-world config that motivated this sanitizer: a host `~/.codex` pinning
// a local OpenAI-compatible gateway whose API key env var is not set, so every
// managed run seeded from it died with `Missing environment variable: OMLX_API_KEY`.
const HOST_CONFIG = `model_provider = "omlx"
model = "Qwen3.5-9B-MLX-4bit"
personality = "pragmatic"

[mcp_servers.pencil]
command = "pencil"

[model_providers.omlx]
name = "oMLX"
base_url = "http://127.0.0.1:8008/v1"
env_key = "OMLX_API_KEY"
`;

describe("stripInheritedCodexModelSelection", () => {
  it("removes the root model/provider pins and keeps everything else", () => {
    const result = stripInheritedCodexModelSelection(HOST_CONFIG);

    expect(result.removedKeys).toEqual(["model_provider", "model"]);
    expect(result.content).toBe(`personality = "pragmatic"

[mcp_servers.pencil]
command = "pencil"

[model_providers.omlx]
name = "oMLX"
base_url = "http://127.0.0.1:8008/v1"
env_key = "OMLX_API_KEY"
`);
    // The provider *definition* is inert without a selector, so it is preserved
    // for anyone who later selects it through a supported path.
    expect(result.content).toContain("[model_providers.omlx]");
  });

  it("leaves a config with no root selection byte-for-byte identical", () => {
    const clean = `personality = "pragmatic"\n\n[model_providers.omlx]\nenv_key = "OMLX_API_KEY"\n`;
    const result = stripInheritedCodexModelSelection(clean);

    expect(result.content).toBe(clean);
    expect(result.removedKeys).toEqual([]);
    expect(result.hasIndirectSelection).toBe(false);
  });

  it("only matches the exact keys, not keys that share their prefix", () => {
    const config = `model_reasoning_effort = "high"
models = ["a"]
model_verbosity = "low"
`;
    const result = stripInheritedCodexModelSelection(config);

    expect(result.removedKeys).toEqual([]);
    expect(result.content).toBe(config);
  });

  it("does not touch a model selection that lives inside a table", () => {
    const config = `personality = "pragmatic"

[profiles.local]
model = "Qwen3.5-9B-MLX-4bit"
model_provider = "omlx"
`;
    const result = stripInheritedCodexModelSelection(config);

    expect(result.removedKeys).toEqual([]);
    expect(result.content).toBe(config);
  });

  it("removes quoted and literal-quoted forms of the same keys", () => {
    const result = stripInheritedCodexModelSelection(
      `"model_provider" = "omlx"\n'model' = "qwen"\npersonality = "pragmatic"\n`,
    );

    expect(result.removedKeys).toEqual(["model_provider", "model"]);
    expect(result.content).toBe(`personality = "pragmatic"\n`);
  });

  it("removes indented and whitespace-padded assignments", () => {
    const result = stripInheritedCodexModelSelection(
      `  model_provider   =   "omlx"\npersonality = "pragmatic"\n`,
    );

    expect(result.removedKeys).toEqual(["model_provider"]);
    expect(result.content).toBe(`personality = "pragmatic"\n`);
  });

  it("drops the continuation lines of a removed multi-line string value", () => {
    // Leaving the trailing `"""` behind would turn the whole file into a TOML
    // parse error — strictly worse than the pin we set out to remove.
    const result = stripInheritedCodexModelSelection(
      `model = """\nqwen\n"""\npersonality = "pragmatic"\n`,
    );

    expect(result.removedKeys).toEqual(["model"]);
    expect(result.content).toBe(`personality = "pragmatic"\n`);
  });

  it("does not over-skip when a multi-line delimiter opens and closes on one line", () => {
    const result = stripInheritedCodexModelSelection(
      `model = """qwen"""\npersonality = "pragmatic"\n`,
    );

    expect(result.removedKeys).toEqual(["model"]);
    expect(result.content).toBe(`personality = "pragmatic"\n`);
  });

  it("reports a surviving root profile key that could re-select a provider", () => {
    const result = stripInheritedCodexModelSelection(
      `profile = "local"\n\n[profiles.local]\nmodel_provider = "omlx"\n`,
    );

    expect(result.removedKeys).toEqual([]);
    expect(result.hasIndirectSelection).toBe(true);
    // Reported, not stripped: a profile also carries policy a user may want.
    expect(result.content).toContain(`profile = "local"`);
  });
});

describe("describeCodexSeedSanitization", () => {
  const homes = { sourceHome: "/host/.codex", targetHome: "/managed/codex-home" };

  it("returns null when there is nothing to report", () => {
    expect(
      describeCodexSeedSanitization({ removedKeys: [], hasIndirectSelection: false }, homes),
    ).toBeNull();
  });

  it("names the dropped keys and both homes", () => {
    const note = describeCodexSeedSanitization(
      { removedKeys: ["model_provider", "model", "model"], hasIndirectSelection: false },
      homes,
    );

    expect(note).toContain("model, model_provider");
    expect(note).toContain("/host/.codex");
    expect(note).toContain("/managed/codex-home");
    // Deduplicated: a repeated key is one dropped selection, not two.
    expect(note?.match(/model_provider/g)).toHaveLength(1);
  });

  it("warns about an inherited profile even when nothing was removed", () => {
    const note = describeCodexSeedSanitization(
      { removedKeys: [], hasIndirectSelection: true },
      homes,
    );

    expect(note).toContain("profile");
  });
});

describe("seedSanitizedCodexConfigToml", () => {
  async function withHomes(
    run: (input: { sourceHome: string; targetHome: string }) => Promise<void>,
  ): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-seed-toml-"));
    try {
      const sourceHome = path.join(root, "host-codex");
      const targetHome = path.join(root, "managed-codex");
      await fs.mkdir(sourceHome, { recursive: true });
      await run({ sourceHome, targetHome });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }

  it("seeds a fresh managed home without the host's model selection", async () => {
    await withHomes(async ({ sourceHome, targetHome }) => {
      await fs.writeFile(path.join(sourceHome, "config.toml"), HOST_CONFIG, "utf8");

      const result = await seedSanitizedCodexConfigToml({ sourceHome, targetHome });

      expect(result).toMatchObject({ wrote: true, removedKeys: ["model_provider", "model"] });
      const seeded = await fs.readFile(path.join(targetHome, "config.toml"), "utf8");
      expect(seeded).not.toMatch(/^\s*model_provider\s*=/m);
      expect(seeded).not.toMatch(/^\s*model\s*=/m);
      expect(seeded).toContain(`personality = "pragmatic"`);
    });
  });

  it("repairs a home that was already seeded with the pin", async () => {
    await withHomes(async ({ sourceHome, targetHome }) => {
      await fs.writeFile(path.join(sourceHome, "config.toml"), HOST_CONFIG, "utf8");
      await fs.mkdir(targetHome, { recursive: true });
      await fs.writeFile(path.join(targetHome, "config.toml"), HOST_CONFIG, "utf8");

      const result = await seedSanitizedCodexConfigToml({ sourceHome, targetHome });

      expect(result.wrote).toBe(true);
      const seeded = await fs.readFile(path.join(targetHome, "config.toml"), "utf8");
      expect(seeded).not.toMatch(/^\s*model_provider\s*=/m);
    });
  });

  it("does not re-copy the host config over an existing managed config", async () => {
    await withHomes(async ({ sourceHome, targetHome }) => {
      await fs.writeFile(path.join(sourceHome, "config.toml"), HOST_CONFIG, "utf8");
      const managed = path.join(targetHome, "config.toml");
      const operatorEdited = `personality = "terse"\n`;
      await fs.mkdir(targetHome, { recursive: true });
      await fs.writeFile(managed, operatorEdited, "utf8");

      const result = await seedSanitizedCodexConfigToml({ sourceHome, targetHome });

      expect(result.wrote).toBe(false);
      expect(await fs.readFile(managed, "utf8")).toBe(operatorEdited);
    });
  });

  it("writes the seeded config with mode 0600", async () => {
    await withHomes(async ({ sourceHome, targetHome }) => {
      await fs.writeFile(path.join(sourceHome, "config.toml"), HOST_CONFIG, {
        encoding: "utf8",
        mode: 0o644,
      });

      await seedSanitizedCodexConfigToml({ sourceHome, targetHome });

      const stat = await fs.stat(path.join(targetHome, "config.toml"));
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  it("refuses to touch the host home when source and target are the same", async () => {
    await withHomes(async ({ sourceHome }) => {
      const hostConfig = path.join(sourceHome, "config.toml");
      await fs.writeFile(hostConfig, HOST_CONFIG, "utf8");

      const result = await seedSanitizedCodexConfigToml({
        sourceHome,
        targetHome: path.join(sourceHome, "."),
      });

      expect(result.wrote).toBe(false);
      expect(await fs.readFile(hostConfig, "utf8")).toBe(HOST_CONFIG);
    });
  });

  it("leaves the host config untouched while seeding", async () => {
    await withHomes(async ({ sourceHome, targetHome }) => {
      const hostConfig = path.join(sourceHome, "config.toml");
      await fs.writeFile(hostConfig, HOST_CONFIG, "utf8");

      await seedSanitizedCodexConfigToml({ sourceHome, targetHome });

      expect(await fs.readFile(hostConfig, "utf8")).toBe(HOST_CONFIG);
    });
  });

  it("creates nothing when the host has no config.toml", async () => {
    await withHomes(async ({ sourceHome, targetHome }) => {
      const result = await seedSanitizedCodexConfigToml({ sourceHome, targetHome });

      expect(result.wrote).toBe(false);
      await expect(fs.stat(path.join(targetHome, "config.toml"))).rejects.toThrow();
    });
  });

  it("reports the dropped keys through onNote", async () => {
    await withHomes(async ({ sourceHome, targetHome }) => {
      await fs.writeFile(path.join(sourceHome, "config.toml"), HOST_CONFIG, "utf8");
      const notes: string[] = [];

      await seedSanitizedCodexConfigToml({
        sourceHome,
        targetHome,
        onNote: (note) => {
          notes.push(note);
        },
      });

      expect(notes.join("")).toContain("model, model_provider");
    });
  });

  it("does not re-announce on a run where nothing changed", async () => {
    await withHomes(async ({ sourceHome, targetHome }) => {
      await fs.writeFile(path.join(sourceHome, "config.toml"), HOST_CONFIG, "utf8");
      await seedSanitizedCodexConfigToml({ sourceHome, targetHome });
      const notes: string[] = [];

      await seedSanitizedCodexConfigToml({
        sourceHome,
        targetHome,
        onNote: (note) => {
          notes.push(note);
        },
      });

      expect(notes).toEqual([]);
    });
  });
});
