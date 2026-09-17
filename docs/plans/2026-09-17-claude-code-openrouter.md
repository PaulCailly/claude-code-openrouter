# claude-code-openrouter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the imported `cc-multi-cli-plugin` tree into a single standalone Claude Code plugin that puts OpenRouter models in `/model`, with named workers, Claude-owned tools and permissions, and credit reporting.

**Architecture:** A loopback HTTP gateway impersonates the Anthropic API. A launcher starts it and spawns the real `claude` with `ANTHROPIC_BASE_URL` pointed at it. Requests whose model starts with `openrouter/` are translated to OpenRouter's OpenAI-compatible `chat/completions` and streamed back as Anthropic SSE; everything else is passed through to Anthropic untouched. Claude Mods (function hooks) supply the in-session control plane for model rows, worker rows, permission state and compaction.

**Tech Stack:** TypeScript run directly by node >= 24.12 (type stripping, no build step), `node --test`, biome, knip, js-tiktoken, Claude Code plugin manifests + function hooks.

**Spec:** `docs/specs/2026-09-17-claude-code-openrouter-design.md`

## Global Constraints

- Node >= 24.12. Sources stay `.ts` and are never compiled; `tsc` is typecheck-only (`--noEmit`).
- `erasableSyntaxOnly` and `verbatimModuleSyntax` are on: no enums, no parameter properties, `import type` for types.
- Every relative import inside `src/` and `test/` ends in `.ts`.
- One plugin. After Task 3 there is no `plugins/` directory and no second provider.
- Model route ids are `openrouter/<openrouter-id>`; the openrouter id itself contains a `/` (e.g. `openrouter/anthropic/claude-sonnet-4.5`).
- Worker names are `openrouter-<openrouter-id with "/" replaced by "-">`.
- Env vars are `OPENROUTER_*`. No `MULTI_*` and no `ZEN`/`OPENCODE` names survive.
- Gateway routes are `/openrouter/...`. Gateway header is `x-openrouter-gateway-token`.
- Only models whose `supported_parameters` contains `tools` are admitted.
- Claude effort `xhigh` and `max` clamp to OpenRouter `high`.
- The user's API key is never accepted, printed, logged or passed as a process argument.
- Apache-2.0. `LICENSE` is never edited. `NOTICE` keeps upstream provenance.
- Commit after every task. Commit messages are imperative and mention no AI tooling except the trailer below.
- Every commit ends with `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`.
- Run `npx biome check --write .` before each commit; CI runs `biome check --error-on-warnings .`.

---

## Stage 1 — Trim and rename

### Task 1: Rescue the shared helpers out of the OpenAI provider

Four things live in `plugins/multi-openai/src/responses.ts` that the gateway and the chat translator need after the OpenAI provider is deleted: the `Effort` type, `readSse`, `prefixSafeLength` and `forAnthropic`. Move them to the core before deleting anything.

**Files:**
- Create: `plugins/multi-core/src/gateway/effort.ts`
- Create: `plugins/multi-core/src/gateway/sse.ts`
- Create: `plugins/multi-core/src/gateway/anthropic.ts`
- Create: `test/unit/native-sse.test.ts`
- Modify: `plugins/multi-openai/src/responses.ts` (re-export from the new modules instead of defining)
- Modify: `plugins/multi-core/src/gateway/tool-observer.ts:3`, `plugins/multi-core/src/launcher.ts:29`, `plugins/multi-core/src/gateway/server.ts:23`, `plugins/multi-zen/src/chat.ts:10`, `plugins/multi-zen/src/models.ts:1`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `gateway/effort.ts`: `export const EFFORTS: readonly ['low','medium','high','xhigh','max']`, `export type Effort = (typeof EFFORTS)[number]`
  - `gateway/sse.ts`: `export async function* readSse(stream: AsyncIterable<Uint8Array>): AsyncGenerator<unknown>`, `export function prefixSafeLength(text: string, stops: readonly string[]): number`
  - `gateway/anthropic.ts`: `export function forAnthropic(body: MessagesRequest): MessagesRequest`

- [ ] **Step 1: Write the failing test**

Create `test/unit/native-sse.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { prefixSafeLength, readSse } from '../../plugins/multi-core/src/gateway/sse.ts';

async function* chunks(...parts: string[]) {
  for (const part of parts) {
    yield new TextEncoder().encode(part);
  }
}

test('readSse yields parsed data payloads across chunk boundaries', async () => {
  const seen: unknown[] = [];
  for await (const event of readSse(chunks('data: {"a":', '1}\n\n', 'data: [DONE]\n\n'))) {
    seen.push(event);
  }
  assert.deepEqual(seen, [{ a: 1 }]);
});

test('prefixSafeLength stops before a partial stop sequence', () => {
  assert.equal(prefixSafeLength('hello wor', ['world']), 'hello '.length);
  assert.equal(prefixSafeLength('hello there', ['world']), 'hello there'.length);
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx tsx --version >/dev/null 2>&1; node --test test/unit/native-sse.test.ts`
Expected: FAIL — `Cannot find module .../gateway/sse.ts`.

(If `node --test` on a single `.ts` file complains about the loader, run the suite the way the repo does: `node --test --test-timeout=120000 "test/unit/native-sse.test.ts"`.)

- [ ] **Step 3: Create the three modules by moving the code**

`plugins/multi-core/src/gateway/effort.ts`:

```ts
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type Effort = (typeof EFFORTS)[number];
```

`plugins/multi-core/src/gateway/sse.ts`: move the bodies of `readSse` (responses.ts:657) and `prefixSafeLength` (responses.ts:1123) verbatim, with their helper functions, adding no behaviour.

`plugins/multi-core/src/gateway/anthropic.ts`: move `forAnthropic` (responses.ts:255) verbatim, importing `MessagesRequest` and `ContentBlock` from `./messages.ts`. Keep the signature prefix list as it is for now; Task 4 rewrites it.

- [ ] **Step 4: Re-point every importer**

In `responses.ts`, delete the moved definitions and re-export so the OpenAI provider keeps compiling until Task 2 deletes it:

```ts
export { EFFORTS, type Effort } from '../../multi-core/src/gateway/effort.ts';
export { prefixSafeLength, readSse } from '../../multi-core/src/gateway/sse.ts';
export { forAnthropic } from '../../multi-core/src/gateway/anthropic.ts';
```

Then change the five importers listed under **Files** to import from the new modules directly.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS, same test count as before plus 2.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Move readSse, prefixSafeLength, forAnthropic and Effort into the gateway

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Delete the OpenAI, Cursor and Antigravity providers

**Files:**
- Delete: `plugins/multi-openai/`, `plugins/multi-cursor/`, `plugins/multi-antigravity/`
- Delete: `docs/openai.md`, `docs/cursor.md`, `docs/antigravity.md`
- Delete: `test/unit/native-openai-*.test.ts`, `test/unit/native-cursor-*.test.ts`, `test/unit/native-antigravity-*.test.ts`, `test/unit/native-approval.test.ts`, `test/unit/native-reviewer-discovery.test.ts`, `test/unit/native-agent-catalog.test.ts` (only if it is Cursor-specific — check first), `test/live/native-antigravity.ts`, `test/live/native-cursor-harness.ts`, `test/live/native-openai-cache.ts`, `test/live/native-openai-instructions.ts`, `test/live/native-provider-approval.ts`, `test/live/native-reviewer.ts`, `test/live/native-approval-worker.ts`, `test/live/native-auto-mode.ts`
- Delete: `plugins/multi-core/src/gateway/cursor-settings.ts`, `plugins/multi-core/src/gateway/approval.ts`, `test/unit/native-cursor-settings.test.ts`
- Modify: `plugins/multi-core/src/gateway/server.ts`, `plugins/multi-core/src/launcher.ts`, `plugins/multi-core/src/account.ts`, `plugins/multi-core/src/gateway/provider-usage.ts`, `plugins/multi-core/src/gateway/permission-hook.ts`, `plugins/multi-core/src/gateway/tokens.ts`, `plugins/multi-core/src/install/plugins.ts`, `plugins/multi-core/hooks/register.ts`, `plugins/multi-core/hooks/usage.ts`, `package.json`, `knip.json`, `.claude-plugin/marketplace.json`

**Interfaces:**
- Consumes: `gateway/effort.ts`, `gateway/sse.ts`, `gateway/anthropic.ts` from Task 1.
- Produces: a gateway with exactly two request paths — `handleZen` and `handleAnthropic` — and `estimateInputTokens(request: ChatRequest): number` in `gateway/tokens.ts`.

- [ ] **Step 1: Delete the provider trees and their tests**

```bash
git rm -r -q plugins/multi-openai plugins/multi-cursor plugins/multi-antigravity
git rm -q docs/openai.md docs/cursor.md docs/antigravity.md
git rm -q test/unit/native-openai-*.test.ts test/unit/native-cursor-*.test.ts \
  test/unit/native-antigravity-*.test.ts test/unit/native-approval.test.ts \
  test/unit/native-reviewer-discovery.test.ts
git rm -q test/live/native-antigravity.ts test/live/native-cursor-harness.ts \
  test/live/native-openai-cache.ts test/live/native-openai-instructions.ts \
  test/live/native-provider-approval.ts test/live/native-reviewer.ts \
  test/live/native-approval-worker.ts test/live/native-auto-mode.ts
git rm -q plugins/multi-core/src/gateway/cursor-settings.ts plugins/multi-core/src/gateway/approval.ts
```

Before deleting `gateway/approval.ts`, check what `gateway/permission-hook.ts` still needs from it:

```bash
grep -n "approval" plugins/multi-core/src/gateway/permission-hook.ts
```

If `approvalCapabilityGuard` or `approvalCwdForComparison` is used there, move that function into `permission-hook.ts` before the delete, with its tests moved into `test/unit/native-permission-hook.test.ts`.

- [ ] **Step 2: Run the suite and collect the breakage list**

Run: `npm test`
Expected: FAIL. `tsc` lists every dangling import. That list is the work for Step 3 — keep it.

- [ ] **Step 3: Cut the provider branches out of the core**

Work file by file until `tsc` is clean:

- `gateway/server.ts`: delete the Cursor/OpenAI/Antigravity imports (lines 15-24), `handleOpenAI`, the Cursor harness plumbing, the `approval` wiring, and every `'openai' | 'cursor' | 'antigravity'` arm of the provider union and its `routeFor`/`providerFor` switches. Keep `handleZen` and `handleAnthropic`. `forAnthropic` now comes from `./anthropic.ts`.
- `launcher.ts`: delete the Antigravity/Cursor/OpenAI imports (lines 10-29), `discoverAntigravity`, `installAntigravityHook`, the Cursor login/models CLI commands, and the `codexSignedIn`/`cursorPicker`/`antigravityModels` parameters of `pickerSettings` and `workerDefinitions` — both become single-parameter functions over the Zen (soon OpenRouter) rows.
- `gateway/provider-usage.ts`: delete `codexQuotaView` and the Cursor/Antigravity panes; keep the dashboard shell and the Zen pane.
- `gateway/tokens.ts`: `estimateInputTokens` currently walks a `ResponsesRequest`. Rewrite it over the chat shape:

```ts
import type { ChatRequest } from '../../../multi-zen/src/chat.ts';

/** Local estimate only; upstream usage is authoritative when it arrives. */
export function estimateInputTokens(request: ChatRequest): number {
  let total = 0;
  for (const message of request.messages) {
    total += estimateTextTokens(typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''));
    if ('reasoning_content' in message) {
      total += estimateTextTokens(message.reasoning_content ?? '');
    }
  }
  for (const tool of request.tools ?? []) {
    total += estimateTextTokens(JSON.stringify(tool));
  }
  return total;
}
```

- `install/plugins.ts`: `PROVIDERS` becomes `['zen'] as const` (Task 4 renames it).
- `hooks/register.ts`: delete `displayTools`, the `mcp__multi-core__cursor_*` handlers and the `prefix` constant; keep the `registerUsage/registerLifecycle/registerCompaction/registerWorkers` composition.
- `hooks/usage.ts`, `account.ts`: delete the non-Zen provider rows.
- `package.json`: remove the `@cursor/sdk` dependency and the `test:live:cursor`, `test:live:antigravity`, `test:live:auto-mode`, `test:live:provider-approval`, `test:live:reviewer`, `test:live:approval-worker` scripts. Run `npm install` to update the lockfile.
- `knip.json`, `.claude-plugin/marketplace.json`: drop the deleted entries.

- [ ] **Step 4: Run the suite until it is green**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Prove nothing is left behind**

Run: `grep -rn -i "cursor\|antigravity\|codex\|openai" plugins test docs .claude-plugin package.json knip.json | grep -v "openai-compatible"`
Expected: no hits other than prose in `NOTICE` (rewritten in Task 12).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Remove the OpenAI, Cursor and Antigravity providers

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Collapse the two plugins into one

**Files:**
- Move: `plugins/multi-core/src/*` -> `src/*`, `plugins/multi-core/hooks/*` -> `hooks/*`, `plugins/multi-core/skills/*` -> `skills/*`, `plugins/multi-zen/src/*` -> `src/openrouter/*`, `plugins/multi-zen/skills/connect` -> `skills/connect`
- Delete: `plugins/`, `plugins/multi-zen/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `tsconfig.json`, `knip.json`, `biome.json` (if it names paths), every import path

**Interfaces:**
- Consumes: the trimmed tree from Task 2.
- Produces: the final layout — `src/launcher.ts`, `src/account.ts`, `src/gateway/*.ts`, `src/openrouter/*.ts`, `src/install/*.ts`, `hooks/*.ts`, `skills/*/SKILL.md`.

- [ ] **Step 1: Move the files with git**

```bash
git mv plugins/multi-core/src src
git mv plugins/multi-core/hooks hooks
git mv plugins/multi-core/skills skills
mkdir -p src/openrouter
for f in plugins/multi-zen/src/*.ts; do git mv "$f" "src/openrouter/$(basename "$f")"; done
git mv plugins/multi-zen/skills/connect skills/connect
git rm -r -q plugins
```

- [ ] **Step 2: Fix every import path**

```bash
grep -rln "multi-core/src\|multi-zen/src\|\.\./\.\./multi" src hooks test | sort
```

Rewrite each hit to the new relative path: inside `src/gateway/*` the openrouter modules are `../openrouter/x.ts`; inside `src/openrouter/*` the gateway modules are `../gateway/x.ts`; in `test/**` everything is `../../src/...`.

- [ ] **Step 3: Update the manifests and tool configs**

`.claude-plugin/plugin.json`:

```json
{
  "name": "openrouter",
  "version": "0.1.0",
  "description": "OpenRouter models inside one Claude Code session, with Claude's own tools and permissions.",
  "author": { "name": "Paul Cailly", "url": "https://github.com/PaulCailly" },
  "license": "Apache-2.0",
  "skills": "./skills",
  "hooks": "./hooks/hooks.json"
}
```

`.claude-plugin/marketplace.json`:

```json
{
  "name": "claude-code-openrouter",
  "owner": { "name": "PaulCailly" },
  "metadata": {
    "description": "Use any OpenRouter model inside Claude Code.",
    "version": "0.1.0"
  },
  "plugins": [
    {
      "name": "openrouter",
      "source": "./",
      "version": "0.1.0",
      "description": "OpenRouter models, workers, credits and Claude-owned tools"
    }
  ]
}
```

`tsconfig.json`: `"include": ["src/**/*.ts", "test/**/*.ts"]`.
`knip.json`: entries become `src/launcher.ts`, `src/account.ts`, `src/gateway/permission-hook.ts`, `test/unit/**/*.test.ts`, `test/live/*.ts`; `project` becomes `["src/**/*.ts", "test/**/*.ts"]`; keep `"ignore": ["hooks/**/*.ts"]` (the `claude-code` module has no installable types).

- [ ] **Step 4: Run the suite**

Run: `npm test && npx knip && npx biome check --error-on-warnings .`
Expected: all three clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Collapse the core and provider plugins into one plugin at the repo root

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Rename every `multi` and `zen` identifier to `openrouter`

This is the last mechanical task. After it, nothing in the repo reads as multi-provider.

**Files:** every file under `src/`, `hooks/`, `test/`, `skills/`, plus `package.json`.

**Interfaces:**
- Consumes: the single-plugin tree from Task 3.
- Produces: the public names the later tasks build on — `openrouterRequest`, `readOpenRouterKey`, route prefix `openrouter/`, env prefix `OPENROUTER_`, gateway routes `/openrouter/mod/*` and `/openrouter/permission`, header `x-openrouter-gateway-token`, token-count header `x-openrouter-token-count`, thinking-signature prefix `openrouter-chat:`.

- [ ] **Step 1: Rename the files**

```bash
cd test/unit && for f in native-zen-*.test.ts; do git mv "$f" "${f/native-zen-/native-openrouter-}"; done; cd -
git mv test/live/native-zen.ts test/live/native-openrouter.ts
```

- [ ] **Step 2: Rewrite the identifiers**

```bash
FILES=$(git ls-files 'src/*' 'hooks/*' 'test/*' 'skills/*' package.json)
perl -pi -e '
  s/\bMULTI_/OPENROUTER_/g;
  s/\bOPENCODE_API_KEY\b/OPENROUTER_API_KEY/g;
  s{multi/zen/}{openrouter/}g;
  s{/multi/mod/}{/openrouter/mod/}g;
  s{/multi/permission}{/openrouter/permission}g;
  s/x-multi-gateway-token/x-openrouter-gateway-token/g;
  s/x-multi-token-count/x-openrouter-token-count/g;
  s/\bZen\b/OpenRouter/g;
  s/\bzen\b/openrouter/g;
  s/\bZEN_/OPENROUTER_/g;
  s/\bmulti-core\b/openrouter/g;
' $FILES
```

Then fix what a regex cannot: `zenModel` -> `openrouterModel`, `zenRequest` -> `openrouterRequest`, `readZenKey` -> `readOpenRouterKey`, `ZenAuthError` -> `OpenRouterAuthError`, `handleZen` -> `handleOpenRouter`, `prepareZenRequest` -> `prepareOpenRouterRequest`, `multi-zen-chat:` -> `openrouter-chat:`, and the user-facing strings ("Multi" -> "claude-code-openrouter", "OpenCode Zen" -> "OpenRouter").

- [ ] **Step 3: Sweep for survivors**

Run: `grep -rn -i "\bmulti\b\|\bzen\b\|opencode" src hooks test skills package.json .claude-plugin`
Expected: no hits. Fix any that appear, then re-run.

- [ ] **Step 4: Run the suite**

Run: `npm test && npx biome check --error-on-warnings .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Rename multi and zen identifiers to openrouter

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Stage 2 — Live catalog and OpenRouter requests

### Task 5: Fetch and cache the OpenRouter catalog

**Files:**
- Create: `src/openrouter/catalog.ts`
- Create: `test/fixtures/models.json` (a 6-model excerpt of the real payload: one tool+reasoning+image model, one tool-only model, one tool+reasoning model with `max_completion_tokens: null`, one model without `tools`, one `:free` model with tools, one model with a malformed `pricing`)
- Create: `test/unit/native-openrouter-catalog.test.ts`

**Interfaces:**
- Consumes: `../gateway/effort.ts`.
- Produces:

```ts
export interface CatalogModel {
  id: string;            // 'anthropic/claude-sonnet-4.5'
  name: string;          // 'Anthropic: Claude Sonnet 4.5'
  contextLength: number;
  maxOutputTokens: number;
  images: boolean;
  reasoning: boolean;
  free: boolean;
  pricing: { prompt: number; completion: number };
}
export interface CatalogLoad {
  models: CatalogModel[];
  source: 'network' | 'cache';
  fetchedAt: string;     // ISO 8601
}
export class CatalogError extends Error {}
export function parseCatalog(payload: unknown): CatalogModel[];
export function catalogFile(options?: { env?: NodeJS.ProcessEnv; homedir?: string; platform?: NodeJS.Platform }): string;
export async function loadCatalog(options?: {
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}): Promise<CatalogLoad>;
```

- [ ] **Step 1: Write the failing tests**

`test/unit/native-openrouter-catalog.test.ts`:

```ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { catalogFile, CatalogError, loadCatalog, parseCatalog } from '../../src/openrouter/catalog.ts';

const fixture = JSON.parse(
  await readFile(new URL('../fixtures/models.json', import.meta.url), 'utf8'),
);

test('parseCatalog admits only tool-capable models', () => {
  const models = parseCatalog(fixture);
  assert.ok(models.every((model) => model.id !== 'meta/no-tools-model'));
  assert.ok(models.some((model) => model.id === 'anthropic/claude-sonnet-4.5'));
});

test('parseCatalog reads capabilities from the payload', () => {
  const model = parseCatalog(fixture).find((entry) => entry.id === 'anthropic/claude-sonnet-4.5');
  assert.deepEqual(
    { images: model?.images, reasoning: model?.reasoning, max: model?.maxOutputTokens },
    { images: true, reasoning: true, max: 64000 },
  );
});

test('parseCatalog falls back to context length when max_completion_tokens is null', () => {
  const model = parseCatalog(fixture).find((entry) => entry.id === 'x/no-max-model');
  assert.equal(model?.maxOutputTokens, model?.contextLength);
});

test('parseCatalog flags free models', () => {
  const model = parseCatalog(fixture).find((entry) => entry.id.endsWith(':free'));
  assert.equal(model?.free, true);
});

test('parseCatalog rejects a payload with no data array', () => {
  assert.throws(() => parseCatalog({ nope: true }), CatalogError);
});

test('loadCatalog writes the cache and reports the network source', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'or-catalog-'));
  const load = await loadCatalog({
    homedir: home,
    env: {},
    platform: 'linux',
    fetch: async () => new Response(JSON.stringify(fixture), { status: 200 }),
  });
  assert.equal(load.source, 'network');
  const cached = JSON.parse(await readFile(catalogFile({ homedir: home, env: {}, platform: 'linux' }), 'utf8'));
  assert.equal(cached.data.length, fixture.data.length);
});

test('loadCatalog falls back to the cache when the network fails', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'or-catalog-'));
  const file = catalogFile({ homedir: home, env: {}, platform: 'linux' });
  await writeFile(file, JSON.stringify(fixture), { flush: true }).catch(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(fixture));
  });
  const load = await loadCatalog({
    homedir: home,
    env: {},
    platform: 'linux',
    fetch: async () => {
      throw new Error('offline');
    },
  });
  assert.equal(load.source, 'cache');
  assert.ok(load.models.length > 0);
});

test('loadCatalog fails explicitly with no network and no cache', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'or-catalog-'));
  await assert.rejects(
    loadCatalog({
      homedir: home,
      env: {},
      platform: 'linux',
      fetch: async () => {
        throw new Error('offline');
      },
    }),
    CatalogError,
  );
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test --test-timeout=120000 "test/unit/native-openrouter-catalog.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/openrouter/catalog.ts`**

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ENDPOINT = 'https://openrouter.ai/api/v1/models';

export class CatalogError extends Error {}

export interface CatalogModel {
  id: string;
  name: string;
  contextLength: number;
  maxOutputTokens: number;
  images: boolean;
  reasoning: boolean;
  free: boolean;
  pricing: { prompt: number; completion: number };
}

export interface CatalogLoad {
  models: CatalogModel[];
  source: 'network' | 'cache';
  fetchedAt: string;
}

export interface CatalogOptions {
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function price(value: unknown): number {
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Capabilities are never inferred from an id; only the payload decides. */
export function parseCatalog(payload: unknown): CatalogModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    throw new CatalogError('OpenRouter returned an unrecognised model list.');
  }
  const models: CatalogModel[] = [];
  for (const entry of payload.data) {
    if (!isRecord(entry) || typeof entry.id !== 'string') {
      continue;
    }
    const parameters = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
    if (!parameters.includes('tools')) {
      continue;
    }
    const architecture = isRecord(entry.architecture) ? entry.architecture : {};
    const modalities = Array.isArray(architecture.input_modalities) ? architecture.input_modalities : [];
    const top = isRecord(entry.top_provider) ? entry.top_provider : {};
    const contextLength =
      typeof entry.context_length === 'number' && entry.context_length > 0 ? entry.context_length : 0;
    if (!contextLength) {
      continue;
    }
    const maxOutput =
      typeof top.max_completion_tokens === 'number' && top.max_completion_tokens > 0
        ? top.max_completion_tokens
        : contextLength;
    const pricing = isRecord(entry.pricing) ? entry.pricing : {};
    models.push({
      id: entry.id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
      contextLength,
      maxOutputTokens: maxOutput,
      images: modalities.includes('image'),
      reasoning: parameters.includes('reasoning'),
      free: entry.id.endsWith(':free'),
      pricing: { prompt: price(pricing.prompt), completion: price(pricing.completion) },
    });
  }
  if (!models.length) {
    throw new CatalogError('OpenRouter returned no tool-capable models.');
  }
  return models;
}

export function catalogFile(options: CatalogOptions = {}): string {
  const env = options.env ?? process.env;
  if (env.OPENROUTER_CATALOG_FILE) {
    return env.OPENROUTER_CATALOG_FILE;
  }
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? os.homedir();
  const api = platform === 'win32' ? path.win32 : path.posix;
  const base =
    platform === 'win32'
      ? env.LOCALAPPDATA || api.join(home, 'AppData', 'Local')
      : env.XDG_CACHE_HOME || api.join(home, '.cache');
  return api.join(base, 'claude-code-openrouter', 'catalog.json');
}

async function readCache(file: string): Promise<CatalogLoad | undefined> {
  try {
    const source = await readFile(file, 'utf8');
    const { mtime } = await import('node:fs/promises').then(({ stat }) => stat(file));
    return { models: parseCatalog(JSON.parse(source)), source: 'cache', fetchedAt: mtime.toISOString() };
  } catch {
    return undefined;
  }
}

async function writeCache(file: string, payload: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, payload, 'utf8');
  await rename(temporary, file);
}

/** The network is the source of truth; the cache only covers an outage. */
export async function loadCatalog(options: CatalogOptions = {}): Promise<CatalogLoad> {
  const file = catalogFile(options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs ?? 10000));
  try {
    const response = await (options.fetch ?? fetch)(ENDPOINT, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new CatalogError(`OpenRouter model list failed with HTTP ${response.status}.`);
    }
    const body = await response.text();
    const models = parseCatalog(JSON.parse(body));
    await writeCache(file, body).catch(() => undefined);
    return { models, source: 'network', fetchedAt: new Date().toISOString() };
  } catch (error) {
    const cached = await readCache(file);
    if (cached) {
      return cached;
    }
    throw new CatalogError(
      `Cannot reach the OpenRouter model list and no cached copy exists (${error instanceof Error ? error.message : String(error)}). Check https://status.openrouter.ai.`,
    );
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run the tests until they pass**

Run: `node --test --test-timeout=120000 "test/unit/native-openrouter-catalog.test.ts"`
Expected: PASS (7 tests). Simplify the `readCache`/`writeCache` helpers if the compiler complains about the inline dynamic import — a plain `import { stat }` at the top of the file is preferred.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Load the OpenRouter model catalog with a disk cache fallback

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Turn the catalog into picker rows, workers and efforts

Replaces the static `ZEN_MODELS` table inherited from upstream.

**Files:**
- Rewrite: `src/openrouter/models.ts`
- Rewrite: `test/unit/native-openrouter-models.test.ts`

**Interfaces:**
- Consumes: `CatalogModel` from Task 5, `Effort` from `../gateway/effort.ts`.
- Produces:

```ts
export const RECOMMENDED_IDS: readonly string[];
export type ReasoningEffort = 'low' | 'medium' | 'high';
export interface ModelOption {
  model: string;        // 'openrouter/anthropic/claude-sonnet-4.5'
  worker: string;       // 'openrouter-anthropic-claude-sonnet-4.5'
  label: string;
  description: string;
  catalog: CatalogModel;
}
export function routeId(id: string): string;
export function catalogId(route: string): string | undefined;
export function workerName(id: string): string;
export function pickerOptions(models: readonly CatalogModel[], selection: string | undefined): ModelOption[];
export function workerDefinitions(options: readonly ModelOption[]): Record<string, { model: string; effort?: ReasoningEffort }>;
export function reasoningEffort(model: CatalogModel, effort: Effort | undefined): ReasoningEffort | undefined;
```

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogModel } from '../../src/openrouter/catalog.ts';
import {
  catalogId,
  pickerOptions,
  reasoningEffort,
  routeId,
  workerDefinitions,
  workerName,
} from '../../src/openrouter/models.ts';

const sonnet: CatalogModel = {
  id: 'anthropic/claude-sonnet-4.5',
  name: 'Anthropic: Claude Sonnet 4.5',
  contextLength: 1000000,
  maxOutputTokens: 64000,
  images: true,
  reasoning: true,
  free: false,
  pricing: { prompt: 0.000003, completion: 0.000015 },
};
const plain: CatalogModel = { ...sonnet, id: 'x/plain', name: 'Plain', reasoning: false, images: false };

test('route ids round-trip through the openrouter prefix', () => {
  assert.equal(routeId(sonnet.id), 'openrouter/anthropic/claude-sonnet-4.5');
  assert.equal(catalogId('openrouter/anthropic/claude-sonnet-4.5'), 'anthropic/claude-sonnet-4.5');
  assert.equal(catalogId('claude-sonnet-4-5'), undefined);
});

test('worker names replace slashes', () => {
  assert.equal(workerName(sonnet.id), 'openrouter-anthropic-claude-sonnet-4.5');
});

test('an explicit selection keeps its order and rejects unknown ids', () => {
  const options = pickerOptions([sonnet, plain], 'x/plain,anthropic/claude-sonnet-4.5');
  assert.deepEqual(options.map((option) => option.catalog.id), ['x/plain', 'anthropic/claude-sonnet-4.5']);
  assert.throws(() => pickerOptions([sonnet], 'nope/nope'), /OPENROUTER_MODELS/);
});

test('an empty selection hides every OpenRouter row', () => {
  assert.deepEqual(pickerOptions([sonnet], ''), []);
});

test('the default selection keeps only recommended ids present in the catalog', () => {
  const options = pickerOptions([sonnet, plain], undefined);
  assert.ok(options.every((option) => option.catalog.id !== 'x/plain'));
  assert.ok(options.some((option) => option.catalog.id === 'anthropic/claude-sonnet-4.5'));
});

test('workers exist per row, with effort variants only for reasoning models', () => {
  const agents = workerDefinitions(pickerOptions([sonnet, plain], 'anthropic/claude-sonnet-4.5,x/plain'));
  assert.ok(agents['openrouter-anthropic-claude-sonnet-4.5-high']);
  assert.equal(agents['openrouter-x-plain-high'], undefined);
  assert.equal(agents['openrouter-x-plain'].effort, undefined);
});

test('effort clamps above high and is undefined without reasoning support', () => {
  assert.equal(reasoningEffort(sonnet, 'max'), 'high');
  assert.equal(reasoningEffort(sonnet, 'xhigh'), 'high');
  assert.equal(reasoningEffort(sonnet, 'low'), 'low');
  assert.equal(reasoningEffort(plain, 'high'), undefined);
  assert.equal(reasoningEffort(sonnet, undefined), undefined);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test --test-timeout=120000 "test/unit/native-openrouter-models.test.ts"`
Expected: FAIL.

- [ ] **Step 3: Write `src/openrouter/models.ts`**

```ts
import type { Effort } from '../gateway/effort.ts';
import type { CatalogModel } from './catalog.ts';

const PREFIX = 'openrouter/';

/**
 * Curation is deliberately static: the catalog has no ranking field, so a live
 * sort would reorder the picker at random. Unknown ids drop out silently, so a
 * retired model shrinks the list instead of breaking the launch.
 */
export const RECOMMENDED_IDS: readonly string[] = Object.freeze([
  'anthropic/claude-sonnet-4.5',
  'openai/gpt-5.1',
  'google/gemini-3-pro',
  'deepseek/deepseek-chat',
  'x-ai/grok-4',
  'qwen/qwen3-coder',
  'moonshotai/kimi-k2',
  'z-ai/glm-4.6',
]);

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface ModelOption {
  model: string;
  worker: string;
  label: string;
  description: string;
  catalog: CatalogModel;
}

export function routeId(id: string): string {
  return `${PREFIX}${id}`;
}

export function catalogId(route: string): string | undefined {
  return route.startsWith(PREFIX) ? route.slice(PREFIX.length) : undefined;
}

export function workerName(id: string): string {
  return `openrouter-${id.replaceAll('/', '-')}`;
}

function describe(model: CatalogModel): string {
  const parts = [`${Math.round(model.contextLength / 1000)}k context`];
  parts.push(model.reasoning ? 'effort supported' : 'native reasoning; /effort not applicable');
  if (model.images) {
    parts.push('images');
  }
  parts.push(model.free ? 'free tier' : `$${model.pricing.prompt * 1e6}/M in`);
  return `OpenRouter · ${parts.join(' · ')}`;
}

function option(model: CatalogModel): ModelOption {
  return {
    model: routeId(model.id),
    worker: workerName(model.id),
    label: model.name,
    description: describe(model),
    catalog: model,
  };
}

/** `undefined` means defaults; `''` means hide every row. */
export function pickerOptions(
  models: readonly CatalogModel[],
  selection: string | undefined,
): ModelOption[] {
  const byId = new Map(models.map((model) => [model.id, model]));
  if (selection === undefined) {
    return RECOMMENDED_IDS.flatMap((id) => {
      const model = byId.get(id);
      return model ? [option(model)] : [];
    });
  }
  const ids = [...new Set(selection.split(',').map((id) => id.trim()).filter(Boolean))];
  return ids.map((id) => {
    const model = byId.get(id);
    if (!model) {
      throw new Error(`OPENROUTER_MODELS: unknown or tool-incapable OpenRouter model: ${id}`);
    }
    return option(model);
  });
}

export function workerDefinitions(
  options: readonly ModelOption[],
): Record<string, { model: string; effort?: ReasoningEffort }> {
  const agents: Record<string, { model: string; effort?: ReasoningEffort }> = {};
  for (const item of options) {
    agents[item.worker] = {
      model: item.model,
      ...(item.catalog.reasoning ? { effort: 'medium' as const } : {}),
    };
    if (item.catalog.reasoning) {
      for (const effort of ['low', 'medium', 'high'] as const) {
        agents[`${item.worker}-${effort}`] = { model: item.model, effort };
      }
    }
  }
  return agents;
}

/** OpenRouter exposes three levels; Claude's xhigh and max clamp to high. */
export function reasoningEffort(
  model: CatalogModel,
  effort: Effort | undefined,
): ReasoningEffort | undefined {
  if (!model.reasoning || effort === undefined) {
    return undefined;
  }
  return effort === 'low' || effort === 'medium' ? effort : 'high';
}
```

- [ ] **Step 4: Run the tests until they pass**

Run: `node --test --test-timeout=120000 "test/unit/native-openrouter-models.test.ts"`
Expected: PASS (7 tests).

- [ ] **Step 5: Verify the recommended ids exist upstream**

Run:

```bash
curl -s https://openrouter.ai/api/v1/models | node -e "
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
const ids=new Set(JSON.parse(s).data.map(m=>m.id));
for (const id of process.argv.slice(1)) console.log(ids.has(id)?'ok  '+id:'MISSING '+id);
});" anthropic/claude-sonnet-4.5 openai/gpt-5.1 google/gemini-3-pro deepseek/deepseek-chat x-ai/grok-4 qwen/qwen3-coder moonshotai/kimi-k2 z-ai/glm-4.6
```

Replace any `MISSING` id with a present, tool-capable equivalent from the same vendor. Do not leave a missing id in the list just because the code tolerates it.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Build picker rows, workers and efforts from the live catalog

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Own the API key store

Upstream borrowed OpenCode's `auth.json`. The plugin now keeps its own.

**Files:**
- Rewrite: `src/openrouter/auth.ts`
- Rewrite: `test/unit/native-openrouter-auth.test.ts` (from the renamed zen auth test, if one exists; otherwise create it)

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
export class OpenRouterAuthError extends Error {}
export interface AuthPathOptions { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; homedir?: string }
export function validateKey(value: string): string;
export function authFile(options?: AuthPathOptions): string;
export async function readOpenRouterKey(options?: AuthPathOptions): Promise<string | undefined>;
export async function saveOpenRouterKey(key: string, options?: AuthPathOptions): Promise<void>;
```

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  authFile,
  OpenRouterAuthError,
  readOpenRouterKey,
  saveOpenRouterKey,
  validateKey,
} from '../../src/openrouter/auth.ts';

const unix = { platform: 'linux' as const, env: {} };

test('the env key wins over the store', async () => {
  const key = await readOpenRouterKey({ ...unix, env: { OPENROUTER_API_KEY: 'sk-or-v1-env' }, homedir: '/nonexistent' });
  assert.equal(key, 'sk-or-v1-env');
});

test('a missing store reads as undefined', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'or-auth-'));
  assert.equal(await readOpenRouterKey({ ...unix, homedir: home }), undefined);
});

test('a saved key round-trips and the file is owner-only', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'or-auth-'));
  await saveOpenRouterKey('sk-or-v1-abc', { ...unix, homedir: home });
  assert.equal(await readOpenRouterKey({ ...unix, homedir: home }), 'sk-or-v1-abc');
  const info = await stat(authFile({ ...unix, homedir: home }));
  assert.equal(info.mode & 0o777, 0o600);
});

test('saving twice replaces the key', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'or-auth-'));
  await saveOpenRouterKey('sk-or-v1-first', { ...unix, homedir: home });
  await saveOpenRouterKey('sk-or-v1-second', { ...unix, homedir: home });
  assert.equal(await readOpenRouterKey({ ...unix, homedir: home }), 'sk-or-v1-second');
});

test('keys with whitespace or control characters are rejected', () => {
  assert.throws(() => validateKey('sk or v1'), OpenRouterAuthError);
  assert.throws(() => validateKey(''), OpenRouterAuthError);
});

test('the store path honours XDG_CONFIG_HOME', () => {
  assert.equal(
    authFile({ platform: 'linux', env: { XDG_CONFIG_HOME: '/xdg' }, homedir: '/home/x' }),
    '/xdg/claude-code-openrouter/auth.json',
  );
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test --test-timeout=120000 "test/unit/native-openrouter-auth.test.ts"`
Expected: FAIL.

- [ ] **Step 3: Rewrite `src/openrouter/auth.ts`**

Keep upstream's atomic-write shape (`writeFile` to a `.tmp` sibling with `mode: 0o600, flag: 'wx'`, then `rename`), and change: the path (`$XDG_CONFIG_HOME` or `~/.config`, `%APPDATA%` on Windows, overridable with `OPENROUTER_AUTH_FILE`), the env var (`OPENROUTER_API_KEY`), and the stored shape:

```json
{ "openrouter": { "type": "api", "key": "sk-or-v1-..." } }
```

`validateKey` keeps the printable-ASCII check and additionally rejects the empty string. Saving preserves any other top-level entry already in the file.

- [ ] **Step 4: Run the tests until they pass**

Run: `node --test --test-timeout=120000 "test/unit/native-openrouter-auth.test.ts"`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "Store the OpenRouter API key in the plugin's own auth file

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Translate a Messages request into an OpenRouter chat request

**Files:**
- Rewrite: `src/openrouter/request.ts`
- Modify: `src/openrouter/chat.ts` (drop the Responses import, add the OpenRouter request fields)
- Rewrite: `test/unit/native-openrouter-request.test.ts`

**Interfaces:**
- Consumes: `CatalogModel` (Task 5), `reasoningEffort`/`catalogId` (Task 6), `toChat`/`ChatRequest` from `./chat.ts`, `estimateInputTokens` from `../gateway/tokens.ts`.
- Produces:

```ts
export interface PreparedRequest {
  body: ChatRequest & {
    usage: { include: true };
    reasoning?: { effort: ReasoningEffort };
    provider?: Record<string, unknown>;
  };
  inputTokens: number;
  signaturePrefix: string;
}
export function openrouterRequest(
  body: MessagesRequest,
  model: CatalogModel,
  options?: { providerJson?: string },
): PreparedRequest;
```

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import type { CatalogModel } from '../../src/openrouter/catalog.ts';
import { openrouterRequest } from '../../src/openrouter/request.ts';

const model: CatalogModel = {
  id: 'anthropic/claude-sonnet-4.5',
  name: 'Anthropic: Claude Sonnet 4.5',
  contextLength: 1000000,
  maxOutputTokens: 64000,
  images: true,
  reasoning: true,
  free: false,
  pricing: { prompt: 0.000003, completion: 0.000015 },
};
const noImages: CatalogModel = { ...model, id: 'x/text-only', images: false, reasoning: false };
const base = {
  model: 'openrouter/anthropic/claude-sonnet-4.5',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

test('every request asks for upstream usage accounting', () => {
  assert.deepEqual(openrouterRequest(base, model).body.usage, { include: true });
});

test('effort becomes an OpenRouter reasoning block, clamped at high', () => {
  const prepared = openrouterRequest({ ...base, output_config: { effort: 'max' } }, model);
  assert.deepEqual(prepared.body.reasoning, { effort: 'high' });
});

test('a model without reasoning support rejects an explicit effort', () => {
  assert.throws(
    () => openrouterRequest({ ...base, model: 'openrouter/x/text-only', output_config: { effort: 'high' } }, noImages),
    /does not support effort/,
  );
});

test('max_tokens above the model ceiling is rejected', () => {
  assert.throws(() => openrouterRequest({ ...base, max_tokens: 64001 }, model), /between 1 and 64000/);
});

test('max_tokens defaults below the ceiling', () => {
  assert.equal(openrouterRequest(base, model).body.max_tokens, 32000);
});

test('images are rejected for a text-only model', () => {
  const withImage = {
    ...base,
    model: 'openrouter/x/text-only',
    messages: [
      {
        role: 'user' as const,
        content: [{ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png', data: 'AA' } }],
      },
    ],
  };
  assert.throws(() => openrouterRequest(withImage, noImages), /does not support images/);
});

test('PDF input is rejected with the model id', () => {
  const withPdf = {
    ...base,
    messages: [
      {
        role: 'user' as const,
        content: [{ type: 'document' as const, source: { type: 'base64' as const, media_type: 'application/pdf', data: 'AA' } }],
      },
    ],
  };
  assert.throws(() => openrouterRequest(withPdf, model), /anthropic\/claude-sonnet-4.5/);
});

test('OPENROUTER_PROVIDER json is merged into the provider field', () => {
  const prepared = openrouterRequest(base, model, { providerJson: '{"order":["anthropic"]}' });
  assert.deepEqual(prepared.body.provider, { order: ['anthropic'] });
});

test('invalid OPENROUTER_PROVIDER json fails loudly', () => {
  assert.throws(() => openrouterRequest(base, model, { providerJson: '{' }), /OPENROUTER_PROVIDER/);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test --test-timeout=120000 "test/unit/native-openrouter-request.test.ts"`
Expected: FAIL.

- [ ] **Step 3: Rewrite `src/openrouter/request.ts`**

Delete the Responses branch entirely. The new body:

1. `toChat({ ...body, max_tokens: body.max_tokens ?? Math.min(32000, model.maxOutputTokens) }, model.id)`;
2. reject `max_tokens` outside `1..model.maxOutputTokens` with `OpenRouter max_tokens must be between 1 and ${model.maxOutputTokens}`;
3. walk the Anthropic content blocks before translation: an `image` block with `model.images === false` throws `` `${model.id} does not support images in this integration` ``; a `document` block always throws `` `${model.id} does not accept PDF input in this integration` ``;
4. `reasoningEffort(model, body.output_config?.effort)` — when an effort was requested and the model has `reasoning === false`, throw `` `${model.id} does not support effort ${effort}. Reset /effort to auto to use its native default.` ``; otherwise set `reasoning: { effort }` when defined;
5. `usage: { include: true }` always;
6. `provider: JSON.parse(providerJson)` when provided, throwing `` `OPENROUTER_PROVIDER must be valid JSON: ${message}` `` on a parse failure;
7. `signaturePrefix = \`openrouter-chat:${model.id}:\``;
8. `inputTokens = estimateInputTokens(chatBody)`.

In `chat.ts`, replace the `../../multi-openai/src/responses.ts` import with `../gateway/sse.ts` (Task 1 moved `readSse` and `prefixSafeLength`) and delete any Responses-only helper that is now unreachable.

- [ ] **Step 4: Run the tests until they pass**

Run: `node --test --test-timeout=120000 "test/unit/native-openrouter-request.test.ts"`
Expected: PASS (9 tests).

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Translate Messages requests into OpenRouter chat completions

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Wire the launcher and gateway to the live catalog

**Files:**
- Modify: `src/launcher.ts`, `src/gateway/server.ts`
- Modify: `test/unit/native-launcher.test.ts`, `test/unit/native-gateway.test.ts`

**Interfaces:**
- Consumes: `loadCatalog`, `pickerOptions`, `workerDefinitions`, `catalogId`, `openrouterRequest`, `readOpenRouterKey`.
- Produces: `createNativeGateway({ openrouter: { apiKey, models } })` where `models: readonly CatalogModel[]`; the launcher CLI command `--models` printing the admitted catalog as JSON.

- [ ] **Step 1: Write the failing gateway test**

Add to `test/unit/native-gateway.test.ts`:

```ts
test('an unknown openrouter model is refused before any upstream call', async () => {
  let called = false;
  const gateway = await createNativeGateway({
    openrouter: { apiKey: 'sk-or-v1-test', models: [] },
    fetch: async () => {
      called = true;
      return new Response('{}', { status: 200 });
    },
  });
  const response = await gateway.request('/v1/messages', {
    model: 'openrouter/nope/nope',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(response.status, 400);
  assert.equal(called, false);
  await gateway.close();
});
```

Match the existing helpers in that file rather than the sketch above if its harness differs; the assertion that matters is 400 with no upstream call.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --test-timeout=120000 "test/unit/native-gateway.test.ts"`
Expected: FAIL.

- [ ] **Step 3: Rewire the gateway**

In `server.ts`:

- the options gain `openrouter?: { apiKey: string; models: readonly CatalogModel[] }`;
- `prepareOpenRouterRequest` resolves the model with `catalogId(body.model)` then a lookup in `options.openrouter.models`, throwing `BadRequest` with `Unknown OpenRouter model: ${id}. Run claude-openrouter models for the admitted catalog.` when absent;
- the upstream URL becomes `https://openrouter.ai/api/v1/chat/completions`;
- the headers become

```ts
{
  authorization: `Bearer ${openrouter.apiKey}`,
  'content-type': 'application/json',
  accept: 'text/event-stream',
  'http-referer': 'https://github.com/PaulCailly/claude-code-openrouter',
  'x-title': 'claude-code-openrouter',
  'x-openrouter-session': prepared.cacheKey,
}
```

- the translator is always `fromChat` (the `prepared.endpoint === 'responses'` branch is gone);
- the 4xx/5xx path keeps `UpstreamFailure(status, retry-after, 'OpenRouter')`.

- [ ] **Step 4: Rewire the launcher**

In `launcher.ts`:

- `const key = await readOpenRouterKey()`; when absent, the gateway starts with no OpenRouter rows and the launcher prints one line telling the user to run `claude-openrouter connect`;
- `const catalog = key ? await loadCatalog() : undefined`; a `source === 'cache'` load prints `Using the cached OpenRouter catalog from <fetchedAt>.`;
- `pickerSettings` and `workerDefinitions` take the `ModelOption[]` from `pickerOptions(catalog.models, process.env.OPENROUTER_MODELS)`;
- the picker row's `behavesAs` uses `option.catalog.reasoning` where upstream used `Boolean(efforts?.length)`;
- the `--zen-models` CLI command becomes `--models`, printing `JSON.stringify(catalog.models, null, 2)`;
- the usage text is rewritten for the new flags: `--models`, `OPENROUTER_API_KEY`, `OPENROUTER_MODELS`, `OPENROUTER_PROVIDER`, `OPENROUTER_RECEIPTS_FILE`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test && npx knip && npx biome check --error-on-warnings .`
Expected: all clean.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Feed the launcher and gateway from the live OpenRouter catalog

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Stage 3 — Credits, entry point, docs, release

### Task 10: Report credits and spend

**Files:**
- Rewrite: `src/openrouter/usage.ts`
- Rewrite: `test/unit/native-openrouter-usage.test.ts`
- Modify: `src/gateway/provider-usage.ts`, `hooks/usage.ts`, `hooks/usage-view.ts`

**Interfaces:**
- Consumes: `readOpenRouterKey` (Task 7).
- Produces:

```ts
export type CreditsResult =
  | { status: 'available'; totalCredits: number; totalUsage: number; remaining: number }
  | { status: 'unavailable'; reason: 'missing-key' | 'unauthorized' | 'network' | 'malformed' };
export async function readCredits(options?: {
  apiKey?: string; endpoint?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number;
}): Promise<CreditsResult>;
export function formatCredits(result: CreditsResult): { status: 'ready' | 'unavailable' | 'error'; summary: string; details: string[] };
```

- [ ] **Step 1: Write the failing tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCredits, readCredits } from '../../src/openrouter/usage.ts';

const ok = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

test('credits are read and the remainder computed', async () => {
  const result = await readCredits({ apiKey: 'sk-or-v1-x', fetch: ok({ data: { total_credits: 25, total_usage: 4.5 } }) });
  assert.deepEqual(result, { status: 'available', totalCredits: 25, totalUsage: 4.5, remaining: 20.5 });
});

test('a missing key is not an error', async () => {
  const result = await readCredits({ apiKey: '', fetch: ok({}) });
  assert.deepEqual(result, { status: 'unavailable', reason: 'missing-key' });
});

test('401 reports unauthorized', async () => {
  assert.deepEqual(await readCredits({ apiKey: 'sk-or-v1-x', fetch: ok({}, 401) }), {
    status: 'unavailable',
    reason: 'unauthorized',
  });
});

test('an unrecognised body reports malformed rather than throwing', async () => {
  assert.deepEqual(await readCredits({ apiKey: 'sk-or-v1-x', fetch: ok({ data: { nope: 1 } }) }), {
    status: 'unavailable',
    reason: 'malformed',
  });
});

test('a network failure degrades instead of throwing', async () => {
  const result = await readCredits({
    apiKey: 'sk-or-v1-x',
    fetch: async () => {
      throw new Error('offline');
    },
  });
  assert.deepEqual(result, { status: 'unavailable', reason: 'network' });
});

test('the formatted view never claims a balance it does not have', () => {
  assert.equal(formatCredits({ status: 'unavailable', reason: 'network' }).status, 'error');
  assert.match(
    formatCredits({ status: 'available', totalCredits: 25, totalUsage: 4.5, remaining: 20.5 }).summary,
    /20\.5/,
  );
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test --test-timeout=120000 "test/unit/native-openrouter-usage.test.ts"`
Expected: FAIL.

- [ ] **Step 3: Rewrite `src/openrouter/usage.ts`**

Keep upstream's defensive shape (abort timer, `redirect: 'error'`, status-specific reasons, no throw on a bad body). `GET https://openrouter.ai/api/v1/credits`; accept `data.total_credits` and `data.total_usage` as finite numbers, anything else is `malformed`. `formatCredits` returns `ready` with `` `$${remaining.toFixed(2)} of $${totalCredits.toFixed(2)} remaining` `` and a details line pointing at `https://openrouter.ai/credits`.

- [ ] **Step 4: Wire it into the pane**

In `provider-usage.ts` and `hooks/usage.ts`, replace the quota row with the credits row and keep the existing session-token and receipts rows. The pane's title becomes `OpenRouter`.

- [ ] **Step 5: Run the whole suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Show the OpenRouter credit balance in the usage pane

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Replace the shell installer with an npm entry point

**Files:**
- Create: `bin/claude-openrouter.mjs`
- Delete: `src/install/installation.ts`, `src/install/bootstrap.ts`, `src/setup.ts`, `skills/setup/SKILL.md`, `test/unit/native-install.test.ts`, `test/live/native-install.ts`
- Keep: `src/install/plugins.ts`, `src/install/process.ts`
- Create: `test/unit/native-entry.test.ts`
- Modify: `package.json`, `knip.json`, `skills/connect/SKILL.md`, `skills/status/SKILL.md`, `skills/uninstall/SKILL.md`, new `skills/models/SKILL.md`, `src/account.ts`

**Interfaces:**
- Consumes: `installedPlugins(claude, settingsArgs)` from `src/install/plugins.ts`.
- Produces: `resolvePluginRoot(options): Promise<string>` exported from `src/install/plugins.ts`; the `claude-openrouter` bin with subcommands `connect`, `status`, `models`, and the default launch.

- [ ] **Step 1: Write the failing test**

`test/unit/native-entry.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePluginRoot } from '../../src/install/plugins.ts';

const plugin = (overrides: Record<string, unknown> = {}) => ({
  id: 'openrouter@claude-code-openrouter',
  enabled: true,
  scope: 'user',
  installPath: '/plugins/openrouter',
  ...overrides,
});

test('the user-scope plugin is the root', async () => {
  const root = await resolvePluginRoot({ list: async () => [plugin()] });
  assert.equal(root, '/plugins/openrouter');
});

test('a disabled plugin is not a root', async () => {
  await assert.rejects(resolvePluginRoot({ list: async () => [plugin({ enabled: false })] }), /\/plugin install/);
});

test('a project-scope-only install is refused', async () => {
  await assert.rejects(resolvePluginRoot({ list: async () => [plugin({ scope: 'project' })] }), /user scope/);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test --test-timeout=120000 "test/unit/native-entry.test.ts"`
Expected: FAIL — `resolvePluginRoot` is not exported.

- [ ] **Step 3: Add `resolvePluginRoot` and write the bin**

In `src/install/plugins.ts`, extract the existing user-scope selection into an exported `resolvePluginRoot({ list })` where `list` defaults to the `claude plugin list --json` call, so the test can inject a fixture. Error messages: `Install the openrouter plugin first: /plugin marketplace add PaulCailly/claude-code-openrouter then /plugin install openrouter@claude-code-openrouter.` and `Enable the openrouter plugin at user scope before launching.`

`bin/claude-openrouter.mjs` resolves the installed plugin, then runs its launcher:



```js
#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 24 || (major === 24 && minor < 12)) {
  console.error(
    `claude-openrouter needs Node >= 24.12 (running ${process.versions.node}). The plugin runs TypeScript directly.`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const management = ['connect', 'status', 'models', 'uninstall'].includes(args[0]);

const { stdout } = await promisify(execFile)('claude', ['plugin', 'list', '--json'], {
  maxBuffer: 4 * 1024 * 1024,
  encoding: 'utf8',
}).catch((error) => {
  console.error(`claude-openrouter cannot run claude: ${error.message}`);
  process.exit(1);
});

const plugins = JSON.parse(stdout);
const root = plugins.find(
  (plugin) =>
    plugin.id === 'openrouter@claude-code-openrouter' && plugin.enabled && plugin.scope === 'user',
)?.installPath;
if (!root) {
  console.error(
    'Install the plugin first: /plugin marketplace add PaulCailly/claude-code-openrouter, then /plugin install openrouter@claude-code-openrouter at user scope.',
  );
  process.exit(1);
}

const entry = path.join(root, 'src', management ? 'account.ts' : 'launcher.ts');
const child = spawn(process.execPath, [entry, ...args], {
  stdio: 'inherit',
  env: { ...process.env, OPENROUTER_PLUGIN_ROOT: root },
});
child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
```

`src/account.ts` gains the `connect` subcommand: it prompts for the key with echo disabled (`readline` with `terminal: true` and a muted output stream), calls `saveOpenRouterKey`, and prints where it was written. It never accepts the key as an argument.

`package.json`:

```json
{
  "name": "claude-code-openrouter",
  "version": "0.1.0",
  "private": false,
  "type": "module",
  "description": "Use any OpenRouter model inside one Claude Code session, with Claude's own tools and permissions.",
  "license": "Apache-2.0",
  "repository": { "type": "git", "url": "git+https://github.com/PaulCailly/claude-code-openrouter.git" },
  "bin": { "claude-openrouter": "./bin/claude-openrouter.mjs" },
  "files": ["bin", "src", "hooks", "skills", ".claude-plugin", "docs", "LICENSE", "NOTICE", "README.md"],
  "engines": { "node": ">=24.12.0" }
}
```

Keep the existing `scripts` minus the deleted live tests, and the `devDependencies`. Dependencies shrink to `js-tiktoken` and `yaml` (drop `yaml` too if `grep -rn "from 'yaml'" src hooks` finds nothing).

- [ ] **Step 4: Rewrite the skills**

`skills/connect/SKILL.md` body:

```markdown
Tell the user to run this command in a separate terminal:

```sh
claude-openrouter connect
```

The helper prompts privately and saves the key under the user's config directory with mode 0600. Tell them to relaunch with `claude-openrouter` afterward. Never accept, request, read, or print the key in chat or pass it as a command argument.
```

`skills/models/SKILL.md` tells the user to run `claude-openrouter models` and explains `OPENROUTER_MODELS`. `skills/status/SKILL.md` runs `claude-openrouter status`. `skills/uninstall/SKILL.md` explains that there is nothing to uninstall beyond `/plugin uninstall openrouter@claude-code-openrouter`, `npm rm -g claude-code-openrouter` and deleting the auth file, whose path it prints.

- [ ] **Step 5: Run everything**

Run: `npm test && npx knip && npx biome check --error-on-warnings . && node bin/claude-openrouter.mjs status`
Expected: the first three clean; the last either prints status or the explicit "install the plugin first" message.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "Launch through an npm bin instead of shell integration

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Rewrite the documentation, notice and CI

**Files:**
- Rewrite: `README.md`, `ARCHITECTURE.md`, `NOTICE`, `CONTRIBUTING.md`, `AGENTS.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/installation.md`, `docs/usage.md`, `docs/permissions.md`, `docs/platform-support.md`
- Create: `docs/openrouter.md`
- Delete: `docs/zen.md`, `docs/assets/`, `scripts/banner.mjs`, `.github/ISSUE_TEMPLATE/config.yml` links to upstream
- Modify: `.github/workflows/ci.yml`, `.github/ISSUE_TEMPLATE/*.yml`, `.github/pull_request_template.md`, `package.json` (drop the `banner:*` scripts)

**Interfaces:**
- Consumes: the finished behaviour from Tasks 1-11.
- Produces: no code interface; the README's install block is the contract users follow.

- [ ] **Step 1: Delete the upstream branding**

```bash
git rm -r -q docs/assets scripts
git rm -q docs/zen.md
```

Remove the `banner:generate` and `banner:check` scripts from `package.json` and the `banner:check` step from `check`.

- [ ] **Step 2: Rewrite `NOTICE`**

```
claude-code-openrouter
Copyright 2026 Paul Cailly

This product derives from cc-multi-cli-plugin
(https://github.com/greenpolo/cc-multi-cli-plugin), Copyright 2026 greenpolo,
licensed under Apache 2.0, at commit 3dc5066. The gateway, mods control plane,
permission handling and the chat-completions translator originate there; the
OpenAI, Cursor, Antigravity and OpenCode Zen provider integrations have been
removed and the remaining provider path was rewritten for OpenRouter.

That project in turn acknowledged work by OpenAI (codex-plugin-cc),
sakibsadmanshajib (gemini-plugin-cc) and blowmage (cursor-agent-acp-npm). Those
modules are not present here; the acknowledgment preserves provenance.

The local token estimator uses js-tiktoken
(https://github.com/dqbd/tiktoken), licensed under MIT.

This is a community project, affiliated with neither Anthropic nor OpenRouter.
```

- [ ] **Step 3: Write the README**

Sections, in order: one-line pitch; a note that this is an unofficial community plugin; Install (the four commands below); Use; Models; Credits; Permissions; Platforms; How it works (5 lines + the pointer to `ARCHITECTURE.md`); Provenance (links upstream, states Apache-2.0); Contributing; License.

The install block:

```text
/plugin marketplace add PaulCailly/claude-code-openrouter
/plugin install openrouter@claude-code-openrouter
/reload-plugins
```

then, in a terminal:

```sh
npm install -g claude-code-openrouter
claude-openrouter connect
claude-openrouter
```

- [ ] **Step 4: Rewrite the docs**

- `docs/openrouter.md`: key setup, the catalog and its cache, `OPENROUTER_MODELS`, effort mapping, images, PDF refusal, `OPENROUTER_PROVIDER`, cost accounting.
- `docs/installation.md`: the block above, the Node 24.12 requirement, the `#for-agents` section rewritten for this repo.
- `docs/usage.md`: `/model`, `/effort`, workers, the usage pane, `OPENROUTER_RECEIPTS_FILE`.
- `docs/permissions.md`: delete every harness paragraph; Claude executes all tools here.
- `docs/platform-support.md`: reduce the matrix to this plugin; mark what is CI-verified versus live-verified.
- `ARCHITECTURE.md`: one provider, one table row, the diagram reduced to `Claude Code -> mods -> gateway -> OpenRouter`.
- `AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING.md`: repo name, commands, the Node floor.
- `CHANGELOG.md`: reset to a single `## 0.1.0` entry describing the first release.

- [ ] **Step 5: Fix CI and the templates**

`.github/workflows/ci.yml`: node-version `24`, matrix `ubuntu-latest, macos-latest, windows-latest`, steps `npm ci`, `npx biome check --error-on-warnings .`, `npx knip`, `npm test`. Remove any provider-specific job. Update the badge URLs in the README to `PaulCailly/claude-code-openrouter`. Update the issue templates and the PR template to drop provider dropdown options that no longer exist.

- [ ] **Step 6: Prove no upstream name survives outside NOTICE**

Run: `grep -rn -i "greenpolo\|cc-multi-cli\|claude-multi\|multi-cli" --exclude-dir=.git . | grep -v "^./NOTICE\|^./docs/specs/\|^./docs/plans/"`
Expected: no hits.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "Rewrite the documentation, notice and CI for claude-code-openrouter

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Prove it against the live API, then publish

**Files:**
- Rewrite: `test/live/native-openrouter.ts`
- Modify: `package.json` (`test:live` script)

**Interfaces:**
- Consumes: everything above.
- Produces: a public repository at `github.com/PaulCailly/claude-code-openrouter`.

- [ ] **Step 1: Rewrite the live test**

`test/live/native-openrouter.ts` starts the gateway with a real key from `OPENROUTER_API_KEY`, sends a streamed `/v1/messages` request for `openrouter/<first recommended id present in the catalog>` carrying one tool definition, and asserts: SSE frames arrive in Anthropic shape, a `tool_use` block round-trips, and the final `usage` carries non-zero `input_tokens` and `output_tokens`. It exits 0 with a skip message when the key is absent.

- [ ] **Step 2: Run it**

Run: `OPENROUTER_API_KEY=... node test/live/native-openrouter.ts`
Expected: PASS. If the key is missing, ask the user to run it; do not fake the result and do not print the key.

- [ ] **Step 3: Run the real thing end to end**

Install the plugin locally from the working copy, run `claude-openrouter`, and check by hand: `/model` lists the OpenRouter rows; selecting one and asking for a file edit produces a real edit through Claude's tools; `/effort high` is accepted on a reasoning model and refused on a plain one; the usage pane shows a credit balance; a worker (`openrouter-<id>`) runs and can be cancelled.

Record the result in `docs/platform-support.md` as live-verified on macOS.

- [ ] **Step 4: Full green gate**

Run: `npm test && npx knip && npx biome check --error-on-warnings .`
Expected: all clean. Do not proceed otherwise.

- [ ] **Step 5: Publish**

```bash
gh repo create PaulCailly/claude-code-openrouter --public \
  --description "Use any OpenRouter model inside one Claude Code session, with Claude's own tools and permissions." \
  --source . --remote origin --push
```

Then set the topics and confirm CI is green:

```bash
gh repo edit PaulCailly/claude-code-openrouter --add-topic claude-code,openrouter,claude-code-plugin,llm
gh run watch
```

- [ ] **Step 6: Commit and tag**

```bash
git tag -a v0.1.0 -m "claude-code-openrouter 0.1.0"
git push origin v0.1.0
```

npm publishing is a separate decision; do not publish the package without asking.

---

## Self-review

**Spec coverage:** shape -> Tasks 3, 11; launch -> Task 11 (bin) and Task 9 (launcher env); catalog -> Tasks 5, 6; workers -> Task 6; request translation -> Task 8 and the gateway half in Task 9; permissions -> untouched by design, verified in Task 13 step 3; usage and credits -> Task 10; authentication -> Task 7 and the `connect` subcommand in Task 11; removals -> Tasks 1, 2, 11, 12; testing -> every task plus Task 13; licensing -> Task 12; the three spec stages map to the three stages here.

**Known risk to watch during execution:** Task 2's edits to `server.ts` and `launcher.ts` are the only place where a mistake is invisible to the type checker — both files carry behaviour that no unit test covers (process-tree cancellation, settings passthrough). Re-read the diff of those two files before committing Task 2.
