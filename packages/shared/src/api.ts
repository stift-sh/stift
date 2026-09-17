// Wire types shared by the stift server, web app and generated clients.
// The single source of truth: the server emits openapi.gen.json from these
// and the TS client (packages/api-client) and Go types (cli/internal/api)
// are generated from that.
import { z } from "zod";

const timestamp = z.iso.datetime({ offset: true });

/** A user, as referenced from other resources. */
export const UserRef = z.object({ id: z.string(), name: z.string() }).meta({ id: "UserRef" });
export type UserRef = z.infer<typeof UserRef>;

/** The caller's org, as returned by whoami. */
export const OrgRef = z.object({ id: z.string(), slug: z.string(), name: z.string() }).meta({ id: "OrgRef" });
export type OrgRef = z.infer<typeof OrgRef>;

const quota = z.int().nullable();

/** Returned by GET /v1/org: the caller's org with its limits (null =
 *  unlimited) and what it currently uses of them. */
export const Org = OrgRef.extend({
  slug_locked: z.boolean().describe("true once the org has published skills: `@<slug>/…` references must keep resolving"),
  limits: z.object({ skills: quota, storage_bytes: quota, seats: quota }),
  usage: z.object({
    skills: z.int().describe("units with at least one version, in every scope"),
    storage_bytes: z.int().describe("bytes of bundle file content"),
    seats: z.int().describe("members"),
  }),
}).meta({ id: "Org" });
export type Org = z.infer<typeof Org>;

/** Body of PATCH /v1/org (admins). */
export const OrgUpdateRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    slug: z.string().optional().describe("lowercase letters, digits and hyphens, 2-39 characters"),
  })
  .meta({ id: "OrgUpdateRequest" });
export type OrgUpdateRequest = z.infer<typeof OrgUpdateRequest>;

export const Role = z.enum(["admin", "member"]).meta({ id: "Role" });
export type Role = z.infer<typeof Role>;

/** One uploaded agent session. */
export const Session = z
  .object({
    id: z.string(),
    key: z.string(),
    agent: z.string(),
    session_id: z.string(),
    project: z.string().optional(),
    project_id: z.string().optional().describe("repo name, for cross-machine matching"),
    repo: z.string().optional().describe("normalized git remote URL (secondary signal)"),
    host: z.string(),
    title: z.string().optional(),
    base: z.enum(["home", "project"]).describe("what archive paths are relative to"),
    files: z.int(),
    size: z.int(),
    sha256: z.string(),
    mod_time: timestamp,
    created_at: timestamp,
    updated_at: timestamp,
    /** Who pushed it; absent for rows written before users existed. */
    user: UserRef.optional(),
  })
  .meta({ id: "Session" });
export type Session = z.infer<typeof Session>;

/** Returned by POST /v1/sessions. */
export const PushResult = z
  .object({
    session: Session,
    status: z.enum(["created", "updated", "unchanged"]),
  })
  .meta({ id: "PushResult" });
export type PushResult = z.infer<typeof PushResult>;

/** An access token (the secret itself is never stored). */
export const TokenInfo = z
  .object({
    id: z.string(),
    name: z.string(),
    /** The role of the token's user; a token has no role of its own. */
    role: Role,
    created_at: timestamp,
    /** Null until the token authenticates a request; updated at most once a minute. */
    last_used_at: timestamp.nullable(),
    /** The token's user. */
    user: UserRef.optional(),
  })
  .meta({ id: "TokenInfo" });
export type TokenInfo = z.infer<typeof TokenInfo>;

/** Returned by POST /v1/tokens; `token` is shown exactly once. */
export const TokenCreated = TokenInfo.extend({ token: z.string() }).meta({ id: "TokenCreated" });
export type TokenCreated = z.infer<typeof TokenCreated>;

/** Returned by GET /v1/whoami. */
export const Whoami = z
  .object({
    name: z.string(),
    role: Role,
    user: UserRef,
    org: OrgRef.optional(),
  })
  .meta({ id: "Whoami" });
export type Whoami = z.infer<typeof Whoami>;

/** JSON error envelope. */
export const ApiError = z.object({ error: z.string() }).meta({ id: "Error" });
export type ApiError = z.infer<typeof ApiError>;

/** One file entry in a Bundle manifest. */
export const BundleFile = z
  .object({
    path: z.string().describe("relative, forward slashes, no '..' / abs"),
    sha256: z.string(),
    size: z.int(),
    mode: z.int().describe("only the exec bit is honoured"),
  })
  .meta({ id: "BundleFile" });
export type BundleFile = z.infer<typeof BundleFile>;

/** Frontmatter summary of one SKILL.md inside a bundle. */
export const SkillMeta = z
  .object({ path: z.string(), name: z.string(), description: z.string() })
  .meta({ id: "SkillMeta" });
export type SkillMeta = z.infer<typeof SkillMeta>;

/**
 * One versioned manifest of a single unit of agent configuration (a skill,
 * a subagent, a command file, a CLAUDE.md, ...) identified by
 * (scope, agent, project?, name). File contents live in content-addressed
 * blobs referenced by sha256.
 */
export const Bundle = z
  .object({
    scope: z.enum(["user", "project", "org"]),
    agent: z.string(),
    project: z.string().optional().describe("abs path (scope=project)"),
    name: z.string().describe("unit name, 1-3 clean path segments"),
    version: z.int(),
    parent: z.int().describe("version this was based on"),
    host: z.string(),
    author: z.string(),
    created: timestamp,
    files: z.array(BundleFile),
    skills: z.array(SkillMeta).describe("parsed SKILL.md frontmatter, for listing"),
  })
  .meta({ id: "Bundle" });
export type Bundle = z.infer<typeof Bundle>;

/** Returned by GET /api/version. */
export const Version = z
  .object({
    version: z.string(),
    api: z.int().describe("API major version"),
    features: z.array(z.string()).describe("server-declared feature flags the web app keys screens on (e.g. cloud, marketplace)"),
  })
  .meta({ id: "Version" });
export type Version = z.infer<typeof Version>;

/** Multipart `meta` part of POST /v1/sessions: what the client sends. */
export const PushMeta = Session.omit({ id: true, sha256: true, size: true, created_at: true, updated_at: true, user: true })
  .partial({ files: true, mod_time: true })
  .meta({ id: "PushMeta" });
export type PushMeta = z.infer<typeof PushMeta>;

/** Query filters for GET /v1/sessions. */
export const SessionFilter = z
  .object({
    agent: z.string().optional(),
    project: z.string().optional(),
    host: z.string().optional(),
    q: z.string().optional().describe("substring match on title, project or session_id"),
  })
  .meta({ id: "SessionFilter" });
export type SessionFilter = z.infer<typeof SessionFilter>;

/** Body of POST /v1/blobs/check. */
export const BlobsCheckRequest = z.object({ shas: z.array(z.string()) }).meta({ id: "BlobsCheckRequest" });
export type BlobsCheckRequest = z.infer<typeof BlobsCheckRequest>;

/** Returned by POST /v1/blobs/check: digests the server does not have. */
export const BlobsCheckResponse = z.object({ missing: z.array(z.string()) }).meta({ id: "BlobsCheckResponse" });
export type BlobsCheckResponse = z.infer<typeof BlobsCheckResponse>;

/** Returned by PUT /v1/blobs/{sha}. */
export const BlobPutResponse = z.object({ sha: z.string() }).meta({ id: "BlobPutResponse" });
export type BlobPutResponse = z.infer<typeof BlobPutResponse>;

/** Query filters for GET /v1/bundles. */
export const BundleFilter = z
  .object({
    scope: z.string().optional(),
    agent: z.string().optional(),
    project: z.string().optional(),
    name: z.string().optional(),
  })
  .meta({ id: "BundleFilter" });
export type BundleFilter = z.infer<typeof BundleFilter>;

/** Body of PUT /v1/bundles/…: key fields come from the path and are ignored. */
export const BundleInput = Bundle.pick({ parent: true, host: true, author: true, files: true })
  .partial()
  .meta({ id: "BundleInput" });
export type BundleInput = z.infer<typeof BundleInput>;

/** Body of POST /v1/tokens. */
export const TokenCreateRequest = z
  .object({
    name: z.string(),
    /** Admins only: mint the token for another member (by user id or name). */
    user: z.string().optional(),
  })
  .meta({ id: "TokenCreateRequest" });
export type TokenCreateRequest = z.infer<typeof TokenCreateRequest>;

/** One member of the caller's org (GET /v1/members). */
export const Member = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string().nullable(),
    role: Role,
    created_at: timestamp,
    tokens: z.int().describe("number of tokens the member holds"),
  })
  .meta({ id: "Member" });
export type Member = z.infer<typeof Member>;

/** Body of POST /v1/members. */
export const MemberCreateRequest = z
  .object({
    name: z.string(),
    email: z.string().optional(),
    role: Role.optional().describe("default member"),
    /** Mint a first token for the new member, returned once as `token`. */
    token: z.string().optional().describe("name of a first token to create; omitted = no token"),
  })
  .meta({ id: "MemberCreateRequest" });
export type MemberCreateRequest = z.infer<typeof MemberCreateRequest>;

/** Returned by POST /v1/members; `token` is present only when requested, shown once. */
export const MemberCreated = Member.extend({ token: z.string().optional() }).meta({ id: "MemberCreated" });
export type MemberCreated = z.infer<typeof MemberCreated>;

/** Body of PATCH /v1/members/{id}. */
export const MemberUpdateRequest = z.object({ role: Role }).meta({ id: "MemberUpdateRequest" });
export type MemberUpdateRequest = z.infer<typeof MemberUpdateRequest>;

/** Body of POST /v1/installs: where an org skill now is on the caller's
 *  machine. Reporting only; the server never enforces anything from it. */
export const InstallReport = z
  .object({
    agent: z.string(),
    name: z.string().describe("unit name, e.g. skills/deploy"),
    version: z.int().min(1).describe("org version the local copy was taken from"),
    host: z.string(),
    from: z.enum(["install", "subscribe"]).describe("install = detached copy, subscribe = org-scope mirror"),
  })
  .meta({ id: "InstallReport" });
export type InstallReport = z.infer<typeof InstallReport>;

/** One reported install (GET /v1/installs). */
export const Install = InstallReport.extend({
  user: UserRef,
  updated_at: timestamp,
}).meta({ id: "Install" });
export type Install = z.infer<typeof Install>;

/** Body of POST /v1/published (admins): publish an org-scope unit as
 *  `@<org-slug>/<name>`. */
export const PublishRequest = z
  .object({
    agent: z.string(),
    unit: z.string().describe("org-scope unit containing a SKILL.md, e.g. skills/deploy"),
    name: z.string().optional().describe("public name; default the unit's last segment, fixed after the first publish"),
    license: z.string().optional().describe("SPDX identifier or LicenseRef-<name>; required on the first publish"),
    version: z.int().min(1).optional().describe("source bundle version to publish; default head"),
  })
  .meta({ id: "PublishRequest" });
export type PublishRequest = z.infer<typeof PublishRequest>;

/** One published version: a copy of the source manifest, immutable once
 *  published. Hidden versions still resolve by number with `unpublished_at`
 *  set. */
export const PublishedVersion = z
  .object({
    org: z.string().describe("org slug, the `@org` of the reference"),
    name: z.string(),
    version: z.int().describe("publish sequence (1, 2, 3…), independent of source_version"),
    source_version: z.int().describe("the org bundle version this was copied from"),
    files: z.array(BundleFile),
    skills: z.array(SkillMeta),
    readme_path: z.string().describe("the SKILL.md the README renders from"),
    published_by: UserRef.optional(),
    created_at: timestamp,
    unpublished_at: timestamp.nullable(),
  })
  .meta({ id: "PublishedVersion" });
export type PublishedVersion = z.infer<typeof PublishedVersion>;

/** A skill an org shares as `@<org>/<name>`. */
export const PublishedSkill = z
  .object({
    org: z.string().describe("org slug"),
    name: z.string(),
    agent: z.string().describe("the source unit's agent: a default for installs, not a constraint"),
    unit: z.string().describe("the org-scope unit it is published from"),
    description: z.string().describe("from the SKILL.md frontmatter of the newest publish"),
    license: z.string(),
    latest: z.int().describe("newest visible version; 0 when every version is hidden"),
    created_at: timestamp,
    updated_at: timestamp,
    unpublished_at: timestamp.nullable().describe("set when the whole skill is hidden"),
  })
  .meta({ id: "PublishedSkill" });
export type PublishedSkill = z.infer<typeof PublishedSkill>;

/** Returned by GET /v1/published: a skill with every version, newest
 *  first, hidden ones included. */
export const PublishedSkillDetail = PublishedSkill.extend({ versions: z.array(PublishedVersion) }).meta({ id: "PublishedSkillDetail" });
export type PublishedSkillDetail = z.infer<typeof PublishedSkillDetail>;
