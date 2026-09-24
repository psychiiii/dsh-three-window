import { overlayBundle } from '../../overlay-client-bundle.ts'

// Host-only: the browser half of this overlay lives in `personal-settings`,
// because the Web client composition is built from the Host entry graph and
// this package is an agent-plane row on the review preset.
export default overlayBundle('@psychiiii/dsh-three-window-review', { client: false })
