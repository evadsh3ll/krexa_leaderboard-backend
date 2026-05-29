# krexa-bill-bot

Standalone X (Twitter) scraper for the **#KrexaBillChallenge**. It watches for
campaign posts (`@krexa_xyz` mentions, `#KrexaBillChallenge`, `#Krexa`), reads
the bill screenshot on each post with a vision model, and publishes a ranked
**leaderboard** the Krexa site consumes.

Self-contained — no dependency on the parent `claw` repo. Drop this folder on a
VPS (or Render) and run it.

```
X search for the tag ──► OCR each bill screenshot ──► UPSERT into Postgres
   (platform + amount + profile read off the image)        │
                                              your hosted site reads krexa_posts
```

## Two ways to collect (pick one)

Both end identically — OCR each post's image for **platform + amount + profile**
and upsert into the same `krexa_posts` table. They differ only in *how they get
the posts*:

| | **Browserless — X GraphQL** (recommended) | Browser — Chrome |
|---|---|---|
| Run | `npm run api:watch` (`src/run-api.ts`) | `npm run watch` (`src/run.ts`) |
| Needs Chrome | **No** — just HTTPS calls | Yes, logged-in, on CDP |
| Host anywhere incl. Render | **Yes, trivially** | Painful (xvfb + disk) |
| Auth | two cookies (`X_AUTH_TOKEN`, `X_CT0`) | a logged-in Chrome profile |
| Speed / memory | fast JSON, tiny | slow, ~400MB |
| Failure mode | cookies expire (~weeks); query-id rotates (~monthly) | X DOM changes |

For your use case — **fetch every `#krexabillchallenge` post on an interval, OCR
the bill, store platform/amount/profile** — the browserless path is the one to
deploy. The browser path is kept as a fallback. (Both are verified; live search
on the browserless path just needs valid cookies.)

### Browserless setup (no Chrome)

X now requires a computed anti-bot header (`x-client-transaction-id`) on every API
call, so the fetch step runs through **twscrape** (Python), which generates that
token and tracks X's rotating query ids. Node still does the OCR + storage; the
fetch is a thin Python sidecar (`collector.py`, called by `src/collect.ts`).

1. Install the Python fetcher (one-time):
   ```bash
   pip3 install --user twscrape      # needs python3
   ```
2. Log into a **burner** X account in any browser.
3. DevTools → **Application → Cookies → `https://x.com`** → copy two values:
   - `auth_token` → `X_AUTH_TOKEN`
   - `ct0` → `X_CT0`
4. Put them in `.env` (plus `GROQ_API_KEY`, `DATABASE_URL`). Set the tag — **quote
   it** so the leading `#` isn't read as a comment:
   `X_QUERIES="#krexabillchallenge"`
5. Run:
   ```bash
   npm run api:once     # one cycle: search → OCR → DB, then exit
   npm run api:watch    # loop every INTERVAL_MIN minutes (production)
   ```

Cookies last a few weeks; when search starts failing on auth, refresh them.
twscrape keeps the rotating query id current, so that's no longer manual.

> `src/xapi.ts` is a pure-Node reference implementation of the same GraphQL call.
> It's correct (auth + query-id discovery work) but X's transaction-id requirement
> means a logged-in token generator is needed — hence the twscrape sidecar. Kept
> for reference / the `ApiPost` type.

> **Campaign window (from the official poster):** starts **May 29**, ends **June
> 10**, winners June 11. Rules: screenshot a Claude or OpenAI bill → post on
> X/Reddit/LinkedIn/etc → tag `#KrexaBillChallenge @krexa_xyz`.

## How the site gets the data — Postgres

Set `DATABASE_URL` and after every scrape the bot upserts one row per X post
into the **`krexa_posts`** table. Your hosted site reads from that table
(`SELECT ... WHERE is_bill = true ORDER BY amount DESC`, or however you rank).

Works with any Postgres: Render Postgres, Supabase, Neon, Railway, etc. The
table is created automatically on first run.

### `krexa_posts` columns

| column | meaning |
|--------|---------|
| `post_id` | X status id (primary key — upsert key, no dupes) |
| `platform` | **which AI tool the bill is for** — `Claude`, `Codex`, `ChatGPT`, `Cursor`, … (`''` if not an AI bill) |
| `is_bill` | true if the image is a bill/receipt/usage screenshot |
| `post_url` | **link to the X post** |
| `handle`, `name`, `profile_url` | **the account** that posted (name + @handle + profile link) |
| `amount`, `currency` | **the bill amount** (numeric) + symbol |
| `vendor`, `bill_date` | merchant name + date off the bill |
| `ocr_text` | full text read off the image |
| `post_text` | the tweet's own text |
| `image_url` | the screenshot |
| `post_type` | original / reply / quote / repost |
| `likes`, `retweets`, `replies`, `views` | engagement (refreshed each run) |
| `posted_at`, `matched_queries`, `first_captured`, `last_captured`, `updated_at` | timestamps / provenance |

The four you asked for are `platform`, `post_url`, `handle`+`name`, `amount`.
Everything else is there so the site can rank / show context without re-scraping.

Example query the site runs:

```sql
SELECT platform, amount, currency, name, handle, post_url, image_url
FROM krexa_posts
WHERE campaign = 'krexa' AND is_bill = true
ORDER BY amount DESC NULLS LAST;
```

> A local audit copy is also written to `DATA_DIR` (`*_master.json`,
> `*_mentions.csv`). An optional HTTP server (`--serve`) and webhook
> (`WEBHOOK_URL`) still exist if you ever want them, but Postgres is the path.

## Setup (local or VPS)

```bash
npm install            # or: pnpm install
cp .env.example .env   # then edit: GROQ_API_KEY at minimum
```

Required in `.env`:
- `GROQ_API_KEY` — for the vision OCR (get one at console.groq.com). Set
  `OCR=false` to skip OCR entirely and just collect posts.

## Chrome on the VPS (the one prerequisite)

X requires a **logged-in** browser session. The bot attaches to a Chrome you run
with remote debugging — it never logs in itself.

```bash
# install chrome on the VPS (Ubuntu)
sudo apt install -y chromium-browser libnss3 libatk-bridge2.0-0 libxkbcommon0 libgbm1

# headless WON'T keep an X login — run it headful under a virtual display:
sudo apt install -y xvfb
xvfb-run -a google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/.krexa-chrome" \
  --no-first-run --no-default-browser-check
```

Then log into X **once** in that profile (open `https://x.com/login`; on a
headless VPS do this via remote debugging or by copying a logged-in
`--user-data-dir` from a desktop machine). The session persists in the profile
dir, so you only do it once.

> Tip: keep the queries to `@krexa_xyz` + the campaign hashtags and run on a
> burner X account — this is read-only (scroll + read), but X is strict.

## Run

```bash
npm run once     # one cycle (scrape → OCR → upsert to DB), then exit — good for cron / first test
npm run watch    # loop every INTERVAL_MIN minutes, upserting to the DB each cycle (production)
npm run serve    # only expose the optional HTTP server, no scraping
```

### Production with PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 logs krexa-bill-bot
pm2 save && pm2 startup     # restart on reboot
```

### Or cron (instead of the watch loop)

```cron
*/30 * * * * cd /path/to/krexa-bill-bot && /usr/bin/npm run once >> data/run.log 2>&1
```

(Run a separate `npm run serve` if you still want the HTTP endpoint.)

## Deploying on Render

**Use the browserless path and Render is straightforward** — there's no Chrome
to keep alive, so no xvfb and no persistent disk for a browser profile.

1. **Postgres** — create a Render Postgres instance; put its connection string in
   `DATABASE_URL`. The site and the bot both point at it.
2. **The bot** — a Render **Web Service** (so it gets a public URL to ping +
   trigger). It needs Node and Python, so use a Docker env or a build command
   that installs both:
   - Build: `npm install && pip3 install twscrape`
   - Start: `npm run api:watch`
   - It binds to Render's `$PORT` automatically.
3. **Env vars** — set `GROQ_API_KEY`, `DATABASE_URL`, `X_AUTH_TOKEN`, `X_CT0`,
   `X_QUERIES="#krexabillchallenge"`, `INTERVAL_MIN` (default 30).
4. **Keep it awake** — Render free Web Services sleep after ~15 min idle. Point an
   external uptime pinger (UptimeRobot, cron-job.org, etc.) at
   `https://<your-app>.onrender.com/health` every ~10 min. That keeps it up *and*
   keeps the fetch loop running.

### HTTP endpoints (in `--watch` mode)

| Endpoint | Does |
|---|---|
| `GET /health` | 200 + status JSON: `running`, `last_run_at`, `last_error`, `interval_min`, `queries`, `db`, and `last` run totals. Ping this to keep Render awake. |
| `GET` or `POST /run` | Manually trigger a fetch→OCR→DB cycle now. `202` if started, `409` if one's already running. Poll `/health` for the result. |

So: it **auto-fetches every `INTERVAL_MIN` minutes** (default 30), **and** you can
force an update any time with `curl https://<app>.onrender.com/run`.

That's it — the worker calls X's GraphQL search over HTTPS, OCRs via Groq (also
HTTPS), and writes to Postgres. All API calls, no display, tiny memory.

Two things to keep in mind on Render:
- **Datacenter IP.** X is stricter with datacenter IPs. Use a **burner** account.
  If search starts getting blocked, route through a residential/mobile proxy — say
  the word and I'll wire an undici `ProxyAgent` into `src/xapi.ts` (Node's `fetch`
  doesn't pick up `HTTPS_PROXY` on its own). The browserless path is far less
  detectable than a headless browser, but the token can still be rate-limited.
- **Cookie refresh.** `X_AUTH_TOKEN`/`X_CT0` last a few weeks; when search 401s,
  update the two env vars and redeploy. (A short re-login + copy, ~1 min.)

> The **browser path** (`npm run watch`, Chrome) is the harder Render case — it
> needs a Dockerfile with Chrome + xvfb and a Disk-backed profile. Only go there
> if the GraphQL path stops working; ask and I'll write that Dockerfile.

## Config (`.env`)

| Var | Default | Meaning |
|-----|---------|---------|
| `GROQ_API_KEY` | — | Groq key for vision OCR (required unless `OCR=false`) |
| `OCR_MODEL` | `meta-llama/llama-4-scout-17b-16e-instruct` | vision model |
| `BROWSER_CDP_URL` | `http://localhost:9222` | browser path: the logged-in Chrome |
| `X_AUTH_TOKEN` | — | **browserless path: `auth_token` cookie** of a logged-in X account |
| `X_CT0` | — | **browserless path: `ct0` cookie** (also sent as x-csrf-token) |
| `X_QUERIES` | `#krexabillchallenge` | browserless path: tag(s) to search (comma-sep) |
| `CAMPAIGN` | `krexa` | file/table prefix |
| `QUERIES` | `#KrexaBillChallenge,@krexa_xyz,#Krexa` | browser path: search terms (comma-sep) |
| `OCR` | `true` | read bill screenshots; `false` = collect only |
| `MAX_POSTS` | `10000` | cap per query |
| `MAX_IDLE_ROUNDS` | `25` | scroll patience before stopping |
| `INTERVAL_MIN` | `30` | minutes between cycles in watch mode |
| `PORT` | `8080` | HTTP server port |
| `DATA_DIR` | `data` | local audit-copy dir |
| `DATABASE_URL` | — | **Postgres connection string the site reads from** (`krexa_posts`) |
| `DATABASE_SSL` | `true` | set `false` only for a local Postgres |
| `WEBHOOK_URL` | — | optional: also POST leaderboard JSON here after each run |
| `WEBHOOK_SECRET` | — | sent as `x-webhook-secret` header |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |

## Notes

- **Read-only.** Only scrolls search-result pages; no posting/liking/following.
- **Idempotent.** Reruns merge into the master by post ID; engagement is refreshed,
  and an already-OCR'd screenshot is never sent to the model again.
- **Completeness.** X "Latest" search shows ~7–10 days of results. Keep the watch
  loop running so nothing ages out before it's captured.
- **Output:** primary sink is Postgres (`krexa_posts`). Local audit copies are
  written to `DATA_DIR`: `krexa_campaign_master.json` (full state),
  `krexa_campaign_mentions.csv` + `krexa_leaderboard.json/.csv` (offline views).
- **Platform detection:** the OCR identifies which AI tool each bill is for
  (Claude / Codex / ChatGPT / Cursor / …) → the `platform` column.
