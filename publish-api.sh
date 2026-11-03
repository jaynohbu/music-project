#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
STACK="${1:-youtube-audio-library}"
REGION=us-west-2
ARTIFACT_BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK-artifacts" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucketName'].OutputValue | [0]" --output text)"
# Pass STEM_IMAGE (from build-stem-image.sh) to release worker changes; otherwise the deployed image stays.
STEM_IMAGE="${STEM_IMAGE:-$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Parameters[?ParameterKey=='StemImageUri'].ParameterValue | [0]" --output text)}"
node --input-type=module <<'JS'
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const template = (await readFile('template.yaml', 'utf8'))
  .replaceAll('      CodeUri: backend', `      CodeUri: ${JSON.stringify(process.cwd() + '/backend')}`);
await mkdir('.aws-sam/api-release', { recursive: true });
await writeFile('.aws-sam/api-release/template.yaml', template);
JS
sam validate --lint --template-file .aws-sam/api-release/template.yaml --region "$REGION"
aws cloudformation package --template-file .aws-sam/api-release/template.yaml --s3-bucket "$ARTIFACT_BUCKET" \
  --region "$REGION" --output-template-file .aws-sam/api-release/packaged.yaml
aws cloudformation deploy --template-file .aws-sam/api-release/packaged.yaml --stack-name "$STACK" --region "$REGION" \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "InitialPasswordSecretName=youtube-audio-library/registration-password" "StemImageUri=$STEM_IMAGE"
