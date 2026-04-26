# Strava Event Bot

Cloudflare Worker that polls the Strava API for a club's group events, computes upcoming occurrences from recurrence rules, and posts Discord reminders.

## Features

- **New event announcements** — posts to Discord when a new event is discovered on Strava
- **24h reminders** — posts a reminder ~24 hours before each occurrence (skipped if just announced)
- **Recurrence expansion** using Temporal API — handles weekly events, biweekly intervals, and DST transitions correctly
- **Detail caching** in KV (24h TTL) to stay well under Strava's rate limits
- **Test/live mode** with separate webhook channels and non-overlapping KV key spaces
- **`/preview` endpoint** for dry-run debugging (no posts, no state changes)
- **`/seed` endpoint** to mark current events as already-posted on first deploy
- **`/calendar.ics` endpoint** publishes club events plus optional external feeds (e.g. PA Road, MUT, XC) for members to subscribe

## Setup

### 1. Install dependencies

```sh
npm install
```

### 2. Configure `wrangler.jsonc`

Copy the example config and fill in your values:

```sh
cp wrangler.jsonc.example wrangler.jsonc
```

`wrangler.jsonc` is gitignored so your deployment-specific values won't be committed.

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

### 3. Set secrets

```sh
wrangler secret put STRAVA_CLIENT_ID
wrangler secret put STRAVA_CLIENT_SECRET
wrangler secret put SEED_SECRET        # any random string — protects /preview and /seed
                                       # e.g. openssl rand -hex 32
wrangler secret put CALENDAR_KEY       # any random string — gates /calendar.ics
                                       # share full URL (?key=...) with members
wrangler secret put DISCORD_WEBHOOK_EVENTS_TEST
wrangler secret put DISCORD_WEBHOOK_LADIES_TEST
wrangler secret put DISCORD_WEBHOOK_EVENTS_LIVE
wrangler secret put DISCORD_WEBHOOK_LADIES_LIVE
```

### 4. OAuth bootstrap (one-time)

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
   wrangler kv key put --namespace-id=YOUR_KV_NAMESPACE_ID --remote "strava:refresh_token" "REFRESH_TOKEN_FROM_STEP_3"
   ```

### 5. Deploy and seed

```sh
wrangler deploy
```

Seed to prevent the first cron from announcing all existing events and posting reminders:

```sh
curl -X POST "https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/seed?key=YOUR_SEED_SECRET"
```

### 6. Test -> Live workflow

1. Start with `MODE: "test"` in `wrangler.jsonc` — posts go to test Discord channels
2. Use `/preview?key=YOUR_SEED_SECRET` to verify the bot sees the right events
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
# Or preview: curl "http://localhost:8787/preview?key=YOUR_SEED_SECRET"
```

## How it works

1. **Token refresh**: Reads the Strava refresh token from KV, exchanges it for an access token, and persists the rotated refresh token back (Strava rotates on every refresh).

2. **Event discovery**: Fetches the club's event list (IDs only — the list endpoint's occurrence data is stale).

3. **Detail fetch + cache**: For each event, fetches full details with a 24h KV cache.

4. **New event announcement**: If an event ID hasn't been seen before, posts a "New Event" announcement with schedule details for recurring events. Marks any in-window occurrences as posted to avoid a duplicate reminder.

5. **Recurrence expansion**: For weekly events, computes occurrences using `@js-temporal/polyfill` for DST-safe wall-clock arithmetic. For non-weekly events, uses the detail endpoint's `upcoming_occurrences`.

6. **Dedup + remind**: Checks KV for each occurrence. If not yet posted, sends a Discord reminder embed and marks it posted with a 30-day TTL.

## Calendar feed

`GET /calendar.ics?key=$CALENDAR_KEY` returns an iCalendar feed members can subscribe to in Google Calendar, Apple Calendar, etc. The key is required — requests without it return 403 — so you can share the URL with members but the feed isn't world-readable.

- Club events are read from the snapshot the cron pipeline writes after each run (so the public route never touches Strava).
- External feeds are configured via `EXTERNAL_CALENDARS` in `wrangler.jsonc` (any public ICS URL — Google Calendar, USATF associations, other clubs, etc).
- Each external feed is fetched and cached in KV for 1 hour to avoid hammering upstream.
- Women-only club events are prefixed with `🚺` in the SUMMARY so they're visible everywhere a calendar client renders titles.

Filter with `?include=`:

```
/calendar.ics?key=...                       # club + every external (default)
/calendar.ics?key=...&include=club          # just our Strava events
/calendar.ics?key=...&include=road,mut,xc   # just external race feeds
```

Each merged event carries `CATEGORIES:<token>` so calendar clients can filter or color-code by source.



- `women_only === true` -> ladies webhook
- Everything else -> main events webhook
- Private events are included (not filtered)

## Architecture notes

- **Event IDs are strings** — some Strava IDs exceed 2^53 and would lose precision as JavaScript numbers
- **DST safety** — all datetime math uses Temporal API, never `Date`
- **Rate limits** — 200 req/15min, 2000/day. The 24h detail cache keeps steady-state at ~11 req/hour
- **Endpoints are auth-gated** — `/preview` and `/seed` both require `?key=SEED_SECRET`
