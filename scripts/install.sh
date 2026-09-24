#!/bin/sh
# dsh-three-window installer. scripts/build-package.mjs stamps this template and
# appends the package to it, producing one self-contained file per Release,
# dsh-three-window.sh. Download it, then run it: a `curl … | sh`
# pipeline has no file to read the package from, and hands `sh` empty input
# when the download fails.
#
# Installs one dsh-three-window tarball into one profile of one harness home.
# It writes only under that home: the tarball and its unpacked copy under
# cache/dsh-three-window/, and the profile's package.json and node_modules/.
# It never creates a profile, never uses sudo, and never touches the dsh
# installation itself. Running it again with the same tarball changes nothing.
#
# The package must match TARBALL_SHA256 below, the hash of the tarball this
# script was built with. By default it is the copy embedded after the
# PAYLOAD marker at the end of this file; --from names a tarball instead, which
# must also match the .sha256 file beside it.
#
# The host must be dsh HOST_FLOOR or a later release (semver order, so
# 0.1.7-alpha.9 < 0.1.7-rc.1 < 0.1.7). The version is read from the package.json
# of the package that owns the dsh executable (--dsh, else `dsh` on PATH); an
# unreadable version is refused. --allow-unsupported-host installs anyway.
set -eu

PACKAGE_NAME='@psychiiii/dsh-three-window'
PLUGIN_VERSION='@@PLUGIN_VERSION@@'
TARBALL_SHA256='@@TARBALL_SHA256@@'
TESTED_DSH_VERSION='@@DSH_VERSION@@'
HOST_FLOOR='0.1.7-rc.1'

HOME_DIR="${DSH_HOME:-${HOME}/.dsh}"
PROFILE='web'
FROM=''
DSH_BIN=''
ALLOW_UNSUPPORTED=0
CHECK=0

say() { printf 'dsh-three-window: %s\n' "$*"; }

usage() {
  cat <<'USAGE'
dsh-three-window installer

  curl -fsSLO https://github.com/psychiiii/dsh-three-window/releases/latest/download/dsh-three-window.sh
  sh dsh-three-window.sh [options]

Running the same two lines again updates to the newest Release.

Options:
  --home DIR                 harness home (default: $DSH_HOME, else ~/.dsh)
  --profile NAME             profile to install into (default: web)
  --from URL|PATH            tarball to install (default: the package embedded in this file)
  --dsh PATH                 dsh executable whose version is checked (default: dsh on PATH)
  --allow-unsupported-host   install even when the host is below the supported floor
  --check                    run every check and write nothing
  -h, --help                 print this text

Installs one dsh-three-window tarball into one profile of one harness home,
writing only under that home. The tarball must match the sha256 this installer
was built with.
USAGE
}
die() { printf 'dsh-three-window: error: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --home) [ $# -ge 2 ] || die '--home needs a directory'; HOME_DIR="$2"; shift 2 ;;
    --profile) [ $# -ge 2 ] || die '--profile needs a name'; PROFILE="$2"; shift 2 ;;
    --from) [ $# -ge 2 ] || die '--from needs a URL or path'; FROM="$2"; shift 2 ;;
    --dsh) [ $# -ge 2 ] || die '--dsh needs the path of the dsh executable'; DSH_BIN="$2"; shift 2 ;;
    --allow-unsupported-host) ALLOW_UNSUPPORTED=1; shift ;;
    --check) CHECK=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

PROFILE_DIR="$HOME_DIR/profiles/$PROFILE"
MANIFEST="$PROFILE_DIR/package.json"
CACHE_DIR="$HOME_DIR/cache/dsh-three-window"
# Keyed by the tarball hash: two builds of one version are different tarballs,
# and each keeps its own cached copy.
BUILD_ID="$PLUGIN_VERSION-$(printf '%s' "$TARBALL_SHA256" | cut -c1-12)"
TARBALL="$CACHE_DIR/dsh-three-window-$BUILD_ID.tgz"
STABLE_DIR="$CACHE_DIR/$BUILD_ID"
INSTALLED_DIR="$PROFILE_DIR/node_modules/$PACKAGE_NAME"

# ── preflight (no writes) ─────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die 'node is not on PATH'
node -e '
  const [major, minor] = process.versions.node.split(".").map(Number)
  if (!((major === 22 && minor >= 19) || major >= 24)) {
    console.error("dsh-three-window: error: Node " + process.versions.node + " does not satisfy ^22.19.0 || >=24.0.0")
    process.exit(1)
  }
' || exit 1
# ── host version guard ────────────────────────────────────────────────────────
[ -n "$DSH_BIN" ] || DSH_BIN="$(command -v dsh 2>/dev/null || true)"
HOST_VERSION=''
if [ -n "$DSH_BIN" ]; then
  HOST_VERSION="$(node -e '
    const fs = require("node:fs"), path = require("node:path")
    let dir
    try { dir = path.dirname(fs.realpathSync(process.argv[1])) } catch { process.exit(0) }
    for (;;) {
      const manifest = path.join(dir, "package.json")
      if (fs.existsSync(manifest)) {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"))
        if (pkg.name === "@deepseek-ai/dsh" && typeof pkg.version === "string") { process.stdout.write(pkg.version); process.exit(0) }
      }
      const parent = path.dirname(dir)
      if (parent === dir) process.exit(0)
      dir = parent
    }
  ' "$DSH_BIN")"
fi

# semver_order A B prints -1, 0, or 1 in semver precedence; "invalid" when either does not parse.
semver_order() {
  node -e '
    const parse = (v) => {
      const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v)
      return m && { core: [+m[1], +m[2], +m[3]], pre: m[4] === undefined ? [] : m[4].split(".") }
    }
    const done = (n) => { process.stdout.write(String(Math.sign(n))); process.exit(0) }
    const a = parse(process.argv[1]), b = parse(process.argv[2])
    if (!a || !b) { process.stdout.write("invalid"); process.exit(0) }
    for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) done(a.core[i] - b.core[i])
    // A release outranks any prerelease of the same core.
    if (!a.pre.length || !b.pre.length) done(b.pre.length - a.pre.length)
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
      const x = a.pre[i], y = b.pre[i]
      if (x === undefined || y === undefined) done(x === undefined ? -1 : 1)
      if (x === y) continue
      const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
      if (nx && ny) done(+x - +y)
      if (nx !== ny) done(nx ? -1 : 1)
      done(x < y ? -1 : 1)
    }
    done(0)
  ' "$1" "$2"
}

HOST_ORDER='invalid'
[ -n "$HOST_VERSION" ] && HOST_ORDER="$(semver_order "$HOST_VERSION" "$HOST_FLOOR")"
if [ "$HOST_ORDER" = invalid ] || [ "$HOST_ORDER" = -1 ]; then
  cat >&2 <<GUARD
dsh-three-window 需要 $HOST_FLOOR 或更新的 rc。
检测到 ${HOST_VERSION:-未知版本（找不到 dsh 可执行文件或其 package.json；用 --dsh 指向 dsh 可执行文件）}。
- 用 npx @deepseek-ai/dsh@$HOST_FLOOR web 启动一次，再用 --dsh 指向该版本的 dsh（或把它放到 PATH 上）重跑本脚本。
- 0.1.5.x 上本插件的三窗不可用（原因见 README）。
想强行安装可加 --allow-unsupported-host（不保证可用）。
GUARD
  [ "$ALLOW_UNSUPPORTED" -eq 1 ] || exit 1
  say '--allow-unsupported-host: continuing on an unsupported host'
else
  say "host dsh $HOST_VERSION ($DSH_BIN) meets the floor $HOST_FLOOR"
  if [ "$(semver_order "$HOST_VERSION" "$TESTED_DSH_VERSION")" = 1 ]; then
    say "本构建的验证上限是 $TESTED_DSH_VERSION，你的是 $HOST_VERSION"
  fi
fi

[ -f "$MANIFEST" ] || die "profile '$PROFILE' is not initialized at $PROFILE_DIR; run 'dsh web' once (or pass --home/--profile) and retry"

if command -v sha256sum >/dev/null 2>&1; then
  sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die 'neither sha256sum nor shasum is on PATH'
fi

# The pnpm route runs the official 'dsh plugin add', so it needs both pnpm and dsh.
if command -v pnpm >/dev/null 2>&1 && [ -n "$DSH_BIN" ]; then
  ROUTE='pnpm'
else
  ROUTE='copy'
fi

say "plugin $PLUGIN_VERSION ($BUILD_ID), verified up to dsh $TESTED_DSH_VERSION; host dsh: ${HOST_VERSION:-unknown}"
say "home $HOME_DIR, profile $PROFILE"
say "source ${FROM:-the package embedded in this installer}"
if [ "$ROUTE" = pnpm ]; then
  say "route: pnpm found — will register with '$DSH_BIN plugin --profile $PROFILE add'"
else
  say "route: pnpm not found — will copy into $INSTALLED_DIR and edit $MANIFEST"
fi

if [ "$CHECK" -eq 1 ]; then
  say 'check only: nothing was written'
  exit 0
fi

# ── fetch and verify ──────────────────────────────────────────────────────────
fetch() {
  case "$1" in
    http://*|https://*)
      if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
      elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
      else die 'neither curl nor wget is on PATH'; fi ;;
    *) cp "$1" "$2" ;;
  esac
}

mkdir -p "$CACHE_DIR"
WORK="$(mktemp -d "$CACHE_DIR/.incoming.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT INT TERM

if [ -z "$FROM" ]; then
  # The package follows the PAYLOAD marker as base64. Node decodes it: it is
  # already required, and base64(1) spells its decode flag differently per OS.
  node -e '
    const fs = require("node:fs")
    const [script, out] = process.argv.slice(1)
    const text = fs.readFileSync(script, "latin1")
    const marker = "\n__DSH_THREE_WINDOW_" + "PAYLOAD__\n"
    const at = text.lastIndexOf(marker)
    if (at < 0) process.exit(3)
    fs.writeFileSync(out, Buffer.from(text.slice(at + marker.length), "base64"))
  ' "$0" "$WORK/package.tgz" \
    || die "$0 carries no package: download dsh-three-window.sh and run the file itself, or pass --from"
  ACTUAL="$(sha256_of "$WORK/package.tgz")"
else
  fetch "$FROM" "$WORK/package.tgz" || die "cannot fetch $FROM"
  fetch "$FROM.sha256" "$WORK/package.tgz.sha256" || die "cannot fetch $FROM.sha256"
  ACTUAL="$(sha256_of "$WORK/package.tgz")"
  PUBLISHED="$(cut -d' ' -f1 < "$WORK/package.tgz.sha256")"
  [ "$ACTUAL" = "$PUBLISHED" ] || die "sha256 mismatch: tarball $ACTUAL, $FROM.sha256 says $PUBLISHED"
fi
[ "$ACTUAL" = "$TARBALL_SHA256" ] || die "sha256 mismatch: package $ACTUAL, this installer was built for $TARBALL_SHA256"
say "sha256 ok: $ACTUAL"

# The tarball stays in the cache: the profile names it (file:), and a later
# 'pnpm install' fails when a dependency points at a deleted path.
if [ ! -f "$TARBALL" ] || [ "$(sha256_of "$TARBALL")" != "$ACTUAL" ]; then
  mv "$WORK/package.tgz" "$TARBALL"
fi

# ── unpack into a stable directory ────────────────────────────────────────────
if [ -d "$STABLE_DIR" ]; then
  [ "$(cat "$STABLE_DIR/.tarball-sha256" 2>/dev/null || true)" = "$ACTUAL" ] \
    || die "$STABLE_DIR exists but was unpacked from a different tarball; remove it and retry"
  say "unpacked copy already present: $STABLE_DIR"
else
  mkdir "$WORK/unpack"
  tar -xzf "$TARBALL" -C "$WORK/unpack"
  # npm pack puts every file under package/; the stable directory is that directory.
  [ -f "$WORK/unpack/package/package.json" ] || die 'tarball has no package/package.json'
  [ -f "$WORK/unpack/package/lib/index.js" ] || die 'tarball has no package/lib/index.js'
  printf '%s\n' "$ACTUAL" > "$WORK/unpack/package/.tarball-sha256"
  mv "$WORK/unpack/package" "$STABLE_DIR"
  say "unpacked: $STABLE_DIR"
fi

# ── register ──────────────────────────────────────────────────────────────────
if [ "$ROUTE" = pnpm ]; then
  # The tarball, not the unpacked directory: a directory spec becomes a link:
  # dependency, a symlink whose real path under cache/ has no node_modules
  # above it, so the Host halves cannot resolve @deepseek-ai/* from there.
  say "registering with: $DSH_BIN plugin --profile $PROFILE add $TARBALL"
  DSH_HOME="$HOME_DIR" "$DSH_BIN" plugin --profile "$PROFILE" add "$TARBALL"
else
  mkdir -p "$(dirname "$INSTALLED_DIR")"
  rm -rf "$WORK/copy"
  cp -R "$STABLE_DIR" "$WORK/copy"
  rm -f "$WORK/copy/.tarball-sha256"
  rm -rf "$INSTALLED_DIR"
  mv "$WORK/copy" "$INSTALLED_DIR"
  node -e '
    const fs = require("node:fs")
    const [manifestPath, name, spec] = process.argv.slice(1)
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    manifest.dependencies = { ...(manifest.dependencies ?? {}), [name]: spec }
    manifest.dsh ??= {}
    manifest.dsh.profile ??= {}
    const bundles = manifest.dsh.profile.bundles ?? []
    if (!bundles.includes(name)) bundles.push(name)
    manifest.dsh.profile.bundles = bundles
    const next = JSON.stringify(manifest, null, 2) + "\n"
    const temp = manifestPath + ".dsh-three-window.tmp"
    fs.writeFileSync(temp, next)
    fs.renameSync(temp, manifestPath)
  ' "$MANIFEST" "$PACKAGE_NAME" "file:$TARBALL"
  say "copied into $INSTALLED_DIR and added $PACKAGE_NAME to dependencies and dsh.profile.bundles"
fi

# ── done ──────────────────────────────────────────────────────────────────────
say "installed through the $ROUTE route. Restart 'dsh web' for the profile '$PROFILE' to load it."
cat <<EOF
dsh-three-window: to uninstall, in this order:
  1. remove "$PACKAGE_NAME" from "dependencies" and from "dsh.profile.bundles" in
     $MANIFEST
  2. delete $INSTALLED_DIR
  3. only then delete $CACHE_DIR
     (step 1 first: a profile that still names file:$TARBALL fails its next pnpm install)
EOF
# Nothing below this line is shell: the build appends the package here.
exit 0
