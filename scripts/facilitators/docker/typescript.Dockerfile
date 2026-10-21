# The x402 e2e TypeScript facilitator, built from a `git archive` of the pinned commit (typescript/ and e2e/) by
# scripts/facilitators/images.mjs, as the e2e CI job of that commit builds it: install and build typescript/, then
# install e2e/, on Node.js 22. Its key and RPC URL come at run time (targets.mjs).
FROM node:22-bookworm-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /x402
COPY typescript ./typescript
COPY e2e ./e2e
RUN cd typescript && pnpm install --frozen-lockfile && pnpm build
RUN cd e2e && pnpm install --frozen-lockfile
WORKDIR /x402/e2e/facilitators/typescript
ENV E2E_MECHANISMS_CATALOG=/x402/e2e/config
USER node
CMD ["node_modules/.bin/tsx", "index.ts"]
