# The faults-proxy runner of the bundler matrix: the built @hashspan/faults (package.json and dist/ of packages/faults),
# the runner, and the scenario parser of the facilitator matrix, copied into a build context by
# scripts/bundlers/images.mjs. No dependencies.
FROM node:24-bookworm-slim
WORKDIR /app
COPY node_modules/@hashspan/faults ./node_modules/@hashspan/faults
COPY runner.mjs scenario.mjs ./
USER node
CMD ["node", "runner.mjs"]
