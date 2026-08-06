// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

import { OMP_MAINTENANCE_RESOLVER } from "./OmpDriver.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  ProviderVersionCache,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";

const ompDriver = ProviderDriverKind.make("omp");
const OMP_NPM_PACKAGE = "@oh-my-pi/pi-coding-agent";
const OMP_NPM_UPDATE_COMMAND = `npm install -g ${OMP_NPM_PACKAGE}@latest`;

const makeTempDir = (name: string) => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), name));

const installedOmpProvider: ServerProvider = {
  instanceId: ProviderInstanceId.make("omp"),
  driver: ompDriver,
  enabled: true,
  installed: true,
  version: "17.0.8",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-01T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const cachedLatestVersion = (version: string) =>
  new Map([
    [
      OMP_NPM_PACKAGE,
      {
        expiresAt: Number.MAX_SAFE_INTEGER,
        version,
      },
    ],
  ]);

const dieOnHttpClient = HttpClient.make(() =>
  Effect.die("cached provider version should not make an HTTP request"),
);

const npmGlobalCapabilities = {
  provider: ompDriver,
  packageName: OMP_NPM_PACKAGE,
  update: {
    command: OMP_NPM_UPDATE_COMMAND,
    executable: "npm",
    args: ["install", "-g", `${OMP_NPM_PACKAGE}@latest`],
    lockKey: "npm-global",
  },
};

describe("OMP maintenance resolver configuration", () => {
  it("resolves the default `omp` binary to the npm-global inline update", () => {
    expect(OMP_MAINTENANCE_RESOLVER.resolve({ binaryPath: "omp" })).toEqual(npmGlobalCapabilities);
  });

  it("resolves a missing binary path to the same npm-global inline update", () => {
    expect(OMP_MAINTENANCE_RESOLVER.resolve()).toEqual(npmGlobalCapabilities);
  });

  it("keeps the advisory package but drops inline update for Homebrew installs", () => {
    expect(OMP_MAINTENANCE_RESOLVER.resolve({ binaryPath: "/opt/homebrew/bin/omp" })).toEqual({
      provider: ompDriver,
      packageName: OMP_NPM_PACKAGE,
      update: null,
    });
  });

  it("keeps the advisory package but drops inline update for unrecognized custom binary paths", () => {
    expect(OMP_MAINTENANCE_RESOLVER.resolve({ binaryPath: "/opt/custom/omp" })).toEqual({
      provider: ompDriver,
      packageName: OMP_NPM_PACKAGE,
      update: null,
    });
  });
});

it.layer(NodeServices.layer)("OMP provider maintenance", (it) => {
  it.effect("resolves an `omp` on PATH to npm-global capabilities through the effect seam", () => {
    const tempDir = makeTempDir("t3-omp-maintenance-");
    const ompBinDir = NodePath.join(tempDir, "bin");
    NodeFS.mkdirSync(ompBinDir, { recursive: true });
    const ompPath = NodePath.join(ompBinDir, "omp");
    NodeFS.writeFileSync(ompPath, "#!/bin/sh\n");
    NodeFS.chmodSync(ompPath, 0o755);

    return Effect.gen(function* () {
      const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
        OMP_MAINTENANCE_RESOLVER,
        {
          binaryPath: "omp",
          env: {
            PATH: ompBinDir,
          },
        },
      ).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

      expect(capabilities).toEqual(npmGlobalCapabilities);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });

  it.effect(
    "resolves a Homebrew-style cellar symlink to manual-only capabilities through the effect seam",
    () => {
      const tempDir = makeTempDir("t3-omp-homebrew-");
      const binDir = NodePath.join(tempDir, "bin");
      const cellarBinDir = NodePath.join(tempDir, "homebrew", "cellar", "omp", "17.2.7", "bin");
      NodeFS.mkdirSync(binDir, { recursive: true });
      NodeFS.mkdirSync(cellarBinDir, { recursive: true });
      const cellarOmpPath = NodePath.join(cellarBinDir, "omp");
      NodeFS.writeFileSync(cellarOmpPath, "#!/bin/sh\n");
      NodeFS.chmodSync(cellarOmpPath, 0o755);
      // Homebrew exposes a bin symlink whose realPath lands in the Cellar.
      NodeFS.symlinkSync(cellarOmpPath, NodePath.join(binDir, "omp"));

      return Effect.gen(function* () {
        const capabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(
          OMP_MAINTENANCE_RESOLVER,
          {
            binaryPath: NodePath.join(binDir, "omp"),
            env: {
              PATH: "",
            },
          },
        ).pipe(Effect.provideService(HostProcessPlatform, "darwin"));

        expect(capabilities).toEqual({
          provider: ompDriver,
          packageName: OMP_NPM_PACKAGE,
          update: null,
        });
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        ),
      );
    },
  );

  it.effect(
    "reports behind_latest with the npm update command when a newer version is available",
    () =>
      enrichProviderSnapshotWithVersionAdvisory(
        installedOmpProvider,
        OMP_MAINTENANCE_RESOLVER.resolve(),
        {
          enableProviderUpdateChecks: true,
        },
      ).pipe(
        Effect.provideService(ProviderVersionCache, cachedLatestVersion("17.2.7")),
        Effect.provideService(HttpClient.HttpClient, dieOnHttpClient),
        Effect.map((provider) => {
          expect(provider.versionAdvisory).toMatchObject({
            status: "behind_latest",
            currentVersion: "17.0.8",
            latestVersion: "17.2.7",
            updateCommand: OMP_NPM_UPDATE_COMMAND,
            canUpdate: true,
            message: "Install the update now or review provider settings.",
          });
        }),
      ),
  );

  it.effect("reports current when the installed version matches the latest", () =>
    enrichProviderSnapshotWithVersionAdvisory(
      { ...installedOmpProvider, version: "17.2.7" },
      OMP_MAINTENANCE_RESOLVER.resolve(),
      {
        enableProviderUpdateChecks: true,
      },
    ).pipe(
      Effect.provideService(ProviderVersionCache, cachedLatestVersion("17.2.7")),
      Effect.provideService(HttpClient.HttpClient, dieOnHttpClient),
      Effect.map((provider) => {
        expect(provider.versionAdvisory).toMatchObject({
          status: "current",
          currentVersion: "17.2.7",
          latestVersion: "17.2.7",
        });
      }),
    ),
  );

  it.effect("does not resolve the latest version when update checks are disabled", () =>
    enrichProviderSnapshotWithVersionAdvisory(
      installedOmpProvider,
      OMP_MAINTENANCE_RESOLVER.resolve(),
      {
        enableProviderUpdateChecks: false,
      },
    ).pipe(
      Effect.provideService(ProviderVersionCache, new Map()),
      Effect.provideService(HttpClient.HttpClient, dieOnHttpClient),
      Effect.map((provider) => {
        expect(provider.versionAdvisory).toMatchObject({
          status: "unknown",
          currentVersion: "17.0.8",
          latestVersion: null,
          checkedAt: "2026-08-01T00:00:00.000Z",
        });
      }),
    ),
  );

  it.effect("keeps comparing versions for Homebrew installs but drops the inline update", () =>
    enrichProviderSnapshotWithVersionAdvisory(
      installedOmpProvider,
      OMP_MAINTENANCE_RESOLVER.resolve({ binaryPath: "/opt/homebrew/bin/omp" }),
      {
        enableProviderUpdateChecks: true,
      },
    ).pipe(
      Effect.provideService(ProviderVersionCache, cachedLatestVersion("17.2.7")),
      Effect.provideService(HttpClient.HttpClient, dieOnHttpClient),
      Effect.map((provider) => {
        expect(provider.versionAdvisory).toMatchObject({
          status: "behind_latest",
          currentVersion: "17.0.8",
          latestVersion: "17.2.7",
          updateCommand: null,
          canUpdate: false,
        });
      }),
    ),
  );

  it.effect("keeps the advisory unknown without fetching when the current version is unknown", () =>
    enrichProviderSnapshotWithVersionAdvisory(
      { ...installedOmpProvider, version: null },
      OMP_MAINTENANCE_RESOLVER.resolve(),
      {
        enableProviderUpdateChecks: true,
      },
    ).pipe(
      Effect.provideService(ProviderVersionCache, new Map()),
      Effect.provideService(HttpClient.HttpClient, dieOnHttpClient),
      Effect.map((provider) => {
        expect(provider.versionAdvisory).toMatchObject({
          status: "unknown",
          currentVersion: null,
          latestVersion: null,
        });
      }),
    ),
  );
});
