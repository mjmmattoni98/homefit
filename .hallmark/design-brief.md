# HomeFit: Day and Night (design brief for every screen)

The user rejected the previous redesign because it looked like the original: same icon rail, same
stat tiles, same cards. This system is new. Every screen must read as part of it, and none may fall
back to a generic shadcn dashboard (cards in a grid, icon tiles, pill badges, soft shadows).

## The idea

The day's training sits above a horizon line, the night's sleep hangs below it. Two grounds:

- **Day**: a clear, cool light ground (`bg-day`, raised or hover `bg-day-2`, `bg-day-3`). Training,
  forms, tables and most content live here. Text `text-ink` / `text-ink-2` / `text-ink-3` (secondary).
  Rules `border-rule` (hairline) and `border-rule-2` (stronger); `border-ink` for the one heavy rule
  that opens a table.
- **Night**: a deep indigo field (`bg-night`, raised or hover `bg-night-2`, rules `border-night-rule` /
  `divide-night-rule`). Anything about sleep or the nights sits on it. Text on night is
  `text-moon` (primary) and `text-moon-2` (secondary). Never put ink or grey text on night.
- **Sun** (`bg-sun`, `text-sun`, `fill-sun`, `stroke-sun`, `decoration-sun`) is the one signal:
  the training series on charts, the current tab or nav item (an inset 2px underline:
  `shadow-[inset_0_-2px_0_var(--color-sun)]`), the hover underline on links
  (`hover:underline hover:decoration-sun`). Never a fill for buttons or large areas, never text.
- **Sleep series** on the night field: `bg-sleep` / `fill-sleep` (full), `bg-sleep-dim` (weaker),
  `bg-moon` (strongest). On the day ground the sleep colour is too pale: put sleep marks on a night
  panel instead.
- `text-error`, `text-success` exist for form feedback only.

Reference: the overview, `src/routes/dashboard/+page.svelte` and `src/lib/components/dashboard/`
(`SleepTrainingChart.svelte`, `KpiStrip.svelte`, `WorkoutNights.svelte`, `SleepFactors.svelte`).
Screenshot: `/tmp/hallmark-shots/o1.png` (light), `/tmp/hallmark-shots/o-dark.png` (dark),
`/tmp/hallmark-shots/o-375.png` (phone). Read them before you start.

## Type

One family, Archivo, with a width axis.

- `h1`, `h2`, `h3` get the condensed head cut automatically (base.css). Sizes: page `h1` is
  `text-4xl`, section `h2` is `text-2xl`, sub-heads `text-lg` or `text-xl`. One weight, one colour.
- Big figures use `font-figure` (narrower, heavier, tabular) at `text-4xl sm:text-5xl` for a
  screen's lead figures, `text-xl` / `text-2xl` inside rows. Use `Measure`
  (`src/lib/components/Measure.svelte`) for a value with a unit so the unit is smaller and
  secondary.
- Body is `text-base`; labels, captions, table heads and meta are `text-sm text-ink-3` (or
  `text-moon-2` on night). Sentence case, never uppercase, never tracked, never mono.
- Tabular numerals are on by default for the whole body.

## Layout

- The dashboard layout's `<main>` is a `page-grid`: every direct child sits in a capped, centred
  content column. A child with class `bleed` spans the full window width and its own children
  return to the content column (subgrid). Use `bleed` for any night band that should run edge to
  edge; nest `bleed` inside `bleed` when needed.
- Page header pattern (copy it from the overview): a block with `border-b border-rule pt-7 pb-3`,
  the `h1` at `text-4xl`, its description `mt-1.5 text-sm text-ink-3`, actions or tabs on the
  right at `sm:` and up. Sticky only when it holds controls that drive the whole page.
- Sections are separated by space (`mt-14` to `mt-16`) and rules, not boxes.
- **Tables before cards.** A list of records is a ledger: an opening `border-t border-ink`, a head
  row in `text-sm text-ink-3`, rows split by `border-t border-rule`, no outer border, no zebra.
  Whole-row links or buttons get `group` and the primary cell underlines in sun on hover.
- A **night panel** (`bg-night text-moon px-5 py-6 sm:px-7`) is the one allowed container, and only
  for sleep-related content or for one deliberate dark element per screen. No rounded corners on
  bands and panels.
- Cards: the shadcn `Card` is now a plain bordered plate. Use it only where a form needs a
  boundary. Never a card inside a card, never a grid of identical cards.
- Corners: `rounded-(--radius-control)` (4px) on controls only.

## Controls (already restyled, use them as they are)

- `Button`: `default` is the night fill (the one primary action per screen), `outline` a plain
  edge, `ghost`, `link`, `destructive`. Sizes `sm` (32px), `default` (36px), `lg` (40px).
- Tabs or segmented choices: `ToggleGroup` with `variant="outline"` renders text tabs on a rule
  with the chosen one underlined in sun. Link-based tabs copy that look by hand.
- `Input`, `Label`, `Sheet`, `Dialog`, `AlertDialog`, `DropdownMenu`, `Empty`, `Skeleton`,
  `Table` are token-driven and fine as they are.
- Do not edit `src/lib/components/ui/**`, `src/routes/tokens.css`, `src/routes/base.css`,
  `src/routes/layout.css` or the overview components. If a primitive needs a change, say so in
  your report instead.

## Charts

Inline SVG or layerchart as the screen already does. Training series in `var(--color-sun)` on the
day ground; sleep series in `var(--color-sleep)` on a night panel. Gridlines `stroke-rule`, 3 to 5,
solid, never dashed; tick text `fill-ink-3 text-xs` (`fill-moon-2` on night). Bars start at zero,
22px thick at most, square ends. One y-axis per chart. Apply colours with `style:fill` /
`style:stroke` or classes, never SVG presentation attributes with literal colours.
`CHART_COLORS` in `src/lib/charts.ts` already points at the new tokens.

## Hallmark floor (non-negotiable)

- Colours and fonts only through the tokens above. No literal colours, no Tailwind palette colours
  (`text-green-600`, `bg-white`, `text-black`), no `font-mono`.
- Never `transition-all`; transitions on `colors` or `opacity` with `duration-(--dur-micro)`.
- Every interactive element keeps a visible `:focus-visible` (base.css gives an outline; do not
  remove it with `outline-none` unless you add `focus-visible:outline-*` back).
- No eyebrows or small labels above headings, no uppercase or tracked labels, no middle-dot
  (`·`) joined strings, no arrows glued to link text, no decorative status dots, no emoji, no
  icon tiles beside stats, no gradients.
- Heading levels step one at a time. Every data region keeps its loading, empty and error states.

## Wiring is sacred

Keep every link and `href`, form, `action`, field `name`, `id`, handler, remote function call,
`data-testid`, prop name and test-visible text. Rewrite markup and classes inside the component
that owns them. Do not move logic, rename props, change messages, or edit any `*.spec.ts`. Run
the specs that cover your files with `bun run test:unit --run <path>` and keep them green.

## Svelte

Use the Svelte MCP `svelte-autofixer` on every `.svelte` file you change, until it reports no
issues. Runes only.

## Preview (never start a server)

A preview is already running from a copy of the project with no `.env` files, against a
throwaway database with demo data. Never run `bun run dev`, `vite` or any server in the repo:
the repo's `.env` points at the user's real database.

1. Sync your edits to the copy:
   `rsync -a --exclude '.env' --exclude '.env.*' --exclude node_modules --exclude .git --exclude build --exclude .svelte-kit --exclude .hallmark --exclude package.json --exclude bun.lock /home/mjmmattoni/Development/Personal/homefit/ $HOME/.cache/homefit-hallmark-preview/`
2. Screenshot (signed in through a proxy on 127.0.0.1:5198):
   `cd /tmp/hallmark-pptr && CHROME_PATH=$HOME/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome node shot.mjs <url> <out.png> <width> <height> <light|dark> [full]`
   for example `node shot.mjs http://127.0.0.1:5198/dashboard/exercises /tmp/hallmark-shots/ex.png 1440 900 light full`.
   Check 1440 light, 1440 dark and 375 light. Look at every screenshot you take.
