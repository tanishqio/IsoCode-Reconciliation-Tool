# LeakLens

LeakLens reconciles a direct-to-consumer brand's orders against what channels, courier aggregators and the warehouse actually reported: settlements, COD remittances, freight invoices and return scans. It shows where money is missing and what is at risk.

This is a hiring-assignment project (Option 2). The assignment text is in `docs/assignment.md`.

## Contents

- [What is in the app](#what-is-in-the-app)
- [Requirements](#requirements)
- [Run it locally](#run-it-locally)
- [Load the sample data](#load-the-sample-data)
- [Tests and checks](#tests-and-checks)
- [Benchmark](#benchmark)
- [Security and privacy](#security-and-privacy)
- [Repository layout](#repository-layout)
- [Assumptions and limits](#assumptions-and-limits)

## What is in the app

Two accounts exist, a finance executive and a co-founder. There is no sign-up.

| Area           | What it does                                                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Uploads        | CSV, XLS and XLSX files, up to 5 per upload, exact duplicate files refused by SHA-256.                                                                                                                        |
| Mapping        | A new file layout is mapped to standard columns, with an optional AI suggestion that a person approves. Without an AI key the app uses fixed name rules and says so.                                          |
| Ingestion      | A background worker reads files into typed tables and keeps rejected rows with the reason.                                                                                                                    |
| Rate cards     | Fee rules per channel and courier, with versions.                                                                                                                                                             |
| Reconciliation | Orders are matched to their payment, COD, freight and return lines by order ID or AWB. The expected amount is computed by rules, never by AI. Each order gets a status and a difference (a loss is negative). |
| Money at risk  | Dashboard tab: cash at risk and value of returns not received, by partner, discrepancy type and age.                                                                                                          |
| TCS and TDS    | Dashboard tab: tax collected and deducted per month and channel, from settlement lines.                                                                                                                       |
| Activity       | Dashboard tab for the co-founder: who did what (sign-in, uploads, approvals, exports).                                                                                                                        |

Matching and expected amounts are rules. AI only proposes column mappings and candidate matches for missing IDs, and a person decides.

## Requirements

- Node.js 20.19 or newer
- Docker Desktop (for PostgreSQL 17)
- npm 10 or newer

## Run it locally

All commands run from the repository root. `deployment.md` has the same steps with the full list of environment variable names.

1. Install packages: `npm install`
2. Create the root `.env` from `.env.example` and set `POSTGRES_PASSWORD` (letters and digits only).
3. Start the database: `docker compose up -d db`. It listens on `127.0.0.1:5433`.
4. Create `apps/api/.env` from `apps/api/.env.example`. Set `DATABASE_URL` to `postgresql://leaklens:<POSTGRES_PASSWORD>@localhost:5433/leaklens` and choose the `SEED_*` emails and passwords (12 to 72 characters).
5. Create the tables and the database client: in `apps/api` run `npx prisma migrate deploy`, then from the root run `npm run db:generate`.
6. Create the sources, the two accounts and the sample rate cards: `npm run db:seed`
7. Start everything: `npm run dev`. This starts the API (port 4000), the background worker and the web app (port 5173). Without the worker, uploaded files stay queued.
8. Open `http://localhost:5173` and sign in with a `SEED_*` account.

Never run `docker compose down -v`: it deletes the database volume.

## Load the sample data

`sample-data/demo` holds 400 synthetic orders across the website, three marketplaces and two quick-commerce channels, with the matching settlement, COD, freight and return files. It includes the three sample rows from the assignment exactly. It contains no real customers or partners.

With the stack running (`npm run dev`):

```
npm run demo:load -w @leaklens/api
```

The script signs in as the executive from `apps/api/.env`, uploads the 16 files, approves the column mappings, waits for the worker and triggers the calculation. Running it twice is safe: files already there are reported as duplicates. Then open **Money at risk** (`/dashboard`).

To make a different dataset: `npm run sample:generate -w @leaklens/api -- --orders 1000 --seed 7 --out ../../.bench-data/orders-1000`. The same seed gives the same files. `truth.json` in the output lists what every order should end up as; the tests compare the engine with it.

## Tests and checks

| Command                                 | What it runs                                                 | Needs                                                  |
| --------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| `npm test`                              | Unit tests for the API, the web app and the shared package   | nothing                                                |
| `npm run test:integration`              | API tests against a real PostgreSQL                          | Docker database; uses its own `leaklens_test` database |
| `npm run test:docker`                   | Tests that start throwaway containers                        | Docker, opt-in                                         |
| `npm run typecheck`                     | TypeScript for all packages                                  | nothing                                                |
| `npm run lint`                          | ESLint                                                       | nothing                                                |
| `npm run format:check`                  | Prettier                                                     | nothing                                                |
| `npm run scan:secrets -w @leaklens/api` | Looks for keys, passwords and personal data in tracked files | nothing                                                |

Run the integration tests from one terminal at a time. Two runs at once share `leaklens_test` and delete each other's users.

Integration tests for the dashboard, audit trail, access control, privacy and the whole sample-data flow are in `apps/api/tests/integration/part11`, `part12` and `part13`. The access-control test lists every API route with the roles that may call it; add a new route to that list.

## Benchmark

`npm run bench:full -w @leaklens/api -- --orders 100000 --runs 3` generates the files, uploads them the way the app does, runs the worker, runs the matching three times and checks every order against the generated truth. It writes `result.json` next to the generated files in `.bench-data/`. Run it against a database whose name contains `test`.

One run on the developer's machine (Windows 11, i5-12450H, 12 logical cores, 15.7 GB RAM, Node 20.19.2, PostgreSQL 17 in Docker on the same computer, other programs open):

| Step                                       | 100,000 orders (222,866 rows, 16 files, 14.7 MB)  |
| ------------------------------------------ | ------------------------------------------------- |
| Read all files into the tables             | 57.8 s                                            |
| Match and calculate (3 runs)               | 31.7 s, 37.5 s, 25.4 s (median 31.7 s)            |
| Orders checked against the generated truth | 100,000, status mismatches 0, amount mismatches 0 |
| Peak memory of the process                 | 956 MB                                            |

An earlier run with 10,000 orders took 4.8 to 5.0 s to match and calculate.

What this does and does not show:

- The assignment's one-minute target is not defined in the text (one file of 100,000 rows, or 100,000 orders over several files, and whether reading counts). Matching and calculation alone took about 25 to 37 s. Reading plus matching took about 90 s. So the one-minute target is met for matching only, on this machine.
- The numbers vary between runs, mostly with what else the computer is doing.
- Staging tables are analysed before linking (see `docs/decisions.md`, T44). Before that change, a recompute on 100,000 orders was stopped after more than 10 minutes on a stale query plan.
- Not measured: a single file of 100,000 rows over a slow disk, a hosted database, more than one worker.

## Security and privacy

- Sign-in: bcrypt, an HTTP-only session cookie, a CSRF header on writes, a lock after 5 wrong passwords, a limit on sign-in attempts per address, and a general limit of 600 API requests per minute per address (`API_RATE_LIMIT_PER_MINUTE`).
- Roles are enforced in the API, not only in the screens. The audit trail (`GET /api/audit`) is for the co-founder only.
- Audit trail: the `audit_logs` table records sign-in, failed sign-in (no email stored), sign-out, uploads, blocked duplicates, mapping approvals, rejections and rollbacks, rate card changes, recalculations, accepted and rejected matches, claim exports and claim status changes. The application never updates or deletes audit rows. Details hold ids and counts, no personal data.
- Customer name, phone and address are not ingested and never sent to an AI service.
- Money is stored as exact decimals in rupees and sent as text such as `"1499.00"`.
- `npm run scan:secrets -w @leaklens/api` is part of the checks. `.env` files are git-ignored.

## Repository layout

```
apps/api            Express API, background worker, Prisma schema and migrations, tests, scripts
apps/web            React, Vite and Tailwind web app
packages/shared     Types and helpers used by both
sample-data/demo    Synthetic demo files, manifest.json and truth.json
docs/               Assignment, analysis, decisions, progress, diagrams (not published)
deployment.md       Local run steps and environment variable names
```

## Assumptions and limits

Every assumption is labelled in the app and in `docs/decisions.md`. The ones that change numbers on the dashboard:

- Age bands are 0 to 30, 31 to 60, 61 to 90 and over 90 days. Age counts from the due date, or the delivery date, or the order date, to the newest date in the data.
- Cash at risk counts short-paid and unpaid orders and freight overcharges. Returns not received are valued at the order's selling price and shown apart from cash at risk.
- The sample TCS and TDS rates (1% and 0.1%) are illustrative, not tax advice. The assignment gives no rates.
- The project is not deployed. See `deployment.md`.
