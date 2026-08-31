# pi-cloud-quota

Subscription quota & pay-as-you-go balance in the [pi](https://github.com/earendil-works/pi-coding-agent) status bar.

**Supported providers (18)**

- Subscription windows: **Ark** (Volcengine Agent/Coding Plan), **Kimi For Coding**, **Ollama Cloud**, **OpenAI Codex** (ChatGPT plan), **GitHub Copilot**, **Anthropic Claude**, **GLM Coding Plan** (bigmodel.cn / z.ai), **MiniMax Coding Plan**, **Synthetic**
- Balance display: **OpenRouter**, **Moonshot**, **DeepSeek**, **SiliconFlow**, **StepFun**, **xAI**, **DeepInfra**, **Vercel AI Gateway**
- One-api / new-api gateways: automatic billing probing for any self-hosted OpenAI-compatible gateway (new-api, one-api and derivatives)

Wrong or missing numbers for one of these? [Open an issue](https://github.com/ArtrixTech/pi-cloud-quota/issues). Adding a provider or fixing one that drifted? Pull requests are welcome — see [Issues & PRs](#issues--prs).

```
Ark 5h 91% ↺3h · wk 50% · mo 29%
Kimi 5h 72% ↺45m · wk 14%
Codex 5h 5% · wk 24%
GLM 5h 15% · wk 44%
Copilot mo 12% ↺8d
OpenRouter $12.08
newapi-codex $20.32 spent
```

- Provider name prefix, used percent per window (or remaining amount for
  balance-type providers)
- Color-graded: green < 70%, yellow < 90%, red \u003e= 90%
- Reset countdown per window, shown only while remaining quota is below a
  configurable threshold (defaults: 5h \u003c 80%, week \u003c 40%); hours/minutes/days
  formatting (Ollama: predicted from the global reset grid — the API reports
  no reset times)
- Width budget: when the status exceeds `maxWidth` (default 40 visible chars),
  the 5h reset is kept and the week reset is dropped first, then non-5h
  windows, then the 5h reset
- Shows only while the active model belongs to a known provider; unknown
  OpenAI-compatible providers fall back to one-api/new-api billing probing
  (auto-hidden when the gateway answers nothing)
- Refreshes on a timer — 30s / 1min / 2min / 5min (default 1min); session
  start and model switches reuse a 5-minute cache. Failed fetches retry on
  exponential backoff (5min → 30min cap) instead of every tick, so a dead
  SSO session never hammers the token-exchange endpoint into a rate limit
- Ark SSO lifecycle: when the Ark session is missing/expired the status shows
  `Ark 未登录` (instead of a silent `✗`), and a toast tells you to run
  `/cloud-quota login` — one command that opens the browser SSO flow and
  refreshes the quota automatically on completion (also available as the
  first entry of the `/cloud-quota` menu). The local refresh token is decoded
  to warn ~12h before the server-side expiry (tokens are not rotated; each
  login is valid ~48h). When the token-exchange endpoint is rate-limiting
  the account, the status shows `Ark 限流中` and login failures say to wait
  instead of retrying
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

## Provider coverage & status

Three status levels, stated per provider:

- ✅ **verified** — exercised against a real account: live request succeeded and real quota/balance data was parsed.
- 🟡 **endpoint verified** — request and auth path verified live (HTTP 200 / auth accepted); the local account has no active plan or was rejected at the business layer, so a real subscription display still needs confirmation from community users.
- 🧪 **untested** — no local credential; implemented from official docs / multiple independent community implementations and response shapes. Users with real credentials are welcome to open issues with (sanitized) findings.

| Provider | Status | Endpoint / channel | Credential lookup order |
|---|---|---|---|
| Ark (Volcengine) | ✅ verified | `arkcli usage plan` CLI snapshot | `arkcli` SSO session |
| Kimi For Coding | ✅ verified | `GET api.kimi.com/coding/v1/usages` | pi auth `kimi-coding` (key/OAuth) |
| Ollama Cloud | ✅ verified | `GET ollama.com/api/usage` | models.json `ollama-cloud.apiKey` |
| OpenAI Codex (ChatGPT plan) | ✅ verified | `GET chatgpt.com/backend-api/wham/usage` (5h + weekly, credits-aware) | `~/.codex/auth.json` tokens → pi auth `openai-codex`; silent refresh on 401/403 (in-memory only) |
| GitHub Copilot | ✅ verified | `GET api.github.com/copilot_internal/user` (premium → chat fallback; monthly) | `$GITHUB_TOKEN`/`$GH_TOKEN` → `gh auth token`; auto v2 token exchange on 401 |
| OpenRouter (balance) | ✅ verified | `GET openrouter.ai/api/v1/credits` (`total_credits` − `total_usage`) | models.json → opencode store → `$OPENROUTER_API_KEY` |
| one-api/new-api gateway (balance) | 🟡 endpoint verified | `GET {origin}/v1/dashboard/billing/subscription` + `/usage`; unlimited tokens (hard_limit 1e8) render as `… spent` | models.json `<provider>.apiKey`; probed automatically for any unmatched OpenAI-compatible provider, hidden after first failure |
| GLM Coding Plan (bigmodel.cn / z.ai) | 🟡 endpoint verified | `GET {open.bigmodel.cn\|api.z.ai}/api/monitor/usage/quota/limit` (5h tokens + weekly + plan level); bare key first, `Bearer` retry on 401 | CN: pi auth/models.json `bigmodel-cn` → `$ZHIPUAI_API_KEY`; global: opencode store `zai`/`zai-coding-plan` → `$ZAI_API_KEY` |
| Moonshot (balance) | 🟡 endpoint reachable, local key rejected (401) | `GET api.moonshot.cn\|api.moonshot.ai/v1/users/me/balance` | models.json `<provider>.apiKey` → opencode store `moonshotai-cn`/`moonshotai` → `$MOONSHOT_API_KEY` |
| Anthropic Claude (subscription) | 🧪 untested | `GET api.anthropic.com/api/oauth/usage` + `anthropic-beta: oauth-2025-04-20` (5h/7d; plain `sk-ant-` keys stay hidden by design) | pi auth `anthropic` OAuth token |
| MiniMax Coding Plan | 🧪 untested | `GET api.minimax.io\|api.minimaxi.com/v1/token_plan/remains` (5h + weekly; region auto-picked) | models.json → `$MINIMAX_API_KEY` |
| Synthetic | 🧪 untested | `GET api.synthetic.new/v2/quotas` (rolling 5h requests) | `$SYNTHETIC_API_KEY` |
| DeepSeek (balance) | 🧪 untested | `GET api.deepseek.com/user/balance` | models.json → `$DEEPSEEK_API_KEY` |
| SiliconFlow (balance) | 🧪 untested | `GET api.siliconflow.cn\|.com/v1/user/info` | models.json → `$SILICONFLOW_API_KEY` |
| StepFun (balance) | 🧪 untested | `GET api.stepfun.com/v1/accounts` (shape from public docs; needs a real account) | models.json → `$STEPFUN_API_KEY` |
| xAI (credits) | 🧪 untested | `GET api.x.ai/v1/api-key` (credit grants) | models.json → `$XAI_API_KEY` |
| DeepInfra (balance) | 🧪 untested | `GET api.deepinfra.com/payment/checklist?compute_owed=true` (prepaid deposit = negative `stripe_balance`) | models.json → `$DEEPINFRA_API_KEY` |
| Vercel AI Gateway (balance) | 🧪 untested | `GET ai-gateway.vercel.sh/v1/credits` | models.json → `$VERCEL_AI_GATEWAY_API_KEY` |

Failed fetches degrade to a dim `<provider> ✗`; missing subscriptions (e.g. GLM answers
`当前用户不存在coding plan` with HTTP 200) surface the provider message in the error path.

## Issues & PRs

Most endpoints here are internal developer surfaces documented by community
tools (CodexBar, pi-quotas, @satas/pi-usage-bar, openusage.sh); a provider can
break silently when the vendor changes it. The coverage table states exactly
what has been verified against real accounts (✅), what is endpoint-verified
but still needs a live subscription (🟡), and what is implemented from public
implementations without a local credential (🧪). Community reports are the
primary quality signal for the 🟡 and 🧪 rows.

- **Wrong or missing numbers?** [Open an issue](https://github.com/ArtrixTech/pi-cloud-quota/issues) with: provider name, the pi model in use, the status line shown, and the failure path (a `<provider> ✗` carries the `HTTP <status>` or business error that caused it). Sanitize everything: no API keys, tokens, cookies, or account-identifying response payloads.
- **Endpoint drifted, or a provider missing?** PRs welcome. Adding a provider = one exported parse function + one fetch function + one `matchSpec` branch (see Development below); keep `npx esbuild extensions/cloud-quota.ts --format=esm --outfile=/dev/null` clean, and flip the coverage-table row to ✅ once verified against a real account.
- 提 issue / PR 前请务必脱敏：不要粘贴 API key、token、cookie 或带账号标识的响应内容。

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
- Ollama Cloud resets are **global** — the same instant for every account — on an epoch-aligned grid: session resets every 5h (multiples of 5h since Unix epoch, so the hour cycles through all 24 over 5 days), weekly resets every 7d at Monday 00:00 UTC. The extension predicts the next reset locally (`nextReset`); community-verified against the settings-page countdown (ollama/ollama#12532).
- Ark data comes from `arkcli` (console-identical snapshot), so no Volcengine API key is needed by this extension.
- Codex access tokens are short-lived. On 401/403 the extension runs a
  silent refresh against `auth.openai.com/oauth/token` (the well-known
  Codex CLI client id) and keeps the fresh token in memory for 10 minutes;
  it never writes credential files. Reading `~/.codex/auth.json` picks up
  tokens refreshed by the Codex CLI itself.
- GLM's monitor endpoint is an official plugin (`zai-coding-plugins`)
  surface; it replies HTTP 200 with a business error for accounts without a
  coding plan, which the extension reports as a failure (`✗`). Region
  implementations disagree on `Bearer` vs bare key — both are attempted.
- Gateway probing marks a (gateway, token) pair dead after the first
  failure (some new-api deployments disable billing routes), so unrelated
  tokens on the same gateway stay independent.
- Most subscription endpoints above are internal/unpublished developer
  surfaces documented by community tools (CodexBar, pi-quotas,
  @satas/pi-usage-bar, openusage.sh). They work today and can change
  without notice; treat breaking reports as expected.

## Changelog

### 0.5.0 — 2026-08-31

- New providers (16 total): OpenAI Codex, GitHub Copilot, GLM Coding Plan
  (bigmodel.cn + z.ai, auto-region), Anthropic Claude, MiniMax Coding Plan,
  Synthetic, and balance-type OpenRouter, Moonshot, DeepSeek, SiliconFlow,
  StepFun, xAI, DeepInfra, Vercel AI Gateway, plus automatic one-api/new-api
  gateway billing probing.
- New balance display type: `OpenRouter $12.08` / `newapi-codex $20.32
  spent`, with remaining-fraction coloring when a limit is known.
- Codex silent token refresh (in-memory, never writes credential files);
  Copilot premium → chat quota fallback with v2 token exchange;
  one-api-family gateway probing with per-token dead-marking and auto-hide.
- Status statuses: `测试状态` per provider documented in the coverage table
  above (✅ verified / 🟡 endpoint verified / 🧪 untested — community help
  welcome for 🧪 rows).

### 0.4.0

- Ark SSO login from any model, `logged_in`-based login detection, model-
  agnostic login flow.

### 0.3.0 and earlier

- Ark / Kimi / Ollama Cloud window quota, warnings, `/cloud-quota` settings
  menu. See git history.

## Development

The extension is plain TypeScript loaded directly by pi (no build step). The pure
helpers (`parseArk` / `parseKimi` / `parseOllama` / `parseGlm` / `parseCodex` /
`parseAnthropic` / `parseCopilot` / `parseMiniMax` / `parseSynthetic` /
`parseOpenrouterCredits` / `parseGatewayBilling` / `parseMoonshotBalance` /
`parseDeepseekBalance` / `parseSiliconflowBalance` / `parseStepfunBalance` /
`parseXaiCredits` / `parseDeepinfraBalance` / `parseVercelBalance` /
`renderQuota` / `renderBalance` / `formatReset` / `nextReset` /
`parseDateish` / `matchSpec`) are exported for offline testing.

```bash
npx esbuild extensions/cloud-quota.ts --format=esm --outfile=/dev/null   # parse check
node --experimental-strip-types your-test.mts                             # runtime tests
```

## License

MIT