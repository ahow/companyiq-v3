# PgBouncer connection pooler (Phase 2 — performance foundation)

This documents the PgBouncer service that fronts the Railway Postgres database so
that the `app` service and the (multi-replica) `worker` service can share a small,
bounded set of real Postgres connections instead of each opening its own pool
directly against the database.

## Why

Railway Postgres enforces a low connection cap (~25 usable). With N worker
replicas plus the app, each holding its own `pg` pool, direct connections can
exceed that cap and cause `too many connections` / connection-exhaustion errors
under load. PgBouncer in **transaction pooling** mode multiplexes many client
connections onto a handful of real server connections, keeping upstream usage
well under the cap while letting the services keep modest local pools.

## Service

Deployed on Railway (environment: `sprint-10-preview`) as a service named
`pgbouncer`, from the public image:

```
edoburu/pgbouncer:latest   # PgBouncer 1.25.x
```

It reaches Postgres over the Railway private network
(`postgres.railway.internal:5432`) and is itself reachable by the other services
at `pgbouncer.railway.internal:5432`.

## Configuration (service variables)

The `edoburu/pgbouncer` image renders `pgbouncer.ini` / `userlist.txt` from these
environment variables. Values below are the deployed settings; secrets
(`DB_PASSWORD`) are stored as Railway service variables and are **not** committed.

| Variable | Value | Notes |
|----------|-------|-------|
| `DB_HOST` | `postgres.railway.internal` | upstream Postgres (private network) |
| `DB_PORT` | `5432` | |
| `DB_USER` | `postgres` | |
| `DB_PASSWORD` | *(secret)* | Railway service variable, not committed |
| `DB_NAME` | `companyiq_v3` | |
| `POOL_MODE` | `transaction` | multiplexes per-transaction (max reuse) |
| `AUTH_TYPE` | `plain` | userlist rendered from DB_USER/DB_PASSWORD |
| `MAX_CLIENT_CONN` | `1000` | many app/worker client conns allowed |
| `DEFAULT_POOL_SIZE` | `18` | real server conns per (user,db) — under the ~25 cap |
| `MIN_POOL_SIZE` | `2` | keep a warm baseline |
| `RESERVE_POOL_SIZE` | `2` | burst headroom (18+2 = 20 max upstream, < 25) |
| `RESERVE_POOL_TIMEOUT` | `3` | seconds before reserve pool is used |
| `LISTEN_PORT` | `5432` | |
| `LISTEN_ADDR` | `0.0.0.0,::` | **must bind IPv6** — Railway private net is IPv6-only |
| `IGNORE_STARTUP_PARAMETERS` | `extra_float_digits` | tolerate client startup params |
| `SERVER_CHECK_QUERY` | `select 1` | health probe against upstream |

### Upstream connection budget

`DEFAULT_POOL_SIZE (18) + RESERVE_POOL_SIZE (2) = 20` real Postgres connections
maximum for the single `(postgres, companyiq_v3)` pair — comfortably under the
~25 cap, regardless of how many app/worker replicas or client connections exist.

## Application side

- `app` and `worker` set `DATABASE_URL` to point at
  `pgbouncer.railway.internal:5432` (same credentials/db, host swapped).
- `worker` `PG_POOL_MAX` lowered from `10` to `5`: with the pooler in front, each
  replica only needs a small local pool; the pooler absorbs concurrency.
- See `server/db.ts` for the pool sizing rationale and the transaction-pooling
  compatibility notes.

## Transaction-pooling compatibility

Transaction pooling does **not** pin a client to one server connection between
statements, so any *session*-scoped server state (session-level advisory locks,
`SET` that must persist across queries, `LISTEN`/`NOTIFY`, server-side prepared
statements) is unsafe. This app is compatible:

- node-postgres (drizzle's driver) issues **no server-side prepared statements**
  by default.
- No session-scoped `SET` is relied upon across separate pool queries.
- No `LISTEN`/`NOTIFY`.
- The one advisory-lock consumer, `server/reconciler.ts`, was changed to take a
  **transaction-scoped** lock (`pg_try_advisory_xact_lock` inside an explicit
  `BEGIN`/`COMMIT`) instead of a session-scoped `pg_advisory_lock`, so the lock
  is held for the duration of an open transaction (which pins one server
  connection) and auto-releases on `COMMIT`/`ROLLBACK`. Correct under
  transaction pooling, session pooling, and direct connections.

## Recreating the service (Railway CLI)

```sh
# From a shell linked to the target project/environment.
# DB_PASSWORD is read from the existing app DATABASE_URL; never echo it.
railway add --service pgbouncer --image edoburu/pgbouncer:latest \
  --variables "DB_HOST=postgres.railway.internal" \
  --variables "DB_PORT=5432" \
  --variables "DB_USER=postgres" \
  --variables "DB_PASSWORD=<secret>" \
  --variables "DB_NAME=companyiq_v3" \
  --variables "POOL_MODE=transaction" \
  --variables "AUTH_TYPE=plain" \
  --variables "MAX_CLIENT_CONN=1000" \
  --variables "DEFAULT_POOL_SIZE=18" \
  --variables "MIN_POOL_SIZE=2" \
  --variables "RESERVE_POOL_SIZE=2" \
  --variables "RESERVE_POOL_TIMEOUT=3" \
  --variables "LISTEN_PORT=5432" \
  --variables "LISTEN_ADDR=0.0.0.0,::" \
  --variables "IGNORE_STARTUP_PARAMETERS=extra_float_digits" \
  --variables "SERVER_CHECK_QUERY=select 1"
```

Then point `app` / `worker` `DATABASE_URL` at `pgbouncer.railway.internal:5432`.
