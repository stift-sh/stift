import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

// Public sharing end to end (skills-registry-4 "Done when"): an admin sets
// the org slug and publishes an org skill from the browser; curl without a
// token resolves it; a machine with no stift login installs it by reference
// with every blob verified, and a tampered blob leaves nothing behind.
const token = process.env.STIFT_TEST_TOKEN;
const serverUrl = process.env.STIFT_TEST_SERVER;
test.skip(!token || !serverUrl, "STIFT_TEST_TOKEN not set");

const stift = resolve(dirname(fileURLToPath(import.meta.url)), "../../../cli/bin/stift");
/** stdout of a CLI run that may exit non-zero on purpose (`outdated` does when something is behind). */
const output = (args: string[], env: NodeJS.ProcessEnv) => {
  try {
    return execFileSync(stift, args, { env, stdio: "pipe" }).toString();
  } catch (e) {
    return (e as { stdout: Buffer }).stdout.toString();
  }
};
let work: string;
const envFor = (who: string): NodeJS.ProcessEnv => {
  const home = join(work, who, "home");
  mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, STIFT_CONFIG: join(work, who, "config.json"), STIFT_STATE: join(work, who, "state"), STIFT_SKILLS_STATE: join(work, who, "skills-state") };
  delete env.STIFT_TOKEN;
  delete env.STIFT_SERVER;
  return env;
};

test.beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "stift-e2e-publish-"));
  const admin = envFor("admin");
  const skill = join(admin.HOME!, ".stift/org/claude/skills/e2e-deploy");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: e2e-deploy\ndescription: ships it\n---\n# Deploy\n");
  execFileSync(stift, ["login", serverUrl!, "--token", token!, "--no-daemon"], { env: admin });
  // --force: a retried worker starts from a fresh state file but the unit may already be there.
  execFileSync(stift, ["push", "--skills", "--scope", "org", "--name", "skills/e2e-deploy", "--force"], { env: admin });
});
test.afterAll(() => rmSync(work, { recursive: true, force: true }));

test("publish in the browser, resolve without a token, install without a login", async ({ page, request }) => {
  await page.goto("/login");
  await page.getByLabel("API token").fill(token!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();

  // The slug gate points at the org card; set the slug there.
  await page.goto("/skills/org/claude/skills/e2e-deploy");
  const card = page.getByRole("region", { name: "Published" });
  await expect(card).toContainText("Not published");
  await card.getByRole("link", { name: "Set an org slug" }).click();
  const org = page.getByRole("region", { name: "Organization" });
  await org.getByRole("button", { name: "Edit" }).click();
  const orgForm = page.getByRole("form", { name: "Edit organization" });
  await orgForm.getByLabel("Slug").fill("e2e-acme");
  await orgForm.getByRole("button", { name: "Save" }).click();
  await expect(org).toContainText("@e2e-acme");

  await page.goto("/skills/org/claude/skills/e2e-deploy");
  await card.getByRole("button", { name: "Publish" }).click();
  const form = page.getByRole("form", { name: "Publish" });
  await expect(form.getByLabel("Public name")).toHaveValue("e2e-deploy");
  await form.getByLabel("License").fill("MIT");
  await expect(form).toContainText("→ @e2e-acme/e2e-deploy v1");
  await form.getByRole("button", { name: "Publish v1" }).click();
  await expect(card).toContainText("@e2e-acme/e2e-deploy v1");
  await expect(card.locator("code")).toContainText(`stift skills install @e2e-acme/e2e-deploy --registry ${serverUrl}`);
  await expect(page.getByRole("form", { name: "Edit organization" })).toHaveCount(0);

  // Anyone: no token.
  const res = await request.get(`${serverUrl}/v1/registry/skills/@e2e-acme/e2e-deploy`, { headers: { authorization: "" } });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { skill: { license: string }; version: { version: number; source_version: number; files: { sha256: string }[] } };
  expect(body.skill.license).toBe("MIT");
  expect(body.version).toMatchObject({ version: 1, source_version: 1 });

  // A machine with no stift login: only the registry URL.
  const guest = envFor("guest");
  const out = execFileSync(stift, ["skills", "install", "@e2e-acme/e2e-deploy", "--registry", serverUrl!], { env: guest }).toString();
  expect(out).toContain("installed @e2e-acme/e2e-deploy v1");
  const installed = join(guest.HOME!, ".claude/skills/e2e-deploy");
  expect(lstatSync(installed).isSymbolicLink()).toBe(false);
  expect(readFileSync(join(installed, "SKILL.md"), "utf8")).toContain("# Deploy");
  expect(existsSync(join(work, "guest/config.json"))).toBe(false);

  // Publish v2 from the CLI after an edit; the page lists both, the guest is behind and upgrades.
  const admin = envFor("admin");
  writeFileSync(join(admin.HOME!, ".stift/org/claude/skills/e2e-deploy/SKILL.md"), "---\nname: e2e-deploy\ndescription: ships it\n---\n# Deploy\nnow with rollback\n");
  execFileSync(stift, ["push", "--skills", "--scope", "org", "--name", "skills/e2e-deploy"], { env: admin });
  expect(execFileSync(stift, ["skills", "publish", "skills/e2e-deploy"], { env: admin }).toString()).toContain("as @e2e-acme/e2e-deploy v2");
  await page.reload();
  await expect(card).toContainText("@e2e-acme/e2e-deploy v2");
  await expect(card.getByRole("list", { name: "Published versions" }).getByRole("listitem")).toHaveCount(2);
  expect(output(["skills", "outdated"], guest)).toMatch(/e2e-deploy.*v1.*v2.*behind/);
  execFileSync(stift, ["skills", "install", "@e2e-acme/e2e-deploy", "--upgrade", "--registry", serverUrl!], { env: guest });
  expect(readFileSync(join(installed, "SKILL.md"), "utf8")).toContain("now with rollback");

  // Unpublish v2 in the browser: latest falls back to v1, v2 still resolves by number.
  await card.getByRole("button", { name: "unpublish v2" }).click();
  await expect(card).toContainText("@e2e-acme/e2e-deploy v1");
  await expect(card.getByRole("button", { name: "restore v2" })).toBeVisible();
  expect(((await (await request.get(`${serverUrl}/v1/registry/skills/@e2e-acme/e2e-deploy`, { headers: { authorization: "" } })).json()) as { version: { version: number } }).version.version).toBe(1);
  expect((await request.get(`${serverUrl}/v1/registry/skills/@e2e-acme/e2e-deploy/2`, { headers: { authorization: "" } })).status()).toBe(200);
  expect(output(["skills", "outdated"], guest)).toContain("unpublished; latest is v1");

  // Locked slug: the org card refuses to change it now.
  await page.goto("/members");
  await org.getByRole("button", { name: "Edit" }).click();
  await expect(page.getByRole("form", { name: "Edit organization" }).getByLabel("Slug")).toBeDisabled();
});

test("a tampered blob fails the install and leaves nothing half-written", async () => {
  // The registry serves exactly the published bytes; corrupt them on the way
  // through a tiny proxy that flips the SKILL.md body. The CLI runs async so
  // the proxy in this process can answer it.
  const { createServer } = await import("node:http");
  const upstream = new URL(serverUrl!);
  const proxy = createServer(async (req, res) => {
    const r = await fetch(`${upstream.origin}${req.url}`, { headers: { accept: req.headers.accept ?? "*/*" } });
    const buf = Buffer.from(await r.arrayBuffer());
    const tampered = /\/blobs\//.test(req.url ?? "") ? Buffer.from(buf.toString("utf8").replace("# Deploy", "# Trojan")) : buf;
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/octet-stream" });
    res.end(tampered);
  });
  await new Promise<void>((ok) => proxy.listen(0, "127.0.0.1", ok));
  const addr = proxy.address() as { port: number };
  try {
    const victim = envFor("victim");
    const run = promisify(execFile)(stift, ["skills", "install", "@e2e-acme/e2e-deploy", "--registry", `http://127.0.0.1:${addr.port}`], { env: victim });
    await expect(run).rejects.toThrow(/hash mismatch/);
    expect(existsSync(join(victim.HOME!, ".claude/skills/e2e-deploy"))).toBe(false);
    expect(existsSync(join(work, "victim/skills-state"))).toBe(false);
  } finally {
    proxy.closeAllConnections();
    proxy.close();
  }
});
