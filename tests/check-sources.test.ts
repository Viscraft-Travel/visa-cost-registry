import { describe, it, expect } from "vitest";
import { normalizeHtml, hashText, checkCanaries, isAllowedByRobots, cacheKey } from "../scripts/check-sources.js";
import type { Source } from "../scripts/resolve.js";

describe("normalizeHtml", () => {
  it("strips script/style/nav/header/footer and returns visible text", () => {
    const html = `
      <html><body>
        <nav>Skip to content</nav>
        <header>Site Header</header>
        <script>console.log("x")</script>
        <style>.x { color: red }</style>
        <main><h1>France</h1><p>Visa fee: ₹8,300</p></main>
        <footer>Copyright 2026</footer>
      </body></html>
    `;
    const text = normalizeHtml(html);
    expect(text).toContain("France");
    expect(text).toContain("₹8,300");
    expect(text).not.toContain("Skip to content");
    expect(text).not.toContain("Site Header");
    expect(text).not.toContain("console.log");
    expect(text).not.toContain("Copyright");
  });

  it("strips elements that look like cookie banners", () => {
    const html = `<div id="cookie-consent-banner">We use cookies</div><p>Real content</p>`;
    const text = normalizeHtml(html);
    expect(text).not.toContain("We use cookies");
    expect(text).toContain("Real content");
  });

  it("normalizes date-like text so a page's own timestamp doesn't cause spurious diffs", () => {
    const a = normalizeHtml("<p>Last updated: 10 September 2026</p><p>Fee: 90 EUR</p>");
    const b = normalizeHtml("<p>Last updated: 11 September 2026</p><p>Fee: 90 EUR</p>");
    expect(a).toBe(b);
  });

  it("collapses whitespace", () => {
    const text = normalizeHtml("<p>Hello   \n\n  World</p>");
    expect(text).toBe("Hello World");
  });
});

describe("hashText", () => {
  it("is deterministic", () => {
    expect(hashText("hello")).toBe(hashText("hello"));
  });

  it("changes when the input changes", () => {
    expect(hashText("hello")).not.toBe(hashText("hello!"));
  });
});

describe("checkCanaries", () => {
  it("passes when all canaries are present and no forbidden terms appear", () => {
    const result = checkCanaries("France visa fee is ₹8,300", ["France", "₹"], ["Germany"]);
    expect(result).toEqual({ ok: true, missing: [], forbidden: [] });
  });

  it("is case-insensitive", () => {
    const result = checkCanaries("FRANCE visa information", ["France"]);
    expect(result.ok).toBe(true);
  });

  it("fails and lists what's missing when a required canary is absent", () => {
    const result = checkCanaries("Some unrelated page", ["France", "₹"]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(["France", "₹"]);
  });

  it("fails and lists what's forbidden when a wrong-country marker is present", () => {
    const result = checkCanaries("Germany visa fee is €90", ["Germany"], ["United Kingdom"]);
    // canary present, but this simulates the wrong-page case directly:
    const wrongPage = checkCanaries("United Kingdom visa fee is £100", ["Germany"], ["United Kingdom"]);
    expect(result.ok).toBe(true);
    expect(wrongPage.ok).toBe(false);
    expect(wrongPage.forbidden).toEqual(["United Kingdom"]);
  });
});

describe("isAllowedByRobots", () => {
  it("allows a path with no matching Disallow rule", () => {
    const robots = "User-agent: *\nDisallow: /admin\n";
    expect(isAllowedByRobots(robots, "/visa-fees")).toBe(true);
  });

  it("disallows a path matching a wildcard Disallow rule", () => {
    const robots = "User-agent: *\nDisallow: /visa-fees\n";
    expect(isAllowedByRobots(robots, "/visa-fees")).toBe(false);
  });

  it("only applies Disallow rules inside a User-agent: * block", () => {
    const robots = "User-agent: SomeOtherBot\nDisallow: /visa-fees\n";
    expect(isAllowedByRobots(robots, "/visa-fees")).toBe(true);
  });

  it("allows everything when robots.txt has no rules at all", () => {
    expect(isAllowedByRobots("", "/anything")).toBe(true);
  });
});

describe("cacheKey", () => {
  it("combines iso_code and what_it_covers", () => {
    const source = { iso_code: "fr", what_it_covers: "fees" } as Source;
    expect(cacheKey(source)).toBe("fr:fees");
  });
});
