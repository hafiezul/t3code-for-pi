// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { parse as parseYamlDocument } from "yaml";

import { OmpSettingsFile, OmpSettingsFileLive } from "./OmpSettingsFile.ts";

function makeTempHome(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-omp-settings-"));
}

function withAgentDir(agentDir: string) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return () => {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
  };
}

function withHomeDir(homeDir: string) {
  const previous = process.env.HOME;
  process.env.HOME = homeDir;
  return () => {
    if (previous === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previous;
    }
  };
}

const testLayer = it.layer(OmpSettingsFileLive.pipe(Layer.provideMerge(NodeServices.layer)));

const SAMPLE_CONFIG_YAML = [
  "symbolPreset: blocks",
  "theme:",
  "  dark: true",
  "setupVersion: 17",
  "modelRoles:",
  "  default: anthropic/claude-sonnet-4-6",
  "  smol: opencode-go/deepseek-v4-flash:max",
  "defaultThinkingLevel: high",
  "compaction:",
  "  enabled: true",
].join("\n");

describe("OmpSettingsFile", () => {
  testLayer("OmpSettingsFile", (it) => {
    it.effect("reads a missing file as empty and unset", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          const service = yield* OmpSettingsFile;
          const snapshot = yield* service.read({ profile: "" });
          expect(snapshot.exists).toBe(false);
          expect(snapshot.content).toBe("");
          expect(snapshot.malformed).toBe(false);
          expect(snapshot.path).toBe(NodePath.join(agentDir, "config.yml"));
          expect(snapshot.curated).toEqual({
            defaultThinkingLevel: null,
            modelRoles: null,
          });
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("reads an existing file and extracts the curated keys", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          NodeFS.mkdirSync(agentDir, { recursive: true });
          NodeFS.writeFileSync(NodePath.join(agentDir, "config.yml"), SAMPLE_CONFIG_YAML);
          const service = yield* OmpSettingsFile;
          const snapshot = yield* service.read({ profile: "" });
          expect(snapshot.exists).toBe(true);
          expect(snapshot.malformed).toBe(false);
          expect(snapshot.curated).toEqual({
            defaultThinkingLevel: "high",
            modelRoles: [
              "default=anthropic/claude-sonnet-4-6",
              "smol=opencode-go/deepseek-v4-flash:max",
            ].join("\n"),
          });
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("flags a malformed file without crashing", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          NodeFS.mkdirSync(agentDir, { recursive: true });
          NodeFS.writeFileSync(
            NodePath.join(agentDir, "config.yml"),
            "defaultThinkingLevel: [unclosed\nmodelRoles: {",
          );
          const service = yield* OmpSettingsFile;
          const snapshot = yield* service.read({ profile: "" });
          expect(snapshot.exists).toBe(true);
          expect(snapshot.malformed).toBe(true);
          expect(snapshot.curated).toEqual({
            defaultThinkingLevel: null,
            modelRoles: null,
          });
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("curated write merges the two keys and preserves unknown keys", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          NodeFS.mkdirSync(agentDir, { recursive: true });
          const configPath = NodePath.join(agentDir, "config.yml");
          NodeFS.writeFileSync(configPath, SAMPLE_CONFIG_YAML);
          const service = yield* OmpSettingsFile;
          const result = yield* service.write({
            profile: "",
            mode: "curated",
            curated: {
              defaultThinkingLevel: "max",
              modelRoles: "default=anthropic/claude-sonnet-4-6\nslow=openai/gpt-5.2",
            },
          });

          // Read-back reflects the merged file.
          expect(result.curated).toEqual({
            defaultThinkingLevel: "max",
            modelRoles: "default=anthropic/claude-sonnet-4-6\nslow=openai/gpt-5.2",
          });
          const onDisk = parseYamlDocument(NodeFS.readFileSync(configPath, "utf8"));
          expect(onDisk).toEqual({
            symbolPreset: "blocks",
            theme: { dark: true },
            setupVersion: 17,
            modelRoles: {
              default: "anthropic/claude-sonnet-4-6",
              slow: "openai/gpt-5.2",
            },
            defaultThinkingLevel: "max",
            compaction: { enabled: true },
          });
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("curated write with empty values removes previously-set keys", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          const configPath = NodePath.join(agentDir, "config.yml");
          NodeFS.mkdirSync(agentDir, { recursive: true });
          NodeFS.writeFileSync(configPath, SAMPLE_CONFIG_YAML);
          const service = yield* OmpSettingsFile;
          const result = yield* service.write({
            profile: "",
            mode: "curated",
            curated: { defaultThinkingLevel: "", modelRoles: "" },
          });
          expect(result.curated).toEqual({
            defaultThinkingLevel: null,
            modelRoles: null,
          });
          const onDisk = parseYamlDocument(NodeFS.readFileSync(configPath, "utf8"));
          expect(onDisk).toEqual({
            symbolPreset: "blocks",
            theme: { dark: true },
            setupVersion: 17,
            compaction: { enabled: true },
          });
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("curated write refuses a malformed file on disk", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          const configPath = NodePath.join(agentDir, "config.yml");
          NodeFS.mkdirSync(agentDir, { recursive: true });
          NodeFS.writeFileSync(configPath, "defaultThinkingLevel: [unclosed");
          const service = yield* OmpSettingsFile;
          const exit = yield* service
            .write({
              profile: "",
              mode: "curated",
              curated: { defaultThinkingLevel: "high", modelRoles: "" },
            })
            .pipe(Effect.exit);
          expect(exit._tag).toBe("Failure");
          // The malformed file is untouched.
          expect(NodeFS.readFileSync(configPath, "utf8")).toBe("defaultThinkingLevel: [unclosed");
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("curated write refuses a non-mapping file on disk", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          const configPath = NodePath.join(agentDir, "config.yml");
          NodeFS.mkdirSync(agentDir, { recursive: true });
          NodeFS.writeFileSync(configPath, "- just\n- a\n- list\n");
          const service = yield* OmpSettingsFile;
          const error = yield* service
            .write({
              profile: "",
              mode: "curated",
              curated: { defaultThinkingLevel: "high", modelRoles: "" },
            })
            .pipe(Effect.flip);
          expect(error.operation).toBe("write-curated");
          expect(error.detail).toContain("not a YAML mapping");
          // The list file is untouched.
          expect(NodeFS.readFileSync(configPath, "utf8")).toBe("- just\n- a\n- list\n");
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("curated write validates the thinking level enum", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          const configPath = NodePath.join(agentDir, "config.yml");
          NodeFS.mkdirSync(agentDir, { recursive: true });
          NodeFS.writeFileSync(configPath, "theme:\n  dark: true\n");
          const service = yield* OmpSettingsFile;
          const error = yield* service
            .write({
              profile: "",
              mode: "curated",
              curated: { defaultThinkingLevel: "turbo", modelRoles: "" },
            })
            .pipe(Effect.flip);
          expect(error.operation).toBe("write-curated");
          expect(error.detail).toContain("defaultThinkingLevel must be one of");
          expect(NodeFS.readFileSync(configPath, "utf8")).toBe("theme:\n  dark: true\n");
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("curated write validates modelRoles line format", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          const configPath = NodePath.join(agentDir, "config.yml");
          NodeFS.mkdirSync(agentDir, { recursive: true });
          NodeFS.writeFileSync(configPath, "theme:\n  dark: true\n");
          const service = yield* OmpSettingsFile;

          const noEquals = yield* service
            .write({
              profile: "",
              mode: "curated",
              curated: { defaultThinkingLevel: "", modelRoles: "default anthropic/claude" },
            })
            .pipe(Effect.exit);
          expect(noEquals._tag).toBe("Failure");

          const noSlash = yield* service
            .write({
              profile: "",
              mode: "curated",
              curated: { defaultThinkingLevel: "", modelRoles: "default=anthropic" },
            })
            .pipe(Effect.exit);
          expect(noSlash._tag).toBe("Failure");

          const error = yield* service
            .write({
              profile: "",
              mode: "curated",
              curated: {
                defaultThinkingLevel: "",
                modelRoles: "default=anthropic/claude\nbad line",
              },
            })
            .pipe(Effect.flip);
          expect(error.operation).toBe("write-curated");
          expect(error.detail).toContain("Line 2");
          expect(NodeFS.readFileSync(configPath, "utf8")).toBe("theme:\n  dark: true\n");
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("raw write validates YAML and never writes malformed content", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          const configPath = NodePath.join(agentDir, "config.yml");
          NodeFS.mkdirSync(agentDir, { recursive: true });
          NodeFS.writeFileSync(configPath, "theme:\n  dark: true\n");
          const service = yield* OmpSettingsFile;

          const invalid = yield* service
            .write({ profile: "", mode: "raw", content: "defaultThinkingLevel: [unclosed" })
            .pipe(Effect.exit);
          expect(invalid._tag).toBe("Failure");
          expect(NodeFS.readFileSync(configPath, "utf8")).toBe("theme:\n  dark: true\n");

          const rawContent = [
            "defaultThinkingLevel: medium",
            "modelRoles:",
            "  default: anthropic/claude-sonnet-4-6",
          ].join("\n");
          const valid = yield* service.write({ profile: "", mode: "raw", content: rawContent });
          expect(valid.malformed).toBe(false);
          expect(valid.curated.defaultThinkingLevel).toBe("medium");
          expect(valid.curated.modelRoles).toBe("default=anthropic/claude-sonnet-4-6");
          // Raw mode writes the user's bytes verbatim.
          expect(NodeFS.readFileSync(configPath, "utf8")).toBe(rawContent);
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("targets the profile's config file when a profile is set", () =>
      Effect.gen(function* () {
        const homeDir = makeTempHome();
        const restoreHome = withHomeDir(homeDir);
        try {
          const service = yield* OmpSettingsFile;
          const missing = yield* service.read({ profile: "work" });
          expect(missing.path).toBe(
            NodePath.join(homeDir, ".omp", "profiles", "work", "agent", "config.yml"),
          );
          expect(missing.exists).toBe(false);

          const written = yield* service.write({
            profile: "work",
            mode: "curated",
            curated: { defaultThinkingLevel: "low", modelRoles: "" },
          });
          expect(written.exists).toBe(true);
          expect(written.path).toBe(
            NodePath.join(homeDir, ".omp", "profiles", "work", "agent", "config.yml"),
          );
          const onDisk = parseYamlDocument(
            NodeFS.readFileSync(
              NodePath.join(homeDir, ".omp", "profiles", "work", "agent", "config.yml"),
              "utf8",
            ),
          );
          expect(onDisk).toEqual({ defaultThinkingLevel: "low" });

          // The default-profile file is a different path, untouched.
          const defaultSnapshot = yield* service.read({ profile: "" });
          expect(defaultSnapshot.path).not.toBe(missing.path);
          expect(defaultSnapshot.exists).toBe(false);
        } finally {
          restoreHome();
          NodeFS.rmSync(homeDir, { recursive: true, force: true });
        }
      }),
    );
  });
});
