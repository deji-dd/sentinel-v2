#!/usr/bin/env bash
set -e

# Syncs production environment file to target server dejis-cloud
TARGET_HOST="${1:-dejis-cloud}"
TARGET_DIR="/opt/sentinel-v2"

echo "[sync-env] Syncing .env.production to root@${TARGET_HOST}:${TARGET_DIR}/.env.production..."
rsync -avzP .env.production "root@${TARGET_HOST}:${TARGET_DIR}/.env.production"

echo "[sync-env] Environment sync complete."
