// Port of TestBlobValidation in the former Go server (git history before 2026-08-27) engine/server/handlers_bundles_test.go.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createTestApp, req, skip, type TestApp } from "./harness.js";

const shaOf = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = (s: string) => new TextEncoder().encode(s);

describe("blobs routes", { skip }, () => {
  let t: TestApp;
  before(async () => {
    t = await createTestApp({ maxBlobBytes: 16 });
  });
  after(() => t.close());

  const put = (sha: string, body: Uint8Array, headers: Record<string, string> = {}) =>
    t.app.request(`/v1/blobs/${sha}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${t.admin}`, "Content-Length": String(body.byteLength), ...headers },
      body: body as BodyInit,
    });

  test("validation", async () => {
    const content = bytes("hello");
    let r = await put("nothex", content);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "invalid sha256 in path" });

    r = await put("b".repeat(64), content);
    assert.equal(r.status, 400, "hash mismatch");

    r = await req(t.app, "GET", `/v1/blobs/${"b".repeat(64)}`, t.admin);
    assert.equal(r.status, 404, "mismatched blob stored");
    assert.deepEqual(await r.json(), { error: "no such blob" });

    const big = bytes("x".repeat(17));
    r = await put(shaOf(big), big);
    assert.equal(r.status, 413);
    assert.deepEqual(await r.json(), { error: "blob exceeds limit of 16 bytes" });

    // lying Content-Length: the counting limiter still stops it
    r = await put(shaOf(big), big, { "Content-Length": "10" });
    assert.equal(r.status, 413);

    // missing Content-Length
    r = await t.app.request(`/v1/blobs/${shaOf(content)}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${t.admin}` },
      body: new ReadableStream({ start: (c) => (c.enqueue(content), c.close()) }),
      // @ts-expect-error node fetch needs duplex for stream bodies
      duplex: "half",
    });
    assert.equal(r.status, 411);
    assert.deepEqual(await r.json(), { error: "Content-Length is required" });

    // within limit works, and is idempotent
    r = await put(shaOf(content), content);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { sha: shaOf(content) });
    r = await put(shaOf(content), content);
    assert.equal(r.status, 200);

    r = await req(t.app, "GET", `/v1/blobs/${shaOf(content)}`, t.admin);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "application/octet-stream");
    assert.equal(await r.text(), "hello");

    r = await req(t.app, "GET", "/v1/blobs/nothex", t.admin);
    assert.equal(r.status, 400);
  });

  test("check", async () => {
    const check = (body: string) => req(t.app, "POST", "/v1/blobs/check", t.admin, body, "application/json");
    const content = bytes("hello");
    await put(shaOf(content), content);

    let r = await check(JSON.stringify({ shas: [shaOf(content), "a".repeat(64)] }));
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { missing: ["a".repeat(64)] });

    r = await check(JSON.stringify({ shas: [] }));
    assert.deepEqual(await r.json(), { missing: [] });

    r = await check("{nope");
    assert.equal(r.status, 400);

    const many = Array.from({ length: 10001 }, (_, i) => shaOf(new Uint8Array([i & 255, i >> 8])));
    r = await check(JSON.stringify({ shas: many }));
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "at most 10000 shas per check" });
  });

  test("org isolation", async () => {
    // tokens minted via the API share the admin's orgId; a second orgId
    // needs a token row with a different org_id column.
    const { createToken } = await import("../auth/tokens.js");
    const { orgs } = await import("../db/schema.js");
    await t.db.insert(orgs).values({ id: "other", slug: "other", name: "Other" }).onConflictDoNothing();
    const { raw: other } = await createToken(t.db, "other", "other", false);
    const content = bytes("hello");
    await put(shaOf(content), content);
    const r = await req(t.app, "GET", `/v1/blobs/${shaOf(content)}`, other);
    assert.equal(r.status, 404);
  });
});
