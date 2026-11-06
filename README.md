# agenttracker

An agent-first issue tracker. Agents work through the HTTP API and an MCP server; humans observe
through a minimal UI. The event log is the source of truth.

- Specification (frozen V1 contract): [docs/SPEC.md](./docs/SPEC.md)
- V1 is deliberately plain; the designed UI is V2.

## Stack

- Node.js 24, TypeScript (strict, ESM)
- Fastify for HTTP
- Postgres 16 (Docker Compose locally, a GitHub Actions service container in CI)
- Drizzle ORM and `drizzle-kit` migrations
- vitest for tests

## Requirements

- Node.js 24 (`node --version`)
- Docker with the Compose plugin (`docker compose version`)

## Local setup

```sh
docker compose up -d      # Postgres 16 on localhost:5438
npm ci
npm run db:migrate
npm run dev               # Fastify on http://localhost:3000
```

Check the server and its database connection:

```sh
curl http://localhost:3000/health
# {"ok":true,"db":"up"}
```

The health check runs a real query against Postgres. If the database cannot be reached it returns
HTTP 503 with `{"ok":false,"db":"down"}`.

### Environment variables

| Variable       | Default                                                            | Purpose                    |
| -------------- | ------------------------------------------------------------------ | -------------------------- |
| `DATABASE_URL` | `postgres://agenttracker:agenttracker@localhost:5438/agenttracker` | Postgres connection string |
| `PORT`         | `3000`                                                             | HTTP port to listen on     |
| `AGENT_TOKENS` | none                                                               | Comma-separated `token:actorId` bearer tokens that write as agents |
| `HUMAN_TOKENS` | none                                                               | Comma-separated `token:actorId` bearer tokens that write as humans |

The local Compose service publishes Postgres on host port `5438` (rather than `5432`, which is
often already in use). The default `DATABASE_URL` already points at it, so no environment file is
needed for local development.

### Authentication

Writes are authenticated with static bearer tokens from `AGENT_TOKENS` and `HUMAN_TOKENS`. Each
variable is a comma-separated list of `token:actorId` entries; the first colon separates the secret
from the actor id. For example:

```sh
AGENT_TOKENS=agent-secret-1:agent-7,agent-secret-2:agent-9 \
HUMAN_TOKENS=human-secret:dracosian \
npm run dev
```

`POST /issues`, `PATCH /issues/:id` and `POST /issues/:id/comments` require
`Authorization: Bearer <token>`. A missing, malformed or unknown token returns a JSON `401`
(`{ "statusCode": 401, "error": "Unauthorized", "message": "A valid bearer token is required" }`).
Read routes stay public in V1. A malformed token list or the same token configured twice fails
startup. With no tokens configured the server still starts, but every write is rejected.

## Scripts

| Script                | What it does                                       |
| --------------------- | -------------------------------------------------- |
| `npm run dev`         | Start Fastify with file watching (`tsx watch`)     |
| `npm run build`       | Type-check and compile `src/` to `dist/`           |
| `npm start`           | Run the compiled server from `dist/`               |
| `npm run typecheck`   | Type-check the project without emitting files      |
| `npm test`            | Run the vitest suite                               |
| `npm run db:generate` | Generate a new migration from `src/db/schema.ts`   |
| `npm run db:migrate`  | Apply pending migrations to the database           |
| `npm run db:rebuild-projections` | Truncate the issues projection and replay the event log |

## Database and migrations

The schema lives in [`src/db/schema.ts`](./src/db/schema.ts); generated SQL migrations live in
`drizzle/`. After changing the schema, generate and apply a migration:

```sh
npm run db:generate
npm run db:migrate
```

Commit both the generated SQL file and the `drizzle/meta/` files.

### Rebuilding projections

`issues` is a projection of the event log. To truncate it and replay every event:

```sh
npm run db:rebuild-projections
```

The command runs in a single transaction and folds the log in `seq` order: `issue.created` seeds
a row, `issue.updated` applies the changed fields it carries, and `comment.created` leaves the
projection alone because comments are read from the event log itself. It restores issue keys,
timestamps and `last_event_seq`, then advances the issue key sequence so later creates continue
from the right number. It needs the database to be migrated and reachable through `DATABASE_URL`.
The command fails loudly on an issue event type it does not know how to apply rather than silently
dropping projection state.

## Issues API

All responses are JSON. Timestamps are ISO-8601 strings. `lastEventSeq` is the `seq` of the latest
event that shaped the projected row.

### `POST /issues`

Body: `{ "title", "body"?, "status"?, "priority"?, "assignee"? }`

| Field      | Default     | Notes                                             |
| ---------- | ----------- | ------------------------------------------------- |
| `title`    | required    | non-empty string                                  |
| `body`     | `""`        | string                                            |
| `status`   | `"backlog"` | `backlog`, `todo`, `in_progress`, `done`, `canceled` |
| `priority` | `0`         | integer 0–4                                       |
| `assignee` | `null`      | string or null                                    |

Returns `201` with
`{ id, key, title, body, status, priority, assignee, createdAt, updatedAt, lastEventSeq }`.
The projection insert, the `issue.created` append and the `last_event_seq` update happen in one
transaction. The event payload carries an issue snapshot so the projection can be rebuilt.

### `GET /issues?limit=50&cursor=...`

Newest first (descending `key`). `limit` defaults to 50 and must be an integer from 1 to 100. The
`cursor` is the opaque `nextCursor` from the previous page. Returns
`{ "issues": [...], "nextCursor": "..." | null }`; `nextCursor` is `null` on the last page. An
invalid `limit` or `cursor` returns `400`.

### `GET /issues/:id`

Returns the full issue, or `404` with
`{ "statusCode": 404, "error": "Not Found", "message": "Issue not found" }`.

### `GET /issues/:id/events`

Returns `{ "events": [...] }`, oldest first, with each event row as stored (`id`, `at`,
`actorType`, `actorId`, `entityType`, `entityId`, `type`, `payload`, `seq`). An unknown issue
returns the same `404` body.

### `PATCH /issues/:id`

Requires a bearer token. Body: any non-empty subset of
`{ "title", "body", "status", "priority", "assignee" }`, with the same field rules as
`POST /issues`; `"assignee": null` clears the assignee. Returns `200` with the full updated issue.
The projection write and exactly one `issue.updated` append happen in one transaction, and that
event payload contains only the fields supplied in the patch (for example `{ "title": "New" }`),
which is what a projection rebuild replays. An invalid status or priority returns `400`; an
unknown issue and an empty patch return `404` and `400` respectively.

### `POST /issues/:id/comments`

Requires a bearer token. Body: `{ "body" }` (non-empty string). Returns `201` with
`{ id, issueId, body, actorType, actorId, createdAt }` and appends a `comment.created` event whose
payload is `{ "body" }`. The comment id is the event id. An unknown issue returns the usual `404`.

### `GET /issues/:id/comments`

Public. Returns `{ "comments": [...] }`, oldest first, in the same shape as the `POST` response.
Comments are derived from `comment.created` events, so they survive
`db:rebuild-projections`; adding one does not change the issue projection.

### Actor attribution

The SPEC requires every event to carry `actor_type` and `actor_id`. The bearer-token hook resolves
`Authorization: Bearer <token>` into an actor identity, and every write route passes that actor to
the service layer. The request body can never supply an actor: the body schemas reject or strip
unknown fields, and the tests assert that a body-supplied `actor`, `actorType` or `actorId` is
ignored in favour of the token identity.

## Testing

```sh
docker compose up -d
npm run db:migrate
npm test
```

Tests connect to Postgres through `DATABASE_URL`, so the database must be running and migrated.
They cover the healthy `/health` response against a real database, the 503 response when the
database is unavailable, the issue create/read/pagination/timeline/404 paths, bearer-token
configuration and 401 responses, agent versus human attribution (including a body-supplied actor
being ignored), partial issue updates and their single changed-fields event, comment round-trips,
projection rebuild equivalence for creates, updates and comments, and a seeded benchmark asserting
that `GET /issues?limit=50` on 10,000 issues stays under the SPEC p95 target of 50 ms. The
database-backed tests truncate both tables between cases and run sequentially.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`. The `ci` job starts a
Postgres 16 service container, installs with `npm ci`, then runs `typecheck`, `db:migrate` and
`npm test` against that real database. The job is named `ci` because branch protection requires
that check.
