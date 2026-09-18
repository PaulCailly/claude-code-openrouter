# Permissions

Claude Code executes every tool in this plugin, so Claude's own permission model
applies unchanged. There is no external harness and no external reviewer.

## What applies where

| Surface | Behaviour |
| --- | --- |
| `/model` OpenRouter rows | Claude Code's Read, Grep, Glob, Bash, Edit and Write tools run the loop under the session's permission mode. |
| Named workers | Worker tool restrictions intersect with the prompt-boundary mode; unknown workers fail explicitly. |
| Auto mode | Available whenever Anthropic access exists, because Claude performs the review. Without Anthropic access it is disabled rather than silently downgraded. |
| Plan mode | Denies shell and edit capabilities for OpenRouter runs exactly as for Claude runs. |

## Admission

Claude's permission mode is captured at the `UserPromptSubmit` and
`SubagentStart` boundaries and applied to every dispatch. Admission fails
explicitly for unsupported modes, unknown workers, untranslatable policies and
unavailable permission context. A capability guard runs as a `PreToolUse` hook so
`/model` changes and workers are covered without calling a model or classifying
commands.

## Credentials

The OpenRouter key never reaches Claude's own requests, and Anthropic
credentials never reach OpenRouter. The gateway strips inbound Anthropic
authentication headers before calling OpenRouter and authenticates its loopback
port with a per-session token.
