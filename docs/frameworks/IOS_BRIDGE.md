---
title: "iOS Bridge"
version: 3.8.51
lastUpdated: 2026-11-07
---

# iOS Bridge — iPhone integrations for any MCP client

The Claude iOS app can read and write **Calendar** and **Reminders**, use the iPhone's
**Location** with **Apple Maps**, read **Apple Health** data, and draft **emails and text
messages**. The iOS Bridge rebuilds these integrations in OmniRoute, so every MCP client
routed through OmniRoute (Claude Desktop, Claude Code, Cursor, …) gets the same functions.

The iPhone side needs no app of its own: an **Apple Shortcuts** shortcut ("OmniRoute Sync")
pushes snapshots to OmniRoute and runs the actions that Claude has queued.

```
iPhone (Shortcuts)                         OmniRoute                          MCP client
──────────────────                         ─────────                          ──────────
Find Calendar Events ┐
Find Reminders       ├─ POST /api/v1/ios-bridge/sync ──▶ key_value (encrypted) ◀── ios_* read tools
Get Current Location │
Find Health Samples  ┘
Add New Event / Reminder ◀─ GET /api/v1/ios-bridge/actions ◀── action queue ◀── ios_* write tools
                         ── POST /api/v1/ios-bridge/actions ─▶ (done / failed)
```

Source: `open-sse/mcp-server/tools/iosBridgeTools.ts` (tools), `src/lib/db/iosBridge.ts`
(storage), `src/lib/iosBridge/schemas.ts` (Zod payloads), `src/app/api/v1/ios-bridge/` (REST).

## MCP tools (13)

| Tool                        | Scope               | What it does                                                       |
| :-------------------------- | :------------------ | :----------------------------------------------------------------- |
| `ios_bridge_status`         | `read:ios`          | When each category was last synced, pending action count           |
| `ios_calendar_list_events`  | `read:ios`          | Events in a range (default next 7 days), filter by calendar/text   |
| `ios_calendar_create_event` | `write:ios`         | Queue a new event (default end = start + 1 h)                      |
| `ios_reminders_list`        | `read:ios`          | Open reminders sorted by due date; `includeCompleted`, `dueBefore` |
| `ios_reminders_create`      | `write:ios`         | Queue a new reminder (list, due, notes, priority, flag)            |
| `ios_reminders_update`      | `write:ios`         | Queue a change (new title, due, notes, priority, move to list)     |
| `ios_reminders_complete`    | `write:ios`         | Queue marking a reminder as done                                   |
| `ios_reminders_delete`      | `write:ios`         | Queue deleting a reminder                                          |
| `ios_actions_list`          | `read:ios`          | What was queued and whether the iPhone executed it                 |
| `ios_location_get`          | `read:ios_location` | Last known location + Apple Maps link                              |
| `ios_maps_link`             | `read:ios`          | Apple Maps link: show a place, search, or directions               |
| `ios_health_summary`        | `read:ios_health`   | Health metrics: count/sum/avg/min/max, optional per-day buckets    |
| `ios_compose_draft`         | `read:ios`          | `mailto:` / `sms:` link that opens Mail or Messages pre-filled     |

Like the iOS app, **Apple Health is read-only** — no tool writes to Health. Location and Health
have their own scopes so a key can be granted calendar access without them. With scope
enforcement on (`OMNIROUTE_MCP_ENFORCE_SCOPES=true`), `read:*` covers all three read scopes.

Write tools do not touch the iPhone directly: they add an action to the queue, and the
shortcut executes it on its next run. Claude can check the outcome with `ios_actions_list`.
Reminders are matched on the device by **title** (and **list** when given).

## REST endpoints

All endpoints require an OmniRoute API key: `Authorization: Bearer <key>`.

| Method   | Path                         | Purpose                                                                             |
| :------- | :--------------------------- | :---------------------------------------------------------------------------------- |
| `POST`   | `/api/v1/ios-bridge/sync`    | Push snapshots; returns updated categories + `pendingActions`                       |
| `GET`    | `/api/v1/ios-bridge/sync`    | Bridge status (same data as `ios_bridge_status`)                                    |
| `DELETE` | `/api/v1/ios-bridge/sync`    | Wipe all synced snapshots and queued actions                                        |
| `GET`    | `/api/v1/ios-bridge/actions` | Pending actions for the iPhone                                                      |
| `POST`   | `/api/v1/ios-bridge/actions` | Report results: `{ "results": [{ "id", "status": "done" \| "failed", "error"? }] }` |

### Sync payload

Every top-level key is optional, but at least one of `calendar`, `reminders`, `location`,
`health` must be present. Each category present **replaces** the stored snapshot; categories
left out stay as they were. Dates accept ISO 8601 (use Shortcuts' _Format Date → ISO 8601_)
or epoch seconds/milliseconds.

```json
{
  "device": "iPhone",
  "calendar": {
    "events": [
      {
        "title": "Zahnarzt",
        "start": "2026-11-08T09:00:00+01:00",
        "end": "2026-11-08T10:00:00+01:00",
        "calendar": "Privat",
        "location": "Hauptstraße 1"
      }
    ]
  },
  "reminders": { "items": [{ "title": "Milch kaufen", "list": "Einkauf", "completed": false }] },
  "location": { "latitude": 52.52, "longitude": 13.405, "accuracy": 15, "address": "Berlin" },
  "health": {
    "samples": [
      { "metric": "steps", "value": 8421, "unit": "count", "start": "2026-11-07T00:00:00+01:00" }
    ]
  }
}
```

Limits: 2,000 events, 2,000 reminders, 5,000 health samples per sync. Health metric names are
normalized to `snake_case` (`"Heart Rate"` → `heart_rate`).

```bash
curl -X POST https://<your-omniroute>/api/v1/ios-bridge/sync \
  -H "Authorization: Bearer $OMNIROUTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"location":{"latitude":52.52,"longitude":13.405}}'
```

### Action types

| `type`                  | `payload`                                                                                      |
| :---------------------- | :--------------------------------------------------------------------------------------------- |
| `calendar.create_event` | `title`, `start`, `end`, `allDay?`, `location?`, `notes?`, `calendar?`, `url?`                 |
| `reminders.create`      | `title`, `list?`, `due?`, `notes?`, `priority?`, `flagged?`                                    |
| `reminders.update`      | `match: { title, list?, id? }`, `changes: { newTitle?, due?, notes?, priority?, moveToList? }` |
| `reminders.complete`    | `match: { title, list?, id? }`                                                                 |
| `reminders.delete`      | `match: { title, list?, id? }`                                                                 |

Finished actions are kept for 7 days; the queue holds at most 500 actions.

## iPhone setup (Apple Shortcuts)

1. **Reach OmniRoute from the iPhone.** Use a URL the phone can open — the same LAN address,
   or a tunnel (see [`TUNNELS_GUIDE.md`](../ops/TUNNELS_GUIDE.md)). Use HTTPS outside your LAN.
2. **Create an API key** for the shortcut in the dashboard (`/dashboard/api-manager`).
3. **Create the shortcut "OmniRoute Sync"** in the Shortcuts app:
   - **Calendar:** _Find Calendar Events_ (start date in the next 14 days) → _Repeat with Each_
     → _Dictionary_ with `title`, `start` / `end` (each through _Format Date_, ISO 8601),
     `location`, `notes`, `calendar`. The _Repeat Results_ are the `events` list.
   - **Reminders:** _Find Reminders_ (not completed) → _Repeat with Each_ → _Dictionary_ with
     `title`, `list`, `due` (ISO 8601), `notes`.
   - **Location:** _Get Current Location_ → _Get Details of Locations_ (Latitude, Longitude).
   - **Health** (optional): _Find Health Samples_ per type (e.g. Steps, Heart Rate, Sleep) for
     the last 7 days → _Repeat with Each_ → _Dictionary_ with `metric`, `value`, `unit`,
     `start` (ISO 8601).
   - Build one _Dictionary_ with the keys `device`, `calendar` (`{ events }`), `reminders`
     (`{ items }`), `location`, `health` (`{ samples }`).
   - _Get Contents of URL_: `POST …/api/v1/ios-bridge/sync`, header
     `Authorization: Bearer <key>`, request body **File** = the dictionary (sent as JSON).
4. **Run queued actions** (same shortcut, after the sync):
   - _Get Contents of URL_: `GET …/api/v1/ios-bridge/actions` → _Get Dictionary Value_
     `actions` → _Repeat with Each_ → _If_ `type` is …
     - `calendar.create_event` → _Get Dates from Input_ on `start` / `end` → _Add New Event_.
     - `reminders.create` → _Add New Reminder_.
     - `reminders.complete` / `update` / `delete` → _Find Reminders_ where Title is
       `match.title` (and List is `match.list`) → edit or _Remove Reminders_.
   - Collect `{ "id": <action id>, "status": "done" }` per action and send them with
     _Get Contents of URL_: `POST …/api/v1/ios-bridge/actions`, body `{ "results": [...] }`.
5. **Automate it:** Shortcuts → Automation → _Time of Day_ (several times a day, _Run
   Immediately_). Add an automation such as _When App is closed_ for faster round trips, or put
   the shortcut on the Home Screen.

iOS asks for Calendar, Reminders, Location and Health permission the first time the shortcut
uses each — the same contextual prompts the Claude app shows. Leave out any category you do
not want to share.

## Data & privacy

- Snapshots and the action queue live in the `key_value` table (namespace `ios_bridge`) and are
  encrypted with AES-256-GCM when `STORAGE_ENCRYPTION_KEY` is set. Without it they are stored in
  plaintext — set the key before syncing Health or Location data.
- OmniRoute only keeps the **latest** snapshot per category; there is no location history.
- To wipe everything: `DELETE /api/v1/ios-bridge/sync` (API key required).

## Tests

- `tests/unit/ios-bridge-db.test.ts` — schema normalization, snapshots, encryption at rest, queue
- `tests/unit/ios-bridge-tools.test.ts` — every MCP tool, scopes, link builders
- `tests/unit/ios-bridge-routes.test.ts` — auth, validation, sync and action round trip
