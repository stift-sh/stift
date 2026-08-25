CREATE TABLE "blobs" (
	"tenant" text DEFAULT '' NOT NULL,
	"sha256" text NOT NULL,
	"size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "blobs_tenant_sha256_pk" PRIMARY KEY("tenant","sha256")
);
--> statement-breakpoint
CREATE TABLE "bundle_versions" (
	"bundle_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "bundle_versions_bundle_id_version_pk" PRIMARY KEY("bundle_id","version")
);
--> statement-breakpoint
CREATE TABLE "bundles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "bundles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant" text DEFAULT '' NOT NULL,
	"scope" text NOT NULL,
	"agent" text NOT NULL,
	"project" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"head" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"tenant" text DEFAULT '' NOT NULL,
	"id" text NOT NULL,
	"key" text NOT NULL,
	"agent" text NOT NULL,
	"session_id" text NOT NULL,
	"project" text,
	"project_id" text,
	"repo" text,
	"host" text NOT NULL,
	"title" text,
	"base" text NOT NULL,
	"files" integer NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"mod_time" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_tenant_id_pk" PRIMARY KEY("tenant","id")
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"hash" text NOT NULL,
	"admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bundle_versions" ADD CONSTRAINT "bundle_versions_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bundles_key" ON "bundles" USING btree ("tenant","scope","agent","project","name");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_tenant_key" ON "sessions" USING btree ("tenant","key");--> statement-breakpoint
CREATE INDEX "sessions_tenant_updated" ON "sessions" USING btree ("tenant","updated_at");--> statement-breakpoint
CREATE INDEX "tokens_tenant" ON "tokens" USING btree ("tenant");--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_hash" ON "tokens" USING btree ("hash");