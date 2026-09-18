# OpenRouter

OpenRouter models use direct API requests while Claude Code owns tools,
permissions and history.

## Setup

1. Install the plugin. See [installation](installation.md).
2. Run `claude-openrouter connect` in a terminal and paste the key at the hidden
   prompt. Create one at https://openrouter.ai/keys.
3. Launch with `claude-openrouter`.

`OPENROUTER_API_KEY` overrides the stored key for a single process.

| Platform | Default auth file |
| --- | --- |
| Linux and macOS | `$XDG_CONFIG_HOME/claude-code-openrouter/auth.json`, or `~/.config/claude-code-openrouter/auth.json` |
| Windows | `%APPDATA%\claude-code-openrouter\auth.json` |
| Any platform with an override | The path in `OPENROUTER_AUTH_FILE` |

The file is written atomically with mode `0600`, and unrelated entries in it are
preserved.

## The catalog

`GET https://openrouter.ai/api/v1/models` is the source of truth. It is fetched
at launch and cached:

| Platform | Cache file |
| --- | --- |
| Linux and macOS | `$XDG_CACHE_HOME/claude-code-openrouter/catalog.json`, or `~/.cache/...` |
| Windows | `%LOCALAPPDATA%\claude-code-openrouter\catalog.json` |

If the fetch fails, the cache is used and the launcher says so. With neither, the
launch fails explicitly. Setting `OPENROUTER_CATALOG_FILE` pins the catalog to
that file and skips the network entirely.

**Admission.** A model appears only if its `supported_parameters` contain
`tools`. Around 380 of OpenRouter's 440-odd models qualify today.

**Rows.** `/model` shows a short recommended list intersected with the live
catalog, so a retired id disappears instead of erroring.
`OPENROUTER_MODELS=<id,id,...>` replaces that selection and an empty value hides
the rows. Any admitted id remains selectable by typing it.

Model ids are `openrouter/<openrouter-id>`, for example
`openrouter/anthropic/claude-sonnet-5`.

## Requests

Requests go to `POST /api/v1/chat/completions` with `usage: { include: true }`, so
token counts and cost come from OpenRouter rather than a local estimate.

| Claude | OpenRouter |
| --- | --- |
| `/effort low` / `medium` / `high` | `reasoning.effort` `low` / `medium` / `high` |
| `/effort xhigh` / `max` | `reasoning.effort` `high` |
| `max_tokens` | rejected above the model's `max_completion_tokens`; defaults to `min(32000, limit)` |
| image blocks | passed only when the model lists `image` input; otherwise refused |
| PDF blocks | always refused |

`OPENROUTER_PROVIDER` may hold raw JSON merged into the request's `provider`
field for routing order, fallbacks and data policy. Invalid JSON fails before any
request is sent.

## Execution

Claude Code executes every tool and applies its permission mode. OpenRouter has
no independent reviewer, and none is borrowed.

## Caching and continuation

Stable translated instructions, tool ordering and history preserve reusable
prefixes. A cache identity for the Claude session, worker, model and workspace
survives restarts and is sent as `x-openrouter-session`. Visible conversation
history transfers when switching models; reasoning signatures stay with the model
that produced them. Compaction or a model switch can make the next request cold.

## Limits

The gateway rejects unknown models, unsupported effort values, unsupported media
and output limits above the catalog limit. Token counts reported by
`count_tokens` are local estimates and labelled as such.
