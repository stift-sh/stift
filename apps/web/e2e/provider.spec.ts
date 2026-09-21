import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

// Runs only against a server started with STIFT_AUTH=local,jwt,
// STIFT_JWT_SECRET and STIFT_LOGIN_PROVIDER=test (see ci.yml): the spec
// signs the JWTs the test adapter hands to the app, one per org.
const secret = process.env.STIFT_JWT_SECRET;
test.skip(!secret || process.env.STIFT_LOGIN_PROVIDER !== "test", "server not started with the test sign-in provider");

const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
function jwt(org: { id: string; slug: string; name: string }) {
  const claims = { sub: "user_ada", name: "Ada", org_id: org.id, org_slug: org.slug, org_name: org.name, org_role: "org:admin", exp: Math.floor(Date.now() / 1000) + 600 };
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}`;
  return `${body}.${createHmac("sha256", secret!).update(body).digest("base64url")}`;
}

test("provider sign-in, org switch and sign out", async ({ page }) => {
  const sessions = [
    { org: "Acme", token: jwt({ id: "org_acme", slug: "acme", name: "Acme" }) },
    { org: "Beta", token: jwt({ id: "org_beta", slug: "beta", name: "Beta" }) },
  ];
  await page.addInitScript((s) => {
    (window as unknown as { __stiftTestAuth: unknown }).__stiftTestAuth = { sessions: s };
  }, sessions);

  await page.goto("/skills");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Use an API token instead" })).toBeVisible();
  await page.getByRole("button", { name: "Sign in as the test user" }).click();
  await expect(page).toHaveURL(/\/skills$/);
  await expect(page.getByText("Ada · Acme · admin")).toBeVisible();

  // A token made here belongs to Acme only: the other org starts empty.
  await page.goto("/tokens");
  await page.getByRole("button", { name: "Create token" }).click();
  const form = page.getByRole("form", { name: "Create token" });
  await form.getByLabel("Name").fill("laptop");
  await form.getByRole("button", { name: "Create" }).click();
  await page.getByRole("region", { name: "Token created" }).getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("row").filter({ hasText: "laptop" })).toBeVisible();
  await page.getByLabel("Organization").selectOption("Beta");
  await expect(page.getByText("Ada · Beta · admin")).toBeVisible();
  await expect(page.getByText("No tokens yet")).toBeVisible();

  // The session survives a reload, and ends on sign out.
  await page.reload();
  await expect(page.getByText("Ada · Beta · admin")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("button", { name: "Sign in as the test user" })).toBeVisible();
});
