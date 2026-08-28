import { test } from "node:test";
import assert from "node:assert/strict";
import { chain, type Authenticator } from "./authenticator.js";
import { identity } from "./identity.js";

const fixed = (name: string | null): Authenticator => ({
  authenticate: async () => (name ? identity({ id: name, userId: name, orgId: "", name, role: "member" }) : null),
});

test("chain returns the first non-null identity", async () => {
  const id = await chain(fixed(null), fixed("b"), fixed("c")).authenticate("x");
  assert.equal(id?.name, "b");
});

test("chain propagates null when nobody matches", async () => {
  assert.equal(await chain(fixed(null), fixed(null)).authenticate("x"), null);
  assert.equal(await chain().authenticate("x"), null);
});
