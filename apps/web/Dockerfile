# Build context is the REPOSITORY ROOT, not this directory (D251(a); the
# demo/sdk-sample-ts root-context pattern is the precedent): apps/web is an
# npm workspace member, and `npm ci` needs the single root lockfile plus every
# workspace's package.json to resolve the same tree a developer's `npm ci`
# would. Dockerfile.dockerignore beside this file scopes that context.
#
#   docker build -f apps/web/Dockerfile --build-arg OBSTACK_DATA_MODE=live -t obstack-web:live .
#   docker build -f apps/web/Dockerfile --build-arg OBSTACK_DATA_MODE=mock -t obstack-web:mock .
#
# `output: "standalone"` in next.config.ts (node_modules/next/dist/docs/01-app/
# 03-api-reference/05-config/01-next-config-js/output.md) traces only the
# files each page needs into `.next/standalone`; that tree mirrors the
# monorepo layout it was traced from (apps/web/server.js and apps/web/.next/**
# next to a hoisted node_modules/), which is why the runtime stage copies it
# whole instead of re-deriving the shape by hand — verified against this
# repo's own `.next/standalone` output, not assumed.

FROM node:24.19.0-slim AS deps
WORKDIR /repo
# Only the manifests here: this layer is invalidated by a dependency change,
# not by every source edit below.
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/obstack-js/package.json packages/obstack-js/package.json
RUN npm ci

FROM deps AS build
WORKDIR /repo
COPY apps/web apps/web
# The one file `apps/web/src/server/ingest-health.ts` shares with Go's own
# copy (services/ingest/pricing/pricing.go) — a real cross-workspace source
# dependency, not an artifact, so it is copied at its real repo-relative path
# rather than duplicated into apps/web.
COPY services/ingest/pricing/prices.json services/ingest/pricing/prices.json

# `OBSTACK_DATA_MODE` is a BUILD-time input (data.ts:71-73): `next build`
# reads it through `resolveMode()` while collecting page data, and the
# generated static pages for /login and /signup differ by mode (D157) — the
# value baked here is the mode the artifact serves for its whole lifetime
# (D251(b)); there is no runtime override, only the boot check's refusal
# below if the two disagree.
ARG OBSTACK_DATA_MODE
ENV OBSTACK_DATA_MODE=${OBSTACK_DATA_MODE}
# `resolveMode()` (data.ts:56-57) also requires CLICKHOUSE_URL to be non-empty
# when the mode is "live", because that check runs at module-evaluation time
# and Next imports every route module — including dynamic ones — while
# collecting page data during `next build`. The real endpoint is a RUNTIME
# value supplied by compose/the chart (D266); this build-time placeholder
# only satisfies the presence check so a live build can trace its files
# without a reachable ClickHouse. It is never read again after this step and
# is not a NEXT_PUBLIC_ var, so it does not reach the client bundle.
ENV CLICKHOUSE_URL=http://build-time-placeholder:8123
RUN npm run build --workspace apps/web

FROM node:24.19.0-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
# The whole standalone tree, copied as-is (see the header note above): this
# lands `apps/web/server.js` + `apps/web/.next/**` next to the hoisted
# `node_modules/` Node's resolver walks up to find from there.
COPY --from=build /repo/apps/web/.next/standalone ./
# `output: "standalone"` deliberately excludes `public/` and `.next/static`
# (self-hosting.md's own recipe: `cp -r public .next/standalone/ && cp -r
# .next/static .next/standalone/.next/`), so they are copied back here at the
# same monorepo-relative paths.
COPY --from=build /repo/apps/web/public apps/web/public
COPY --from=build /repo/apps/web/.next/static apps/web/.next/static

# D267: the mode stamp is a file inside the image, read by the boot check
# (apps/web/src/server/mode-stamp.ts — the path is stated once there) at
# server startup, plus this OCI label for anyone inspecting the image from
# outside a running container.
ARG OBSTACK_DATA_MODE
LABEL io.obstack.data-mode=${OBSTACK_DATA_MODE}
RUN test -n "$OBSTACK_DATA_MODE" \
    && printf '%s' "$OBSTACK_DATA_MODE" > apps/web/.obstack-mode-stamp

# The stock `node` user, so nothing in here runs as root.
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
