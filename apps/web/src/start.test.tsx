import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "./api/client";
import { renderApp } from "./test/render";
import { http, HttpResponse, member, orgOverview, server } from "./test/msw";

const TOKEN = "stf_" + "a".repeat(48);
beforeEach(() => setToken(TOKEN));

test("login line carries this server's origin and admins get a tokens link", async () => {
  renderApp({ path: "/start" });
  expect(await screen.findByRole("heading", { name: "Get started" })).toBeInTheDocument();
  expect(screen.getByText(`stift login ${window.location.origin} --token <token>`)).toBeInTheDocument();
  expect(await within(screen.getByRole("main")).findByRole("link", { name: "Tokens" })).toBeInTheDocument();
  expect(screen.getByText("claude", { selector: ".badge" })).toBeInTheDocument();
});

test("members get the tokens link too: tokens are per user", async () => {
  server.use(http.get("*/v1/whoami", () => HttpResponse.json(member)));
  renderApp({ path: "/start" });
  expect(await within(screen.getByRole("main")).findByRole("link", { name: "Tokens" })).toBeInTheDocument();
});

test("copy writes the command to the clipboard", async () => {
  const write = vi.fn(() => Promise.resolve());
  Object.assign(navigator, { clipboard: { writeText: write } });
  renderApp({ path: "/start" });
  await screen.findByRole("heading", { name: "Get started" });
  await userEvent.click(screen.getAllByRole("button", { name: "Copy to clipboard" })[0]);
  expect(write).toHaveBeenCalledWith("curl -fsSL https://stift.sh/install.sh | sh");
  expect(await screen.findByText("Copied")).toBeInTheDocument();
});

test("the org card shows usage against the limits", async () => {
  server.use(http.get("*/v1/org", () => HttpResponse.json({ ...orgOverview, limits: { skills: 2, storage_bytes: 4096, seats: null } })));
  renderApp({ path: "/start" });
  const card = await screen.findByRole("region", { name: "Organization" });
  expect(card).toHaveTextContent("Acme");
  expect(card).toHaveTextContent("2 / 2");
  expect(card).toHaveTextContent("2.0 KB / 4.0 KB");
  expect(card).toHaveTextContent("2 · unlimited");
});

test("admins edit the org name and slug; the card and whoami follow", async () => {
  const patches: unknown[] = [];
  server.use(
    http.patch("*/v1/org", async ({ request }) => {
      const body = (await request.json()) as { name?: string; slug?: string };
      patches.push(body);
      if (body.slug === "taken") return HttpResponse.json({ error: 'slug "taken" is taken' }, { status: 409 });
      return HttpResponse.json({ ...orgOverview, name: body.name ?? orgOverview.name, slug: body.slug ?? orgOverview.slug });
    }),
  );
  renderApp({ path: "/start" });
  const card = await screen.findByRole("region", { name: "Organization" });
  expect(card).toHaveTextContent("@default");
  expect(card).toHaveTextContent("set a slug before publishing skills");

  await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
  const form = within(card).getByRole("form", { name: "Edit organization" });
  const slug = within(form).getByLabelText("Slug");
  await userEvent.clear(slug);
  await userEvent.type(slug, "taken");
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));
  expect(await within(form).findByRole("alert")).toHaveTextContent('slug "taken" is taken');

  await userEvent.clear(slug);
  await userEvent.type(slug, "acme");
  await userEvent.click(within(form).getByRole("button", { name: "Save" }));
  expect(await within(card).findByText("@acme")).toBeInTheDocument();
  // Only the changed field is sent.
  expect(patches).toEqual([{ slug: "taken" }, { slug: "acme" }]);
  expect(card).not.toHaveTextContent("set a slug before publishing");
});

test("a locked slug cannot be edited; members see no edit button", async () => {
  server.use(http.get("*/v1/org", () => HttpResponse.json({ ...orgOverview, slug: "acme", slug_locked: true })));
  renderApp({ path: "/start" });
  const card = await screen.findByRole("region", { name: "Organization" });
  await userEvent.click(within(card).getByRole("button", { name: "Edit" }));
  expect(within(card).getByLabelText("Slug")).toBeDisabled();
  expect(card).toHaveTextContent("Locked: published skills are addressed as @acme/…");
});

test("members see the slug but cannot edit the org", async () => {
  server.use(http.get("*/v1/whoami", () => HttpResponse.json(member)));
  renderApp({ path: "/start" });
  const card = await screen.findByRole("region", { name: "Organization" });
  expect(card).toHaveTextContent("@default");
  expect(within(card).queryByRole("button", { name: "Edit" })).toBeNull();
  expect(card).not.toHaveTextContent("set a slug before publishing");
});
