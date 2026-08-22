# pi-cloud-quota

Subscription quota in the [pi](https://github.com/earendil-works/pi-coding-agent) status bar for **Ark (Volcengine Agent/Coding Plan)**, **Kimi For Coding**, and **Ollama Cloud**.

```
Ark 5h 91% ↺3h · wk 50% · mo 29%
Kimi 5h 72% ↺45m · wk 14%
Ollama 5h 2% · wk 5%
```

- Provider name prefix (`Ark` / `Kimi` / `Ollama`), used percent per window
- Color-graded: green < 70%, yellow < 90%, red ≥ 90%
- Reset countdown per window, shown only while remaining quota is below a
  configurable threshold (defaults: 5h < 80%, week < 40%); hours/minutes/days
  formatting (omitted for Ollama — the API reports no reset times)
- Width budget: when the status exceeds `maxWidth` (default 40 visible chars),
  the 5h reset is kept and the week reset is dropped first, then non-5h
  windows, then the 5h reset
- Shows only while the active model belongs to a known provider
- Refreshes on a timer — 30s / 1min / 2min / 5min (default 1min); session
  start and model switches reuse a 5-minute cache
- Quota warnings: toast on severity escalation (80% warning / 90% high /
  100% critical); only critical notifies at error level
- All display options adjustable via `/cloud-quota` or
  `~/.pi/agent/cloud-quota.json`

## Install

```bash
pi install npm:pi-cloud-quota        # from the npm registry (recommended)
# or track the latest main branch:
pi install git:https://github.com/ArtrixTech/pi-cloud-quota
```

Then restart pi (or `/reload`).

## Provider setup

| Provider | Requirement |
|---|---|
| Ark | Official [`arkcli`](https://www.npmjs.com/package/@volcengine/ark-cli): `CI=1 npm i -g @volcengine/ark-cli && arkcli auth login volc-sso`. Works with both Agent Plan (`/api/plan/v3`) and Coding Plan (`/api/coding*`) — any provider whose baseUrl is on `volces.com`. |
| Kimi | `kimi-coding` credential in `~/.pi/agent/auth.json` (API key or OAuth), e.g. via pi's built-in Kimi For Coding login. |
| Ollama | `ollama-cloud` provider in `~/.pi/agent/models.json` with an `apiKey` (ollama.com). |

## Notes

- The footer entry uses pi's `setStatus` mechanism. If you run a theme with a fully custom footer (`setFooter`), it must render `footerData.getExtensionStatuses()` for the status to appear.
- Settings persist to `~/.pi/agent/cloud-quota.json`:
  - `refreshIntervalMs` — 30000/60000/120000/300000 (default 60000)
  - `resetThresholds` — per-window remaining-% threshold for showing the
    reset countdown, e.g. `{"5h": 80, "wk": 40}` (default); a window without
    an entry never shows a reset
  - `maxWidth` — status width budget in visible chars (default 40; 0 =
    unlimited)
  All adjustable via `/cloud-quota`.
- Ollama's `session` window is displayed as `5h` by convention; the API gives no window duration or reset time.
- Ark data comes from `arkcli` (console-identical snapshot), so no Volcengine API key is needed by this extension.

## Development

The extension is plain TypeScript loaded directly by pi (no build step). The pure
helpers (`parseArk` / `parseKimi` / `parseOllama` / `renderQuota` / `formatReset`)
are exported for offline testing:

```bash
node --experimental-strip-types your-test.mjs
```

## License

MIT
