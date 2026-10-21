# The x402 e2e Python facilitator, built from a `git archive` of the pinned commit (python/ and e2e/) by
# scripts/facilitators/images.mjs, as e2e/setup.sh sets a Python component up (`uv sync`), with Python 3.10 as in the
# e2e CI job. Its pyproject takes x402 from ../../../python/x402. Key and RPC URL come at run time.
# uv publishes no Python 3.10 image from 0.11 on, and the lockfile needs uv >= 0.11: the uv binary comes from its own
# image at a fixed version.
FROM python:3.10-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.11.20 /uv /uvx /bin/
WORKDIR /x402
COPY python ./python
COPY e2e/config ./e2e/config
COPY e2e/facilitators/python ./e2e/facilitators/python
WORKDIR /x402/e2e/facilitators/python
RUN uv sync --frozen
ENV E2E_MECHANISMS_CATALOG=/x402/e2e/config
CMD ["uv", "run", "--frozen", "--no-sync", "python", "main.py"]
