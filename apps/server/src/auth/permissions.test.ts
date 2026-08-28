import { test } from "node:test";
import assert from "node:assert/strict";
import { can, type Subject } from "./permissions.js";

const member = { userId: "u1", role: "member" as const };
const admin = { userId: "a1", role: "admin" as const };

const table: [Subject, boolean, boolean][] = [
  [{ action: "bundle.write", scope: "org", ownerId: null }, false, true],
  [{ action: "bundle.write", scope: "user", ownerId: "u2" }, false, true],
  [{ action: "bundle.write", scope: "user", ownerId: "u1" }, true, true],
  [{ action: "bundle.write", scope: "user", ownerId: null }, true, true],
  [{ action: "bundle.write", scope: "project", ownerId: "u2" }, true, true],
  [{ action: "token.manage" }, false, true],
  [{ action: "member.manage" }, false, true],
  [{ action: "session.delete", ownerId: "u2" }, false, true],
  [{ action: "session.delete", ownerId: "u1" }, true, true],
  [{ action: "session.delete", ownerId: null }, true, true],
];

test("permission table", () => {
  for (const [s, m, a] of table) {
    assert.equal(can(member, s), m, `member ${JSON.stringify(s)}`);
    assert.equal(can(admin, s), a, `admin ${JSON.stringify(s)}`);
  }
});
