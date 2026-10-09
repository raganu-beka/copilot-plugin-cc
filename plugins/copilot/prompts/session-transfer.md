<task>
This session continues work that started in a Claude Code session.
The conversation from that session is in `<claude_conversation>`.
Treat it as the shared history of this session.
Do not start new work and do not edit files in this turn.
</task>

<context>
Claude session ID: {{CLAUDE_SESSION_ID}}
Workspace: {{WORKSPACE_ROOT}}
{{TRUNCATION_NOTE}}
Lines in the form `[tool call Name: ...]` are summaries of tool calls that Claude made. Their results are not included.
</context>

<compact_output_contract>
Reply with a short handoff summary:
1. The goal of the work.
2. What is done.
3. What is still open, as a short list.
Keep the reply under 200 words.
</compact_output_contract>

<claude_conversation>
{{CLAUDE_TRANSCRIPT}}
</claude_conversation>
