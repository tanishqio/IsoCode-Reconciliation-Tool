# Deployment

## Status

The app is **not deployed**. It runs locally with Docker for the database. Section 3 lists what a hosted setup needs.

Repository: `<GitHub URL: add before submitting>`

## 1. Run it locally

Needs Node.js 20.19 or newer, npm, and Docker Desktop.

```
npm install
```

1. Copy `.env.example` to `.env` in the repository root. Set `POSTGRES_PASSWORD` (letters and digits only).
2. Start the database: `docker compose up -d db`. PostgreSQL 17 listens on `127.0.0.1:5433`. Data is kept in the Docker volume `leaklens-db-data`. Do not run `docker compose down -v`: it deletes the data.
3. Copy `apps/api/.env.example` to `apps/api/.env`. Set:
   - `DATABASE_URL` to `postgresql://leaklens:<POSTGRES_PASSWORD>@localhost:5433/leaklens`
   - `SEED_EXECUTIVE_EMAIL`, `SEED_EXECUTIVE_PASSWORD`, `SEED_COFOUNDER_EMAIL`, `SEED_COFOUNDER_PASSWORD` (passwords 12 to 72 characters)
4. Create the tables: in `apps/api` run `npx prisma migrate deploy`. Then in the root run `npm run db:generate`.
5. Create the sources, the two accounts and the sample rate cards: `npm run db:seed`
6. Start the API, the worker and the web app: `npm run dev`. Without the worker, uploaded files stay queued.
7. Open `http://localhost:5173`.
8. Load the demo data (optional, needs step 6 running): `npm run demo:load -w @leaklens/api`. It uploads the 16 files in `sample-data/demo`, approves their column mappings and runs the calculation.

If the API says it cannot connect, check that Docker Desktop is running and that no old `DATABASE_URL` environment variable in your terminal overrides `apps/api/.env`.

## 2. Demo login

There is no sign-up page. Two accounts are created by `npm run db:seed` from the `SEED_*` values.

| Role              | Email                      | Password                   | Sees                                                                                                              |
| ----------------- | -------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Finance executive | `<fill in before zipping>` | `<fill in before zipping>` | Uploads, mapping review, Orders, Review queue, Rate cards, Claims, Money at risk (Money at risk and TCS/TDS tabs) |
| Co-founder        | `<fill in before zipping>` | `<fill in before zipping>` | Orders, Rate cards, Claims, Money at risk with the extra Activity tab (audit trail)                               |

The real values are only in the git-ignored `apps/api/.env`. This file in the repository keeps placeholders. Put the real values into the copy that goes in the ZIP, and do not commit them.

After 5 wrong passwords an account locks for 15 minutes. `npm run db:seed:users -w @leaklens/api` resets a password and clears a lock.

## 3. Environment variables

Names only. Values are never stored in the repository.

Root `.env` (Docker Compose):

| Name                | Purpose                                  |
| ------------------- | ---------------------------------------- |
| `POSTGRES_PASSWORD` | Password of the database user `leaklens` |

`apps/api/.env`:

| Name                                                                                                          | Required    | Purpose                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                                                                | yes         | PostgreSQL connection string                                                                            |
| `NODE_ENV`, `PORT`, `LOG_LEVEL`                                                                               | no          | Environment, API port (default 4000), log level                                                         |
| `SEED_EXECUTIVE_EMAIL`, `SEED_EXECUTIVE_PASSWORD`, `SEED_EXECUTIVE_NAME`                                      | for seeding | Finance executive account                                                                               |
| `SEED_COFOUNDER_EMAIL`, `SEED_COFOUNDER_PASSWORD`, `SEED_COFOUNDER_NAME`                                      | for seeding | Co-founder account                                                                                      |
| `SESSION_TTL_HOURS`, `LOGIN_MAX_FAILED_ATTEMPTS`, `LOGIN_LOCK_MINUTES`, `LOGIN_RATE_LIMIT_MAX`, `BCRYPT_COST` | no          | Sign-in settings                                                                                        |
| `API_RATE_LIMIT_PER_MINUTE`                                                                                   | no          | General limit per IP address (default 600)                                                              |
| `UPLOAD_DIR`, `UPLOAD_TEMP_DIR`, `MAX_UPLOAD_FILE_BYTES`, `MAX_UPLOAD_FILES`                                  | no          | Upload storage and limits                                                                               |
| `WORKER_POLL_INTERVAL_MS`, `WORKER_HEARTBEAT_INTERVAL_MS`, `WORKER_STALE_AFTER_MS`                            | no          | Background worker timing                                                                                |
| `AI_PROVIDER`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_TIMEOUT_MS`                                       | no          | Optional AI column-mapping suggestions. Without them the app uses fixed rules and says so on the screen |

`apps/web`: `API_PROXY_TARGET` (optional, development only) points the dev server at an API on another address.

## 4. What a hosted setup needs

This is a plan, not something that has been done.

- Two Node processes from the same code: the API (`npm run start -w @leaklens/api`) and the worker (`npm run worker`). They talk through the database only.
- A PostgreSQL 17 database, and `npx prisma migrate deploy` at each release.
- A writable disk for `UPLOAD_DIR`, or a change to object storage (not built).
- The web app built with `npm run build` and served as static files, with `/api` routed to the API on the same origin (the session cookie is same-site).
- The Linux build of `nodejs-polars` at the version in `package-lock.json`. Only Windows has been tested.
- `NODE_ENV=production` so the session cookie is marked secure.
- The 100,000-row timings in `README.md` were measured on one Windows laptop with the database on the same computer. They are not a promise for a hosted machine.

## 5. Checks you can run

```
npm test
npm run typecheck
npm run lint
npm run test:integration
npm run scan:secrets -w @leaklens/api
```

`npm run test:integration` needs the Docker database. It uses its own `leaklens_test` database, never the working one.
