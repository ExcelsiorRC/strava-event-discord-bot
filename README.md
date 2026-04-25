# Strava Event Bot

Cloudflare Worker that polls the Strava API for a club's group events, computes upcoming occurrences from recurrence rules, and posts Discord embed reminders ~24 hours before each event.

## Features

- **Hourly cron** checks for events in the next 25-hour window
- **Recurrence expansion** using Temporal API — handles weekly events, biweekly intervals, and DST transitions correctly
- **Detail caching** in KV (24h TTL) to stay well under Strava's rate limits
- **Test/live mode** with separate webhook channels and non-overlapping KV key spaces
- **`/preview` endpoint** for dry-run debugging (no posts, no state changes)
- **`/seed` endpoint** to mark current events as already-posted on first deploy

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Configure `wrangler.jsonc`

The checked-in `wrangler.jsonc` contains placeholder values. Update it with your deployment-specific values:

1. Create a KV namespace and fill in the IDs:
   ```sh
   wrangler kv namespace create EVENT_BOT_STATE
   wrangler kv namespace create EVENT_BOT_STATE --preview
   ```

2. Set your club-specific vars:
   ```jsonc
   "vars": {
     "STRAVA_CLUB_ID": "YOUR_CLUB_ID",
     "STRAVA_CLUB_URL": "https://www.strava.com/clubs/your-club-slug",
     "MODE": "test"
   }
   ```

These are local changes you don't need to commit back.

### 4. Set secrets

```sh
wrangler secret put STRAVA_CLIENT_ID
wrangler secret put STRAVA_CLIENT_SECRET
wrangler secret put SEED_SECRET
wrangler secret put DISCORD_WEBHOOK_EVENTS_TEST
wrangler secret put DISCORD_WEBHOOK_LADIES_TEST
wrangler secret put DISCORD_WEBHOOK_EVENTS_LIVE
wrangler secret put DISCORD_WEBHOOK_LADIES_LIVE
```

### 5. OAuth bootstrap (one-time)

You need a Strava refresh token with `read` scope for a member of the club.

1. Open in browser (logged in as the club member):
   ```
   https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost&approval_prompt=force&scope=read
   ```

2. Copy the `code` parameter from the redirect URL.

3. Exchange for tokens:
   ```sh
   curl -X POST https://www.strava.com/oauth/token \
     -d client_id=YOUR_CLIENT_ID \
     -d client_secret=YOUR_CLIENT_SECRET \
     -d code=AUTHORIZATION_CODE \
     -d grant_type=authorization_code
   ```

4. Seed the refresh token into KV:
   ```sh
   wrangler kv key put --binding=EVENT_BOT_STATE "strava:refresh_token" "REFRESH_TOKEN_FROM_STEP_3"
   ```

### 6. Deploy and seed

```sh
wrangler deploy
```

Seed to prevent the first cron from posting reminders for all currently-upcoming events:

```sh
curl -X POST "https://strava-event-discord-bot.YOUR_SUBDOMAIN.workers.dev/seed?key=YOUR_SEED_SECRET"
```

### 7. Test → Live workflow

1. Start with `MODE: "test"` in `wrangler.jsonc` — posts go to test Discord channels
2. Use `/preview` to verify the bot sees the right events
3. Monitor test channels for a day to confirm timing and formatting
4. Change `MODE` to `"live"` in `wrangler.jsonc`, redeploy, and seed again
5. Live posts go to production channels — test history is preserved separately

## Development

```sh
# Run tests
npm test

# Local dev with scheduled trigger support
npm run dev
# Then trigger cron: curl http://localhost:8787/__scheduled
# Or preview: curl http://localhost:8787/preview
```

## How it works

1. **Token refresh**: Reads the Strava refresh token from KV, exchanges it for an access token, and persists the rotated refresh token back (Strava rotates on every refresh).

2. **Event discovery**: Fetches the club's event list (IDs only — the list endpoint's occurrence data is stale).

3. **Detail fetch + cache**: For each event, fetches full details with a 24h KV cache. At ~259 events, this means ~11 uncached fetches per hour.

4. **Recurrence expansion**: For weekly events, computes occurrences using `@js-temporal/polyfill` for DST-safe wall-clock arithmetic. For non-weekly events, uses the detail endpoint's `upcoming_occurrences`.

5. **Dedup + post**: Checks KV for each occurrence. If not yet posted, sends a Discord embed and marks it posted with a 30-day TTL.

## Event routing

- `women_only === true` → ladies webhook
- Everything else → main events webhook
- Private events are included (not filtered)

## Architecture notes

- **Event IDs are strings** — some Strava IDs exceed 2^53 and would lose precision as JavaScript numbers
- **DST safety** — all datetime math uses Temporal API, never `Date`
- **Rate limits** — 200 req/15min, 2000/day. The 24h detail cache keeps steady-state at ~11 req/hour
