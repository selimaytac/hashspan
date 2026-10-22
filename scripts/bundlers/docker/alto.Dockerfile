# Alto v1.2.8, built from a `git archive` of the tag by scripts/bundlers/images.mjs, not from the official image
# (alto#756: that image decodes revert errors differently from a source build). The archive holds Alto's own package
# (src/), the contracts and the workspace manifests; images.mjs adds each contracts/lib submodule at the commit the
# tag records. The contracts are compiled as the tag's `build:contracts` scripts do (package.json), then only Alto's
# package is installed and built, one task at a time with a 4 GiB heap, on the full Node.js image (node-gyp needs Python
# and a compiler). Its keys and node URL come at run time (targets.mjs).
FROM ghcr.io/foundry-rs/foundry:v1.8.4 AS contracts
USER root
WORKDIR /alto
COPY contracts ./contracts
RUN forge build --quiet --root contracts --evm-version london --out ../src/contracts/ src/PimlicoSimulations.sol
RUN forge build --quiet --root contracts --evm-version london --optimize --optimizer-runs 1000000 --via-ir --use solc:0.8.17 --out ../src/contracts/ src/v06/EntryPointFilterOpsOverride.sol
RUN forge build --quiet --root contracts --evm-version paris --optimize --optimizer-runs 1000000 --via-ir --use solc:0.8.23 --out ../src/contracts/ src/v07/EntryPointFilterOpsOverride.sol
RUN forge build --quiet --root contracts --evm-version cancun --optimize --optimizer-runs 1000000 --via-ir --use solc:0.8.28 --out ../src/contracts/ src/v08/EntryPointFilterOpsOverride.sol
RUN forge build --quiet --root contracts --evm-version cancun --optimize --optimizer-runs 1000000 --via-ir --use solc:0.8.28 --out ../src/contracts/ src/v09/EntryPointFilterOpsOverride.sol
RUN forge build --quiet --root contracts --evm-version london --optimize --optimizer-runs 1000000 --via-ir --use solc:0.8.17 --out ../src/contracts/ src/v06/EntryPointGasEstimationOverride.sol
RUN forge build --quiet --root contracts --evm-version paris --out ../src/contracts/ src/v07/EntryPointSimulations.sol
RUN forge build --quiet --root contracts --evm-version cancun --out ../src/contracts/ src/v08/EntryPointSimulations.sol
RUN forge build --quiet --root contracts --evm-version cancun --out ../src/contracts/ src/v09/EntryPointSimulations.sol

FROM node:22-bookworm
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /alto
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY test/e2e/package.json ./test/e2e/package.json
COPY scripts/localDeployer/package.json ./scripts/localDeployer/package.json
COPY src ./src
COPY --from=contracts /alto/src/contracts ./src/contracts
ENV NODE_OPTIONS=--max-old-space-size=4096
# pnpm takes --workspace-concurrency on run, not on install (the lab run's pnpm refused it there).
RUN pnpm install --frozen-lockfile --filter @pimlico/alto...
RUN pnpm --filter @pimlico/alto --workspace-concurrency=1 run build
ENV NODE_OPTIONS=
WORKDIR /alto/src
USER node
ENTRYPOINT ["node", "esm/cli/alto.js"]
