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
- **Anonymous multi-model review.** Tell the review window what to review, e.g.
  “review the storyboard and the shot list, only the shot lengths”: it finds the
  files in the workspace and asks you in a confirmation card listing each item,
  why it was picked, and what was left out and why. Choose “start” and every
  configured reviewer model reviews it on its own, blind to the others, for at
  most three rounds (if one fails, the others go on), and you get the conclusion,
  the agreed findings, and the disagreements in plain words; choose “change” and
  say what you want instead. The original report opens from the review window. Not only code: documents,
  translations, data, plans, storyboards and other text work, with or without git;
  images, audio, video and Office files themselves are not reviewed. Reviewer
  models are set with the “Review models” button (the window stays locked until
  one is set; a single one runs an ordinary single-model review); each workspace's
  standing guidance is set with “Review guidance”, and workspaces without their own
  use the default in Settings → Windows & review.
- **Model output language.** Each window can have its own language for the
  model's answers to you: pick it from “输出语言：…” at the top right of the
  window, or in Settings → General (the same setting). It governs only what the
  model says to you: code, comments, and commit messages keep following the project.
- **Per-workspace turn prompt.** In the workspace list, ⋯ → “Turn prompt…” sets a
  text that is appended after every message in that workspace, in all three
  windows. A 📌 beside the name marks a workspace that has one and previews it on
  hover. It is stored only in this machine's dsh settings, never in the project.

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
dsh version before changing anything. Run in a terminal, it first shows what it
found (this package, your dsh, what is installed) and asks: `1` install or
update, `0` uninstall (confirmed once more), `x` quit. Run from a script (no
terminal), it installs without asking.

**To update, run the same `curl` and `sh` lines again and choose `1`** — they
always fetch the newest [Release](https://github.com/psychiiii/dsh-three-window/releases),
and the earlier version's cached package is cleared on the way. Release versions
follow official dsh releases (rc and stable only).

<details>
<summary>Uninstall</summary>

From the folder that holds the downloaded `dsh-three-window.sh`, run
`sh dsh-three-window.sh` and choose `0`, or skip the menu:

```sh
sh dsh-three-window.sh --uninstall
```

Then restart `dsh web`: it starts as plain dsh. Sessions, workspaces, and
settings stay. `--uninstall --check` lists what would be removed without
removing it; running it again when nothing is installed changes nothing.

By hand, in this order: in `~/.dsh/profiles/web/package.json`, remove
`@psychiiii/dsh-three-window` from `dependencies` and from `dsh.profile.bundles`;
then delete `~/.dsh/profiles/web/node_modules/@psychiiii/dsh-three-window` and,
last, `~/.dsh/cache/dsh-three-window`.
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
sh out/release/dsh-three-window.sh
```
</details>

## License

MIT
