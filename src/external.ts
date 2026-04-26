import { foldIcsLine } from "./calendar.ts";

const CACHE_TTL = 60 * 60; // 1 hour

export interface ExternalSlice {
  vtimezones: string;
  vevents: string[];
}

export function externalCacheKey(url: string): string {
  return `cache:ics:${url}`;
}

export async function fetchExternalIcs(
  kv: KVNamespace,
  url: string,
): Promise<string> {
  const key = externalCacheKey(url);
  const cached = await kv.get(key);
  if (cached !== null) return cached;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`External ICS fetch failed (${response.status}): ${url}`);
  }
  const text = await response.text();
  await kv.put(key, text, { expirationTtl: CACHE_TTL });
  return text;
}

export function transformExternalIcs(
  rawIcs: string,
  token: string,
): ExternalSlice {
  const unfolded = unfold(rawIcs);
  const lines = unfolded.split(/\r?\n/);

  const vtimezoneBlocks: string[][] = [];
  const veventBlocks: string[][] = [];

  let current: string[] | null = null;
  // Track which top-level component we're in (VTIMEZONE/VEVENT) — ignore
  // others (e.g. VCALENDAR wrapper, VTODO).
  const stack: string[] = [];

  for (const line of lines) {
    if (line.startsWith("BEGIN:")) {
      const name = line.slice("BEGIN:".length);
      stack.push(name);
      if (stack.length === 2 && name === "VTIMEZONE") {
        current = [line];
        continue;
      }
      if (stack.length === 2 && name === "VEVENT") {
        current = [line];
        continue;
      }
      if (current) current.push(line);
      continue;
    }
    if (line.startsWith("END:")) {
      const name = line.slice("END:".length);
      if (current) current.push(line);
      if (stack.length === 2 && name === "VTIMEZONE" && current) {
        vtimezoneBlocks.push(current);
        current = null;
      } else if (stack.length === 2 && name === "VEVENT" && current) {
        veventBlocks.push(current);
        current = null;
      }
      stack.pop();
      continue;
    }
    if (current) current.push(line);
  }

  return {
    vtimezones: vtimezoneBlocks.map(refold).join("\r\n"),
    vevents: veventBlocks.map((b) => refold(transformVEvent(b, token))),
  };
}

function unfold(text: string): string {
  // RFC5545: a CRLF followed by a single space or tab is a fold continuation.
  return text.replace(/\r?\n[ \t]/g, "");
}

function transformVEvent(lines: string[], token: string): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("UID:")) {
      out.push(`UID:${token}-${line.slice("UID:".length)}`);
    } else if (line.startsWith("CATEGORIES:")) {
      // drop existing — we add our own at the end
      continue;
    } else if (line === "END:VEVENT") {
      out.push(`CATEGORIES:${token}`);
      out.push(line);
    } else {
      out.push(line);
    }
  }
  return out;
}

function refold(lines: string[]): string {
  return lines.map(foldIcsLine).join("\r\n");
}
