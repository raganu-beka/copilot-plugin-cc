/**
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable } from "./process.mjs";

const COPILOT_COMMAND = "copilot";
const TASK_SESSION_PREFIX = "Copilot Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";
export const COPILOT_INSTALL_HINT =
  "GitHub Copilot CLI is not installed. Install it with `npm install -g @github/copilot`, then rerun `/copilot:setup`.";

const READ_ONLY_SHELL_COMMANDS = [
  "git status",
  "git diff",
  "git log",
  "git show",
  "git blame",
  "git ls-files",
  "git rev-parse",
  "git merge-base",
  "git grep",
  "git cat-file",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "rg",
  "grep",
  "Get-Content",
  "Get-ChildItem",
  "Select-String"
];

const SHELL_TOOL_PATTERN = /^(bash|sh|zsh|shell|powershell|pwsh)$/i;
const EDIT_TOOL_PATTERN = /^(apply_patch|edit|create|write|str_replace|str_replace_editor|insert|multi_edit)$/i;
const SUBAGENT_TOOL_PATTERN = /^(task|subagent|delegate)$/i;
const SEARCH_TOOL_PATTERN = /^(web_search|web_fetch|fetch)$/i;
const TOKEN_ENV_NAMES = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"];

function cleanCopilotStderr(stderr) {
  return String(stderr ?? "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

function sanitizeSessionName(text) {
  return String(text ?? "")
    .replace(/[^A-Za-z0-9 ._:,-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildTaskSessionName(prompt) {
  const excerpt = shorten(sanitizeSessionName(prompt), 56);
  return excerpt ? `${TASK_SESSION_PREFIX}: ${excerpt}` : TASK_SESSION_PREFIX;
}

function quoteForCmd(arg) {
  const value = String(arg);
  if (/^[A-Za-z0-9_\-.,:=/\\@+]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function spawnCopilot(args, options = {}) {
  const spawnOptions = {
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true
  };
  if (process.platform === "win32") {
    return spawn([COPILOT_COMMAND, ...args].map(quoteForCmd).join(" "), [], { ...spawnOptions, shell: true });
  }
  return spawn(COPILOT_COMMAND, args, spawnOptions);
}

function buildPermissionArgs(write) {
  if (write) {
    return ["--allow-all-tools"];
  }
  return [
    "--deny-tool=write",
    ...READ_ONLY_SHELL_COMMANDS.map((command) => `--allow-tool=shell(${command})`)
  ];
}

export function buildCopilotArgs(options = {}) {
  const args = ["--output-format", "json", "--no-ask-user"];
  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  } else {
    args.push("--session-id", options.sessionId);
    const sessionName = sanitizeSessionName(options.sessionName);
    if (sessionName) {
      args.push("--name", sessionName);
    }
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--reasoning-effort", options.effort);
  }
  args.push(...buildPermissionArgs(Boolean(options.write)));
  return args;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function looksLikeReadableReasoning(text) {
  return /\s/.test(text) && !/^[A-Za-z0-9+/=]{80,}$/.test(text.replace(/\s+/g, ""));
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

function readToolCommand(data) {
  const args = data?.arguments;
  if (args && typeof args === "object" && typeof args.command === "string") {
    return args.command;
  }
  return null;
}

function collectPatchPaths(patchText) {
  const paths = [];
  for (const match of String(patchText ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    paths.push(match[1].trim());
  }
  return paths;
}

function collectEditPaths(data) {
  const args = data?.arguments;
  if (typeof args === "string") {
    return collectPatchPaths(args);
  }
  if (args && typeof args === "object") {
    const candidate = args.path ?? args.file_path ?? args.filePath ?? null;
    return typeof candidate === "string" && candidate ? [candidate] : [];
  }
  return [];
}

function isSubagentEvent(data) {
  return Boolean(data?.parentToolCallId ?? data?.agentId ?? null);
}

function createRunState(sessionId, onProgress) {
  return {
    sessionId,
    onProgress: onProgress ?? null,
    finalMessage: "",
    finalAnswerSeen: false,
    reasoningSummary: [],
    error: null,
    resultEvent: null,
    toolCalls: new Map(),
    touchedFiles: new Set(),
    commandExecutions: []
  };
}

function describeToolStart(data) {
  const toolName = String(data?.toolName ?? "tool");
  const command = readToolCommand(data);
  if (command && (SHELL_TOOL_PATTERN.test(toolName) || !EDIT_TOOL_PATTERN.test(toolName))) {
    return {
      message: `Running command: ${shorten(command, 96)}`,
      phase: looksLikeVerificationCommand(command) ? "verifying" : "running"
    };
  }
  if (EDIT_TOOL_PATTERN.test(toolName)) {
    const paths = collectEditPaths(data);
    return {
      message: paths.length > 0 ? `Editing ${paths.join(", ")}.` : `Applying file changes via ${toolName}.`,
      phase: "editing"
    };
  }
  if (SUBAGENT_TOOL_PATTERN.test(toolName)) {
    return { message: `Starting subagent via ${toolName}.`, phase: "investigating" };
  }
  if (SEARCH_TOOL_PATTERN.test(toolName)) {
    const query = data?.arguments?.query ?? data?.arguments?.url ?? "";
    return { message: `Searching: ${shorten(query || toolName, 96)}`, phase: "investigating" };
  }
  return { message: `Running tool: ${toolName}.`, phase: "investigating" };
}

function describeToolComplete(state, data) {
  const started = state.toolCalls.get(data?.toolCallId) ?? null;
  const toolName = String(started?.toolName ?? data?.toolName ?? "tool");
  const succeeded = data?.success !== false;
  const statusLabel = succeeded ? "completed" : "failed";
  const command = started ? readToolCommand(started) : null;

  if (command) {
    const exitCode = data?.shellExecution?.exitCode ?? (succeeded ? 0 : "?");
    state.commandExecutions.push({ command, exitCode, status: statusLabel });
    return {
      message: `Command ${statusLabel}: ${shorten(command, 96)} (exit ${exitCode})`,
      phase: looksLikeVerificationCommand(command) ? "verifying" : "running"
    };
  }

  if (EDIT_TOOL_PATTERN.test(toolName)) {
    if (succeeded) {
      for (const filePath of collectEditPaths(started)) {
        state.touchedFiles.add(filePath);
      }
    }
    return { message: `File changes ${statusLabel}.`, phase: "editing" };
  }

  const detail = succeeded ? "" : data?.error?.message ? `: ${shorten(data.error.message, 96)}` : "";
  return { message: `Tool ${toolName} ${statusLabel}${detail}.`, phase: "investigating" };
}

function recordAssistantMessage(state, data) {
  const text = typeof data?.content === "string" ? data.content : "";
  if (!text.trim()) {
    return;
  }

  if (isSubagentEvent(data)) {
    emitLogEvent(state.onProgress, {
      message: `Subagent message: ${shorten(text, 96)}`,
      logTitle: "Subagent message",
      logBody: text
    });
    return;
  }

  if (!state.finalAnswerSeen || data?.phase === "final_answer") {
    state.finalMessage = text;
  }
  if (data?.phase === "final_answer") {
    state.finalAnswerSeen = true;
  }
  emitLogEvent(state.onProgress, {
    message: `Assistant message captured: ${shorten(text, 96)}`,
    phase: data?.phase === "final_answer" ? "finalizing" : null,
    logTitle: "Assistant message",
    logBody: text
  });
}

function recordReasoning(state, data) {
  const text = normalizeReasoningText(data?.content);
  if (!text || !looksLikeReadableReasoning(text)) {
    return;
  }
  state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, [text]);
  emitLogEvent(state.onProgress, {
    message: `Reasoning summary captured: ${shorten(text, 96)}`,
    logTitle: "Reasoning summary",
    logBody: `- ${text}`
  });
}

function applyCopilotEvent(state, event) {
  const type = String(event?.type ?? "");
  const data = event?.data ?? {};

  switch (type) {
    case "assistant.message":
      recordAssistantMessage(state, data);
      return;
    case "assistant.reasoning":
      recordReasoning(state, data);
      return;
    case "tool.execution_start": {
      state.toolCalls.set(data.toolCallId, data);
      const update = describeToolStart(data);
      emitProgress(state.onProgress, update.message, update.phase);
      return;
    }
    case "tool.execution_complete": {
      const update = describeToolComplete(state, data);
      emitProgress(state.onProgress, update.message, update.phase);
      return;
    }
    case "result":
      state.resultEvent = event;
      for (const filePath of event?.usage?.codeChanges?.filesModified ?? []) {
        if (typeof filePath === "string" && filePath) {
          state.touchedFiles.add(filePath);
        }
      }
      emitProgress(state.onProgress, `Copilot session finished (exit ${event?.exitCode ?? "?"}).`, "finalizing");
      return;
    default:
      if (/(^|\.)error$/.test(type)) {
        const message = data?.message ?? data?.error?.message ?? "Unknown Copilot error.";
        state.error = { message };
        emitProgress(state.onProgress, `Copilot error: ${message}`, "failed");
      }
  }
}

function buildResultStatus(state, exitCode) {
  if (exitCode !== 0) {
    return 1;
  }
  const reportedExit = state.resultEvent?.exitCode;
  if (typeof reportedExit === "number" && reportedExit !== 0) {
    return 1;
  }
  return state.error && !state.finalMessage ? 1 : 0;
}

function waitForCopilotRun(child, state) {
  return new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        stderr += `${trimmed}\n`;
        return;
      }
      applyCopilotEvent(state, event);
    });

    child.on("error", (error) => {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
        reject(new Error(COPILOT_INSTALL_HINT));
        return;
      }
      reject(error);
    });

    child.on("close", (code) => {
      lines.close();
      resolve({ exitCode: code ?? 1, stderr: cleanCopilotStderr(stderr) });
    });
  });
}

export function getCopilotAvailability(cwd) {
  const versionStatus = binaryAvailable(COPILOT_COMMAND, ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }
  const firstLine = versionStatus.detail.split(/\r?\n/)[0].trim();
  return { available: true, detail: firstLine || versionStatus.detail };
}

export function resolveCopilotHome(env = process.env) {
  return path.resolve(env.COPILOT_HOME || path.join(os.homedir(), ".copilot"));
}

function readCopilotConfig(env) {
  const configPath = path.join(resolveCopilotHome(env), "config.json");
  if (!fs.existsSync(configPath)) {
    return null;
  }
  try {
    const text = fs
      .readFileSync(configPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not logged in to GitHub Copilot",
    source: "unknown",
    authMethod: null,
    verified: null,
    ...fields
  };
}

function describeLogin(user) {
  if (!user || typeof user.login !== "string" || !user.login.trim()) {
    return null;
  }
  const host = typeof user.host === "string" ? user.host.replace(/^https?:\/\//, "").replace(/\/+$/, "") : "";
  return host && host !== "github.com" ? `${user.login.trim()} on ${host}` : user.login.trim();
}

export function getCopilotAuthStatus(cwd, options = {}) {
  const env = options.env ?? process.env;
  const availability = getCopilotAvailability(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null
    };
  }

  if (env.COPILOT_PROVIDER_BASE_URL) {
    return buildAuthStatus({
      loggedIn: true,
      detail: "custom model provider configured through COPILOT_PROVIDER_BASE_URL",
      source: "env",
      authMethod: "provider"
    });
  }

  const tokenEnvName = TOKEN_ENV_NAMES.find((name) => typeof env[name] === "string" && env[name].trim());
  if (tokenEnvName) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${tokenEnvName} is set (unverified)`,
      source: "env",
      authMethod: "token",
      verified: false
    });
  }

  const config = readCopilotConfig(env);
  const login =
    describeLogin(config?.lastLoggedInUser) ??
    (Array.isArray(config?.loggedInUsers) ? config.loggedInUsers.map(describeLogin).find(Boolean) : null) ??
    null;
  if (login) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `GitHub login active for ${login}`,
      source: "config",
      authMethod: "github"
    });
  }

  return buildAuthStatus({ source: "config" });
}

export async function runCopilotTurn(cwd, options = {}) {
  const availability = getCopilotAvailability(cwd);
  if (!availability.available) {
    throw new Error(COPILOT_INSTALL_HINT);
  }

  const prompt = options.prompt?.trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Copilot run.");
  }

  const resumeSessionId = options.resumeSessionId ?? null;
  const sessionId = resumeSessionId ?? crypto.randomUUID();
  const args = buildCopilotArgs({
    resumeSessionId,
    sessionId,
    sessionName: options.sessionName ?? null,
    model: options.model ?? null,
    effort: options.effort ?? null,
    write: Boolean(options.write)
  });

  emitProgress(
    options.onProgress,
    resumeSessionId ? `Resuming Copilot session ${sessionId}.` : `Starting Copilot session ${sessionId}.`,
    "starting",
    { threadId: sessionId }
  );

  const state = createRunState(sessionId, options.onProgress);
  const child = spawnCopilot(args, { cwd, env: options.env });
  options.onSpawn?.(child);
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  const { exitCode, stderr } = await waitForCopilotRun(child, state);
  const reportedSessionId =
    typeof state.resultEvent?.sessionId === "string" && state.resultEvent.sessionId ? state.resultEvent.sessionId : sessionId;

  return {
    status: buildResultStatus(state, exitCode),
    threadId: reportedSessionId,
    turnId: null,
    finalMessage: state.finalMessage,
    reasoningSummary: state.reasoningSummary,
    error: state.error ?? (exitCode !== 0 ? { message: stderr || `Copilot exited with code ${exitCode}.` } : null),
    stderr,
    touchedFiles: [...state.touchedFiles],
    commandExecutions: state.commandExecutions
  };
}

export function buildPersistentTaskSessionName(prompt) {
  return buildTaskSessionName(prompt);
}

function extractJsonCandidate(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/);
  if (fenced) {
    return fenced[1].trim();
  }
  if (text.startsWith("{")) {
    return text;
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start !== -1 && end > start ? text.slice(start, end + 1) : text;
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Copilot did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(extractJsonCandidate(rawOutput)),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error.message,
      rawOutput,
      ...fallback
    };
  }
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_SESSION_PREFIX };
