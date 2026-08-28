import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Bundle } from "@stift/shared";

// Every table carries a `orgId` column ("" = default orgId), mirroring the
// Go Backend's orgId parameter. Real org/user tables arrive with the first
// feature that needs them (ADR 0001, sequencing note).

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const orgs = pgTable("orgs", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  // null = unlimited (the self-host default); the cloud sets these from entitlements.
  maxSkills: integer("max_skills"),
  maxStorageBytes: bigint("max_storage_bytes", { mode: "number" }),
  maxSeats: integer("max_seats"),
});

export const ROLES = ["admin", "member"] as const;
export type Role = (typeof ROLES)[number];

export const memberships = pgTable(
  "memberships",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ROLES }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId] })],
);

export const sessions = pgTable(
  "sessions",
  {
    orgId: text("org_id").notNull().default(""),
    id: text("id").notNull(),
    /** Who pushed it (the token's user); null for rows written before users existed. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    key: text("key").notNull(),
    agent: text("agent").notNull(),
    sessionId: text("session_id").notNull(),
    project: text("project"),
    projectId: text("project_id"),
    repo: text("repo"),
    host: text("host").notNull(),
    title: text("title"),
    base: text("base").notNull(),
    files: integer("files").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    modTime: ts("mod_time").notNull(),
    createdAt: ts("created_at").notNull(),
    updatedAt: ts("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.id] }),
    uniqueIndex("sessions_org_key").on(t.orgId, t.key),
    index("sessions_org_updated").on(t.orgId, t.updatedAt),
  ],
);

export const blobs = pgTable(
  "blobs",
  {
    orgId: text("org_id").notNull().default(""),
    sha256: text("sha256").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.sha256] })],
);

export const bundles = pgTable(
  "bundles",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id").notNull().default(""),
    scope: text("scope").notNull(),
    agent: text("agent").notNull(),
    project: text("project").notNull().default(""),
    name: text("name").notNull(),
    /** Owner of a user-scope unit (who created it); null for org/project scope or legacy rows. */
    userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
    head: integer("head").notNull().default(0),
  },
  (t) => [uniqueIndex("bundles_key").on(t.orgId, t.scope, t.agent, t.project, t.name)],
);

export const bundleVersions = pgTable(
  "bundle_versions",
  {
    bundleId: bigint("bundle_id", { mode: "number" })
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    manifest: jsonb("manifest").$type<Bundle>().notNull(),
    createdAt: ts("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.bundleId, t.version] })],
);

export const tokens = pgTable(
  "tokens",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().default(""),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hash: text("hash").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at"),
  },
  (t) => [index("tokens_org").on(t.orgId), index("tokens_user").on(t.userId), uniqueIndex("tokens_hash").on(t.hash)],
);

/** Where org skills are on members' machines, reported by the CLI on
 *  install/subscribe. Reporting only: a missing row means "unknown". */
export const installs = pgTable(
  "installs",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    name: text("name").notNull(),
    host: text("host").notNull(),
    version: integer("version").notNull(),
    from: text("from", { enum: ["install", "subscribe"] }).notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.userId, t.agent, t.name, t.host] })],
);
