import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "COPILOT_COMPANION_TRANSCRIPT_PATH";
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");
const DEFAULT_MAX_HANDOFF_CHARS = 120000;
const MAX_TOOL_INPUT_CHARS = 240;

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  let projects;
  try {
    source = fs.realpathSync(sourcePath);
    projects = fs.realpathSync(CLAUDE_PROJECTS_DIR);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }
  const relative = path.relative(projects, source);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Copilot can transfer Claude sessions only from ${CLAUDE_PROJECTS_DIR}: ${source}`);
  }
  return source;
}

function stripSystemReminders(text) {
  return String(text ?? "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .trim();
}

function shortenInline(text, limit) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function describeToolUse(block) {
  const input = block.input === undefined ? "" : shortenInline(JSON.stringify(block.input), MAX_TOOL_INPUT_CHARS);
  return input ? `[tool call ${block.name}: ${input}]` : `[tool call ${block.name}]`;
}

function extractUserText(content) {
  if (typeof content === "string") {
    return stripSystemReminders(content);
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block?.type === "text")
    .map((block) => stripSystemReminders(block.text))
    .filter(Boolean)
    .join("\n\n");
}

function extractAssistantText(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (block?.type === "text") {
        return String(block.text ?? "").trim();
      }
      if (block?.type === "tool_use" && block.name) {
        return describeToolUse(block);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseTranscriptEntries(sourcePath) {
  const entries = [];
  for (const line of fs.readFileSync(sourcePath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.isSidechain || record?.isMeta) {
      continue;
    }
    const role = record?.message?.role ?? record?.type;
    if (role === "user") {
      const text = extractUserText(record.message?.content);
      if (text) {
        entries.push({ role: "User", text });
      }
    } else if (role === "assistant") {
      const text = extractAssistantText(record.message?.content);
      if (text) {
        entries.push({ role: "Claude", text });
      }
    }
  }
  return entries;
}

function formatEntry(entry) {
  return `### ${entry.role}\n${entry.text}`;
}

export function buildClaudeSessionHandoff(sourcePath, options = {}) {
  const maxChars = options.maxChars ?? DEFAULT_MAX_HANDOFF_CHARS;
  const entries = parseTranscriptEntries(sourcePath);
  if (entries.length === 0) {
    return { text: "", messageCount: 0, truncated: false };
  }

  const formatted = entries.map(formatEntry);
  const firstUserIndex = entries.findIndex((entry) => entry.role === "User");
  const selected = [];
  let usedChars = 0;
  for (let index = formatted.length - 1; index >= 0; index -= 1) {
    if (usedChars + formatted[index].length > maxChars && selected.length > 0) {
      break;
    }
    selected.unshift(index);
    usedChars += formatted[index].length;
  }

  const truncated = selected[0] > 0;
  if (truncated && firstUserIndex !== -1 && !selected.includes(firstUserIndex)) {
    selected.unshift(firstUserIndex);
  }

  const parts = [];
  for (const [position, index] of selected.entries()) {
    if (position > 0 && index !== selected[position - 1] + 1) {
      parts.push("[... earlier messages omitted ...]");
    }
    parts.push(formatted[index]);
  }

  return {
    text: parts.join("\n\n"),
    messageCount: entries.length,
    truncated
  };
}
