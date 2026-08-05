import {
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderSkill,
} from "@t3tools/contracts";

/**
 * Skills a provider can render as inline chips. pi's probe reports skills as
 * slash commands (`get_commands` rows named `skill:*`), not
 * `ServerProvider.skills` rows, so entries are synthesized from the command
 * list with the invocation prefix stripped — matching how the composer's
 * `/skill:name` insertion authorizes tokens. Other providers pass their
 * `skills` array through untouched.
 */
export function providerSkillsForDisplay(
  provider: Pick<ServerProvider, "driver" | "skills" | "slashCommands"> | null | undefined,
): ReadonlyArray<ServerProviderSkill> {
  if (!provider) {
    return [];
  }
  if (provider.driver !== ProviderDriverKind.make("pi")) {
    return provider.skills;
  }

  const skills: Array<ServerProviderSkill> = [...provider.skills];
  for (const command of provider.slashCommands) {
    if (!command.name.startsWith("skill:")) {
      continue;
    }
    const name = command.name.slice("skill:".length);
    if (skills.some((skill) => skill.name === name)) {
      continue;
    }
    skills.push({
      name,
      path: command.name,
      enabled: true,
      ...(command.description ? { description: command.description } : {}),
      ...(command.description ? { shortDescription: command.description } : {}),
    });
  }
  return skills;
}

/**
 * Bare skill name for an authored token, whatever form it arrived in:
 * `$name`, `/skill:name` (pi's invocation), or `$skill:name`. Mirrors the
 * normalization `collectComposerInlineTokens` applies to `/skill:` tokens so
 * conversation renderers resolve every form against the same bare-name list.
 */
export function normalizeSkillTokenName(value: string): string {
  if (value.startsWith("/skill:")) {
    return value.slice("/skill:".length);
  }
  if (value.startsWith("skill:")) {
    return value.slice("skill:".length);
  }
  return value;
}
