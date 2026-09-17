# claude-code-openrouter — design

Date: 2026-09-17
Status: approved for planning
Base: `greenpolo/cc-multi-cli-plugin` @ `3dc5066` (Apache-2.0), imported as commit 1, not a GitHub fork.

## Goal

One Claude Code plugin that puts **OpenRouter** models in `/model`, with named
workers, Claude-owned tools and permissions, and credit/spend reporting. Nothing
else. No second provider, no provider abstraction left in the reader's way.

## Non-goals

- Any provider other than OpenRouter (OpenAI, Cursor, Zen, Antigravity are removed).
- Harness integrations (external SDK/CLI loops). OpenRouter is a direct model API;
  Claude Code always owns the tool loop.
- Shell-rc modification or shadowing the `claude` binary.
- OpenRouter features unrelated to a coding session: web search plugin, image
  output, embeddings, BYOK management, PDF input.

## Shape

Single plugin, single install command.

```
.claude-plugin/plugin.json          name: openrouter
.claude-plugin/marketplace.json     one entry, source "./"
bin/claude-openrouter.mjs           launch wrapper (npm bin)
src/launcher.ts                     gateway boot + claude spawn
src/account.ts                      status / uninstall
src/setup.ts                        /openrouter:setup
src/gateway/*.ts                    HTTP gateway, mods bridge, permissions, receipts
src/openrouter/auth.ts              key store
src/openrouter/catalog.ts           live /api/v1/models fetch + disk cache
src/openrouter/models.ts            catalog -> picker rows, workers, effort
src/openrouter/request.ts           Messages -> chat/completions
src/openrouter/chat.ts              translation + SSE streaming both ways
src/openrouter/usage.ts             credits, spend, quota view
src/install/*.ts                    install state, plugin discovery
hooks/*.ts                          lifecycle, compaction, usage view, register
skills/*/SKILL.md                   connect, setup, status, models, uninstall
test/unit/*.test.ts                 offline
test/live/*.ts                      key-gated
docs/*.md
```

Upstream's two-plugin split (`multi-core` + `multi-<provider>`) collapses into one.
The `multi/` model-id namespace becomes `openrouter/`. `MULTI_*` env vars become
`OPENROUTER_*`.

## Launch

`claude-openrouter` is a node bin shipped by the npm package
(`npx claude-code-openrouter` or `npm i -g claude-code-openrouter`). It:

1. asserts node >= 24.12 (the sources are run as TypeScript by node's type
   stripping) and fails with an explicit message otherwise;
2. resolves the installed plugin root and runs `src/launcher.ts`;
3. the launcher starts the loopback gateway on an ephemeral port, then spawns the
   real `claude` with `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`,
   `OPENROUTER_GATEWAY_TOKEN`, `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`, and the
   model-picker settings;
4. exits with the child's code; the process tree is cancelled with it.

Plain `claude` is never touched. No file outside `~/.claude/` and the plugin's own
state directory is written. `--` passes the remaining arguments to `claude`
unchanged, including `--resume`.

Refuse to start when `ANTHROPIC_BASE_URL` is already set: the launcher owns it.

## Catalog

`GET https://openrouter.ai/api/v1/models` is the source of truth for the model
list and every capability. No hand-maintained capability table.

- Fetched at launch, written to `<state>/catalog.json` with the fetch timestamp.
  A fetch failure falls back to the cache and prints one line; no cache and no
  network is a hard failure with the OpenRouter status URL.
- Admitted models: `supported_parameters` contains `tools` (376 of 445 today).
  A model that cannot call tools cannot drive a Claude Code session, so it never
  reaches the picker.
- Per model the catalog supplies: `context_length`,
  `top_provider.max_completion_tokens` (output clamp),
  `architecture.input_modalities` (image admission),
  `supported_parameters` (effort admission), `pricing` (spend estimate).

**Visible rows.** Capabilities are dynamic; curation is not. `/model` shows
`RECOMMENDED_IDS`, a short committed list, intersected with the live catalog so a
retired id disappears instead of erroring. `OPENROUTER_MODELS=<id,id,...>`
replaces that selection; an empty value hides OpenRouter rows entirely. Any
tool-capable catalog id remains selectable by typing it, whether or not it has a
row. `/openrouter:models` prints the full admitted catalog with capabilities.

Model id in Claude: `openrouter/<openrouter-id>`, e.g.
`openrouter/anthropic/claude-sonnet-4.5`. Three segments are expected; the prefix
is stripped, the remainder is the OpenRouter id verbatim.

## Workers

One worker per visible row: `openrouter-<id with "/" replaced by "-">`, e.g.
`openrouter-anthropic-claude-sonnet-4.5`. Tools are
`Read, Grep, Glob, Bash, Edit, Write`. Models that accept effort also get
effort-suffixed workers (`...-high`). Workers are never generated for the whole
catalog — only for visible rows — so the agent list stays readable.

## Request translation

Anthropic Messages -> OpenAI-compatible `POST /api/v1/chat/completions`, streamed
back as Anthropic SSE. Upstream's Zen chat translator is the base; the Responses
API path is deleted with the OpenAI provider.

- Headers: `Authorization: Bearer <key>`, `HTTP-Referer` and `X-Title` identifying
  this project (OpenRouter attribution), `x-openrouter-session` for sticky routing.
- `usage: { include: true }` on every request, so upstream returns real cost and
  cache counters rather than a local estimate.
- `max_tokens`: rejected above `top_provider.max_completion_tokens`; defaults to
  `min(32000, max_completion_tokens)`.
- Effort: Claude's `low|medium|high|xhigh|max` maps to OpenRouter
  `reasoning.effort` `low|medium|high` (`xhigh` and `max` clamp to `high`).
  Only for models advertising `reasoning`; other models expose no effort row and
  `/effort` reports that it does not apply.
- Images pass only when `input_modalities` contains `image`. PDF input is
  rejected with the model id in the message.
- `OPENROUTER_PROVIDER` may hold raw JSON merged into the request's `provider`
  field (routing order, fallbacks, data policy). Invalid JSON fails at launch,
  not mid-request.
- Cancellation propagates to the upstream request; an interrupted stream reports
  the tokens seen and says final usage is unavailable.

## Permissions

Unchanged from upstream, minus the multi-provider intersection. Claude's
permission mode is applied at the `UserPromptSubmit` and `SubagentStart`
boundaries; plan mode denies shell and edit capability; unknown workers and
untranslatable policies fail explicitly. Claude Code executes every tool call, so
`PreToolUse` and `PermissionRequest` keep their normal admission path — there is
no native harness to observe.

## Usage and credits

`/openrouter-usage` shows:

- credit balance from `GET /api/v1/credits` (`total_credits - total_usage`), with
  rate-limit context from `GET /api/v1/key`;
- session tokens and billed cost, summed from the `usage` block of each response;
- worker receipts, appended as JSONL when `OPENROUTER_RECEIPTS_FILE` is set.

A failing credits call degrades to "balance unavailable" and never blocks a run.

## Authentication

API key, stored by the plugin itself (upstream borrowed OpenCode's store; that
coupling is dropped).

- `OPENROUTER_API_KEY` wins when set.
- Otherwise `<config>/claude-code-openrouter/auth.json`, mode `0600`, written
  atomically: `$XDG_CONFIG_HOME` or `~/.config` on Unix, `%APPDATA%` on Windows.
- `/openrouter:connect` tells the user to run `claude-openrouter connect` in a
  separate terminal; the helper prompts without echo. The key is never accepted,
  read, printed or passed as an argument in chat.

## Removed from upstream

`plugins/multi-openai`, `plugins/multi-cursor`, `plugins/multi-antigravity` and
their skills, docs, unit tests and live tests; the Codex Guardian policy assets;
the `@cursor/sdk` dependency; `gateway/cursor-settings.ts`; the Antigravity
permission-hook installer; the external-reviewer path — reviewer discovery, the
approval bridge in `gateway/approval.ts` and the provider-approval hooks — since
OpenRouter has no model-based reviewer and upstream already forbids borrowing
another provider's. Whatever `gateway/permission-hook.ts` still needs from that
module (the capability guard) moves next to it instead of being deleted.
`readSse`, `prefixSafeLength` and the `Effort` type move from the OpenAI provider
into `src/gateway/` before that directory is deleted.

## Testing

- `npm test` = `tsc --noEmit` + `node --test` over `test/unit/**`, fully offline,
  with the catalog served from a fixture.
- New unit tests: catalog parse and admission filter, cache fallback, picker and
  worker generation, model-id round-trip, effort mapping and rejection,
  `max_tokens` clamp, image admission, auth store read/write/permissions, credits
  view including the degraded path.
- `test/live/openrouter.ts` runs a real streamed tool-using turn, skipped without
  `OPENROUTER_API_KEY`.
- CI on Linux, macOS and Windows, node 24: lint (biome), knip, typecheck, tests.

## Licensing and attribution

Apache-2.0. `LICENSE` kept. `NOTICE` rewritten to state that this project derives
from `greenpolo/cc-multi-cli-plugin` @ `3dc5066` with its own upstream credits
preserved, and that it is a community project affiliated with neither Anthropic
nor OpenRouter. Upstream banner and screenshot assets are removed rather than
rebranded.

## Stages

1. **Trim.** Delete the three providers, merge core + provider into one plugin,
   rename `multi` -> `openrouter` everywhere, drop `@cursor/sdk`, port the Zen
   chat translator, keep the surviving tests green.
2. **Catalog.** Live `/api/v1/models` fetch with disk cache, admission filter,
   picker rows, workers, effort mapping, `max_tokens` clamp, image admission.
3. **Finish.** Credits and usage pane, `bin/claude-openrouter`, docs rewrite,
   NOTICE, CI, publish the public repo.
