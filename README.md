# HomeFit

A self-hosted dashboard for your sleep, training and health data. Import your Sleep Cycle and Hevy exports, optionally connect Google Health, and see how rest and workouts affect each other. Everything runs on your own server: one Bun app and one PostgreSQL database.

- **Sleep** — quality, time in bed, regularity and notes from Sleep Cycle CSV exports.
- **Training** — volume, sets and per-exercise progression from Hevy CSV exports.
- **Correlations** — sleep quality on training days versus rest days, and the effect of each sleep note.
- **Google Health (optional)** — automatic, read-only import of every supported metric, kept current by webhooks and a daily reconciliation.
- English and Spanish.

## Stack

[SvelteKit 3](https://svelte.dev/docs/kit) with remote functions · [Bun](https://bun.com/) · [PostgreSQL 18](https://www.postgresql.org/) · [Drizzle ORM](https://orm.drizzle.team/) · [Better Auth](https://www.better-auth.com/) (email and password) · [pg-boss](https://github.com/timgit/pg-boss) for background jobs · [shadcn-svelte](https://shadcn-svelte.com/) and Tailwind CSS · [Paraglide](https://inlang.com/m/gerre34r/library-inlang-paraglideJs) for translations.

## Run it with Docker

Requirements: Docker with Compose v2.

```sh
git clone <this repository> homefit && cd homefit
cp .env.example .env
```

Edit `.env` and set at least:

| Variable             | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| `ORIGIN`             | The URL you will open HomeFit at, e.g. `http://localhost:3000`. |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32`                                       |
| `POSTGRES_PASSWORD`  | `openssl rand -hex 24` (letters and digits only)                |

Then start it:

```sh
docker compose up -d --build
```

Open `ORIGIN`, create your account and import your data from **Import data**. Database migrations run automatically when the app starts. Registration defaults to `SIGNUP_MODE=first-user`: it closes as soon as any account exists, with concurrent first registrations serialized in PostgreSQL. Use `open` to allow additional accounts or `closed` to disallow registration. The deprecated `DISABLE_SIGNUP=true` still overrides the mode to closed. Removing the last account reopens first-user registration.

### Deploying on a server

- Put HomeFit behind a reverse proxy that terminates HTTPS (Caddy, Traefik, nginx…) and set `ORIGIN` to the public `https://` URL. `ORIGIN` is read at runtime, so the same image works anywhere.
- The app is published on `127.0.0.1:3000` only, so a proxy on the same host can reach it and nothing else can. If your proxy runs in Docker instead, attach it to HomeFit's network and remove the `ports` mapping. To serve other machines without a proxy (for example on a home network), set `APP_BIND_ADDRESS=0.0.0.0`.
- Behind a proxy, also set `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1` (the number of trusted proxies) so sign-in throttling sees each client's real address instead of the proxy's. Only do this while the proxy is the sole way in; a client that reaches the app directly could forge the header.
- The database listens only on the Compose network. Back it up with `docker compose exec db pg_dump -U homefit homefit > homefit.sql`. `bun run db:start` publishes it on `127.0.0.1` for tools on this machine.
- To update: `git pull && docker compose up -d --build`.
- Every configuration option is listed with its purpose in [`.env.example`](.env.example) and validated at startup by [`src/env.ts`](src/env.ts).

The image runs as an unprivileged user, exposes port 3000 and has a health check on `/api/health`. To scale out, run extra replicas with `BACKGROUND_JOBS=false` and keep one worker; migrations are serialized with an advisory lock.

### Test stack

A second Compose project for disposable use, including by coding agents. It has its own volume, password, and network, and it does not read `.env`.

```sh
docker compose -f compose.test.yaml up -d --build
```

Open http://127.0.0.1:3300 and create an account. The database is `homefit_test` on `127.0.0.1:5434` (user `homefit`, password `homefittest`). Google Health stays off. The process only starts when `POSTGRES_DB` is `homefit_test` and every Google Health credential is empty, so this stack cannot open your real database or sync your real health data.

`docker compose -f compose.test.yaml down -v` deletes the disposable volume. The main stack is left as it is.

### Published images and Tailscale

CI publishes `linux/amd64` and `linux/arm64` images to GHCR. To use the published main image, set `HOMEFIT_IMAGE=ghcr.io/mjmmattoni98/homefit:main` in `.env`, then:

```sh
docker compose pull app
docker compose up -d --no-build
```

Pin a version or SHA tag for reproducible deployments. Leaving `HOMEFIT_IMAGE` unset preserves local builds (`homefit:latest`).

For Tailscale Serve, set `TAILSCALE_ORIGIN` to your own HTTPS origin (including any nonstandard port) and optionally `TAILSCALE_APP_PORT` (default 3080). Configure Serve to proxy that loopback port, then run `docker compose -f compose.yaml -f compose.tailscale.yaml up -d`. No tailnet hostname is built into the repository.

### Scheduled backups and restore

Enable with `docker compose --profile backup up -d`. The backup service takes a compressed PostgreSQL custom-format dump immediately and every `BACKUP_INTERVAL_SECONDS` (default 86400), keeping the newest `BACKUP_KEEP` dumps (default 14) in `BACKUP_DIRECTORY` (default `./backups`). The bind directory must be writable by the container. Dumps are created with owner-only permissions; use the backup container to read them. Backups contain private health data; restrict access and copy them off the host. A failed dump exits non-zero and never publishes a completed `.dump` file; temporary files are ignored and cleaned on exit. Container failures are visible in `docker compose logs backup`.

Restore into a separate empty database first, using the same PostgreSQL major version. For default database/role names:

```sh
# Replace the filename with one completed .dump file.
docker compose exec db createdb -U homefit homefit_restore
docker compose --profile backup run --rm --no-deps --entrypoint pg_restore backup --host=db --username=homefit --dbname=homefit_restore --exit-on-error --no-owner /backups/homefit-TIMESTAMP-ID.dump
docker compose exec db psql -U homefit -d homefit_restore -c 'SELECT count(*) FROM "user";'
```

Check accounts and representative records in the restored database. To recover the deployment, stop the app and backup services, retain the current database as a rollback, then point `POSTGRES_DB` at the verified restored database and recreate the services. Never restore over a running app's database. The same dump/restore path is exercised with synthetic data against the disposable stack by `scripts/test-backup.sh`.

### CSV corrections and time zones

Export files carry local times without a time zone. The first file you select saves your browser's time zone for the account, and every later import reads times in that zone, whichever browser you use. You can change it on the import page; delete the imported CSV data first, because records imported earlier keep their old times and would otherwise be added a second time.

Importing an export again is safe: unchanged records are skipped and edited ones are updated. Hevy exports have no workout ID, so a workout is recognised by its start time and title. A renamed workout is still matched when the full export shows that exactly one stored title disappeared and one new title appeared at that start time. If several sessions at the same start time cannot be told apart, the import stops and asks you to delete the imported Hevy data and import the full export again. That is also how to remove duplicates left by renames made before this version.

## Google Health (optional)

Leave the `GOOGLE_HEALTH_*` variables empty and the integration is disabled entirely: no routes, jobs or UI. To enable it you need a Google Cloud OAuth client with the Google Health API; follow [docs/google-health-setup.md](docs/google-health-setup.md).

## Local development

Requirements: [Bun](https://bun.com/) 1.4 or newer, plus Docker for the database.

```sh
bun install
cp .env.example .env            # set ORIGIN=http://localhost:5173 and fill in the secrets
bun run db:start                # PostgreSQL on 127.0.0.1:5432
bun run dev
```

The app builds its PostgreSQL connection string from `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`, and connects to `localhost` on `POSTGRES_PORT` (default `5432`).

| Command                           | Purpose                                                         |
| --------------------------------- | --------------------------------------------------------------- |
| `bun run dev`                     | Development server with hot reload                              |
| `bun run build && bun start`      | Production build, then the Bun server (`server.js`)             |
| `bun run check`                   | Type-check Svelte and TypeScript                                |
| `bun run lint` / `bun run format` | Prettier and ESLint                                             |
| `bun run test:unit`               | Unit, PGlite integration and browser component tests            |
| `bun run db:generate`             | Create a migration after changing `src/lib/server/db/schema.ts` |
| `bun run db:studio`               | Browse the database with Drizzle Studio                         |
| `bun run auth:schema`             | Regenerate the Better Auth tables after changing auth options   |

Server tests run against an in-process PostgreSQL ([PGlite](https://pglite.dev/)), so no database is needed to run them. Component tests run in Chromium through Playwright (`bunx --bun playwright install chromium` once).

### End-to-end tests

`bun run test:e2e` rebuilds and starts only `compose.test.yaml`, runs Chromium smoke tests with synthetic accounts and CSVs in both themes, then the backup and restore test (`scripts/test-backup.sh`), and removes the disposable stack and volume afterwards. Install Chromium once with `bunx --bun playwright install --with-deps chromium`. `bun run test` runs unit tests and this suite.

### Project layout

```
src/
  env.ts                    Environment variables and validation
  hooks.server.ts           Auth, locale, migrations and background jobs on startup
  lib/remote/               Remote functions called from components
  lib/server/db/            Drizzle schema, client and migration runner
  lib/server/google-health/ Optional Google Health integration
  lib/server/jobs.ts        pg-boss queues and schedules
  routes/                   Pages, auth forms and API endpoints
drizzle/                    SQL migrations (committed)
server.js                   Production entry point (Bun)
```

## License

[MIT](LICENSE)
