---
description: Transfer the current Claude Code session into a resumable Copilot session
argument-hint: "[--source <claude-jsonl>]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/copilot-companion.mjs" transfer "$ARGUMENTS"`

Present the command output to the user exactly as returned. Preserve the Copilot session ID and the `copilot --resume <session-id>` command.
