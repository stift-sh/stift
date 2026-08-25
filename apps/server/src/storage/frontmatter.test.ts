import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter } from "./frontmatter.js";

test("parseFrontmatter", () => {
  const cases: [string, string, string][] = [
    ["no frontmatter\nname: x\n", "", ""],
    ["---\nname: review\ndescription: \"Review a diff: carefully\"\nother: x\n---\n# Body\nname: not-this\n", "review", "Review a diff: carefully"],
    ["---\ndescription: 'single quoted'\n---\n", "", "single quoted"],
    ["\ufeff---\nname: bom\n---\n", "bom", ""],
    ["---\ndescription: >\n  folded over\n  two lines\nname: n\n---\n", "n", "folded over two lines"],
    ["---\n# comment\nname: |-\n  literal\n---\n", "literal", ""],
    ["---\nname: unterminated\n", "unterminated", ""],
  ];
  for (const [input, name, description] of cases) {
    assert.deepEqual(parseFrontmatter(input), { name, description }, JSON.stringify(input));
  }
});
