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
API_BASE_URL="$(output PublicApiUrl)"
export POOL CLIENT API_BASE_URL
npm run build --prefix web
# Written into the build only: web/public/config.json keeps "/api" for local development.
node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  writeFileSync("web/dist/youtube-library/browser/config.json", JSON.stringify({
    region: "us-west-2", userPoolId: process.env.POOL,
    clientId: process.env.CLIENT, apiBaseUrl: process.env.API_BASE_URL
  }, null, 2));
'
aws s3 sync web/dist/youtube-library/browser/ "s3://$BUCKET/" --region "$REGION" \
  --exclude index.html --exclude config.json --exclude config.example.json \
  --exclude sorituh-mark.svg --exclude sorituh-logo.svg \
  --cache-control 'public,max-age=31536000,immutable'
for asset in sorituh-mark.svg sorituh-logo.svg; do
  aws s3 cp "web/dist/youtube-library/browser/$asset" "s3://$BUCKET/$asset" \
    --region "$REGION" --content-type image/svg+xml --cache-control no-cache
done
aws s3 cp web/dist/youtube-library/browser/index.html "s3://$BUCKET/index.html" \
  --region "$REGION" --content-type text/html --cache-control no-cache
aws s3 cp web/dist/youtube-library/browser/config.json "s3://$BUCKET/config.json" \
  --region "$REGION" --content-type application/json --cache-control no-store
INVALIDATION="$(aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" \
  --paths '/*' --query Invalidation.Id --output text)"
aws cloudfront wait invalidation-completed --distribution-id "$DISTRIBUTION" --id "$INVALIDATION"
curl --fail --silent --show-error "$SITE/config.json" >/dev/null
printf '\nWebsite: %s\nUser pool: %s\n' "$SITE" "$POOL"
