#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
STACK="${1:-youtube-audio-library}"
REGION=us-west-2
OUTPUTS="$(aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query 'Stacks[0].Outputs' --output json)"
export OUTPUTS
output() {
  node --input-type=module -e '
    const item = JSON.parse(process.env.OUTPUTS).find(o => o.OutputKey === process.argv[1]);
    if (!item?.OutputValue) throw new Error(`Missing stack output: ${process.argv[1]}`);
    console.log(item.OutputValue);
  ' "$1"
}
BUCKET="$(output WebsiteBucketName)"
DISTRIBUTION="$(output DistributionId)"
SITE="$(output WebsiteUrl)"
POOL="$(output UserPoolId)"
CLIENT="$(output UserPoolClientId)"
export POOL CLIENT
node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  writeFileSync("web/public/config.json", JSON.stringify({
    region: "us-west-2", userPoolId: process.env.POOL,
    clientId: process.env.CLIENT, apiBaseUrl: "/api"
  }, null, 2));
'
npm run build --prefix web
aws s3 sync web/dist/youtube-library/browser/ "s3://$BUCKET/" --region "$REGION" \
  --exclude index.html --exclude config.json --exclude config.example.json \
  --cache-control 'public,max-age=31536000,immutable'
aws s3 cp web/dist/youtube-library/browser/index.html "s3://$BUCKET/index.html" \
  --region "$REGION" --content-type text/html --cache-control no-cache
aws s3 cp web/dist/youtube-library/browser/config.json "s3://$BUCKET/config.json" \
  --region "$REGION" --content-type application/json --cache-control no-store
INVALIDATION="$(aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" \
  --paths '/*' --query Invalidation.Id --output text)"
aws cloudfront wait invalidation-completed --distribution-id "$DISTRIBUTION" --id "$INVALIDATION"
curl --fail --silent --show-error "$SITE/config.json" >/dev/null
printf '\nWebsite: %s\nUser pool: %s\n' "$SITE" "$POOL"
