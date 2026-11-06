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

The local Compose service publishes Postgres on host port `5438` (rather than `5432`, which is
often already in use). The default `DATABASE_URL` already points at it, so no environment file is
needed for local development.

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

## Database and migrations

The schema lives in [`src/db/schema.ts`](./src/db/schema.ts); generated SQL migrations live in
`drizzle/`. After changing the schema, generate and apply a migration:

```sh
npm run db:generate
npm run db:migrate
```

Commit both the generated SQL file and the `drizzle/meta/` files.

## Testing

```sh
docker compose up -d
npm run db:migrate
npm test
```

Tests connect to Postgres through `DATABASE_URL`, so the database must be running and migrated.
They cover the healthy `/health` response against a real database and the 503 response when the
database is unavailable.

## CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`. The `ci` job starts a
Postgres 16 service container, installs with `npm ci`, then runs `typecheck`, `db:migrate` and
`npm test` against that real database. The job is named `ci` because branch protection requires
that check.
