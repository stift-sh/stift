# stift server image: the TypeScript API server serving the built web bundle. Self-host with docker-compose.yml or:
#   docker run -p 8580:8580 -e STIFT_DATABASE_URL=... -e STIFT_S3_* ghcr.io/stift-sh/stift
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@stift/server..." --filter "@stift/web..."
RUN pnpm turbo run build --filter=@stift/server --filter=@stift/web
RUN pnpm --filter @stift/server deploy --prod --legacy /out

FROM node:22-alpine
ARG VERSION=dev
ENV NODE_ENV=production PORT=8580 STIFT_VERSION=${VERSION} STIFT_WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /out /app
# `pnpm deploy` honours .gitignore, so the built output is copied explicitly.
COPY --from=build /src/apps/server/dist /app/dist
COPY --from=build /src/packages/shared/dist /app/node_modules/@stift/shared/dist
COPY --from=build /src/apps/web/dist /app/web
USER node
EXPOSE 8580
CMD ["node", "dist/src/main.js"]
