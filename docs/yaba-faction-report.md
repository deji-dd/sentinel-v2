# YABA Faction Activity Report

Port of the Google Sheet report to a dedicated UI, the Sentinel API and Discord bot.

## Data sources

All calls use the **Alliance public key pool** (`tornApi` with `pool: "alliance"`),
budgeted at **30 requests/min/key** (Torn's ceiling is 50). No private keys are
collected or stored for this feature.

| Source             | Endpoint                                         | Purpose                                                                                                             |
| ------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Member counters    | `/user/{id}/personalstats?cat=popular`           | Xanax, seconds played, ranked-war hits, faction respect, attacks won/lost, hits/crits/damage, revives, revive skill |
| Historical anchors | same endpoint with `stat=[...]&timestamp=<unix>` | 90/30/7/1-day backfill (max 10 stats per call)                                                                      |
| Faction details    | `/faction/{id}/basic`                            | Name, tag, leader, size, respect                                                                                    |
| Roster             | `/faction/{id}/members`                          | Members, `days_in_faction`, last action                                                                             |
| Faction list       | `faction_role_mappings` for `ALLIANCE_GUILD_ID`  | The alliance verification faction map                                                                               |
| Battle score       | FFScouter via `getPlayerStats()`                 | `bs_estimate` with provider/source metadata                                                                         |

`data/faction-alliances.snapshot.json` is deliberately **not** used: it only
powers the `/alliance-map` territory PNG.

## Ranking

Pure implementation: `packages/utils/src/yaba-ranking.ts`.

- Percentile (0–100) per metric → weighted average → rank 1 is highest.
- Factions use the **median** of their members' values per metric; members use
  their own values.
- Default preset matches the sheet: 3-month Xanax, hours active, ranked-war
  hits (combat) or revives (revive), and FFScouter battle score, equal weights.
- Selectable secondary signals: attack win rate, damage per hit, critical hit
  rate, revive skill. Custom combos use the same formula.
- Windows: 1d / 7d / 30d / 90d. Values are cumulative-stat deltas between the
  latest anchor and the anchor at or before the window boundary.
- Missing data is `null`, never zero; entities without data are reported as
  `unrankedCount` instead of receiving a zero score.
- Snapshots are immutable and versioned by scope, faction type, window, preset
  hash and generation time.

## Workers

Registered in `services/scheduler/src/workers/registry.ts`:

| Id              | Schedule                  | Notes                                                                                              |
| --------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| `yaba:nightly`  | `0 1 * * *` Europe/London | `bootRun: true` — runs immediately on first boot; on an empty DB it performs a full backfill first |
| `yaba:backfill` | `0 3 * * *` Europe/London | Historical stat anchors; never on boot                                                             |
| `yaba:charts`   | `0 7 * * *` Europe/London | Top-10 charts to the two configured channels                                                       |

All support `DISABLED_WORKERS` and `bun run trigger` (`force_run_worker`).

## UI and Discord

- `web/yaba` is served at `yaba.blasted-labs.tech` through the host-based SPA
  middleware. Login reuses the dashboard's Discord OAuth session cookie
  (`.blasted-labs.tech` domain).
- Public API: `/v2/yaba/{factions,members,rankings,status,methodology,prospective}`.
  Admin API: `/v2/yaba/admin/{factions,collect/run,rankings/recompute,preset,channels}`.
- The alliance dashboard's **YABA Stats** page sets the faction-chart and
  player-chart channels. The bot edits persistent messages in place, attaches a
  Chart.js PNG and links to the full leaderboard.
