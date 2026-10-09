# Copilot plugin for Claude Code

Use GitHub Copilot CLI from inside Claude Code for code reviews or to delegate tasks to Copilot.

This plugin is for Claude Code users who want an easy way to start using GitHub Copilot CLI from the workflow
they already have.

This project is derived from [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). It keeps the same commands and job model, but it runs the [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) (`copilot`) instead of Codex.

## What You Get

- `/copilot:review` for a normal read-only Copilot review
- `/copilot:adversarial-review` for a steerable challenge review
- `/copilot:rescue`, `/copilot:transfer`, `/copilot:status`, `/copilot:result`, and `/copilot:cancel` to delegate work, hand off sessions, and manage background jobs

## Requirements

- **A GitHub Copilot subscription** (Free, Pro, Pro+, Business, or Enterprise), or a custom model provider configured for Copilot CLI.
  - Each Copilot run uses premium requests from your Copilot plan.
- **GitHub Copilot CLI** (`copilot`) on your `PATH`
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add raganu-beka/copilot-plugin-cc
```

Install the plugin:

```bash
/plugin install copilot@copilot-plugin-cc
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/copilot:setup
```

`/copilot:setup` will tell you whether Copilot is ready. If Copilot CLI is missing and npm is available, it can offer to install Copilot for you.

If you prefer to install Copilot CLI yourself, use:

```bash
npm install -g @github/copilot
```

If Copilot is installed but not logged in yet, run:

```bash
!copilot login
```

You can also set `COPILOT_GITHUB_TOKEN` (or `GH_TOKEN` / `GITHUB_TOKEN`) to a token that has Copilot access.

After install, you should see:

- the slash commands listed below
- the `copilot:copilot-rescue` subagent in `/agents`

One simple first run is:

```bash
/copilot:review --background
/copilot:status
/copilot:result
```

## Usage

### `/copilot:review`

Runs a normal Copilot review on your current work. The plugin collects the git diff, sends it to Copilot with a review prompt, and renders the structured result.

> [!NOTE]
> Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/copilot:adversarial-review`](#copilotadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/copilot:review
/copilot:review --base main
/copilot:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use [`/copilot:status`](#copilotstatus) to check on the progress and [`/copilot:cancel`](#copilotcancel) to cancel the ongoing task.

### `/copilot:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/copilot:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/copilot:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```bash
/copilot:adversarial-review
/copilot:adversarial-review --base main challenge whether this was the right caching and retry design
/copilot:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/copilot:rescue`

Hands a task to Copilot through the `copilot:copilot-rescue` subagent.

Use it when you want Copilot to:

- investigate a bug
- try a fix
- continue a previous Copilot task
- take a faster or cheaper pass with a smaller model

> [!NOTE]
> Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, `--resume`, and `--fresh`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue session for this repo.

Examples:

```bash
/copilot:rescue investigate why the tests started failing
/copilot:rescue fix the failing test with the smallest safe patch
/copilot:rescue --resume apply the top fix from the last run
/copilot:rescue --model gpt-5.4 --effort medium investigate the flaky integration test
/copilot:rescue --model claude-sonnet-4.6 fix the issue quickly
/copilot:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Copilot:

```text
Ask Copilot to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model` or `--effort`, Copilot chooses its own defaults.
- `--model` accepts any model id that Copilot CLI accepts, for example `gpt-5.4`, `claude-sonnet-4.6`, or `auto`.
- `--effort` accepts `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- follow-up rescue requests can continue the latest Copilot task in the repo

### `/copilot:transfer`

Creates a new Copilot session from the current Claude Code session and prints a `copilot --resume <session-id>` command.

Use it when you started a debugging or implementation conversation in Claude Code and want to continue that same context directly in Copilot.

Examples:

```bash
/copilot:transfer
/copilot:transfer --source ~/.claude/projects/-Users-me-repo/<session-id>.jsonl
```

The plugin's existing `SessionStart` hook supplies the current transcript path automatically; `--source` is available as a manual override. The transfer reads the user and Claude messages from the transcript (with short notes for each tool call), sends them to a new read-only Copilot session, and asks Copilot for a short handoff summary. Very long conversations keep the first request and the most recent messages. The source must be under `~/.claude/projects`.

### `/copilot:status`

Shows running and recent Copilot jobs for the current repository.

Examples:

```bash
/copilot:status
/copilot:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/copilot:result`

Shows the final stored Copilot output for a finished job.
When available, it also includes the Copilot session ID so you can reopen that run directly in Copilot with `copilot --resume <session-id>`.

Examples:

```bash
/copilot:result
/copilot:result task-abc123
```

### `/copilot:cancel`

Cancels an active background Copilot job.

Examples:

```bash
/copilot:cancel
/copilot:cancel task-abc123
```

### `/copilot:setup`

Checks whether Copilot CLI is installed and authenticated.
If Copilot is missing and npm is available, it can offer to install Copilot for you.

You can also use `/copilot:setup` to manage the optional review gate.

#### Enabling review gate

```bash
/copilot:setup --enable-review-gate
/copilot:setup --disable-review-gate
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a targeted Copilot review based on Claude's response. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Copilot loop and may use many premium requests. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/copilot:review
```

### Hand A Problem To Copilot

```bash
/copilot:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/copilot:adversarial-review --background
/copilot:rescue --background investigate the flaky test
```

Then check in with:

```bash
/copilot:status
/copilot:result
```

## Copilot Integration

The plugin runs the global `copilot` binary in non-interactive mode. Each review or task starts one Copilot process with:

- the prompt sent on standard input
- `--output-format json`, so the plugin can follow tool calls, progress, and the final answer
- `--session-id <uuid>` for new sessions, or `--resume <session-id>` to continue a task
- `--no-ask-user`, so Copilot does not wait for questions that nobody can answer

Permissions depend on the job:

- Reviews, read-only tasks, transfers, and the stop gate deny file writes. Shell access is limited to an allow list of inspection commands such as `git diff`, `git log`, `git show`, `ls`, and `cat`. Copilot denies all other tool requests in non-interactive mode.
- Write-capable rescue tasks (`--write`, the default for `/copilot:rescue`) run with `--allow-all-tools`. File access stays limited to the repository and the temporary directory.

### Common Configurations

The plugin uses your normal Copilot CLI configuration. To change the default model, use the `/model` command in Copilot, run `copilot config model <model>`, or set the `COPILOT_MODEL` environment variable. Use `copilot config --repo model <model>` to set a default for one repository.

Copilot reads repository instructions such as `AGENTS.md` and `.github/copilot-instructions.md` in plugin runs too.

Check out the Copilot CLI docs for more [configuration options](https://docs.github.com/copilot/how-tos/copilot-cli).

### Moving The Work Over To Copilot

Delegated tasks and any [stop gate](#enabling-review-gate) run can also be directly resumed inside Copilot by running `copilot --resume <session-id>` with the session ID you received from `/copilot:result` or `/copilot:status`, or by running `copilot --resume` and selecting it from the list.

This way you can review the Copilot work or continue the work there.

## FAQ

### Do I need a separate Copilot account for this plugin?

If you are already logged in to Copilot CLI on this machine, that login works here too. This plugin uses your local Copilot CLI authentication.

If you have not used Copilot CLI yet, you need a GitHub account with a Copilot subscription. Run `/copilot:setup` to check whether Copilot is ready, and use `!copilot login` if it is not.

### Does the plugin use a separate Copilot runtime?

No. This plugin runs your local [Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) on the same machine.

That means:

- it uses the same Copilot install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Copilot config I already have?

Yes. If you already use Copilot CLI, the plugin picks up the same [configuration](#common-configurations), including MCP servers, custom instructions, and the default model.

### Can I use my own model provider?

Yes. Copilot CLI supports custom model providers through `COPILOT_PROVIDER_BASE_URL` and the related `COPILOT_PROVIDER_*` variables. Run `copilot help providers` for details. `/copilot:setup` reports the plugin as ready when a custom provider is configured.
