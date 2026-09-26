# dsh-three-window

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
- **匿名多模型评审。** 审核窗让每个配置好的评审模型各自独立审同一份改动、互不知情，
  最后给出一份报告：结论、全部问题，以及只有单个模型提出的问题。评审模型在审核窗的「评审模型」按钮里配置
  （一个都没配时审核窗会锁住）；只配一个就是一次普通的单模型评审。评审视角在「设置 → 窗口与评审」里改。
- **模型输出语言。** 三个窗口可以分别指定模型回复你时用的语言（设置 → 通用，第一次进入时也会问一次），
  只约束模型对你说的话，代码、注释和提交信息仍按项目约定。
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

**更新：把同样的 `curl` 和 `sh` 两行再运行一遍即可**——它们总是取最新的
[Release](https://github.com/psychiiii/dsh-three-window/releases)；已经是最新版时再运行也不会有任何改动。
版本号跟随 dsh 官方 release（只跟 rc 和稳定版）。

<details>
<summary>卸载</summary>

在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里去掉
`@psychiiii/dsh-three-window`；再删除 `~/.dsh/profiles/web/node_modules/@psychiiii/dsh-three-window`，
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
