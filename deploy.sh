#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
STACK="${1:-youtube-audio-library}"
REGION=us-west-2
for tool in aws sam node npm; do
  command -v "$tool" >/dev/null || { echo "Missing required tool: $tool" >&2; exit 1; }
done
npm ci --prefix backend
npm ci --prefix web
npm test --prefix backend
npm run build --prefix web
sam validate --lint --region "$REGION"
aws secretsmanager describe-secret \
  --secret-id youtube-audio-library/registration-password --region "$REGION" \
  --query ARN --output text >/dev/null
ARTIFACT_STACK="${STACK}-artifacts"
aws cloudformation deploy --template-file artifacts.yaml \
  --stack-name "$ARTIFACT_STACK" --region "$REGION" --no-fail-on-empty-changeset
ARTIFACT_BUCKET="$(aws cloudformation describe-stacks \
  --stack-name "$ARTIFACT_STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucketName'].OutputValue | [0]" \
  --output text)"
if [[ -z "$ARTIFACT_BUCKET" || "$ARTIFACT_BUCKET" == "None" ]]; then
  echo "Artifact stack did not return an S3 bucket." >&2
  exit 1
fi
aws s3api head-bucket --bucket "$ARTIFACT_BUCKET" --region "$REGION"
STEM_IMAGE="$(bash build-stem-image.sh "$STACK")"
sam build
sam deploy --stack-name "$STACK" --region "$REGION" --s3-bucket "$ARTIFACT_BUCKET" \
  --resolve-image-repos --capabilities CAPABILITY_IAM --confirm-changeset \
  --parameter-overrides "InitialPasswordSecretName=youtube-audio-library/registration-password" "StemImageUri=$STEM_IMAGE"
bash publish-web.sh "$STACK"
