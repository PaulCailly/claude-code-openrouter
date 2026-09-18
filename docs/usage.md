# Usage and receipts

`/openrouter-usage` opens a pane with three things.

| Row | Source |
| --- | --- |
| Credit balance | `GET /api/v1/credits`: purchased credits minus spend |
| Session tokens | the `usage` block OpenRouter returns on every request |
| Worker receipts | one entry per completed request in this session |

A failing credits call degrades to "balance unavailable" and never blocks a run.
The balance is account-wide, not session-scoped: review spend at
https://openrouter.ai/credits.

## Claude's own cost line is not your OpenRouter spend

Claude Code prices every row with one of its own model profiles, because that is
what `behavesAs` selects for the effort UI. Its `/cost` line therefore reports
what the turn *would* have cost on that Claude model, not what OpenRouter
charged. Use `/openrouter-usage` for real spend, and OpenRouter's own dashboard
as the final word.

## Token counts

Every request sets `usage: { include: true }`, so input, output, cache-read and
cache-write counts come from OpenRouter. When a stream is interrupted or
cancelled, final usage can be missing; the pane says so instead of guessing.

`/v1/messages/count_tokens` is answered locally and labelled with
`x-openrouter-token-count: estimate`. It is a local estimate, not a billed count.

## Receipts

Set `OPENROUTER_RECEIPTS_FILE` before launching to append one JSON object per
line for each completed request: session, worker, model, route, token counts and
whether the counts came from the provider or from a local estimate.

```sh
OPENROUTER_RECEIPTS_FILE=~/openrouter-receipts.jsonl claude-openrouter
```

Receipts contain no prompt text, no completion text and no credentials.
