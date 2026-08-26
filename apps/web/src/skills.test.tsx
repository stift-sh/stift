import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bundle } from "@stift/shared";
import { setToken } from "./api/client";
import { renderApp } from "./test/render";
import { http, HttpResponse, server } from "./test/msw";

const TOKEN = "stf_" + "a".repeat(48);
const SHA1 = "1".repeat(64);
const SHA2 = "2".repeat(64);
const blobs: Record<string, string> = {
  [SHA1]: "---\nname: hello\ndescription: says hi\n---\n# Hello\n",
  [SHA2]: "---\nname: hello\ndescription: says hi\n---\n# Hello\nmore\n",
};

const bundle = (over: Partial<Bundle>): Bundle => ({
  scope: "user",
  agent: "claude",
  name: "skills/hello",
  version: 1,
  parent: 0,
  host: "mac",
  author: "root",
  created: "2026-08-27T10:00:00Z",
  files: [{ path: "SKILL.md", sha256: SHA1, size: 48, mode: 0o644 }],
  skills: [{ path: "SKILL.md", name: "hello", description: "says hi" }],
  ...over,
});
const v1 = bundle({});
const v2 = bundle({ version: 2, parent: 1, files: [{ path: "SKILL.md", sha256: SHA2, size: 53, mode: 0o644 }] });
const policy = bundle({ scope: "org", agent: "cursor", name: "skills/policy", skills: [{ path: "SKILL.md", name: "policy", description: "org rules" }] });

const pre = () => document.querySelector("pre");
let versions: Bundle[];
let requests: URL[];
let puts: unknown[];
beforeEach(() => {
  setToken(TOKEN);
  versions = [v1, v2];
  requests = [];
  puts = [];
  const head = () => versions[versions.length - 1];
  server.use(
    http.get("*/v1/bundles", ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const scope = url.searchParams.get("scope");
      const agent = url.searchParams.get("agent");
      return HttpResponse.json([head(), policy].filter((b) => (!scope || b.scope === scope) && (!agent || b.agent === agent)));
    }),
    http.get("*/v1/bundles/:scope/:agent/*", ({ request, params }) => {
      const url = new URL(request.url);
      requests.push(url);
      if (params["1"] !== "skills/hello") return HttpResponse.json({ error: "no such bundle" }, { status: 404 });
      if (url.searchParams.get("history") === "1") return HttpResponse.json([...versions].reverse());
      const v = Number(url.searchParams.get("version") ?? 0);
      const found = v ? versions.find((b) => b.version === v) : head();
      return found ? HttpResponse.json(found) : HttpResponse.json({ error: "no such bundle" }, { status: 404 });
    }),
    http.put("*/v1/bundles/:scope/:agent/*", async ({ request }) => {
      const body = (await request.json()) as { parent: number; files: Bundle["files"] };
      puts.push(body);
      const next = bundle({ version: head().version + 1, parent: body.parent, files: body.files, host: "web" });
      versions.push(next);
      return HttpResponse.json(next, { status: 201 });
    }),
    http.get("*/v1/blobs/:sha", ({ params }) => new HttpResponse(blobs[String(params.sha)], { headers: { "content-type": "application/octet-stream" } })),
  );
});

test("lists skills and filters scope and agent through the query string", async () => {
  const { router } = renderApp({ path: "/skills" });
  expect(await screen.findByRole("link", { name: "hello" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "policy" })).toBeInTheDocument();
  expect(screen.getByText("says hi")).toBeInTheDocument();
  expect(screen.getByText("v2")).toBeInTheDocument();

  await userEvent.click(screen.getByRole("tab", { name: /Org/ }));
  await waitFor(() => expect(router.state.location.search).toBe("?scope=org"));
  await waitFor(() => expect(screen.queryByRole("link", { name: "hello" })).not.toBeInTheDocument());
  expect(requests.at(-1)?.searchParams.get("scope")).toBe("org");

  await userEvent.selectOptions(screen.getByLabelText("Agent"), "cursor");
  await waitFor(() => expect(router.state.location.search).toBe("?scope=org&agent=cursor"));
  expect(await screen.findByRole("link", { name: "policy" })).toBeInTheDocument();

  await userEvent.type(screen.getByLabelText("Search"), "zzz");
  expect(await screen.findByText("Nothing matches")).toBeInTheDocument();
  await userEvent.click(within(screen.getByText("Nothing matches").parentElement!).getByRole("button", { name: "Clear filters" }));
  await waitFor(() => expect(router.state.location.search).toBe(""));
  expect(await screen.findByRole("link", { name: "hello" })).toBeInTheDocument();
});

test("empty list teaches the CLI", async () => {
  server.use(http.get("*/v1/bundles", () => HttpResponse.json([])));
  renderApp({ path: "/skills" });
  expect(await screen.findByText("No skills yet")).toBeInTheDocument();
  expect(screen.getByText(/stift push --skills/)).toBeInTheDocument();
});

test("detail renders SKILL.md with a raw toggle, files and an audit timeline; 404s for unknown names", async () => {
  const first = renderApp({ path: "/skills/user/claude/skills/hello" });
  expect(await screen.findByRole("heading", { name: "hello" })).toBeInTheDocument();
  const rendered = await screen.findByTestId("rendered");
  expect(within(rendered).getByRole("heading", { level: 1, name: "Hello" })).toBeInTheDocument();
  expect(within(rendered).getByText("says hi")).toBeInTheDocument(); // front matter
  expect(pre()).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: "raw" }));
  await waitFor(() => expect(pre()).toHaveTextContent(/# Hello more/));
  await userEvent.click(screen.getByRole("button", { name: "rendered" }));
  expect(screen.getByText("53 B")).toBeInTheDocument();
  const history = await screen.findByRole("list", { name: "Versions" });
  expect(within(history).getAllByRole("link", { name: /^v\d$/ })).toHaveLength(2);
  expect(within(history).getByLabelText("0 added, 1 changed, 0 removed")).toHaveTextContent("~1");
  expect(within(history).getByLabelText("1 added, 0 changed, 0 removed")).toHaveTextContent("+1");
  expect(within(history).getAllByText("mac")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: /Roll back/ })).not.toBeInTheDocument();
  first.unmount();
  renderApp({ path: "/skills/user/claude/skills/nope" });
  expect(await screen.findByText("Page not found")).toBeInTheDocument();
});

test("viewing an old version shows its content and offers rollback with the right parent", async () => {
  const { router } = renderApp({ path: "/skills/user/claude/skills/hello" });
  const history = await screen.findByRole("list", { name: "Versions" });
  await userEvent.click(within(history).getByRole("link", { name: "v1" }));
  await waitFor(() => expect(router.state.location.search).toBe("?v=1"));
  expect(await screen.findByText(/Viewing v1/)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByTestId("rendered")).not.toHaveTextContent("more"));

  await userEvent.click(screen.getByRole("button", { name: "Roll back to v1" }));
  expect(await screen.findByText("Republish v1 as v3?")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(router.state.location.search).toBe(""));
  expect(puts).toEqual([{ parent: 2, host: "web", files: v1.files }]);
  expect(await screen.findByText("v3 (from v2)")).toBeInTheDocument();
});

test("diff shows added lines between consecutive versions", async () => {
  renderApp({ path: "/skills/user/claude/skills/hello?diff=2" });
  expect(await screen.findByText(/v1 → v2 · 1 file changed/)).toBeInTheDocument();
  const diff = await screen.findByTestId("diff:SKILL.md");
  expect(within(diff).getByText("+ more")).toBeInTheDocument();
  expect(within(diff).queryByText(/^- /)).not.toBeInTheDocument();
});

test("delete confirms inline, calls DELETE and returns to the list", async () => {
  let deleted: string | undefined;
  server.use(
    http.delete("*/v1/bundles/:scope/:agent/*", ({ request }) => {
      deleted = new URL(request.url).pathname;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { router } = renderApp({ path: "/skills/user/claude/skills/hello" });
  await screen.findByRole("heading", { name: "hello" });
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(await screen.findByText("Delete all 2 versions?")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/skills"));
  expect(deleted).toMatch(/\/v1\/bundles\/user\/claude\/skills(\/|%2F)hello$/);
});
