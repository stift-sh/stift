import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Pushes a skill twice with the Go CLI and drives the skills screens:
// list → detail → old version → diff → rollback → delete.
const token = process.env.STIFT_TEST_TOKEN;
const serverUrl = process.env.STIFT_TEST_SERVER;
test.skip(!token || !serverUrl, "STIFT_TEST_TOKEN not set");

const stift = resolve(dirname(fileURLToPath(import.meta.url)), "../../../cli/bin/stift");
let work: string;

test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "stift-e2e-skills-"));
  const home = join(work, "home");
  const skill = join(home, ".claude/skills/e2e-hello");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: e2e-hello\ndescription: says hi from playwright\n---\n# Hello\n");
  const env = {
    ...process.env,
    HOME: home,
    STIFT_CONFIG: join(work, "config.json"),
    STIFT_STATE: join(work, "state"),
    STIFT_SKILLS_STATE: join(work, "skills-state"),
  };
  execFileSync(stift, ["login", serverUrl!, "--token", token!], { env });
  execFileSync(stift, ["push", "--skills", "--scope", "user", "--name", "skills/e2e-hello"], { env });
  appendFileSync(join(skill, "SKILL.md"), "more\n");
  execFileSync(stift, ["push", "--skills", "--scope", "user", "--name", "skills/e2e-hello"], { env });
});

test.afterAll(() => rmSync(work, { recursive: true, force: true }));

test("a pushed skill can be browsed, diffed, rolled back and deleted", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("API token").fill(token!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("link", { name: "Skills" }).click();
  await expect(page).toHaveURL(/\/skills$/);

  const row = page.getByRole("row").filter({ hasText: "e2e-hello" });
  await expect(row).toContainText("says hi from playwright");
  await expect(row).toContainText("v2");
  await row.getByRole("link", { name: "e2e-hello" }).click();
  await expect(page).toHaveURL(/\/skills\/user\/claude\/skills\/e2e-hello$/);
  await expect(page.getByText("# Hello")).toBeVisible();
  await expect(page.getByText("more")).toBeVisible();

  const history = page.getByRole("list", { name: "Versions" });
  await history.getByRole("link", { name: "diff" }).click();
  await expect(page.getByText("v1 → v2")).toBeVisible();
  await expect(page.getByTestId("diff:SKILL.md")).toContainText("+ more");

  await history.getByRole("link", { name: "v1" }).click();
  await expect(page.getByText("Viewing v1")).toBeVisible();
  await page.getByRole("button", { name: "Roll back to v1" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page).toHaveURL(/\/skills\/user\/claude\/skills\/e2e-hello$/);
  await expect(history.getByRole("link", { name: "v3" })).toBeVisible();
  await expect(page.getByText("more")).toHaveCount(0);

  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page).toHaveURL(/\/skills$/);
  await expect(page.getByRole("row").filter({ hasText: "e2e-hello" })).toHaveCount(0);
});
