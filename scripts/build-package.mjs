#!/usr/bin/env node
/**
 * Assemble the distributable `dist/` package and pack it.
 *
 *   node scripts/build-package.mjs
 *
 * Steps run in order and the first failure stops the script:
 *   1. `tsc` then `tsdown` for the seven packages (`packages/personal-web` last:
 *      its bundle inlines the other six from source).
 *   2. Assemble `dist/` from `packages/personal-web`: bundles, declarations,
 *      presets, patch, every package's `src/`, README pair, LICENSE,
 *      and a generated `package.json`.
 *   3. `npm pack --dry-run`: record the file list and reject excluded paths.
 *   4. `npm pack`, unpack the tarball, strip its `package/` prefix, and check
 *      the unpacked tree, including that its `README.md` and `README.zh.md`
 *      are byte-identical to the repository root's (a difference fails the
 *      build and prints the diff).
 *   5. Record sha256 of the tarball and of every packed file.
 *   6. Check that `scripts/install.sh`'s `HOST_FLOOR` equals the checkout
 *      version and that `verified-hosts.json` lists the checkout version and
 *      nothing below the floor; stamp the installer with the plugin version,
 *      the tarball sha256, and the highest verified harness version; check it
 *      with `sh -n`; append the base64 tarball to it, producing the one
 *      Release asset `release/dsh-three-window.sh`.
 *
 * The package version is the `version` of the official checkout's root
 * `package.json`: the plugin version follows the build baseline and is never
 * written by hand. It does not state the supported harness range: that is
 * `HOST_FLOOR` up to the highest version in `verified-hosts.json`.
 *
 * Outputs go to `out/`: `dsh-three-window-<version>.tgz`, its `.sha256`,
 * `pack-dry-run.json`, `files.sha256`, and `release/`: the Release asset
 * `dsh-three-window.sh` (installer plus embedded package; the name is fixed so
 * `releases/latest/download/dsh-three-window.sh` always serves the newest), an
 * identical `install.sh` for local use, the bare `dsh-three-window.tgz` with its
 * `.sha256` for `--from`, and `SHA256SUMS`. `DSH_RELEASE_REVISION=N` (N ≥ 2)
 * names a re-release of the same baseline `-rN` in the tag and title. The
 * baseline must be an rc or stable version, and both READMEs must install
 * from the `latest` URL, so they never name a version. `dist/` and `out/` are rebuilt
 * from scratch on every run. `DSH_REPO_ROOT` names the checkout that supplies
 * `tsdown` and the version (default: the checkout `.harness` points at; see
 * `link-workspace-packages.py`).
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECKOUT = resolve(process.env.DSH_REPO_ROOT ?? join(ROOT, '.harness'))
const PACKAGES = join(ROOT, 'packages')
const COMPOSED_DIR = join(PACKAGES, 'personal-web')
const DIST = join(ROOT, 'dist')
const OUT = join(ROOT, 'out')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const TSDOWN = join(CHECKOUT, 'node_modules', '.bin', 'tsdown')
/** Build order: declarations of the six internal packages feed `personal-web`'s. */
const BUILD_ORDER = [
  'client-ui-workbench', 'client-ui-workspace', 'client-ui-sidebar',
  'personal-hooks', 'personal-review', 'personal-settings', 'personal-web',
]
/** Module-table rows every browser half may require without requesting them. */
const PLATFORM = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
])
/** The only paths the tarball may contain: the plugin itself and its license and introduction. */
const ALLOWED = [
  /^(package\.json|cordis\.patch\.yml|README\.md|README\.zh\.md|LICENSE)$/u,
  /^lib\//u, /^presets\//u, /^src\//u,
]
/** Paths inside the allowed directories that must still never be packed. */
const EXCLUDED = [/(^|\/)tests\//u, /(^|\/)node_modules\//u, /^src\/[^/]+\/README(\.zh)?\.md$/u]
/** Paths the packed tarball must contain. */
const REQUIRED = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'README.md', 'README.zh.md', 'LICENSE']
/** Documents the tarball must carry byte-identical to the repository root, so a build never ships a README older than the repository's. */
const ROOT_DOCS = ['README.md', 'README.zh.md']

function step(title) {
  process.stdout.write(`\n== ${title}\n`)
}

function fail(message) {
  process.stderr.write(`build-package: ${message}\n`)
  process.exit(1)
}

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    fail(`${[command, ...args].join(' ')} failed in ${relative(ROOT, cwd) || '.'}:\n${error.stdout ?? ''}${error.stderr ?? ''}`)
  }
}

/**
 * Semver precedence of two versions: -1, 0, or 1. Same rules as `semver_order`
 * in `scripts/install.sh`, which stamps and compares the same values.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function semverOrder(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(v)
    if (!m) fail(`${v} is not a semver version`)
    return { core: [+m[1], +m[2], +m[3]], pre: m[4] === undefined ? [] : m[4].split('.') }
  }
  const x = parse(a), y = parse(b)
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return Math.sign(x.core[i] - y.core[i])
  // A release outranks any prerelease of the same core.
  if (!x.pre.length || !y.pre.length) return Math.sign(y.pre.length - x.pre.length)
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i]
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    if (p === q) continue
    const np = /^\d+$/u.test(p), nq = /^\d+$/u.test(q)
    if (np && nq) return Math.sign(+p - +q)
    if (np !== nq) return np ? -1 : 1
    return p < q ? -1 : 1
  }
  return 0
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function walk(dir, base = dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(path, base))
    else files.push(relative(base, path).split(sep).join('/'))
  }
  return files.sort()
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

// ── 1. compile ────────────────────────────────────────────────────────────────
step('1. tsc + tsdown')
if (!existsSync(TSDOWN)) fail(`${TSDOWN} is missing; set DSH_REPO_ROOT to a built checkout`)
for (const name of BUILD_ORDER) {
  const dir = join(PACKAGES, name)
  rmSync(join(dir, 'lib'), { recursive: true, force: true })
  run(process.execPath, [TSC, '-p', 'tsconfig.json'], dir)
  if (existsSync(join(dir, 'tsdown.config.ts'))) run(TSDOWN, [], dir)
  process.stdout.write(`ok ${name}\n`)
}

// ── 2. assemble dist/ ─────────────────────────────────────────────────────────
step('2. assemble dist/')
rmSync(DIST, { recursive: true, force: true })
mkdirSync(join(DIST, 'lib'), { recursive: true })
const composedLib = join(COMPOSED_DIR, 'lib')
const source = readJson(join(COMPOSED_DIR, 'package.json'))
const baselineVersion = readJson(join(CHECKOUT, 'package.json')).version
if (typeof baselineVersion !== 'string' || baselineVersion === '') fail(`${join(CHECKOUT, 'package.json')} has no version`)
// The plugin follows official dsh rc and stable releases only; an alpha baseline
// would put an alpha version on a public Release.
if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-rc\.[0-9]+)?$/u.test(baselineVersion)) {
  fail(`build checkout version ${baselineVersion} is not an rc or stable release; build against an official rc or stable tag`)
}
// A second or later Release of one baseline takes `-rN`: a published Release's
// asset is never replaced, so one download URL always yields the same bytes.
const revision = process.env.DSH_RELEASE_REVISION ?? ''
if (revision !== '' && !/^[2-9]$|^[1-9][0-9]+$/u.test(revision)) fail(`DSH_RELEASE_REVISION is ${revision}; it must be 2 or higher`)
const releaseVersion = revision === '' ? baselineVersion : `${baselineVersion}-r${revision}`
// One fixed asset name: `releases/latest/download/<name>` then always serves
// the newest Release, so the README's install lines never change and running
// them again is how a user updates. The version lives in the tag and title.
const releaseAsset = 'dsh-three-window.sh'
const LATEST_URL = 'https://github.com/psychiiii/dsh-three-window/releases/latest/download/dsh-three-window.sh'
for (const doc of ['README.md', 'README.zh.md']) {
  const text = readFileSync(join(ROOT, doc), 'utf8')
  if (!text.includes(LATEST_URL)) fail(`${doc} does not install from ${LATEST_URL}`)
  if (/releases\/download\/v[0-9]/u.test(text)) fail(`${doc} names a fixed Release; install from the latest URL only`)
}

/** Rewrite one bundle sourcemap so every `sources` entry points inside `dist/`. */
function relocateSourceMap(fromMap, toMap) {
  const map = readJson(fromMap)
  map.sources = map.sources.map((entry) => {
    const absolute = resolve(dirname(fromMap), entry)
    const inPackages = relative(PACKAGES, absolute).split(sep)
    if (inPackages[0] !== '..' && inPackages[1] === 'src') {
      return relative(dirname(toMap), join(DIST, 'src', inPackages[0], ...inPackages.slice(2))).split(sep).join('/')
    }
    // Inlined third-party code: keep a name, not a host path.
    // The label is the path below the last node_modules/ or packages/ segment,
    // so it does not depend on where the checkout lives.
    const label = [`${sep}node_modules${sep}`, `${sep}packages${sep}`]
      .map(marker => absolute.split(marker))
      .find(parts => parts.length > 1)?.at(-1) ?? basename(absolute)
    return `inlined:${label.split(sep).join('/')}`
  })
  // Sources resolve to the packed src/; inlined third-party entries keep a name only.
  delete map.sourcesContent
  writeJson(toMap, map)
}

const CHECKOUT_REAL = realpathSync(CHECKOUT)

/**
 * A region path (relative to the tsdown directory) as a label that does not
 * depend on where this repository or the checkout lives: `dsh/<path>` inside the
 * checkout, `<path>` inside this repository, else the file name.
 */
function locationFreeLabel(path) {
  if (path.startsWith('\0')) return path
  const absolute = resolve(COMPOSED_DIR, path)
  const inCheckout = relative(CHECKOUT_REAL, absolute)
  if (!inCheckout.startsWith('..')) return `dsh/${inCheckout.split(sep).join('/')}`
  const inRepo = relative(ROOT, absolute)
  if (!inRepo.startsWith('..')) return inRepo.split(sep).join('/')
  return basename(absolute)
}

/**
 * Rolldown heads each inlined module with `//#region <path relative to the
 * build directory>`, which names directories outside the package whenever the
 * checkout is not beside this repository. Rewrite each such line in place so the
 * line count, and with it every sourcemap mapping, is unchanged.
 */
function relabelRegions(code) {
  return code.replace(/^(\s*\/\/#region )(.+)$/gmu, (_line, head, path) => `${head}${locationFreeLabel(path)}`)
}

for (const file of walk(composedLib)) {
  if (file.startsWith('types/')) continue
  const from = join(composedLib, file)
  const to = join(DIST, 'lib', file)
  mkdirSync(dirname(to), { recursive: true })
  if (file.endsWith('.js.map')) relocateSourceMap(from, to)
  else if (file.endsWith('.js')) writeFileSync(to, relabelRegions(readFileSync(from, 'utf8')))
}
for (const file of walk(join(composedLib, 'types'))) {
  if (!file.endsWith('.d.ts')) continue
  const to = join(DIST, 'lib', 'types', file)
  mkdirSync(dirname(to), { recursive: true })
  cpSync(join(composedLib, 'types', file), to)
}
for (const name of BUILD_ORDER) cpSync(join(PACKAGES, name, 'src'), join(DIST, 'src', name), { recursive: true })
cpSync(join(COMPOSED_DIR, 'presets'), join(DIST, 'presets'), { recursive: true })
cpSync(join(COMPOSED_DIR, 'cordis.patch.yml'), join(DIST, 'cordis.patch.yml'))
for (const doc of ['README.md', 'README.zh.md', 'LICENSE']) {
  if (existsSync(join(ROOT, doc))) cpSync(join(ROOT, doc), join(DIST, doc))
  else fail(`${doc} does not exist at the repository root`)
}

// File modes follow the source checkout's umask and history; the tarball must not.
for (const file of walk(DIST)) chmodSync(join(DIST, file), 0o644)

// Host peers: every bare package the Host bundles still import at runtime.
const hostImports = new Set()
for (const file of walk(join(DIST, 'lib'))) {
  if (!file.endsWith('.js') || file === 'client.js') continue
  const code = readFileSync(join(DIST, 'lib', file), 'utf8')
  for (const match of code.matchAll(/(?:\bfrom|\bimport)\s*["']([^"'.][^"']*)["']/gu)) {
    const specifier = match[1]
    if (specifier.startsWith('node:')) continue
    hostImports.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])
  }
}
const stray = [...hostImports].filter(name => !name.startsWith('@deepseek-ai/'))
if (stray.length > 0) fail(`Host bundles import non-harness packages that the profile cannot resolve: ${stray.join(', ')}`)
const peers = [...new Set(['@deepseek-ai/cordis', ...hostImports, 'react'])].sort()

const exportsField = Object.fromEntries(Object.entries(source.exports).map(([key, value]) =>
  [key, key === './src/*' ? './src/*' : value]))
writeJson(join(DIST, 'package.json'), {
  name: source.name,
  version: baselineVersion,
  description: source.description,
  type: 'module',
  main: source.main,
  types: source.types,
  exports: exportsField,
  files: ['lib/**', 'src/**', 'presets/**', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE'],
  license: source.license,
  dsh: source.dsh,
  peerDependencies: Object.fromEntries(peers.map(name => [name, '*'])),
  peerDependenciesMeta: Object.fromEntries(peers.map(name => [name, { optional: true }])),
})
const writtenVersion = readJson(join(DIST, 'package.json')).version
if (writtenVersion !== baselineVersion) {
  fail(`dist/package.json version ${writtenVersion} differs from the checkout version ${baselineVersion}`)
}
process.stdout.write(`dist/package.json: version ${writtenVersion} (checkout ${CHECKOUT}), ${peers.length} optional peers, ${source.dsh.client.inject.length} dsh.client.inject rows\n`)

// ── build-time checks on dist/ ────────────────────────────────────────────────
step('checks on dist/')
const distFiles = walk(DIST)
const clientCode = readFileSync(join(DIST, 'lib', 'client.js'), 'utf8')
const loads = clientCode.match(/__ModuleLoader__\.load\(/gu)?.length ?? 0
if (loads !== 1) fail(`lib/client.js registers ${loads} ModuleLoader factories; expected exactly 1`)
const answered = new Set([...PLATFORM, ...source.dsh.client.inject])
// `<package>/client` names the same module-table row as `<package>`.
const unanswered = [...clientCode.matchAll(/\brequire\((["'])([^"']+)\1\)/gu)].map(match => match[2])
  .filter(name => !answered.has(name.endsWith('/client') ? name.slice(0, -'/client'.length) : name))
if (unanswered.length > 0) fail(`lib/client.js requires modules the browser module table does not answer: ${unanswered.join(', ')}`)
for (const file of distFiles.filter(name => name.startsWith('lib/') && name.endsWith('.js') && name !== 'lib/client.js')) {
  const code = readFileSync(join(DIST, file), 'utf8')
  const clientImport = code.match(/["']@deepseek-ai\/[^"']+\/client["']/u)
  if (clientImport !== null) fail(`${file} imports ${clientImport[0]}; a Host bundle must not import a /client entry`)
}
for (const file of distFiles) {
  const text = readFileSync(join(DIST, file), 'utf8')
  for (const pattern of [/["']link:/u, /\/home\/ubuntu\//u]) {
    if (pattern.test(text)) fail(`${file} contains ${pattern}; dist/ must not depend on development links or host paths`)
  }
}
process.stdout.write(`ok: 1 ModuleLoader factory; client requires ⊆ platform ∪ inject; no /client Host import; no link:/host path in ${distFiles.length} files\n`)

// ── 3. pack dry run ───────────────────────────────────────────────────────────
step('3. npm pack --dry-run')
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const dryRun = JSON.parse(run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], DIST))
writeJson(join(OUT, 'pack-dry-run.json'), dryRun)
const packed = dryRun[0].files.map(file => file.path).sort()
const excluded = packed.filter(path => !ALLOWED.some(pattern => pattern.test(path)) || EXCLUDED.some(pattern => pattern.test(path)))
if (excluded.length > 0) fail(`the tarball would contain excluded paths: ${excluded.join(', ')}`)
const missing = REQUIRED.filter(path => !packed.includes(path))
if (missing.length > 0) fail(`the tarball would lack: ${missing.join(', ')}`)
const unlisted = distFiles.filter(path => !packed.includes(path))
if (unlisted.length > 0) fail(`dist/ files npm would not pack: ${unlisted.join(', ')}`)
process.stdout.write(`ok: ${packed.length} files; none excluded; required present\n`)

// ── 4. pack, unpack, check ────────────────────────────────────────────────────
step('4. npm pack + unpack')
const packedName = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', OUT], DIST))[0].filename
const tarball = join(OUT, `dsh-three-window-${baselineVersion}.tgz`)
renameSync(join(OUT, packedName), tarball)
const scratch = mkdtempSync(join(tmpdir(), 'dsh-three-window-unpack-'))
/** Set when a packed README differs; reported after the unpacked copy is removed. */
let docMismatch
try {
  run('tar', ['-xzf', tarball, '-C', scratch], ROOT)
  const top = readdirSync(scratch)
  if (top.length !== 1 || top[0] !== 'package') fail(`tarball top level is ${JSON.stringify(top)}; expected ["package"]`)
  const unpacked = join(scratch, 'package')
  for (const path of ['package.json', 'lib/index.js']) {
    if (!statSync(join(unpacked, path), { throwIfNoEntry: false })?.isFile()) fail(`unpacked tarball lacks ${path}`)
  }
  const unpackedFiles = walk(unpacked)
  if (JSON.stringify(unpackedFiles) !== JSON.stringify(packed)) fail('unpacked file list differs from the dry-run list')
  process.stdout.write(`ok: unpacked under package/, ${unpackedFiles.length} files, matches dry run\n`)
  for (const doc of ROOT_DOCS) {
    const packedDoc = join(unpacked, doc)
    if (Buffer.compare(readFileSync(packedDoc), readFileSync(join(ROOT, doc))) === 0) continue
    try {
      execFileSync('diff', ['-u', join(ROOT, doc), packedDoc], { encoding: 'utf8' })
    } catch (error) {
      // diff exits 1 on a difference; its stdout is the report.
      docMismatch = `the tarball's ${doc} differs from the repository root's ${doc}:\n${error.stdout ?? ''}${error.stderr ?? ''}`
    }
    break
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
if (docMismatch !== undefined) fail(docMismatch)
process.stdout.write(`ok: ${ROOT_DOCS.join(', ')} in the tarball are byte-identical to the repository root\n`)

// ── 5. fingerprints ───────────────────────────────────────────────────────────
step('5. fingerprints')
const tarballHash = sha256(tarball)
writeFileSync(`${tarball}.sha256`, `${tarballHash}  ${relative(OUT, tarball)}\n`)
writeFileSync(join(OUT, 'files.sha256'), packed.map(path => `${sha256(join(DIST, path))}  ${path}`).join('\n') + '\n')
process.stdout.write(`${tarballHash}  ${relative(ROOT, tarball)}\n`)

// ── 6. installer and install set ──────────────────────────────────────────────
step('6. install.sh + install set')
const release = join(OUT, 'release')
mkdirSync(release, { recursive: true })
const installerSource = readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8')
// The policy floor is the verified baseline: a build against any other
// version would ship an installer that admits hosts nobody verified, or refuses
// the one that was.
const hostFloor = installerSource.match(/^HOST_FLOOR='([^']+)'$/mu)?.[1]
if (hostFloor !== baselineVersion) {
  fail(`scripts/install.sh HOST_FLOOR is ${String(hostFloor)} but the build checkout is ${baselineVersion}; set HOST_FLOOR to the baseline when switching it`)
}
// The stamped verified bound is the highest host an acceptance run passed on,
// recorded in `verified-hosts.json`; the baseline is always one of them.
const verifiedHosts = readJson(join(ROOT, 'verified-hosts.json')).hosts
if (!Array.isArray(verifiedHosts) || !verifiedHosts.some(host => host.version === baselineVersion)) {
  fail(`verified-hosts.json does not list the build checkout ${baselineVersion}`)
}
for (const host of verifiedHosts) {
  if (semverOrder(host.version, hostFloor) < 0) fail(`verified-hosts.json lists ${host.version}, below HOST_FLOOR ${hostFloor}`)
}
const verifiedBound = verifiedHosts.map(host => host.version).reduce((a, b) => (semverOrder(a, b) >= 0 ? a : b))
const installer = installerSource
  .replaceAll('@@PLUGIN_VERSION@@', baselineVersion)
  .replaceAll('@@TARBALL_SHA256@@', tarballHash)
  .replaceAll('@@DSH_VERSION@@', verifiedBound)
if (installer.includes('@@')) fail('scripts/install.sh has a placeholder this script does not fill')
const templatePath = join(OUT, 'install.template.sh')
writeFileSync(templatePath, installer)
run('sh', ['-n', templatePath], ROOT)
if (!installer.endsWith('\nexit 0\n')) fail('scripts/install.sh must end with `exit 0`, before the appended package')
// The package follows a marker line as base64 wrapped at 76 columns; the
// installer decodes everything after the last marker.
const payload = readFileSync(tarball).toString('base64').replace(/.{76}/gu, '$&\n')
const bundled = `${installer}__DSH_THREE_WINDOW_PAYLOAD__\n${payload}\n`
const assetPath = join(release, releaseAsset)
writeFileSync(assetPath, bundled, { mode: 0o755 })
writeFileSync(join(release, 'install.sh'), bundled, { mode: 0o755 })
rmSync(templatePath)
cpSync(tarball, join(release, 'dsh-three-window.tgz'))
writeFileSync(join(release, 'dsh-three-window.tgz.sha256'), `${tarballHash}  dsh-three-window.tgz\n`)
const assetHash = sha256(assetPath)
writeFileSync(join(release, 'SHA256SUMS'), `${assetHash}  ${releaseAsset}\n${tarballHash}  dsh-three-window.tgz\n`)
process.stdout.write(`${assetHash}  out/release/${releaseAsset} (embeds tarball ${tarballHash})\n`)
process.stdout.write(`supported hosts: ${hostFloor} (floor) to ${verifiedBound} (verified bound)\n`)
process.stdout.write(`release: tag v${releaseVersion}, title "dsh-three-window ${releaseVersion}", one asset ${releaseAsset}; not a pre-release, marked latest\n`)
