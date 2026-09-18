# Contributor guide

## Orientation

Read [ARCHITECTURE.md](ARCHITECTURE.md) and [README.md](README.md) first. Setup
and limits live in [docs/installation.md](docs/installation.md),
[docs/openrouter.md](docs/openrouter.md),
[docs/permissions.md](docs/permissions.md) and
[docs/platform-support.md](docs/platform-support.md).
`.agent/` is gitignored scratch space. It is never authoritative.

## Code map

| Path | Responsibility |
| --- | --- |
| `bin/claude-openrouter.mjs` | npm entry point; resolves the installed plugin and runs its launcher. |
| `src/launcher.ts` | Loads the catalog, registers models and workers, starts the gateway, spawns Claude. |
| `src/account.ts` | `connect`, `status`, `models` and `uninstall`. |
| `src/gateway/server.ts` | Routes requests and manages sessions. |
| `src/gateway/messages.ts`, `fetch.ts`, `tools.ts`, `sse.ts`, `anthropic.ts` | Shared protocol, outbound fetch, tool aliases, SSE reading, Anthropic-bound cleanup. |
| `src/gateway/executable.ts`, `process-tree.ts` | Resolves executables and manages child processes. |
| `src/gateway/atomic-write.ts`, `state-lock.ts` | Protects files and serialises local state. |
| `src/gateway/mode-hook.ts`, `permission-hook.ts`, `agent-definitions.ts` | Permission modes, capability guard, worker permissions. |
| `src/gateway/mod-*.ts`, `tool-observer.ts` | Claude Mods control-plane routes, compaction, policy, progress. |
| `src/openrouter/catalog.ts` | Fetches, admits and caches the model catalog. |
| `src/openrouter/models.ts` | Catalog to picker rows, workers, effort mapping. |
| `src/openrouter/request.ts`, `chat.ts` | Messages to chat completions and back. |
| `src/openrouter/auth.ts`, `usage.ts` | Key store and credit balance. |
| `src/install/plugins.ts`, `process.ts` | Plugin discovery and child-process helpers. |
| `hooks/` | The Claude Mod: lifecycle, usage pane, workers, compaction. |
| `skills/` | `connect`, `models`, `status`, `uninstall`. |
| `test/unit/` | Offline unit tests. |
| `test/live/` | Opt-in checks against the real OpenRouter API. |
| `.github/workflows/ci.yml` | Runs `npm run check` on Node 24 across Linux, macOS and Windows. |

Import concrete modules directly. Do not add barrel re-exports. Platform-dependent
code accepts an explicit `platform` option so every branch is unit-testable on
Linux.

## Product rules

- Claude Code executes every tool; the plugin never runs an external harness.
- Claude's permission mode controls dispatch at prompt boundaries.
- Capabilities come from the catalog payload, never from a model id.
- Fail explicitly on unsupported modes, unknown workers and ambiguous ownership.
- Never report usage or cost upstream did not send.
- Never print, log or pass the API key as an argument.
- Keep paid probes bounded; live tests are opt-in and spend real credits.

## Verification

Run `npm run check`: Biome lint, Knip, strict type checking and the offline unit
suite. `npm test` runs `tsc --noEmit` plus the unit tests. Use Node 24.12 or
newer.

| Command | Check | Needs |
| --- | --- | --- |
| `npm test` | offline unit suite | none |
| `npm run test:live` | a real streamed OpenRouter turn | `OPENROUTER_API_KEY` |
| `npm run test:live:permissions` | permission modes end to end | Claude login and a key |
| `npm run test:mod` | the Claude Mod | Claude Code with function hooks |

The definition of done is passing checks and an updated `CHANGELOG.md` for
user-facing changes.

## Code style

Biome requires braces, one variable declaration per statement, no nested
ternaries, no parameter reassignment, no explicit `any`, no non-null assertions,
and cognitive complexity of 15 or less. Do not disable rules or raise limits.
Explain any narrow suppression beside the constrained code.
