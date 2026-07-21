# CLAUDE.md

This file provides guidance to Claude Code when working on the Aptron project.

---

# Project Overview

Aptron is a long-term Personal Operating System.

The goal is not simply to build several utilities, but to build an integrated
ecosystem where every module can eventually communicate through a shared AI layer.

Current modules include:

- Goals & Calendar
- Gym
- Wardrobe
- Health

Future modules may include:

- Tasks
- Notes
- Finance
- Projects
- Knowledge
- Reading
- Learning
- AI Assistant
- Habits

The project is designed to evolve for years.

Always optimize for long-term maintainability.

---

# Workspace

This project is part of a multi-folder workspace.

```
Workspace
│
├── Aptron
│     Source code
│
└── Aptron Brain
      Knowledge base
```

The repository contains the implementation.

The Brain contains the project's memory.

Whenever both folders are available, consider the Brain the primary source of
architectural truth.

---

# Development Principles

Always prioritize:

1. Simplicity
2. Maintainability
3. Readability
4. Offline-first behavior
5. Documentation
6. Future extensibility

Never optimize prematurely.

Prefer boring, understandable solutions over clever ones.

Every feature should make the project easier to evolve.

---

# Current Stack

Frontend

- Vanilla JavaScript
- HTML
- CSS

No:

- Framework
- Build step
- Bundler
- Transpiler

Backend

- Supabase
- Express proxy
- Google Calendar API

Deployment

- Vercel
- Render

---

# Running Locally

Frontend

Serve the repository using a local static server.

Examples:

```
npx serve .
```

or

VSCode Live Server

Do NOT use file:// URLs.

---

Proxy

```
cd proxy

npm run dev
```

or

```
npm start
```

Google OAuth setup

```
npm run auth
```

Paste the refresh token inside

```
proxy/.env
```

---

# Architecture

## Offline First

The UI must always work without waiting for the network.

localStorage is always the first source.

Supabase synchronizes asynchronously.

---

## Sync Systems

There are intentionally THREE synchronization systems.

Never merge them.

### 1. app_state blob (sync.js)

Stores complete application state as JSONB, one row per app.

Used by

- Goals
- Wardrobe
- Health

Synchronization:

localStorage ⇄ Supabase app_state

Conflict strategy: last write wins (with per-key mergeRemote exceptions).

Poll-based today (realtime is subscribed but currently inactive — the tables
are not in the realtime publication, so the 5s poll carries it).

Per-user isolation is enforced by RLS (auth.uid() = user_id), restored by
migration 0006 / ADR-013.

A second blob implementation (js/gym/gym-sync.js) follows the same pattern for
the 'po-coach' key — deliberately separate, not to be merged.

---

### 2. Normalized Gym Storage (js/gym/gym-cloud.js)

Uses

- routines
- exercise_logs

These tables intentionally coexist with app_state.

Do not replace them.

Future migrations will continue normalizing gym data.

---

### 3. Calendar events (js/index.js ⇄ events; proxy ↔ Google)

Supabase `events` is the source of truth; Google Calendar is an optional
per-user mirror driven by the proxy (push-then-pull, local-wins).

---

# Authentication

Authentication uses

Supabase Auth + RLS.

The authenticated client is

```
window.APP_SUPABASE
```

Never create another client.

Always wait for

```
window.APP_AUTH_READY
```

before accessing Supabase.

Anonymous keys never bypass RLS.

---

## Proxy

Every request must use

```
authedFetch()
```

or send

Authorization Bearer JWT

The proxy rejects unauthenticated requests.

---

# Large Files

Current large modules

- js/gym/ (gym-cloud.js, gym-sync.js, and the Coach UI)
- wardrobe.js
- health.js
- index.js
- account.js

When modifying them:

- avoid increasing complexity
- extract reusable logic when appropriate
- prefer composition over giant functions

---

# Generated Files

```
js/exercises-data.json
```

is generated.

Never edit it manually.

Edit the generator instead.

---

# Environment

Frontend

The browser's public Supabase config (URL + publishable/anon key) lives in
`js/config.js`, committed. There is **no build step and no consumed root `.env`**
— access is gated by RLS, not by hiding these public values. (A leftover
`.env.example` at the repo root is not consumed by anything; see Known Issues.)

Proxy

```
proxy/.env
```

contains

- Google OAuth credentials
- Calendar configuration
- Supabase validation settings (SUPABASE_URL, SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY, TOKEN_ENC_KEY)

Remains gitignored.

---

# Git Workflow

Development branch

```
test
```

Production

```
main
```

Never push directly to main unless explicitly instructed.

---

# Aptron Brain

Whenever Aptron Brain is available:

Read it before implementing medium or large features.

The Brain contains

- Vision
- Roadmap
- Architecture
- Database
- ADRs
- Research
- AI Design
- Development Journal
- Known Problems
- Ideas

Treat these documents as the project's long-term memory.

---

# Documentation Rules

Documentation is part of every implementation — not a follow-up task.

**Every code change ends with a documentation pass, automatically, without
being asked.** A change is not done until the Brain reflects it.

The operational spec — exactly which Brain documents each kind of change must
update — is the Brain's own protocol file:

```
aptron Brain/00 Home/Maintenance Protocol.md
```

Follow it. In short:

- update the affected Feature, Architecture, Database, Sync and AI notes
- update the Roadmap (move items; never invent them)
- update Known Issues when bugs are found, fixed, or follow-ups created
- refresh each touched note's "Last verified" stamp (date · branch @ commit)
- add a Development Journal entry per significant session

If an architectural decision changes — structure, database, synchronization,
authentication, AI, storage, module communication, deployment —

**automatically create a new ADR** (professional format; supersede, never
delete, the old one).

---

# ADR Policy

Architectural Decision Records are required whenever a decision changes:

- project structure
- database
- synchronization
- authentication
- AI
- storage
- module communication

Small bug fixes do not require ADRs.

---

# Decision Process

Before implementing:

1. Understand the problem.
2. Read relevant Brain documentation.
3. Search existing implementation.
4. Reuse existing patterns.
5. For medium/large features: present the Architecture Review (below), BEFORE writing code.
6. Implement.
7. Update documentation.
8. Suggest an ADR if needed.
9. Run the post-task architectural review (below).

# Pre-Implementation Architecture Review

Mandatory before any medium or large feature (spans modules, or adds/alters a
table, localStorage key, window global, proxy route, prompt, sync behavior, or
dependency). Present answers to the owner BEFORE implementing:

- Is this consistent with the current architecture?
- Can an existing system be extended instead of creating a new one?
- Will this increase technical debt?
- Does the database need to evolve?
- Should an ADR be created?
- Which Brain documents will require updating?

After implementation, verify every document named in the last answer was
actually updated. Full spec:

```
aptron Brain/00 Home/Maintenance Protocol.md  →  "Pre-implementation architecture review"
```

# Post-Task Architectural Review

At the end of every completed task, before calling it done, answer:

- Did this change improve the project?
- Is the documentation still accurate?
- Did I introduce technical debt?
- Can this implementation be simplified?
- Should any Brain document be updated?

Any "yes" that implies documentation work is resolved **before** the task is
considered complete. New technical debt is recorded (Known Issues / Roadmap),
never silently carried. Cheap simplifications happen now; costly ones are
recorded as candidates. Full spec:

```
aptron Brain/00 Home/Maintenance Protocol.md  →  "Post-task architectural review"
```

---

# Coding Style

Prefer

- readable code
- small functions
- explicit naming
- predictable behavior

Avoid

- unnecessary abstractions
- duplicated logic
- magic values
- undocumented architectural changes

---

# Long-Term Vision

Aptron is evolving into a Personal Operating System.

Every new module should be designed assuming it may eventually communicate with:

- AI
- Calendar
- Notes
- Tasks
- Health
- Gym
- Wardrobe
- Future modules

Design APIs and data structures with interoperability in mind.

Never optimize only for the current feature.

Optimize for the project that Aptron will become.