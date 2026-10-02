# bilibili-persona：移植到 Pi 的安装步骤与踩坑记录

把 B 站网课蒸馏成「课程知识库 + 讲师人格」的 skill。**上游是 ZCode 桌面客户端插件，不是 Pi 包**，本文记录把它移植到 Pi 的完整过程、必要的改动、以及实测踩到的坑。

---

## 1. 上游是什么

| 项 | 值 |
|---|---|
| 官方项目名 | `bilibili-persona` |
| 仓库地址 | `https://github.com/sorrowKnight123/video-to-skill-`（**注意仓库名末尾有一个连字符**；不带连字符的仓库不存在） |
| 形态 | **ZCode 桌面客户端插件**（含 `marketplace.json` + `.zcode-plugin/plugin.json`） |
| 许可 | **GPL-3.0**（衍生作品需同样以 GPL 开源；保留了 `LICENSE` 与 `NOTICE`） |
| 职责划分 | `yt-dlp`/`bili_fetch.py` 负责下载，`transcribe.py` 负责音频转文字，`materials.py` 负责读课件，**蒸馏与写作由 LLM 完成**，无其他运行时 |

### 为什么 `pi install` 装不了

- README 的安装方式是「ZCode → 设置 → 插件管理 → 发现 → `+` → 粘贴仓库 URL」，这是 ZCode 的插件市场机制；
- 仓库**没有 `package.json`、没有 `pi` 字段**，所以 `pi install git:...` / `npm:` 都不可用；
- 但它的 `skills/bilibili-persona/SKILL.md` 结构**与 Pi 的 Agent Skills 规范高度兼容**，可以手工移植。

---

## 2. 移植到 Pi（用户级安装）

### 2.1 最终目录结构

```
~/.pi/agent/skills/bilibili-persona/
├── SKILL.md                  # 唯一改了内容的文件
├── LICENSE                   # GPL-3.0 原文（合规）
├── NOTICE                    # 第三方归属声明（合规）
├── scripts/
│   ├── bili_fetch.py         # 列分P / 下音频 / 存原生字幕
│   ├── transcribe.py         # 转写（云/本地）+ 术语纠错
│   ├── materials.py          # 课件解析（PDF/PPTX/DOCX/MD/TXT）
│   └── mock_asr.py           # 假 ASR 服务，无密钥验证云链路
└── personas/_methods/        # 三种教学法叠加层模板
    ├── README.md
    ├── 严格推导派.md
    ├── 直觉类比派.md
    └── 考点导向派.md

~/.pi/agent/prompts/learn-course.md    # 把上游的 ZCode 命令改成 Pi 提示词模板
```

Pi 会自动发现 `~/.pi/agent/skills/` 与 `~/.pi/agent/prompts/` 下的资源，**不需要改 `settings.json`**。

### 2.2 必须做的 2 处内容改动

**① `SKILL.md` 中的脚本路径**（9 处）

上游用 ZCode 的"插件根"占位符：

```diff
- python "<插件根>/scripts/bili_fetch.py" list <BV号或链接>
+ python scripts/bili_fetch.py list <BV号或链接>
```

理由：Pi 规范要求**使用相对 skill 目录的路径**，Pi 会把 skill 所在路径告知模型，相对路径即可解析。

**② frontmatter 规范化**

```diff
  name: bilibili-persona
  description: Turn a bilibili/B站 course video or BV id into ...
- when_to_use: BV号, bilibili.com/video, 网课, ...
  license: GPL-3.0
+ metadata:
+   when_to_use: BV号, bilibili.com/video, 网课, ...
```

`when_to_use` 不是 Agent Skills 规范字段（Pi 会告警但不阻断），收进 `metadata` 后即合规。其余正文**一字未动**。

### 2.3 提示词模板

上游的 `commands/learn-course.md` 是 ZCode 斜杠命令，Pi 侧改造成 `~/.pi/agent/prompts/learn-course.md`：

- 删掉 ZCode 专有字段 `skills: bilibili-persona`（Pi 不认）；
- 保留 `description`、`argument-hint`（Pi 同名字段）；
- 正文里的 `$ARGUMENTS` **Pi 原生支持**，无需改动。

### 2.4 安装验证方法

**不要只看文件是否存在**，要确认 Pi 真的加载了它。用一个"对照组"无头会话来验证：

```powershell
# 已知会被用户级 settings.json 排除的 skill 作对照，验证 skill 列表确实被注入
Push-Location $env:TEMP
pi -p "只根据系统提示回答，不要调用任何工具：1) 有没有 chrome-devtools？2) 有没有 bilibili-persona？格式：x=有/没有" --no-session
Pop-Location
```

注意两点：

- 加 `-nt`（禁用工具）时 Pi **不会**注入 skill 清单，会得到"没有"的假阴性；
- 用户级 `settings.json` 里的 `skills` 数组支持 `-path`（精确排除）与 `+path`（精确包含）。例如 `-skills\chrome-devtools\SKILL.md` 会排除该 skill，而项目级 `+...` 又能把它加回来——**同一 skill 在不同目录下可见性可能不同**。

---

## 3. 踩坑一：本地代理导致目标站点 412（最耗时的坑）

### 症状与误导

`bili_fetch.py list` 崩溃并抛出**极具误导性**的堆栈：

```
[info] 412 from Python client; retrying this request through curl
json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)
```

看起来像"脚本请求头写错了"或"JSON 接口变了"，**实际都不是**。

### 根因

环境和机器代理配置问题（完整诊断见 [`clash全局模式导致pi连接超时-诊断报告.md`](./clash全局模式导致pi连接超时-诊断报告.md)）：

- 用户级环境变量存在 `HTTP_PROXY / HTTPS_PROXY / ALL_PROXY = http://127.0.0.1:7890`；
- `curl` 与 Python `urllib` **都自动遵守**这些变量，于是**所有请求都从同一个共享出口 IP 出去**；
- 该出口 IP 被目标站点风控高频命中 → 返回 **412**（带一个 HTML 挑战页）；
- 浏览器因系统代理关闭而直连，所以"浏览器能打开、命令行 412"。

判定方法（一次性对照）：

```powershell
curl.exe -s -o NUL -w "%{http_code}"      -A "<UA>" "<目标 API URL>"   # 走环境代理
curl.exe -s -o NUL -w "%{http_code}" --noproxy "*" -A "<UA>" "<目标 API URL>"   # 直连
```

实测结果：**走代理 412 / 直连 200**。

### 修法（两种，可叠加）

**修法 A：临时/单次** —— 给目标域名设 `NO_PROXY`

```powershell
$env:NO_PROXY = "bilibili.com,hdslb.com,bilivideo.com,bilivideo.cn"
```

`curl` 与 Python `urllib` 都遵守，且**保留代理给 HuggingFace 等其他服务使用**。

**修法 B：永久固化进脚本**（见下节第 4 处补丁）——脚本自行对目标域名强制直连，无需任何环境变量。

---

## 4. 对 `bili_fetch.py` 的 4 处补丁

补丁的目标是：**让错误可诊断**（不改业务逻辑）+ **让目标站点直连**。

| # | 位置 | 改动 | 解决的问题 |
|---|---|---|---|
| 1 | `_curl()` | 命令追加 `-w "\n%{http_code}"`，取回后按最后一个换行拆出响应体与状态码；非 200 抛 `urllib.error.HTTPError` | `curl` 在 412 时**返回码仍是 0**，原实现会把 WAF 的 HTML 当成响应体交给 `json.loads`，掩盖真实原因 |
| 2 | 新增 `_http_error()` | 412 给出明确说明：**"Python 客户端与 curl 都 412 = IP 级限流，不是 TLS 指纹或请求头问题；等几分钟并调大 `--delay`；cookie 无法解决"** | 把误导性报错换成可操作的诊断 |
| 3 | `api()` | 新增 `except json.JSONDecodeError` 分支给出同样明确的提示；降级重试前 `time.sleep(RETRY_AFTER_412_S)`（新增常量，默认 5 秒） | 412 会短暂开启 IP 惩罚窗口，**立即重试必然再次 412**，等于白重试 |
| 4 | 新增 `DIRECT_HOSTS` / `_needs_direct()` / `_urlopen()`；`_curl()` 中对目标域名追加 `--noproxy "*"` | **目标站点域名（`bilibili.com` / `hdslb.com` / `bilivideo.com` / `bilivideo.cn`）强制直连**，覆盖 API、CDN 音频下载、字幕三条路径（共 3 处 `urlopen` 调用点） | 不依赖用户设置环境变量；非目标域名（如 HuggingFace）仍走代理，互不冲突 |

### 验收结果

| 场景 | 修复前 | 修复后 |
|---|---|---|
| `list`（API），**不设 `NO_PROXY`** | 412 → `JSONDecodeError` 崩溃 | **200 ✅** |
| `audio`（CDN 下载），**不设 `NO_PROXY`** | — | **200 ✅** |
| 412 场景的报错信息 | 误导性 JSON 堆栈 | **一句话说清是 IP 级限流 ✅** |

> 补丁 4 与 Clash 是否切到规则模式无关，两种情况下都有效，可长期保留。

---

## 5. 踩坑二：无 GPU 机器的性能与参数

### 5.1 脚本的默认行为（已核对源码）

```python
MODEL_GPU, MODEL_CPU = "large-v3-turbo", "small"   # 无 CUDA → 自动用 small
pick_device("auto") -> ("cpu", "int8")             # 无 CUDA → CPU + int8
cpu_threads = cpu_threads or 0                     # 0 = 交给 CTranslate2 自决
```

无 GPU 时自动退回 CPU + `small` 模型，**这是设计行为，不是故障**。

### 5.2 实测耗时换算

测试条件：4 分 55 秒中文音频，CPU `int8`，模型 `small`，输出 173 行带时间戳文本。

| 参数 | 耗时 |
|---|---|
| 默认（`--cpu-threads` 不设，即 0） | **146.7 s**（≈ 2.1× 实时） |
| `--cpu-threads 8` | 148.0 s（与默认无差异，在噪声内） |
| `--cpu-threads 14` | **184.7 s（慢 26%，不要设）** |

**结论：不要显式指定 `--cpu-threads`**，默认值最优。混合核心（性能核 + 能效核）的笔记本上，按物理核数强行指定反而因线程争抢而变慢。

### 5.3 耗时规划表（按 2.1× 实时）

| 音频长度 | CPU 本地预计耗时 |
|---|---|
| 5 分钟 | ~2.5 分钟 |
| 1 小时 | ~28 分钟 |
| 4 小时 | **~1.9 小时** |

### 5.4 其他约束与建议

- **内存**：`faster-whisper small` 已缓存约 494 MB。若可用内存紧张（例如只剩 3 GB），长音频转写要避免与其他重任务并行。
- **不要为提速换更小的模型**：`small` 对英文产品名的识别已经错误率很高（见下节），换 `tiny`/`base` 只会更糟；`large-v3-turbo` 在 CPU 上会慢很多倍。
- **优先走字幕**：先跑 `bili_fetch.py subs`。有原生字幕时免费且秒出，完全不需要 ASR。
- **长课程考虑云 ASR**（无需 GPU 时最快的路径）：脚本支持任意 OpenAI 兼容的 `/audio/transcriptions` 端点，例如把 `ASR_BASE_URL` 指向服务商地址、`ASR_MODEL` 设为对应的语音模型。无密钥时可用 `python scripts/mock_asr.py` 验证链路。

---

## 6. 踩坑三：ASR 对英文产品名的系统性错写

`faster-whisper small` 对同一产品名会产生**多种错法**，直接污染知识库。实测（一期中文科技评论视频）：

| 转写结果 | 正确写法 |
|---|---|
| DeepSake / Deepsec / Deepsec 的 | **DeepSeek** |
| Hanis | **harness** |
| Cloud Code / Cloud Core / Cloud-Code / Claude扣 | **Claude Code** |
| Z Code / Z Core / Z-Code / Z扣 | **ZCode** |
| 库德克斯 | Codex |
| 一技绝尘 / 败下阵栏 / 稳扎文档 / 通定思统 | 一骑绝尘 / 败下阵来 / 稳扎稳打 / 痛定思痛 |
| 分职 / 德芬 | 分值 / 得分 |

**处理方式**：先用 `--apply-glossary 词表.json --dry-run` 看命中情况，确认后再落盘。词表是 JSON 结构，用**确定性替换**修正术语，而不是让模型"猜"。

### 无法解决的未决项

有一类错误无法靠转写修正：**画面里才有、口播又读不出正确拼写的专有名词**。
实测案例：某框架名的 ASR 稳定输出为「Ryzenx」（变体「RazenX」「recentx」），无法从音频判定正确产品名。

该 skill 的取舍是**不读视频画面**（抽帧/OCR/视觉模型成本高），而是**靠课件补这个缺口**。因此：
- 没有课件时，此类名称应**明确标注为 ASR 不确定**，不要猜测；
- 有课件（PDF/PPTX/DOCX）时，用 `materials.py` 解析后对照即可解决。

---

## 7. 标准使用流程

```powershell
# 0) 关键：若机器配置了代理，且目标站点是国内服务，先确保直连
#    （移植后的脚本已内置直连，通常无需手动设置）

# 1) 列分P —— 必须把全部分P呈现给用户并确认范围，不要替用户决定
python scripts/bili_fetch.py list <BV号>

# 2) 优先尝试原生字幕（免费、秒级）
python scripts/bili_fetch.py subs <BV号> -I 1-5 -o transcripts
#    若输出 "no subtitles" 则说明该视频没有字幕，且与登录无关，别再折腾 cookie

# 3) 无字幕时才下载音频（默认串行；下载后会做解码校验）
python scripts/bili_fetch.py audio <BV号> -I 1-5 -o downloads

# 4) 本地转写（无 GPU 时自动 CPU int8 + small；不要指定 --cpu-threads）
python scripts/transcribe.py downloads -o transcripts --engine local

# 5) 有课件时解析课件，补上"不读画面"丢掉的信息
python scripts/materials.py <课件目录> -o <知识库>/references/课件笔记

# 6) 最后一步是 LLM 的活：读转写 + 课件，按知识库结构写作
```

### 知识库产物结构（上游设计）

```
skills/<课程名>/
├── SKILL.md            # 触发词 + 大纲索引 + 怎么检索
└── references/
    ├── 大纲.md          # 全部讲次 + 每讲核心 + 考点清单
    ├── 术语表.md        # 术语 + 读法 + ASR 勘误对照
    ├── 讲义/01-xxx.md   # 每讲一份：概念/公式/推导/例题/易混与坑/考点
    └── 课件笔记/

personas/<讲师名>/       # 人格产物，默认不启用（要用需拷进 skills 目录）
```

讲义按**六栏**结构化是刻意的：**先结构化再写作**，口语填充语在第一步就被挡掉，避免知识库被"这个这个""啊"污染。

### 安全边界（重要）

- `downloads/`、`transcripts/`、`.cache/`、`_refs/` 必须 gitignore，**不要提交或上传**音视频、字幕、课件；
- 用本工具生成的**知识库与人格可以自由分发**，但原始音视频/字幕/课件**不可以**；
- `SESSDATA` 等 cookie 属账号凭据，**不要写进仓库、不要贴进对话**；
- 只做个人学习用途的本地文字化：不重新分发视频、不绕过付费墙/DRM、不批量爬取。

---

## 8. 已知限制

- **不读视频画面**（不抽帧、不做 OCR/视觉理解）——用课件补这个缺口；
- **只支持 B 站**；
- 不做 MCP server、GUI、配置文件、向量库 RAG、思维导图；
- 不做学习者状态跟踪（掌握度、复习队列、错误本）；
- 上游为 **GPL-3.0**，本仓库内的移植说明与补丁同样受该许可约束。

---

## 9. 命令速查

| 命令 | 作用 |
|---|---|
| `bili_fetch.py list <BV>` | 列分P（序号/时长/cid/标题） |
| `bili_fetch.py audio <BV> -I 4-24 -o downloads` | 下音频（串行 + 解码校验） |
| `bili_fetch.py verify <BV> -o downloads` | 校验本地音频完整性 |
| `bili_fetch.py subs <BV> -I 1-3 -o transcripts` | 存原生字幕（与转写同格式） |
| `transcribe.py downloads -o transcripts` | 转写（`--engine auto\|cloud\|local`） |
| `transcribe.py --check` | 自检设备与模型 |
| `transcribe.py --apply-glossary 词表.json transcripts/ --dry-run` | 术语纠错（先看命中再落盘） |
| `materials.py <课件目录> -o <知识库>/references/课件笔记` | 解析课件 |
| `mock_asr.py` | 本地假 ASR 服务，无密钥验证云转写链路 |

`bili_fetch.py` 另有两个参数：`--delay`（默认 1 秒，被限流就调大）、`--workers`（默认 1，**不要调大**——并行下载会产生"大小正确但内容损坏"的音频文件）。
