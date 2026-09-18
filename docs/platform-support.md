# Platform support

| Platform | Status |
| --- | --- |
| Linux | CI offline checks on every commit |
| macOS | CI offline checks on every commit; live-verified |
| Windows | CI offline checks on every commit |
| WSL | behaves as Linux |

CI runs `npm run check` — Biome, Knip, strict type checking and the offline unit
suite — on Linux, macOS and Windows with Node 24.

## Live checks

| Command | Covers | Needs |
| --- | --- | --- |
| `npm run test:live` | a real streamed OpenRouter turn with tools, usage and resume | `OPENROUTER_API_KEY` |
| `npm run test:live:permissions` | permission modes end to end | Claude login and an API key |
| `npm run test:mod` | the Claude Mods control plane | Claude Code with function hooks |

Live checks spend real OpenRouter credits. They are opt-in and never run in CI.

## Notes

- Node 24.12 is the floor because the sources are executed as TypeScript.
- Windows uses `%APPDATA%` for the key and `%LOCALAPPDATA%` for the catalog cache.
- Platform-dependent code takes an explicit `platform` option, so every branch is
  unit-testable on any host.
