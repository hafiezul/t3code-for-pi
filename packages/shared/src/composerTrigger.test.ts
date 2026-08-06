import { describe, expect, it } from "vite-plus/test";

import {
  detectComposerTrigger,
  serializeComposerFileLink,
  serializeComposerMentionPath,
} from "./composerTrigger.ts";

describe("serializeComposerMentionPath", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("docs/My File.md")).toBe('"docs/My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("detectComposerTrigger (# prompt actions)", () => {
  it("detects a # prompt-action query at line start", () => {
    const trigger = detectComposerTrigger("#cop", 4);
    expect(trigger).toEqual({ kind: "prompt-action", query: "cop", rangeStart: 0, rangeEnd: 4 });
  });

  it("treats whitespace after # as plain text (markdown headings)", () => {
    expect(detectComposerTrigger("# Title", 7)).toBeNull();
  });

  it("fires mid-word like the OMP TUI", () => {
    const trigger = detectComposerTrigger("foo#cop", 7);
    expect(trigger).toEqual({ kind: "prompt-action", query: "cop", rangeStart: 3, rangeEnd: 7 });
  });

  it("uses the last # before the caret", () => {
    const trigger = detectComposerTrigger("a#b#cop", 7);
    expect(trigger).toEqual({ kind: "prompt-action", query: "cop", rangeStart: 3, rangeEnd: 7 });
  });

  it("only considers the current line", () => {
    expect(detectComposerTrigger("before#cop\nthen", 15)).toBeNull();
  });
});
