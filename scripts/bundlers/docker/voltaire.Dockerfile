# Voltaire v1.0.5, built from a `git archive` of the tag (the package and its pinned requirements) by
# scripts/bundlers/images.mjs, as the tag's own Dockerfile installs it (`pip install` of requirements.txt, then of the
# package without dependencies), on Debian bookworm with glibc rather than Alpine, for the arm64 wheels of the Docker
# VM. Python 3.13, as pyproject.toml requires. Its key and node URL come at run time (targets.mjs).
FROM python:3.13-slim-bookworm
ENV PYTHONUNBUFFERED=1
ENV PIP_DISABLE_PIP_VERSION_CHECK=1
ENV PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY requirements.txt pyproject.toml poetry.lock README.md ./
COPY voltaire_bundler ./voltaire_bundler
RUN pip install --require-hashes -r requirements.txt && pip install --no-deps .
RUN mkdir -p /app/cache && chmod a+w /app/cache
USER nobody
ENTRYPOINT ["python", "-m", "voltaire_bundler"]
