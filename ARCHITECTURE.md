# Architecture

See [AGENTS.md](AGENTS.md) for contributor rules and [README.md](README.md) for
usage. Setup and limits are in [docs/installation.md](docs/installation.md),
[docs/openrouter.md](docs/openrouter.md),
[docs/permissions.md](docs/permissions.md) and
[docs/platform-support.md](docs/platform-support.md).

## Overview

The plugin puts OpenRouter models inside one Claude Code session. The launcher
fetches the model catalog, registers model rows and named workers, and starts a
loopback gateway. The gateway passes Anthropic traffic through and translates
OpenRouter traffic. Claude Mods provide the in-engine control plane for model
rows, worker rows, permission state, progress and compaction.

```text
Claude Code session (/model, workers, prompts)
                  |
        Claude Mods control plane
                  |
             Node gateway
            /            \
    Anthropic          OpenRouter
   passthrough      chat completions
                    Claude tool loop
```

## Request flow

Claude Code sends Anthropic Messages traffic to the gateway. A model id starting
with `openrouter/` is translated to an OpenRouter chat completion and streamed
back in Anthropic's shape; everything else is forwarded to Anthropic untouched.
Each run reports a visible lifecycle: row, elapsed time, streamed progress,
completion, failure and cancellation.

## Execution contract

| Concern | Owner |
| --- | --- |
| Tool execution | Claude Code, always |
| Permission mode | Claude Code, applied at prompt boundaries |
| Review | Claude, when Anthropic access exists; never borrowed from elsewhere |
| Model catalog | OpenRouter's `/api/v1/models`, cached on disk |
| Authentication | An OpenRouter API key in the plugin's own store |
| Token and cost accounting | OpenRouter's `usage` block, with local estimates only for `count_tokens` |

## Permissions

Claude's permission mode controls dispatch at the `UserPromptSubmit` and
`SubagentStart` boundaries. The gateway intersects worker rules, project settings
and platform policy. Unsupported modes, unknown workers and untranslatable
policies fail explicitly. Plan mode denies shell and edit capabilities. See
[docs/permissions.md](docs/permissions.md).

## Isolation

Every run isolates Claude session, worker, model and workspace identity. The
OpenRouter key never reaches Anthropic requests and Anthropic credentials never
reach OpenRouter. Claude subscription passthrough remains available; the plugin
has no Claude token pool.

## State

`state-lock.ts` serialises local state with a portable marker-file lock that
survives crashes. Durable run ids support terminal-result recovery: a recoverable
run resumes its record, an uncertain run does not rerun actions blindly.
Follow-ups forward the newest turn after the last assistant response. Compaction
summarises authenticated context. Cache reuse and usage accounting stay
provider-owned.

## Platform layer

The process tree tracks and cancels child processes. Executable resolution picks
platform-appropriate commands. Atomic writes protect settings, the auth file and
the catalog cache. The npm bin resolves the installed plugin and hands off to its
launcher. Linux, macOS and Windows are described in
[docs/platform-support.md](docs/platform-support.md).

## Design rules

- Keep the catalog, authentication and translation in `src/openrouter/`.
- Keep shared Claude protocol types and cross-cutting helpers in `src/gateway/`.
- Read capabilities from the catalog; never infer them from a model id.
- Apply Claude's permission mode and explicit tool restrictions at prompt boundaries.
- Propagate cancellation and expose progress, completion and failure.
- Fail on unknown models, unsupported policy and unknown workers.
- Never claim usage or cost that upstream did not report.
- Isolate every session, worker, workspace and credential context.
