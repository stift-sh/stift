import { Readable } from "node:stream";

/** Thrown by `limited()` when the body outgrows the limit (HTTP 413). */
export class TooLargeError extends Error {
  readonly name = "TooLargeError";
  constructor(readonly limit: number) {
    super(`body exceeds limit of ${limit} bytes`);
  }
}

/** Port of http.MaxBytesReader: counts bytes and fails once `limit` is passed,
 *  so a lying Content-Length cannot smuggle a larger body through. */
export function limited(body: ReadableStream<Uint8Array> | null, limit: number): Readable {
  if (!body) return Readable.from([]);
  let seen = 0;
  const reader = body.getReader();
  return new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) return this.push(null);
        seen += value.byteLength;
        if (seen > limit) {
          await reader.cancel().catch(() => {});
          return this.destroy(new TooLargeError(limit));
        }
        this.push(Buffer.from(value));
      } catch (e) {
        this.destroy(e as Error);
      }
    },
  });
}
