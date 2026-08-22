# devlog

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
