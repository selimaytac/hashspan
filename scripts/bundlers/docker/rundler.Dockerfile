# Rundler v0.11.0: the release binary for the Docker VM's architecture, which scripts/bundlers/images.mjs downloads,
# checks (the pinned SHA-256 of the tarball and of its signature, and the signature's issuer, rundler.mjs) and puts
# into the build context. Debian bookworm, as Rundler's own image uses since v0.11.0; the binary needs glibc 2.34.
# Its signer key comes at run time by env name (targets.mjs).
FROM debian:bookworm-slim
COPY rundler /usr/local/bin/rundler
USER nobody
ENTRYPOINT ["rundler"]
