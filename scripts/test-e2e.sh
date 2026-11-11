#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Literal test configuration only; never use the main Compose project.
trap 'docker compose -f compose.test.yaml down -v' EXIT
trap 'exit 1' INT TERM
docker compose -f compose.test.yaml up -d --build --wait
bun --no-env-file x playwright test
sh scripts/test-backup.sh
