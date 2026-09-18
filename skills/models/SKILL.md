---
name: models
description: List the OpenRouter models this session can use and explain how to change the /model rows.
disable-model-invocation: true
allowed-tools: Bash
---

Run:

```sh
claude-openrouter models
```

It prints every admitted model as JSON: id, context length, output limit, image
support, effort support and price. Only models that advertise tool calling are
admitted, because Claude Code drives them through its own tools.

`/model` shows a short recommended list. To choose the rows yourself, set
`OPENROUTER_MODELS` to a comma-separated list of OpenRouter ids before launching:

```sh
OPENROUTER_MODELS=anthropic/claude-sonnet-5,z-ai/glm-5.3 claude-openrouter
```

An empty value hides the OpenRouter rows. Any admitted id can still be selected
by typing it in `/model`, whether or not it has a row.
