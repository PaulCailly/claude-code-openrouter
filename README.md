# claude-code-openrouter

**Any OpenRouter model, inside one Claude Code session, running Claude's own tools.**

[![CI](https://github.com/PaulCailly/claude-code-openrouter/actions/workflows/ci.yml/badge.svg)](https://github.com/PaulCailly/claude-code-openrouter/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Built for Claude Code](https://img.shields.io/badge/built_for-Claude_Code-d97757)](https://docs.anthropic.com/en/docs/claude-code)
[![Node 24.12+](https://img.shields.io/badge/Node-%E2%89%A524.12-555)](#install)

Pick an OpenRouter model in `/model` and keep everything else: Claude Code reads,
edits, greps and runs your tools, applies its own permission mode, and keeps the
conversation. The model is the only thing that changes.

This is an unofficial community plugin, affiliated with neither Anthropic nor
OpenRouter.

[Install](#install) · [Use](#use) · [Models](#models) · [Credits](#credits) · [How it works](#how-it-works) · [Provenance](#provenance)

## Install

In Claude Code:

```text
/plugin marketplace add PaulCailly/claude-code-openrouter
/plugin install openrouter@claude-code-openrouter
/reload-plugins
```

Then, in a terminal (Node 24.12 or newer):

```sh
npm install -g claude-code-openrouter
claude-openrouter connect
claude-openrouter
```

`connect` prompts for an [OpenRouter API key](https://openrouter.ai/keys)
privately and stores it with mode 0600 under your config directory. Launch with
`claude-openrouter`; plain `claude` is never modified and no shell configuration
is written.

## Use

`/model` lists the OpenRouter rows next to Claude's own. `/effort` sets reasoning
effort on models that advertise it. Each visible row also gets a named worker —
`openrouter-anthropic-claude-sonnet-5`, and `-low` / `-medium` / `-high` variants
for reasoning models — that runs as a subagent with progress and cancellation.

Claude's permission mode governs every OpenRouter run, because Claude Code is
what executes the tools. See [permissions](docs/permissions.md).

Resume a saved session with `claude-openrouter --resume <session-id>`.

## Models

The catalog is fetched from OpenRouter at launch and cached on disk, so context
length, output limits, image support, effort support and prices are never stale.
Only models that advertise tool calling are admitted — a model that cannot call
tools cannot drive a Claude Code session.

`/model` shows a short recommended list. Choose your own rows with
`OPENROUTER_MODELS`:

```sh
OPENROUTER_MODELS=anthropic/claude-sonnet-5,z-ai/glm-5.3 claude-openrouter
```

An empty value hides the OpenRouter rows. Any admitted id stays selectable by
typing it. `claude-openrouter models` prints the full admitted catalog. More in
[docs/openrouter.md](docs/openrouter.md).

## Credits

`/openrouter-usage` shows your OpenRouter credit balance, this session's tokens
and billed cost as OpenRouter reports it, and per-worker receipts. Set
`OPENROUTER_RECEIPTS_FILE` before launching to append JSONL receipts. See
[usage and receipts](docs/usage.md).

## How it works

The launcher starts a loopback gateway and runs the real `claude` against it.
Requests for `openrouter/...` models are translated into OpenRouter chat
completions and streamed back in Anthropic's shape; every other request is
forwarded to Anthropic untouched. Claude Mods supply the in-session control plane
for model rows, worker rows, permissions and compaction.

```text
Claude Code session (/model, workers, prompts)
                  |
        Claude Mods control plane
                  |
             Node gateway
            /            \
    Anthropic          OpenRouter
   passthrough      chat completions
```

Details in [ARCHITECTURE.md](ARCHITECTURE.md).

## Platforms

Linux, macOS and Windows; CI runs the offline checks on all three. See
[platform support](docs/platform-support.md).

## Documentation

| Start here | Learn more |
| --- | --- |
| [Installation](docs/installation.md) | [Permissions](docs/permissions.md) |
| [OpenRouter models and limits](docs/openrouter.md) | [Architecture](ARCHITECTURE.md) |
| [Usage and receipts](docs/usage.md) | [Platform support](docs/platform-support.md) |

## Provenance

This project derives from
[cc-multi-cli-plugin](https://github.com/greenpolo/cc-multi-cli-plugin) by
greenpolo, Apache 2.0, at commit `3dc5066`. Its gateway, mods control plane,
permission handling and chat translator are the foundation here; its four
provider integrations were removed and the remaining path was rewritten for
OpenRouter. See [NOTICE](NOTICE).

## Contributing

Bug reports and improvements are welcome; see the
[contributing guide](CONTRIBUTING.md).

## License

Apache 2.0.
