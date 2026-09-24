#!/usr/bin/env python3
"""Symlink a built harness checkout's packages into this overlay's node_modules.

    python3 link-workspace-packages.py --checkout /path/to/deepseek-harness
    python3 link-workspace-packages.py            # relink against the current .harness

`.harness` (gitignored) is the one pointer to the checkout: the tsconfig path
map and the build script read it. Passing
`--checkout` moves it and records the target it replaced in `.harness-previous`,
so `--checkout "$(cat .harness-previous)"` switches back. Every run clears the
`@deepseek-ai` links first, so a package the new checkout lacks cannot keep
resolving from the old one.
"""
from pathlib import Path
import argparse
import json
import os
import shutil
import sys

here = Path(__file__).resolve().parent
pointer = here / '.harness'
parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
parser.add_argument('--checkout', help='built harness checkout to link against')
args = parser.parse_args()
if args.checkout is not None:
    target = Path(args.checkout).resolve()
    if not (target / 'package.json').is_file() or not (target / 'tsconfig.base.json').is_file():
        sys.exit(f'link-workspace-packages: {target} is not a harness checkout (no package.json / tsconfig.base.json)')
    if pointer.is_symlink():
        previous = os.readlink(pointer)
        if Path(previous).resolve() != target:
            (here / '.harness-previous').write_text(previous + '\n')
        pointer.unlink()
    elif pointer.exists():
        sys.exit(f'link-workspace-packages: {pointer} exists and is not a symlink')
    pointer.symlink_to(target)
if not pointer.is_symlink():
    sys.exit('link-workspace-packages: no .harness pointer yet; run once with --checkout /path/to/a/built/harness/checkout')
root = pointer.resolve()
print(f'link-workspace-packages: linking against {root} (version {json.loads((root / "package.json").read_text()).get("version")})')
nm = here / 'node_modules'
scoped = nm / '@deepseek-ai'
types = nm / '@types'
shutil.rmtree(scoped, ignore_errors=True)
scoped.mkdir(parents=True, exist_ok=True)
types.mkdir(exist_ok=True)

def link(name: str, target: Path) -> None:
    dest = nm.joinpath(*name.split('/')) if name.startswith('@') else nm / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_symlink() or dest.exists():
        dest.unlink()
    dest.symlink_to(os.path.relpath(target.resolve(), dest.parent))

overlay = Path(__file__).resolve().parent / 'packages'
for pkg in overlay.glob('*/package.json'):
    data = json.loads(pkg.read_text())
    name = data.get('name')
    # Every package here, whatever scope it publishes under; the filter is the
    # directory, not the name.
    if isinstance(name, str):
        link(name, pkg.parent)

for pkg in (root / 'packages').glob('*/*/package.json'):
    data = json.loads(pkg.read_text())
    name = data.get('name')
    if isinstance(name, str) and name.startswith('@deepseek-ai/'):
        link(name, pkg.parent)

for pkg in (root / 'vendor').glob('*/package.json'):
    data = json.loads(pkg.read_text())
    name = data.get('name')
    if isinstance(name, str):
        link(name, pkg.parent)

conv = root / 'packages/client/ui-conversation/node_modules'
for name in ['react', 'react-dom']:
    target = conv / name
    if target.exists():
        link(name, target)
clsx = root / 'packages/client/ui-sidebar/node_modules/clsx'
if clsx.exists():
    link('clsx', clsx)
types_src = conv / '@types'
if types_src.exists():
    for child in types_src.iterdir():
        link(f'@types/{child.name}', child)

node_types = root / 'node_modules/@types/node'
if node_types.exists():
    link('@types/node', node_types)

# Node-side tooling. The specs used to run from inside the checkout, where these
# resolved through its root node_modules; now that this directory sits beside the
# checkout they must be linked explicitly or the test config cannot load.
for name in [
    # The CSS Modules compiler overlay-client-bundle.ts imports for every tsdown build.
    'lightningcss',
    'typescript',
    'vitest',
    'vite',
    'vite-tsconfig-paths',
    '@testing-library/react',
    '@testing-library/dom',
]:
    target = root / 'node_modules' / name
    if target.exists():
        link(name, target)
zod = root / 'packages/todo/tool-todo/node_modules/zod'
if not zod.exists():
    matches = list((root / 'node_modules' / '.pnpm').glob('zod@*/node_modules/zod'))
    zod = matches[0] if matches else None
if zod is not None and zod.exists():
    link('zod', zod)
