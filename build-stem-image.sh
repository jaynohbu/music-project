#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
STACK="${1:-youtube-audio-library}"
REPOSITORY="$(aws cloudformation describe-stacks --stack-name "${STACK}-artifacts" \
  --region us-west-2 --query "Stacks[0].Outputs[?OutputKey=='StemRepositoryUri'].OutputValue | [0]" --output text)"
if [[ -z "$REPOSITORY" || "$REPOSITORY" == "None" ]]; then
  echo "Deploy artifacts.yaml before building the stem image." >&2
  exit 1
fi
IMAGE="${REPOSITORY}:cpu-$(date -u +%Y%m%d%H%M%S)"
aws ecr get-login-password --region us-west-2 | docker login \
  --username AWS --password-stdin "${REPOSITORY%%/*}" >&2
docker build --platform linux/amd64 -f backend/Dockerfile.stems -t "$IMAGE" backend >&2
docker push "$IMAGE" >&2
echo "$IMAGE"
