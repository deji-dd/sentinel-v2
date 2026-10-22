# Sentinel v2 — Architecture & Project Rules

## Technical Stack & Runtime

- **Runtime & Package Manager**: Bun (ESM native, `bun test`, `bun run`)
- **Monorepo Packages**: `@sentinel/schemas`, `@sentinel/torn-api`, `@sentinel/utils`
- **Formatter**: Bun (`bun fmt`)
- **Type Checker**: TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`)

## Core Architectural Flow

`[Client / Bot / App] ➔ @sentinel/torn-api ➔ OpenAPI Schema Inferences (@sentinel/schemas)`

- **Crypto Operations**: Uses `node:crypto` AES-256-GCM
- **IPC Transport**: Unix Domain Socket communication (`@sentinel/utils/ipc`)
- **Rate Limiting**: Sliding Window RAM Rate Limiter (`@sentinel/utils`)

## Strict Coding Guidelines

- **Zero Explicit `any`**
  - Use `unknown` for unstructured payloads, errors, or generic dynamic inputs.
  - Narrow `unknown` using explicit type guards (`typeof x === "object"`, `error instanceof Error`, or `Record<string, unknown>`).
- **Indexing & Optional Access (`noUncheckedIndexedAccess`)**
  - Array index lookups (e.g., `arr[0]`) resolve to `T | undefined`.
  - Always check for `undefined` or supply a fallback (`arr[0] ?? fallback`).
- **Cryptography & Standard Compliance**
  - Rely on `node:crypto` directly for AES-256-GCM symmetric encryption.
  - Use 12 bytes (96 bits) as the default IV length (NIST standard), but retain dynamic hex length checking for backward compatibility with 16-byte legacy keys.
- **Testing Standards (`bun test`)**
  - Mock network calls using `spyOn(globalThis, "fetch")` instead of reassigning `globalThis.fetch`.
  - Cast mock implementations via `as unknown as typeof fetch` to satisfy hybrid function interfaces. Always run `spy.mockRestore()` in cleanup.
- **Code Style Compliance**
  - **Template Strings**: Use template literals (`` `${a}${b}` ``) instead of string concatenation (`a + b`).
  - **Exponentiation**: Use `a ** b` instead of `Math.pow(a, b)`.
  - **No Side-Effect Assignments**: Do not assign variables inside conditional statements or loop headers (`while ((x = getNext()) !== -1)` is prohibited).
  - **Exact Matching**: Use pre-compiled word-boundary regular expressions (`\bkeyword\b`) instead of `String.prototype.includes()` when mapping action strings to IDs to prevent sub-word collisions.
- **Database Migrations (`drizzle-kit`)**
  - **Never Manually Create Migration SQL Files**: Never manually create, write, or scaffold migration `.sql` files in `packages/database/drizzle/`.
  - **Always Run `bun run db:generate`**: Always update schema definitions in `packages/database/src/schema/` first and run `bun run db:generate` to let Drizzle Kit generate migration SQL files, snapshots, and `_journal.json` entries.
  - **Data Backfills Are Allowed Inside Generated Migrations**: Drizzle Kit generates DDL only. Appending the accompanying backfill DML to the file it generated (see `0041_sour_doctor_spectrum.sql`, `0049_guild_stock_alerts.sql`) is permitted and preferred over a separate script, because the backfill and the DDL must commit in one transaction. Never hand-write the DDL itself.

- **Persisted State — Do Not Add New `system_states` Keys**
  - **`system_states` is a legacy SQLite-era key/value table.** It is being retired, not extended. Adding a new key to it is not an acceptable way to persist a feature.
  - **New persisted state needs a typed table** in `packages/database/src/schema/`, following the existing per-domain convention keyed by `guild_id` / `faction_id` (e.g. `guild_configs`, `merc_channel_configs`, `subversive_dibs_configs`, `guild_stock_alert_configs`). If the state is genuinely an ephemeral worker cursor or status flag, it belongs in `worker_state` — not in a new blob key.
  - **`worker_state` is the one sanctioned generic store, and only for worker plumbing.** Use `getWorkerState` / `upsertWorkerState` / `setWorkerInitFlag` from `@sentinel/database`, with the id taken from `WORKER_STATE_IDS` rather than a fresh literal — several of those ids are written by one service and read or cleared by another, and a duplicated literal is how a key drifts between writer and reader. `init`, `status`, `last_error` and `cursor` are typed columns; `details` is for worker-specific counters only. **Configuration must never go in `details`** — that is what the legacy blob table became. The column carries a `jsonb_typeof(...) = 'object'` CHECK so the double-encoded shape cannot be stored at all.
  - **`upsertWorkerState` leaves `init` alone when you omit it**, deliberately: clearing it replays history in the log-manager, recruitment and territory workers. Pass `init` only when you actually mean to change the first-run gate.
  - **Never store a growing collection as one JSON array in a single row.** Use one row per record (`subversive_dibs_records`, `personal_bounty_targets`). A whole-array rewrite is O(n) write amplification and makes that row a single-writer bottleneck.
  - **Never write a read-modify-write of an entire JSON blob.** `SELECT` the row, then `UPDATE` only the columns you are changing. The API, bot and scheduler are separate processes; a whole-blob spread silently reverts whatever another process wrote in between, and no `system_states` write is wrapped in a transaction or row lock. This pattern has already destroyed live configuration.
  - **Prefer typed columns over `jsonb` for scalars.** `system_states.data` is untyped, so a writer that double-encodes a value (storing JSON as a JSON _string_) is accepted silently, and every reader that guards with `typeof data === "object"` then degrades to a default. A `numeric`/`text`/`timestamp` column makes that state unrepresentable.
  - **Do not rely on the `init` boolean loosely.** It gates first-run behaviour in the log-manager, recruitment and territory workers; a backfill that leaves it `false` re-triggers a full historical backfill. Preserve it explicitly.
  - **Name the table you added in the change description**, so a reviewer can see that a feature persisted data somewhere deliberate.
  - **Tests must never touch the service database.** `bun test` is pinned to an isolated database by `scripts/test-preload.ts`; refresh it with `bun run test:db:setup`. Never write a suite that mutates a fixed configuration key in place — two existing suites did, and one of them overwrote the live `elims:item_requests_config` row with its own fixture.

## Torn Terms of Service & Scripting Rules Compliance

The use of scripts, extensions, applications, or any other software is permitted only when they rely on data from our API or from a page that you have manually loaded and are actively viewing. Such software must not make additional non-API requests to Torn, scrape pages that are not currently being viewed, attempt to bypass CAPTCHA protections, or extract data from unfocused pages to send elsewhere, generate alerts, or draw attention to itself or another window.
Any software that makes non-API requests which are not directly and manually initiated by the user is prohibited and may be tracked.
Furthermore, releasing software with malicious or undisclosed functionality is strictly forbidden, and developers of API-based tools are required to comply with the acceptable usage terms outlined:
When creating a script, userscript, sheet, extension, API service, bot, 3rd party website or any other API tool (collectively "service"), the end user must be aware of how will their API key be used.
Here's a table with the information that is important to the end user - giving them a good idea of what to expect from the API service they're using:

| Data Storage                                                                                                                                      | Data Sharing                                                                                                   | Purpose of Use                                                                                                                                                                         | Key Storage & Sharing                                                                                                                   | Key Access Level                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Will the data be stored for any purpose?                                                                                                          | Who can access the data besides the end user?                                                                  | What is the stored data being used for?                                                                                                                                                | Will the API key be stored securely and who can access it?                                                                              | What key access level or specific selections are required?          |
| No / Only locally<br>Temporary - less than a minute<br>Temporary - less than a day<br>Persistent - until account deletion<br>Persistent - forever | Nobody<br>Faction<br>Friends & faction<br>General public<br>Service owners<br>Service owners & their customers | Non malicious statistical analysis<br>Public amusement<br>Public community tools<br>Competitive advantage [Please specify]<br>Personal gain [Please specify]<br>Other [Please specify] | Not stored / Not shared<br>Stored / Used only for automation<br>Stored / Shared with the faction<br>Stored / Shared with other services | Public<br>Minimal<br>Limited<br>Full<br>Custom - specify selections |

If the service is not storing or sharing the data or the key anywhere, it's enough to state so, otherwise ToS with the information above needs to be clearly and visibly stated in any place where user is providing their API key in the table format highlighted above.
When integrating your service with another service (opt-in), make sure there's at least a link to ToS of the service you're allowing the user to integrate with.
When integrating your service with another service (automatically), your ToS need to cover the usage of the service you're integrating with.
Using keys for purposes other than the ones described in the ToS or deceiving the end user into believing that the key is being used for a purpose other than described is prohibited and is a punishable offense.
These rules also apply to those who purchase API keys from other players.
If you're unsure how to describe your service, feel free to contact [Torn staff.](https://www.torn.com/staff.php)
If you suspect your key was misused, you can use ['key' -> 'log'](https://www.torn.com/swagger.php#/Key/get_key_log) selection to view & monitor API key usage history.
All services must be compliant with [Torn's scripting rules](https://www.torn.com/rules.php).
ToS examples can be found at the bottom of this page.
