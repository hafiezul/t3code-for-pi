import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SkillInlineText } from "./SkillInlineText";

const skills = [{ name: "wayfinder", displayName: "Wayfinder" }];

describe("SkillInlineText", () => {
  it("renders `$name` tokens as chips", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText text="Run $wayfinder now" skills={skills} />,
    );
    expect(markup).toContain('data-markdown-copy="$wayfinder"');
    expect(markup).toContain("Wayfinder");
    expect(markup).toContain("Run ");
    expect(markup).toContain(" now");
  });

  it("renders `/skill:name` invocation tokens (pi composer form) as chips", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText text={"/skill:wayfinder\nHello"} skills={skills} />,
    );
    expect(markup).toContain('data-markdown-copy="/skill:wayfinder"');
    expect(markup).toContain("Wayfinder");
    expect(markup).toContain("Hello");
  });

  it("preserves the authored token form for copy payloads", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText text="Run /skill:wayfinder please" skills={skills} />,
    );
    expect(markup).toContain('data-markdown-copy="/skill:wayfinder"');
  });

  it("renders a trailing token at end of input as a chip", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText text="/skill:wayfinder" skills={skills} />,
    );
    expect(markup).toContain("Wayfinder");
  });

  it("leaves tokens plain when the skill is unknown", () => {
    const markup = renderToStaticMarkup(<SkillInlineText text="/skill:unknown" skills={skills} />);
    expect(markup).toContain("/skill:unknown");
    expect(markup).not.toContain("Wayfinder");
  });

  it("renders `$skill:name` tokens against bare-name skill lists", () => {
    const markup = renderToStaticMarkup(
      <SkillInlineText text="Run $skill:wayfinder now" skills={skills} />,
    );
    expect(markup).toContain('data-markdown-copy="$skill:wayfinder"');
    expect(markup).toContain("Wayfinder");
  });
});
