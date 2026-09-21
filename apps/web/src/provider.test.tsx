import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Version } from "@stift/shared";
import { browser } from "./api/billing";
import { getToken } from "./api/client";
import { renderApp } from "./test/render";
import { admin, http, HttpResponse, member, server, version } from "./test/msw";

const BILLING = "https://billing.test";
const cloud: Version = { ...version, features: ["cloud"], auth: { kinds: ["token", "jwt"], login: { provider: "test" } }, cloud_api_url: BILLING };
const orgs: Record<string, string> = { "jwt-acme": "Acme", "jwt-beta": "Beta" };

/** A server with the test sign-in adapter: whoami answers by JWT. */
function provider(v: Version = cloud, who = admin) {
  window.__stiftTestAuth = { sessions: [{ org: "Acme", token: "jwt-acme" }, { org: "Beta", token: "jwt-beta" }] };
  server.use(
    http.get("*/api/version", () => HttpResponse.json(v)),
    http.get("*/v1/whoami", ({ request }) => {
      const name = orgs[request.headers.get("authorization")?.replace("Bearer ", "") ?? ""];
      if (!name) return HttpResponse.json({ error: "invalid token" }, { status: 401 });
      return HttpResponse.json({ ...who, org: { id: name.toLowerCase(), slug: name.toLowerCase(), name } });
    }),
  );
}

async function signIn() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Sign in as the test user" }));
  return user;
}

test("provider sign-in sends its token per request and stores none", async () => {
  provider();
  const { router } = renderApp({ path: "/skills" });
  await signIn();
  expect(await screen.findByRole("heading", { name: "Skills" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/skills");
  expect(await screen.findByText(/· Acme ·/)).toBeInTheDocument();
  expect(getToken()).toBeNull();
});

test("switching org refetches as the other org", async () => {
  provider();
  renderApp({ path: "/sessions" });
  const user = await signIn();
  await screen.findByText(/· Acme ·/);
  await user.selectOptions(screen.getByLabelText("Organization"), "Beta");
  expect(await screen.findByText(/· Beta ·/)).toBeInTheDocument();
});

test("sign out ends the provider session", async () => {
  provider();
  renderApp({ path: "/sessions" });
  const user = await signIn();
  await user.click(await screen.findByRole("button", { name: "Sign out" }));
  expect(await screen.findByRole("button", { name: "Sign in as the test user" })).toBeInTheDocument();
  expect(sessionStorage.length).toBe(0);
});

test("the token form stays reachable only when the server takes tokens", async () => {
  provider();
  const first = renderApp({ path: "/login" });
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Use an API token instead" }));
  expect(screen.getByLabelText("API token")).toBeInTheDocument();
  first.unmount();

  provider({ ...cloud, auth: { kinds: ["jwt"], login: { provider: "test" } } });
  renderApp({ path: "/login" });
  await screen.findByRole("button", { name: "Sign in as the test user" });
  expect(screen.queryByRole("button", { name: "Use an API token instead" })).not.toBeInTheDocument();
});

test("a session without an org gets the switcher, not a sign-out", async () => {
  provider();
  server.use(http.get("*/v1/whoami", () => HttpResponse.json({ error: "no organization selected" }, { status: 401 })));
  renderApp({ path: "/sessions" });
  await signIn();
  const notice = (await screen.findByText("Pick an organization")).closest("div")!;
  expect(notice).toHaveTextContent("no organization selected");
  expect(within(notice).getByLabelText("Organization")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
});

describe("billing", () => {
  const status = (body: object) =>
    server.use(
      http.get(`${BILLING}/billing/status`, ({ request }) =>
        request.headers.get("authorization") === "Bearer jwt-acme" ? HttpResponse.json(body) : HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

  test("an admin on the free plan upgrades through checkout", async () => {
    provider();
    status({ plan: "free", status: null, seats: 2, current_period_end: null });
    server.use(http.post(`${BILLING}/billing/checkout`, () => HttpResponse.json({ url: "https://stripe.test/c/1" })));
    const go = vi.spyOn(browser, "go").mockImplementation(() => {});
    renderApp({ path: "/billing" });
    const user = await signIn();
    const plan = await screen.findByRole("region", { name: "Plan" });
    expect(plan).toHaveTextContent("Free");
    expect(plan).toHaveTextContent("2 seats");
    expect(await screen.findByRole("region", { name: "Organization" })).toBeInTheDocument();
    await user.click(within(plan).getByRole("button", { name: "Upgrade to Pro" }));
    await vi.waitFor(() => expect(go).toHaveBeenCalledWith("https://stripe.test/c/1"));
  });

  test("pro manages through the portal; members only read", async () => {
    provider();
    status({ plan: "pro", status: "past_due", seats: 1, current_period_end: "2026-10-21T00:00:00Z" });
    const first = renderApp({ path: "/billing" });
    await signIn();
    const plan = await screen.findByRole("region", { name: "Plan" });
    expect(plan).toHaveTextContent(/Pro.*1 seat · past due · renews/);
    expect(within(plan).getByRole("button", { name: "Manage subscription" })).toBeInTheDocument();
    first.unmount();

    provider(cloud, member);
    renderApp({ path: "/billing" });
    const readonly = await screen.findByRole("region", { name: "Plan" });
    expect(within(readonly).queryByRole("button")).not.toBeInTheDocument();
    expect(readonly).toHaveTextContent("Ask an admin");
  });

  test("a billing failure shows its message and keeps the session", async () => {
    provider();
    server.use(http.get(`${BILLING}/billing/status`, () => HttpResponse.json({ error: "unauthorized" }, { status: 401 })));
    renderApp({ path: "/billing" });
    await signIn();
    expect(await screen.findByRole("alert")).toHaveTextContent("unauthorized");
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  test("without a billing service the route is not found", async () => {
    provider({ ...cloud, cloud_api_url: undefined });
    renderApp({ path: "/billing" });
    await signIn();
    expect(await screen.findByText("Page not found")).toBeInTheDocument();
  });
});

test("the Clerk frontend API host comes out of the publishable key", async () => {
  const { frontendApi } = await import("./auth/clerk");
  expect(frontendApi(`pk_live_${btoa("clerk.stift.sh$")}`)).toBe("clerk.stift.sh");
  expect(() => frontendApi(`pk_live_${btoa("evil.test/x?$")}`)).toThrow("malformed");
  expect(() => frontendApi("sk_live_nope")).toThrow("malformed");
});
