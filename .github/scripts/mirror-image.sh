#!/usr/bin/env bash
#
# Copies a public Docker Hub image into GHCR, so CI can pull it from GitHub with
# the credentials it already has instead of anonymously from Docker Hub.
#
# Why this exists: anonymous Docker Hub pulls are capped at 100 per 6 hours per
# source IP, and GitHub-hosted runners share an egress pool with every other
# workflow on it. Docker Hub's anonymous token endpoint also intermittently
# stalls or returns 504, which surfaces in CI as `toomanyrequests`, `Client.Timeout
# exceeded while awaiting headers`, or `failed to fetch oauth token`. Both the
# Bun base image and the BuildKit builder image are pulled on every build, so
# both are mirrored here.
#
# Usage: mirror-image.sh <upstream-image> <ghcr-target-image> [--force]
#
#   --force  Re-copy even when the target already exists. Needed for moving
#            tags such as `moby/buildkit:buildx-stable-1`, which never change
#            name but do change content.
#
# Requires: an authenticated docker CLI (GHCR login), and packages: write.

set -euo pipefail

upstream="${1:?usage: mirror-image.sh <upstream-image> <ghcr-target-image> [--force]}"
target="${2:?usage: mirror-image.sh <upstream-image> <ghcr-target-image> [--force]}"
force="${3:-}"

if [ "${force}" != "--force" ]; then
	if docker manifest inspect "${target}" >/dev/null 2>&1; then
		echo "${target} is already mirrored; nothing to do."
		exit 0
	fi
fi

echo "Copying ${upstream} -> ${target}..."

# Docker Hub's auth endpoint resets connections under load, so a single failure
# must not take the whole build down with it.
for attempt in 1 2 3; do
	if docker pull "${upstream}"; then
		docker tag "${upstream}" "${target}"
		docker push "${target}"
		echo "Mirrored ${upstream} -> ${target}."
		exit 0
	fi
	echo "Docker Hub pull of ${upstream} failed (attempt ${attempt} of 3)." >&2
	sleep $((attempt * 5))
done

echo "Could not fetch ${upstream} from Docker Hub; ${target} cannot be seeded." >&2
exit 1
