# x402-rs x402-facilitator, built from a `git archive` of the pinned commit (or of a `--ref`) by
# scripts/facilitators/images.mjs: the workspace manifests, crates/, facilitator/, examples/ (cargo loads every
# workspace member) and patches/ (the aptos patch path), plus the config the harness generates (configOf() in
# targets.mjs). Upstream's Dockerfile builds in rust:trixie with --features full; this one builds the default features
# (eip155, solana, tron, telemetry), as the justfile's `cargo build` does, two jobs at a time to keep the build's memory
# low. Build and run stages share Debian trixie, so the binary finds the same glibc. Key and RPC URL come at run time.
FROM rust:1.99-trixie AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY facilitator ./facilitator
COPY examples ./examples
COPY patches ./patches
ENV CARGO_BUILD_JOBS=2
RUN cargo build --package x402-facilitator --release --locked

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/x402-facilitator /usr/local/bin/x402-facilitator
COPY hashspan-facilitator.json /etc/x402-rs/config.json
WORKDIR /app
USER nobody
CMD ["x402-facilitator", "--config", "/etc/x402-rs/config.json"]
