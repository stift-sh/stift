import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Bundle, PublishedSkillDetail, PublishedVersion } from "@stift/shared";
import { setToken } from "./api/client";
import { installCommand } from "./api/published";
import { renderApp } from "./test/render";
import { http, HttpResponse, member, orgOverview, server } from "./test/msw";

const TOKEN = "stf_" + "a".repeat(48);
const SHA = "1".repeat(64);
const bundle = (over: Partial<Bundle>): Bundle => ({
  scope: "org",
  agent: "claude",
  name: "skills/deploy",
  version: 1,
  parent: 0,
  host: "mac",
  author: "root",
  created: "2026-09-10T10:00:00Z",
  files: [{ path: "SKILL.md", sha256: SHA, size: 48, mode: 0o644 }],
  skills: [{ path: "SKILL.md", name: "deploy", description: "ships it" }],
  ...over,
});
const v1 = bundle({});
const v2 = bundle({ version: 2, parent: 1 });
const pv = (over: Partial<PublishedVersion>): PublishedVersion => ({
  org: "acme",
  name: "deploy",
  version: 1,
  source_version: 1,
  files: v1.files,
  skills: v1.skills,
  readme_path: "SKILL.md",
  published_by: { id: "u-root", name: "root" },
  created_at: "2026-09-11T10:00:00Z",
  unpublished_at: null,
  ...over,
});
const skill = (over: Partial<PublishedSkillDetail>): PublishedSkillDetail => ({
  org: "acme",
  name: "deploy",
  agent: "claude",
  unit: "skills/deploy",
  description: "ships it",
  license: "MIT",
  latest: 1,
  created_at: "2026-09-11T10:00:00Z",
  updated_at: "2026-09-11T10:00:00Z",
  unpublished_at: null,
  versions: [pv({})],
  ...over,
});
const acme = { ...orgOverview, slug: "acme" };

let published: PublishedSkillDetail[];
let calls: { method: string; url: string; body?: unknown }[];
const withRegistry = (features: string[] = ["registry"]) => server.use(http.get("*/api/version", () => HttpResponse.json({ version: "t", api: 1, features })));

beforeEach(() => {
  setToken(TOKEN);
  published = [];
  calls = [];
  withRegistry();
  server.use(
    http.get("*/v1/org", () => HttpResponse.json(acme)),
    http.get("*/v1/bundles/:scope/:agent/*", ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get("history") === "1") return HttpResponse.json([v2, v1]);
      const v = Number(url.searchParams.get("version") ?? 0);
      return HttpResponse.json(v === 1 ? v1 : v2);
    }),
    http.get("*/v1/blobs/:sha", () => new HttpResponse("---\nname: deploy\n---\n# Deploy\n", { headers: { "content-type": "application/octet-stream" } })),
    http.get("*/v1/published", () => HttpResponse.json(published)),
    http.post("*/v1/published", async ({ request }) => {
      const body = (await request.json()) as { name?: string; license?: string; version?: number };
      calls.push({ method: "POST", url: "/v1/published", body });
      const prev = published[0];
      const version = pv({ version: (prev?.versions[0]?.version ?? 0) + 1, source_version: body.version ?? 2 });
      published = [skill({ latest: version.version, license: body.license ?? prev?.license ?? "MIT", versions: [version, ...(prev?.versions ?? [])] })];
      return HttpResponse.json(version, { status: 201 });
    }),
    http.delete("*/v1/published/:name", ({ request, params }) => {
      calls.push({ method: "DELETE", url: `/v1/published/${params.name}${new URL(request.url).search}` });
      const version = Number(new URL(request.url).searchParams.get("version") ?? 0);
      const p = published[0];
      published = [
        version
          ? { ...p, latest: 0, versions: p.versions.map((v) => (v.version === version ? { ...v, unpublished_at: "2026-09-12T10:00:00Z" } : v)) }
          : { ...p, latest: 0, unpublished_at: "2026-09-12T10:00:00Z" },
      ];
      return new HttpResponse(null, { status: 204 });
    }),
    http.post("*/v1/published/:name/restore", ({ request, params }) => {
      calls.push({ method: "POST", url: `/v1/published/${params.name}/restore${new URL(request.url).search}` });
      const p = published[0];
      published = [{ ...p, latest: p.versions[0].version, unpublished_at: null, versions: p.versions.map((v) => ({ ...v, unpublished_at: null })) }];
      return new HttpResponse(null, { status: 204 });
    }),
  );
});

const card = () => screen.findByRole("region", { name: "Published" });

test("no card without the registry feature, and none on user-scope skills", async () => {
  withRegistry([]);
  renderApp({ path: "/skills/org/claude/skills/deploy" });
  await screen.findByRole("region", { name: "Pulls" });
  expect(screen.queryByRole("region", { name: "Published" })).not.toBeInTheDocument();
  withRegistry();
  renderApp({ path: "/skills/user/claude/skills/deploy" });
  await screen.findAllByRole("heading", { name: "deploy" });
  expect(screen.queryByRole("region", { name: "Published" })).not.toBeInTheDocument();
});

test("first publish sends name, license and the chosen version, then shows the ref and install command", async () => {
  renderApp({ path: "/skills/org/claude/skills/deploy" });
  const c = await card();
  expect(c).toHaveTextContent("Not published");
  await userEvent.click(within(c).getByRole("button", { name: "Publish" }));
  const form = within(c).getByRole("form", { name: "Publish" });
  expect(within(form).getByLabelText("Public name")).toHaveValue("deploy");
  expect(form).toHaveTextContent("→ @acme/deploy v1");
  await userEvent.type(within(form).getByLabelText("License"), "MIT");
  await userEvent.selectOptions(within(form).getByLabelText("Version to publish"), "1");
  await userEvent.click(within(form).getByRole("button", { name: "Publish v1" }));
  await waitFor(() => expect(calls).toEqual([{ method: "POST", url: "/v1/published", body: { agent: "claude", unit: "skills/deploy", name: "deploy", license: "MIT", version: 1 } }]));
  await waitFor(() => expect(c).toHaveTextContent("@acme/deploy v1"));
  expect(within(c).getByText(installCommand("@acme/deploy"))).toBeInTheDocument();
  expect(within(c).getByRole("button", { name: "Copy Install" })).toBeInTheDocument();
  // Head (v2) is ahead of the published source (v1).
  expect(within(c).getByRole("button", { name: "Publish v2" })).toBeInTheDocument();
});

test("a server refusal is shown in the form", async () => {
  server.use(http.post("*/v1/published", () => HttpResponse.json({ error: "@acme/deploy v1 already has these files" }, { status: 409 })));
  renderApp({ path: "/skills/org/claude/skills/deploy" });
  const c = await card();
  await userEvent.click(within(c).getByRole("button", { name: "Publish" }));
  await userEvent.type(within(c).getByLabelText("License"), "MIT");
  await userEvent.click(within(c).getByRole("button", { name: "Publish v2" }));
  expect(await within(c).findByRole("alert")).toHaveTextContent("@acme/deploy v1 already has these files");
});

test("the default slug blocks publishing and points at the org card", async () => {
  server.use(http.get("*/v1/org", () => HttpResponse.json(orgOverview)));
  renderApp({ path: "/skills/org/claude/skills/deploy" });
  const c = await card();
  expect(c).toHaveTextContent("Set an org slug");
  expect(within(c).getByRole("link", { name: "Set an org slug" })).toHaveAttribute("href", "/members");
  expect(within(c).queryByRole("button", { name: "Publish" })).not.toBeInTheDocument();
});

test("republish keeps the name, unpublish and restore hit one version or the whole skill", async () => {
  published = [skill({})];
  renderApp({ path: "/skills/org/claude/skills/deploy" });
  const c = await card();
  await waitFor(() => expect(c).toHaveTextContent("@acme/deploy v1"));
  await userEvent.click(within(c).getByRole("button", { name: "Publish v2" }));
  const form = within(c).getByRole("form", { name: "Publish v2" });
  expect(within(form).getByLabelText("Public name")).toBeDisabled();
  expect(within(form).getByLabelText("License")).toHaveValue("MIT");
  expect(form).toHaveTextContent("→ @acme/deploy v2");
  await userEvent.click(within(form).getByRole("button", { name: "Publish v2" }));
  await waitFor(() => expect(calls).toEqual([{ method: "POST", url: "/v1/published", body: { agent: "claude", unit: "skills/deploy" } }]));
  await waitFor(() => expect(c).toHaveTextContent("@acme/deploy v2"));
  expect(within(c).queryByRole("button", { name: /^Publish v/ })).not.toBeInTheDocument();
  const list = within(c).getByRole("list", { name: "Published versions" });
  expect(within(list).getAllByRole("listitem").map((li) => li.textContent)).toEqual([expect.stringContaining("v2from v2 by root"), expect.stringContaining("v1from v1 by root")]);

  await userEvent.click(within(list).getByRole("button", { name: "unpublish v2" }));
  await waitFor(() => expect(calls.at(-1)).toEqual({ method: "DELETE", url: "/v1/published/deploy?version=2" }));
  await waitFor(() => expect(within(list).getByRole("button", { name: "restore v2" })).toBeInTheDocument());
  expect(c).toHaveTextContent("hidden");

  await userEvent.click(within(list).getByRole("button", { name: "restore v2" }));
  await waitFor(() => expect(calls.at(-1)).toEqual({ method: "POST", url: "/v1/published/deploy/restore?version=2" }));
  await waitFor(() => expect(c).toHaveTextContent("@acme/deploy v2"));

  await userEvent.click(within(c).getByRole("button", { name: "Unpublish" }));
  await waitFor(() => expect(calls.at(-1)).toEqual({ method: "DELETE", url: "/v1/published/deploy" }));
  await waitFor(() => expect(within(c).getByRole("button", { name: "Restore" })).toBeInTheDocument());
  expect(c).toHaveTextContent("The whole skill is hidden");
  await userEvent.click(within(c).getByRole("button", { name: "Restore" }));
  await waitFor(() => expect(calls.at(-1)).toEqual({ method: "POST", url: "/v1/published/deploy/restore" }));
  await waitFor(() => expect(within(c).getByRole("button", { name: "Unpublish" })).toBeInTheDocument());
});

test("members see the published row read-only", async () => {
  published = [skill({})];
  server.use(http.get("*/v1/whoami", () => HttpResponse.json(member)));
  renderApp({ path: "/skills/org/claude/skills/deploy" });
  const c = await card();
  await waitFor(() => expect(c).toHaveTextContent("@acme/deploy v1"));
  expect(within(c).getByText(installCommand("@acme/deploy"))).toBeInTheDocument();
  expect(within(c).queryAllByRole("button").map((b) => b.textContent)).toEqual(["Copy"]);
});

test("install command names the registry unless this server is the default one", () => {
  expect(installCommand("@acme/deploy", "https://stift.corp.example")).toBe("stift skills install @acme/deploy --registry https://stift.corp.example");
  expect(installCommand("@acme/deploy", "https://app.stift.sh")).toBe("stift skills install @acme/deploy");
});
