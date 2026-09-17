-- Public sharing (skills-registry item 4): a skill an org publishes as
-- @<org-slug>/<name>. Publishing copies the source unit's manifest into
-- published_versions so editing, rolling back or deleting the org unit
-- cannot change or break a published version. Blobs stay in the org's
-- content-addressed store and are pinned by these manifests: a blob GC,
-- should one arrive, must treat every published_versions.manifest as a root.
CREATE TABLE "published_skills" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "published_skills_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"agent" text NOT NULL,
	"unit" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"license" text NOT NULL,
	"latest" integer DEFAULT 0 NOT NULL,
	"publisher_verified" boolean DEFAULT false NOT NULL,
	"unpublished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "published_versions" (
	"skill_id" bigint NOT NULL,
	"version" integer NOT NULL,
	"source_version" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"readme_path" text NOT NULL,
	"published_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unpublished_at" timestamp with time zone,
	"signature" text,
	CONSTRAINT "published_versions_skill_id_version_pk" PRIMARY KEY("skill_id","version")
);
--> statement-breakpoint
ALTER TABLE "published_skills" ADD CONSTRAINT "published_skills_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_versions" ADD CONSTRAINT "published_versions_skill_id_published_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."published_skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "published_versions" ADD CONSTRAINT "published_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "published_skills_org_name" ON "published_skills" USING btree ("org_id","name");--> statement-breakpoint
COMMENT ON COLUMN "published_versions"."manifest" IS 'pins the published blobs: a blob GC must treat every row as a root';
