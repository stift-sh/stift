import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// The company registry end to end: an admin adds a member in the UI and
// hands over the token; the member's CLI is a member (no org push), installs
// the org skill the admin published, and the skill page shows the pull.
const token = process.env.STIFT_TEST_TOKEN;
const serverUrl = process.env.STIFT_TEST_SERVER;
test.skip(!token || !serverUrl, "STIFT_TEST_TOKEN not set");

const stift = resolve(dirname(fileURLToPath(import.meta.url)), "../../../cli/bin/stift");
let work: string;
const envFor = (who: string): NodeJS.ProcessEnv => {
  const home = join(work, who, "home");
  mkdirSync(home, { recursive: true });
  return {
    ...process.env,
    HOME: home,
    STIFT_CONFIG: join(work, who, "config.json"),
    STIFT_STATE: join(work, who, "state"),
    STIFT_SKILLS_STATE: join(work, who, "skills-state"),
  };
};

test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "stift-e2e-members-"));
  const admin = envFor("admin");
  // Org units are published from the org mirror, not from ~/.claude.
  const skill = join(admin.HOME!, ".stift/org/claude/skills/e2e-policy");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: e2e-policy\ndescription: company rules\n---\n# Policy\n");
  execFileSync(stift, ["login", serverUrl!, "--token", token!, "--no-daemon"], { env: admin });
  execFileSync(stift, ["push", "--skills", "--scope", "org", "--name", "skills/e2e-policy"], { env: admin });
});
test.afterAll(() => rmSync(work, { recursive: true, force: true }));

test("an added member is a member in the CLI, installs the org skill, and shows up under Pulls", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("API token").fill(token!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Members" }).click();
  await expect(page.getByRole("region", { name: "Organization" })).toContainText("Seats");

  await page.getByRole("button", { name: "Add member" }).click();
  const form = page.getByRole("form", { name: "Add member" });
  await form.getByLabel("Name", { exact: true }).fill("e2e-ada");
  await form.getByRole("button", { name: "Add" }).click();
  const created = page.getByRole("region", { name: "First token for e2e-ada" });
  const secret = (await created.locator("code").first().textContent())!.trim();
  expect(secret).toMatch(/^stf_/);
  await created.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("row").filter({ hasText: "e2e-ada" })).toContainText("1");

  const ada = envFor("ada");
  // `stift login` validates against /v1/whoami and prints user and role.
  expect(execFileSync(stift, ["login", serverUrl!, "--token", secret, "--no-daemon"], { env: ada }).toString()).toMatch(/"e2e-ada".*\(member\)/);
  for (const dir of [".stift/org/claude/skills/e2e-mine", ".claude/skills/e2e-mine"]) {
    mkdirSync(join(ada.HOME!, dir), { recursive: true });
    writeFileSync(join(ada.HOME!, dir, "SKILL.md"), "---\nname: e2e-mine\ndescription: mine\n---\n# Mine\n");
  }
  expect(() => execFileSync(stift, ["push", "--skills", "--scope", "org", "--name", "skills/e2e-mine"], { env: ada, stdio: "pipe" })).toThrow();
  execFileSync(stift, ["push", "--skills", "--scope", "user", "--name", "skills/e2e-mine"], { env: ada });

  execFileSync(stift, ["skills", "install", "skills/e2e-policy"], { env: ada });
  const installed = join(ada.HOME!, ".claude/skills/e2e-policy");
  expect(existsSync(join(installed, "SKILL.md"))).toBe(true);
  expect(lstatSync(installed).isSymbolicLink()).toBe(false);

  await page.goto("/skills/org/claude/skills/e2e-policy");
  const pulls = page.getByRole("region", { name: "Pulls" });
  await expect(pulls).toContainText("1 of 2 members on v1");
  await expect(pulls.getByRole("listitem")).toContainText(["e2e-ada"]);

  // The same page as the member: readable, nothing to publish with.
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("API token").fill(secret);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Tokens" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Members" })).toHaveCount(0);
  await page.goto("/skills/org/claude/skills/e2e-policy");
  await expect(page.getByTestId("rendered").getByRole("heading", { name: "Policy" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "edit" })).toHaveCount(0);
});
