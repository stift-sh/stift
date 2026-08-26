import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Pushes a skill twice with the Go CLI and drives the skills screens:
// list → detail → old version → diff → rollback → edit in the browser
// (then `stift pull` sees it) → delete.
const token = process.env.STIFT_TEST_TOKEN;
const serverUrl = process.env.STIFT_TEST_SERVER;
test.skip(!token || !serverUrl, "STIFT_TEST_TOKEN not set");

const stift = resolve(dirname(fileURLToPath(import.meta.url)), "../../../cli/bin/stift");
let work: string;
let env: NodeJS.ProcessEnv;
let skill: string;

test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "stift-e2e-skills-"));
  const home = join(work, "home");
  skill = join(home, ".claude/skills/e2e-hello");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: e2e-hello\ndescription: says hi from playwright\n---\n# Hello\n");
  env = {
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
  await expect(page.getByTestId("rendered").getByRole("heading", { name: "Hello" })).toBeVisible();
  await expect(page.getByTestId("rendered")).toContainText("more");

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
  await expect(page.getByTestId("rendered")).not.toContainText("more");

  await page.getByRole("link", { name: "edit" }).first().click();
  await expect(page).toHaveURL(/edit=SKILL\.md/);
  const editor = page.getByRole("textbox", { name: "SKILL.md source" });
  await expect(editor).toHaveValue(/# Hello/);
  await editor.fill((await editor.inputValue()) + "edited in the browser\n");
  await page.getByRole("button", { name: "Save as v4" }).click();
  await expect(page).toHaveURL(/\/skills\/user\/claude\/skills\/e2e-hello$/);
  await expect(history.getByRole("link", { name: "v4" })).toBeVisible();
  await expect(page.getByTestId("rendered")).toContainText("edited in the browser");
  execFileSync(stift, ["pull", "--skills", "--scope", "user", "--name", "skills/e2e-hello", "--force"], { env });
  expect(readFileSync(join(skill, "SKILL.md"), "utf8")).toContain("edited in the browser");

  await page.getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page).toHaveURL(/\/skills$/);
  await expect(page.getByRole("row").filter({ hasText: "e2e-hello" })).toHaveCount(0);
});
