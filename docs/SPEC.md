# SPEC — agenttracker

**Status:** V1 scope, frozen by the owner. Workers must not expand scope; ask instead.

An issue tracker built **agent-first**: agents are the primary users and act through an API and
an MCP server. Humans observe, and can also act, through a minimal UI. Linear-shaped data model.

## Non-negotiables

1. **Every write goes through one path.** Agents and humans both write to the same HTTP API.
   The UI is a *client* of that API — it holds no private state and has no side channel.
2. **The event log is the source of truth.** An append-only `events` table records every change.
   Issues are a *projection* built from it. Nothing mutates an issue without appending an event.
3. **Attribution is mandatory.** Every event carries `actor_type` (`human` | `agent`) and
   `actor_id`. No anonymous writes.
4. **Agents never need the UI.** Anything doable in the UI must be doable by API/MCP first.
5. **Live by default.** The UI shows activity as it happens, sourced from the same log.

## Performance targets (these are testable acceptance criteria)

| Path | Target |
|---|---|
| `GET /issues?limit=50` on 10,000 issues | p95 **< 50 ms** |
| `POST /issues` (append + project) | p95 **< 80 ms** |
| append → SSE delivery to a connected client | p95 **< 150 ms** |
| server idle memory | < 200 MB |

## Stack (decided — do not substitute)

- Node 24, TypeScript strict, ESM
- **Fastify** for HTTP
- **Postgres 16** via `docker compose` for local/dev; GitHub Actions service container in CI
- **Drizzle** ORM + `drizzle-kit` migrations (Postgres dialect)
- **vitest** for tests
- **SSE** for the live stream (no websockets in V1)

## Data model (V1)

```
events(id bigserial, at timestamptz, actor_type text, actor_id text,
       entity_type text, entity_id text, type text, payload jsonb, seq bigserial unique)

issues(id text pk, key serial, title text, body text, status text, priority smallint,
       assignee text null, created_at timestamptz, updated_at timestamptz,
       last_event_seq bigint)     -- projection, rebuildable from events
```

Statuses: `backlog | todo | in_progress | done | canceled`. Priorities: 0–4.

## API surface (V1)

```
GET  /health
POST /issues                 {title, body?, status?, priority?, assignee?}  -> issue
GET  /issues?limit&cursor    cursor pagination, newest first
GET  /issues/:id
PATCH /issues/:id            partial update; appends an event
GET  /issues/:id/events      the timeline for one issue
GET  /stream?since=<seq>     SSE: replay from seq, then live
```

Auth: static bearer tokens from env (`AGENT_TOKENS`, `HUMAN_TOKENS`). Token → actor identity.
No OAuth, no sessions, no users table in V1.

## MCP server (V1)

Separate entry point exposing: `issue_create`, `issue_get`, `issue_list`, `issue_update`,
`comment_add`, `stream_tail`. Tools call the same service layer as HTTP — no duplicated logic.

## Definition of done (every ticket)

- Tests cover the new behaviour, including at least one failure case
- `npm run typecheck && npm test` pass locally
- CI is green on the PR
- No `TODO`, no stub returns, no commented-out code
- Docs updated if a request/response shape changed
- PR body states what changed, what was verified, and any limitation — honestly

## Explicitly OUT of scope for V1

Teams, orgs, permissions beyond token identity, notifications, email, attachments, search,
cycles/roadmaps, theming, and any UI polish. The UI is deliberately plain in V1; a designed
UI is V2.
