import type { OmpSettingsFileSnapshot } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  OmpEnvironmentConfigBody,
  OmpEnvironmentConfigSection,
} from "./OmpEnvironmentConfigSection";

const EMPTY_SNAPSHOT: OmpSettingsFileSnapshot = {
  path: "~/.omp/agent/config.yml",
  exists: false,
  content: "",
  malformed: false,
  curated: { defaultThinkingLevel: null, modelRoles: null },
};

function bodyMarkup(overrides: Partial<Parameters<typeof OmpEnvironmentConfigBody>[0]> = {}) {
  return renderToStaticMarkup(
    <OmpEnvironmentConfigBody
      environmentId={null}
      snapshot={EMPTY_SNAPSHOT}
      isLoading={false}
      isSaving={false}
      loadError={null}
      saveError={null}
      onSaveCurated={vi.fn()}
      onSaveRaw={vi.fn()}
      {...overrides}
    />,
  );
}

describe("OmpEnvironmentConfigSection", () => {
  it("renders the collapsed section with the default-profile fallback path", () => {
    const markup = renderToStaticMarkup(
      <OmpEnvironmentConfigSection environmentId={null} instanceId="omp" profile="" />,
    );

    expect(markup).toContain("OMP config");
    expect(markup).toContain("~/.omp/agent/config.yml");
    // The body only renders when the section is open.
    expect(markup).not.toContain("Applies to new omp sessions");
  });

  it("shows the profile path when the instance sets a profile", () => {
    const markup = renderToStaticMarkup(
      <OmpEnvironmentConfigSection environmentId={null} instanceId="omp" profile="work" />,
    );

    expect(markup).toContain("~/.omp/profiles/work/agent/config.yml");
    expect(markup).toContain("this instance&#x27;s profile");
  });
});

describe("OmpEnvironmentConfigBody", () => {
  it("states that changes apply on the next launch", () => {
    expect(bodyMarkup()).toContain("Applies to new omp sessions");
  });

  it("renders the curated tab with the thinking-level select and model-roles textarea", () => {
    const markup = bodyMarkup({
      snapshot: {
        ...EMPTY_SNAPSHOT,
        curated: {
          defaultThinkingLevel: "high",
          modelRoles: "default=anthropic/claude-sonnet-4-6",
        },
      },
    });

    expect(markup).toContain("Default thinking level");
    expect(markup).toContain("Model roles");
    expect(markup).toContain("default=anthropic/claude-sonnet-4-6");
    expect(markup).toContain("Save model roles");
    expect(markup).toContain("Curated");
    expect(markup).toContain("Raw YAML");
  });

  it("warns when the file on disk is malformed", () => {
    const markup = bodyMarkup({ snapshot: { ...EMPTY_SNAPSHOT, exists: true, malformed: true } });

    expect(markup).toContain("omp can&#x27;t read this file until it&#x27;s fixed");
  });

  it("shows load and save errors when present", () => {
    const markup = bodyMarkup({ loadError: "load boom", saveError: "save boom" });

    expect(markup).toContain("load boom");
    expect(markup).toContain("save boom");
  });

  it("renders the raw tab with the file content and save button", () => {
    const markup = bodyMarkup({
      initialTab: "raw",
      snapshot: { ...EMPTY_SNAPSHOT, content: "theme:\n  dark: true\n" },
    });

    expect(markup).toContain("theme:");
    expect(markup).toContain("Save raw YAML");
    expect(markup).toContain("validated on the server before writing");
  });
});
