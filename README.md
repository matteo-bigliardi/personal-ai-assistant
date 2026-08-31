# Personal AI Assistant

A single-user personal assistant over Telegram: projects, tasks, time tracking,
persistent reminders, Google Calendar and with proactive briefings. The LLM
interprets requests and selects **typed tools**. The LLM is not the source of truth
and not the scheduler.

## Status

**In progress.** Projects, tasks and time tracking are implemented end to end —
the agent loop, the typed tool boundary and all twelve tools work over Telegram.
Reminders and Calendar are next.

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
- **The agent owns the loop, not the provider.** A provider performs exactly one
  round trip and never executes anything: it reports which tools the model asked
  for and returns. Validation, execution and every side effect stay in the
  agent, so swapping in a different inference backend cannot change what the
  assistant is allowed to do.

### Agent loop

```
message → provider (one round trip) → validate arguments → execute tools
        → feed results back → … (bounded) → final answer
```

Each tool is one zod schema, used both to advertise a JSON Schema to the model
and to validate what comes back. A failure is a structured result the model can
read and correct, not an exception: domain errors reach it verbatim, unexpected
faults are logged and reported as opaque.

Two properties keep the running cost predictable. The system prompt and tool
definitions form a **cached prefix**, so nothing volatile may go in them — the
current time is prepended to the user message instead. And the model never does
calendar arithmetic: it receives the current instant and the next seven dates
computed from the real clock, and may only pass back absolute ISO-8601 instants,
which are re-validated before anything is persisted.

Conversational history is deliberately thin. The database is the assistant's
memory; the transcript exists only to resolve "mark that one done". Completed
exchanges are kept in memory, bounded and never persisted, and intermediate tool
traffic is discarded once a turn ends.

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

Integration tests need Postgres. They never touch `DATABASE_URL` itself: the URL
is redirected to a sibling database suffixed `_test`, created on demand, so
running the suite cannot destroy real data. With no server reachable they skip
rather than fail.

`scripts/agent-smoke.ts` sends messages through the real stack (model, database,
tools) without Telegram, which is handy when adding a tool:

```bash
npx tsx --env-file-if-exists=.env scripts/agent-smoke.ts "create project Atlas"
```

## Data model

`projects`, `tasks` and `work_sessions` live in Postgres and are authoritative.
All instants are stored as `timestamptz` in UTC; user input is interpreted in
the configured timezone (`TZ`, default `Europe/Rome`) and resolved to an
absolute instant before persistence. Two invariants are enforced by the database
rather than by application code: at most one running work timer,
`tasks.completed_at` set exactly when a task is `done`, and project names unique
regardless of casing, since chat refers to projects by name.

Project status carries behaviour rather than being a label: `active` is what
the briefing will consider, `paused` is a deliberate hold that stays listed with
its tasks intact, and `archived` is the soft delete — there is no
`delete_project`. Listings hide archived projects by default and nothing else.
Tasks work the same way: `cancelled` is their soft delete, and a listing shows
open tasks unless a status is asked for.

Projects are addressed by name, because that is how chat refers to them and
because the name is unique. Task titles are not unique, so tasks are addressed
by the first eight characters of their id, shown in every listing and resolved
back to exactly one row — an ambiguous reference is refused rather than guessed.

A deadline given as a plain calendar date means the end of that day in the
configured timezone, so a task due Friday is not reported as overdue on Friday
morning. The model never computes that instant: it reports the date it read off
the per-turn calendar block, and the conversion, including which daylight-saving
offset applies to that particular day, happens in `domain/datetime.ts`.

Time is tracked as work sessions, at most one of them running at a time. A
timer may run on a paused project — if you are working on it, it is not paused
any more — but not on a completed or archived one. Starting a second timer is
refused, and the refusal names the project already running rather than silently
stopping it. Reporting periods are half-open ranges `[from, to)`, resolved from
a named period or a pair of calendar dates; a session that straddles a boundary
is counted only for the part inside, and a running timer is counted up to now
and reported separately so a total never looks more final than it is.

Domain timestamps come from the application clock, not from column defaults: a
default `now()` is the transaction start time on the database host, which is a
different machine under Docker, and mixing the two can place an `updated_at`
before its own `created_at`.

## Security

Access control: the bot answers only in private chats, and only to the numeric
Telegram user IDs listed in `TELEGRAM_ALLOWED_USER_IDS` — an empty allowlist
rejects everyone. The container runs as a non-root user, and the LLM is never
given generic shell or SQL access, only typed tools.

## License

[MIT](./LICENSE)
