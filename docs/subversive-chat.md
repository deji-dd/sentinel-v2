# Subversive Chat

Torn Rooms-style chat inside Torn's chat bar, served by Sentinel instead of the
original Cloudflare Worker. The UI is the Torn Rooms layout (Torn's own chat CSS
and markup, namespaced under `sc_`), so it looks and behaves like Torn's faction
chat while the data lives in the Sentinel Postgres database.

## What is included

- Rooms: private invite-only rooms, faction-wide invites, public topic rooms
  (site admins only), room icons/colors, `[TAG]` sender names, admin-only
  announcement rooms.
- Chat: live messages, unread counters, typing indicators, replies via
  `@Name` mentions (with an `@ N mentions` pill), emoji reactions, message
  deletion, history paging.
- Panel size: drag a room's left edge to change its width or its top edge to
  change its height, or use **Panel size** in a room's title menu for exact
  values. The **Rooms → Settings** tab sets a default for every room without
  its own size. Sizes are stored in Tampermonkey, so they are per player and
  per browser.
- GIFs: a KLIPY-backed picker (when `KLIPY_API_KEY` is configured) and a
  paste-a-GIF-link fallback that works without a key. GIFs render in the bubble
  and open full size on click. KLIPY's terms require the search request to come
  from the end-user client, so the picker calls `api.klipy.com` directly from
  the userscript; the server only hands the authenticated client the app key.
- Same auth as the rest of the userscript: the `satf_...` target-finder session
  token. Connect the Torn API key once in the Subversive panel.

## Data model

All tables are in `packages/database/src/schema/chat.ts`:

| Table                    | Purpose                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `chat_rooms`             | Room metadata, access mode, post policy, last message id      |
| `chat_room_grants`       | Player/faction invitations                                    |
| `chat_room_admins`       | Per-room admins                                               |
| `chat_room_bans`         | Per-room bans                                                 |
| `chat_room_memberships`  | Joined/left state and last read cursor                        |
| `chat_messages`          | Messages, snapshots of sender name/tag/avatar, GIF attachment |
| `chat_message_reactions` | One row per reaction                                          |
| `chat_message_mentions`  | Resolved `@Name` tags and seen state                          |
| `chat_user_settings`     | Avatar consent and site-wide ban flag                         |

Identity is not duplicated: a chat account is an active
`subversive_target_finder_users` row, the same session the userscript already
uses. Faction tags are read from the `factions` reference table.

## API

Mounted under `/v2/chat` (`services/api/src/routes/v2/chat.ts`):

- `GET /me`, `PATCH /me` (avatar consent)
- `GET/POST /rooms`, `GET /rooms/browse`, `PATCH/DELETE /rooms/:id`
- `POST /rooms/:id/join|leave|read|typing`
- `GET/POST /rooms/:id/messages`, `DELETE /rooms/:id/messages/:messageId`
- `POST /rooms/:id/messages/:messageId/reactions`
- `POST /rooms/:id/mentions/seen`
- `GET /rooms/:id/access` plus grants/admins/bans endpoints
- `GET /poll` and `GET /events` (SSE) for live updates
- `GET /me` returns the KLIPY app key for the client-side GIF picker

The userscript uses SSE through `GM_xmlhttpRequest` on Tampermonkey and falls
back to polling on managers or clients that cannot stream (Torn PDA and
Violentmonkey), with no polling while the tab is hidden.

## Configuration

Add to `.env` / `.env.production`:

```bash
# Torn ids allowed to create public rooms and ban site-wide (comma separated)
CHAT_SUPERADMINS="1934909"

# Optional: enables the KLIPY GIF picker (https://partner.klipy.com)
KLIPY_API_KEY=""
```

Create the KLIPY key at [partner.klipy.com](https://partner.klipy.com). Add
`torn.com` as the platform domain if the partner panel asks for one: the search
request comes from the Torn page, via `GM_xmlhttpRequest`. Testing keys allow 100
requests/hour; request production access in the panel for normal use. The key is
served only to authenticated family members so the browser can call KLIPY
directly; it is not sent to Torn.

Apply the migration before starting the API:

```bash
bun run db:migrate
```

Build the userscript as usual:

```bash
bun run subversive:build
```

## Limits and moderation

Values live in `CHAT_LIMITS` (`services/api/src/lib/chat-protocol.ts`):
5 messages per 5 seconds, 60 writes per minute, 50 invites per hour, 30 typing
pings per minute, 240 reads per minute, 5 live
streams per player, 50 messages of history per page, and the last 5,000 messages
kept per room. Site admins can ban a player from chat; the ban closes their live
streams immediately. Room admins can ban players per room.

## Notes

- The KLIPY app key is a client-side key, not a secret like a Torn API key:
  every authenticated family member receives it from `GET /me` so the browser
  can call KLIPY directly. Keep the Torn API key out of KLIPY requests; the
  userscript never sends it there. KLIPY keys start in testing mode (100
  requests/hour) and can be upgraded to production in their partner panel.
  The picker caches each query for five minutes to stay inside the testing
  limit. KLIPY requires its attribution/branding in the picker; the current
  footer links "Powered by KLIPY" and can be replaced with their official mark
  from the partner panel.
- `chat_reaction_seq` is a Postgres sequence stamped on every reaction change.
  Polling clients pass the last value they saw as `reactionsAfter`, so reaction
  updates are not lost while messages are missed or pruned.
- Live fan-out is in memory in the single `sentinel-api` process. Polling
  clients still catch up after a restart; if the API is ever scaled to multiple
  instances, add a Postgres `LISTEN/NOTIFY` (or Redis) bridge for fan-out.
- The chat CSS and icon set are derived from Torn's chat assets and are not
  covered by the MIT license; they remain TORN LTD's.

## Torn API disclosure

The chat reuses the API key already connected in the Subversive panel. It does
not ask for a second key.

|                       |                                                                                                                                                                                                                                                     |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data storage          | Player ID, name, faction id and tag; profile picture URL only with consent; messages, reactions, mentions and room membership. Messages are kept until room deletion, capped at the last 5,000 per room.                                            |
| Data sharing          | Name, faction tag, avatar (if enabled), messages and reactions are visible to members of the rooms you post in. Nothing is sold or shared elsewhere.                                                                                                |
| Purpose of use        | Proving who you are and which faction you are in, for room access, and operating the chat.                                                                                                                                                          |
| Key storage & sharing | The existing target-finder key stays encrypted on the Sentinel server and in the userscript's Tampermonkey storage. Chat only decrypts it to read your Torn profile picture when you enable that setting; it is never sent to KLIPY or anyone else. |
| Key access level      | Public is enough.                                                                                                                                                                                                                                   |
