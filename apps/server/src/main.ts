import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

const version = process.env.STIFT_VERSION ?? "dev";
const port = Number(process.env.PORT ?? 8580);

serve({ fetch: createApp({ version }).fetch, port }, (info) => {
  console.log(`stift server ${version} listening on :${info.port}`);
});
