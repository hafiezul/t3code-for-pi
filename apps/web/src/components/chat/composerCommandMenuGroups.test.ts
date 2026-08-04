import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type ServerProviderSlashCommand } from "@t3tools/contracts";

import { groupCommandItems, type ComposerCommandItem } from "./ComposerCommandMenu";

function providerCommand(name: string, group: string | undefined): ServerProviderSlashCommand {
  return {
    name,
    description: `description of ${name}`,
    ...(group !== undefined ? { group } : {}),
  } as ServerProviderSlashCommand;
}

function providerItem(command: ServerProviderSlashCommand): ComposerCommandItem {
  return {
    id: `provider-slash-command:pi:${command.name}`,
    type: "provider-slash-command",
    provider: ProviderDriverKind.make("pi"),
    command,
    label: `/${command.name}`,
    description: command.description ?? "",
  };
}

const builtInItem: ComposerCommandItem = {
  id: "slash:model",
  type: "slash-command",
  command: "model",
  label: "/model",
  description: "Switch response model for this thread",
};

describe("groupCommandItems", () => {
  it("keeps ungrouped provider commands in the flat Provider section", () => {
    const groups = groupCommandItems(
      [builtInItem, providerItem(providerCommand("compact", undefined))],
      "slash-command",
      true,
    );

    expect(groups.map((group) => group.label)).toEqual(["Built-in", "Provider"]);
  });

  it("splits grouped provider commands into per-group sections in order", () => {
    const groups = groupCommandItems(
      [
        builtInItem,
        providerItem(providerCommand("do-something", "Extension")),
        providerItem(providerCommand("review", "Skill")),
        providerItem(providerCommand("explain", "Prompt")),
      ],
      "slash-command",
      true,
    );

    expect(groups.map((group) => group.label)).toEqual([
      "Built-in",
      "Extension",
      "Skill",
      "Prompt",
    ]);
    expect(groups[1]?.items.map((item) => item.label)).toEqual(["/do-something"]);
  });

  it("keeps grouped and ungrouped providers in separate sections", () => {
    const groups = groupCommandItems(
      [
        providerItem(providerCommand("compact", undefined)),
        providerItem(providerCommand("do-something", "Extension")),
      ],
      "slash-command",
      true,
    );

    expect(groups.map((group) => group.label)).toEqual(["Extension", "Provider"]);
  });

  it("falls back to a single flat list when grouping is disabled", () => {
    const groups = groupCommandItems(
      [builtInItem, providerItem(providerCommand("do-something", "Extension"))],
      "slash-command",
      false,
    );

    expect(groups.map((group) => group.label)).toEqual([null]);
  });
});
