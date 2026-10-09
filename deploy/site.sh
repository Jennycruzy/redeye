#!/usr/bin/env bash
# Builds the site and publishes it to the folder nginx serves.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm packages:build
pnpm --filter @redeye/web exec vite build
sudo mkdir -p /var/www/redeye
sudo rsync -a --delete apps/web/dist/ /var/www/redeye/
echo "Site published to /var/www/redeye"
