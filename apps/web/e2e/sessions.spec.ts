import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Pushes a session with the Go CLI (cli/bin/stift, built by `pnpm build`)
// and drives the sessions screens against it.
const token = process.env.STIFT_TEST_TOKEN;
const serverUrl = process.env.STIFT_TEST_SERVER;
test.skip(!token || !serverUrl, "STIFT_TEST_TOKEN not set");

const stift = resolve(dirname(fileURLToPath(import.meta.url)), "../../../cli/bin/stift");
let work: string;

test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "stift-e2e-"));
  const home = join(work, "home");
  mkdirSync(join(home, ".e2e/runs/run-1"), { recursive: true });
  mkdirSync(join(work, "project"));
  writeFileSync(join(home, ".e2e/runs/run-1/log.txt"), "hello from playwright\n");
  writeFileSync(join(work, "agents.json"), JSON.stringify([{ name: "e2e", sessions: "~/.e2e/runs/*" }]));
  const env = {
    ...process.env,
    HOME: home,
    STIFT_CONFIG: join(work, "config.json"),
    STIFT_STATE: join(work, "state"),
    STIFT_AGENTS: join(work, "agents.json"),
  };
  execFileSync(stift, ["login", serverUrl!, "--token", token!], { env });
  try {
    execFileSync(stift, ["stop"], { env });
  } catch {
    // no daemon running
  }
  execFileSync(stift, ["push", "--agent", "e2e", "--all-projects"], { env, cwd: join(work, "project") });
});

test.afterAll(() => rmSync(work, { recursive: true, force: true }));

test("a pushed session is listed, filterable, downloadable and deletable", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("API token").fill(token!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/sessions$/);

  const row = page.getByRole("row").filter({ hasText: "e2e" });
  await expect(row).toBeVisible();

  await page.getByLabel("Agent").selectOption("e2e");
  await expect(page).toHaveURL(/agent=e2e/);
  await expect(row).toBeVisible();

  await row.getByRole("link").click();
  await expect(page).toHaveURL(/\/sessions\/[0-9a-f]+$/);
  await expect(page.getByText("SHA-256")).toBeVisible();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.tar\.gz$/);

  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(page.getByText("No sessions yet")).toBeVisible();
});
