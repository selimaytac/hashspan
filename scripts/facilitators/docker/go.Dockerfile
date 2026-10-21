# The x402 e2e Go facilitator, built from a `git archive` of the pinned commit (go/ and e2e/) by
# scripts/facilitators/images.mjs, as e2e/setup.sh builds a Go component (`go mod tidy`, `go build`), with Go 1.24 as
# in the e2e CI job. Its go.mod replaces the x402 module with ../../../go. Key and RPC URL come at run time.
FROM golang:1.24-bookworm AS build
WORKDIR /x402
COPY go ./go
COPY e2e/facilitators/go ./e2e/facilitators/go
WORKDIR /x402/e2e/facilitators/go
RUN go mod tidy && go build -o /out/facilitator .

FROM debian:bookworm-slim
COPY --from=build /out/facilitator /usr/local/bin/facilitator
COPY e2e/config /x402/e2e/config
ENV E2E_MECHANISMS_CATALOG=/x402/e2e/config
USER nobody
CMD ["facilitator"]
