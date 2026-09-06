# Personal AI Assistant

A single-user personal assistant over Telegram: projects, tasks, time tracking,
persistent reminders, Google Calendar and with proactive briefings. The LLM
interprets requests and selects **typed tools**. The LLM is not the source of truth
and not the scheduler.

## Status

**In progress.** Projects, tasks, time tracking, persistent reminders, Google
Calendar, a morning briefing and an audit trail are implemented end to end — the
agent loop, the typed tool boundary and all twenty-three tools work over
Telegram, and destructive actions cannot run until the user has confirmed them.
What remains before V1 is a synthetic eval set and a round of real use.

## Stack

TypeScript · Node 24 · grammY (Telegram) · Hono (health) · PostgreSQL + Drizzle ·
pg-boss (jobs) · Anthropic SDK · Vitest · Docker Compose.

## Using it

There are no commands to learn: you write to the bot the way you would write to
a person, and it answers in whatever language you wrote in. `/start` exists and
only says hello.

**Projects and tasks**

```text
Create project Atlas.
Add "prepare the demo" to Atlas for Friday.
What's open on Atlas?
What's due today?
Mark the demo one done.
```

Projects are addressed by name. Task titles are not, so a listing shows a short
id next to each one — "the demo one" works because the assistant has just read
the list, and a reference it cannot narrow to exactly one task is refused rather
than guessed. A task with no date is fine; asked for something vague like
"soon", it will ask rather than invent a deadline.

**Time**

```text
I'm starting on Atlas.
Stop the timer.
I worked on Atlas yesterday from 14:00 to 16:30.
How much time did I spend on Atlas this week?
```

One timer runs at a time, and starting a second is refused with the name of the
one already running rather than silently stopping it. A report covers today,
this week, this month or a pair of dates, and counts a running timer up to now,
listed separately so the total does not look more final than it is.

**Reminders**

```text
Remind me to check the build in 45 minutes.
Remind me to call the bank tomorrow at 9.
What reminders do I have?
Snooze the build one 20 minutes.
Cancel the bank one.
```

A reminder arrives with `[Done] [Snooze 10m] [Snooze 1h]` attached, so the usual
answer is one tap. Delivery does not go through the model, and a reminder that
came due while the app was down is delivered late rather than dropped.

**Calendar**

```text
What's on my calendar today?
And tomorrow?
Put a meeting on Friday from 15:00 to 15:30.
Move the design review to 17:00.
Find me two free hours tomorrow afternoon.
```

**The morning briefing**

It arrives on its own, every morning, and says so even when there is nothing to
report. The time is changed by asking, not by editing the environment:

```text
What time do you send the briefing?
Send it at 8:05.
```

**Deleting things**

Deleting a calendar event and archiving a project stop and ask first, and the
answer has to come in the next message:

```text
Delete the design review.
→ About to permanently delete "Design review", today 14:00–15:00. Confirm?
Yes.
```

Nothing has happened at the point where it asks — the request is held server
side and the same call only runs after you have answered. There is no
`delete_project` and no `delete_task`: archiving and cancelling are the soft
deletes, and both keep their history.

Finally, when a request is not something it can do — "email me the summary" —
it says so plainly instead of implying it was done.

## Architecture (V1)

```
Telegram → Telegram Adapter → Agent Service ── LLM Provider
                                   ↓
                              Tool Registry
                              ├─ Projects / Tasks ─ PostgreSQL
                              ├─ Time Tracking ──── PostgreSQL
                              ├─ Reminders ──────── PostgreSQL + pg-boss
                              ├─ Calendar ───────── Google Calendar API
                              └─ Briefing ───────── PostgreSQL + pg-boss

pg-boss workers → reminder delivery · morning briefing
```

Design invariants:

- **Structured state is authoritative.** Projects, tasks, time and reminders live
  in PostgreSQL; appointments live in Google Calendar. The LLM reads and writes
  them only through tools.
- **Typed tools only.** No generic SQL, shell or filesystem tool is ever exposed
  to the model.
- **The scheduler is deterministic.** Reminder delivery runs without an LLM call,
  so it cannot fail on a model error or a rate limit.
- **Destructive actions require confirmation**, and the rule is enforced rather
  than requested. The tool registry refuses the first attempt at a destructive
  call outright and records what was asked for; only the identical call made
  while handling a _later_ message runs. The assistant therefore has to end its
  turn — which means saying something — and the user has to answer, before
  anything is deleted. There is no token for the model to carry: the pending
  request lives server-side, out of reach of the conversation.
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

Prerequisites: Node 24, Docker.

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
| `npm run eval`        | Run the agent eval suite against the real model |

| Shell script            | Purpose                                           |
| ----------------------- | ------------------------------------------------- |
| `scripts/backup-db.sh`  | Dump the database, verifying the dump is readable |
| `scripts/restore-db.sh` | Restore a dump, into a scratch database if asked  |

Integration tests need Postgres. They never touch `DATABASE_URL` itself: the URL
is redirected to a sibling database suffixed `_test`, created on demand, so
running the suite cannot destroy real data. With no server reachable they skip
rather than fail.

`scripts/agent-smoke.ts` sends messages through the real stack (model, database,
tools) without Telegram, which is handy when adding a tool:

```bash
npx tsx --env-file-if-exists=.env scripts/agent-smoke.ts "create project Atlas"
```

`scripts/briefing-smoke.ts` composes and prints today's briefing immediately,
rather than waiting for the scheduled hour. It bypasses the once-a-day claim, so
it never consumes the real morning briefing:

```bash
npx tsx --env-file-if-exists=.env scripts/briefing-smoke.ts
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

Google Calendar is authoritative for appointments and is never mirrored into
Postgres: every answer is a live read. Authentication is a service account with
the calendar shared to it rather than an OAuth consent flow — an OAuth app left
in Google's testing state hands out refresh tokens that expire weekly, and
publishing one requires a domain, a privacy policy and a review, all to protect
users of an app that has exactly one. The trade is that the service account is a
separate identity: it manages the calendar shared with it, but cannot invite
other people as the user.

Free-slot search is pure interval arithmetic over the events read back, so
overlapping meetings, one event containing another and events reaching in from
outside the window are handled without a network round trip to test them.
All-day events are reported next to the slots rather than counted as busy: a
birthday would otherwise empty the day, and a birthday and a week of leave are
not distinguishable through the API.

Reminders are delivered by a background worker, never by the model: the text is
written when the reminder is created, so it arrives on time even if the LLM is
unreachable. The queue (pg-boss, in its own database schema) is a mechanism, not
the record — the reminders table is authoritative, which is what makes recovery
possible. On startup anything that fell due while the process was down is
delivered late rather than dropped, and a reminder whose job was never created,
because the process died between the insert and the enqueue, is scheduled again.
Delivery is idempotent: the worker claims a reminder with a conditional status
update before sending, so a pg-boss retry, or two workers racing, cannot deliver
the same message twice.

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

The morning briefing is the one place the model is used without tools and
without a loop. Today's events and the tasks that are due are collected
deterministically by calling the domain services, and the model is handed that
data with a single job: turn it into a few lines. It cannot forget to look at
the tasks or wander off to read something else. It is sent every morning, empty
days included, and says so explicitly — a silent morning is indistinguishable
from a job that never ran — and if the provider is unreachable the same data is
rendered without a model and sent anyway. "The calendar could not be read" and
"there is nothing in the calendar" are kept as different answers.

Its schedule lives in the database rather than in the environment, because the
natural way to change it is to ask: `BRIEFING_TIME` seeds the row on first start
and is ignored afterwards, and `set_briefing_time` reschedules the job in the
same call. The schedule is a cron carrying an IANA timezone, so 07:30 stays
07:30 across daylight saving. One briefing per day is enforced by a conditional
update rather than by trusting the queue, and the claim is released if the send
fails, so a retry can still deliver.

Every tool call and every turn is recorded in `audit_events`: which tool, the
outcome, the error code, the latency, and for a turn the model, the round trips
and the token counters. What is **not** recorded is argument values. Tool
arguments are the user's own words, and this is the only table kept for months,
so what goes in is the name, type and size of each argument — enough to measure
whether the model picks the right tool and fills it in correctly, not enough to
reconstruct a sentence anyone said. A failed audit write is logged and swallowed:
it must never fail the action it describes. A daily sweep drops rows older than
`AUDIT_RETENTION_DAYS`.

## Evals

`npm run eval` runs twenty-three synthetic conversations through the real agent
loop, the real tool definitions and the real model, with the domain services
replaced by fakes. Nothing is written anywhere: an eval run cannot reach the
database, the calendar or anyone's data, and the clock is frozen to a fixed
Wednesday so that "Friday" has exactly one right answer.

Three numbers come out:

| Metric                  | What it means                              |
| ----------------------- | ------------------------------------------ |
| tool-selection accuracy | the expected tool was the one called       |
| argument correctness    | of the arguments checked, how many matched |
| task success rate       | the case passed completely                 |

The cases cover creating and completing tasks, timers, reminders, calendar
reads, writes and moves, relative and ambiguous dates, the confirmation flow,
and one request no tool covers — where the right answer is to say so. A run
writes to `evals/results/local/`, which is git-ignored; `evals/results/v1-baseline.json`
is a committed reference run.

Two things the harness deliberately does not assert. Instants are compared as
instants, so `15:00+02:00` and `13:00Z` are the same answer and a case cannot
fail on formatting. And where the model may reasonably either act at once or
offer a confirmation first — moving an appointment, for instance — the case
checks the outcome across the whole conversation rather than pinning the route,
because the route varies between runs.

Writing the cases found two things worth keeping. `delete_calendar_event` used
to tell the model to confirm before calling, which made the user confirm twice:
once for the model's own question and once for the registry's refusal. And the
first eval run failed a move because the _fake_ applied only the start of the
patch — the model noticed the zero-length event it got back and kept retrying,
which is the behaviour you would want against a real API misbehaving.

## Backups

```bash
./scripts/backup-db.sh                 # → backups/assistant-<timestamp>.dump
./scripts/backup-db.sh /mnt/elsewhere  # somewhere that survives this machine
```

The backup is a `pg_dump` archive, not a copy of the Docker volume: a volume is
tied to this Postgres version and this host, a dump restores anywhere. The
script reads its credentials from the same `.env` compose uses, and then reads
the archive's table of contents back — a dump that cannot be read is not a
backup.

Restoring is the half that is usually never tested, so it is one command, and it
takes a target database so it can be tested without touching the live one:

```bash
docker compose stop assistant
./scripts/restore-db.sh backups/assistant-<timestamp>.dump scratch_check  # rehearsal
./scripts/restore-db.sh backups/assistant-<timestamp>.dump                # the real thing
docker compose start assistant
```

Restoring into the live database asks for the database name first. Google
Calendar is not part of any of this: it is authoritative for appointments and
holds its own history.

## Security

Access control: the bot answers only in private chats, and only to the numeric
Telegram user IDs listed in `TELEGRAM_ALLOWED_USER_IDS` — an empty allowlist
rejects everyone. The container runs as a non-root user, and the LLM is never
given generic shell or SQL access, only typed tools.

Nothing personal is retained beyond what the assistant is asked to remember. The
audit trail stores argument shapes rather than argument values, logs redact
anything that looks like a secret, and Google credentials are a service-account
key file kept out of the repository. Deletions cannot happen without an explicit
confirmation in a separate message.

## Limitations

Known and deliberate, so nobody has to discover them the hard way.

**Built for one person.** The allowlist, the briefing recipient and the single
running timer all assume one user. Nothing would stop a second person from being
allowlisted, but they would share the same projects, tasks and timer.

**The calendar cannot invite anyone.** Authentication is a service account, which
is a separate identity from the user. It manages the calendar shared with it, but
an event it creates cannot invite other people. It also works on exactly one
calendar.

**Recurring anything is out.** The assistant can move or delete a single
occurrence of an existing recurring event, but it cannot create a recurring
event or a recurring reminder.

**Conversation memory is in-process.** Short history and pending confirmations
live in memory and are lost on restart. The cost is small — a repeated sentence,
or being asked to confirm again — and the database, which is the real memory, is
untouched. But it does mean the assistant cannot run as more than one process.

**No semantic memory.** The assistant knows what is in the database. It does not
remember what you told it last week, and asking "what did we decide about X"
will not work unless X was written down as a task or a project.

**Projects have no deadline.** Dates live on tasks. The morning briefing reports
tasks that are due or overdue along with the project each belongs to, which
covers the same ground in practice.

**Every message costs two or three model round trips.** The system prompt and
tool definitions are a cached prefix, which keeps the bill down, but a chatty day
is a real cost. The audit trail records the token counters if you want to check.

**Without the model, the assistant is mute.** Reminders still arrive on time and
the morning briefing still goes out as plain text, because neither needs the LLM
at delivery. Everything conversational stops.

**The audit trail cannot be replayed.** It records which tool ran and how it
went, and the names, types and sizes of the arguments — never their values. That
is a privacy decision, and it means the trail can tell you the model picked the
wrong tool but not what you had asked for.

**Telegram only, long polling only.** No web UI, no webhook, no other channel.

## License

[MIT](./LICENSE)
