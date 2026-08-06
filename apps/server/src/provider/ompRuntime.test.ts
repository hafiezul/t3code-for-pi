import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ompJsonlLines } from "./ompRuntime.ts";

const collect = (chunks: ReadonlyArray<Uint8Array>) =>
  Stream.fromIterable(chunks).pipe(
    ompJsonlLines,
    Stream.runCollect,
    Effect.map((lines) => lines.map((line) => line)),
  );

describe("ompJsonlLines", () => {
  it("splits records on newlines and strips a trailing carriage return", () =>
    Effect.gen(function* () {
      const lines = yield* collect([
        Buffer.from('{"type":"ready"}\r\n{"type":"response","id":"1"}\r\n'),
      ]);
      expect(lines).toEqual(['{"type":"ready"}', '{"type":"response","id":"1"}']);
    }));

  it("never splits inside a record that spans chunks", () =>
    Effect.gen(function* () {
      const record = '{"type":"message_update","delta":"hello world"}';
      const lines = yield* collect([
        Buffer.from(record.slice(0, 10)),
        Buffer.from(record.slice(10)),
        Buffer.from("\n"),
      ]);
      expect(lines).toEqual([record]);
    }));

  it("keeps U+2028/U+2029 intact inside a JSON string (valid line separators)", () =>
    Effect.gen(function* () {
      const record = '{"type":"message_update","delta":"a\u2028b\u2029c"}';
      const lines = yield* collect([Buffer.from(`${record}\n`)]);
      expect(lines).toEqual([record]);
    }));

  it("carries a >1 MiB single record end to end (1 MiB framing)", () =>
    Effect.gen(function* () {
      const payload = "x".repeat(1024 * 1024 + 64);
      const record = `{"type":"subagent_progress","id":"sa-1","recentOutput":"${payload}"}`;
      const lines = yield* collect([
        // Deliberately cut mid-record so the splitter must reassemble
        // across an arbitrary chunk boundary.
        Buffer.from(record.slice(0, 512 * 1024)),
        Buffer.from(record.slice(512 * 1024)),
        Buffer.from("\n"),
      ]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toBe(record);
      expect(lines[0]!.length).toBeGreaterThan(1024 * 1024);
    }));
});
