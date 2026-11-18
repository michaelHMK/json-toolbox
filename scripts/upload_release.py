#!/usr/bin/env python3
"""Upload missing release assets and verify existing assets before changing the release."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


EMPTY_DIGEST = 'sha256:' + hashlib.sha256(b'').hexdigest()


def empty_workflow_starter(asset):
    # The release job is serialized per release. Its earlier uploads have
    # stopped, but a maintainer could be uploading the same name separately.
    uploader = asset.get('uploader') or {}
    return (asset.get('state') == 'starter' and asset.get('size') == 0
            and asset.get('digest') in (None, '', EMPTY_DIGEST)
            and uploader.get('login') == 'github-actions[bot]')


def upload_release(repo, release_id, tag, paths):
    endpoint = f'repos/{repo}/releases'
    pages = json.loads(subprocess.check_output([
        'gh', 'api', '--paginate', '--slurp', f'{endpoint}/{release_id}/assets',
    ]))
    assets = {asset['name']: asset for page in pages for asset in page}
    missing = []
    abandoned = []
    for path in paths:
        local_digest = 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()
        asset = assets.get(path.name)
        if asset is None:
            missing.append(path)
            continue
        if empty_workflow_starter(asset):
            abandoned.append((path.name, asset['id']))
            missing.append(path)
            continue
        if asset['state'] != 'uploaded':
            raise ValueError(f'{path.name} is unfinished and may be uploading')
        remote_digest = asset.get('digest')
        if not remote_digest:
            # Older GitHub assets may predate the server-provided digest.
            data = subprocess.check_output([
                'gh', 'api', '-H', 'Accept: application/octet-stream', f"{endpoint}/assets/{asset['id']}",
            ])
            remote_digest = 'sha256:' + hashlib.sha256(data).hexdigest()
        if remote_digest != local_digest:
            raise ValueError(f'{path.name} already exists with different content')
        print(f'✓ {path.name} already uploaded')

    # A 502 may leave an empty starter. Recheck its ID after verifying every
    # published asset, so a completed or renamed asset is preserved.
    for name, asset_id in abandoned:
        asset_endpoint = f'{endpoint}/assets/{asset_id}'
        current = json.loads(subprocess.check_output(['gh', 'api', asset_endpoint]))
        if current['name'] != name or not empty_workflow_starter(current):
            raise ValueError(f'{name} changed during verification; retry the upload')
        subprocess.run(['gh', 'api', '--method', 'DELETE', asset_endpoint], check=True)
    if missing:
        subprocess.run(['gh', 'release', 'upload', '--repo', repo, '--', tag, *missing], check=True)


if __name__ == '__main__':
    try:
        upload_release(os.environ['GITHUB_REPOSITORY'], os.environ['RELEASE_ID'],
                       os.environ['GITHUB_REF_NAME'], [Path(arg) for arg in sys.argv[1:]])
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
