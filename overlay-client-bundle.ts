/**
 * Standalone client-bundle tsdown presets for overlay packages that are not
 * workspace members (the official clientBundle helper scans packages glob).
 * {@link overlayBundle} builds one internal package; {@link composedBundle}
 * builds the distributed package, which inlines every internal package from
 * source.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'

/** Repository root: the directory of this file. */
const HERE = dirname(fileURLToPath(import.meta.url))

const PLATFORM = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

const requested = new Set<string>(PLATFORM)

/**
 * The module-table row a specifier names: `<package>/client` and `<package>`
 * are the same row, as in the official module table's specifier normalization.
 * @param specifier - module specifier as source or a bundle spells it.
 * @returns the row name.
 */
function moduleRow(specifier: string): string {
  return specifier.endsWith('/client') ? specifier.slice(0, -'/client'.length) : specifier
}

/** The rolldown plugin hooks these presets use. */
interface BundlePlugin {
  readonly name: string
  readonly enforce?: 'pre'
  resolveId?: (source: string, importer: string | undefined) => string | null
  generateBundle?: (
    this: { error: (message: string) => never },
    options: unknown,
    bundle: Record<string, { type: string; fileName: string; code?: string }>,
  ) => void
}

/** What {@link overlayBundle} builds for one package. */
export interface OverlayBundleOptions {
  /**
   * Whether the package has a browser half at `src/client/index.ts`. A
   * host-only package passes `false`; tsdown fails on a missing entry, so this
   * is not something the builder can detect for itself.
   */
  readonly client?: boolean
}

/**
 * Host library plus browser ModuleLoader factory for one overlay package.
 * @param id - package name stamped into the factory.
 * @param options - whether to build the browser half.
 * @returns tsdown configs.
 */
export function overlayBundle(id: string, options: OverlayBundleOptions = {}): UserConfig[] {
  const host: UserConfig = {
    name: id,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: false,
    sourcemap: true,
    clean: false,
    inputOptions: {
      external: (source: string) => source.startsWith('@deepseek-ai/') || source.startsWith('node:') || source === 'zod',
    },
    outputOptions: {
      entryFileNames: 'index.js',
    },
  }
  const client = clientConfig(id, requested, [])
  return options.client === false ? [host] : [host, client]
}

/**
 * Browser ModuleLoader factory config for one package.
 * @param id - package name stamped into the factory.
 * @param external - module specifiers left to the browser module table.
 * @param extraPlugins - plugins that run before CSS Modules inlining.
 * @returns the tsdown config.
 */
function clientConfig(id: string, external: ReadonlySet<string>, extraPlugins: readonly BundlePlugin[]): UserConfig {
  return {
    name: `${id}/client`,
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: (specifier: string) => external.has(moduleRow(specifier)),
      alwaysBundle: (specifier: string) => !external.has(moduleRow(specifier)),
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'process.env.DSH_CLIENT_VERSION': 'undefined',
      'process.env.DSH_CLIENT_COMMIT_HASH': 'undefined',
      'process.env.DSH_CLIENT_GIT_DIRTY': 'undefined',
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    plugins: [...extraPlugins as never[], {
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined
          ? new URL(source, `file://${importer}`).pathname
          : source
        // Repository-relative, so no host path reaches the output's region comments.
        return CSS_VIRTUAL_PREFIX + relative(HERE, abs) + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = resolve(HERE, virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length))
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          // Class-name hashes derive from this name; relative keeps them independent of the checkout location.
          filename: relative(HERE, fileId),
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        // lightningcss returns exports in no stable order; sorting keeps the bundle byte-reproducible.
        for (const [local, exp] of Object.entries(cssExports ?? {}).sort(([a], [b]) => a.localeCompare(b))) classMap[local] = exp.name
        return styleInjectionModule(id, fileId, code.toString(), classMap)
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: () => `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}


/**
 * Resolve this repository's own package specifiers to source through
 * `tsconfig.overlay-paths.json`. Without it the build
 * would follow each package's `exports` to its built `lib/`, and the browser
 * build would inline four already-wrapped ModuleLoader factories.
 * @returns the rolldown plugin.
 */
export function overlaySourceAlias(): BundlePlugin {
  const map = JSON.parse(readFileSync(resolve(HERE, 'tsconfig.overlay-paths.json'), 'utf8')) as {
    compilerOptions: { paths: Record<string, string[]> }
  }
  const paths = new Map(Object.entries(map.compilerOptions.paths).map(([key, targets]) => {
    const target = targets[0]
    if (target === undefined) throw new Error(`tsconfig.overlay-paths.json: ${key} has no target`)
    return [key, resolve(HERE, target)] as const
  }))
  return {
    name: 'dsh-overlay-source-alias',
    enforce: 'pre',
    resolveId(source) {
      return source.startsWith('@psychiiii/') ? paths.get(source) ?? null : null
    },
  }
}

/**
 * `@deepseek-ai/*` value imports a browser bundle may inline because they carry
 * no shared runtime identity. Mirrors the official `INLINE_SAFE` and
 * `VENDORED_LIBRARY` rules, plus `@deepseek-ai/dsh-hook-protocol`, whose
 * `matcherDiagnostic` the settings half inlines; the `require` gate below
 * rejects any Node module that inlining would pull in.
 */
const INLINE_SAFE = /^(?:@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|deque|output-retention|typert-protocol|util-crypto|util-values|util-workspace-path|hook-protocol)(?:\/|$)|@deepseek-ai\/(?:cosmokit|schemastery)(?:\/|$))/

/**
 * Build-time mirror of the browser module table: every `@deepseek-ai/*` value
 * import is either left to the table (`external`) or inline-safe, and every
 * `require()` left in the output names a module the table answers.
 * @param id - package name used in diagnostics.
 * @param external - module specifiers the table answers for this package.
 * @returns the rolldown plugin.
 */
function clientBundleGates(id: string, external: ReadonlySet<string>): BundlePlugin {
  return {
    name: 'dsh-overlay-client-gates',
    resolveId(source) {
      if (!source.startsWith('@deepseek-ai/') || external.has(moduleRow(source)) || INLINE_SAFE.test(source)) return null
      throw new Error(
        `client bundle purity: ${id} imports "${source}", which is neither a module-table row it requests `
        + 'nor an inline-safe library',
      )
    },
    generateBundle(_options, bundle) {
      const unanswered = new Set<string>()
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk' || chunk.code === undefined) continue
        for (const match of chunk.code.matchAll(/\brequire\((["'])([^"']+)\1\)/gu)) {
          const specifier = match[2]
          if (specifier !== undefined && !external.has(moduleRow(specifier))) unanswered.add(`${chunk.fileName}: ${specifier}`)
        }
      }
      if (unanswered.size > 0) {
        this.error(`client bundle ${id} requires modules the browser module table does not answer: ${[...unanswered].join(', ')}`)
      }
    },
  }
}

/** What {@link composedBundle} builds. */
export interface ComposedBundleOptions {
  /** Host entry name (output `lib/<name>.js`) to source path. */
  readonly host: Readonly<Record<string, string>>
  /** Module-table rows the browser half requests (`dsh.client.inject`). */
  readonly inject: readonly string[]
}

/**
 * Host entries plus one browser ModuleLoader factory for the distributed
 * package. Internal packages are inlined from source; on the Host every
 * `@deepseek-ai/*` import stays external, and in the browser only the platform
 * modules and `inject` rows do.
 * @param id - package name stamped into the factory.
 * @param options - Host entries and requested module-table rows.
 * @returns tsdown configs.
 */
export function composedBundle(id: string, options: ComposedBundleOptions): UserConfig[] {
  const hostExternal = (specifier: string): boolean => specifier.startsWith('@deepseek-ai/') || specifier.startsWith('node:')
  const host: UserConfig = {
    name: id,
    entry: { ...options.host },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: hostExternal,
      alwaysBundle: (specifier: string) => !hostExternal(specifier),
    },
    plugins: [overlaySourceAlias() as never],
    outputOptions: {
      entryFileNames: '[name].js',
      chunkFileNames: 'chunks/[name]-[hash].js',
    },
  }
  const external = new Set<string>([...PLATFORM, ...options.inject])
  const client = clientConfig(id, external, [overlaySourceAlias(), clientBundleGates(id, external)])
  return [host, client]
}
