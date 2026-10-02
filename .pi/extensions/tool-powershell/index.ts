/**
 * PowerShell tool extension for pi.
 *
 * Adds a `powershell` tool that runs cross-platform PowerShell (pwsh preferred,
 * Windows PowerShell 5.1 fallback). Supports two execution modes:
 *   - 'command' (default): runs inline PowerShell via stdin
 *   - 'file': invokes a .ps1 script via -File <path> [args...]
 *
 * Registered AND activated by default — no need to add to active tools manually.
 * Placement: .pi/extensions/tool-powershell/index.ts (project-level).
 *
 * Note: if another extension (e.g. `minimal-tools`) overrides active tools in
 * `session_start`, we re-add powershell in `before_agent_start` to keep it
 * visible to the LLM.
 *
 * Test:  pi -e ./.pi/extensions/tool-powershell/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPowerShellTool } from "./powershell.ts";

export default function (pi: ExtensionAPI) {
  // 工具在工厂里绑定 cwd。同名 registerTool() 会替换已注册的实例，
  // 所以我们在 session_start 里按当前 cwd 重新注册，确保 /cd 等命令
  // 切换工作目录后工具仍指向正确的 cwd。
  const ensureRegistered = () => {
    try {
      // 只注册一次（同名 registerTool 会覆盖）。getAllTools() 检查避免重复。
      const existing = pi.getAllTools().some((t) => t.name === "powershell");
      if (!existing) {
        pi.registerTool(createPowerShellTool(process.cwd()));
      }
    } catch {
      // 静默失败 —— 工具可能已存在
    }
  };

  // 首次注册（基于初始 cwd）
  ensureRegistered();

  // 工具的"默认激活"必须在每次会话开始时重设（其他扩展如 minimal-tools
  // 可能会在 session_start 中调用 setActiveTools 覆盖白名单）。
  // 我们既在 session_start 也在 before_agent_start 尝试加入 powershell，
  // 确保它对 LLM 始终可见。
  const ensureActive = () => {
    try {
      const active = pi.getActiveTools();
      if (!active.includes("powershell")) {
        pi.setActiveTools([...active, "powershell"]);
      }
    } catch {
      // 静默失败 —— runtime 可能还未初始化
    }
  };

  pi.on("session_start", () => {
    ensureRegistered();
    ensureActive();
  });

  // 每个 turn 开始前重新确认 —— 防备其他扩展在 session 中途改 active 列表。
  pi.on("before_agent_start", () => {
    ensureActive();
  });
}