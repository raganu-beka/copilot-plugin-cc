import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export function fakeStatePath(binDir) {
  return path.join(binDir, "fake-copilot-state.json");
}

export function fakeCopilotHome(binDir) {
  return path.join(binDir, "copilot-home");
}

export function readFakeState(binDir) {
  const statePath = fakeStatePath(binDir);
  if (!fs.existsSync(statePath)) {
    return { invocations: [] };
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

export function lastInvocation(binDir) {
  return readFakeState(binDir).invocations.at(-1) ?? null;
}

function writeCopilotConfig(binDir, behavior) {
  const home = fakeCopilotHome(binDir);
  fs.mkdirSync(home, { recursive: true });
  if (behavior === "logged-out") {
    return;
  }
  const config = {
    lastLoggedInUser: { host: "https://github.com", login: "octocat" },
    loggedInUsers: [{ host: "https://github.com", login: "octocat" }]
  };
  fs.writeFileSync(
    path.join(home, "config.json"),
    `// User settings belong in settings.json.\n${JSON.stringify(config, null, 2)}\n`,
    "utf8"
  );
}

export function installFakeCopilot(binDir, behavior = "review-ok") {
  const statePath = fakeStatePath(binDir);
  const scriptPath = path.join(binDir, "copilot");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const crypto = require("node:crypto");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { invocations: [] };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function readOption(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      return args[index + 1] ?? null;
    }
    if (arg.startsWith(name + "=")) {
      return arg.slice(name.length + 1);
    }
  }
  return null;
}

function readOptions(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name && args[index + 1]) {
      values.push(args[index + 1]);
    } else if (arg.startsWith(name + "=")) {
      values.push(arg.slice(name.length + 1));
    }
  }
  return values;
}

function emit(event) {
  process.stdout.write(JSON.stringify({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...event }) + "\\n");
}

function structuredReviewPayload(prompt) {
  if (prompt.includes("adversarial software review")) {
    if (BEHAVIOR === "adversarial-clean") {
      return JSON.stringify({ verdict: "approve", summary: "No material issues found.", findings: [], next_steps: [] });
    }
    return JSON.stringify({
      verdict: "needs-attention",
      summary: "One adversarial concern surfaced.",
      findings: [
        {
          severity: "high",
          title: "Missing empty-state guard",
          body: "The change assumes data is always present.",
          file: "src/app.js",
          line_start: 4,
          line_end: 6,
          confidence: 0.87,
          recommendation: "Handle empty collections before indexing."
        }
      ],
      next_steps: ["Add an empty-state test."]
    });
  }

  if (BEHAVIOR === "invalid-json") {
    return "not valid json";
  }

  const payload = JSON.stringify({ verdict: "approve", summary: "No material issues found.", findings: [], next_steps: [] });
  return BEHAVIOR === "fenced-json" ? "\\u0060\\u0060\\u0060json\\n" + payload + "\\n\\u0060\\u0060\\u0060" : payload;
}

function taskPayload(prompt, resumed) {
  if (prompt.includes("Only review the work from the previous Claude turn.")) {
    if (BEHAVIOR === "adversarial-clean") {
      return "ALLOW: No blocking issues found in the previous turn.";
    }
    return "BLOCK: Missing empty-state guard in src/app.js:4-6.";
  }

  if (prompt.includes("<claude_conversation>")) {
    return "Goal: continue the Claude work.\\nDone: context loaded.\\nOpen: next step.";
  }

  if (resumed || prompt.includes("Continue from the current session state") || prompt.includes("follow up")) {
    return "Resumed the prior run.\\nFollow-up prompt accepted.";
  }

  return "Handled the requested task.\\nTask prompt accepted.";
}

function finalPayload(prompt, resumed) {
  return prompt.includes("<output_schema>") ? structuredReviewPayload(prompt) : taskPayload(prompt, resumed);
}

function emitToolRun(toolCallId, toolName, args, extra = {}) {
  emit({ type: "tool.execution_start", data: { toolCallId, toolName, arguments: args, turnId: "0" } });
  emit({ type: "tool.execution_complete", data: { toolCallId, success: true, turnId: "0", ...extra } });
}

function finish(sessionId, prompt, resumed, filesModified) {
  if (BEHAVIOR === "with-reasoning") {
    emit({
      type: "assistant.reasoning",
      data: { reasoningId: "r1", content: "Inspected the changed files and checked the highest-risk paths first." }
    });
  }

  if (BEHAVIOR === "with-subagent") {
    emit({ type: "tool.execution_start", data: { toolCallId: "call_sub", toolName: "task", arguments: { prompt: "inspect" } } });
    emit({
      type: "assistant.message",
      data: { messageId: "m_sub", content: "Subagent looked at the retry path.", parentToolCallId: "call_sub", phase: "final_answer" }
    });
    emit({ type: "tool.execution_complete", data: { toolCallId: "call_sub", success: true } });
  }

  emit({ type: "assistant.message", data: { messageId: "m_progress", content: "Working on it.", phase: "commentary", toolRequests: [] } });
  emit({ type: "assistant.message", data: { messageId: "m_final", content: finalPayload(prompt, resumed), phase: "final_answer", toolRequests: [] } });

  if (BEHAVIOR === "with-late-subagent-message") {
    emit({
      type: "assistant.message",
      data: { messageId: "m_late", content: "Late subagent note.", parentToolCallId: "call_late", phase: "final_answer" }
    });
  }

  emit({ type: "assistant.idle", data: {}, ephemeral: true });
  emit({ type: "result", sessionId, exitCode: 0, usage: { premiumRequests: 1, codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified } } });
}

const args = process.argv.slice(2);
if (args[0] === "--version" || args[0] === "version") {
  if (BEHAVIOR === "version-fails") {
    console.error("copilot is broken");
    process.exit(1);
  }
  console.log("GitHub Copilot CLI 9.9.9-fake.");
  console.log("Run 'copilot update' to check for updates.");
  process.exit(0);
}

const prompt = fs.readFileSync(0, "utf8");
const resumeSessionId = readOption(args, "--resume");
const sessionId = resumeSessionId || readOption(args, "--session-id") || crypto.randomUUID();
const state = loadState();
state.invocations.push({
  args,
  prompt,
  cwd: process.cwd(),
  pid: process.pid,
  sessionId,
  resumeSessionId,
  name: readOption(args, "--name"),
  model: readOption(args, "--model"),
  effort: readOption(args, "--reasoning-effort"),
  allowAllTools: args.includes("--allow-all-tools"),
  allowTools: readOptions(args, "--allow-tool"),
  denyTools: readOptions(args, "--deny-tool")
});
saveState(state);

if (BEHAVIOR === "auth-run-fails") {
  console.error("Error: No authentication information found. Run 'copilot login' to authenticate.");
  process.exit(1);
}

emit({ type: "session.tools_updated", data: { model: "fake-model" }, ephemeral: true });
emit({ type: "user.message", data: { content: prompt } });

if (BEHAVIOR === "error-event") {
  emit({ type: "session.error", data: { errorType: "quota", message: "Premium request quota exceeded." } });
  emit({ type: "result", sessionId, exitCode: 1, usage: {} });
  process.exit(1);
}

const filesModified = [];
if (BEHAVIOR === "with-tools") {
  emitToolRun("call_cmd", "bash", { command: "npm test", description: "Run tests" }, { shellExecution: { exitCode: 0 } });
  emitToolRun("call_edit", "apply_patch", "*** Begin Patch\\n*** Update File: src/app.js\\n@@\\n-a\\n+b\\n*** End Patch\\n");
  filesModified.push("src/app.js");
}

const delayMs = BEHAVIOR === "slow-task" ? 400 : BEHAVIOR === "very-slow-task" ? 30000 : 0;
setTimeout(() => finish(sessionId, prompt, Boolean(resumeSessionId), filesModified), delayMs);
`;
  writeExecutable(scriptPath, source);
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "copilot.cmd"), `@echo off\r\nnode "%~dp0copilot" %*\r\n`, "utf8");
  }
  writeCopilotConfig(binDir, behavior);
}

export function buildEnv(binDir, extra = {}) {
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    COPILOT_HOME: fakeCopilotHome(binDir),
    ...extra
  };
  for (const name of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_PROVIDER_BASE_URL", "COPILOT_COMPANION_SESSION_ID", "COPILOT_COMPANION_TRANSCRIPT_PATH"]) {
    if (!(name in extra)) {
      delete env[name];
    }
  }
  return env;
}
