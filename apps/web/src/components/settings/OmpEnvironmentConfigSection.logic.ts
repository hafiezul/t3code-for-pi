import { OMP_THINKING_LEVELS, type OmpSettingsFileCurated } from "@t3tools/contracts";

/**
 * Pure helpers for the OMP config editor section. The curated shape is a
 * `defaultThinkingLevel` enum plus a keyed textarea of `role=provider/model`
 * lines (the wire format for `modelRoles`); the server validates both on
 * save, and these helpers mirror that validation so the form can flag bad
 * lines before round-tripping.
 */

export type OmpSettingsFileCuratedInput = {
  readonly defaultThinkingLevel: string | null;
  readonly modelRoles: string | null;
};

/** One `role=provider/model` line; a `:param` suffix is allowed. */
export const MODEL_ROLE_LINE_PATTERN = /^[^=\s]+=[^=\s]+\/[^=\s]+$/;

export function toCuratedInput(curated: OmpSettingsFileCurated): OmpSettingsFileCuratedInput {
  return {
    defaultThinkingLevel: curated.defaultThinkingLevel?.trim() || null,
    modelRoles: curated.modelRoles?.trim() || null,
  };
}

/**
 * Client-side preview of the server's modelRoles line validation. Returns a
 * user-facing error for the first malformed line, or null when the draft is
 * acceptable. Blank lines are ignored, matching the server.
 */
export function modelRolesDraftError(content: string): string | null {
  const lines = content.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (line.length === 0) {
      continue;
    }
    if (!MODEL_ROLE_LINE_PATTERN.test(line)) {
      return `Line ${index + 1} is not "role=provider/model" (e.g. "default=anthropic/claude-sonnet-4-6").`;
    }
  }
  return null;
}

/** The curated enum select's options, in OMP's own order. */
export const OMP_THINKING_LEVEL_OPTIONS: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}> = OMP_THINKING_LEVELS.map((level) => ({
  value: level,
  label: level,
  ...(level === "off"
    ? { description: "Omit thinking from the model's responses." }
    : level === "max"
      ? { description: "Maximum reasoning effort for the hardest tasks." }
      : {}),
}));
