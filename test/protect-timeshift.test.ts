import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProtectTimeshiftBuffer } from "../src/protect-timeshift.js";
import { createMockNvr } from "./helpers/mocks.js";
import * as pluginUtils from "homebridge-plugin-utils";

function createCamera() {

  const nvr = createMockNvr();
  const livestream = new EventEmitter() as EventEmitter & { getInitSegment: ReturnType<typeof vi.fn>; initSegment: Buffer };

  livestream.initSegment = Buffer.from("init");
  livestream.getInitSegment = vi.fn(async () => livestream.initSegment);

  const manager = {

    acquire: vi.fn(() => livestream),
    start: vi.fn(async () => true),
    stop: vi.fn(),
    restart: vi.fn(),
    isRestarting: vi.fn(() => false)
  };

  return {

    camera: {

      hasFeature: vi.fn(() => false),
      livestream: manager,
      log: nvr.platform.log,
      nvr: nvr,
      stream: { hksv: { recordingConfiguration: { mediaContainerConfiguration: { fragmentLength: 4000 } } } }
    } as any,
    livestream: livestream
  };
}

describe("protect-timeshift", () => {

  afterEach(() => {

    vi.clearAllMocks();
  });

  it("reuses getLast cache and invalidates on clearBuffer", () => {

    const { camera, livestream } = createCamera();
    const buffer = new ProtectTimeshiftBuffer(camera);
    const segment = Buffer.from("seg-1");

    (buffer as any).livestream = livestream;
    (buffer as any)._buffer = [ segment ];
    (buffer as any)._keyframes = [ true ];
    (buffer as any).bufferGeneration = 1;

    const first = buffer.getLast(50);
    const second = buffer.getLast(50);
    expect(first).toBe(second);

    (buffer as any).clearBuffer();
    (buffer as any).livestream = livestream;
    (buffer as any)._buffer = [ Buffer.from("seg-2") ];
    (buffer as any)._keyframes = [ true ];

    const third = buffer.getLast(50);
    expect(third).not.toBe(first);
  });

  it("returns keyframe snapshots only when fresh", () => {

    const { camera, livestream } = createCamera();
    const buffer = new ProtectTimeshiftBuffer(camera);

    (buffer as any).livestream = livestream;
    (buffer as any)._buffer = [ Buffer.from("k1"), Buffer.from("k2") ];
    (buffer as any)._keyframes = [ false, true ];
    (buffer as any)._lastKeyframeTime = Date.now();

    const keyframe = buffer.getLastKeyframe();
    expect(keyframe).toEqual(Buffer.concat([ livestream.initSegment, Buffer.from("k2") ]));

    (buffer as any)._lastKeyframeTime = 0;
    expect(buffer.getLastKeyframe()).toBeNull();

    (buffer as any)._lastKeyframeTime = Date.now() - ((5 * 2 * 1000) + 1000);
    expect(buffer.getLastKeyframe()).toBeNull();

    (buffer as any)._lastKeyframeTime = Date.now();
    (buffer as any)._keyframes = [ false, false ];
    expect(buffer.getLastKeyframe()).toBeNull();
  });

  it("detects init segment and updates generation when clearing", () => {

    const { camera, livestream } = createCamera();
    const buffer = new ProtectTimeshiftBuffer(camera);
    const beforeGeneration = (buffer as any).bufferGeneration;

    (buffer as any).livestream = livestream;
    expect(buffer.isInitSegment(livestream.initSegment)).toBe(true);
    expect(buffer.isInitSegment(Buffer.from("other"))).toBe(false);

    (buffer as any).clearBuffer();
    expect((buffer as any).bufferGeneration).toBe(beforeGeneration + 1);
    expect(buffer.buffer).toBeNull();
  });

  it("starts and stops timeshift buffer lifecycle", async () => {

    const { camera, livestream } = createCamera();
    const buffer = new ProtectTimeshiftBuffer(camera);
    const rtspEntry = { channel: { id: 1 }, url: "rtsps://example" } as any;

    await expect(buffer.start(rtspEntry)).resolves.toBe(true);
    expect(camera.livestream.acquire).toHaveBeenCalledWith(rtspEntry);
    expect(camera.livestream.start).toHaveBeenCalled();
    expect(buffer.isStarted).toBe(true);

    expect(buffer.stop()).toBe(true);
    expect(camera.livestream.stop).toHaveBeenCalledWith(rtspEntry);
    expect(buffer.isStarted).toBe(false);
    expect(buffer.isTransmitting).toBe(false);
    expect((buffer as any).livestream).toBeUndefined();
    expect((buffer as any).rtspEntry).toBeUndefined();
    expect(livestream.listenerCount("segment")).toBe(0);
  });

  it("restarts an already started buffer and normalizes segment length", async () => {

    const { camera } = createCamera();
    const buffer = new ProtectTimeshiftBuffer(camera);
    const rtspEntry = { channel: { id: 1 }, url: "rtsps://example" } as any;
    const stopSpy = vi.spyOn(buffer, "stop");

    (buffer as any)._isStarted = true;
    (buffer as any)._segmentLength = 5000;
    camera.stream.hksv.recordingConfiguration.mediaContainerConfiguration.fragmentLength = 1000;

    await expect(buffer.start(rtspEntry)).resolves.toBe(true);
    expect(stopSpy).toHaveBeenCalledOnce();
    expect((buffer as any)._segmentLength).toBe(100);
  });

  it("returns false when livestream startup or init segment fail", async () => {

    const { camera } = createCamera();
    const buffer = new ProtectTimeshiftBuffer(camera);
    const rtspEntry = { channel: { id: 1 }, url: "rtsps://example" } as any;

    camera.livestream.start = vi.fn(async () => false);
    await expect(buffer.start(rtspEntry)).resolves.toBe(false);

    camera.livestream.start = vi.fn(async () => true);
    camera.livestream.acquire = vi.fn(() => ({ on: vi.fn(), off: vi.fn(), initSegment: undefined, getInitSegment: vi.fn(async () => null) }));
    await expect(buffer.start(rtspEntry)).resolves.toBe(false);
  });

  it("transmitStart emits init+buffer and supports slicing", async () => {

    const { camera, livestream } = createCamera();
    const buffer = new ProtectTimeshiftBuffer(camera);

    (buffer as any).livestream = livestream;
    (buffer as any)._buffer = [ Buffer.from("a"), Buffer.from("b"), Buffer.from("c") ];
    (buffer as any)._isStarted = true;

    const seen: Buffer[] = [];
    buffer.on("segment", (segment: Buffer) => seen.push(segment));

    await expect(buffer.transmitStart(2)).resolves.toBe(true);
    expect(seen[0]).toEqual(Buffer.concat([ livestream.initSegment, Buffer.from("c") ]));
    expect(buffer.isTransmitting).toBe(true);

    expect(buffer.transmitStop()).toBe(true);
    expect(buffer.isTransmitting).toBe(false);
  });

  it("returns false when transmitStart cannot acquire livestream", async () => {

    const { camera } = createCamera();
    const buffer = new ProtectTimeshiftBuffer(camera);

    (buffer as any)._isStarted = false;
    (buffer as any).rtspEntry = { channel: { id: 1 }, url: "rtsps://example" };
    (buffer as any).livestream = { initSegment: null };
    vi.spyOn(buffer, "start").mockResolvedValue(false);

    await expect(buffer.transmitStart()).resolves.toBe(false);
    expect(camera.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to connect to the Protect livestream API"));
  });

  it("handles discontinuity and keyframe resume logic", () => {

    const { camera, livestream } = createCamera();
    const buffer = new ProtectTimeshiftBuffer(camera);
    const isKeyframe = vi.mocked(pluginUtils.isKeyframe);

    (buffer as any).livestream = livestream;
    (buffer as any)._isTransmitting = true;
    (buffer as any)._segmentLength = 100;
    (buffer as any).segmentCount = 3;

    const discontinuitySpy = vi.fn();
    const segmentSpy = vi.fn();
    buffer.on("discontinuity", discontinuitySpy);
    buffer.on("segment", segmentSpy);

    (buffer as any).eventHandlers.close();
    expect((buffer as any)._pendingDiscontinuity).toBe(true);
    expect((buffer as any)._buffer).toEqual([]);

    isKeyframe.mockReturnValueOnce(false).mockReturnValueOnce(true);
    (buffer as any).eventHandlers.segment(Buffer.from("s1"));
    expect(segmentSpy).not.toHaveBeenCalled();

    (buffer as any).eventHandlers.segment(Buffer.from("s2"));
    expect(discontinuitySpy).toHaveBeenCalledOnce();
    expect(segmentSpy).toHaveBeenCalledWith(Buffer.from("s2"));
  });

  it("computes keyframe alignment and restart behavior", () => {

    const { camera } = createCamera();
    const buffer = new ProtectTimeshiftBuffer(camera);
    const rtspEntry = { channel: { id: 1 }, url: "rtsps://example" } as any;

    (buffer as any).rtspEntry = rtspEntry;
    (buffer as any)._segmentLength = 100;
    (buffer as any)._buffer = [ Buffer.from("0"), Buffer.from("1"), Buffer.from("2"), Buffer.from("3"), Buffer.from("4") ];
    (buffer as any)._keyframes = [ false, true, false, false, true ];

    expect(buffer.getKeyframeAlignedStart(250)).toEqual({ seekOffsetMs: 100, startIndex: 1 });
    expect(buffer.getKeyframeAlignedStart(150)).toEqual({ seekOffsetMs: 200, startIndex: 1 });

    buffer.restart();
    expect(camera.livestream.restart).toHaveBeenCalledWith(rtspEntry);
    expect((buffer as any)._buffer).toEqual([]);
  });

  it("reports current buffered time", () => {

    const { camera } = createCamera();
    const buffer = new ProtectTimeshiftBuffer(camera);

    (buffer as any)._segmentLength = 250;
    (buffer as any)._buffer = [ Buffer.from("a"), Buffer.from("b"), Buffer.from("c"), Buffer.from("d") ];
    expect(buffer.time).toBe(1000);
  });

  it("returns null init segment without livestream and handles getLast edge cases", async () => {

    const { camera } = createCamera();
    const buffer = new ProtectTimeshiftBuffer(camera);
    expect(await buffer.getInitSegment()).toBeNull();
    expect(buffer.getLast(0)).toBeNull();

    (buffer as any)._segmentLength = 100;
    (buffer as any)._buffer = [ Buffer.from("1"), Buffer.from("2") ];
    (buffer as any).livestream = { initSegment: Buffer.from("init"), getInitSegment: vi.fn() };
    expect(buffer.getLast(10000)).toEqual(Buffer.concat([ Buffer.from("init"), Buffer.from("1"), Buffer.from("2") ]));
  });
});
