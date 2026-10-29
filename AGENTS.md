You are able to use the Svelte MCP server, where you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available Svelte MCP Tools:

### 1. list-sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles, use_cases, and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get-documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list-sections tool, you MUST analyze the returned documentation sections (especially the use_cases field) and then use the get-documentation tool to fetch ALL documentation sections that are relevant for the user's task.

### 3. svelte-autofixer

Analyzes Svelte code and returns issues and suggestions.
You MUST use this tool whenever writing Svelte code before sending it to the user. Keep calling it until no issues or suggestions are returned.

### 4. playground-link

Generates a Svelte Playground link with the provided code.
After completing the code, ask the user if they want a playground link. Only call this tool after user confirmation and NEVER if code was written to files in their project.

## Project conventions

HomeFit is a self-hosted SvelteKit 3 app backed by PostgreSQL. Production runs on Bun via `@sveltejs/adapter-bun`; `bun run build` must run on Bun.

- Data access uses Drizzle ORM. The schema lives in `src/lib/server/db/schema.ts`; after changing it, run `bun run db:generate` and commit the new migration in `drizzle/`. Migrations are applied automatically at startup.
- Authentication uses Better Auth (`src/lib/server/auth.ts`). Its tables in `src/lib/server/db/auth.schema.ts` are generated with `bun run auth:schema`.
- Client code talks to the server through remote functions in `src/lib/remote/*.remote.ts`. Server modules take a Drizzle `Database` argument so they can be tested against PGlite (`src/lib/server/testing/database.ts`).
- Environment variables are declared and validated in `src/env.ts` and read through `$app/env/private`.
- Background work (Google Health sync, webhooks, maintenance) runs on pg-boss (`src/lib/server/jobs.ts`). Google Health is optional and fully disabled when its variables are unset.
- Before finishing, run `bun run check`, `bun run lint` and `bun run test:unit --run`.

## Local test stack

The real data lives in the Compose project `homefit` (`docker compose up`). That database listens only on the Compose network. Leave it alone: do not start it, do not use `compose.dev.yaml` or `bun run db:start`, and do not read or copy `.env`.

Use the disposable test stack:

```sh
docker compose -f compose.test.yaml up -d --build
```

- App: http://127.0.0.1:3300
- Database: `homefit_test` at `127.0.0.1:5434`, user `homefit`, password `homefittest`
- Create a new account there. Keep real Sleep Cycle, Hevy, and Google Health data out of it.

`docker compose -f compose.test.yaml down -v` deletes only that volume. The test process starts only when `POSTGRES_DB` is `homefit_test` and Google Health credentials are empty.
