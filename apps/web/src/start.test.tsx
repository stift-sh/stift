import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setToken } from "./api/client";
import { renderApp } from "./test/render";
import { http, HttpResponse, member, server } from "./test/msw";

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
