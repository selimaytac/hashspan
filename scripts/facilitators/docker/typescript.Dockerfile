# The x402 e2e TypeScript facilitator, built from a `git archive` of the pinned commit (typescript/ and e2e/) by
# scripts/facilitators/images.mjs, as the e2e CI job of that commit builds it: install and build typescript/, then
# install e2e/, on Node.js 22. Its key and RPC URL come at run time (targets.mjs). The full image, not -slim: native
# modules of the install (bufferutil, keccak, msgpackr-extract) build with node-gyp, which needs Python and a compiler.
FROM node:22-bookworm
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /x402
COPY typescript ./typescript
COPY e2e ./e2e
# Without the legacy packages (nothing the facilitator imports), one build task at a time and a 4 GiB heap: the full
# parallel build, the legacy x402 bundle and the declaration build of @x402/evm run out of memory otherwise in a
# laptop's Docker VM.
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN cd typescript && pnpm install --frozen-lockfile && pnpm exec turbo run build --concurrency=1 --filter='!./packages/legacy/*'
ENV NODE_OPTIONS=
RUN cd e2e && pnpm install --frozen-lockfile
WORKDIR /x402/e2e/facilitators/typescript
ENV E2E_MECHANISMS_CATALOG=/x402/e2e/config
USER node
CMD ["node_modules/.bin/tsx", "index.ts"]
