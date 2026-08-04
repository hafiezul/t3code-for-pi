// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { PiSettingsFile, PiSettingsFileLive } from "./PiSettingsFile.ts";

function makeTempHome(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-pi-settings-"));
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

const testLayer = it.layer(PiSettingsFileLive.pipe(Layer.provideMerge(NodeServices.layer)));

describe("PiSettingsFile", () => {
  testLayer("PiSettingsFile", (it) => {
    it.effect("reads a missing file as empty and unset", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          const service = yield* PiSettingsFile;
          const snapshot = yield* service.read();
          expect(snapshot.exists).toBe(false);
          expect(snapshot.content).toBe("");
          expect(snapshot.malformed).toBe(false);
          expect(snapshot.path).toBe(NodePath.join(agentDir, "settings.json"));
          expect(snapshot.curated).toEqual({
            defaultProvider: null,
            defaultModel: null,
            defaultThinkingLevel: null,
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
          NodeFS.writeFileSync(
            NodePath.join(agentDir, "settings.json"),
            JSON.stringify(
              {
                defaultProvider: "anthropic",
                defaultModel: "claude-sonnet-4-6",
                defaultThinkingLevel: "high",
                lastChangelogVersion: "0.83.0",
                theme: "dark",
              },
              null,
              2,
            ),
          );
          const service = yield* PiSettingsFile;
          const snapshot = yield* service.read();
          expect(snapshot.exists).toBe(true);
          expect(snapshot.malformed).toBe(false);
          expect(snapshot.curated).toEqual({
            defaultProvider: "anthropic",
            defaultModel: "claude-sonnet-4-6",
            defaultThinkingLevel: "high",
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
          NodeFS.writeFileSync(NodePath.join(agentDir, "settings.json"), "{not json");
          const service = yield* PiSettingsFile;
          const snapshot = yield* service.read();
          expect(snapshot.exists).toBe(true);
          expect(snapshot.malformed).toBe(true);
          expect(snapshot.curated).toEqual({
            defaultProvider: null,
            defaultModel: null,
            defaultThinkingLevel: null,
          });
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("curated write merges exactly the three keys and preserves unknown keys", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          NodeFS.mkdirSync(agentDir, { recursive: true });
          const settingsPath = NodePath.join(agentDir, "settings.json");
          NodeFS.writeFileSync(
            settingsPath,
            JSON.stringify(
              {
                theme: "dark",
                lastChangelogVersion: "0.83.0",
                trackingId: "uuid-1",
              },
              null,
              2,
            ),
          );
          const service = yield* PiSettingsFile;
          const result = yield* service.write({
            mode: "curated",
            curated: {
              defaultProvider: "anthropic",
              defaultModel: "claude-sonnet-4-6",
              defaultThinkingLevel: "",
            },
          });

          // Empty thinking level = omitted from the file.
          expect(result.curated).toEqual({
            defaultProvider: "anthropic",
            defaultModel: "claude-sonnet-4-6",
            defaultThinkingLevel: null,
          });
          const onDisk = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"));
          expect(onDisk).toEqual({
            theme: "dark",
            lastChangelogVersion: "0.83.0",
            trackingId: "uuid-1",
            defaultProvider: "anthropic",
            defaultModel: "claude-sonnet-4-6",
          });
          // pi's convention: 2-space indent, no trailing newline.
          expect(NodeFS.readFileSync(settingsPath, "utf8")).toBe(JSON.stringify(onDisk, null, 2));
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("curated write with nulls removes previously-set keys", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          const settingsPath = NodePath.join(agentDir, "settings.json");
          NodeFS.mkdirSync(agentDir, { recursive: true });
          NodeFS.writeFileSync(
            settingsPath,
            JSON.stringify({ defaultProvider: "anthropic", theme: "dark" }),
          );
          const service = yield* PiSettingsFile;
          yield* service.write({
            mode: "curated",
            curated: { defaultProvider: null, defaultModel: null, defaultThinkingLevel: null },
          });
          const onDisk = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"));
          expect(onDisk).toEqual({ theme: "dark" });
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
          const settingsPath = NodePath.join(agentDir, "settings.json");
          NodeFS.mkdirSync(agentDir, { recursive: true });
          NodeFS.writeFileSync(settingsPath, "{broken");
          const service = yield* PiSettingsFile;
          const exit = yield* service
            .write({
              mode: "curated",
              curated: {
                defaultProvider: "anthropic",
                defaultModel: null,
                defaultThinkingLevel: null,
              },
            })
            .pipe(Effect.exit);
          expect(exit._tag).toBe("Failure");
          // The malformed file is untouched.
          expect(NodeFS.readFileSync(settingsPath, "utf8")).toBe("{broken");
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );

    it.effect("raw write validates strict JSON and never writes malformed content", () =>
      Effect.gen(function* () {
        const agentDir = makeTempHome();
        const restore = withAgentDir(agentDir);
        try {
          const settingsPath = NodePath.join(agentDir, "settings.json");
          NodeFS.mkdirSync(agentDir, { recursive: true });
          NodeFS.writeFileSync(settingsPath, "{}");
          const service = yield* PiSettingsFile;

          const invalid = yield* service.write({ mode: "raw", content: "{nope" }).pipe(Effect.exit);
          expect(invalid._tag).toBe("Failure");
          expect(NodeFS.readFileSync(settingsPath, "utf8")).toBe("{}");

          const valid = yield* service.write({
            mode: "raw",
            content: '{\n  "defaultProvider": "opencode-go",\n  "theme": "light"\n}',
          });
          expect(valid.malformed).toBe(false);
          expect(valid.curated.defaultProvider).toBe("opencode-go");
          expect(NodeFS.readFileSync(settingsPath, "utf8")).toBe(
            '{\n  "defaultProvider": "opencode-go",\n  "theme": "light"\n}',
          );
        } finally {
          restore();
          NodeFS.rmSync(agentDir, { recursive: true, force: true });
        }
      }),
    );
  });
});
