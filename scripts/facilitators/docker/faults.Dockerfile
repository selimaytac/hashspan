# The faults-proxy runner of the facilitator matrix: the built @hashspan/faults (package.json and dist/ of
# packages/faults) and the runner, copied into a build context by scripts/facilitators/images.mjs. No dependencies.
FROM node:24-bookworm-slim
WORKDIR /app
COPY node_modules/@hashspan/faults ./node_modules/@hashspan/faults
COPY runner.mjs scenario.mjs ./
USER node
CMD ["node", "runner.mjs"]
