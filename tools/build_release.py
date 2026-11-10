#!/usr/bin/env python3
"""Build a documentation-free Foundry module ZIP and, for GitHub releases, a URL-aware manifest."""
import argparse
import json
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent.parent
RUNTIME_DIRS = ('scripts', 'styles', 'lang')


def build(out: Path, repo: str | None = None, tag: str | None = None):
    manifest = json.loads((ROOT/'module.json').read_text(encoding='utf-8'))
    if bool(repo) != bool(tag):
        raise ValueError('Both --repo and --tag must be supplied together')
    if repo:
        if '/' not in repo or not tag.startswith('v'):
            raise ValueError('Expected --repo owner/repo and --tag vX.Y.Z')
        if tag[1:] != manifest['version']:
            raise ValueError(f'Tag {tag} does not match module version {manifest["version"]}')
        manifest['url'] = f'https://github.com/{repo}'
        manifest['manifest'] = f'https://github.com/{repo}/releases/latest/download/module.json'
        manifest['download'] = f'https://github.com/{repo}/releases/download/{tag}/module.zip'
    out.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(manifest, ensure_ascii=False, indent=2).encode('utf-8') + b'\n'
    (out/'module.json').write_bytes(raw)
    with ZipFile(out/'module.zip', 'w', ZIP_DEFLATED) as archive:
        archive.writestr('module.json', raw)
        for folder in RUNTIME_DIRS:
            for path in sorted((ROOT/folder).rglob('*')):
                if path.is_file() and path.suffix in {'.mjs', '.js', '.css', '.json'}:
                    archive.write(path, path.relative_to(ROOT).as_posix())
    return manifest

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', help='GitHub owner/repository')
    parser.add_argument('--tag', help='Git release tag v0.1.0')
    parser.add_argument('--out', type=Path, default=ROOT/'dist')
    options = parser.parse_args()
    result = build(options.out, options.repo, options.tag)
    print(f'Built {result["id"]} v{result["version"]} -> {options.out}')
