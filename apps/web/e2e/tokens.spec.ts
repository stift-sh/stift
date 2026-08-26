import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Creates a token in the UI, uses it from the Go CLI, revokes it in the UI
// and checks the CLI is then rejected.
const token = process.env.STIFT_TEST_TOKEN;
const serverUrl = process.env.STIFT_TEST_SERVER;
test.skip(!token || !serverUrl, "STIFT_TEST_TOKEN not set");

const stift = resolve(dirname(fileURLToPath(import.meta.url)), "../../../cli/bin/stift");
let work: string;
test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "stift-e2e-tokens-"));
});
test.afterAll(() => rmSync(work, { recursive: true, force: true }));

test("a token created in the UI works in the CLI until revoked", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("API token").fill(token!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Tokens" }).click();
  await expect(page).toHaveURL(/\/tokens$/);

  await page.getByRole("button", { name: "Create token" }).click();
  const form = page.getByRole("form", { name: "Create token" });
  await form.getByLabel("Name").fill("playwright");
  await form.getByRole("button", { name: "Create" }).click();
  const created = page.getByRole("region", { name: "Token created" });
  const secret = (await created.locator("code").first().textContent())!.trim();
  expect(secret).toMatch(/^stf_/);
  await created.getByRole("button", { name: "Done" }).click();
  const row = page.getByRole("row").filter({ hasText: "playwright" });
  await expect(row).toContainText("never");

  const env = { ...process.env, HOME: work, STIFT_CONFIG: join(work, "config.json"), STIFT_STATE: join(work, "state") };
  // `stift login` validates the token against /v1/whoami and prints the name.
  expect(execFileSync(stift, ["login", serverUrl!, "--token", secret, "--no-daemon"], { env }).toString()).toContain("playwright");

  // The CLI login touched last_used_at; a reload shows it.
  await page.reload();
  await expect(row).toContainText("just now");
  await row.getByRole("button", { name: "Revoke" }).click();
  await row.getByRole("button", { name: "Confirm" }).click();
  await expect(row).toHaveCount(0);
  expect(() => execFileSync(stift, ["login", serverUrl!, "--token", secret, "--no-daemon"], { env, stdio: "pipe" })).toThrow();

  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Get started" }).click();
  await expect(page.getByText(`stift login ${serverUrl} --token <token>`)).toBeVisible();
});
