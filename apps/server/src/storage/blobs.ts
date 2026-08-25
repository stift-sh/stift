import { createHash, randomBytes } from "node:crypto";
import { Readable, Transform } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { validSha, validTenant } from "./validate.js";

export type BlobStoreConfig = {
  bucket: string;
  endpoint?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  /** Key prefix inside the bucket; "" by default. */
  prefix?: string;
};

/** Reads STIFT_S3_* from the environment. */
export function blobConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BlobStoreConfig {
  const bucket = env.STIFT_S3_BUCKET;
  if (!bucket) throw new Error("STIFT_S3_BUCKET is not set");
  return {
    bucket,
    endpoint: env.STIFT_S3_ENDPOINT,
    region: env.STIFT_S3_REGION ?? "auto",
    accessKeyId: env.STIFT_S3_ACCESS_KEY,
    secretAccessKey: env.STIFT_S3_SECRET_KEY,
    forcePathStyle: env.STIFT_S3_FORCE_PATH_STYLE === "true",
    prefix: env.STIFT_S3_PREFIX,
  };
}

export class HashMismatchError extends Error {
  readonly name = "HashMismatchError";
}

/** An uploaded object awaiting promote/discard. */
export type Staged = { tmp: string; sha256: string; size: number };

/**
 * Content storage over the S3 API (R2, S3, MinIO). Layout:
 *
 *   <tenant>/sessions/<id>.tar.gz
 *   <tenant>/blobs/<sha[0:2]>/<sha>
 *
 * The empty tenant maps to "_". Writes go to a temporary key while the
 * content is hashed, then are copied to the final key only when the digest
 * (and size, if given) match, so a rejected upload leaves nothing behind.
 */
export class BlobStore {
  readonly bucket: string;
  private readonly prefix: string;
  readonly client: S3Client;

  constructor(cfg: BlobStoreConfig) {
    this.bucket = cfg.bucket;
    this.prefix = cfg.prefix ? cfg.prefix.replace(/\/+$/, "") + "/" : "";
    this.client = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region ?? "auto",
      forcePathStyle: cfg.forcePathStyle ?? false,
      credentials:
        cfg.accessKeyId && cfg.secretAccessKey
          ? { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey }
          : undefined,
    });
  }

  private tenantPrefix(tenant: string): string {
    if (!validTenant(tenant)) throw new Error(`invalid tenant "${tenant}"`);
    return `${this.prefix}${tenant === "" ? "_" : tenant}/`;
  }

  sessionKey(tenant: string, id: string): string {
    return `${this.tenantPrefix(tenant)}sessions/${id}.tar.gz`;
  }

  blobKey(tenant: string, sha: string): string {
    if (!validSha(sha)) throw new Error(`invalid sha256 "${sha}"`);
    return `${this.tenantPrefix(tenant)}blobs/${sha.slice(0, 2)}/${sha}`;
  }

  /**
   * Streams body to a temporary key while hashing it. The caller decides
   * whether to `promote` the staged object to its final key or `discard` it.
   */
  async stage(body: Readable): Promise<Staged> {
    const tmp = `${this.prefix}tmp/${randomBytes(12).toString("hex")}`;
    const hash = createHash("sha256");
    let size = 0;
    const tap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk);
        size += chunk.length;
        cb(null, chunk);
      },
    });
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: tmp, Body: body.pipe(tap) },
    });
    try {
      await upload.done();
    } catch (err) {
      await this.discard({ tmp, sha256: "", size: 0 });
      throw err;
    }
    return { tmp, sha256: hash.digest("hex"), size };
  }

  /** Server-side copy of a staged object to its final key, then cleanup. */
  async promote(staged: Staged, key: string): Promise<void> {
    try {
      await this.client.send(
        new CopyObjectCommand({ Bucket: this.bucket, Key: key, CopySource: `${this.bucket}/${staged.tmp}` }),
      );
    } finally {
      await this.discard(staged);
    }
  }

  async discard(staged: Staged): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: staged.tmp })).catch(() => {});
  }

  /**
   * Stores body under key only when its digest (and size, if >= 0) match;
   * a rejected upload leaves nothing behind.
   */
  async putVerified(key: string, body: Readable, expect: { sha256: string; size?: number }): Promise<Staged> {
    const staged = await this.stage(body);
    if (expect.size !== undefined && expect.size >= 0 && staged.size !== expect.size) {
      await this.discard(staged);
      throw new HashMismatchError(`blob size mismatch: got ${staged.size} bytes, want ${expect.size}`);
    }
    if (staged.sha256 !== expect.sha256) {
      await this.discard(staged);
      throw new HashMismatchError(`blob hash mismatch: got ${staged.sha256}, want ${expect.sha256}`);
    }
    await this.promote(staged, key);
    return staged;
  }

  async has(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  /** Returns undefined when the key does not exist. */
  async get(key: string, opts?: { range?: string }): Promise<{ body: Readable; size?: number } | undefined> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: opts?.range }),
      );
      if (!res.Body) return undefined;
      return { body: res.Body as Readable, size: res.ContentLength };
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}
