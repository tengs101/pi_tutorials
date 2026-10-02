/**
 * disable-bash.ts — 项目级扩展：仅禁用内置 bash 工具
 *
 * 作用域: 仅当前项目（.pi/extensions/ 是项目级作用域）
 * 目的:   移除 bash，但保留全部其他工具——包括扩展注册的工具
 *         （Agent / SubagentWorkflow / web_search / obsidian_cli / mcp ...）
 *
 * ⚠️ 修复记录 (2026-09):
 *   旧实现用的是“白名单”语义：
 *       pi.setActiveTools(["read", "write", "edit", "powershell"])
 *   这会把可用工具限制成那 4 个，导致【所有扩展工具被隐藏】
 *   （pi-subagents / pi-web-access / pi-obsidian / pi-codex-image-gen
 *    / pi-goal / MCP 子工具 等全部失效）。
 *   现改为“先取当前激活列表，再过滤掉 bash”，只移除 bash，其余不动。
 *
 * 注意: setActiveTools 必须在事件处理器里调用（如 session_start），
 *       扩展加载阶段调用会报 "Extension runtime not initialized"。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// 每次会话生命周期开始时执行，覆盖 startup / new / resume / fork / reload
	pi.on("session_start", () => {
		// 只移除 bash；保留内置其余工具 + 所有扩展工具
		const active = pi.getActiveTools();
		pi.setActiveTools(active.filter((name) => name !== "bash"));
	});
}
