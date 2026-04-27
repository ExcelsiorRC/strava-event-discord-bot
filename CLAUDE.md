# Agent Notes

This repository is a Cloudflare Worker that polls Strava for club group events and posts Discord reminders.

## Local expectations

- Use Node 22 when running tests locally
- Use `npm test` for the test suite
- Use `npm run dev` for remote Wrangler development with scheduled testing

## Behavior to preserve

- New events get an announcement post (only if they have a future occurrence — see `hasFutureOccurrence`); known events get 24h reminders only. Dead one-offs are still marked seen so we don't reconsider them, just not announced.
- If an event is announced and has an occurrence within 24h, skip the reminder (no double-post)
- Seed marks all events as "seen" (no announcement flood) and in-window occurrences as "posted"
- Event IDs must always be treated as strings (some exceed 2^53)
- All datetime math uses @js-temporal/polyfill, never native Date
- Discord descriptions are plain text — preserve \n, truncate at 400 chars with "[...]"
- `women_only` events route to the ladies webhook; everything else to the main webhook
- Strava refresh tokens rotate on every refresh — persist to KV before any other work
- The list endpoint's `upcoming_occurrences` is stale — only use detail endpoint data
- We fetch details for every event Strava returns (the list endpoint's `upcoming_occurrences` is stale for recurring events, so list-stage filtering would drop legit weekly events like Dawn Patrol). The 6-month recency filter is applied at ICS render time only (`ONE_OFF_LOOKBACK_MONTHS` in `calendar.ts`).
- Snapshot is sticky: aged-out events stay in the calendar feed; events deleted from Strava get dropped
- `calendar:version` is bumped only when snapshot content actually changes (sorted-by-id JSON compare); cache key includes the version
- Per-run budget: `MAX_API_CALLS_PER_RUN=30` uncached fetches in `FETCH_CONCURRENCY=5`-wide batches
- Workers Standard plan is required (the Free plan's 50-subrequest cap can't fit a ~250-event club); update wrangler.jsonc only to lower limits, defaults are sufficient

## Editing guidance

- Prefer red/green TDD: add or update a failing test first, then implement
- Test fixtures in `test/fixtures.ts` must be fully sanitized — no real names, club IDs, or PII
- `wrangler.jsonc` is gitignored; `wrangler.jsonc.example` is the committed template
- `samples/` is gitignored — contains private club data, never commit
- If CI behavior changes, keep `.github/workflows/ci.yml` aligned with `npm test`
- Do not add `Co-Authored-By` trailers (or any AI-attribution footer) to commit messages
