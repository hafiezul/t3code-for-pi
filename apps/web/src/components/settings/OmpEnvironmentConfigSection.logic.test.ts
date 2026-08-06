import { describe, expect, it } from "vite-plus/test";

import {
  modelRolesDraftError,
  OMP_THINKING_LEVEL_OPTIONS,
  toCuratedInput,
} from "./OmpEnvironmentConfigSection.logic";

describe("OmpEnvironmentConfigSection logic", () => {
  describe("toCuratedInput", () => {
    it("trims values and maps empty strings to null", () => {
      expect(
        toCuratedInput({
          defaultThinkingLevel: " high ",
          modelRoles: "default=anthropic/claude-sonnet-4-6",
        }),
      ).toEqual({
        defaultThinkingLevel: "high",
        modelRoles: "default=anthropic/claude-sonnet-4-6",
      });
      expect(toCuratedInput({ defaultThinkingLevel: "", modelRoles: null })).toEqual({
        defaultThinkingLevel: null,
        modelRoles: null,
      });
    });
  });

  describe("modelRolesDraftError", () => {
    it("accepts blank content and blank lines", () => {
      expect(modelRolesDraftError("")).toBeNull();
      expect(modelRolesDraftError("  \n\n")).toBeNull();
    });

    it("accepts role=provider/model lines, including :param suffixes", () => {
      expect(
        modelRolesDraftError(
          "default=anthropic/claude-sonnet-4-6\nsmol=opencode-go/deepseek-v4-flash:max",
        ),
      ).toBeNull();
    });

    it("rejects lines without an equals sign", () => {
      expect(modelRolesDraftError("default anthropic/claude")).toContain("Line 1");
    });

    it("rejects lines without a provider/model slash", () => {
      expect(modelRolesDraftError("default=anthropic")).toContain("Line 1");
    });

    it("rejects whitespace in role or model", () => {
      expect(modelRolesDraftError("def ault=anthropic/claude")).toContain("Line 1");
      expect(modelRolesDraftError("default=anthropic /claude")).toContain("Line 1");
    });

    it("reports the line number of the first bad line", () => {
      expect(modelRolesDraftError("default=anthropic/claude\n\nbad line")).toContain("Line 3");
    });
  });

  describe("OMP_THINKING_LEVEL_OPTIONS", () => {
    it("lists OMP's seven thinking levels in order", () => {
      expect(OMP_THINKING_LEVEL_OPTIONS.map((option) => option.value)).toEqual([
        "off",
        "minimal",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]);
    });

    it("annotates the off and max endpoints", () => {
      expect(OMP_THINKING_LEVEL_OPTIONS.find((option) => option.value === "off")?.description).toBe(
        "Omit thinking from the model's responses.",
      );
      expect(OMP_THINKING_LEVEL_OPTIONS.find((option) => option.value === "max")?.description).toBe(
        "Maximum reasoning effort for the hardest tasks.",
      );
    });
  });
});
