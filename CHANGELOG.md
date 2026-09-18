# Changelog

## 0.1.0

First release.

- OpenRouter models in Claude Code's `/model` picker, with named workers per row.
- The model list, capabilities, output limits, image support, effort support and
  prices all come from `GET /api/v1/models`, cached on disk for outages.
- Anthropic Messages requests are translated to OpenRouter chat completions and
  streamed back; Claude Code keeps its own tools, permissions and history.
- `/effort` maps to OpenRouter reasoning effort on models that advertise it.
- The usage pane reports the account credit balance, session tokens and receipts.
- The API key lives in the plugin's own auth file, mode 0600.
- Launching goes through the `claude-openrouter` command; plain `claude` is
  never modified and no shell configuration is written.

Derived from [cc-multi-cli-plugin](https://github.com/greenpolo/cc-multi-cli-plugin)
at commit 3dc5066; see [NOTICE](NOTICE).
