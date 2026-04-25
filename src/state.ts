const POSTED_TTL = 30 * 24 * 60 * 60; // 30 days

export function postedKey(
  mode: string,
  eventId: string,
  occurrenceIso: string,
): string {
  return `posted:${mode}:${eventId}:${occurrenceIso}`;
}

export function cacheDetailKey(eventId: string): string {
  return `cache:detail:${eventId}`;
}

export async function isAlreadyPosted(
  kv: KVNamespace,
  mode: string,
  eventId: string,
  occurrenceIso: string,
): Promise<boolean> {
  const val = await kv.get(postedKey(mode, eventId, occurrenceIso));
  return val !== null;
}

export async function markPosted(
  kv: KVNamespace,
  mode: string,
  eventId: string,
  occurrenceIso: string,
): Promise<void> {
  await kv.put(postedKey(mode, eventId, occurrenceIso), "1", {
    expirationTtl: POSTED_TTL,
  });
}
