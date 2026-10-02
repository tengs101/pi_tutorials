---
name: create-pi-extensions
description: 创建 pi-coding-agent 扩展（Extension）。包含完整的 ExtensionAPI 接口、编程规范、安全清单、调试技巧、依赖管理与固定输出模板。仅通过 /skill:create-pi-extensions 手动触发，不自动加载。
disable-model-invocation: true
---

# create-pi-extensions / 创建 pi 扩展

> 帮助用户创建 pi-coding-agent 的 TypeScript 扩展。

---

## 1. 基本信息 / Overview

### 什么是 Extension

TypeScript 模块，通过 `ExtensionAPI` 接口扩展 pi。可注册：

- **Tools** — 自定义工具（LLM 可调用）
- **Commands** — `/` 自定义命令
- **Events** — 生命周期 / Agent / Tool / Model 事件钩子
- **UI** — 状态行、头部、尾部、对话框、Widget、编辑器
- **Providers** — 自定义模型供应商
- **Flags / Shortcuts** — CLI 参数与快捷键

### 放置位置（按优先级）

| 位置 | 作用域 |
|------|--------|
| `~/.pi/agent/extensions/*.ts` 或 `*/index.ts` | 全局（所有项目） |
| `.pi/extensions/*.ts` 或 `*/index.ts` | 项目级（当前项目，需受信任） |
| pi package 内 | 通过 npm/git 分享 |
| `pi -e <path>` | CLI 临时加载（可重复） |

### 文件组织形式

**单文件**（最简）：
```
my-extension.ts
```

**目录形式**（多文件）：
```
my-extension/
├── index.ts        # 入口（默认导出）
├── tools.ts        # 辅助模块
└── utils.ts
```

**带依赖**：
```
my-extension/
├── package.json    # 声明依赖 + `pi.extensions` 字段
├── package-lock.json
├── node_modules/   # npm install 后
└── src/index.ts
```

---

## 2. ExtensionAPI 完整接口 / Full API

### 2.1 事件订阅（Event API）

完整事件清单（按类别）：

| 事件 | 时机 | 可拦截/可改写 |
|------|------|---------------|
| **启动 / Startup** | | |
| `project_trust` | 项目信任判定前（仅 user/global/CLI 扩展） | ✅ 返回 `{ trusted, remember? }` |
| **资源 / Resources** | | |
| `resources_discover` | 资源发现 | ✅ 返回 `skillPaths`/`promptPaths`/`themePaths` |
| **会话 / Session** | | |
| `session_start` | 会话开始（startup/new/resume/fork/reload） | 通知型 |
| `session_info_changed` | `/name` 改名 | 通知型 |
| `session_before_switch` | `/new` / `/resume` 前 | ✅ 可 cancel |
| `session_before_fork` | `/fork` / `/clone` 前 | ✅ 可 cancel |
| `session_before_compact` | 压缩前 | ✅ 可 cancel 或自定义摘要 |
| `session_compact` | 压缩后 | 通知型 |
| `session_before_tree` | `/tree` 导航前 | ✅ 可 cancel 或自定义摘要 |
| `session_tree` | 树导航后 | 通知型 |
| `session_shutdown` | 会话关闭 | 清理资源 |
| **Agent** | | |
| `before_agent_start` | 用户提交 prompt 后、Agent 循环前 | ✅ 注入 message / 修改 systemPrompt |
| `agent_start` / `agent_end` | 低层级 agent run 开始/结束 | 通知型 |
| `agent_settled` | 无自动重试/压缩/follow-up | 通知型 |
| `turn_start` / `turn_end` | 每个 turn | 通知型 |
| `message_start` / `message_update` / `message_end` | 消息生命周期 | `message_end` 可替换 message |
| `tool_execution_start` / `_update` / `_end` | 工具执行生命周期 | 通知型 |
| `context` | 每次 LLM 调用前 | ✅ 修改 messages（非破坏性） |
| `before_provider_headers` | 组装请求头后 | ✅ 修改 headers |
| `before_provider_request` | 发送前 | ✅ 替换 payload |
| `after_provider_response` | 收到响应后、消费流前 | 通知型 |
| **Model** | | |
| `model_select` | 模型变更 | 通知型 |
| `thinking_level_select` | 思考等级变更 | 通知型 |
| **Tool** | | |
| `tool_call` | 工具执行前 | ✅ 阻塞（`{ block: true, reason }`）/ 改写 `event.input` |
| `tool_result` | 工具执行后 | ✅ 改写结果（`content`/`details`/`isError`/`usage`） |
| **用户 Bash** | | |
| `user_bash` | `!` / `!!` 命令 | ✅ 提供 operations 或 result |
| **输入** | | |
| `input` | 用户输入（命令检查后、skill/template 展开前） | ✅ `transform` / `handled` / `continue` |

### 2.2 注册方法

| 方法 | 用途 |
|------|------|
| `pi.on(event, handler)` | 订阅事件 |
| `pi.registerTool(definition)` | 注册自定义工具 |
| `pi.registerCommand(name, { description, handler, getArgumentCompletions? })` | 注册 `/` 命令 |
| `pi.registerShortcut(key, { description, handler })` | 注册快捷键 |
| `pi.registerFlag(name, { description, type, default })` | 注册 CLI 参数 |
| `pi.registerProvider(name \| Provider, config?)` | 注册/覆盖模型供应商 |
| `pi.unregisterProvider(name)` | 移除已注册供应商 |
| `pi.registerMessageRenderer(customType, renderer)` | 自定义消息 TUI 渲染 |
| `pi.registerEntryRenderer(customType, renderer)` | 自定义会话条目渲染 |

### 2.3 状态与消息

| 方法 | 用途 |
|------|------|
| `pi.sendMessage(message, options?)` | 注入自定义消息（参与 LLM 上下文） |
| `pi.sendUserMessage(content, options?)` | 发送用户消息（看起来像用户输入） |
| `pi.appendEntry(customType, data?)` | 持久化扩展数据（不参与 LLM 上下文） |
| `pi.setSessionName(name)` / `pi.getSessionName()` | 会话显示名 |
| `pi.setLabel(entryId, label)` | 给 entry 打书签 |
| `pi.setActiveTools(names)` / `pi.getActiveTools()` / `pi.getAllTools()` | 工具启用管理 |
| `pi.setModel(model)` | 切换模型 |
| `pi.setThinkingLevel(level)` / `pi.getThinkingLevel()` | 思考等级 |
| `pi.exec(command, args, options?)` | 执行 shell 命令 |
| `pi.events` | 跨扩展事件总线（`on` / `emit`） |

### 2.4 ExtensionContext（handler 接收的 `ctx`）

**常用字段**：
- `ctx.cwd` — 当前工作目录
- `ctx.mode` — `"tui" | "rpc" | "json" | "print"`
- `ctx.hasUI` — 是否有 UI（guard 对话框方法）
- `ctx.sessionManager` — 只读会话状态（`getEntries` / `getBranch` / `buildContextEntries` / `getLeafId`）
- `ctx.modelRegistry` / `ctx.model` / `ctx.thinkingLevel` / `ctx.scopedModels`
- `ctx.signal` — 当前 turn 的中止信号
- `ctx.isIdle()` / `ctx.abort()` / `ctx.hasPendingMessages()`
- `ctx.shutdown()` — 请求优雅退出
- `ctx.getContextUsage()` — 当前上下文用量
- `ctx.compact(opts)` — 触发压缩
- `ctx.getSystemPrompt()` — 当前系统提示字符串
- `ctx.isProjectTrusted()` — 项目是否受信任

**`ctx.ui` 方法**：
- 对话框：`select` / `confirm` / `input` / `editor` / `notify` / `custom`
- 状态：`setStatus` / `setWidget` / `setFooter` / `setHeader` / `setTitle`
- 编辑器：`setEditorText` / `getEditorText` / `pasteToEditor` / `setEditorComponent` / `getEditorComponent`
- 流式：`setWorkingMessage` / `setWorkingVisible` / `setWorkingIndicator`
- 主题：`getAllThemes` / `getTheme` / `setTheme`
- 工具显示：`getToolsExpanded` / `setToolsExpanded`
- 自动补全：`addAutocompleteProvider`
- 思考标签：`setHiddenThinkingLabel`

**命令专属（`ExtensionCommandContext`）**：
- `ctx.waitForIdle()` — 等待 agent 真正空闲
- `ctx.newSession(options?)` — 创建新会话
- `ctx.fork(entryId, options?)` — fork 指定 entry
- `ctx.navigateTree(targetId, options?)` — 树内导航
- `ctx.switchSession(path, options?)` — 切换会话文件
- `ctx.reload()` — 同 `/reload`
- `ctx.getSystemPromptOptions()` — 获取系统提示的构造选项

### 2.5 关键工具定义字段

```typescript
pi.registerTool({
  name, label, description,
  promptSnippet?,            // 一行简介（出现在 "Available tools"）
  promptGuidelines?,         // 工具专属指南（必须包含工具名）
  parameters,                // Type.Object(...)
  prepareArguments?,         // 旧会话参数兼容
  renderShell?: "self",      // 自己渲染外壳
  renderCall?, renderResult?,// TUI 自定义渲染
  async execute(toolCallId, params, signal, onUpdate, ctx) { ... }
});
```

`execute` 返回：
```typescript
{
  content: [{ type: "text", text: "..." }],  // 发送给 LLM
  details: { ... },                          // 状态/渲染
  isError?: boolean,                         // 由 throw 设置
  usage?: Usage,                             // 嵌套 LLM 调用的用量
  terminate?: true,                          // 整个 batch 终止后停止
}
```

---

## 3. 编程规范 / Coding Standards

### 3.1 命名

| 类型 | 规则 | 示例 |
|------|------|------|
| 文件名 | kebab-case | `auto-commit-on-exit.ts` |
| 工具名 | 小写 + 下划线 | `parse_duration` |
| 命令名 | kebab-case | `/stats`, `/deploy-prod` |
| 事件 customType | kebab-case | `my-state`, `tools-config` |

### 3.2 类型与 Schema

- **字符串枚举必须用 `StringEnum`**（来自 `@earendil-works/pi-ai`）— `Type.Union`/`Type.Literal` 不兼容 Google API
- 参数 schema 用 `typebox` 的 `Type.Object(...)`、`Type.String(...)`、`Type.Optional(...)` 等
- 复杂对象导出 `Static<typeof schema>` 作为输入类型
- 旧会话兼容：用 `prepareArguments` 重写参数形状

### 3.3 异步与生命周期

- 默认导出可 `async`，pi 会等待
- **不要在工厂函数中启动后台资源**（进程、socket、文件监听、定时器）— 改在 `session_start` 或具体 handler 内启动
- **必须注册幂等的 `session_shutdown` handler** 清理资源
- `ctx.signal` 用于 abort-aware 操作（fetch、嵌套模型调用等）

### 3.4 输出截断

工具输出必须截断，默认上限 **50KB / 2000 行**：

```typescript
import { truncateHead, truncateTail, formatSize, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES }
  from "@earendil-works/pi-coding-agent";
```

- `truncateHead` — 文件读取、搜索结果（前部重要）
- `truncateTail` — 日志、命令输出（尾部重要）
- 截断后告知 LLM 完整文件路径

### 3.5 文件并发写入

修改文件的工具**必须**用 `withFileMutationQueue`，避免并行执行时冲突：

```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

await withFileMutationQueue(resolve(ctx.cwd, params.path), async () => {
  // 完整的 read-modify-write 流程
});
```

### 3.6 错误处理

```typescript
async execute(...) {
  if (!isValid(params.input)) {
    throw new Error(`Invalid input: ${params.input}`);  // throw 设 isError=true
  }
  return { content: [...], details: {} };  // 返回值不会设 error
}
```

### 3.7 状态持久化（支持分支）

将状态存入工具结果 `details`，`session_start` 时从 `sessionManager.getBranch()` 重构：

```typescript
// 工具：details 携带状态
return { content: [...], details: { items: [...items] } };

// session_start：重构
for (const entry of ctx.sessionManager.getBranch()) {
  if (entry.type === "message" && entry.message.role === "toolResult"
      && entry.message.toolName === "my_tool") {
    items = entry.message.details?.items ?? [];
  }
}
```

---

## 4. 安全清单 / Security Checklist

创建/审查扩展时必须确认：

- [ ] **输入验证**：所有用户输入（命令参数、文件路径、URL）已校验
- [ ] **路径保护**：阻止写入 `.env`、`.git/`、`node_modules/`、`secrets.*` 等敏感路径
- [ ] **危险命令确认**：`rm -rf`、`sudo`、格式化、删除分支等需要 `ctx.ui.confirm`
- [ ] **敏感数据脱敏**：不把密钥、token 直接写入日志、`details` 或 `notify`
- [ ] **网络请求**：外部 fetch 带超时，使用 `ctx.signal` 支持取消
- [ ] **资源清理**：`session_shutdown` 中关闭所有打开的资源（DB、socket、监听器、子进程）
- [ ] **权限最小化**：能用 `setActiveTools` 限制可用工具就用
- [ ] **沙箱考虑**：高风险扩展参考 `sandbox/` 或 `gondolin/` 模式
- [ ] **可信赖来源**：仅安装审查过的第三方扩展（pi package 拥有完整系统权限）

---

## 5. 依赖管理 / Dependencies

### 5.1 简单依赖

在扩展目录下创建 `package.json`，声明 `pi.extensions` 字段：

```json
{
  "name": "pi-extension-with-deps",
  "private": true,
  "type": "module",
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "dependencies": {
    "ms": "2.1.3"
  }
}
```

执行 `npm install`，jiti 自动从扩展自己的 `node_modules/` 解析依赖。

### 5.2 注意事项

- 通过 `pi install npm:...` 发布的扩展，运行时依赖必须在 `dependencies`（不能用 `devDependencies`）
- 包安装默认使用 `npm install --omit=dev`
- 可配置 `npmCommand` 在 `settings.json` 中以兼容 mise 等 wrapper

### 5.3 Node 内置模块

`node:fs`、`node:path` 等可直接 import。

---

## 6. 场景化推荐 / Scenario Routing

当用户描述需求时，按下表定位参考示例：

| 用户场景关键词 | 推荐示例 | 说明 |
|----------------|----------|------|
| "拦截危险命令" | `permission-gate.ts` | `tool_call` 事件 + `ctx.ui.confirm` |
| "保护 .env / 路径" | `protected-paths.ts` | `tool_call` 事件检查 `event.input` |
| "Git 自动存档/checkpoint" | `git-checkpoint.ts` | turn 级别 git stash |
| "退出时自动 commit" | `auto-commit-on-exit.ts` | `session_shutdown` + git commit |
| "自定义压缩摘要" | `custom-compaction.ts` | `session_before_compact` |
| "Sub-agent 子代理" | `subagent/` | 独立上下文窗口委派 |
| "Plan 模式" | `plan-mode/` | 只读探索 + `/plan` 命令 |
| "新工具最小示例" | `hello.ts` | `defineTool` + `registerTool` |
| "启用/禁用工具 UI" | `tools.ts` | `setActiveTools` + `setWidget` + 自定义 UI |
| "动态添加工具" | `dynamic-tools.ts` | `session_start` + `setActiveTools` |
| "覆盖内置 read/edit" | `tool-override.ts` | 同名注册 |
| "自定义渲染" | `built-in-tool-renderer.ts`, `minimal-mode.ts` | `renderCall` / `renderResult` |
| "输出截断" | `truncated-tool.ts` | `truncateHead` |
| "状态行/页脚/Header" | `status-line.ts`, `custom-footer.ts`, `custom-header.ts` | `ctx.ui.setXxx` |
| "编辑框自定义（vim 等）" | `modal-editor.ts` | `ctx.ui.setEditorComponent` |
| "小部件/Widget" | `widget-placement.ts` | `ctx.ui.setWidget` |
| "Tab 自动补全扩展" | `github-issue-autocomplete.ts` | `ctx.ui.addAutocompleteProvider` |
| "桌面通知" | `notify.ts` | OSC 777 序列 |
| "跨扩展通信" | `event-bus.ts` | `pi.events` |
| "消息自定义渲染" | `message-renderer.ts`, `entry-renderer.ts` | `registerMessageRenderer` / `registerEntryRenderer` |
| "会话改名/书签" | `session-name.ts`, `bookmark.ts` | `setSessionName` / `setLabel` |
| "Mac 主题同步" | `mac-system-theme.ts` | 系统集成 |
| "动态资源发现" | `dynamic-resources/` | `resources_discover` 事件 |
| "沙箱执行" | `sandbox/`, `gondolin/` | OS 级别隔离 |
| "SSH 远程执行" | `ssh.ts` | `ReadOperations` / `BashOperations` |
| "自定义 Provider（OAuth）" | `custom-provider-anthropic/` | `pi.registerProvider` + OAuth |
| "GitLab Duo 代理" | `custom-provider-gitlab-duo/` | 复用 pi-ai 流式 |
| "带依赖扩展" | `with-deps/` | 自带 package.json |
| "文件触发" | `file-trigger.ts` | fs.watch |
| "流式 steering 处理" | `input-transform-streaming.ts` | `input` 事件 + streamingBehavior |
| "定时确认" | `timed-confirm.ts` | `AbortSignal` + `timeout` |
| "小游戏" | `snake.ts`, `tic-tac-toe.ts`, `doom-overlay/`, `space-invaders.ts` | `ctx.ui.custom` |

---

## 7. 输出模板 / Output Template

每次生成扩展代码时，按以下结构输出：

### 7.1 模板（最小工具）

```typescript
/**
 * <ToolName> - <一句话描述>
 * 放置位置: ~/.pi/agent/extensions/<name>.ts
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const myTool = defineTool({
  name: "my_tool",
  label: "My Tool",
  description: "What this tool does (shown to LLM)",
  parameters: Type.Object({
    // 用 Type.String / Type.Optional / Type.Integer 等
    input: Type.String({ description: "Input description" }),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    // 1. 检查 signal?.aborted
    if (signal?.aborted) {
      return { content: [{ type: "text", text: "Cancelled" }] };
    }

    // 2. 业务逻辑（必要时用 withFileMutationQueue）
    const result = doWork(params);

    // 3. 截断输出（如有）
    // const truncation = truncateHead(result, { ... });

    // 4. 返回标准结构
    return {
      content: [{ type: "text", text: result }],
      details: { /* 状态/渲染数据 */ },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(myTool);
}
```

### 7.2 输出要点

- **先列范围**（文件路径、注册项、依赖）再写代码
- 包含完整 import 语句
- 默认导出命名遵循 `<name>Extension` 或匿名（参考示例）
- 关键逻辑加中文注释
- 输出末尾给出放置建议和测试命令：
  ```bash
  pi -e ./my-extension.ts          # 临时测试
  # 或复制到 ~/.pi/agent/extensions/  自动加载
  ```

---

## 8. 调试技巧 / Debugging

### 8.1 加载与重载

```bash
pi -e ./my-extension.ts    # 临时测试单文件
pi --extension ./my-ext.ts # 同 -e（可重复）
/reload                    # 会话内热重载（自动发现位置）
```

### 8.2 日志

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event, ctx) => {
    console.log("[my-ext] payload:", JSON.stringify(event.payload, null, 2));
  });

  pi.on("tool_result", (event, ctx) => {
    console.log(`[my-ext] ${event.toolName} result:`, event.content);
  });
}
```

### 8.3 错误排查清单

| 症状 | 检查项 |
|------|--------|
| 扩展未加载 | 路径是否在 `~/.pi/agent/extensions/` 或 `.pi/extensions/`？文件名/目录结构是否正确？执行 `pi --verbose` 启动 |
| TypeScript 报错 | jiti 通常无需编译，但严格类型下需检查 import；查看 jiti 报错 |
| 事件没触发 | 用 `pi.on("event_name", ...)` 确认事件名拼写；用 `console.log` 验证 |
| 工具 LLM 看不到 | 确认 `description` 清晰；`pi.getAllTools()` 检查；`setActiveTools` 是否启用 |
| 覆盖内置工具不生效 | 必须使用同名 + 注册在扩展加载阶段；TUI 会显示警告 |
| Provider 不出现 | `pi --list-models` 检查；`refreshModels` 是否有错 |
| 重载后状态丢失 | 状态应存 `details`，`session_start` 重构 |

### 8.4 性能与内存

- 长任务用 `onUpdate?.({...})` 流式回报
- 大数据结构避免放在闭包里（会阻止 GC）
- 监听器用 `signal` 或在 `session_shutdown` 清理

---

## 9. 工作流程 / Workflow

当用户调用此 skill 时，按以下步骤：

1. **理解需求**：确认扩展类型（工具 / 命令 / 事件 / UI / 组合）
2. **查表定位**：用第 6 节「场景化推荐」找最相近示例
3. **读取 API 详情**：如需精确字段，读取 `docs/extensions.md` 对应章节
4. **列出范围**（按项目规则）：文件路径、注册项、依赖、放置位置
5. **得到用户同意**后生成代码
6. **输出**：完整 `.ts` 文件内容 + 放置建议 + 测试命令

### 决策树

```
用户需求
├─ 工具？
│  ├─ 简单只读 → hello.ts 模板
│  ├─ 需要状态 → details 持久化
│  ├─ 修改文件 → withFileMutationQueue
│  └─ 大量输出 → 截断
├─ 命令？
│  ├─ 简单通知 → registerCommand
│  ├─ 需要 UI → ctx.ui.custom
│  └─ 需要等待 → ctx.waitForIdle
├─ 事件钩子？
│  ├─ 改写 → tool_call / tool_result / context / input
│  ├─ 阻塞 → tool_call { block: true } / session_before_*
│  └─ 通知型 → 其余
├─ UI？
│  ├─ 状态栏 → setStatus / setFooter / setHeader
│  ├─ 弹窗 → setWidget / ui.custom
│  ├─ 编辑器 → setEditorComponent
│  └─ 流式指示 → setWorkingMessage / Indicator
├─ Provider？
│  ├─ 简单代理 → registerProvider(name, config)
│  ├─ 自定义 OAuth → registerProvider + oauth 字段
│  └─ 完整自定义 → createProvider + registerProvider
└─ 复合？
   └─ 多文件目录 + package.json（参考 with-deps）
```

---

## 10. 参考资源 / References

| 资源 | 路径 |
|------|------|
| API 详细文档（必读） | `node_modules\@earendil-works\pi-coding-agent\docs\extensions.md` |
| 示例索引 | `node_modules\@earendil-works\pi-coding-agent\examples\extensions\README.md` |
| 最小工具示例 | `examples/extensions/hello.ts` |
| 工具管理示例 | `examples/extensions/tools.ts` |
| 带依赖示例 | `examples/extensions/with-deps/` |
| TUI 组件 API | `docs/tui.md` |
| 自定义 Provider | `docs/custom-provider.md` |
| SDK 集成 | `docs/sdk.md` |
| 打包发布 | `docs/packages.md` |
| 键位系统 | `docs/keybindings.md` |
| 主题系统 | `docs/themes.md` |

---

**记住**：遵循项目规则 — "修改或创建文件前，必须先列出改动范围，得到用户明确同意后才能开始实行。"