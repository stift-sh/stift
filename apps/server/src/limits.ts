/** Upload size limits; defaults match the Go server. */
export type Limits = {
  /** per-session archive size limit */
  maxUploadBytes: number;
  /** per-blob (bundle file) size limit */
  maxBlobBytes: number;
};

export const DEFAULT_LIMITS: Limits = { maxUploadBytes: 200 << 20, maxBlobBytes: 5 << 20 };

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name}: expected a positive integer, got "${v}"`);
  return n;
}

export function limitsFromEnv(): Limits {
  return {
    maxUploadBytes: intEnv("STIFT_MAX_UPLOAD_BYTES", DEFAULT_LIMITS.maxUploadBytes),
    maxBlobBytes: intEnv("STIFT_MAX_BLOB_BYTES", DEFAULT_LIMITS.maxBlobBytes),
  };
}
