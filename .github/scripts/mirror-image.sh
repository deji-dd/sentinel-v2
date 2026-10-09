#!/usr/bin/env bash
#
# Copies a public image into GHCR, so CI can pull it from GitHub with the
# credentials it already has instead of anonymously from Docker Hub.
#
# Why this exists: anonymous Docker Hub pulls are capped at 100 per 6 hours per
# source IP, and GitHub-hosted runners share an egress pool with every other
# workflow on it. Worse, Docker Hub's anonymous token endpoint intermittently
# stalls, returning `Client.Timeout exceeded while awaiting headers` or 504 —
# which has failed this repository's pipeline several times, including the very
# pull that was supposed to seed this mirror.
#
# Sources are therefore tried in order:
#
#   1. mirror.gcr.io — Google's public Docker Hub pull-through cache. It needs
#      no token exchange at all, which sidesteps the endpoint that keeps timing
#      out. Verified to serve byte-identical manifests (same
#      `docker-content-digest`) to Docker Hub for the images mirrored here.
#   2. Docker Hub itself, in case the cache is unreachable or does not carry the
#      image. Run `docker login docker.io` first to use the authenticated quota
#      (200 per 6 hours, and a token path that is not shed the same way);
#      without a login this is the anonymous request that fails under load.
#
# Once the target exists in GHCR, neither source is contacted again.
#
# Usage: mirror-image.sh <upstream-image> <ghcr-target-image> [--force]
#
#   --force  Re-copy even when the target already exists. Needed for moving tags
#            such as `moby/buildkit:buildx-stable-1`, which never change name but
#            do change content. A forced copy takes whatever the first reachable
#            source currently serves, so the cache may briefly lag Docker Hub.
#
# Requires: a docker CLI with push access to the target registry.

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

# The cache mirrors Docker Hub's namespace layout, where images published without
# a namespace (postgres, debian, …) live under `library/`.
case "${upstream}" in
*/*) cache_source="mirror.gcr.io/${upstream}" ;;
*) cache_source="mirror.gcr.io/library/${upstream}" ;;
esac

for source in "${cache_source}" "${upstream}"; do
	for attempt in 1 2 3; do
		echo "Copying ${source} -> ${target} (attempt ${attempt} of 3)..."
		# Inside a condition, so a failed attempt retries instead of aborting.
		if docker pull "${source}" &&
			docker tag "${source}" "${target}" &&
			docker push "${target}"; then
			echo "Mirrored ${source} -> ${target}."
			exit 0
		fi
		echo "Attempt ${attempt} of 3 against ${source} failed." >&2
		sleep $((attempt * 5))
	done
	echo "Could not seed ${target} from ${source}." >&2
done

echo "Could not seed ${target} from any source (${cache_source}, ${upstream})." >&2
echo "To unblock: run the 'Mirror CI Images' workflow, or copy it by hand from a" >&2
echo "machine that can reach either registry:" >&2
echo "  docker pull ${upstream}" >&2
echo "  docker tag ${upstream} ${target}" >&2
echo "  docker push ${target}" >&2
exit 1
