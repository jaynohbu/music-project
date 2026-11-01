const messages = {
  YOUTUBE_SIGN_IN_REQUIRED: 'YouTube requires sign-in or bot verification for this download. This is a YouTube rejection, not the app’s duration or size limit.',
  VIDEO_UNAVAILABLE: 'YouTube reports that this video is private, removed, unavailable, or restricted in this region.',
  AGE_RESTRICTED: 'YouTube requires age verification to access this video.',
  VIDEO_FILTERED: 'The app skipped this video: it must be non-live and no longer than 10 minutes. Missing duration/live metadata can also cause a skip.',
  FILE_TOO_LARGE: 'The downloaded or converted audio exceeds the app’s 250 MiB file limit.',
  DOWNLOADER_INCOMPATIBLE: 'The installed yt-dlp version does not support the required options. Update it or select a compatible executable.',
  DOWNLOADER_MISSING: 'The yt-dlp executable is missing or cannot be started on the conversion server.',
  FFMPEG_FAILED: 'FFmpeg could not extract WAV audio. Check the installed FFmpeg and the input audio format.',
  FORMAT_UNAVAILABLE: 'yt-dlp could not find a usable audio format. The video may require a newer downloader or provide no downloadable audio.',
  NETWORK_FAILED: 'The download failed because of a network, DNS, TLS, or connection timeout error.',
  DOWNLOAD_FORBIDDEN: 'The media server rejected the download with HTTP 403. This is a server-side rejection, not an app size or duration limit.',
  DOWNLOAD_RATE_LIMITED: 'The media server is rate-limiting downloads (HTTP 429). Wait before trying again.',
  CONVERSION_TIMEOUT: 'The conversion exceeded its execution time limit and was stopped.',
  OUTPUT_MISSING: 'yt-dlp finished but did not create a WAV file. No audio was uploaded.',
  METADATA_INVALID: 'The conversion output metadata is missing or invalid. No audio was uploaded.',
  UPLOAD_FAILED: 'Audio conversion finished, but uploading the WAV to AWS S3 failed.',
  JOB_UPDATE_FAILED: 'The service could not update the job record in DynamoDB. Check server permissions and connectivity.',
  LOCAL_STORAGE_FAILED: 'The conversion server could not create or read temporary files. Check disk space and permissions.',
  INVALID_VIDEO_URL: 'The video URL is invalid. Use a single HTTPS YouTube video URL.',
  DOWNLOAD_FAILED: 'Conversion failed while downloading or extracting audio. The downloader returned an unrecognized error; check server diagnostics.',
};

export class ConversionError extends Error {
  constructor(code) {
    super(messages[code]);
    this.name = 'ConversionError';
    this.code = code;
  }
}

export function classifyConversionError(error, stage, output = '') {
  if (error instanceof ConversionError) return { errorCode: error.code, error: error.message };
  const code = classify(error, stage, output);
  return { errorCode: code, error: messages[code] };
}

function classify(error, stage, output) {
  if (stage === 'upload') return 'UPLOAD_FAILED';
  if (stage === 'record') return 'JOB_UPDATE_FAILED';
  if (stage === 'validate') return 'INVALID_VIDEO_URL';
  if (stage === 'scratch') return 'LOCAL_STORAGE_FAILED';
  if (stage === 'metadata') return 'METADATA_INVALID';
  if (stage === 'output') return 'LOCAL_STORAGE_FAILED';
  const text = [
    typeof error?.stderr === 'string' ? error.stderr : '',
    typeof error?.stdout === 'string' ? error.stdout : '',
    typeof error?.message === 'string' ? error.message : '', output,
  ].join('\n');
  if (error?.code === 'ENOENT') return 'DOWNLOADER_MISSING';
  if (error?.killed && error?.signal) return 'CONVERSION_TIMEOUT';
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'DOWNLOAD_FAILED';
  if (/no such option|unrecognized (?:option|argument)|unsupported Python version/i.test(text)) {
    return 'DOWNLOADER_INCOMPATIBLE';
  }
  if (/age.restrict|confirm your age|age verification/i.test(text)) return 'AGE_RESTRICTED';
  if (/confirm you.?re not a bot|sign in to confirm|login required|sign in to (?:view|watch)|authentication required/i.test(text)) {
    return 'YOUTUBE_SIGN_IN_REQUIRED';
  }
  if (/private video|video (?:is )?unavailable|video (?:has been )?(?:removed|deleted)|not available in your country|geo.restrict/i.test(text)) {
    return 'VIDEO_UNAVAILABLE';
  }
  if (/larger than (?:the )?max.filesize|exceeds? (?:the )?(?:file|size) limit|file is larger than/i.test(text)) {
    return 'FILE_TOO_LARGE';
  }
  if (/does not pass (?:the )?filter|rejected by (?:the )?filter/i.test(text)) return 'VIDEO_FILTERED';
  if (/ffmpeg.*(?:not found|not installed)|ffprobe.*(?:not found|not installed)|postprocessing:|error (?:while )?opening (?:input|output)/i.test(text)) {
    return 'FFMPEG_FAILED';
  }
  if (/requested format (?:is )?not available|no video formats found|only images are available/i.test(text)) {
    return 'FORMAT_UNAVAILABLE';
  }
  if (/HTTP (?:Error )?429|too many requests/i.test(text)) return 'DOWNLOAD_RATE_LIMITED';
  if (/HTTP (?:Error )?403|403 forbidden/i.test(text)) return 'DOWNLOAD_FORBIDDEN';
  if (/timed? out|timeout|connection (?:reset|refused)|name resolution|certificate verify failed|network is unreachable|ENOTFOUND|ECONNRESET/i.test(text)) {
    return 'NETWORK_FAILED';
  }
  return 'DOWNLOAD_FAILED';
}

export function missingOutputError(output = '') {
  const diagnostic = classifyConversionError(new Error(''), 'download', output);
  return new ConversionError(diagnostic.errorCode === 'DOWNLOAD_FAILED' ? 'OUTPUT_MISSING' : diagnostic.errorCode);
}
