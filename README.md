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

Open `ORIGIN`, create your account and import your data from **Import data**. Database migrations run automatically when the app starts. Once your own account exists you can set `DISABLE_SIGNUP=true` and run `docker compose up -d` again to close registration.

### Deploying on a server

- Put HomeFit behind a reverse proxy that terminates HTTPS (Caddy, Traefik, nginx…) and set `ORIGIN` to the public `https://` URL. `ORIGIN` is read at runtime, so the same image works anywhere.
- The app is published on `127.0.0.1:3000` only, so a proxy on the same host can reach it and nothing else can. If your proxy runs in Docker instead, attach it to HomeFit's network and remove the `ports` mapping. To serve other machines without a proxy (for example on a home network), set `APP_BIND_ADDRESS=0.0.0.0`.
- Behind a proxy, also set `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1` (the number of trusted proxies) so sign-in throttling sees each client's real address instead of the proxy's. Only do this while the proxy is the sole way in; a client that reaches the app directly could forge the header.
- The database is only published on `127.0.0.1` for backups and local tooling. Back it up with `docker compose exec db pg_dump -U homefit homefit > homefit.sql`.
- To update: `git pull && docker compose up -d --build`.
- Every configuration option is listed with its purpose in [`.env.example`](.env.example) and validated at startup by [`src/env.ts`](src/env.ts).

The image runs as an unprivileged user, exposes port 3000 and has a health check on `/api/health`. To scale out, run extra replicas with `BACKGROUND_JOBS=false` and keep one worker; migrations are serialized with an advisory lock.

## Google Health (optional)

Leave the `GOOGLE_HEALTH_*` variables empty and the integration is disabled entirely: no routes, jobs or UI. To enable it you need a Google Cloud OAuth client with the Google Health API; follow [docs/google-health-setup.md](docs/google-health-setup.md).

## Local development

Requirements: [Bun](https://bun.com/) 1.4 or newer, plus Docker for the database.

```sh
bun install
cp .env.example .env            # set ORIGIN=http://localhost:5173 and fill in the secrets
docker compose up -d db         # PostgreSQL on localhost:5432
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
