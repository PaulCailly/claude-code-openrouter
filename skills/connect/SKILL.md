---
name: connect
description: Save an OpenRouter API key without exposing it in chat.
disable-model-invocation: true
allowed-tools: Bash
---

Tell the user to run this command in a separate terminal:

```sh
claude-openrouter connect
```

The helper prompts privately and saves the key under the user's config directory
with mode 0600. Tell them to relaunch with `claude-openrouter` afterwards. Never
accept, request, read, or print the key in chat or pass it as a command argument.

An API key is created at https://openrouter.ai/keys.
