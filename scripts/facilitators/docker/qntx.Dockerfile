# qntx/facilitator, built from a `git archive` of the pinned commit by scripts/facilitators/images.mjs: the workspace
# manifests and crates/ (without rust-toolchain.toml, as upstream's .dockerignore), plus the config the harness
# generates (configOf() in targets.mjs). The same build as upstream's Dockerfile (Rust 1.95, `cargo build --release
# --locked --bin facilitator`, default features) without its cache mounts, two jobs at a time to keep the build's
# memory low. Upstream runs on distroless cc-debian12; this runs on debian:bookworm-slim, the builder's release.
# Key, RPC URL and bearer token come at run time.
FROM rust:1.95-bookworm AS build
WORKDIR /src/facilitator
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
ENV CARGO_BUILD_JOBS=2
RUN cargo build --release --locked --bin facilitator

FROM debian:bookworm-slim
COPY --from=build /src/facilitator/target/release/facilitator /usr/local/bin/facilitator
COPY hashspan-facilitator.toml /etc/facilitator/config.toml
USER nobody
CMD ["facilitator", "serve", "-c", "/etc/facilitator/config.toml"]
