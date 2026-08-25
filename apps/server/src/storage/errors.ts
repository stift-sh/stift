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
