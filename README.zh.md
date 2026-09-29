# dsh-three-window

<p align="center">
  <a href="https://github.com/psychiiii/dsh-three-window"><img src="https://img.shields.io/badge/Workbench-Chat%20%7C%20Construct%20%7C%20Review-orange" alt="Workbench · Chat | Construct | Review"></a>
  <a href="https://github.com/psychiiii/dsh-three-window"><img src="https://img.shields.io/badge/Review-Anonymous%20Multi--Model-red" alt="Anonymous multi-model review"></a>
</p>
<p align="center">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DeepSeek_Harness-plugin-blue" alt="DSH Plugin"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DeepSeek_Harness-web-orange" alt="DSH Web"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DSH%20verified-0.1.7--rc.1%20~%200.2.0--rc.2-blue" alt="DSH verified 0.1.7-rc.1 ~ 0.2.0-rc.2"></a>
</p>
<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green" alt="License MIT"></a>
  <a href="https://github.com/psychiiii/dsh-three-window/releases/latest"><img src="https://img.shields.io/github/v/release/psychiiii/dsh-three-window?label=version&color=9cf" alt="Version"></a>
</p>

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的三窗工作台插件。

## 功能

- **三个窗口并排**，各有分工和默认权限：

  | 窗口 | 用途 | 权限 |
  |---|---|---|
  | 聊天 | 动代码之前先讨论、拆解、定方案 | 只读 |
  | 施工 | 真正改代码 | 可写工作区 |
  | 审核 | 审查改动 | 只读 |

- **按工作区隔离。** 每个工作区有自己的三个窗口和对话记录；切换工作区、刷新页面，都会回到你离开时的位置。
- **每个窗口单独的 hook。** 项目里的 `.dsh/hooks/chat.json`、`construct.json`、`review.json`
  各管一个窗口，`examples/hooks/` 里有现成的示例。
- **匿名多模型评审。** 在审核窗里直接说要评什么，例如「评一下分镜和镜头清单，只看镜头时长」：它先在工作区里
  找到对应的文件，弹出一张确认卡片列出清单（每项为什么选、哪些没纳入及原因）；你点「开始评审」后，每个配置好的
  评审模型各自独立评审、互不知情，最多三轮（某个模型失败时其余继续），最后用大白话告诉你结论、共识、分歧；
  点「换材料或重点」写下想法就会重新挑。原始报告在审核窗里点「查看原始报告」查看。不限于代码：文档、翻译、
  数据、方案、分镜等文本材料都能评，不需要 git；图片、音视频、Office 文件本身不纳入评审。评审模型在
  「评审模型」按钮里配置（一个都没配时审核窗会锁住；只配一个就是普通的单模型评审）；每个工作区一贯的评审口径在
  「评审口径」按钮里设，未单独设置的工作区用「设置 → 窗口与评审」里的默认口径。
- **模型输出语言。** 三个窗口可以分别指定模型回复你时用的语言：点每个窗口右上角的「输出语言：…」直接选，
  或在「设置 → 通用」里改，两处是同一个设置。只约束模型对你说的话，代码、注释和提交信息仍按项目约定。
- **工作区每轮 Prompt。** 左侧工作区名右边的「⋯」→「每轮 Prompt…」：写一段话，它会附在这个工作区每一轮
  消息之后，三个窗口都生效。配置过的工作区名字旁会显示 📌，悬停可预览。只存在本机的 dsh 配置里，不写进项目。

## 安装

需要 dsh `0.1.7-rc.1` 或更新版本（rc 或稳定版），以及 Node `22.19` 以上的 22.x，或 `24` 及以上。

```sh
npm install -g @deepseek-ai/dsh@next    # 已装有 dsh 0.1.7-rc.1 或更新版本可跳过
dsh web                                 # 先启动一次让配置目录生成，然后 Ctrl+C

curl -fsSLO https://github.com/psychiiii/dsh-three-window/releases/latest/download/dsh-three-window.sh
sh dsh-three-window.sh

dsh web
```

安装器是一个文件，插件就在里面；它会先校验 sha256 和你的 dsh 版本，再做任何改动。
在终端里运行时，它先显示检测结果（本安装包版本、你的 dsh 版本、当前已装的版本），再让你选：
`1` 安装或更新，`0` 卸载（会再确认一次），`x` 退出。在脚本里运行（没有终端）时不提问，直接安装。

**更新：把同样的 `curl` 和 `sh` 两行再运行一遍、选 `1` 即可**——它们总是取最新的
[Release](https://github.com/psychiiii/dsh-three-window/releases)；旧版本留下的安装包会顺带清掉。
版本号跟随 dsh 官方 release（只跟 rc 和稳定版）。

<details>
<summary>卸载</summary>

在下载了 `dsh-three-window.sh` 的目录里运行 `sh dsh-three-window.sh` 选 `0`，或者不经菜单直接：

```sh
sh dsh-three-window.sh --uninstall
```

然后重启 `dsh web`，就是原版 dsh。会话、工作区和设置都保留。加 `--check` 只列出要删的内容、不删除；
已经卸载过再运行不会有任何改动。

手动卸载（顺序不能反）：在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 和 `dsh.profile.bundles`
里去掉 `@psychiiii/dsh-three-window`；再删除 `~/.dsh/profiles/web/node_modules/@psychiiii/dsh-three-window`，
最后删除 `~/.dsh/cache/dsh-three-window`。
</details>

<details>
<summary>从源码构建</summary>

需要 `git`、`pnpm`、`python3`。构建要对照官方 `dsh-v0.1.7-rc.1` 源码检出进行：

```sh
git clone --depth 1 --branch dsh-v0.1.7-rc.1 https://github.com/deepseek-ai/deepseek-harness.git ~/src/dsh-0.1.7-rc.1
(cd ~/src/dsh-0.1.7-rc.1 && pnpm install --frozen-lockfile && pnpm run build)
git clone https://github.com/psychiiii/dsh-three-window.git && cd dsh-three-window
python3 link-workspace-packages.py --checkout ~/src/dsh-0.1.7-rc.1
node scripts/build-package.mjs
sh out/release/dsh-three-window.sh
```
</details>

## 许可证

MIT
