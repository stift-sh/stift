import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TokenInfo } from "@stift/shared";
import { setToken } from "./api/client";
import { renderApp } from "./test/render";
import { http, HttpResponse, member, server } from "./test/msw";

const TOKEN = "stf_" + "a".repeat(48);
const SECRET = "stf_" + "b".repeat(48);

let tokens: TokenInfo[];
beforeEach(() => {
  setToken(TOKEN);
  tokens = [
    { id: "t1", name: "laptop", admin: false, created_at: "2026-08-27T10:00:00Z", last_used_at: null, user: { id: "u-dev", name: "dev" } },
    { id: "t2", name: "root", admin: true, created_at: "2026-08-20T10:00:00Z", last_used_at: "2026-08-20T12:00:00Z", user: { id: "u-root", name: "root" } },
  ];
  server.use(
    http.get("*/v1/tokens", () => HttpResponse.json(tokens)),
    http.post("*/v1/tokens", async ({ request }) => {
      const body = (await request.json()) as { name: string; admin?: boolean };
      const info = { id: "t3", name: body.name, admin: body.admin ?? false, created_at: "2026-08-27T11:00:00Z", last_used_at: null };
      tokens = [...tokens, info];
      return HttpResponse.json({ ...info, token: SECRET }, { status: 201 });
    }),
    http.delete("*/v1/tokens/:id", ({ params }) => {
      if (params.id === "t2") return HttpResponse.json({ error: "refusing to revoke the token used for this request" }, { status: 400 });
      tokens = tokens.filter((t) => t.id !== params.id);
      return new HttpResponse(null, { status: 204 });
    }),
  );
});

test("lists tokens with their role and, for admins, their user", async () => {
  renderApp({ path: "/tokens" });
  expect(await screen.findByText("laptop")).toBeInTheDocument();
  expect(screen.getByRole("columnheader", { name: "User" })).toBeInTheDocument();
  expect(screen.getByText("laptop").closest("tr")).toHaveTextContent("dev");
  expect(screen.getByText("member")).toBeInTheDocument();
  expect(screen.getByText("admin", { selector: ".badge" })).toBeInTheDocument();
  expect(screen.getByText("never")).toBeInTheDocument();
  expect(screen.getByText("root", { selector: "td.mono" }).closest("tr")).toHaveTextContent(/never|ago/);
});

test("members see their own tokens without the user column or admin checkbox", async () => {
  server.use(
    http.get("*/v1/whoami", () => HttpResponse.json(member)),
    http.get("*/v1/tokens", () => HttpResponse.json([tokens[0]])),
  );
  renderApp({ path: "/tokens" });
  expect(await screen.findByText("laptop")).toBeInTheDocument();
  expect(screen.getByText(/Your API tokens/)).toBeInTheDocument();
  expect(screen.queryByRole("columnheader", { name: "User" })).not.toBeInTheDocument();
  expect(screen.queryByText("root", { selector: "td" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Create token" }));
  const form = screen.getByRole("form", { name: "Create token" });
  expect(within(form).queryByRole("checkbox")).not.toBeInTheDocument();
});

test("empty list explains the secret is shown once", async () => {
  tokens = [];
  renderApp({ path: "/tokens" });
  expect(await screen.findByText("No tokens yet")).toBeInTheDocument();
});

test("create shows the secret once and refreshes the list", async () => {
  renderApp({ path: "/tokens" });
  await screen.findByText("laptop");
  await userEvent.click(screen.getByRole("button", { name: "Create token" }));
  const form = screen.getByRole("form", { name: "Create token" });
  await userEvent.type(within(form).getByLabelText("Name"), "ci");
  await userEvent.click(within(form).getByRole("checkbox"));
  await userEvent.click(within(form).getByRole("button", { name: "Create" }));

  const created = await screen.findByRole("region", { name: "Token created" });
  expect(within(created).getByText(SECRET)).toBeInTheDocument();
  expect(within(created).getByText(new RegExp(`stift login ${window.location.origin} --token ${SECRET}`))).toBeInTheDocument();
  expect(await screen.findByText("ci", { selector: "td" })).toBeInTheDocument();
  expect(screen.getAllByText("admin", { selector: ".badge" })).toHaveLength(2);

  await userEvent.click(within(created).getByRole("button", { name: "Done" }));
  expect(screen.queryByText(SECRET)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create token" })).toBeInTheDocument();
});

test("revoke confirms inline and surfaces the server's refusal", async () => {
  renderApp({ path: "/tokens" });
  const laptop = (await screen.findByText("laptop")).closest("tr")!;
  await userEvent.click(within(laptop).getByRole("button", { name: "Revoke" }));
  await userEvent.click(within(laptop).getByRole("button", { name: "Cancel" }));
  expect(within(laptop).queryByText("Revoke?")).not.toBeInTheDocument();
  await userEvent.click(within(laptop).getByRole("button", { name: "Revoke" }));
  await userEvent.click(within(laptop).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByText("laptop")).not.toBeInTheDocument());

  const root = screen.getByText("root", { selector: "td.mono" }).closest("tr")!;
  await userEvent.click(within(root).getByRole("button", { name: "Revoke" }));
  await userEvent.click(within(root).getByRole("button", { name: "Confirm" }));
  expect(await within(root).findByRole("alert")).toHaveTextContent("refusing to revoke");
  expect(screen.getByText("root", { selector: "td.mono" })).toBeInTheDocument();
});
