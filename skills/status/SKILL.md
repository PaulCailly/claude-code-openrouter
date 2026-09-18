---
name: status
description: Show what this plugin has connected — key, catalog and credit balance.
disable-model-invocation: true
allowed-tools: Bash
---

Run:

```sh
claude-openrouter status
```

It prints the plugin path, whether a key is stored (never the key itself), the
auth and catalog file paths, how many models are admitted, where the catalog came
from, and the OpenRouter credit balance.
