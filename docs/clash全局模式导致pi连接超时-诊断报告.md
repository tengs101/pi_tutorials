# 诊断报告：Clash 全局模式导致 pi 连接超时

**环境**：Windows 11 + npm 版 Pi（`@earendil-works/pi-coding-agent`）+ Clash Verge Rev（内核 `verge-mihomo`）
**症状**：pi 频繁报 `Connection error.` / `Request timed out.` / `Retry failed after 3 attempts: Connection error.`
**结论**：**Clash 运行在「全局模式」（`mode: global`），叠加用户级 `HTTP_PROXY` 环境变量，使 pi 的国内模型请求被绕道境外节点，单次请求从 ~1 秒劣化到 ~57 秒，最终超时。**

**当前状态：✅ 已修复（2026-10-02）** —— Clash 已切换为「规则」模式，实测 pi 单次调用从 57.02 s 降至 1.20 s，复测数据见 §4.1。

---

## 1. 症状与日志证据

会话 JSONL 里的失败条目结构如下（tokens 全为 0，说明请求从未建立成功，不是模型返回的错误）：

```json
{
  "type": "message",
  "message": {
    "role": "assistant",
    "content": [],
    "api": "openai-completions",
    "provider": "deepseek",
    "model": "deepseek-flash",
    "usage": { "input": 0, "output": 0, "totalTokens": 0 },
    "stopReason": "error",
    "errorMessage": "Connection error."
  }
}
```

- 单个会话文件中命中该模式的条目共 **58 条**。
- 存在明显的**重试爆发段**：`14:50:13 → 14:50:26 → 14:50:35 → 14:50:48 → 14:50:55 → 14:51:02`，间隔 7–13 秒，符合"超时 → 重试 → 再超时"的节奏。

## 2. 排查路径（含走过的弯路）

**教训：遇到"连接慢/超时"类问题，第一件事应该是对照"直连 vs 走代理"，而不是怀疑具体脚本或接口。**

| 顺序 | 怀疑对象 | 结论 |
|---|---|---|
| 1 | 第三方脚本的请求头不正确 | ❌ 错。同一请求头组合在不同时刻 200/412 交替，是时间窗口问题 |
| 2 | 目标站点的 WAF / TLS 指纹 | ❌ 错。`urllib` 与 `curl` 表现不一致只是表象，两者最终都受同一出口 IP 影响 |
| 3 | 目标站点对本机 IP 限流 | ⚠️ 部分对。限流确实存在，但**被限的是代理的出口 IP，不是本机真实 IP** |
| 4 | **本机代理配置** | ✅ **正解** |

关键转折：发现环境里存在 `HTTP_PROXY / HTTPS_PROXY / ALL_PROXY = http://127.0.0.1:7890`，
而 pi 的文档明确说明它会读取这两个变量（`docs/environment-variables.md`：`HTTP_PROXY, HTTPS_PROXY → Proxy outbound HTTP requests`；
`docs/settings.md` 的 `httpProxy` 项描述为 "applied as HTTP_PROXY and HTTPS_PROXY for Pi-managed HTTP clients"）。

## 3. 根因：全局模式 + 环境变量代理

```yaml
# %APPDATA%\io.github.clash-verge-rev.clash-verge-rev\config.yaml
mode: global          # 运行时实际生效
```

```
config.yaml           -> mode: global     ← 有效值
clash-verge.yaml      -> mode: global
profiles\<订阅>.yaml   -> mode: rule       ← 订阅自带默认值，被全局模式覆盖
verge.yaml            -> enable_system_proxy: false, enable_tun_mode: false
```

两个条件同时成立才出问题：

1. **Clash 处于全局模式** → 所有流量（含国内）都被塞进境外节点，规则不生效；
2. **用户级代理环境变量存在** → 命令行工具（`curl`、Python、pi）主动把请求交给 7890 端口。

浏览器不受影响，因为 `enable_system_proxy: false`（系统代理关闭），浏览器走直连。

## 4. 量化证据

| 测试目标 | 走代理 | 直连 | 倍数 |
|---|---|---|---|
| `https://api.deepseek.com/v1/models` | 1.09 – 2.65 s | **0.12 – 0.16 s** | ~10–20× |
| `https://www.baidu.com`（纯国内站，本不可能出国） | 1.39 s | **0.08 s** | ~17× |
| **一次完整的 pi 无头调用** | **57.02 s** | **0.96 s** | **~60×** |
| pi 调用 + `NO_PROXY=api.deepseek.com` | — | **1.25 s** | ✅ 有效 |

节点延迟抖动本身也很大：连续 3 次采样为 **4.15 s / 0.91 s / 5.09 s**，抖动达 5 倍——这解释了"时好时坏"。

### 4.1 修复后复测（2026-10-02，切到规则模式后）

| 测试 | 走代理 | 直连 | 结论 |
|---|---|---|---|
| `https://api.deepseek.com/v1/models` | 0.108 s | 0.138 s | **已一致** ✅ |
| `https://www.baidu.com` | 0.099 s | 0.113 s | **已一致** ✅ |
| `https://www.google.com`（境外） | 302 / 1.96 s | — | **仍走代理** ✅ 预期行为 |
| **一次完整的 pi 无头调用** | **1.20 s / 1.30 s** | — | 相比修复前的 57.02 s 提升约 **45×** ✅ |

配置状态：`config.yaml` → `mode: rule`（运行时生效值）。

> ⚠️ `clash-verge.yaml` 中仍保留旧值 `mode: global`。实测行为已正确，但若**重启 Clash 后模式又跳回全局**，就是这个文件里的值被恢复所致，需在 GUI 中重新确认。

## 5. 复现与判定命令

```powershell
# 1) 看代理环境变量是否存在
Get-ChildItem env: | Where-Object Name -match 'PROXY'

# 2) 对照测试：直连 vs 走代理（同一个国内域名）
foreach ($h in @("https://api.deepseek.com/v1/models","https://www.baidu.com")) {
  $viaProxy = & curl.exe -s -o NUL -w "%{time_total}s" --max-time 15 -x "http://127.0.0.1:7890" $h
  $direct   = & curl.exe -s -o NUL -w "%{time_total}s" --max-time 15 --noproxy '*' $h
  "{0,-40} 走代理={1,-10} 直连={2}" -f $h, $viaProxy, $direct
}

# 3) 看 Clash 当前模式
$d = "$env:APPDATA\io.github.clash-verge-rev.clash-verge-rev"
Select-String -Path "$d\config.yaml" -Pattern '^\s*mode\s*:'

# 4) 计时对比 pi 调用（走代理 vs 无代理）
Measure-Command { pi -p "只回答数字：1+1" --no-session -nt | Out-Null }   # 现状
$env:NO_PROXY="api.deepseek.com"; Measure-Command { pi -p "只回答数字：1+1" --no-session -nt | Out-Null }
```

> 判定原则：**如果国内域名的"走代理"耗时明显高于"直连"（比如 0.1s vs 1s 以上），就说明国内流量被绕出境了。**

## 6. 修法

### 方案 1（**已于 2026-10-02 采用**，推荐）：Clash 切到「规则」模式

Clash Verge 里把模式从 **全局(Global)** 改为 **规则(Rule)**。

- 国内流量（DeepSeek、B站、百度等）走直连 → pi 从 57s 回到 ~1s
- 国外流量（Google、GitHub、HuggingFace）仍走代理 → 需要翻墙的能力不受影响
- **立即生效**，无需重启任何程序

### 方案 2（保留全局模式）：给国内域名设 `NO_PROXY`

实测有效（1.25s）。**用户级环境变量，重启 pi 后生效**（新进程才继承）：

```powershell
[Environment]::SetEnvironmentVariable(
  "NO_PROXY",
  "api.deepseek.com,api.minimax.chat,api.minimaxi.com,localhost,127.0.0.1",
  "User")
```

- pi 的 HTTP 栈（undici `EnvHttpProxyAgent`）**支持 `NO_PROXY`**，已实测；
- `curl`、Python `urllib` 也支持；
- 不影响对境外站点的访问。

### 方案 3（不推荐）：清空 proxy 环境变量

会让依赖代理的境外能力（web 搜索、GitHub 抓取、HuggingFace 下载）一起失效。

## 7. 同源影响：目标站点 412

同一根因还会造成**目标站点返回 412（Precondition Failed）**：

- 走代理时，出口是一个**共享的境外 IP**，容易被国内站点的风控高频命中；
- 表现为"浏览器正常、命令行 412"；
- 若代码把 412 的 HTML 响应体直接喂给 JSON 解析器，就会抛出误导性的 `JSONDecodeError`，把真正原因掩盖掉。

> 具体案例与修复见 [`bilibili-persona-安装与踩坑.md`](./bilibili-persona-安装与踩坑.md) 的「代理导致 412」一节。

## 8. 一句话总结

**国内服务不要走境外代理。** 检查三件事：Clash 是否在全局模式、`HTTP_PROXY/HTTPS_PROXY` 是否存在、国内域名的走代理与直连耗时是否差一个数量级。
