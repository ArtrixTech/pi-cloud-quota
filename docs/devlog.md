# devlog

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
