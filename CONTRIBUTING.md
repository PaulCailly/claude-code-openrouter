# Contributing

Start with the [README](README.md) for usage and
[ARCHITECTURE.md](ARCHITECTURE.md) for the execution and permission boundaries.
[AGENTS.md](AGENTS.md) has the code map, rules and full verification guide.

## Local setup

Node 24.12 or newer, and npm.

```sh
git clone https://github.com/PaulCailly/claude-code-openrouter.git
cd claude-code-openrouter
npm ci
npm run check
```

`npm run check` covers formatting and lint, unused code, strict TypeScript and
the offline unit suite. It needs no API key and spends nothing.

## Making a change

1. Branch, and keep the change focused on one problem.
2. Add or update unit tests for behaviour changes. Documentation-only changes do
   not need new tests.
3. Run `npm run check` before opening a pull request.
4. Update `CHANGELOG.md` for anything user-facing.
5. Never commit an API key, a captured request body or a recorded conversation.

## Live checks

`npm run test:live` runs one real streamed turn against OpenRouter and spends
real credits. It is opt-in, needs `OPENROUTER_API_KEY`, and never runs in CI.

## Scope

This plugin covers OpenRouter only. Requests to add another provider belong
upstream in [cc-multi-cli-plugin](https://github.com/greenpolo/cc-multi-cli-plugin),
which this project derives from.
