-- Session quota (cloud-wrapper item 2): null = unlimited, like the other
-- orgs.max_* columns. The cloud's free plan is the first user.
ALTER TABLE "orgs" ADD COLUMN "max_sessions" integer;
