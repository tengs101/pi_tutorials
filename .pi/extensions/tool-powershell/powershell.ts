/**
 * PowerShell tool implementation for pi.
 *
 * Reference: dist/core/tools/bash.js (built-in bash tool).
 * Self-contained — does NOT import pi's internal modules so the extension
 * remains stable across pi version bumps.
 */

import { constants } from "node:fs";
import { access as fsAccess, stat as fsStat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { isAbsolute, join as joinPath, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { type Static, Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
  type AgentToolUpdateCallback,
  type Theme,
  DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize,
  truncateToVisualLines, truncateTail,
  keyHint,
  defineTool,
} from "@earendil-works/pi-coding-agent";

// ============================================================================
// Constants
// ============================================================================

/** PowerShell flags applied to every invocation (command or -File mode). */
const PS_FLAGS = [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy", "Bypass",
] as const;

const PREVIEW_LINES = 5;
const UPDATE_THROTTLE_MS = 100;
const TEMP_FILE_PREFIX = "pi-powershell";

/** Shell probing timeout — pwsh cold start is usually < 2s. */
const SHELL_PROBE_TIMEOUT_MS = 5000;

const WIN_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;
const UNIX_CANDIDATES = ["pwsh"] as const;

// ============================================================================
// Schema
// ============================================================================

const powerShellSchema = Type.Object({
  run: Type.Optional(StringEnum(["command", "file"] as const, {
    description:
      "Execution mode. 'command' (default) runs inline PowerShell via stdin; " +
      "'file' invokes a .ps1 script via -File <path> [args...]. The script's " +
      "exit code is propagated.",
  })),
  command: Type.Optional(Type.String({
    description:
      "PowerShell command(s) to execute. Required when run='command' (default). " +
      "Ignored when run='file'. The wrapper appends `; exit $LASTEXITCODE` so " +
      "exit codes from native commands invoked by PowerShell are propagated.",
  })),
  scriptPath: Type.Optional(Type.String({
    description:
      "Path to a .ps1 script. Required when run='file'. Resolved relative to " +
      "cwd if not absolute.",
  })),
  scriptArgs: Type.Optional(Type.Array(Type.String(), {
    description:
      "Arguments passed to the script (appended after -File <path>). " +
      "Only used in file mode. Each argument is passed as a single string.",
  })),
  timeout: Type.Optional(Type.Number({
    description:
      "Timeout in seconds (optional, no default timeout). On timeout the entire " +
      "process tree is killed and an error is thrown.",
  })),
});

export type PowerShellInput = Static<typeof powerShellSchema>;

// ============================================================================
// Shell detection (cached)
// ============================================================================

let cachedShell: string | null = null;

export async function findPowerShellShell(): Promise<string> {
  if (cachedShell) return cachedShell;
  const candidates = process.platform === "win32" ? WIN_CANDIDATES : UNIX_CANDIDATES;

  for (const candidate of candidates) {
    if (await canExecute(candidate)) {
      cachedShell = candidate;
      return candidate;
    }
  }

  const installHint = process.platform === "win32"
    ? "Install PowerShell 7+ (https://aka.ms/powershell) — Windows PowerShell 5.1 " +
      "is also accepted but pwsh is strongly preferred."
    : "Install PowerShell 7+ via https://aka.ms/powershell or your package manager " +
      "(brew install --cask powershell / apt install powershell / etc.).";

  throw new Error(
    `PowerShell executable not found. Tried: ${candidates.join(", ")}. ${installHint}`
  );
}

function canExecute(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve(ok);
    };

    // Cheapest possible probe: -Command '$true' exits 0 on success, non-zero on parse error.
    const child = spawn(
      cmd,
      [...PS_FLAGS, "-Command", "$true"],
      { stdio: "ignore", windowsHide: true }
    );
    child.on("error", () => finish(false));
    child.on("exit", (code) => finish(code === 0));
    setTimeout(() => finish(false), SHELL_PROBE_TIMEOUT_MS);
  });
}

// ============================================================================
// Process management — cross-platform killProcessTree
// ============================================================================

/**
 * Kill a process and all its descendants.
 * - Windows: taskkill /T /F (most reliable for PowerShell child trees).
 * - POSIX:   SIGTERM to the negative process group (process was spawned detached).
 */
export async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("exit", () => resolve());
      killer.on("error", () => resolve());
      setTimeout(resolve, 3000);
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
    // Escalate after grace period
    setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
      try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    }, 1500).unref();
  }
}

/**
 * Wait for a child process to exit, working around Node's stdio hang on Windows
 * when grand-children inherit stdio handles.
 */
function waitForChildProcess(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

// ============================================================================
// OutputAccumulator — minimal self-contained reimplementation
// ============================================================================
//
// We can't import the internal OutputAccumulator from pi without coupling to
// internal paths. This covers the same semantics we need:
//   - decode UTF-8 chunks incrementally
//   - keep a rolling window of recent bytes (so snapshot() is fast)
//   - overflow to a temp file once output exceeds DEFAULT_MAX_BYTES
//
// What we don't replicate: per-line / per-byte truncation metadata that bash
// uses for rich truncation messages. We fall back to truncateTail on snapshot().

interface SimpleAccumulatorOptions {
  maxBytes?: number;
  tempFilePrefix?: string;
}

class SimpleOutputAccumulator {
  private readonly maxBytes: number;
  private readonly tempFilePrefix: string;
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private chunks: Buffer[] = [];
  private chunkBytes = 0;
  private totalRawBytes = 0;
  private finished = false;
  private tempFilePath?: string;
  private tempFileStream?: ReturnType<typeof createWriteStream>;
  private persistentText = "";   // written to temp file when overflow
  private rawOverflowed = false; // true once we've started dumping to temp file

  constructor(options: SimpleAccumulatorOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.tempFilePrefix = options.tempFilePrefix ?? "pi-ext";
  }

  append(data: Buffer): void {
    if (this.finished) return;
    this.totalRawBytes += data.length;

    if (!this.rawOverflowed && this.totalRawBytes > this.maxBytes) {
      this.openTempFile();
    }

    if (this.rawOverflowed) {
      // Stream decode + write to file (clean CRLF normalization)
      const text = this.decoder.decode(data, { stream: true }).replace(/\r/g, "");
      this.persistentText += text;
      this.tempFileStream?.write(text);
      // We don't need to keep all this in memory — keep only the last maxBytes raw
      this.chunks = [];
      this.chunkBytes = 0;
    } else {
      this.chunks.push(data);
      this.chunkBytes += data.length;
      // Trim rolling buffer to ~2x limit
      while (this.chunkBytes > this.maxBytes * 2 && this.chunks.length > 1) {
        const removed = this.chunks.shift()!;
        this.chunkBytes -= removed.length;
      }
    }
  }

  private openTempFile(): void {
    if (this.tempFilePath) return;
    const id = randomBytes(8).toString("hex");
    this.tempFilePath = joinPath(
      tmpdir(),
      `${this.tempFilePrefix}-${id}.log`,
    );
    this.tempFileStream = createWriteStream(this.tempFilePath);
    // Flush whatever we've buffered so far
    const buffered = Buffer.concat(this.chunks);
    const text = this.decoder.decode(buffered, { stream: false }).replace(/\r/g, "");
    this.persistentText = text;
    this.tempFileStream.write(text);
    this.chunks = [];
    this.chunkBytes = 0;
    this.rawOverflowed = true;
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (this.rawOverflowed) {
      // Flush any pending decode state
      const tail = this.decoder.decode().replace(/\r/g, "");
      this.persistentText += tail;
      this.tempFileStream?.write(tail);
    }
  }

  snapshot(): {
    content: string;
    truncation: ReturnType<typeof truncateTail>;
    fullOutputPath?: string;
  } {
    let text: string;
    if (this.rawOverflowed) {
      // Use the persistent text (may itself exceed maxBytes — truncate it)
      const tail = this.decoder.decode().replace(/\r/g, "");
      text = this.persistentText + tail;
      this.persistentText = text;
    } else {
      const buffered = Buffer.concat(this.chunks);
      text = this.decoder.decode(buffered, { stream: false }).replace(/\r/g, "");
    }

    const truncation = truncateTail(text, { maxBytes: this.maxBytes });
    return {
      content: truncation.truncated ? truncation.content : text,
      truncation,
      fullOutputPath: this.tempFilePath,
    };
  }

  async closeTempFile(): Promise<void> {
    if (!this.tempFileStream) return;
    await new Promise<void>((resolve) => {
      this.tempFileStream!.end(() => resolve());
    });
  }

  /** Bytes of the last (possibly partial) line — used for truncation warnings. */
  getLastLineBytes(): number {
    if (this.rawOverflowed) {
      const tail = this.persistentText;
      const lastNl = tail.lastIndexOf("\n");
      return tail.length - lastNl - 1;
    }
    const text = Buffer.concat(this.chunks).toString("utf-8");
    const lastNl = text.lastIndexOf("\n");
    return text.length - lastNl - 1;
  }
}

// ============================================================================
// Rendering helpers
// ============================================================================

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try { return JSON.stringify(value); } catch { return null; }
}

function invalidArgText(theme: Theme): string {
  return theme.fg("warning", "<invalid>");
}

function formatPowerShellCall(args: PowerShellInput, theme: Theme): string {
  const mode = args.run ?? "command";
  const timeoutSuffix = args.timeout
    ? theme.fg("muted", ` (timeout ${args.timeout}s)`)
    : "";

  if (mode === "file") {
    const path = str(args.scriptPath);
    const argsList = (args.scriptArgs ?? []).map((a) => str(a) ?? invalidArgText(theme)).join(" ");
    const pathDisplay = path === null
      ? invalidArgText(theme)
      : path
        ? (argsList ? `${path} ${argsList}` : path)
        : theme.fg("toolOutput", "...");
    return theme.fg("toolTitle", theme.bold(`📜 ${pathDisplay}`)) + timeoutSuffix;
  }

  const command = str(args.command);
  const commandDisplay = command === null
    ? invalidArgText(theme)
    : command
      ? command
      : theme.fg("toolOutput", "...");
  return theme.fg("toolTitle", theme.bold(`> ${commandDisplay}`)) + timeoutSuffix;
}

function getTextOutput(result: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
  const content = result?.content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c?.type === "text")
      .map((c) => c.text ?? "")
      .join("");
  }
  return "";
}

class PowerShellResultComponent extends Container {
  state: {
    cachedWidth: number | undefined;
    cachedLines: string[] | undefined;
    cachedSkipped: number | undefined;
  } = { cachedWidth: undefined, cachedLines: undefined, cachedSkipped: undefined };
}

function formatDuration(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function rebuildResultComponent(
  component: PowerShellResultComponent,
  result: { content?: Array<{ type?: string; text?: string }>; details?: { truncation?: ReturnType<typeof truncateTail>; fullOutputPath?: string } },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  startedAt: number | undefined,
  endedAt: number | undefined,
): void {
  const state = component.state;
  component.clear();

  let output = getTextOutput(result).trim();
  const truncation = result?.details?.truncation;
  const fullOutputPath = result?.details?.fullOutputPath;

  // Strip the truncation footer that we appended to the text (so re-render
  // during partial updates doesn't double up the warning).
  if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
    const footerStart = output.lastIndexOf("\n\n[");
    if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
      output = output.slice(0, footerStart).trimEnd();
    }
  }

  if (output) {
    const styledOutput = output
      .split("\n")
      .map((line) => theme.fg("toolOutput", line))
      .join("\n");

    if (options.expanded) {
      component.addChild(new Text(`\n${styledOutput}`, 0, 0));
    } else {
      component.addChild({
        render: (width: number) => {
          if (state.cachedLines === undefined || state.cachedWidth !== width) {
            const preview = truncateToVisualLines(styledOutput, PREVIEW_LINES, width);
            state.cachedLines = preview.visualLines;
            state.cachedSkipped = preview.skippedCount;
            state.cachedWidth = width;
          }
          if (state.cachedSkipped && state.cachedSkipped > 0) {
            const hint = theme.fg("muted", `... (${state.cachedSkipped} earlier lines,`) +
              ` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
            return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
          }
          return ["", ...(state.cachedLines ?? [])];
        },
        invalidate: () => {
          state.cachedWidth = undefined;
          state.cachedLines = undefined;
          state.cachedSkipped = undefined;
        },
      });
    }
  }

  if (truncation?.truncated || fullOutputPath) {
    const warnings: string[] = [];
    if (fullOutputPath) warnings.push(`Full output: ${fullOutputPath}`);
    if (truncation?.truncated) {
      const lines = `Showing ${truncation.outputLines} of ${truncation.totalLines} lines`;
      const size = formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES);
      warnings.push(
        truncation.truncatedBy === "lines"
          ? `Truncated: ${lines}`
          : `Truncated: ${lines} (${size} limit)`,
      );
    }
    component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
  }

  if (startedAt !== undefined) {
    const label = options.isPartial ? "Elapsed" : "Took";
    const endTime = endedAt ?? Date.now();
    component.addChild(
      new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0),
    );
  }
}

// ============================================================================
// Execution — spawn pwsh + stream output + handle timeout/abort
// ============================================================================

async function resolveModeArgs(
  mode: "command" | "file",
  params: PowerShellInput,
  cwd: string,
): Promise<{ args: string[]; stdinContent?: string }> {
  if (mode === "command") {
    if (!params.command) {
      throw new Error(
        "Missing required parameter 'command' for run='command' (default) mode.",
      );
    }
    // -Command - reads the script block from stdin. This avoids command-line
    // length limits and quoting hell with double quotes inside the command.
    //
    // Append `; exit $LASTEXITCODE` so any native command's exit code is
    // propagated through pwsh's own exit code (otherwise pwsh exits 0 if the
    // last PowerShell statement succeeded, regardless of what the wrapped
    // native command returned).
    const stdinContent = `${params.command}\n; exit $LASTEXITCODE\n`;
    return {
      args: [...PS_FLAGS, "-Command", "-"],
      stdinContent,
    };
  }

  // file mode
  if (!params.scriptPath) {
    throw new Error("Missing required parameter 'scriptPath' for run='file' mode.");
  }
  const absPath = isAbsolute(params.scriptPath)
    ? params.scriptPath
    : resolvePath(cwd, params.scriptPath);
  // Verify script exists and is readable
  try {
    const st = await fsStat(absPath);
    if (!st.isFile()) {
      throw new Error(`Script path is not a regular file: ${absPath}`);
    }
    await fsAccess(absPath, constants.R_OK);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Script path")) throw err;
    throw new Error(`Script file not found or not readable: ${absPath}`);
  }
  return {
    args: [...PS_FLAGS, "-File", absPath, ...(params.scriptArgs ?? [])],
  };
}

function buildEnv(params: { cwd: string }, ctx: any): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Unset to avoid stale values if ctx is missing
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  delete env.PI_PROVIDER;
  delete env.PI_MODEL;
  delete env.PI_REASONING_LEVEL;

  if (ctx?.sessionManager) {
    try { env.PI_SESSION_ID = ctx.sessionManager.getSessionId(); } catch { /* ignore */ }
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (sessionFile) env.PI_SESSION_FILE = sessionFile;
    } catch { /* ignore */ }
  }
  const model = ctx?.model;
  if (model) {
    env.PI_PROVIDER = model.provider;
    env.PI_MODEL = model.id;
  }
  if (ctx?.thinkingLevel) {
    env.PI_REASONING_LEVEL = ctx.thinkingLevel;
  }
  env.PWD = params.cwd; // PowerShell reads $PWD on startup
  return env;
}

async function runPowerShell(opts: {
  shell: string;
  args: string[];
  stdinContent?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout?: number;
  signal?: AbortSignal;
  onData: (data: Buffer) => void;
}): Promise<{ exitCode: number | null }> {
  // Cwd sanity check (fail fast with a clear error)
  try {
    await fsAccess(opts.cwd, constants.F_OK);
  } catch {
    throw new Error(`Working directory does not exist: ${opts.cwd}\nCannot execute PowerShell commands.`);
  }

  if (opts.signal?.aborted) throw new Error("aborted");

  const child = spawn(opts.shell, opts.args, {
    cwd: opts.cwd,
    detached: process.platform !== "win32",
    env: opts.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  // Track so SIGINT (Ctrl+C in TUI) propagates to the whole tree
  // (bash's trackDetachedChildPid is internal; we replicate the minimal piece.)
  const pid = child.pid;

  let stdinClosed = false;
  const closeStdin = () => {
    if (stdinClosed) return;
    stdinClosed = true;
    try { child.stdin?.end(opts.stdinContent ?? ""); } catch { /* ignore */ }
  };
  if (opts.stdinContent !== undefined) {
    child.stdin?.on("error", () => { /* ignore EPIPE on broken pipe */ });
    // Close stdin on next tick so pwsh is ready to read
    setImmediate(closeStdin);
  } else {
    closeStdin();
  }

  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;

  const onAbort = () => {
    if (pid != null) void killProcessTree(pid);
  };

  try {
    if (opts.timeout !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        if (pid != null) void killProcessTree(pid);
      }, opts.timeout * 1000);
    }
    child.stdout?.on("data", opts.onData);
    child.stderr?.on("data", opts.onData);

    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const exitCode = await waitForChildProcess(child);

    if (opts.signal?.aborted) throw new Error("aborted");
    if (timedOut) throw new Error(`timeout:${opts.timeout}`);
    return { exitCode };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
    // Ensure stdin is closed so child never hangs on a write
    closeStdin();
  }
}

// ============================================================================
// Tool definition
// ============================================================================

export function createPowerShellTool(cwd: string) {
  return defineTool({
    name: "powershell",
    label: "PowerShell",

    description:
      `Execute PowerShell commands or run a script file (.ps1). Cross-platform: prefers ` +
      `PowerShell 7+ ('pwsh') and falls back to Windows PowerShell 5.1 ('powershell.exe') on ` +
      `Windows. Works on Windows, Linux, and macOS.

` +
      `TWO MODES:
` +
      `  1. 'command' (default) — runs inline PowerShell via stdin to pwsh with flags ` +
      `-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass. The -Command - form reads ` +
      `the script block from stdin, avoiding command-line length limits and quoting issues.
` +
      `  2. 'file' — invokes a script via -File <scriptPath> [<args...>]. The script's exit ` +
      `code is propagated.

` +
      `STREAM BEHAVIOR:
` +
      `  - stdout and stderr are merged (PowerShell streams them together by default).
` +
      `  - To separate: redirect with '2>&1' or '*>&1 | Write-Host' as needed.

` +
      `OUTPUT HANDLING:
` +
      `  - Output is truncated to the last ${DEFAULT_MAX_LINES} lines or ` +
      `${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).
` +
      `  - If truncated, the full output is saved to a temp file and its path is included ` +
      `in the result.
` +
      `  - Long-running commands stream partial output every ~100ms.

` +
      `EXIT CODE SEMANTICS:
` +
      `  - For native commands invoked from PowerShell, $LASTEXITCODE is propagated (the ` +
      `wrapper appends '; exit $LASTEXITCODE').
` +
      `  - For pure PowerShell statements, exit code is 0 on success, non-zero on uncaught ` +
      `error.
` +
      `  - On timeout, the entire process tree is killed and an error is thrown.

` +
      `ENVIRONMENT:
` +
      `  - Working directory is the current pi cwd.
` +
      `  - Session metadata is exposed as $env:PI_SESSION_ID, $env:PI_MODEL, $env:PI_PROVIDER, ` +
      `$env:PI_SESSION_FILE, $env:PI_REASONING_LEVEL.

` +
      `WHEN TO PREFER THIS OVER THE 'bash' TOOL:
` +
      `  - Windows cmdlets (Get-ChildItem, Get-Process, Get-Service, etc.)
` +
      `  - Accessing .NET / COM / WMI / the Windows Registry
` +
      `  - Cross-platform scripting that needs identical behavior on Windows + *nix
` +
      `  - Structured object pipelines (Select-Object, Where-Object, Group-Object, Format-Table)
` +
      `  - The bash tool stays better for POSIX-only tooling: grep/awk/sed/curl/jq/etc.

` +
      `FORMATTING NOTES (important for Windows PowerShell 5.1):
` +
      `  - In non-interactive capture (such as this tool's stdin/stdout pipe), pipelines that ` +
      `produce objects MUST end with ` + "`| Format-Table -AutoSize | Out-String`" + ` (or ` +
      "`| Format-List | Out-String`" + `) to force text output.
` +
      `  - Without explicit formatting, Windows PowerShell 5.1 falls back to its default ` +
      `formatter which can mis-render FileInfo and other objects (e.g. showing files as if they ` +
      `were processes — observed in pipeline tests).
` +
      `  - PowerShell 7+ (pwsh) is more forgiving but explicit formatting is still recommended ` +
      `for portability.
` +
      `  - For pure data export, use ` + "`| ConvertTo-Json -Depth 5`" + ` or ` +
      "`| ConvertTo-Csv -NoTypeInformation`" + ` instead of Format-*; the LLM parses these ` +
      `directly without ambiguity.`,

    promptSnippet:
      "Run PowerShell commands. Use for Windows cmdlets (Get-*, .NET, WMI, registry) and cross-platform pwsh scripting. Supports inline commands or -File script mode. Tip: end object-producing pipelines with `| Format-Table -AutoSize | Out-String` for reliable text output.",

    promptGuidelines: [
      "The 'powershell' tool runs PowerShell (pwsh preferred, powershell.exe fallback on Windows). It is independent of the 'bash' tool — pick the one whose ecosystem matches the task.",
      "Default mode is inline 'command' via stdin; set 'run: \"file\"' with 'scriptPath' (and optionally 'scriptArgs') to run a .ps1 file via -File.",
      "Inspect $env:PI_* variables for current model and session details.",
      "stdout and stderr are merged; redirect with '2>&1' or '*>&1' if separation is required.",
      "Exit code semantics: $LASTEXITCODE from native commands is auto-propagated; pure PowerShell statements yield 0 on success, non-zero on error.",
    ],

    parameters: powerShellSchema,

    async execute(_toolCallId, params, signal, onUpdate: AgentToolUpdateCallback<unknown> | undefined, ctx) {
      const mode = params.run ?? "command";

      // 1) Resolve shell (cached)
      const shell = await findPowerShellShell();

      // 2) Build args + stdin content based on mode
      const { args, stdinContent } = await resolveModeArgs(mode, params, cwd);

      // 3) Build env (with PI_* + PWD)
      const env = buildEnv({ cwd }, ctx);

      // 4) Output accumulator + throttled streaming updates
      const output = new SimpleOutputAccumulator({ tempFilePrefix: TEMP_FILE_PREFIX });
      let acceptingOutput = true;
      let updateTimer: NodeJS.Timeout | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;

      const emitUpdate = () => {
        if (!onUpdate || !updateDirty) return;
        updateDirty = false;
        lastUpdateAt = Date.now();
        const snapshot = output.snapshot();
        onUpdate({
          content: [{ type: "text", text: snapshot.content || "" }],
          details: {
            truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
            fullOutputPath: snapshot.fullOutputPath,
          },
        });
      };
      const clearTimer = () => {
        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }
      };
      const scheduleUpdate = () => {
        if (!onUpdate) return;
        updateDirty = true;
        const delay = UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
        if (delay <= 0) {
          clearTimer();
          emitUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitUpdate();
        }, delay);
      };

      if (onUpdate) onUpdate({ content: [], details: undefined });

      const handleData = (data: Buffer) => {
        if (!acceptingOutput) return;
        output.append(data);
        scheduleUpdate();
      };

      const finishOutput = async () => {
        acceptingOutput = false;
        output.finish();
        clearTimer();
        emitUpdate();
        const snapshot = output.snapshot();
        await output.closeTempFile();
        return snapshot;
      };

      const formatOutput = (
        snapshot: { content: string; truncation: ReturnType<typeof truncateTail>; fullOutputPath?: string },
        emptyText = "(no output)"
      ): { text: string; details: { truncation: ReturnType<typeof truncateTail>; fullOutputPath?: string } | undefined } => {
        const truncation = snapshot.truncation;
        let text = snapshot.content || emptyText;
        let details: { truncation: ReturnType<typeof truncateTail>; fullOutputPath?: string } | undefined;
        if (truncation.truncated) {
          details = { truncation, fullOutputPath: snapshot.fullOutputPath };
          const startLine = truncation.totalLines - truncation.outputLines + 1;
          const endLine = truncation.totalLines;
          if (truncation.lastLinePartial) {
            const lastLineSize = formatSize(output.getLastLineBytes());
            text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
          } else if (truncation.truncatedBy === "lines") {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
          } else {
            text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
          }
        }
        return { text, details };
      };

      const appendStatus = (text: string, status: string) =>
        `${text ? `${text}\n\n` : ""}${status}`;

      try {
        let exitCode: number | null;
        try {
          const result = await runPowerShell({
            shell,
            args,
            stdinContent,
            cwd,
            env,
            timeout: params.timeout,
            signal,
            onData: handleData,
          });
          exitCode = result.exitCode;
        } catch (err) {
          const snapshot = await finishOutput();
          const { text } = formatOutput(snapshot, "");
          if (err instanceof Error && err.message === "aborted") {
            throw new Error(appendStatus(text, "PowerShell command aborted"));
          }
          if (err instanceof Error && err.message.startsWith("timeout:")) {
            const timeoutSecs = err.message.split(":")[1];
            throw new Error(appendStatus(text, `PowerShell command timed out after ${timeoutSecs} seconds`));
          }
          throw err;
        }

        const snapshot = await finishOutput();
        const { text: outputText, details } = formatOutput(snapshot);
        if (exitCode !== 0 && exitCode !== null) {
          throw new Error(appendStatus(outputText, `PowerShell exited with code ${exitCode}`));
        }
        return { content: [{ type: "text", text: outputText }], details };
      } finally {
        clearTimer();
      }
    },

    renderCall(args, theme, context: { state?: any; executionStarted?: boolean; lastComponent?: any }) {
      const state = context.state ?? (context.state = {});
      if (context.executionStarted && state.startedAt === undefined) {
        state.startedAt = Date.now();
        state.endedAt = undefined;
      }
      const text: Text = context.lastComponent ?? new Text("", 0, 0);
      text.setText(formatPowerShellCall(args, theme));
      return text;
    },

    renderResult(
      result: { content?: Array<{ type?: string; text?: string }>; details?: { truncation?: ReturnType<typeof truncateTail>; fullOutputPath?: string } },
      options: { expanded: boolean; isPartial: boolean },
      theme: Theme,
      context: { state?: any; isError?: boolean; invalidate?: () => void; lastComponent?: any }
    ) {
      const state = context.state ?? (context.state = {});
      if (state.startedAt !== undefined && options.isPartial && !state.interval) {
        state.interval = setInterval(() => context.invalidate?.(), 1000);
      }
      if (!options.isPartial || context.isError) {
        state.endedAt ??= Date.now();
        if (state.interval) {
          clearInterval(state.interval);
          state.interval = undefined;
        }
      }
      const component: PowerShellResultComponent = context.lastComponent ?? new PowerShellResultComponent();
      rebuildResultComponent(component, result, options, theme, state.startedAt, state.endedAt);
      component.invalidate?.();
      return component;
    },
  });
}