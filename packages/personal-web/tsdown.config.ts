import { readFileSync } from 'node:fs'
import { composedBundle } from '../../overlay-client-bundle.ts'

const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
  name: string
  dsh: { client: { inject: string[] } }
}

// One Host entry per Loader row name in cordis.patch.yml and the presets;
// `index` is the package-root row that carries the browser half.
export default composedBundle(manifest.name, {
  host: {
    index: 'src/index.ts',
    workbench: 'src/workbench.ts',
    sidebar: 'src/sidebar.ts',
    workspace: 'src/workspace.ts',
    hooks: 'src/hooks.ts',
    settings: 'src/settings.ts',
    review: 'src/review.ts',
    'tool-deny': 'src/tool-deny.ts',
    'permission-lock': 'src/permission-lock.ts',
  },
  inject: manifest.dsh.client.inject,
})
