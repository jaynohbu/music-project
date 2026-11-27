#!/usr/bin/env bash
# Builds the split-only worker image (backend/Dockerfile.split) into the stem repository, tagged split-<time>.
# Release it with SPLIT_IMAGE=$(bash build-split-image.sh) bash publish-api.sh.
set -euo pipefail
cd "$(dirname "$0")"
STACK="${1:-youtube-audio-library}"
REPOSITORY="$(aws cloudformation describe-stacks --stack-name "${STACK}-artifacts" \
  --region us-west-2 --query "Stacks[0].Outputs[?OutputKey=='StemRepositoryUri'].OutputValue | [0]" --output text)"
if [[ -z "$REPOSITORY" || "$REPOSITORY" == "None" ]]; then
  echo "Deploy artifacts.yaml before building the split image." >&2
  exit 1
fi
IMAGE="${REPOSITORY}:split-$(date -u +%Y%m%d%H%M%S)"
aws ecr get-login-password --region us-west-2 | docker login \
  --username AWS --password-stdin "${REPOSITORY%%/*}" >&2
docker build --platform linux/amd64 -f backend/Dockerfile.split -t "$IMAGE" backend >&2
docker push "$IMAGE" >&2
echo "$IMAGE"
