#!/usr/bin/env bash
# Vendor packages/shared-web → web/shared/ for production.
set -euo pipefail
cd "$(dirname "$0")/.."
../packages/shared-web/sync.sh web/shared
