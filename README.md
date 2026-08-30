# Clutchly CS2

A premium, fully-functional CS2 match tracking platform — a modern alternative to
[cstracker.gg](https://cstracker.gg). Global search, deep player profiles, a chat
archive with round-tagged messages, teammates/queues analysis, full match
scoreboards, per-round economy + timeline, and inferred server locations.

Built with **Next.js 14 (App Router) · strict TypeScript · TailwindCSS · Framer
Motion · PostgreSQL + Prisma · Redis + BullMQ · demofile** for parsing.

> This project is being built step-by-step. See the **Roadmap** below for what
> each step delivers.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env         # fill in DATABASE_URL, REDIS_*, STEAM_API_KEY

# 3. Create the database schema & generate the Prisma client
npx prisma generate
npx prisma db push           # dev-friendly; use `prisma migrate dev` for real migrations

# 4. Run the app
npm run dev                  # http://localhost:3000

# In a second terminal — the BullMQ worker (parses .dem files, throttles Steam)
npm run worker
```

---

## Environment Variables

See [.env.example](.env.example). Keys:

| Variable           | Purpose                                                    |
| ------------------ | ---------------------------------------------------------- |
| `DATABASE_URL`     | PostgreSQL DSN for Prisma                                  |
| `REDIS_HOST/PORT/PASSWORD/DB` | BullMQ / ioredis connection                    |
| `STEAM_API_KEY`    | Steam Web API key (resolve vanity URLs, fetch profiles)    |
| `PARSE_MODE`       | `bullmq` (default) or `in_process` for Redis-free local dev |
| `CSTACKER_ENABLED` | Toggle the cstracker.gg scraper (`true` default)             |
| `CSTACKER_USE_PROXIES` | Rotate free proxies for cstracker requests (`true` default; `false` = direct) |
| `CSTACKER_PROXY_LIST_URL` | proxyscrape free-proxy feed (set to your preferred list) |
| `CSTACKER_MAX_PROXY_ATTEMPTS` | Proxies tried per page before failing (default 6) |
| `CSTACKER_ALLOW_DIRECT_FALLBACK` | One direct request when all proxies fail (default `true`) |

---

## Repository Layout

```
app/                  Next.js App Router routes (pages land here, step-by-step)
components/           Shared UI — <ShimmerCard />, nav, stat blocks
lib/                  Prisma client, Steam API client, serializer helpers
src/worker/           BullMQ queue + worker (download, decompress, demofile parse,
                      persist scoreboard/chat/rounds/server + teammate aggregation)
prisma/schema.prisma  Full relational model (User, Match, PlayerMatchStat, ChatLog,
                      TeammateLink, ServerLocation, RoundEvent, EconomySnapshot)
demos/ (gitignored)   Downloaded .dem files
```

---

## Roadmap

1. **Project architecture, database, & animation config** — *this step.*
   `package.json`, `tailwind.config.ts` (shimmer `@keyframes`), `app/globals.css`
   (global scrollbar hiding + glassmorphic shimmer-border system), and the full
   `schema.prisma`.
2. **Backend Steam API, match parsing, & location tracking** — Steam URL → Steam64
   resolution, share-code history fetch, BullMQ worker that downloads the `.dem`,
   parses chat logs / scoreboard / server IP with demoparser2, and geo-enriches
   the server IP.
3. **Global UI components & Home page** — reusable `<ShimmerCard />`, the radar
   (`app/layout.tsx` + font setup), and `/` home page with global search.
4. **Player profile & sub-navigation** — `/player/[steamId]` layout, overview,
   VAC/match totals/chat-count/server-location tracking, plus a free-proxy
   powered **cstracker.gg scraper** (Premier rating, match telemetry, weapons,
   history) that fills the gaps Steam/GC leave open.
5. **Chat archive & teammates** — `/player/[steamId]/chat` (keyword filter, Team vs
   All toggle, pagination) and `/player/[steamId]/teammates`.
6. **Match detail scoreboard** — `/match/[matchId]` full 10-player board + economy
   + round timeline.

---

## Design System

- **Background:** `#09090b`, near-black, high negative space.
- **Text:** `text-zinc-50` primary, `text-zinc-400` muted.
- **Cards:** transparent / `bg-white/5` glassmorphism, strict **8px** rounding
  (`rounded-lg`), animated rotating conic-gradient shimmer outline.
- **Accents:** electric blue `#38bdf8` and neon purple `#a855f7`.
- **Typography:** Geist (via `/GeistSans`) with Inter fallback.
- **Scrollbars:** hidden globally; scrolling still works (see `globals.css`).