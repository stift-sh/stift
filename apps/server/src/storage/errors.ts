/** Thrown by putBundle when parent != HEAD (HTTP 409). */
export class StaleError extends Error {
  readonly name = "StaleError";
  constructor(head: number, parent: number) {
    super(`bundle is stale: parent is not the current head (head=${head}, parent=${parent})`);
  }
}

/** Thrown by putBundle when a referenced blob is absent (HTTP 412). */
export class MissingBlobError extends Error {
  readonly name = "MissingBlobError";
  constructor(readonly missing: string[]) {
    super(`bundle references a missing blob: ${missing.join(", ")}`);
  }
}

/** Thrown when a session, blob or bundle does not exist (HTTP 404). */
export class NotFoundError extends Error {
  readonly name = "NotFoundError";
  constructor(what = "not found") {
    super(what);
  }
}

/** Thrown when a write would take an org over one of its limits (HTTP 402,
 *  so clients can key an "upgrade" affordance on it). The message is what
 *  the CLI prints. */
export class LimitError extends Error {
  readonly name = "LimitError";
  constructor(
    readonly limit: number,
    readonly what: "skills" | "bytes of storage" | "seats",
  ) {
    super(`limit: ${limit} ${what} per org`);
  }
}

/** Thrown by publish when the request cannot be honoured as asked: no org
 *  slug, not an org-scope unit, no SKILL.md, a bad name or license (HTTP 400). */
export class PublishError extends Error {
  readonly name = "PublishError";
}

/** Thrown by publish when the manifest is already published or the public
 *  name is taken by another unit (HTTP 409). */
export class PublishConflictError extends Error {
  readonly name = "PublishConflictError";
}
