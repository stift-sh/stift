import {
  bigint,
  boolean,
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

// Every table carries a `tenant` column ("" = default tenant), mirroring the
// Go Backend's tenant parameter. Real org/user tables arrive with the first
// feature that needs them (ADR 0001, sequencing note).

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const sessions = pgTable(
  "sessions",
  {
    tenant: text("tenant").notNull().default(""),
    id: text("id").notNull(),
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
    primaryKey({ columns: [t.tenant, t.id] }),
    uniqueIndex("sessions_tenant_key").on(t.tenant, t.key),
    index("sessions_tenant_updated").on(t.tenant, t.updatedAt),
  ],
);

export const blobs = pgTable(
  "blobs",
  {
    tenant: text("tenant").notNull().default(""),
    sha256: text("sha256").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenant, t.sha256] })],
);

export const bundles = pgTable(
  "bundles",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    tenant: text("tenant").notNull().default(""),
    scope: text("scope").notNull(),
    agent: text("agent").notNull(),
    project: text("project").notNull().default(""),
    name: text("name").notNull(),
    head: integer("head").notNull().default(0),
  },
  (t) => [uniqueIndex("bundles_key").on(t.tenant, t.scope, t.agent, t.project, t.name)],
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
    tenant: text("tenant").notNull().default(""),
    name: text("name").notNull(),
    hash: text("hash").notNull(),
    admin: boolean("admin").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("tokens_tenant").on(t.tenant), uniqueIndex("tokens_hash").on(t.hash)],
);
