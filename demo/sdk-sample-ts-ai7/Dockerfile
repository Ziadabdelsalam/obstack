# Build context is the REPOSITORY ROOT, not this directory: the image packs
# obstack-js out of packages/obstack-js and installs the tarball, which is the
# install path the README documents for a human. Same command, same artifact —
# a Dockerfile that took a shortcut here (a workspace link, a pre-built dist
# copied in) would stop proving the packaging works.
#
#   docker build -f demo/sdk-sample-ts-ai7/Dockerfile -t sdk-sample-ts-ai7 .
#
# Dockerfile.dockerignore beside this file keeps that context to the two
# directories actually needed.

FROM node:22.23.1-slim AS sdk

WORKDIR /sdk
COPY packages/obstack-js ./
# `npm pack` runs the package's own prepack build, so its toolchain has to be
# present — this is the SDK being built from source, exactly as `npm pack` does
# it on a developer's machine.
RUN npm install --no-audit --no-fund && npm pack --pack-destination /sdk

FROM node:22.23.1-slim

WORKDIR /app

COPY --from=sdk /sdk/obstack-js-0.1.0.tgz ./
COPY demo/sdk-sample-ts-ai7/package.json ./
RUN npm install --no-audit --no-fund

COPY demo/sdk-sample-ts-ai7/tsconfig.json ./
COPY demo/sdk-sample-ts-ai7/src ./src
RUN npm run build

# The stock `node` user, so nothing in here runs as root.
USER node

EXPOSE 8100
CMD ["node", "dist/main.js"]
