import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown, splitFrontMatter } from "./markdown";

const html = (s: string) => renderToStaticMarkup(renderMarkdown(s) as React.ReactElement);

test("splits front matter", () => {
  expect(splitFrontMatter("---\nname: x\n---\n# Hi\n")).toEqual({ frontMatter: "name: x", body: "# Hi\n" });
  expect(splitFrontMatter("# Hi")).toEqual({ frontMatter: null, body: "# Hi" });
});

test("renders blocks and inline", () => {
  expect(html("# Title\n\nSome **bold** and `code` and *em*.\n\n- a\n- b\n\n1. one\n2. two\n\n```sh\nls -la\n```\n\n> quoted\n\n---\n")).toBe(
    "<h1>Title</h1><p>Some <strong>bold</strong> and <code>code</code> and <em>em</em>.</p><ul><li>a</li><li>b</li></ul><ol><li>one</li><li>two</li></ol><pre data-lang=\"sh\"><code>ls -la</code></pre><blockquote><p>quoted</p></blockquote><hr/>",
  );
});

test("never passes HTML through and drops unsafe links", () => {
  expect(html("<script>alert(1)</script>\n\n[x](javascript:alert(1)) [ok](https://a.b)")).toBe(
    "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p><p>[x](javascript:alert(1)) <a href=\"https://a.b\" rel=\"noopener noreferrer\" target=\"_blank\">ok</a></p>",
  );
});
