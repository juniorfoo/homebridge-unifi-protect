import { describe, expect, it } from "vitest";
import { computeTimeshiftSliceStart, TimeshiftConcatCache } from "../src/timeshift-cache.js";

describe("timeshift-cache", () => {

  it("returns null for empty buffer or missing init segment", () => {

    const cache = new TimeshiftConcatCache();
    expect(cache.get({ buffer: [], generation: 1, initSegment: Buffer.from("init"), sliceStart: 1 })).toBeNull();
    expect(cache.get({ buffer: [ Buffer.from("seg") ], generation: 1, sliceStart: 1 })).toBeNull();
  });

  it("reuses cached concatenations for the same generation", () => {

    const cache = new TimeshiftConcatCache();
    const init = Buffer.from("init");
    const seg = Buffer.from("seg");
    const first = cache.get({ buffer: [ seg ], generation: 1, initSegment: init, sliceStart: 1 });
    const second = cache.get({ buffer: [ seg ], generation: 1, initSegment: init, sliceStart: 1 });

    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("invalidates when generation changes", () => {

    const cache = new TimeshiftConcatCache();
    const init = Buffer.from("init");
    const seg = Buffer.from("seg");
    const first = cache.get({ buffer: [ seg ], generation: 1, initSegment: init, sliceStart: 1 });
    const second = cache.get({ buffer: [ seg ], generation: 2, initSegment: init, sliceStart: 1 });

    expect(first).not.toBe(second);
  });

  it("invalidates explicit cache entries", () => {

    const cache = new TimeshiftConcatCache();
    const init = Buffer.from("init");
    const seg = Buffer.from("seg");
    const first = cache.get({ buffer: [ seg ], generation: 1, initSegment: init, sliceStart: 1 });
    cache.invalidate();
    const second = cache.get({ buffer: [ seg ], generation: 1, initSegment: init, sliceStart: 1 });
    expect(first).not.toBe(second);
  });

  it("computes slice starts from duration", () => {

    expect(computeTimeshiftSliceStart(1000, 100, 20)).toBe(10);
    expect(computeTimeshiftSliceStart(0, 100, 20)).toBe(20);
  });
});
