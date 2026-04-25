import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MemoryKV } from "./helpers.ts";

// These imports will fail until we implement state.ts
import {
  postedKey,
  cacheDetailKey,
  seenKey,
  isAlreadyPosted,
  markPosted,
  isEventSeen,
  markEventSeen,
} from "../src/state.ts";

describe("postedKey", () => {
  it("builds correct key from mode, eventId, and occurrence ISO", () => {
    assert.equal(
      postedKey("test", "1546960", "2026-04-28T12:45:00Z"),
      "posted:test:1546960:2026-04-28T12:45:00Z",
    );
  });

  it("works with large string event IDs", () => {
    assert.equal(
      postedKey("live", "3482146135682753450", "2026-05-01T15:00:00Z"),
      "posted:live:3482146135682753450:2026-05-01T15:00:00Z",
    );
  });
});

describe("cacheDetailKey", () => {
  it("builds correct cache key", () => {
    assert.equal(cacheDetailKey("1546960"), "cache:detail:1546960");
  });
});

describe("isAlreadyPosted", () => {
  it("returns false when key does not exist", async () => {
    const kv = new MemoryKV();
    const result = await isAlreadyPosted(
      kv as unknown as KVNamespace,
      "test",
      "123",
      "2026-04-28T12:45:00Z",
    );
    assert.equal(result, false);
  });

  it("returns true when key exists", async () => {
    const kv = new MemoryKV();
    await kv.put("posted:test:123:2026-04-28T12:45:00Z", "1");
    const result = await isAlreadyPosted(
      kv as unknown as KVNamespace,
      "test",
      "123",
      "2026-04-28T12:45:00Z",
    );
    assert.equal(result, true);
  });
});

describe("markPosted", () => {
  it("writes key to KV", async () => {
    const kv = new MemoryKV();
    await markPosted(
      kv as unknown as KVNamespace,
      "test",
      "123",
      "2026-04-28T12:45:00Z",
    );
    assert.equal(kv.has("posted:test:123:2026-04-28T12:45:00Z"), true);
  });
});

describe("seenKey", () => {
  it("builds correct seen key", () => {
    assert.equal(seenKey("test", "9990001"), "seen:test:9990001");
  });
});

describe("isEventSeen", () => {
  it("returns false when event has not been seen", async () => {
    const kv = new MemoryKV();
    const result = await isEventSeen(
      kv as unknown as KVNamespace,
      "test",
      "9990001",
    );
    assert.equal(result, false);
  });

  it("returns true when event has been seen", async () => {
    const kv = new MemoryKV();
    await kv.put("seen:test:9990001", "1");
    const result = await isEventSeen(
      kv as unknown as KVNamespace,
      "test",
      "9990001",
    );
    assert.equal(result, true);
  });
});

describe("markEventSeen", () => {
  it("writes seen key to KV", async () => {
    const kv = new MemoryKV();
    await markEventSeen(
      kv as unknown as KVNamespace,
      "test",
      "9990001",
    );
    assert.equal(kv.has("seen:test:9990001"), true);
  });
});
