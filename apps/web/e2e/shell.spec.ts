import { expect, test } from "@playwright/test";

const token = process.env.STIFT_TEST_TOKEN;
test.skip(!token, "STIFT_TEST_TOKEN not set");

test("token login shows the shell and sign out returns to login", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel("API token").fill(token!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/sessions$/);
  const nav = page.getByRole("navigation", { name: "Main" });
  for (const label of ["Sessions", "Skills", "Tokens", "Get started"]) {
    await expect(nav.getByRole("link", { name: label })).toBeVisible();
  }
  await expect(page.getByText("admin")).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login$/);
});
