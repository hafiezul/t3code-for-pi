import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind } from "@t3tools/contracts";

import { normalizeSkillTokenName, providerSkillsForDisplay } from "./providerSkills.ts";

const provider = (input: {
  driver?: string;
  skills?: unknown[];
  slashCommands?: Array<{ name: string; description?: string }>;
}) => ({
  driver: ProviderDriverKind.make((input.driver ?? "claudeAgent") as never),
  skills: (input.skills ?? []) as never,
  slashCommands: input.slashCommands ?? [],
});

describe("providerSkillsForDisplay", () => {
  it("passes non-pi skills through untouched", () => {
    const skills = [{ name: "wayfinder", path: "/x", enabled: true }];
    const result = providerSkillsForDisplay(provider({ skills }));
    expect(result).toBe(skills);
  });

  it("synthesizes pi skills from `skill:` slash commands", () => {
    const result = providerSkillsForDisplay(
      provider({
        driver: "pi",
        slashCommands: [
          { name: "skill:wayfinder", description: "Run wayfinder" },
          { name: "/plan" },
          { name: "skill:plan", description: "Plan skill" },
        ],
      }),
    );
    expect(result).toEqual([
      {
        name: "wayfinder",
        path: "skill:wayfinder",
        enabled: true,
        description: "Run wayfinder",
        shortDescription: "Run wayfinder",
      },
      {
        name: "plan",
        path: "skill:plan",
        enabled: true,
        description: "Plan skill",
        shortDescription: "Plan skill",
      },
    ]);
  });

  it("merges pi skills with existing rows, deduping by bare name", () => {
    const result = providerSkillsForDisplay(
      provider({
        driver: "pi",
        skills: [{ name: "wayfinder", path: "/x", enabled: false }],
        slashCommands: [
          { name: "skill:wayfinder", description: "Duplicate" },
          { name: "skill:other" },
        ],
      }),
    );
    expect(result).toEqual([
      { name: "wayfinder", path: "/x", enabled: false },
      { name: "other", path: "skill:other", enabled: true },
    ]);
  });

  it("returns an empty array for a missing provider", () => {
    expect(providerSkillsForDisplay(null)).toEqual([]);
    expect(providerSkillsForDisplay(undefined)).toEqual([]);
  });
});

describe("normalizeSkillTokenName", () => {
  it("strips the `/skill:` and `skill:` invocation prefixes", () => {
    expect(normalizeSkillTokenName("/skill:wayfinder")).toBe("wayfinder");
    expect(normalizeSkillTokenName("skill:wayfinder")).toBe("wayfinder");
    expect(normalizeSkillTokenName("wayfinder")).toBe("wayfinder");
  });
});
