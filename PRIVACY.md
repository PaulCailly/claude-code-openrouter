# Privacy

The gateway runs on your machine. This project has no hosted service and collects
no telemetry. Claude Code and OpenRouter have their own data handling and privacy
policies.

## What is sent where

| Destination | Endpoint | Data sent |
| --- | --- | --- |
| Anthropic | `https://api.anthropic.com`, through Claude's own connection | Claude Messages requests, conversation context, tools and attachments, for Claude models and Claude-side review. |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | For OpenRouter models only: the translated conversation, system instructions, tool definitions, tool results and any admitted images. |
| OpenRouter | `https://openrouter.ai/api/v1/models` | Nothing but the request itself; no key is sent. |
| OpenRouter | `https://openrouter.ai/api/v1/credits` | Your API key, to read the account balance. |

OpenRouter routes requests to an underlying model provider. Its routing and data
policies apply: https://openrouter.ai/docs/features/privacy-and-logging.
`OPENROUTER_PROVIDER` can constrain that routing.

## What stays local

- The API key, in the plugin's own auth file with mode 0600. It is never printed,
  logged, passed as a command argument or included in receipts.
- The model catalog cache.
- Receipts, when `OPENROUTER_RECEIPTS_FILE` is set. They contain session, worker,
  model, route and token counts — no prompt text, no completion text, no key.

## Isolation

The OpenRouter key never reaches Anthropic requests, and Anthropic credentials
never reach OpenRouter. Inbound Anthropic authentication headers are stripped
before any OpenRouter call, and the loopback gateway authenticates with a
per-session token.
