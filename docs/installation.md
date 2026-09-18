# Installation

## Requirements

- Claude Code 2.1.272 or newer, with function hooks available.
- Node 24.12 or newer on `PATH`. The plugin runs TypeScript directly, with no
  build step.
- An OpenRouter account and API key: https://openrouter.ai/keys

## Install

In Claude Code:

```text
/plugin marketplace add PaulCailly/claude-code-openrouter
/plugin install openrouter@claude-code-openrouter
/reload-plugins
```

Install at **user scope**. Startup runs before the workspace trust prompt, so a
project-scope install is refused.

Then, in a terminal:

```sh
npm install -g claude-code-openrouter
claude-openrouter connect
claude-openrouter
```

`npx claude-code-openrouter` works too if you would rather not install globally.

## What gets written

| Path | Contents |
| --- | --- |
| `<config>/claude-code-openrouter/auth.json` | the API key, mode 0600 |
| `<cache>/claude-code-openrouter/catalog.json` | the last fetched model catalog |

Nothing else. No shell configuration is edited, and plain `claude` is unchanged.

## Commands

| Command | Purpose |
| --- | --- |
| `claude-openrouter` | launch Claude with the OpenRouter rows and workers |
| `claude-openrouter connect` | store an API key from a hidden prompt |
| `claude-openrouter status` | plugin path, key presence, catalog and credits |
| `claude-openrouter models` | the admitted catalog as JSON |
| `claude-openrouter uninstall` | print exactly what to remove |

Arguments after `--` go to `claude` unchanged, for example
`claude-openrouter -- --resume <session-id>`.

## Environment

| Variable | Effect |
| --- | --- |
| `OPENROUTER_API_KEY` | use this key instead of the stored one |
| `OPENROUTER_MODELS` | comma-separated ids for the `/model` rows; empty hides them |
| `OPENROUTER_PROVIDER` | raw JSON merged into the request's `provider` routing field |
| `OPENROUTER_AUTH_FILE` | override the auth file path |
| `OPENROUTER_CATALOG_FILE` | pin the catalog to a file and skip the network |
| `OPENROUTER_RECEIPTS_FILE` | append JSONL receipts for each completed request |

## From a checkout

```sh
npm ci
/plugin marketplace add /path/to/checkout   # inside Claude Code
node src/launcher.ts --openrouter-models
node src/launcher.ts -- --model openrouter/anthropic/claude-sonnet-5
```

## For agents

Install the plugin at user scope with the two `/plugin` commands above, then
`npm install -g claude-code-openrouter`. Ask the human to run
`claude-openrouter connect` themselves: the key must never be requested, printed
or passed as a command argument. Confirm with `claude-openrouter status`, which
reports key presence without revealing the key.

## Uninstall

```sh
claude-openrouter uninstall
```

It prints the plugin command, the npm command and the two file paths to delete.
