# Krexa Bill Challenge — data contract (for the frontend)

This backend scrapes X for `#KrexaBillChallenge` posts, OCRs the bill screenshot
on each, and stores **only verified bills** (platform + amount read off the image)
in Postgres. The leaderboard frontend consumes that data.

You can read the data **two ways** — pick whichever fits your stack.

---

## Option 1 (recommended for a static / no-backend frontend): the HTTP API

The backend exposes a ranked JSON endpoint. CORS is open, so a browser can fetch
it directly.

```
GET  https://<backend-host>/leaderboard
```

Response:

```jsonc
{
  "updated_at": "2026-05-29T11:30:48.644Z",  // when this response was built
  "count": 1,                                  // number of entries
  "entries": [
    {
      "rank": 1,                               // 1 = biggest bill
      "platform": "Anthropic",                 // AI tool the bill is for (Claude / OpenAI / Anthropic / Codex / Cursor / ...)
      "amount": 23.6,                          // bill total as a number (can be null if unreadable)
      "currency": "$",                         // symbol/code as shown ("$", "USD", "₹", ...)
      "vendor": "Anthropic, PBC",              // merchant name on the invoice
      "handle": "SajetI19477",                 // X username (no @)
      "name": "niche baby meme",               // X display name
      "profile_url": "https://x.com/SajetI19477",
      "post_url": "https://x.com/SajetI19477/status/2060317211844370662",
      "image_url": "https://pbs.twimg.com/media/HJe3k2XaEAAWLZy.png?name=large", // the bill screenshot
      "posted_at": "2026-05-29T11:07:56.000Z", // when the tweet was posted (ISO)
      "likes": 0, "retweets": 0, "views": 0    // engagement (refreshed each scrape)
    }
  ]
}
```

- **Already ranked** by `amount` descending (biggest AI bill first). You can
  re-sort client-side using any field (e.g. `views` for "most viral").
- Poll it (every ~30s) or fetch on load. It's cheap and cached-friendly.
- Other endpoints on the same host: `GET /health` (status), `GET|POST /run`
  (force a refresh). You normally only need `/leaderboard`.

---

## Option 2 (if your frontend has its own backend): query Postgres directly

Connect to the same Aiven Postgres and read the `krexa_posts` table.

```sql
SELECT platform, amount, currency, vendor, name, handle, profile_url,
       post_url, image_url, posted_at, likes, retweets, views
FROM krexa_posts
WHERE is_bill = true
ORDER BY amount DESC NULLS LAST, posted_at DESC;
```

(`is_bill` is always `true` for rows we store — the table only contains verified
bills tagged `#KrexaBillChallenge` — but the filter is shown for clarity.)

### `krexa_posts` table

| column | type | meaning |
|--------|------|---------|
| `post_id` | text (PK) | X status id — stable key, so re-scrapes never duplicate |
| `platform` | text | **AI tool the bill is for** (Claude / OpenAI / Anthropic / Codex / Cursor …) |
| `is_bill` | boolean | always true in this table (we only store verified bills) |
| `amount` | numeric | **bill total** as a number (nullable if the image had no readable total) |
| `currency` | text | currency symbol/code as shown |
| `vendor` | text | merchant/company name on the invoice |
| `post_url` | text | **link to the X post** |
| `handle` | text | X username (no @) |
| `name` | text | X display name |
| `profile_url` | text | `https://x.com/<handle>` |
| `image_url` | text | the bill screenshot (pbs.twimg.com) |
| `ocr_text` | text | full text read off the image (audit / debugging) |
| `post_text` | text | the tweet's own text |
| `post_type` | text | original / reply / quote / repost |
| `likes`,`retweets`,`replies`,`views` | int | engagement, refreshed each scrape |
| `posted_at` | timestamptz | when the tweet was posted |
| `matched_queries` | text | which search term surfaced it (e.g. `#krexabillchallenge`) |
| `first_captured`,`last_captured`,`updated_at` | timestamptz | provenance |

---

## How fresh is the data?

The backend re-scrapes every `INTERVAL_MIN` minutes (default 30) and upserts new
bills. So a new entrant appears within ~30 min, or instantly if someone calls
`POST /run`. Engagement numbers (likes/views) are refreshed on each scrape.

## What counts as a leaderboard entry

A row exists **only if**: the post was found under `#KrexaBillChallenge` **and**
the attached image was read as an actual bill/receipt/invoice (so platform/amount
were extractable). Hype tweets, memes, and text-only posts are **not** stored.

## Ranking

Default: highest `amount` first (the campaign theme is "people spending too much
on AI"). If you want a different ranking (most bills per person, most viral, most
recent), sort by the relevant field client-side — every field is in the payload.
