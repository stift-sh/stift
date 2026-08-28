// Port of TestPushListDownloadDelete, TestUploadSizeLimit and
// TestPushValidation in the former Go server (git history before 2026-08-27) engine/server/server_test.go.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { PushResult, Session } from "@stift/shared";
import { createTestApp, pushSession, req, skip, testMeta, type TestApp } from "./harness.js";
import { parseRange } from "./sessions.js";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("sessions routes", { skip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp({ maxUploadBytes: 1024 });
  });
  after(() => t.close());

  const push = async (meta = testMeta(), payload = bytes("fake-tar-gz-bytes")) => {
    const r = await pushSession(t.app, t.admin, meta, payload);
    const body = (await r.json()) as PushResult;
    return { ...body, status: r.status };
  };

  test("push, list, download, delete", async () => {
    const payload = bytes("fake-tar-gz-bytes");
    const r1 = await push(testMeta(), payload);
    assert.equal(r1.status, 201);
    assert.equal(r1.session.id.length > 0, true);
    const r2 = await push(testMeta(), payload);
    assert.equal(r2.status, 200);
    assert.equal(r2.session.id, r1.session.id);
    const changed = bytes("fake-tar-gz-bytes!");
    const r3 = await push(testMeta(), changed);
    assert.equal(r3.status, 200);
    assert.equal(r3.session.id, r1.session.id);

    const other = { ...testMeta(), key: "codex|host1|/p|zzz", session_id: "zzz", agent: "codex" };
    await push(other, payload);

    let r = await req(t.app, "GET", "/v1/sessions?agent=claude", t.admin);
    const list = (await r.json()) as Session[];
    assert.equal(list.length, 1);
    assert.equal(list[0]!.agent, "claude");

    r = await req(t.app, "GET", `/v1/sessions/${r1.session.id}/archive`, t.admin);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/gzip");
    assert.equal(r.headers.get("content-disposition"), `attachment; filename="claude-${r1.session.id}.tar.gz"`);
    assert.equal(await r.text(), "fake-tar-gz-bytes!");

    // Range download
    r = await t.app.request(`/v1/sessions/${r1.session.id}/archive`, {
      headers: { Authorization: `Bearer ${t.admin}`, Range: "bytes=0-3" },
    });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), `bytes 0-3/${changed.byteLength}`);
    assert.equal(await r.text(), "fake");

    r = await req(t.app, "GET", `/v1/sessions/${r1.session.id.slice(0, 6)}`, t.admin);
    assert.equal(r.status, 200, "prefix get");

    assert.equal(r1.session.user?.name, "admin");
    r = await req(t.app, "DELETE", `/v1/sessions/${r1.session.id}`, t.member);
    assert.equal(r.status, 403);
    assert.deepEqual(await r.json(), { error: "session belongs to another user" });
    r = await req(t.app, "DELETE", `/v1/sessions/${r1.session.id}`, t.admin);
    assert.equal(r.status, 204);
    r = await req(t.app, "GET", `/v1/sessions/${r1.session.id}`, t.admin);
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: "no such session" });
  });

  test("upload size limit", async () => {
    const r = await pushSession(t.app, t.admin, { ...testMeta(), key: "big" }, bytes("A".repeat(64 * 1024)));
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { error: "archive exceeds limit of 1024 bytes" });
    const list = (await (await req(t.app, "GET", "/v1/sessions?q=big", t.admin)).json()) as Session[];
    assert.equal(list.length, 0, "oversized upload was stored");
  });

  test("push validation", async () => {
    let r = await pushSession(t.app, t.admin, { ...testMeta(), base: "everywhere" as "home" }, bytes("x"));
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: 'meta.base must be "home" or "project"' });

    // archive before meta
    const form = new FormData();
    form.append("archive", new Blob([bytes("x")]), "a.tar.gz");
    form.append("meta", JSON.stringify(testMeta()));
    r = await req(t.app, "POST", "/v1/sessions", t.admin, form);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "meta field must precede archive field" });

    // no archive at all
    const only = new FormData();
    only.append("meta", JSON.stringify(testMeta()));
    r = await req(t.app, "POST", "/v1/sessions", t.admin, only);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "missing archive field" });

    r = await req(t.app, "POST", "/v1/sessions", t.admin, "{}", "application/json");
    assert.equal(r.status, 400);
  });

  test("auth required", async () => {
    const r = await req(t.app, "GET", "/v1/sessions");
    assert.equal(r.status, 401);
  });
});

describe("parseRange", () => {
  test("cases", () => {
    assert.deepEqual(parseRange("bytes=0-3", 10), { start: 0, end: 3 });
    assert.deepEqual(parseRange("bytes=5-", 10), { start: 5, end: 9 });
    assert.deepEqual(parseRange("bytes=-2", 10), { start: 8, end: 9 });
    assert.deepEqual(parseRange("bytes=0-99", 10), { start: 0, end: 9 });
    assert.equal(parseRange("bytes=10-", 10), "unsatisfiable");
    assert.equal(parseRange("bytes=0-1,3-4", 10), undefined);
    assert.equal(parseRange(undefined, 10), undefined);
  });
});
