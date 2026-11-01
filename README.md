# YouTube Audio Library

An isolated Angular application and CPU-only conversion service. The existing
TunesBasis API and frontend are unchanged. As requested, this app creates its
**own Cognito user pool**, rather than sharing the TunesBasis pool.

## Pages

- Login: email/password; supports administrator-issued temporary passwords.
- Register: request an account, disabled until manually enabled in Cognito.
- Forgot password: email reset code, then code/new-password confirmation.
- Upload: submit a single YouTube video URL to queue a conversion.
- Split audio: upload an audio file directly for six-stem separation (up to
  30 MB / 30,000,000 bytes and seven minutes), with upload progress.
- List: per-user jobs, status/errors, pagination, YouTube playback/download, and
  links to completed stem mixers.
- Stem mixer: synchronized playback and seeking, waveforms and master volume.
  Each compact brushed-metal mixer contains its stem's waveform, transport and
  master volume, with an expandable effects panel beneath them containing
  nine vertical faders: Volume, Pre-gain, Compression, Distortion, Bass, Mid,
  Treble, Pan and Reverb. All nine are meaningful on all six stems. Not-ready
  audio and bypassed effects stay visible but disabled, with a reason.
  Effects panels start collapsed; waveforms and transport remain visible inside
  each mixer. Play/Pause/Stop, Loop, seek and Master Volume are available in every
  mixer; Master uses a horizontal metallic fader beside the transport buttons.
  Loop uses the same illuminated toggle styling as Mute, with keyboard activation
  and a shared pressed state across all mixers.
  They share one synchronized state across all six stems, not independent
  playback or separate master gains. Click a stem's Mixer header to show its full controls;
  opening another closes the previous panel. Click again to collapse it.
  Collapsed headers show volume and mute/solo/bypass status; collapsing never
  changes audio settings or stops playback. Only one panel is expanded at a time.
  Mute and Solo sit beside Stop, always visible; Effects Bypass and Reset are in the
  expanded panel. All four belong to that stem only.
  Solo allows multiple selected stems; mute always wins. Bypass skips pre-gain,
  compression, distortion, EQ, pan and reverb but preserves volume/mute/solo.
  A 6 ms delay in the dry path matches compressor lookahead to preserve timing.
  Reset restores the stem's faders and clears its mute/solo/bypass flags; it
  does not reset another stem, master volume, markers or transport.
  EQ is a 150 Hz bass shelf, 1 kHz mid band and 4 kHz treble shelf; each ranges
  from -12 to +12 dB. Pan runs left/center/right. Reverb uses a local 1.5-second
  stereo impulse; zero distortion and reverb are off. High pre-gain/EQ/drive
  can clip the mix: lower channel or master volume. Distortion is a smoothly
  blended, fixed soft-clip curve with level compensation, not added gain.
  It cannot boost individual samples and may sound quieter as clipping increases;
  Pre-gain can intentionally drive the clipper. The curve is never replaced while
  adjusting the fader, including transitions to/from zero. Stop/pause silence effect
  tails. Panels scroll horizontally on narrow screens; native faders support
  pointer, touch and keyboard input. Controls are not saved between mixer visits.
  Two downward arrows (S/E) above every waveform mark the shared start/end,
  defaulting to the full track. Drag either arrow on any stem to change the
  interval for all stems. Dragging auditions short synchronized audio previews
  at successive pointer positions, forward or backward; release resumes if
  playback was running, otherwise it stays paused. The red playhead is independent:
  drag it or the waveform to scrub without changing the interval. The existing
  Play/Pause/Stop controls operate on that interval; Loop repeats it with native
  Web Audio buffer looping. Stop returns to the start arrow. Markers also support
  arrow keys (Shift for larger steps), Home and End. Selections are local to
  the open mixer, not saved to the job.
- Generate accompaniment: four browser-side wizard steps select harmonic sources
  (vocals are optional and off by default) and tempo, estimate/review major/minor
  chords (including silence), choose a warm synth, acoustic guitar, clean electric
  guitar or piano with instrument-appropriate playing styles, then select regions,
  preview with source stems and save a full-length WAV.
  The last step shows a waveform for each selected stem on one shared scale and
  automatically selects regions where those stems contain audible music, ignoring
  faint separation bleed. Regions can be resized, moved, added or removed anywhere
  in the song by dragging, by keyboard or by typing exact times; overlaps merge.
  Play selection plays the selected stems inside the regions, skipping the gaps,
  before anything is generated. Accompaniment is generated only inside the regions
  and every other sample is exactly zero, so the saved stem stays aligned.
  A region with only "N" chords stays silent and is flagged in the editor.
  Every note draws its own random onset and length change of 0.01% to 0.05% of its
  length, in either direction, from a saved seed so the preview matches the saved render.
  The accompaniment's level is matched to the average loudness of the selected
  stems while they play inside the regions, then rises and falls with them, from
  -18 dB to +6 dB around that average with a peak ceiling. Regions over silent source
  audio stay quietly audible. A short preview keeps its place in the song's dynamics
  rather than being matched on its own, so its level is close to, not identical to, the save.
  Chord detection is approximate and uses a bar grid starting at time zero;
  set the tempo and correct estimated chords before rendering. Complex harmony,
  tempo changes, separation artifacts and pickup beats can need manual corrections.
  Generation is local, in a Web Worker plus OfflineAudioContext; no uploaded
  music is sent to an external analysis or generation service. Keep the page open
  until save completes. Full-length rendering adds about 148 MB of float audio
  and a 74 MB WAV for a seven-minute song, on top of decoded original stems.
  Piano uses Salamander Grand Piano V3 by Alexander Holm (CC BY 3.0), with four velocity
  layers chosen from the source stems' loudness and each layer leveled so it changes
  tone rather than volume. Guitars use the Musyng Kite soundfont (CC BY-SA 3.0), so a
  shared guitar WAV should carry that credit and license; see
  `web/public/instruments/LICENSE.txt`. The pinned sample-selection script is
  `npm run bundle:instruments --prefix web` (needs FFmpeg); normal deployment needs no
  download. Instrument files are cached as immutable, so give changed samples a new
  file name. Guitar articulation is basic: no string choice or strum direction.
  It is not a realistic performer model or exact transcription of the original.
  Saving uses an exact-size private S3 POST, validates canonical PCM16 stereo
  44.1 kHz WAV length against the parent song, then copies to a write-once output.
  Separate DynamoDB accompaniment records store instrument/style/tempo, selected
  sources, corrected chord timings, regions and the random seed. Retries use the same request ID and keep
  rendered audio. If a save expires, use Back to generate a fresh save.
  Completed audio has no expiry and reloads automatically as additional channels
  with the same transport, markers, master, mute/solo/effects/reset and download.
  Delete on a generated channel, after confirmation, permanently removes that stem
  from the mixer and private storage. The bucket is not versioned, so this cannot be
  undone. The API's S3 delete permission excludes `users/*/stems/*`, so original
  stems cannot be deleted through it. Already-issued signed links stop working.
  Signed links renew with the original stems. A generated channel load failure
  does not prevent original six-stem playback. Do not share sampled instrument
  downloads without their attribution.
- Logout: global Cognito sign-out and removal of the local session.

## Architecture

CloudFront serves the Angular app from a private S3 bucket and forwards `/api/*`
to API Gateway. JWT-authenticated requests create/list per-user DynamoDB jobs.
The stack creates its own zero-TTL cache policy for API requests and runtime
configuration, so authenticated responses and configuration are never cached.
The API asynchronously invokes a **Lambda Docker image**, which runs `yt-dlp`
and FFmpeg, uploads a WAV to a separate private S3 bucket, and records its status.
The YouTube worker remains independent of stem separation.
Direct uploads use signed S3 POST policies restricted to the server-generated
key and exact file size. A separate **Demucs CPU Fargate task** runs for each
separation, orchestrated by a Standard Step Functions execution. No persistent
container, GPU, ECS service, NAT gateway or load balancer is required.
Workflow/container launch payloads contain only user/job identifiers. The worker
reads media keys and titles from DynamoDB; decomposed Unicode titles are not
passed through ECS environment variables, which require NFC-normalized values.
The UI uses hash routes so refreshing either page needs no S3 error-page rewrite.

Conversion is limited to non-live videos up to 10 minutes and files up to 250 MiB.
Direct audio uploads have separate seven-minute and 30 MB limits;
the browser checks duration before upload and the service validates the actual media.
YouTube workers have 2 GiB memory, 1 GiB scratch space, a 15-minute timeout and concurrency
of two. Pending invocations expire after 60 seconds; asynchronous retries are
disabled. An undelivered or timed-out job is displayed as failed after 17 minutes.
This is a small private tool, not an unlimited public download service.
Stem tasks use 4 vCPU and 16 GiB memory with a two-hour job deadline. They have
outbound-only networking and a public IP for ECR/AWS access; no inbound ports.
The six PCM16 stereo 44.1 kHz WAV outputs must have identical frame counts.
WAV avoids MP3 encoder-delay alignment differences. At seven minutes, decoded
six-stem playback uses roughly 848 MiB at 44.1 kHz before browser/audio processing
overhead (more if the browser resamples to 48 kHz). Low-memory devices may not
handle the longest files. The 30 MB limit applies to the uploaded source, not
the expanded WAV stems; a seven-minute PCM WAV source exceeds it, so use a
compressed input such as MP3, M4A or FLAC for long recordings.
An upload expires after 15 minutes; queued/processing stem jobs use a separate
two-hour deadline rather than the YouTube timeout. Failed stem history also
disappears after ten minutes. Abandoned input objects expire from S3 after one day.
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
Queued YouTube jobs have a fallback expiration at creation + 17-minute processing limit
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
CloudFormation, IAM, Lambda, API Gateway, ECR, S3, DynamoDB, Cognito, CloudFront,
ECS, EC2 networking, EventBridge and Step Functions
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
deployment bucket and an immutable-tag ECR stem-image repository. The script
builds/pushes the x86_64 Demucs image with its model cached, then passes its URI
as `StemImageUri`. This small bootstrap stack is deployed automatically; the
application changeset still asks for confirmation. The explicit bucket avoids
depending on SAM's shared `aws-sam-cli-managed-default` stack, whose bucket may
have been deleted independently. No shared SAM resources are repaired or deleted.
All regional resources are in **us-west-2**. CloudFront is a global AWS service.
SAM manages the YouTube worker image's ECR repository. The stem worker uses
the bootstrap repository and a dedicated stack-created VPC.
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

For API/infrastructure-only changes without rebuilding either audio worker image:
`bash publish-api.sh youtube-audio-library` uses AWS CloudFormation packaging for the current backend and
preserves the deployed YouTube and Demucs image URIs. Review template changes
before running it; it deploys the stack without an interactive changeset prompt.
Accompaniment changes require this deployment before publishing the frontend.

Focused accompaniment tests: `npm run test:accompaniment --prefix web` and
`node --test backend/test/accompaniment.test.mjs`.
The explicit live runner `SMOKE_API_URL=https://d324d1xuqjbi6.cloudfront.net/api node
backend/test/live-accompaniment-smoke.mjs` creates and deletes only a temporary
account, synthetic parent stems, generated audio and records. It verifies S3/IAM,
write-once persistence and authenticated signed reload; it is not run by unit tests.

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
npm run test:effects --prefix web
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
The `npm test --prefix backend` suite uses fake AWS clients, never downloads a
video or touches AWS.

### Local stem separation

Use a separate Python 3.11 environment (the pinned PyTorch version does not
support the downloader's Python 3.13 environment):

```bash
python3.11 -m venv .venv-stems
.venv-stems/bin/python -m pip install -r backend/stem-requirements.txt
LOCAL_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg npm run start:local --prefix backend
```

The API automatically uses `.venv-stems/bin/python`; override with
`STEM_PYTHON_PATH`. The default device is CPU; `STEM_DEVICE=mps` or `cuda`
requires compatible local hardware/PyTorch. Local separation runs one job at
a time and uses AWS Cognito, S3 and DynamoDB. The deployed bucket needs the new
POST CORS configuration before browser upload works. Upload/start failures
remain explicit; a start request can be retried without reuploading the file.
Local processing is not durable across process shutdown; AWS processing uses
Step Functions for durable task monitoring and terminal-state finalization.

For an explicit authenticated integration test (creates and removes a temporary
Cognito account, synthetic audio, S3 objects and job record):

```bash
node backend/test/live-stem-smoke.mjs
SMOKE_API_URL=https://YOUR_SITE/api node backend/test/live-stem-smoke.mjs
SMOKE_DURATION_SECONDS=420 node backend/test/live-stem-smoke.mjs
```

This requires administrative Cognito permissions in addition to job/storage
access. It downloads no YouTube content. A local CPU check of a synthetic
180-second input produced six exactly aligned WAVs in about 86 seconds with
roughly 1.68 GiB peak resident memory on the development Mac. This is not an
AWS performance or separation-quality guarantee.

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
The separate stem image does. Inspect ECS/Step Functions and the stem log group
for processing failures. Fargate tasks stop after each job, but CPU, memory,
public IPv4 usage, image storage and workflow transitions incur charges.
There is no global production stem concurrency cap; limit access to this private
tool and monitor budgets before adding users or submitting many simultaneous jobs.

Lambda scales to zero, but S3, DynamoDB storage, backups, CloudFront traffic,
CloudWatch and ECR can still incur charges. Audio and the job table are retained
when deleting the stack to protect user files; remove retained resources explicitly
when no longer needed. Empty the website bucket before stack deletion. Review AWS
budgets and usage limits before granting additional user accounts.
The deployment artifact bucket is also retained and must be cleaned up explicitly
when no longer needed.
# music-project
