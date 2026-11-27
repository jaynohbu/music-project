#!/usr/bin/env bash
# Builds and pushes the ScoreReader image (backend/Dockerfile.scores) to the stem repository; prints its URI for
# SCORE_IMAGE=... bash publish-api.sh.
set -euo pipefail
cd "$(dirname "$0")"
STACK="${1:-youtube-audio-library}"
REPOSITORY="$(aws cloudformation describe-stacks --stack-name "${STACK}-artifacts" \
  --region us-west-2 --query "Stacks[0].Outputs[?OutputKey=='StemRepositoryUri'].OutputValue | [0]" --output text)"
if [[ -z "$REPOSITORY" || "$REPOSITORY" == "None" ]]; then
  echo "Deploy artifacts.yaml before building the score image." >&2
  exit 1
fi
IMAGE="${REPOSITORY}:score-$(date -u +%Y%m%d%H%M%S)"
aws ecr get-login-password --region us-west-2 | docker login \
  --username AWS --password-stdin "${REPOSITORY%%/*}" >&2
# Lambda takes Docker v2 images (no attestation manifests).
docker build --platform linux/amd64 --provenance=false -f backend/Dockerfile.scores -t "$IMAGE" backend >&2
docker push "$IMAGE" >&2
echo "$IMAGE"
