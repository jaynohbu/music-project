# YouTube Audio Library

An isolated Angular application and CPU-only conversion service. The existing
TunesBasis API and frontend are unchanged. As requested, this app creates its
**own Cognito user pool**, rather than sharing the TunesBasis pool.

## Pages

- Login: email/password; supports administrator-issued temporary passwords.
- Register: request an account, disabled until manually enabled in Cognito.
- Forgot password: email reset code, then code/new-password confirmation.
- Upload: submit a single YouTube video URL to queue a conversion.
- List: per-user jobs, status/errors, pagination, inline playback and WAV download.
- Logout: global Cognito sign-out and removal of the local session.

## Architecture

CloudFront serves the Angular app from a private S3 bucket and forwards `/api/*`
to API Gateway. JWT-authenticated requests create/list per-user DynamoDB jobs.
The stack creates its own zero-TTL cache policy for API requests and runtime
configuration, so authenticated responses and configuration are never cached.
The API asynchronously invokes a **Lambda Docker image**, which runs `yt-dlp`
and FFmpeg, uploads a WAV to a separate private S3 bucket, and records its status.
No persistent container, GPU, ECS service or load balancer is required.
The UI uses hash routes so refreshing either page needs no S3 error-page rewrite.

Conversion is limited to non-live videos up to 10 minutes and files up to 250 MiB.
Workers have 2 GiB memory, 1 GiB scratch space, a 15-minute timeout and concurrency
of two. Pending invocations expire after 60 seconds; asynchronous retries are
disabled. An undelivered or timed-out job is displayed as failed after 17 minutes.
This is a small private tool, not an unlimited public download service.
Only download content you own or have permission to download. YouTube can block
data-center downloads; the app reports failure rather than bypassing restrictions.

Failed conversions now include a safe human-readable message, `errorCode`, and
`failureStage` in the list. Reasons distinguish YouTube sign-in/bot checks,
unavailable/age-restricted videos, app duration/live filters and file limits,
outdated/missing yt-dlp, FFmpeg/format errors, HTTP 403/429, network failures,
execution timeouts, missing output/metadata, S3 uploads, and DynamoDB updates.
The worker inspects stdout as well as stderr: yt-dlp may exit successfully after
skipping a video because of a filter or size limit. A combined duration/live
filter reports the combined rule, not a guessed specific cause.
Subprocess output, signed media URLs, commands and local file paths are not
returned to users. Server failure logs contain job ID, stage, classified reason,
exception name and numeric exit code rather than the raw subprocess error.
Previously stored failures keep their older messages until expiration or a new
attempt; the downloader implementation and all limits remain unchanged.

The API returns 202 when queued, **not when conversion finishes**. List polls
every five seconds. Links expire after one hour and are renewed while the page
is open. Links are bearer URLs: do not share them unless you intend to share
the file. Cognito tokens stay in session storage for this browser tab.
Cognito/API Gateway may continue to accept already-issued JWTs until their
one-hour expiration after logout; global sign-out revokes refresh sessions.

Failed history disappears from API responses ten minutes after failure (the
open list reflects this on its next five-second refresh). DynamoDB TTL removes
the records asynchronously; physical deletion may take days, but expired
history is never returned by the API. Completed jobs have no TTL and remain.
Queued jobs have a fallback expiration at creation + 17-minute processing limit
+ 10-minute failure-history window, covering abandoned and hard-timed-out jobs.
The worker replaces this expiration with failure time + ten minutes on failure,
or removes it entirely on success.
For pre-existing failures without a failure timestamp, creation time is the
legacy retention reference; existing successful records are unchanged.
After enabling TTL, apply expiration to older records once:

```bash
AWS_REGION=us-west-2 TABLE_NAME=YOUR_JOBS_TABLE \
  node backend/expire-job-history.mjs
```

## Deploy to AWS us-west-2

Requirements: Node 22.12+ or a supported Node 24 release, npm, AWS CLI,
AWS SAM CLI, and a running Docker-compatible engine. AWS credentials need
CloudFormation, IAM, Lambda, API Gateway, ECR, S3, DynamoDB, Cognito and CloudFront
deployment permissions.

```bash
cd youtube-app
bash deploy.sh
```

The script installs locked dependencies, tests the backend, builds Angular,
validates/builds SAM, asks for approval of the AWS changeset, then uploads the web
assets and generated public runtime configuration. The stack defaults to
`youtube-audio-library`; pass a different stack name as the first argument if needed.
Before deploying the application, the script creates a separate
`youtube-audio-library-artifacts` CloudFormation stack containing a private S3
deployment bucket. This small bootstrap stack is deployed automatically; the
application changeset still asks for confirmation. The explicit bucket avoids
depending on SAM's shared `aws-sam-cli-managed-default` stack, whose bucket may
have been deleted independently. No shared SAM resources are repaired or deleted.
All regional resources are in **us-west-2**. CloudFront is a global AWS service.
SAM manages the worker image's ECR repository; no image URI or VPC is needed.
Before deployment, create a Secrets Manager secret named
`youtube-audio-library/registration-password` in us-west-2. Store the administrator's
chosen initial password as the **plain-text SecretString**, not a JSON object.
It must meet the 12-character Cognito password policy. Never commit it or put it
in the frontend, runtime config, template, or a shell script. The deployment script
checks that the secret exists; the account Lambda reads it at registration time.

For frontend-only updates to an existing stack:

```bash
bash publish-web.sh youtube-audio-library
```

The final output gives the HTTPS website URL and Cognito pool ID. The Register
page creates the account using the backend, marks its email verified without
checking ownership, suppresses automatic email, disables it, and sets the secret
as a permanent password. Disabling happens **before** installing the shared
password to avoid exposing an enabled account with a known password.
If setup fails, the backend removes only the account it just created. Duplicate
registration never changes or disables an existing account.

Enable a requested account in the Cognito console, or use:

```bash
aws cognito-idp admin-enable-user \
  --region us-west-2 --user-pool-id YOUR_POOL_ID \
  --username your-email@example.com
```

After enablement, the email and permanent initial password work immediately,
without email verification or forced first-login password change. A shared
initial password is a risk: tell each approved user to set a personal password
using Forgot password. Accounts and audio are not imported from TunesBasis.

## Anonymous account sessions

`POST /api/accounts/session` issues a random 256-bit token with a **300-second**
lifetime. Only its hash is stored in DynamoDB. Registration and password reset
requests require the `X-Account-Session` header. The backend atomically checks
expiration and limits each token to five attempts; delayed DynamoDB TTL deletion
does not make an expired token valid. Issuance is limited to ten sessions per
API Gateway source address per five-minute window, plus route-level throttling.
When using CloudFront, source-address limiting can be shared by clients behind
the same proxy. These anonymous tokens are not proof of identity and do not
replace approval, Cognito reset codes, bot protection, or AWS budgets.

Registration and reset pages hold this token only in memory. At five minutes,
or a server 401 for an expired/exhausted token, the page reloads and obtains a
new session. Forms/passwords/codes are not persisted or automatically resubmitted.
Leaving either page cancels its timer. Password reset never enables a disabled
account, and reset codes have their separate Cognito expiration.

The account Lambda can create, disable, set passwords and roll back newly created
users in this pool only. It has **no AdminEnableUser permission**. The job API
remains JWT-protected; only the four account endpoints are anonymous.

## Local development and checks

```bash
npm ci --prefix backend
npm test --prefix backend
npm ci --prefix web
npm run build --prefix web
sam validate --lint --region us-west-2
```

For local API **and local conversion**, use the deployed `web/public/config.json`
with `apiBaseUrl: "/api"`. If it is missing, copy the example and fill in the
deployed Cognito pool/client IDs. Install `yt-dlp` with its default dependencies
and FFmpeg on your machine. Use a current Node version supported by yt-dlp's JS
runtime. AWS credentials must allow CloudFormation reads and access to this
stack's DynamoDB, S3, Cognito administrator operations and password secret.

```bash
# Terminal 1: local API and CPU conversion worker
npm run start:local --prefix backend
# Terminal 2: Angular
npm start --prefix web
```

Open `http://localhost:4200`. `npm start` proxies `/api/**` to the local API on
`127.0.0.1:3001`. The API verifies real Cognito ID tokens and executes the shared
conversion worker **on your machine**, not Lambda. Job records and WAV files
still go to real AWS DynamoDB and S3; login/reset still use Cognito.
Two conversions can run concurrently; excess submissions fail explicitly rather
than forming an unbounded local queue. Keep the API process running until active
jobs finish. `GET http://127.0.0.1:3001/health` reports the active execution mode.
Startup reads resource names from the `youtube-audio-library` stack in us-west-2.
Set `LOCAL_STACK_NAME`, `LOCAL_API_PORT`, `LOCAL_YTDLP_PATH`, or `LOCAL_FFMPEG_PATH` if needed; when
changing the port, also update the frontend proxy.
For a project-isolated downloader matching the AWS image, create an environment
using Python 3.11+ and install the pinned dependencies:

```bash
python3.13 -m venv .venv-download
.venv-download/bin/python -m pip install -r backend/downloader-requirements.txt
npm run start:local --prefix backend
```

The local API automatically prefers `.venv-download/bin/yt-dlp` and logs the
selected executable and version at startup. `LOCAL_YTDLP_PATH` overrides it.
This avoids older Python shims or Homebrew versions without changing global
installations. When updating the pin, also update the AWS Dockerfile version.
Startup checks support for `--js-runtimes` rather than allowing an outdated
downloader to start and fail every conversion.

For **frontend-only local development with AWS Lambda conversion** instead:

```bash
npm run start:aws --prefix web
```

That command uses `web/proxy.aws.conf.json`, targeting the live CloudFront site.
Update its target if deploying a different stack. Do not confuse this mode with
local conversion: YouTube sees the AWS network address in frontend-only mode.
Deployment always replaces runtime configuration with the deployed stack outputs.
Backend tests use fake AWS clients, never download a video or touch AWS.

For a real `yt-dlp`/FFmpeg integration smoke test after `sam build`:

```bash
docker run --rm --platform linux/amd64 --entrypoint node \
  -v "$PWD/backend/test:/var/task/test:ro" \
  worker:cpu-v1 test/container-smoke.mjs
```

This generates a one-second synthetic MP4 inside the container, serves it locally,
converts it to WAV and checks the upload stream's RIFF/WAVE header. AWS calls
are mocked; it does not download a YouTube video.

Production dependency audits are clean. The Angular CLI currently has a moderate
transitive `minimatch` advisory in development/build tooling; npm's proposed fix
would downgrade Angular, so no forced major-version override is applied.

## Operations and cost

CloudWatch records API and worker failures. Inspect the Lambda logs when a job
fails. Pin/update `yt-dlp` in `backend/Dockerfile` and rebuild when YouTube changes.
The conversion image does not include Demucs or PyTorch.

Lambda scales to zero, but S3, DynamoDB storage, backups, CloudFront traffic,
CloudWatch and ECR can still incur charges. Audio and the job table are retained
when deleting the stack to protect user files; remove retained resources explicitly
when no longer needed. Empty the website bucket before stack deletion. Review AWS
budgets and usage limits before granting additional user accounts.
The deployment artifact bucket is also retained and must be cleaned up explicitly
when no longer needed.
# music-project
