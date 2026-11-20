# NERVDOG Harness

在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 上跑起一个**离线**、带 NERVDOG 品牌的版本：网页版（`dsh web`）和 Windows 桌面版。官方源码以子模块引用、钉在校验过的提交上，本仓库不改它；品牌插件在 [nervdog-harness-plugins](https://github.com/Nervdog-Tech/nervdog-harness-plugins)。

```
nervdog-harness/
  deepseek-harness/        官方源码（子模块）
  bin/dsh                  启动脚本（Windows Git Bash / macOS / Linux）
  offline/                 离线补丁和它的校验工具
  desktop/                 桌面版：打包配置模板、打包后换图标
nervdog-harness-plugins/   插件仓库，放在本仓库旁边（换图标要用它的 brand/icons）
```

## 准备

需要 Node.js 24.9 或更新、pnpm、git。

```sh
git clone --recursive https://github.com/Nervdog-Tech/nervdog-harness.git
git clone https://github.com/Nervdog-Tech/nervdog-harness-plugins.git
cd nervdog-harness/deepseek-harness
CI=true pnpm install
pnpm build
```

`CI=true` 让上游的 postinstall 跳过 lefthook：它要改 git 配置装提交钩子，在子模块里会失败，我们也用不到。

## 网页版

```sh
export PATH="<Node 24 目录>:<路径>/nervdog-harness/bin:$PATH"
dsh web
```

`bin/dsh` 每次启动前把 `offline/offline.patch.yml` 和 `~/.dsh/cordis.patch.yml` 逐字节比对，不一致就复制过去（不用符号链接：Windows 没开开发者模式建不了）。`~/.dsh/cordis.patch.yml` 如果不是这份补丁的旧副本，拒绝覆盖。第一次用要在设置的 Models 页配一个模型提供方。

品牌插件：`dsh plugin --profile web add link:<绝对路径>/nervdog-harness-plugins/brand`。

## 离线补丁

家目录补丁对 `~/.dsh` 下所有配置生效（web、headless、sdk、sdk-minimal、acp、desktop），排在配置自己的补丁之后，所以设置页改不回来。

| 功能 | 结果 |
|---|---|
| DeepSeek 官方模型通道（`llm-deepseek`） | 关闭；在 Models 页配别的提供方 |
| 会话遥测、产品埋点 | 关闭 |
| DeepSeek 账号（`deepseek-account`） | 开着，三个地址都是 `https://127.0.0.1:9`：桌面版启动要调它的 `account/state`，接口在、请求出不去 |
| 账号登录界面、账号模型通道、账号通知、飞书联系表单 | 关闭 |
| 旧版 DeepSeek 搜索 | 关闭；网页搜索要在设置里另选提供方 |
| 网页获取 | 本机直连目标站点 |
| 插件安装源 | `http://127.0.0.1:9/`，没有备用源；本地路径安装不受影响 |
| 实验插件 | 不挂载 |

源码里出现的每个外部地址为什么收不到数据，写在 `offline/reviewed-hosts.json`。补丁挡不住 agent 自己跑 `curl` / `git` 之类的命令，要彻底断网用防火墙。

### 升级 DeepSeek Harness

```sh
git -C deepseek-harness fetch origin
git -C deepseek-harness checkout <新提交>
(cd deepseek-harness && CI=true pnpm install && pnpm build)
node offline/check.mjs
git add deepseek-harness && git commit
```

校验通过才提交新的子模块指针。

| 校验报错 | 处理 |
|---|---|
| `patch target "x" exists in no profile` | 上游改名或删了这一行，找到新 id 改补丁 |
| `row "x" mounts <package>` | 会外发的包换了 id 或进了预设，补丁里加一行关掉 |
| `upstream config changed` | 上游改了被替换的那行配置，把新字段并进补丁，再 `node offline/check.mjs --accept` |
| `upstream "web" row changed` | 上游换了搜索 / 获取提供方，审一遍 |
| `unreviewed host` | 源码里出现了新的外部地址，确认它收不到数据后加进 `reviewed-hosts.json` |
| `egress package <package> exists in no package.json` | 会外发的包改名或删了，改 `check.mjs` 的 `EGRESS_PACKAGES` |

抓外连：`node offline/egress-proxy.mjs &`，再用 `HTTPS_PROXY=http://127.0.0.1:18999 HTTP_PROXY=http://127.0.0.1:18999 NO_PROXY= dsh web` 启动；代理拒绝所有请求并打印目标。

## Windows 桌面版

1. `desktop/env.windows.example` 复制成 `deepseek-harness/apps/desktop/.env.windows`。强制更新策略地址必须填，指 `https://127.0.0.1:9`：填官方地址的话，桌面版每 10 分钟匿名查一次 `harness.deepseek.com`，还可能弹窗挡住界面；连不上时程序不挡、按退避重试。
2. 打包（Node 24 排 PATH 最前；Git Bash 里 `C:\Windows\System32` 要排在 `/usr/bin` 前，不然 GNU tar 把 `D:` 当远程主机）：

   ```sh
   cd deepseek-harness/apps/desktop
   pnpm exec tsx scripts/package-target.ts win-x64 --unsigned --dir
   ```

   产物：`deepseek-harness/apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/DeepSeek Harness.exe`（免签名解包目录，没有安装器）。
3. 先退出桌面版（包括托盘），再换图标：`node desktop/brand-exe.mjs`。exe 的图标组（任务栏、窗口、Alt+Tab）、`resources/tray.ico`、`resources/icon.png` 换成 `nervdog-harness-plugins/brand/icons` 里的哈士奇；exe 其他资源（包括 `app.asar` 的完整性校验）原样写回。这些归 Electron 主进程，插件改不了。
4. 先跑一次 `dsh --version`，把最新的离线补丁写进 `~/.dsh`，再开桌面版。
5. 品牌插件在桌面版里装（命令行不允许管理 desktop 配置）：插件 → 添加插件 → 填 `nervdog-harness-plugins/brand` 的绝对路径 → 安装 → 立即启用。

从 VS Code 的终端启动 exe 会继承 `ELECTRON_RUN_AS_NODE=1`，exe 被当成纯 Node 跑（`bad option`）；用 `env -u ELECTRON_RUN_AS_NODE` 启动。双击不受影响。

## License

The code in this repository is licensed under the MIT License, see `LICENSE`. `offline/` also contains material under the MIT License with its own copyright notice, see `offline/LICENSE`. `deepseek-harness/` is a submodule of the official DeepSeek Harness repository and stays under that repository's license. The MIT License does not cover the names, marks and images described below.

## Trademarks and intellectual property

NERVDOG, Nervdog, 紧张狗, Nervdog Tech and NERVDOG Harness, the NERVDOG wordmark, and the husky character together with every icon and image derived from it are trademarks and intellectual property of Shanghai Nervdog Technology Co., Ltd. ("Nervdog Tech"). All rights reserved. Neither this repository nor any license that applies to its code grants a license to them. Do not use, copy, modify or distribute them, or use them in a way that suggests affiliation with or endorsement by Nervdog Tech, without prior written permission.

DeepSeek and DeepSeek Harness are trademarks of their respective owners. This project is not affiliated with or endorsed by them.
