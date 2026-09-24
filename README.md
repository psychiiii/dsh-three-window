# dsh-three-window

English | [中文](README.zh.md)

A three-window workbench plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

## Features

- **Three windows side by side**, each with its own job and default permission:

  | Window | For | Permission |
  |---|---|---|
  | Chat | Discuss and plan before touching code | read-only |
  | Construct | Change code | workspace-write |
  | Review | Review a change | read-only |

- **Per workspace.** Every workspace keeps its own three windows and their
  history; switching workspaces and reloading the page bring you back where you were.
- **Per-window hooks.** `.dsh/hooks/chat.json`, `construct.json`, and `review.json`
  in your project apply to one window each. Ready-made examples are in
  `examples/hooks/`.
- **Anonymous multi-model review.** The review window runs every configured
  reviewer model on the same change, blind to each other, and returns one report
  with the verdict, all findings, and the ones only a single model raised.
  Reviewer models are set in Settings → 窗口与评审.

## Install

Requires dsh `0.1.7-rc.1` or newer (rc or stable) and Node `22.19`+ (22.x) or `24`+.

```sh
npm install -g @deepseek-ai/dsh@next    # skip if you already have dsh 0.1.7-rc.1 or newer
dsh web                                 # start once so its profile exists, then Ctrl+C

curl -fsSLO https://github.com/psychiiii/dsh-three-window/releases/latest/download/dsh-three-window.sh
sh dsh-three-window.sh

dsh web
```

The installer is one file with the plugin inside it; it checks its sha256 and your
dsh version before changing anything.

**To update, run the same `curl` and `sh` lines again** — they always fetch the
newest [Release](https://github.com/psychiiii/dsh-three-window/releases), and
running them when you are already up to date changes nothing. Release versions
follow official dsh releases (rc and stable only).

<details>
<summary>Uninstall</summary>

In `~/.dsh/profiles/web/package.json`, remove `@psychiiii/dsh-three-window` from
`dependencies` and from `dsh.profile.bundles`; then delete
`~/.dsh/profiles/web/node_modules/@psychiiii/dsh-three-window` and, last,
`~/.dsh/cache/dsh-three-window`.
</details>

<details>
<summary>Build from source</summary>

Needs `git`, `pnpm`, and `python3`. The build compiles against the official
`dsh-v0.1.7-rc.1` source checkout:

```sh
git clone --depth 1 --branch dsh-v0.1.7-rc.1 https://github.com/deepseek-ai/deepseek-harness.git ~/src/dsh-0.1.7-rc.1
(cd ~/src/dsh-0.1.7-rc.1 && pnpm install --frozen-lockfile && pnpm run build)
git clone https://github.com/psychiiii/dsh-three-window.git && cd dsh-three-window
python3 link-workspace-packages.py --checkout ~/src/dsh-0.1.7-rc.1
node scripts/build-package.mjs
sh out/release/dsh-three-window-*.sh
```
</details>

## License

MIT
