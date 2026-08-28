# Personal AI Assistant

A single-user personal assistant over Telegram: projects, tasks, time tracking,
persistent reminders, Google Calendar and with proactive briefings. The LLM
interprets requests and selects **typed tools**. The LLM is not the source of truth
and not the scheduler.

## Status

**In progress.** Development follows a phased plan tracked internally.

## Stack

TypeScript · Node 22+ · grammY (Telegram) · Hono (health) · PostgreSQL + Drizzle ·
pg-boss (jobs) · Anthropic SDK · Vitest · Docker Compose.

## Architecture (V1)

```
Telegram → Telegram Adapter → Agent Service ── LLM Provider
                                   ↓
                              Tool Registry
                              ├─ Projects / Tasks ─ PostgreSQL
                              ├─ Time Tracking ──── PostgreSQL
                              ├─ Reminders ──────── PostgreSQL + pg-boss
                              └─ Calendar ───────── Google Calendar API
```

Design invariants:

- **Structured state is authoritative.** Projects, tasks, time and reminders live
  in PostgreSQL; appointments live in Google Calendar. The LLM reads and writes
  them only through tools.
- **Typed tools only.** No generic SQL, shell or filesystem tool is ever exposed
  to the model.
- **The scheduler is deterministic.** Reminder delivery runs without an LLM call,
  so it cannot fail on a model error or a rate limit.
- **Destructive actions require confirmation.** Reads and low-risk writes execute
  directly; deletions and bulk changes ask first.

## Local development

Prerequisites: Node 22+, Docker.

```bash
cp .env.example .env
# Fill in: POSTGRES_PASSWORD (openssl rand -base64 24), DATABASE_URL to match,
# TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_IDS, ANTHROPIC_API_KEY
npm install
docker compose up -d postgres   # local Postgres
npm run dev                      # start the assistant
```

`POSTGRES_PASSWORD` has no default — compose refuses to start without it, so no
deployment can run on a password committed to this repository.

The app applies pending migrations on startup, so no separate migration step is
needed for a normal run. Run the whole stack in Docker:

```bash
docker compose up --build
```

Both published ports bind to `127.0.0.1` rather than all interfaces: Docker's
default publishing is reachable from the network and bypasses host firewall
rules such as UFW.

Health check: `GET http://localhost:3000/health` — returns `503` when Postgres
is unreachable.

## Scripts

| Script                | Purpose                                         |
| --------------------- | ----------------------------------------------- |
| `npm run dev`         | Run in watch mode                               |
| `npm run build`       | Compile TypeScript to `dist/`                   |
| `npm test`            | Run unit/integration tests (Vitest)             |
| `npm run typecheck`   | Type-check without emitting                     |
| `npm run lint`        | ESLint                                          |
| `npm run db:generate` | Generate a migration from `src/db/schema.ts`    |
| `npm run db:migrate`  | Apply pending migrations (also done at startup) |

## Data model

`projects`, `tasks` and `work_sessions` live in Postgres and are authoritative.
All instants are stored as `timestamptz` in UTC; user input is interpreted in
the configured timezone (`TZ`, default `Europe/Rome`) and resolved to an
absolute instant before persistence. Two invariants are enforced by the database
rather than by application code: at most one running work timer, and
`tasks.completed_at` set exactly when a task is `done`.

## Security

No personal data is committed: `.env`, tokens, OAuth secrets and personal
Telegram IDs stay out of Git, and fixtures and evals are synthetic.

Access control: the bot answers only in private chats, and only to the numeric
Telegram user IDs listed in `TELEGRAM_ALLOWED_USER_IDS` — an empty allowlist
rejects everyone. The container runs as a non-root user, and the LLM is never
given generic shell or SQL access, only typed tools.

## License

[MIT](./LICENSE)
