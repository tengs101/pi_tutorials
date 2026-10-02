# pi_tutorials

Pi（[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)）的**项目级配置样例与踩坑文档**仓库。

一句话：这里沉淀"怎么把 Pi 配得顺手"的可复用实践——项目级扩展、技能、提示词模板、主题，以及在本机真实环境里踩过的坑与完整修复记录。

---

## 这个仓库是什么

| 是 | 不是 |
|---|---|
| Pi 的**项目级 `.pi/` 配置样例**（可直接抄走） | Pi 本身的源码或发行版 |
| 两个**可用的自定义扩展**实现（PowerShell 工具 / 按需禁用 bash） | npm 上的 Pi 包（那些装在 `.pi/npm/`，不进版本控制） |
| **项目级技能**与提示词模板 | 通用 AI 教程合集（内容全部围绕 Pi） |
| **环境级故障诊断文档**（代理、性能） | 生产项目代码 |

---

## 目录结构

```
pi_tutorials/
├── AGENTS.md                                  # 项目协作约定（中文、改文件前先列范围）
├── README.md                                  # 本文件
├── .pi/                                       # Pi 项目级配置（Pi 在该目录启动时自动生效）
│   ├── settings.json                          #   项目级设置：packages / skills / extensions / themes
│   ├── agents/                                #   项目级子代理定义（当前为空）
│   ├── extensions/
│   │   ├── disable-bash.ts                    #   仅移除内置 bash，保留其余（含扩展）工具
│   │   └── tool-powershell/
│   │       ├── index.ts                       #   `powershell` 工具注册与激活管理
│   │       └── powershell.ts                  #   工具实现（自包含，896 行）
│   ├── prompts/
│   │   └── assess-change.md                   #   `/assess-change` 评估工作区变更
│   ├── skills/
│   │   ├── create-pi-extensions/SKILL.md      #   创建 Pi 扩展（539 行，仅手动触发）
│   │   └── read-pi-readme/SKILL.md            #   查 Pi 官方文档并给结论（仅手动触发）
│   ├── themes/
│   │   └── pi_theme_ts.json                   #   自定义主题 `pi_theme_ts`
│   └── npm/                                   #   项目级 npm 包（pi 包依赖）
│       ├── package.json                       #   依赖清单
│       └── .gitignore                         #   内容为 `*` + `!.gitignore` → 排除整个目录
└── docs/
    ├── clash全局模式导致pi连接超时-诊断报告.md     # 代理导致 pi 请求劣化 60 倍的完整诊断
    └── bilibili-persona-安装与踩坑.md            # 把 ZCode 插件移植成 Pi skill 的过程与 4 处补丁
```

### 为什么 `.pi/npm/` 只有两个文件

`.pi/npm/.gitignore` 的内容是 `*` 加 `!.gitignore`——**整个目录默认被排除**。这是刻意的：该目录下 `node_modules` 约 **67 MB / 12000+ 文件**，不应进版本控制。于是：

- `package-lock.json`（3014 行）与 `node_modules/` **不入库**；
- 仓库里只保留依赖清单 `package.json` 与那条忽略规则。

`package.json` 当前声明的项目级包：

| 包 | 版本 | 备注 |
|---|---|---|
| `pi-subagents` | ^0.74.0 | 项目级已启用（扩展 + 技能 + 7 个提示词） |
| `pi-web-access` | ^0.35.0 | 项目级已启用 |
| `pi-open-tui` | ^0.3.10 | 项目级已启用 |
| `@haispeed/pi-obsidian` | ^0.1.1 | **冗余依赖**：装了但未写入项目级 `packages`，其扩展/技能由用户级设置启用 |

---

## 快速开始

```powershell
git clone https://github.com/tengs101/pi_tutorials.git
cd pi_tutorials

pi                # 首次进入需信任项目级文件，按提示授权，或用 pi --approve
pi config         # 可选：TUI 里按需启用/禁用包提供的资源（Tab 切换作用域）
```

依赖：Node.js + npm 版 Pi。仓库里的扩展是 TypeScript，由 Pi 直接加载，无需单独构建。

**编辑后生效**：扩展 / 技能 / 提示词改动后，在会话里执行 `/reload`。

---

## 组件详解

### 1) `.pi/settings.json` —— 项目级设置

| 键 | 内容 | 作用 |
|---|---|---|
| `packages` | `pi-open-tui`、`pi-subagents`、`pi-web-access` | 以包为单位加载资源（可分别指定扩展 / 技能 / 提示词） |
| `skills` | `chrome-devtools`、`chrome-devtools-cli` | 显式包含用户级技能（含 `+` 精确包含写法） |
| `extensions` | `copy-no-newline.ts` + `builtin:codemode`、`builtin:llama.cpp`、`builtin:mcp`、`builtin:tool-search` | 用户级扩展 + 内置扩展开关 |
| `themes` | 空 | 主题走 `.pi/themes/` 的约定目录自动发现 |

`pi-subagents` 一项同时挂载了扩展、1 个技能与 **7 个提示词模板**（`/parallel-review`、`/review-loop`、`/parallel-research`、`/parallel-cleanup`、`/parallel-context-build`、`/parallel-handoff-plan`、`/gather-context-and-clarify`）。

> ⚠️ **这份文件里有本机绝对路径**（`C:\Users\<user>\.pi\agent\...`）。换机器使用前必须改掉，否则对应资源加载失败。

### 2) 扩展

| 扩展 | 作用 | 关键实现细节 |
|---|---|---|
| `extensions/disable-bash.ts`（29 行） | **只**禁用内置 `bash`，其余工具（含所有扩展注册的工具）保持不动 | 必须在 `session_start` 里调用 `setActiveTools`；**旧版用白名单写法会把所有扩展工具一起隐藏**，文件头保留了这段修复记录 |
| `extensions/tool-powershell/`（65 + 896 行） | 注册并默认激活 `powershell` 工具，支持 `command`（stdin 内联）与 `file`（`-File script.ps1`）两种模式 | 实现**自包含**，不 import Pi 内部模块，以便跨 Pi 版本升级保持稳定；在 `session_start` 与 `before_agent_start` 双重确保激活，防止被其他扩展的白名单覆盖 |

这两个扩展是一对：`disable-bash` 移掉 bash、`tool-powershell` 补上 Windows 下更合适的等价工具。

### 3) 技能（均为手动触发）

| 技能 | 用途 | 触发 |
|---|---|---|
| `create-pi-extensions`（539 行） | 创建 Pi 扩展：完整 `ExtensionAPI` 接口、编程规范、安全清单、调试技巧、依赖管理、固定输出模板 | `/skill:create-pi-extensions`（`disable-model-invocation: true`，不自动加载） |
| `read-pi-readme`（30 行） | 阅读 Pi 的 README 并给结论；按其中的链接继续查 `docs/` | `/skill:read-pi-readme` |

### 4) 提示词模板

- `assess-change` → `/assess-change`：评估当前工作区变更，输出「改了什么 / 影响范围 / 风险点」。

### 5) 主题

- `pi_theme_ts.json`：自定义主题，`vars` + `colors` 结构，名字为 `pi_theme_ts`。

---

## 项目级 vs 用户级：最容易踩的坑

同一个技能在**不同目录下可见性可能不同**，原因是资源数组支持三种前缀：

| 写法 | 含义 |
|---|---|
| `!pattern` | glob 排除 |
| `+path` | 精确包含 |
| `-path` | **精确排除** |

实测案例：用户级 `settings.json` 里写了 `-skills\chrome-devtools\SKILL.md`（**排除**），而本项目 `settings.json` 又用 `+C:\Users\...\chrome-devtools\SKILL.md`（**加回**）。结果同一台机器上：

- 在本项目里 → `chrome-devtools` 可用；
- 在别的目录（无项目级配置）→ **不可用**。

**排查"技能装了却看不见"时，先看用户级与项目级两处设置的前缀。** 相关细节另见 [`docs/bilibili-persona-安装与踩坑.md`](docs/bilibili-persona-安装与踩坑.md) 的安装验证一节。

---

## 本机环境注意事项

以下都是在本机实际踩到并已确诊的问题，**换机器前请先核对是否适用**：

| 现象 | 根因 | 处理 |
|---|---|---|
| pi 频繁 `Connection error.` / `Request timed out.`，单次调用从 ~1s 劣化到 **57s** | Clash 处于**全局模式** + 用户级 `HTTP_PROXY/HTTPS_PROXY` 环境变量，使国内模型请求被绕道境外节点 | 切到「规则」模式，或给国内域名设 `NO_PROXY` → 详见 [诊断报告](docs/clash全局模式导致pi连接超时-诊断报告.md) |
| 命令行访问国内站点返回 **412**，浏览器却正常 | 同上：共享代理出口 IP 被风控；浏览器因系统代理关闭而直连 | 同上 |
| 本地语音转写很慢（约 2.1× 实时） | 本机**无独立 GPU**，`faster-whisper` 自动退回 **CPU + int8 + small** 模型 | 属设计行为；不要显式指定 `--cpu-threads` → 详见 [bilibili-persona 文档](docs/bilibili-persona-安装与踩坑.md) |
| 可用内存紧张（约 3 GB） | 长音频转写需注意不要与其他重任务并行 | 串行处理 |

---

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/clash全局模式导致pi连接超时-诊断报告.md`](docs/clash全局模式导致pi连接超时-诊断报告.md) | 完整排查路径（含走过的弯路）、量化证据表、复现与判定命令、3 种修法 |
| [`docs/bilibili-persona-安装与踩坑.md`](docs/bilibili-persona-安装与踩坑.md) | ZCode 插件 → Pi skill 的移植步骤、4 处脚本补丁与验收、无 GPU 性能实测、ASR 术语勘误、安全边界 |

---

## 协作约定

见 [`AGENTS.md`](AGENTS.md)，要点：

- **中文交流**，所有回复与文档用中文；
- **修改或创建任何文件前，先列出改动范围**（文件路径 + 修改点 + 新增内容概要），得到明确同意后再动手；
- 用户给出明确完整的指令（如"创建文件 X，内容为 Y"）时视为已同意范围，可直接执行。

## 安全边界

- `.pi/npm/` 下的依赖与 `node_modules` **不入库**（由该目录的 `.gitignore` 保证）；
- 音视频、字幕、课件、`downloads/`、`transcripts/` **不要提交**；
- `SESSDATA` 之类的 **cookie 与 API key 属凭据**，不要写进仓库、也不要贴进对话（`~/.pi/agent/auth.json` 同样不应复制进来）。

## 仓库信息

| 项 | 值 |
|---|---|
| 远程 | `https://github.com/tengs101/pi_tutorials` |
| 可见性 | Public |
| 主分支 | `main` |
| 提交署名 | 仓库级配置（不影响全局 git 配置），使用 GitHub noreply 邮箱 |
