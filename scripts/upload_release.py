#!/usr/bin/env python3
"""Upload missing release assets and verify existing assets before changing the release."""

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


def upload_release(repo, release_id, tag, paths):
    endpoint = f'repos/{repo}/releases'
    pages = json.loads(subprocess.check_output([
        'gh', 'api', '--paginate', '--slurp', f'{endpoint}/{release_id}/assets',
    ]))
    assets = {asset['name']: asset for page in pages for asset in page}
    missing = []
    for path in paths:
        local_digest = 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()
        asset = assets.get(path.name)
        if asset is None:
            missing.append(path)
            continue
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

    if missing:
        subprocess.run(['gh', 'release', 'upload', '--repo', repo, '--', tag, *missing], check=True)


if __name__ == '__main__':
    try:
        upload_release(os.environ['GITHUB_REPOSITORY'], os.environ['RELEASE_ID'],
                       os.environ['GITHUB_REF_NAME'], [Path(arg) for arg in sys.argv[1:]])
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
