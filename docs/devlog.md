# devlog

## feat: predict Ollama Cloud reset times (global epoch-aligned grid)

`(pending)` | 2026-08-22

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
