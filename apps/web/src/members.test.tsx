import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Member } from "@stift/shared";
import { setToken } from "./api/client";
import { renderApp } from "./test/render";
import { http, HttpResponse, member, members as seed, orgOverview, server } from "./test/msw";

const TOKEN = "stf_" + "a".repeat(48);
const SECRET = "stf_" + "c".repeat(48);

let list: Member[];
let posted: unknown[];
beforeEach(() => {
  setToken(TOKEN);
  list = [...seed];
  posted = [];
  server.use(
    http.get("*/v1/members", () => HttpResponse.json(list)),
    http.post("*/v1/members", async ({ request }) => {
      const body = (await request.json()) as { name: string; email?: string; role?: Member["role"]; token?: string };
      posted.push(body);
      const m: Member = { id: "u-ada", name: body.name, email: body.email ?? null, role: body.role ?? "member", created_at: "2026-09-18T10:00:00Z", tokens: body.token ? 1 : 0 };
      list = [...list, m];
      return HttpResponse.json(body.token ? { ...m, token: SECRET } : m, { status: 201 });
    }),
    http.patch("*/v1/members/:id", async ({ request, params }) => {
      const { role } = (await request.json()) as { role: Member["role"] };
      if (params.id === "u-root") return HttpResponse.json({ error: "refusing to demote the last admin" }, { status: 400 });
      list = list.map((m) => (m.id === params.id ? { ...m, role } : m));
      return HttpResponse.json(list.find((m) => m.id === params.id));
    }),
    http.delete("*/v1/members/:id", ({ params }) => {
      list = list.filter((m) => m.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
});

const rowOf = (name: string) => screen.getByText(name, { selector: "td" }).closest("tr")!;

test("admins see the org card and every member, with no remove on their own row", async () => {
  server.use(http.get("*/v1/org", () => HttpResponse.json({ ...orgOverview, limits: { skills: 10, storage_bytes: null, seats: 2, sessions: null } })));
  renderApp({ path: "/members" });
  expect(await screen.findByText("dev@acme.test")).toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Main" })).toHaveTextContent("Members");
  const card = await screen.findByRole("region", { name: "Organization" });
  expect(card).toHaveTextContent("Acme");
  expect(card).toHaveTextContent("2 / 10");
  expect(card).toHaveTextContent("2.0 KB · unlimited");
  expect(within(card).getByRole("meter", { name: "Seats used" })).toHaveValue(2);
  expect(rowOf("root")).toHaveTextContent("(you)");
  expect(within(rowOf("root")).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  expect(within(rowOf("dev")).getByRole("button", { name: "Remove" })).toBeInTheDocument();
});

test("adding a member shows their first token once", async () => {
  renderApp({ path: "/members" });
  await screen.findByText("dev@acme.test");
  await userEvent.click(screen.getByRole("button", { name: "Add member" }));
  const form = screen.getByRole("form", { name: "Add member" });
  await userEvent.type(within(form).getByLabelText("Name"), "ada");
  await userEvent.click(within(form).getByRole("button", { name: "Add" }));

  const created = await screen.findByRole("region", { name: "First token for ada" });
  expect(posted).toEqual([{ name: "ada", role: "member", token: "first" }]);
  expect(within(created).getByText(SECRET)).toBeInTheDocument();
  expect(within(created).getByText(new RegExp(`stift login ${window.location.origin} --token ${SECRET}`))).toBeInTheDocument();
  expect(await screen.findByText("ada", { selector: "td" })).toBeInTheDocument();
  await userEvent.click(within(created).getByRole("button", { name: "Done" }));
  expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
});

test("adding without a token goes straight back to the list", async () => {
  renderApp({ path: "/members" });
  await screen.findByText("dev@acme.test");
  await userEvent.click(screen.getByRole("button", { name: "Add member" }));
  const form = screen.getByRole("form", { name: "Add member" });
  await userEvent.type(within(form).getByLabelText("Name"), "ada");
  await userEvent.click(within(form).getByLabelText(/Admin/));
  await userEvent.click(within(form).getByLabelText(/first token/));
  await userEvent.click(within(form).getByRole("button", { name: "Add" }));
  expect(await screen.findByText("ada", { selector: "td" })).toBeInTheDocument();
  expect(posted).toEqual([{ name: "ada", role: "admin" }]);
  expect(screen.queryByRole("region", { name: /First token/ })).not.toBeInTheDocument();
});

test("a seat limit is reported as the org being at its limit", async () => {
  server.use(http.post("*/v1/members", () => HttpResponse.json({ error: "limit: 2 seats per org" }, { status: 402 })));
  renderApp({ path: "/members" });
  await screen.findByText("dev@acme.test");
  await userEvent.click(screen.getByRole("button", { name: "Add member" }));
  const form = screen.getByRole("form", { name: "Add member" });
  await userEvent.type(within(form).getByLabelText("Name"), "ada");
  await userEvent.click(within(form).getByRole("button", { name: "Add" }));
  const alert = await within(form).findByRole("alert");
  expect(alert).toHaveTextContent("This org is at its limit.");
  expect(alert).toHaveTextContent("limit: 2 seats per org");
  expect(alert).toHaveTextContent("STIFT_MAX_");
});

test("role changes save on select and surface the last-admin refusal", async () => {
  renderApp({ path: "/members" });
  await screen.findByText("dev@acme.test");
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Role of dev" }), "admin");
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Role of dev" })).toHaveValue("admin"));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Role of root" }), "member");
  expect(await within(rowOf("root")).findByRole("alert")).toHaveTextContent("refusing to demote the last admin");
  expect(screen.getByRole("combobox", { name: "Role of root" })).toHaveValue("admin");
});

test("remove confirms inline and names the tokens that go with the member", async () => {
  renderApp({ path: "/members" });
  await screen.findByText("dev@acme.test");
  await userEvent.click(within(rowOf("dev")).getByRole("button", { name: "Remove" }));
  expect(rowOf("dev")).toHaveTextContent("Remove dev and their 2 tokens?");
  await userEvent.click(within(rowOf("dev")).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByText("dev@acme.test")).not.toBeInTheDocument());
});

test("members get a read-only list and no nav item", async () => {
  server.use(http.get("*/v1/whoami", () => HttpResponse.json(member)));
  renderApp({ path: "/members" });
  expect(await screen.findByText("dev@acme.test")).toBeInTheDocument();
  expect(rowOf("dev")).toHaveTextContent("(you)");
  expect(screen.getByText("admin", { selector: ".badge" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Main" })).not.toHaveTextContent("Members");
});
