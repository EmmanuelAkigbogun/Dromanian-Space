#!/usr/bin/env bash
# Runs every check (unit, database and server tests, build, lint) in a
# throwaway container with its own PostgreSQL 17, pgvector and PostgREST.
# Safe on the production server: no ports, no volumes, no shared networks,
# and the container and image are removed afterwards.
#
#   deploy/test/run.sh            (from a checkout of the repository)
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
tag="dromanian-space-test:$(date +%s)"
cleanup() { docker image rm -f "$tag" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker build -f "$root/deploy/test/Dockerfile" -t "$tag" "$root"
# No AI keys are passed: tests use deterministic provider doubles only.
docker run --rm --network none "$tag"
echo "All checks passed in the disposable environment."
