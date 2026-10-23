# Quinn

Private, plain-language search over short facts and memories captured in Baserow (the `Quinn` database).
Built for content that must never reach an AI service: **nothing you capture is sent to any LLM, embedding
API, or server-side function.** The page is static and the browser talks to Baserow directly.

## How search works

- **Exact mode** — keywords with stemming, prefix and typo tolerance, ranked by rarity of the matched words.
- **Smart mode** (default) — the same, fused with *semantic* matches from a small sentence-embedding model
  (all-MiniLM-L6-v2) that runs **in your browser**. Only the model weights are downloaded (~25 MB, cached);
  vectors are cached in IndexedDB on the device. Matches found by meaning but not wording show `≈ related`.
- Plain-language filters are parsed locally: `last month`, `this week`, `in october`, `in 2025`,
  `last 3 weeks`, `source:name`, `#tag`, `"exact phrase"`, `-excluded`.
- Source chips filter by capturing app (whatever you set up as options in the `Source` select). Empty search shows newest memories.

## Setup

1. In Baserow, create an API token scoped to the Quinn database with **read** permission only.
2. Deploy to your own Cloudflare account with `npm run deploy` (a Worker serving static assets, no server
   code), or run it locally with `npm run dev` (http://localhost:8800).
3. First launch: paste token + table ID + choose a passphrase. The token is encrypted on this device
   (PBKDF2 -> AES-GCM) and only held in memory once unlocked; reloading locks the app.

## Protecting the site itself

Put the deployed site behind **Cloudflare Access** (Zero Trust, free for one user; email one-time code)
so the page isn't reachable at all without signing in. The passphrase above is a second layer.

## Table shape

`Text` (long text, primary) · `Created` (created on) · `Archived` (boolean) · `Source` (single select).
Archived rows are hidden. Inline `#tags` in the text become filterable.

## Tests

`npm test` covers query parsing, stemming, fuzzy matching, filters and rank fusion.

## Known limits

- Loads the whole table on each unlock; fine for thousands of short rows.
- Baserow still stores the text in plaintext. Row-level encryption at capture is possible later
  (every capture path would need the key) but makes Baserow's own search useless for this table.
