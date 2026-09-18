---
name: uninstall
description: Explain how to remove the OpenRouter plugin, command and stored key.
disable-model-invocation: true
allowed-tools: Bash
---

Run `claude-openrouter uninstall` to print the exact paths, then tell the user:

1. `/plugin uninstall openrouter@claude-code-openrouter`
2. `npm rm -g claude-code-openrouter`
3. delete the auth file and catalog cache the command printed

Nothing else was ever modified: plain `claude` is untouched and no shell
configuration was written.
