# devlog

## docs(readme): provider-first intro + issues/PRs guide

`646d5e8` | 2026-08-31

- **Changes**: README 简介 rewrite — explicit 18-provider list grouped by data
  shape (subscription windows / balance / gateway probing) with issue + PR
  links right in the opening; new "Issues & PRs" section after the coverage
  table (per-status expectations, what to include in an issue, the one-
  parse-one-fetch-one-branch PR recipe, sanitize warning in EN+中文);
  package.json description now enumerates the provider families.
- **Reason**: user wants the project intro to state supported providers
  explicitly and to route community problem reports and contributions to
  issues/PRs (the 🟡/🧪 rows especially need real-account feedback).
- **Result**: README renders with jump link (#issues--prs); package.json
  stays valid JSON.
- **Notes**: GitHub repo description synced via `gh repo edit` in the same
  pass; devlog hash rides with the next commit.
## feat(providers): add 15 providers, balance display type, verified-status docs (v0.5.0)

`1863bfd` | 2026-08-31

- **Changes**: extensions/cloud-quota.ts 738→~1580 lines — new window providers
  (OpenAI Codex wham/usage + silent token refresh, GitHub Copilot
  copilot_internal/user + v2 token exchange + premium→chat fallback, GLM
  Coding Plan bigmodel.cn/z.ai monitor endpoint with bare-key→Bearer retry,
  Anthropic oauth/usage with anthropic-beta header, MiniMax token_plan/remains
  with region auto-pick, Synthetic v2/quotas); new balance-type providers
  (OpenRouter credits, Moonshot, DeepSeek, SiliconFlow, StepFun, xAI,
  DeepInfra, Vercel AI Gateway) with a second render path
  (`OpenRouter $12.08` / `newapi-codex $20.32 spent`, remaining-fraction
  coloring); automatic one-api/new-api gateway billing probing for unmatched
  OpenAI-compatible providers with per-token dead-marking + auto-hide;
  `Usage = Period[] | Balance` union through apply/render/cache/maybeWarn;
  parse/fetch helpers exported for offline tests. package.json 0.4.0→0.5.0
  (description + keywords), README rewritten with provider coverage table
  (✅/🟡/🧪 test-status levels), changelog section.
- **Reason**: user asked to add every integrable+verifiable provider and to
  document which data paths have actually been tested (the ones that cannot
  be tested locally are explicitly handed to open-source community users).
- **Process**: prior research (query archive 2026-08-31, 4-lane subagents)
  provided endpoints; shapes cross-checked against pi-quotas 0.4.0 source
  (jsdelivr) and CodexBar docs; live verification via
  `node --experimental-strip-types` runners against real accounts —
  Codex `5h 5%` (token in ~/.codex/auth.json), Copilot `mo 0%` (free plan,
  chat fallback + reset 09-01), OpenRouter `$12.08/140`, newapi-codex
  gateway `$20.32 spent` (hard_limit 1e8 → spend mode), Kimi/Ollama
  regressions green; GLM both regions return business error
  当前用户不存在coding plan (local keys lack Coding Plan subscription);
  Moonshot CN key from opencode store rejected 401; newapi main instance
  rejects billing routes 401.
- **Result**: esbuild parse OK; 7/13 new providers verified end-to-end or
  endpoint-level with real accounts; documented 🟡/🧪 rows for community
  validation.
- **Notes**: all endpoints are internal/unpublished surfaces (documented by
  CodexBar/pi-quotas/@satas/pi-usage-bar/openusage) and may drift; Codex
  Team/EDU spend-control fields and Gemini/Antigravity/Cursor/Windsurf were
  left out (research archive has the specs); pi auth store is never written
  (Codex refresh stays in-process).

## feat(ark): exponential backoff on fetch failures, rate-limit-aware login

`a13b597` | 2026-08-31

- **Changes**: `refresh()` records a per-spec failure streak and skips ticks
  until `failureBackoffMs` (TTL 5min, 2x per streak, capped 30min) elapses;
  success clears it. New helper `isArkRateLimited()` (/rate limit|too many
  requests/i); the Ark catch branch checks it BEFORE `isArkNotLoggedIn`
  (rate-limit payloads also contain the re-login phrase) and shows
  `Ark 限流中` + a one-shot toast instead of the re-login toast. `arkLogin`'s
  exit handler surfaces the rate-limit hint on both `.then` (status JSON)
  and `.catch` (promisified execFile rejection carries stdout/stderr).
- **Reason**: with the plugin live in several long-running pi sessions, a
  5-day-old dead SSO session made the 30s loop hammer
  `arkcli`'s token-exchange endpoint; Volcengine rate-limited the account
  and every `/cloud-quota login` failed with "Too many requests" - the
  retry advice made the lockout worse (more logins, more exchanges).
- **User feedback**: "Warning: Ark 未登录（SSO 会话过期）...Error: Ark 登录失败，请重试"
  (reported 2026-08-31; turn 1 asked whether installed vs latest versions
  differ - they did not, 0.4.0 @ 103157a on both sides).
- **Process**: circuit-breakered via chmod -x on the arkcli bin (all
  sessions no-op'd); arkcli 1.0.18 -> 1.0.23 (its error message confirmed
  the cause and gave an 894s cooldown); node --experimental-strip-types
  behavior test on the exported helpers; tsc only complained about missing
  env types, none in the diff.
- **Result**: committed a13b597; login recovery scheduled after the
  documented 894s window; sessions need a restart to load the new code.
- **Notes**: arkcli 1.0.23 pauses renewal client-side on rate limit and
  names "高频 arkcli 轮询或多个运行实例" as the cause - vendor-side
  confirmation of the diagnosis. Old refresh token had expired 2026-08-26
  12:41; token.json untouched since, so every login attempt was a fresh
  exchange hitting the limit.

## feat(ark): allow SSO login regardless of current model

`05c15fa` | 2026-08-24

- **Changes**: removed the `spec.name !== "Ark"` gate in `arkLogin` (the
  "Ark SSO 登录仅在 Ark 模型下可用" warning); success now refreshes via a
  new module-level `ARK_SPEC` constant (also reused by `specFor`), failure
  always sets the "Ark 未登录" status.
- **Reason**: user wants the login usable from any model — the login only
  touches arkcli credentials, not the active provider.
- **User feedback**: "Warning: Ark SSO 登录仅在 Ark 模型下可用 这个可以不用，管他啥模型不影响"
- **Process**: previously `finish(true)` refreshed the *current model's*
  spec (which could be Kimi or nothing); with the gate gone, refreshing
  `ARK_SPEC` directly is the only correct target — the login is about Ark,
  so the status bar shows Ark usage right after login.
- **Result**: esbuild parse OK.

## fix(ark): detect login success via logged_in status field

`add529b` | 2026-08-24

- **Changes**: new pure helper `arkAuthOk(stdout)` parses `arkcli auth status`
  JSON and checks `logged_in === true` (substring fallback for non-JSON
  output); `arkLogin`'s exit handler now uses it instead of the literal
  `stdout.includes('"ok": true')`.
- **Reason**: user reported that Ark login shows an "exit 0" error toast even
  though the login actually succeeded.
- **User feedback**: "cloud quota，用ark登陆会显示exit 0错误，但实际上更新成功了。"
- **Process**: verified live `arkcli auth status` output — the literal
  `"ok": true` appears 0 times (real success signals are `"logged_in": true`
  and `control_plane_auth.status` `"ok"`); the old predicate was therefore
  always false and every successful login was misreported as
  "Ark 登录失败（exit 0）" (exit 0 = the login process exited normally).
  The predicate was written from an assumed output format, never verified
  against real output. Also noticed arkcli auto-updated 1.0.18 → 1.0.19
  during verification; 1.0.19 output structure is unchanged.
- **Result**: esbuild parse OK; 5 offline assertions pass, including real
  captured status output (old predicate false → new helper true).
- **Notes**: failure toast still prints `exit ${code}`; with the predicate
  fixed, an exit-0 failure no longer occurs on success, and the exit code
  stays informative for genuine failures.

## fix(kimi): keep 5h window visible when its quota limit is 0

`709ca07` | 2026-08-23

- **Changes**: `parseKimi`'s `pct` helper now treats a zero/negative quota
  limit as 0% (100% when usage is still reported against it) instead of NaN,
  so a zero-limit 5h window stays in the status bar (e.g. `Kimi 5h 0% · wk
  20%`) instead of vanishing. Investigated monthly display for Kimi: the
  `usages` API exposes only the 7-day `usage` + minute `limits[]` windows —
  no monthly field exists on any endpoint, so `mo` stays Ark-only.
- **Reason**: user reported the 5h window disappearing when its limit is 0.
- **User feedback**: "有的时候不同provider（尤其是kimi）的5h会不显示（此时5h限额是0），还是要显示的" + "看看kimi能不能加入月限额显示".
- **Process**: live-inspected `GET api.kimi.com/coding/v1/usages` with the
  user's token (response has `usage` weekly + one 300-min window only;
  `totalQuota` empty, `boosterWallet` is currency top-up limits); probed 6
  alternate endpoints — all 404; community parsers (onWatch, codexbar,
  usagebar, openusage, spec-kimi-code) extract only 5h + weekly; official
  docs confirm only 7-day + rolling 5h windows. Verified the fix with a
  node --experimental-strip-types test of `parseKimi`/`renderQuota` on four
  response shapes.
- **Result**: zero-limit 5h renders `Kimi 5h 0% · wk 20%`; normal responses
  unchanged. Monthly display: not possible — no monthly data in the API.
- **Notes**: none.
## feat: predict Ollama Cloud reset times (global epoch-aligned grid)

`759b0f1` | 2026-08-22

- **Changes**: added `nextReset(now, periodMs, phaseMs)` helper; `parseOllama`
  now attaches predicted `resetsAt` to both windows (session = next multiple
  of 5h since Unix epoch, weekly = next Monday 00:00 UTC); status bar shows
  the ↺ countdown for Ollama's 5h window; warning toasts now include weekly
  reset countdown too; README updated.
- **Reason**: user asked whether Ollama Cloud resets are global and whether
  the reset time is predictable, to add the missing reset countdown.
- **User feedback**: "ollama cloud重置似乎是全球同一个时间（你调研一下）。是否可以预测重置时间？"
- **Process**: researched ollama/ollama#12532 — rick-github posted epoch-aligned
  formulas (session `18000-(now%18000)`, weekly `604800-((now-4d)%604800)`)
  claiming resets are identical for everybody; moritzfl independently confirmed
  they match his settings-page countdown. Verified formula self-consistency by
  back-computing run times (04:11:57Z / 04:12:36Z, 39s apart) and confirmed the
  weekly phase is exactly 4.0 days (→ Monday 00:00 UTC). The `/api/usage`
  response has no reset fields; the settings page HTML carries `data-time`
  ISO timestamps (CodexBar parses them) but needs a session cookie.
- **Result**: `nextReset` reproduces both community-verified examples exactly;
  status bar now renders e.g. `Ollama 5h 2% ↺4h · wk 64%`.
- **Notes**: prediction is community-verified but not officially documented.
  A background poll of the user's own account (`/tmp/ollama_quota_poll.log`,
  pid 23366) watches for the session reset at 2026-08-22T17:00:00Z to confirm
  empirically; if the phase ever shifts, only `nextReset`'s constants change.

## feat(ark): one-command SSO re-login with expiry warning

`546aa10` | 2026-08-22

- **Changes**: `Ark 未登录` status (was silent `✗`) when arkcli reports a
  missing/expired SSO session; `/cloud-quota login` (and first `/cloud-quota`
  menu entry) spawns `arkcli auth login volc-sso` detached, polls
  `arkcli auth status` on exit, and refreshes quota on success (10min timeout,
  `Ark 登录中…` during the flow); `arkLoginExpiryMs` decodes the refresh-token
  JWT exp from `~/.arkcli/identities/<id>/token.json` and toasts ~12h before
  expiry.
- **Reason**: user asked for (1) a clickable login when not logged in, (2) a
  longer single-login validity.
- **User feedback**: "1.ark增加在未登陆的时候可点击登陆的功能 2是否可以延长单次登陆有效期？"
- **Process**: pi's footer renders `setStatus` text without any click/mouse
  support (verified in footer.js + types.d.ts), so a clickable status is
  impossible — implemented a command instead. Login validity is a server-side
  policy: refresh tokens are NOT rotated (verified by hashing token.json
  before/after `usage plan`) and expire 48h after login (JWT iat→exp), and
  `usage plan` rejects `--api-key` (control-plane only), so the client cannot
  extend it; the plugin now warns before expiry instead.
- **Result**: esbuild parse + 10 offline assertions pass; live `exp` decoded
  as 2026-08-24 15:02:14.
- **Notes**: gotcha — a JSDoc comment containing `identities/*/token.json`
  embeds `*/` and prematurely closes the block comment, breaking both node's
  TS stripper and esbuild at a later line; rewrote as `<id>`. package-lock.json
  remains untracked (pre-existing).

## fix: parse weekly resetTime for Kimi usage

`e8945c9` | 2026-08-22

- **Changes**: `parseKimi` now reads `usage.resetTime` into the `wk` period's
  `resetsAt`, so the weekly reset countdown can render (previously only the
  5h window carried a reset time).
- **Reason**: user reported Kimi showed no reset time at all; the 5h reset was
  hidden by the new threshold gate (89% remaining ≥ 80%), and the wk reset
  never rendered because `usage.resetTime` was never parsed.
- **User feedback**: "改第二个。问题是wk无法显示。"
- **Process**: verified live API response carries `usage.resetTime`
  (2026-08-23T03:33:19Z); with config wk:100 the rendered line is
  `Kimi 5h 11% · wk 78% ↺23h` (25 chars ≤ maxWidth 40).
- **Result**: 5 offline assertions pass (`node --experimental-strip-types`).
- **Notes**: threshold semantics unchanged; 5h reset still hidden while
  remaining ≥ 80%.

## feat: threshold-gated reset display with width priority

`ad5e384` | 2026-08-22

- **Changes**: reset countdown now shows per window only while remaining quota
  is below a configurable threshold (defaults 5h <80%, wk <40%); status width
  budget (`maxWidth`, default 40 visible chars, 0 = off) drops non-5h resets
  first, then non-5h windows, then the 5h reset; `formatReset` gained day
  formatting (`↺2d`); `/cloud-quota` now configures interval, both thresholds
  and max width; config file extended with `resetThresholds` + `maxWidth`.
- **Reason**: user asked for threshold-gated reset display and width priority
  with all options adjustable.
- **User feedback**: "需要优化pi cloud quota插件，目前ollama平台没有重置时间显示。
  另外，需要增加新的逻辑，5h剩余<80%才显示重置时间，week剩余<40%才显示重置时间，
  如果宽度不够优先显示5h重置时间。以上选项全要可调。"
- **Process**: verified live that `ollama.com/api/usage` returns no reset times
  (also confirmed by ollama/ollama#12532/#15132/#15663; the settings page needs
  a browser session cookie), so Ollama still shows no reset — the logic is
  provider-agnostic and would pick up resets if the API ever adds them.
  Width is measured on visible chars (ANSI stripped).
- **Result**: 18 offline assertions pass (`node --experimental-strip-types`).
- **Notes**: threshold semantics = remaining quota (100 − used); "5h剩余<80%"
  interpreted as remaining quota, not remaining time. `package-lock.json`
  untracked in repo (pre-existing).


## feat: timer-based refresh with configurable interval

`(pending)` | 2025-02-14

- **Changes**: replaced per-turn force refresh (`agent_settled`) with an unref'd
  `setInterval` timer; added `/cloud-quota` command with `ui.select` to pick
  30s/1min/2min/5min (default 1min); interval persists to
  `~/.pi/agent/cloud-quota.json`; wrapped `arkcli` output parse in try/catch with
  a clear error; updated README.
- **Reason**: user asked for periodic refresh instead of turn-driven fetching,
  with a changeable cadence.
- **User feedback**: "优化当前设计，定时刷新一次，设置可改（30s/1min/2min/5min)默认1min"
- **Result**: timer no-ops without an active known provider; interval change
  restarts the timer and refreshes immediately. TTL cache still serves
  session_start/model_select.
- **Notes**: timer variable typed as `number` (env lacks @types/node, so
  `NodeJS.Timeout.unref` wouldn't type-check) with a guarded runtime unref call.
