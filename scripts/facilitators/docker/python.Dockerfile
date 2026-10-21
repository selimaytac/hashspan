# The x402 e2e Python facilitator, built from a `git archive` of the pinned commit (python/ and e2e/) by
# scripts/facilitators/images.mjs, as e2e/setup.sh sets a Python component up (`uv sync`), with Python 3.10 as in the
# e2e CI job. Its pyproject takes x402 from ../../../python/x402. Key and RPC URL come at run time.
FROM ghcr.io/astral-sh/uv:python3.10-bookworm-slim
WORKDIR /x402
COPY python ./python
COPY e2e/config ./e2e/config
COPY e2e/facilitators/python ./e2e/facilitators/python
WORKDIR /x402/e2e/facilitators/python
RUN uv sync --frozen
ENV E2E_MECHANISMS_CATALOG=/x402/e2e/config
CMD ["uv", "run", "--frozen", "--no-sync", "python", "main.py"]
