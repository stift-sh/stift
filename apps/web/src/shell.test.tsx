import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getToken, setToken } from "./api/client";
import { renderApp } from "./test/render";
import { http, HttpResponse, server, unauthorized } from "./test/msw";

const TOKEN = "stf_" + "a".repeat(48);

async function login(token = TOKEN) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("API token"), token);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

test("login stores the token and lands on /sessions", async () => {
  const { router } = renderApp({ path: "/" });
  await login();
  expect(await screen.findByRole("heading", { name: "Sessions" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/sessions");
  expect(getToken()).toBe(TOKEN);
  expect(screen.getByText("root")).toBeInTheDocument();
});

test("login failure shows the server message and stores nothing", async () => {
  server.use(http.get("*/v1/whoami", () => HttpResponse.json({ error: "token revoked" }, { status: 401 })));
  renderApp({ path: "/login" });
  await login();
  expect(await screen.findByRole("alert")).toHaveTextContent("token revoked");
  expect(getToken()).toBeNull();
});

test("a 401 mid-session returns to login", async () => {
  setToken(TOKEN);
  const { qc } = renderApp({ path: "/skills" });
  expect(await screen.findByRole("heading", { name: "Skills" })).toBeInTheDocument();
  server.use(http.get("*/v1/whoami", unauthorized));
  await act(() => qc.invalidateQueries({ queryKey: ["whoami"] }));
  expect(await screen.findByLabelText("API token")).toBeInTheDocument();
  expect(getToken()).toBeNull();
});

test("tokens nav is hidden for non-admins and the route 404s", async () => {
  server.use(http.get("*/v1/whoami", () => HttpResponse.json({ name: "dev", admin: false })));
  setToken(TOKEN);
  renderApp({ path: "/tokens" });
  expect(await screen.findByText("dev")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Tokens" })).not.toBeInTheDocument();
  expect(screen.getByText("Page not found")).toBeInTheDocument();
});

test("cloud entries appear only with the cloud feature", async () => {
  setToken(TOKEN);
  const first = renderApp({ path: "/sessions" });
  await screen.findByText("root");
  expect(screen.queryByRole("link", { name: "Billing" })).not.toBeInTheDocument();
  expect(screen.queryByText("cloud")).not.toBeInTheDocument();
  first.unmount();

  server.use(http.get("*/api/version", () => HttpResponse.json({ version: "t", api: 1, features: ["cloud"] })));
  renderApp({ path: "/sessions" });
  expect(await screen.findByRole("link", { name: "Billing" })).toBeInTheDocument();
  expect(screen.getByText("cloud")).toBeInTheDocument();
});

test("sign out clears the token and shows login", async () => {
  setToken(TOKEN);
  renderApp({ path: "/sessions" });
  await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
  expect(await screen.findByLabelText("API token")).toBeInTheDocument();
  expect(getToken()).toBeNull();
});
