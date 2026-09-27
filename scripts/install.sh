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
#
# Run in a terminal with no --install, --uninstall, or --check, it first shows
# what it found (this package, the host, what is installed) and asks: 1 install
# or update, 0 uninstall (after a y/N confirmation), x quit. Without a terminal,
# or with one of those options, it runs without asking, as before.
#
# --uninstall removes the plugin from that profile instead: its registration,
# its installed copy, and then the cache/dsh-three-window directory, in that
# order. Sessions, Workspaces, and settings are dsh's own data and stay. It
# needs no package and no supported host, so any build's installer removes any
# build.
set -eu

PACKAGE_NAME='@psychiiii/dsh-three-window'
PLUGIN_VERSION='@@PLUGIN_VERSION@@'
RELEASE_VERSION='@@RELEASE_VERSION@@'
TARBALL_SHA256='@@TARBALL_SHA256@@'
TESTED_DSH_VERSION='@@DSH_VERSION@@'
HOST_FLOOR='0.1.7-rc.1'

HOME_DIR="${DSH_HOME:-${HOME}/.dsh}"
PROFILE='web'
FROM=''
DSH_BIN=''
ALLOW_UNSUPPORTED=0
CHECK=0
UNINSTALL=0
INSTALL=0

say() { printf 'dsh-three-window: %s\n' "$*"; }

usage() {
  cat <<'USAGE'
dsh-three-window installer

  curl -fsSLO https://github.com/psychiiii/dsh-three-window/releases/latest/download/dsh-three-window.sh
  sh dsh-three-window.sh [options]

Running the same two lines again updates to the newest Release. In a terminal,
with none of --install, --uninstall, --check, it asks what to do.

Options:
  --home DIR                 harness home (default: $DSH_HOME, else ~/.dsh)
  --profile NAME             profile to install into (default: web)
  --from URL|PATH            tarball to install (default: the package embedded in this file)
  --dsh PATH                 dsh executable whose version is checked (default: dsh on PATH)
  --allow-unsupported-host   install even when the host is below the supported floor
  --install                  install or update without asking (the default without a terminal)
  --uninstall                remove the plugin from the profile (sessions and settings stay)
  --check                    run every check and write nothing (with --uninstall: list what would go)
  -h, --help                 print this text

Installs one dsh-three-window tarball into one profile of one harness home,
writing only under that home. The tarball must match the sha256 this installer
was built with. Restart 'dsh web' after installing or uninstalling.
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
    --uninstall) UNINSTALL=1; shift ;;
    --install) INSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ $((INSTALL + UNINSTALL)) -le 1 ] || die '--install and --uninstall exclude each other'
# Ask only when a person is there to answer and no action was named.
MENU=0
if [ "$INSTALL" -eq 0 ] && [ "$UNINSTALL" -eq 0 ] && [ "$CHECK" -eq 0 ] && [ -t 0 ] && [ -t 1 ]; then
  MENU=1
fi

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
[ -n "$DSH_BIN" ] || DSH_BIN="$(command -v dsh 2>/dev/null || true)"

# ── host version (read only; the guard below acts on it) ──────────────────────
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

# ── menu (a terminal, no action named) ────────────────────────────────────────
# installed_state prints "<build>|<release>|<registered>|<present>": the build
# the manifest's file: spec names, the installed copy's release label, and
# whether the manifest names the package and the copy exists (1 or 0).
installed_state() {
  node -e '
    const fs = require("node:fs"), path = require("node:path")
    const [manifestPath, installedDir, name] = process.argv.slice(1)
    let spec = "", registered = 0
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      spec = manifest.dependencies?.[name] ?? ""
      registered = spec !== "" || (manifest.dsh?.profile?.bundles ?? []).includes(name) ? 1 : 0
    } catch {}
    const build = /dsh-three-window-(.+)\.tgz$/.exec(spec)?.[1] ?? ""
    let release = "", present = 0
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(installedDir, "package.json"), "utf8"))
      present = 1
      release = pkg.dshThreeWindow?.release ?? pkg.version ?? ""
    } catch {}
    process.stdout.write([build, release, registered, present].join("|"))
  ' "$MANIFEST" "$INSTALLED_DIR" "$PACKAGE_NAME"
}
if [ "$MENU" -eq 1 ]; then
  printf '\ndsh-three-window 安装器\n'
  printf '  本安装包：%s（构建 %s）\n' "$RELEASE_VERSION" "$(printf '%s' "$TARBALL_SHA256" | cut -c1-12)"
  CAN_INSTALL=1
  if [ "$HOST_ORDER" = invalid ] || [ "$HOST_ORDER" = -1 ]; then
    printf '  dsh：%s，不支持（需要 %s 或更新的 rc）\n' "${HOST_VERSION:-未找到}" "$HOST_FLOOR"
    CAN_INSTALL=0
  else
    printf '  dsh：%s（%s），支持\n' "$HOST_VERSION" "$DSH_BIN"
  fi
  printf '  位置：%s，profile %s\n' "$HOME_DIR" "$PROFILE"
  if [ ! -f "$MANIFEST" ]; then
    printf '  当前：profile 还没有初始化（先运行一次 dsh web）\n'
    CAN_INSTALL=0
    STATE='|||'
  else
    STATE="$(installed_state)"
  fi
  S_BUILD="${STATE%%|*}"; REST="${STATE#*|}"
  S_RELEASE="${REST%%|*}"; REST="${REST#*|}"
  S_REGISTERED="${REST%%|*}"; S_PRESENT="${REST#*|}"
  INSTALL_LABEL='安装'
  CAN_UNINSTALL=0
  if [ -f "$MANIFEST" ]; then
    if [ "$S_REGISTERED" = 1 ] || [ "$S_PRESENT" = 1 ] || [ -e "$CACHE_DIR" ]; then CAN_UNINSTALL=1; fi
    if [ "$S_REGISTERED" = 1 ] && [ "$S_PRESENT" = 1 ]; then
      S_SHA="$(printf '%s' "$S_BUILD" | sed 's/.*-//')"
      printf '  当前已装：%s（构建 %s）\n' "${S_RELEASE:-未知版本}" "${S_SHA:-未知}"
      if [ "$S_BUILD" = "$BUILD_ID" ]; then
        INSTALL_LABEL="重新安装（已是 $RELEASE_VERSION）"
      else
        INSTALL_LABEL="更新到 $RELEASE_VERSION"
      fi
    elif [ "$S_REGISTERED" = 1 ] || [ "$S_PRESENT" = 1 ]; then
      printf '  当前：安装不完整（登记与文件不一致），选 1 修复\n'
      INSTALL_LABEL="修复安装 $RELEASE_VERSION"
    else
      printf '  当前：未安装\n'
    fi
  fi
  printf '\n'
  if [ "$CAN_INSTALL" -eq 1 ]; then printf '  [1] %s\n' "$INSTALL_LABEL"; else printf '  [1] %s（不可用，见上）\n' "$INSTALL_LABEL"; fi
  if [ "$CAN_UNINSTALL" -eq 1 ]; then printf '  [0] 卸载\n'; else printf '  [0] 卸载（未安装，不可用）\n'; fi
  printf '  [x] 退出\n'
  while :; do
    printf '请选择 [1/0/x]: '
    if ! IFS= read -r CHOICE; then printf '\n'; say 'no answer: nothing was changed'; exit 0; fi
    case "$CHOICE" in
      1) [ "$CAN_INSTALL" -eq 1 ] && { INSTALL=1; break; }; printf '  现在不能安装，原因见上。\n' ;;
      0) [ "$CAN_UNINSTALL" -eq 1 ] && { UNINSTALL=1; break; }; printf '  没有可卸载的内容。\n' ;;
      x|X|q|Q) say 'quit: nothing was changed'; exit 0 ;;
      *) printf '  请输入 1、0 或 x。\n' ;;
    esac
  done
fi
# ── uninstall ─────────────────────────────────────────────────────────────────
if [ "$UNINSTALL" -eq 1 ]; then
  [ -z "$FROM" ] || die '--uninstall takes no --from'
  [ -f "$MANIFEST" ] || die "profile '$PROFILE' is not initialized at $PROFILE_DIR; nothing to uninstall (pass --home/--profile for another one)"
  # registered_in prints where the manifest still names the package: "dependencies", "bundles", both, or nothing.
  registered_in() {
    node -e '
      const fs = require("node:fs")
      const [manifestPath, name] = process.argv.slice(1)
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      const places = []
      if (Object.hasOwn(manifest.dependencies ?? {}, name)) places.push("dependencies")
      if ((manifest.dsh?.profile?.bundles ?? []).includes(name)) places.push("bundles")
      process.stdout.write(places.join(" "))
    ' "$MANIFEST" "$PACKAGE_NAME"
  }
  REGISTERED="$(registered_in)"
  if [ -z "$REGISTERED" ] && [ ! -e "$INSTALLED_DIR" ] && [ ! -e "$CACHE_DIR" ]; then
    say "not installed in profile '$PROFILE' of $HOME_DIR: nothing to do"
    exit 0
  fi
  if command -v pnpm >/dev/null 2>&1 && [ -n "$DSH_BIN" ] && [ -n "$REGISTERED" ]; then
    UROUTE='pnpm'
  else
    UROUTE='copy'
  fi
  say "uninstalling from home $HOME_DIR, profile $PROFILE"
  [ -z "$REGISTERED" ] || say "1. remove $PACKAGE_NAME from $REGISTERED in $MANIFEST"
  [ ! -e "$INSTALLED_DIR" ] || say "2. delete $INSTALLED_DIR"
  [ ! -e "$CACHE_DIR" ] || say "3. delete $CACHE_DIR"
  if [ "$UROUTE" = pnpm ]; then
    say "route: pnpm found — step 1 and 2 through '$DSH_BIN plugin --profile $PROFILE remove $PACKAGE_NAME'"
  else
    say 'route: edit the manifest and delete the directories directly'
  fi
  say 'sessions, workspaces, and settings are dsh data and stay'
  if [ "$CHECK" -eq 1 ]; then
    say 'check only: nothing was removed'
    exit 0
  fi
  if [ "$MENU" -eq 1 ]; then
    printf '确认卸载？会话、工作区和设置都保留。[y/N]: '
    IFS= read -r CONFIRM || CONFIRM=''
    case "$CONFIRM" in
      y|Y|yes|YES) ;;
      *) say 'cancelled: nothing was removed'; exit 0 ;;
    esac
  fi
  # A running dsh web keeps what it loaded until it restarts; it holds no lock to tell by, so this only warns.
  if ps -eo args 2>/dev/null | grep -E '(^|/)dsh(\.js)?( .*)? web( |$)|bin\.js( .*)? web( |$)' | grep -v grep >/dev/null 2>&1; then
    say "note: a 'dsh web' process is running; restart it after this to load dsh without the plugin"
  fi
  # Step 1 first: a profile that still names file:<cache>/… fails its next pnpm install once the cache is gone.
  if [ "$UROUTE" = pnpm ]; then
    DSH_HOME="$HOME_DIR" "$DSH_BIN" plugin --profile "$PROFILE" remove "$PACKAGE_NAME" \
      || die "'dsh plugin remove' failed; nothing under $CACHE_DIR was deleted"
  fi
  if [ -n "$(registered_in)" ]; then
    node -e '
      const fs = require("node:fs")
      const [manifestPath, name] = process.argv.slice(1)
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
      if (manifest.dependencies) delete manifest.dependencies[name]
      if (manifest.dsh?.profile?.bundles) manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(b => b !== name)
      const temp = manifestPath + ".dsh-three-window.tmp"
      fs.writeFileSync(temp, JSON.stringify(manifest, null, 2) + "\n")
      fs.renameSync(temp, manifestPath)
    ' "$MANIFEST" "$PACKAGE_NAME"
  fi
  [ -z "$(registered_in)" ] || die "$MANIFEST still names $PACKAGE_NAME; nothing under $CACHE_DIR was deleted"
  rm -rf "$INSTALLED_DIR"
  rm -rf "$CACHE_DIR"
  say "uninstalled. Restart 'dsh web' for the profile '$PROFILE'; it starts without the plugin."
  say 'to install again, run dsh-three-window.sh without --uninstall'
  exit 0
fi

# ── host version guard ────────────────────────────────────────────────────────
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

# ── drop other builds from the cache ──────────────────────────────────────────
# Only now that this build is registered; a build any profile of this home
# still names (its manifest or lockfile) stays, or that profile's next pnpm
# install would fail.
for ENTRY in "$CACHE_DIR"/*; do
  [ -e "$ENTRY" ] || continue
  BASE="$(basename "$ENTRY")"
  case "$BASE" in
    "$BUILD_ID"|"dsh-three-window-$BUILD_ID.tgz") continue ;;
  esac
  OTHER="${BASE#dsh-three-window-}"; OTHER="${OTHER%.tgz}"
  if grep -rqsF "dsh-three-window-$OTHER.tgz" "$HOME_DIR"/profiles/*/package.json "$HOME_DIR"/profiles/*/pnpm-lock.yaml 2>/dev/null; then
    say "kept $ENTRY: a profile still names it"
    continue
  fi
  rm -rf "$ENTRY"
  say "removed an earlier build from the cache: $BASE"
done

# ── done ──────────────────────────────────────────────────────────────────────
say "installed through the $ROUTE route. Restart 'dsh web' for the profile '$PROFILE' to load it."
cat <<EOF
dsh-three-window: to uninstall: sh dsh-three-window.sh --uninstall$( [ "$HOME_DIR" = "${DSH_HOME:-${HOME}/.dsh}" ] || printf ' --home %s' "$HOME_DIR" )$( [ "$PROFILE" = web ] || printf ' --profile %s' "$PROFILE" )
  (by hand, in this order: 1. remove "$PACKAGE_NAME" from "dependencies" and from
   "dsh.profile.bundles" in $MANIFEST; 2. delete $INSTALLED_DIR;
   3. only then delete $CACHE_DIR)
EOF
# Nothing below this line is shell: the build appends the package here.
exit 0
