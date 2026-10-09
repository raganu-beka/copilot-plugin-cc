# Changelog

## 2.0.0

- Replace the Codex app server runtime with GitHub Copilot CLI (`copilot`) in non-interactive JSON mode
- Rename the plugin to `copilot` and the commands to `/copilot:*`
- Remove the shared app-server broker; each review or task starts its own Copilot session
- `/copilot:transfer` now seeds a new Copilot session with the Claude conversation

## 1.0.0

- Initial version of the Codex plugin for Claude Code
