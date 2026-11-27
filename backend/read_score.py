"""Reads a score PDF (or image) into MusicXML with Audiveris: the ScoreReader Lambda (backend/Dockerfile.scores).

Invoked by score-api.mjs (asynchronously) with {"bucket", "prefix", "pages"}: the upload is <prefix>/input, the
result goes to <prefix>/score.mxl and the outcome to <prefix>/status.json ({"status": "completed", "scores": n} or
{"status": "failed", "message": ...}). pages: which pages to read ("2", "2-3 5"), or all of them. Audiveris exports
nothing when any page cannot be read (a cover, a page of text): those pages are left out and the rest read again.
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import time
import zipfile

import boto3

AUDIVERIS = os.environ.get('AUDIVERIS', '/opt/audiveris/bin/Audiveris')
LARGEST = 40 * 1024 * 1024
# Leaves the Lambda time to report a failure.
TIMEOUT = int(os.environ.get('SCORE_TIMEOUT', '840'))
PAGES = re.compile(r'^\d+(-\d+)?([ ,]+\d+(-\d+)?)*$')
KINDS = {b'%PDF': '.pdf', b'\x89PNG': '.png', b'\xff\xd8\xff': '.jpg'}

s3 = boto3.client('s3')


def kind_of(head):
    return next((suffix for magic, suffix in KINDS.items() if head.startswith(magic)), None)


def run(source, output, sheets, deadline):
    options = ['-sheets', *sheets] if sheets else []
    # Audiveris keeps its settings under HOME; only /tmp is writable in a Lambda.
    environment = {**os.environ, 'HOME': '/tmp', 'JAVA_TOOL_OPTIONS': '-Djava.awt.headless=true'}
    try:
        done = subprocess.run([AUDIVERIS, '-batch', '-export', *options, '-output', output, source],
                              capture_output=True, text=True, env=environment, timeout=max(30, deadline - time.time()))
        return done.returncode, (done.stdout or '') + (done.stderr or '')
    except subprocess.TimeoutExpired as error:
        return -1, f'{error.stdout or ""}{error.stderr or ""}\nTimed out.'


def exported(output):
    found = []
    for folder, _, names in os.walk(output):
        found += [os.path.join(folder, name) for name in names if name.endswith('.mxl')]
    return sorted(found)


def read(source, output, pages):
    """The .mxl files Audiveris exports, and the log of the last run."""
    deadline = time.time() + TIMEOUT
    chosen = pages.split() if pages else None
    code, log = run(source, output, chosen, deadline)
    found = exported(output)
    total = re.search(r'(\d+) sheets? in ', log)
    unread = {int(number) for number in re.findall(r'Sheet \S+#(\d+) flagged as invalid', log)}
    if not found and not chosen and total and 0 < len(unread) < int(total.group(1)):
        sheets = [str(sheet) for sheet in range(1, int(total.group(1)) + 1) if sheet not in unread]
        print(f'Pages {sorted(unread)} have no music; reading {" ".join(sheets)}')
        shutil.rmtree(output, ignore_errors=True)
        code, log = run(source, output, sheets, deadline)
        found = exported(output)
    print(f'Audiveris exit {code}, {len(found)} score(s)')
    return found, log


def plain_musicxml(mxl):
    """The score inside a compressed MusicXML file: the one META-INF/container.xml names, or its first .xml."""
    with zipfile.ZipFile(mxl) as archive:
        names = archive.namelist()
        path = None
        if 'META-INF/container.xml' in names:
            found = re.search(rb'full-path\s*=\s*"([^"]+)"', archive.read('META-INF/container.xml'))
            path = found.group(1).decode() if found else None
        path = path or next(name for name in names if not name.startswith('META-INF/') and name.endswith(('.xml', '.musicxml')))
        return archive.read(path)


def handler(event, context=None):
    bucket, prefix = event['bucket'], event['prefix'].rstrip('/')
    pages = ' '.join(str(event.get('pages') or '').replace(',', ' ').split())

    def report(status):
        s3.put_object(Bucket=bucket, Key=f'{prefix}/status.json', Body=json.dumps(status).encode(),
                      ContentType='application/json')

    work = tempfile.mkdtemp(dir='/tmp')
    try:
        if pages and not PAGES.match(pages):
            return report({'status': 'failed', 'message': 'Pages are numbers and ranges, such as 2 or 2-3.'})
        head = s3.head_object(Bucket=bucket, Key=f'{prefix}/input')
        if head['ContentLength'] > LARGEST:
            return report({'status': 'failed', 'message': 'The file is larger than 40 MB.'})
        body = s3.get_object(Bucket=bucket, Key=f'{prefix}/input')['Body'].read()
        suffix = kind_of(body[:4])
        if not suffix:
            return report({'status': 'failed', 'message': 'Send a PDF, PNG or JPEG score.'})
        source = os.path.join(work, f'score{suffix}')
        with open(source, 'wb') as file:
            file.write(body)
        found, log = read(source, os.path.join(work, 'out'), pages)
        if not found:
            print(log[-3000:])
            return report({'status': 'failed', 'message': 'No music could be read from the file.'})
        # A score Audiveris splits into movements comes back as its first; the page says how many there were.
        with open(found[0], 'rb') as file:
            s3.put_object(Bucket=bucket, Key=f'{prefix}/score.mxl', Body=file.read(),
                          ContentType='application/vnd.recordare.musicxml')
        # The score itself as plain MusicXML too, so a reading can be saved with a song by its id.
        s3.put_object(Bucket=bucket, Key=f'{prefix}/score.musicxml', Body=plain_musicxml(found[0]),
                      ContentType='application/vnd.recordare.musicxml+xml')
        return report({'status': 'completed', 'scores': len(found)})
    except Exception as error:  # Reported to the page, which otherwise waits.
        print(f'Reading the score failed: {error!r}')
        return report({'status': 'failed', 'message': 'Reading the score failed.'})
    finally:
        shutil.rmtree(work, ignore_errors=True)
