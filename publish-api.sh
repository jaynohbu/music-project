#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
STACK="${1:-youtube-audio-library}"
REGION=us-west-2
YOUTUBE_OWNER_SUB="$(node backend/youtube-admin.mjs owner "$STACK")"
ARTIFACT_BUCKET="$(aws cloudformation describe-stacks --stack-name "$STACK-artifacts" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ArtifactBucketName'].OutputValue | [0]" --output text)"
WORKER="$(aws cloudformation describe-stack-resource --stack-name "$STACK" --logical-resource-id Worker \
  --region "$REGION" --query StackResourceDetail.PhysicalResourceId --output text)"
WORKER_IMAGE="$(aws lambda get-function --function-name "$WORKER" --region "$REGION" --query Code.ImageUri --output text)"
# Pass STEM_IMAGE (from build-stem-image.sh) to release worker changes; otherwise the deployed image stays.
STEM_IMAGE="${STEM_IMAGE:-$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Parameters[?ParameterKey=='StemImageUri'].ParameterValue | [0]" --output text)}"
export WORKER_IMAGE
node --input-type=module <<'JS'
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const image = process.env.WORKER_IMAGE;
if (!image?.includes('.dkr.ecr.') || image === 'None') throw new Error('Missing deployed worker image.');
let template = await readFile('template.yaml', 'utf8');
const metadata = '    Metadata:\n      DockerContext: backend\n      Dockerfile: Dockerfile\n      DockerTag: cpu-v1\n';
if (template.split(metadata).length !== 2 || template.split('      PackageType: Image').length !== 2) {
  throw new Error('Worker template changed; review image preservation before deploying.');
}
template = template.replace(metadata, '')
  .replace('      PackageType: Image', `      PackageType: Image\n      ImageUri: ${JSON.stringify(image)}`)
  .replaceAll('      CodeUri: backend', `      CodeUri: ${JSON.stringify(process.cwd() + '/backend')}`);
await mkdir('.aws-sam/api-release', { recursive: true });
await writeFile('.aws-sam/api-release/template.yaml', template);
JS
sam validate --lint --template-file .aws-sam/api-release/template.yaml --region "$REGION"
aws cloudformation package --template-file .aws-sam/api-release/template.yaml --s3-bucket "$ARTIFACT_BUCKET" \
  --region "$REGION" --output-template-file .aws-sam/api-release/packaged.yaml
aws cloudformation deploy --template-file .aws-sam/api-release/packaged.yaml --stack-name "$STACK" --region "$REGION" \
  --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "InitialPasswordSecretName=youtube-audio-library/registration-password" "StemImageUri=$STEM_IMAGE" \
    "YoutubeOwnerSubject=$YOUTUBE_OWNER_SUB"
node backend/youtube-admin.mjs revoke "$STACK"
