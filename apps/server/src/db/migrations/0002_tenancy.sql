-- Tenancy: orgs, users, memberships. The `tenant` column on every table is
-- renamed to `org_id`; "" stays the id of the default org so no data moves.
-- Roles move from tokens.admin to memberships.role; every existing token gets
-- a user of its own, carrying its admin flag over as the membership role.
CREATE TABLE "orgs" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"max_skills" integer,
	"max_storage_bytes" bigint,
	"max_seats" integer,
	CONSTRAINT "orgs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "installs" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"agent" text NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"version" integer NOT NULL,
	"from" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "installs_org_id_user_id_agent_name_host_pk" PRIMARY KEY("org_id","user_id","agent","name","host")
);
--> statement-breakpoint
INSERT INTO "orgs" ("id", "slug", "name") VALUES ('', 'default', 'Default') ON CONFLICT DO NOTHING;
--> statement-breakpoint
ALTER TABLE "sessions" RENAME COLUMN "tenant" TO "org_id";--> statement-breakpoint
ALTER TABLE "blobs" RENAME COLUMN "tenant" TO "org_id";--> statement-breakpoint
ALTER TABLE "bundles" RENAME COLUMN "tenant" TO "org_id";--> statement-breakpoint
ALTER TABLE "tokens" RENAME COLUMN "tenant" TO "org_id";--> statement-breakpoint
ALTER TABLE "sessions" RENAME CONSTRAINT "sessions_tenant_id_pk" TO "sessions_org_id_id_pk";--> statement-breakpoint
ALTER TABLE "blobs" RENAME CONSTRAINT "blobs_tenant_sha256_pk" TO "blobs_org_id_sha256_pk";--> statement-breakpoint
ALTER INDEX "sessions_tenant_key" RENAME TO "sessions_org_key";--> statement-breakpoint
ALTER INDEX "sessions_tenant_updated" RENAME TO "sessions_org_updated";--> statement-breakpoint
ALTER INDEX "tokens_tenant" RENAME TO "tokens_org";--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "bundles" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "user_id" text;--> statement-breakpoint
-- Every existing token becomes its own user; org rows for other tenants are
-- created so the membership FK holds (self-host only ever has '').
INSERT INTO "orgs" ("id", "slug", "name")
	SELECT DISTINCT "org_id", "org_id", "org_id" FROM "tokens" WHERE "org_id" <> '' ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "tokens" SET "user_id" = 'u_' || "id" WHERE "user_id" IS NULL;--> statement-breakpoint
INSERT INTO "users" ("id", "name", "created_at") SELECT "user_id", "name", "created_at" FROM "tokens";--> statement-breakpoint
INSERT INTO "memberships" ("org_id", "user_id", "role")
	SELECT "org_id", "user_id", CASE WHEN "admin" THEN 'admin' ELSE 'member' END FROM "tokens";--> statement-breakpoint
ALTER TABLE "tokens" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" DROP COLUMN "admin";--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installs" ADD CONSTRAINT "installs_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installs" ADD CONSTRAINT "installs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tokens_user" ON "tokens" USING btree ("user_id");
