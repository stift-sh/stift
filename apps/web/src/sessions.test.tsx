import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session } from "@stift/shared";
import { setToken } from "./api/client";
import { renderApp } from "./test/render";
import { http, HttpResponse, server } from "./test/msw";

const TOKEN = "stf_" + "a".repeat(48);

const session = (over: Partial<Session>): Session => ({
  id: "abc123",
  key: "claude/mac/proj/s1",
  agent: "claude",
  session_id: "s1",
  project: "proj",
  host: "mac",
  title: "Fix the build",
  base: "home",
  files: 3,
  size: 2048,
  sha256: "f".repeat(64),
  mod_time: "2026-08-27T10:00:00Z",
  created_at: "2026-08-27T10:00:00Z",
  updated_at: "2026-08-27T10:00:00Z",
  ...over,
});
const all = [session({}), session({ id: "def456", agent: "cursor", host: "linux", title: "", key: "cursor/linux/proj/s2", session_id: "s2" })];

let requests: URL[];
beforeEach(() => {
  setToken(TOKEN);
  requests = [];
  server.use(
    http.get("*/v1/sessions", ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const agent = url.searchParams.get("agent");
      const q = url.searchParams.get("q");
      return HttpResponse.json(all.filter((s) => (!agent || s.agent === agent) && (!q || (s.title ?? "").includes(q))));
    }),
    http.get("*/v1/sessions/:id", ({ params }) => {
      const found = all.find((s) => s.id === params.id);
      return found ? HttpResponse.json(found) : HttpResponse.json({ error: "session not found" }, { status: 404 });
    }),
  );
});

test("lists sessions and filters through the query string", async () => {
  const { router } = renderApp({ path: "/sessions" });
  expect(await screen.findByText("Fix the build")).toBeInTheDocument();
  expect(screen.getByText("cursor/linux/proj/s2")).toBeInTheDocument();
  expect(screen.getAllByText("2.0 KB")).toHaveLength(2);

  await userEvent.selectOptions(screen.getByLabelText("Agent"), "cursor");
  await waitFor(() => expect(router.state.location.search).toBe("?agent=cursor"));
  await waitFor(() => expect(screen.queryByText("Fix the build")).not.toBeInTheDocument());
  expect(requests.at(-1)?.searchParams.get("agent")).toBe("cursor");

  await userEvent.type(screen.getByLabelText("Search"), "Fix");
  await waitFor(() => expect(router.state.location.search).toBe("?agent=cursor&q=Fix"));
  expect(await screen.findByText("Nothing matches")).toBeInTheDocument();

  await userEvent.click(within(screen.getByText("Nothing matches").parentElement!).getByRole("button", { name: "Clear filters" }));
  await waitFor(() => expect(router.state.location.search).toBe(""));
  expect(await screen.findByText("Fix the build")).toBeInTheDocument();
});

test("filters from the URL are applied on load", async () => {
  renderApp({ path: "/sessions?agent=claude" });
  expect(await screen.findByText("Fix the build")).toBeInTheDocument();
  expect(requests[0].searchParams.get("agent")).toBe("claude");
  expect(screen.getByLabelText("Agent")).toHaveValue("claude");
});

test("empty list teaches the CLI", async () => {
  server.use(http.get("*/v1/sessions", () => HttpResponse.json([])));
  renderApp({ path: "/sessions" });
  expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
  expect(screen.getByText(/stift login/)).toBeInTheDocument();
});

test("detail shows metadata and 404s for unknown ids", async () => {
  const first = renderApp({ path: "/sessions/abc123" });
  expect(await screen.findByRole("heading", { name: "Fix the build" })).toBeInTheDocument();
  expect(screen.getByText("f".repeat(64))).toBeInTheDocument();
  expect(screen.getByText("s1")).toBeInTheDocument();
  first.unmount();
  renderApp({ path: "/sessions/nope" });
  expect(await screen.findByText("Page not found")).toBeInTheDocument();
});

test("delete confirms inline, calls DELETE and returns to the list", async () => {
  let deleted: string | undefined;
  server.use(
    http.delete("*/v1/sessions/:id", ({ params }) => {
      deleted = String(params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { router } = renderApp({ path: "/sessions/abc123" });
  await screen.findByRole("heading", { name: "Fix the build" });
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(await screen.findByText("Delete?")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByText("Delete?")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Delete" }));
  await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/sessions"));
  expect(deleted).toBe("abc123");
});

test("download requests the archive with the bearer", async () => {
  let auth: string | null = null;
  server.use(
    http.get("*/v1/sessions/:id/archive", ({ request }) => {
      auth = request.headers.get("authorization");
      return new HttpResponse(new Uint8Array([0x1f, 0x8b]), { headers: { "content-type": "application/gzip" } });
    }),
  );
  const create = vi.fn(() => "blob:x");
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  renderApp({ path: "/sessions/abc123" });
  await screen.findByRole("heading", { name: "Fix the build" });
  await userEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(click).toHaveBeenCalled());
  expect(auth).toBe(`Bearer ${TOKEN}`);
  expect(create).toHaveBeenCalled();
});
