/**
 * Root row of the three-window bundle. The Web client composition serves a
 * browser half only for a Loader row that names a package root, so this row is
 * what delivers `./client` (the four browser halves in one bundle). It
 * registers nothing on the Host; the Host halves are the subpath rows in the
 * same group of `cordis.patch.yml`. Window presets are the patch files in
 * `presets/`.
 * @module @psychiiii/dsh-three-window
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory of the three window preset patch files (`dsh.bundle.patch` lists them). */
export const PRESET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'presets')

/** Cordis plugin name of the root row. */
export const name = 'dsh-three-window'

/** Host half of the root row: carries `./client` and registers nothing. */
export function apply(): void {}
