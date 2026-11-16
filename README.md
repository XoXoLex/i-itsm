# I-ITSM: Intelligent IT Service Management & Incident Resolution System

[![CI](https://github.com/XoXoLex/i-itsm/actions/workflows/ci.yml/badge.svg)](https://github.com/XoXoLex/i-itsm/actions/workflows/ci.yml)

CS F213 OOP project, Semester I 2026-27.
A full-stack service desk: employees report IT problems; the system classifies, prioritises and assigns them to a technician,
tracks SLA deadlines, escalates automatically, notifies everyone involved and keeps a complete audit trail.

## Run it

Needs **Node.js 22 or 24 LTS** (from nodejs.org).

```bash
npm run setup     # installs everything and builds the frontend (first time only)
npm start         # http://localhost:3000
```

The first start creates `data/itsm.db` and seeds it with 8 services, 4 technicians, 3 employees, an admin and about 10 days of incident history.
Delete the `data` folder to start fresh.

| Role | Email | Password |
|---|---|---|
| Employee | ankit@corp.local | employee1 |
| Employee | divya@corp.local | employee2 |
| Technician | rahul@itsm.local | tech12345 |
| Technician | sneha@itsm.local | tech12345 |
| IT manager (admin) | admin@itsm.local | admin1234 |

The login page has one-click buttons for the first three.

Other commands:

```bash
npm test          # 20 automated test cases
npm run demo      # the 3 demo workflows in the terminal (no browser)
npm run typecheck
cd web && npm run dev   # frontend hot-reload on :5173 (proxies /api to :3000)
```

### Docker

```bash
docker build -t i-itsm .
docker run -p 3000:3000 -v itsm-data:/data i-itsm
```

### Deploy to Render (free tier)

`render.yaml` describes the service. On render.com choose **New → Blueprint**, pick this repository, and deploy. Add `GEMINI_API_KEY` in the dashboard to switch on AI categorisation. The free tier's disk is temporary, so the demo data is re-seeded whenever the service restarts.

### Continuous integration

`.github/workflows/ci.yml` runs on every push: install, type-check, the 20 tests, and a production build of the frontend.

Optional settings go in `.env` (see `.env.example`). Setting `GEMINI_API_KEY` switches the categoriser to Google's Gemini Decisions API (`gemini-decision-1`), or to `gemini-4-hydrogen` with `GEMINI_MODE=generate`. Both fall back to keyword matching if the API fails.

## Technology stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript (front and back) | One language end to end; classes, abstract classes, interfaces, access modifiers and generics map directly onto OOP concepts; compile-time type checking |
| Backend | Node.js + Express 5 | Lightweight REST layer; the domain model stays framework-free |
| Frontend | React 19 + Vite | Component model; a separate UI per role |
| Database | SQLite via better-sqlite3 | ACID, zero setup, a single file; the Repository pattern means swapping in PostgreSQL only needs a new repository class |
| Auth | JWT + scrypt-hashed passwords | Stateless sessions; salted hashes, never plain text |
| Real-time | Server-Sent Events | Live dashboard refresh and push notifications without extra infrastructure |
| AI (optional) | Google Gemini Decisions API (`gemini-decision-1`) or `gemini-4-hydrogen` | Incident categorisation behind an Adapter, with automatic keyword fallback |
| Email (optional) | Resend API adapter | Real email delivery behind the same `NotificationChannel` interface |
| Tests | node:test + tsx | Built-in runner, no extra framework |
| CI / deployment | GitHub Actions, Docker, Render | Tests on every push; one-command container; one-click cloud deploy |

## Architecture

```
 Browser (React)  ──REST/JSON──►  Express API (src/api)  ──►  Services (src/services)  ──►  Domain model (src/domain, src/state)
       ▲                                │                          │        │                       │
       └──── Server-Sent Events ────────┘                          │        └─► Strategies (priority, assignment)
                                                                   │        └─► Intelligence (categoriser, duplicates, suggestions)
                                                                   ▼
                                                        EventBus (Observer) ──► AuditLogger, NotificationDispatcher ──► InApp / Email / Live channels
                                                                   │
                                                        Repository<T>  ──►  SqliteRepository (write-through)  ──►  SQLite (schema.sql)
```

## Folder map

```
src/
  domain/          User hierarchy, Incident (+ snapshot/restore), ITService, Category, SLAPolicy, AuditEntry, enums
  state/           IncidentState + one class per lifecycle stage (State pattern)
  strategies/      PriorityStrategy (2) and AssignmentStrategy (3), each with a factory
  events/          EventBus (subject) + AuditLogger, NotificationDispatcher (observers)
  notifications/   NotificationChannel: InApp (persisted), SimulatedEmail, ResendEmailAdapter + factory
  repositories/    Repository<T> interface, InMemoryRepository, IdGenerator
  persistence/     SqliteStore + SqliteRepository + row mappers
  intelligence/    KeywordCategorizer, DuplicateDetector, ResolutionSuggester
  services/        IncidentService (facade), SLAService, AuthService, AdminService, ReportService, Clock
  api/             Express app, DTOs, GeminiCategorizer (adapter), LiveChannel (SSE)
  exceptions/      ItsmError hierarchy (13 custom exceptions, each mapped to an HTTP status)
  system.ts        composition root; seedHistory.ts demo data; main.ts server entry
web/src/           React UI: Login, IncidentList, IncidentView, ReportForm, Dashboard, Admin (settings, people, audit)
schema.sql         relational schema (13 tables, constraints, indexes)
tests/             20 test cases
```

## Where each OOP requirement lives

| Requirement | Where |
|---|---|
| Encapsulation | `Incident`: every field private, changed only via lifecycle methods; `PasswordHash`; `Technician` workload |
| Abstraction | `User` and `IncidentState` (abstract classes); `IncidentService` facade; `Repository<T>` |
| Inheritance (true is-a) | `Employee/Technician/Admin extends User`; 9 states extend `IncidentState`; 13 errors extend `ItsmError`; `SqliteRepository extends InMemoryRepository` |
| Polymorphism | `user.can()`, `state.close()`, `strategy.select()`, `channel.send()`, `categorizer.suggest()`, `repo.save()` |
| Interfaces | `PriorityStrategy`, `AssignmentStrategy`, `NotificationChannel`, `IncidentObserver`, `Repository<T>`, `Categorizer`, `Clock` |
| Composition | `Incident` owns its `IncidentNote`s; `IncidentService` composes its strategies; `EventBus` owns its observers |
| Association / aggregation | `Incident` → reporter, assignee, service; `Technician` aggregates its active incident IDs |
| Exception handling | `src/exceptions/errors.ts`; API error middleware; `EventBus` isolates a failing observer; Gemini falls back on any failure |
| Collections | `Set` for skills and workload (O(1), no duplicates), `Map` for identity maps and inboxes, 2-D array for the ITIL matrix |

## Design patterns (9)

| Pattern | Use |
|---|---|
| State | Incident lifecycle; illegal moves (e.g. NEW → CLOSED) throw `InvalidStateTransitionException` |
| Strategy | Priority (weighted score, ITIL matrix), assignment (skill, load, round-robin), categoriser (keyword, Gemini); swappable at runtime from Settings |
| Observer | `EventBus` → `AuditLogger`, `NotificationDispatcher`, `LiveChannel` |
| Factory | `AssignmentStrategyFactory`, `PriorityStrategyFactory`, `NotificationChannelFactory`, `IncidentState.of()` |
| Repository | `Repository<T>`, with in-memory (tests) and SQLite (app) implementations |
| Adapter | `GeminiDecisionCategorizer`, `GeminiCategorizer`, `ResendEmailAdapter` wrap third-party APIs behind our own interfaces |
| Facade | `IncidentService` hides the multi-step reporting pipeline |
| Memento | `Incident.toSnapshot()` / `Incident.restore()` for persistence without breaking encapsulation |
| Composition root / DI | `buildSystem()` wires every dependency in one place |

## Priority algorithm (default: weighted score)

`score = impact × urgency × service criticality` (each 1–4, so 1–64)
`≥ 36 → P1, ≥ 18 → P2, ≥ 6 → P3, else P4`, bumped up one level if 25% or more of the service's users are affected.
Alternative: the ITIL impact × urgency matrix, capped at P2 for low-criticality services.

## Intelligent features

1. Automatic categorisation: keyword matching, or the Gemini Decisions API (closed-set choice with a calibrated confidence) when a key is set
2. Duplicate and related incident detection: Jaccard similarity on title + description, plus a boost for the same service, within a 24-hour window
3. SLA risk detection: warning at 80% of the window, recorded breaches, automatic escalation Technician → Team lead → System admin → IT manager
4. Suggested resolutions: fixes from similar past incidents, shown to the technician with a one-click "use this fix"
5. Smart technician recommendation: skill match, then experience with this service, then years, then workload

## API summary

`POST /api/auth/register`, `POST /api/auth/login`, `GET /api/me`, `GET /api/meta`
`GET/POST /api/incidents`, `GET /api/incidents/:id`,
`POST /api/incidents/:id/{acknowledge,start,notes,request-info,provide-info,resolve,verify,reopen,close,feedback,assign}`
`GET /api/notifications`, `GET /api/events` (SSE)
`GET /api/reports/{overview,workload,by-service,by-category,by-priority,trend,sla-violations,audit}`
`GET/POST /api/admin/users`, `PATCH /api/admin/technicians/:id`, `POST/PATCH /api/admin/services`, `POST /api/admin/categories`,
`PUT /api/admin/sla/:priority`, `PUT /api/admin/strategies`, `POST /api/admin/sla-check`

## Demo tips (for the video)

- To show an SLA breach and escalation live: in Settings set P1 to respond within 1 minute and resolve within 2, report a P1 as an employee, wait 1–2 minutes (or press "Run SLA check now"), and watch it escalate.
- Open the employee and the technician in two browser windows (one of them private/incognito) to show live notifications.
