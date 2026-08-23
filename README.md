# Personal AI Assistant

A single-user personal assistant over Telegram: projects, tasks, time tracking,
persistent reminders and Google Calendar — with proactive briefings. The LLM
interprets requests and selects **typed tools**; it is not the source of truth
and not the scheduler.

## Status

**V1 in progress.** Development follows a phased plan tracked internally.

## Stack

TypeScript · Node 20+ · grammY (Telegram) · Hono (health) · PostgreSQL + Drizzle ·
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

Design invariants: structured state is authoritative, typed tools only,
deterministic scheduler (no LLM at delivery time), destructive actions require
confirmation. See spec §3.

## Local development

Prerequisites: Node 20+, Docker.

```bash
cp .env.example .env      # fill TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, TELEGRAM_ALLOWED_USER_IDS
npm install
docker compose up -d postgres   # local Postgres
npm run dev                      # start the assistant
```

Run the whole stack in Docker:

```bash
docker compose up --build
```

Health check: `GET http://localhost:3000/health`.

## Scripts

| Script | Purpose |
|---|---|
| `npm run dev` | Run in watch mode |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run unit/integration tests (Vitest) |
| `npm run typecheck` | Type-check without emitting |
| `npm run lint` | ESLint |

## Security

Public, portfolio-grade repo. **No personal data is committed:** `.env`, tokens,
OAuth secrets and personal Telegram IDs stay out of Git; fixtures and evals are
synthetic. See spec §15.
