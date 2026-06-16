import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LivestreamManager } from "../src/protect-livestream.js";
import { createMockNvr, setNvrBootstrap } from "./helpers/mocks.js";

function createLivestreamHandle() {

  const emitter = new EventEmitter() as EventEmitter & {

    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };

  emitter.start = vi.fn(async () => true);
  emitter.stop = vi.fn();
  emitter.removeAllListeners = vi.fn(emitter.removeAllListeners.bind(emitter)) as any;

  return emitter;
}

function createCamera(overrides: Record<string, unknown> = {}) {

  const nvr = createMockNvr();
  const livestream = createLivestreamHandle();

  (nvr.ufpApi.createLivestream as ReturnType<typeof vi.fn>).mockReturnValue(livestream);

  return {

    camera: {

      hasFeature: vi.fn((feature: string) => feature === "Device.SelfHealing"),
      hostProfile: "default",
      isOnline: true,
      livestream: null,
      log: nvr.platform.log,
      name: "Front Door",
      nvr: nvr,
      platform: nvr.platform,
      stream: {},
      ufp: { id: "camera-id", modelKey: "cameras", videoCodec: "h264" },
      ufpApi: nvr.ufpApi,
      activatePreferRtspLiveView: vi.fn(),
      ...overrides
    } as any,
    livestream: livestream
  };
}

describe("protect-livestream", () => {

  afterEach(() => {

    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("acquires and reuses livestream handles", () => {

    const { camera } = createCamera();
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 1 }, url: "rtsps://example/high" } as any;

    const first = manager.acquire(rtspEntry);
    const second = manager.acquire(rtspEntry);

    expect(first).toBe(second);
  });

  it("indexes livestreams by channel and optional lens", () => {

    const { camera } = createCamera();
    const manager = new LivestreamManager(camera);

    const primary = (manager as any).getIndex({ channel: { id: 2 }, url: "rtsps://example/primary" });
    const secondary = (manager as any).getIndex({ channel: { id: 2 }, lens: 1, url: "rtsps://example/secondary" });

    expect(primary).toEqual({ channel: 2, index: "2", lens: undefined });
    expect(secondary).toEqual({ channel: 0, index: "0.1", lens: 1 });
  });

  it("reports per-stream restarting state", () => {

    const { camera } = createCamera();
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 6 }, url: "rtsps://example/live" } as any;

    expect(manager.isRestarting(rtspEntry)).toBeFalsy();
    (manager as any).restarting["6"] = true;
    expect(manager.isRestarting(rtspEntry)).toBe(true);
  });

  it("returns false when start is called before acquire", async () => {

    const { camera } = createCamera();
    const manager = new LivestreamManager(camera);
    const ok = await manager.start({ channel: { id: 0 }, url: "rtsps://example/live" } as any);

    expect(ok).toBe(false);
  });

  it("starts and stops livestream subscriptions", async () => {

    const { camera, livestream } = createCamera();
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 2 }, url: "rtsps://example/live" } as any;

    manager.acquire(rtspEntry);
    expect(await manager.start(rtspEntry)).toBe(true);
    expect(livestream.start).toHaveBeenCalledOnce();

    manager.stop(rtspEntry);
    expect(livestream.stop).toHaveBeenCalledOnce();
  });

  it("restarts an existing livestream", async () => {

    const { camera, livestream } = createCamera();
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 0 }, url: "rtsps://example/live" } as any;

    manager.acquire(rtspEntry);
    await manager.start(rtspEntry);
    manager.restart(rtspEntry);

    await Promise.resolve();
    expect(livestream.stop).toHaveBeenCalled();
  });

  it("shuts down all livestream sessions and clears state", async () => {

    const { camera, livestream } = createCamera();
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 0 }, url: "rtsps://example/live" } as any;

    manager.acquire(rtspEntry);
    await manager.start(rtspEntry);
    manager.shutdown();

    expect(livestream.removeAllListeners).toHaveBeenCalled();
    expect(livestream.stop).toHaveBeenCalled();
    expect(await manager.start(rtspEntry)).toBe(false);
  });

  it("tracks subscribers and keeps stream until last consumer stops", async () => {

    const { camera, livestream } = createCamera();
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 1 }, url: "rtsps://example/live" } as any;

    manager.acquire(rtspEntry);
    await manager.start(rtspEntry);
    await manager.start(rtspEntry);
    expect(livestream.start).toHaveBeenCalledOnce();

    manager.stop(rtspEntry);
    expect(livestream.stop).toHaveBeenCalledTimes(0);

    manager.stop(rtspEntry);
    expect(livestream.stop).toHaveBeenCalledOnce();
  });

  it("retries restart later when camera is offline/throttled", async () => {

    vi.useFakeTimers();
    const { camera, livestream } = createCamera({ isOnline: false });
    setNvrBootstrap(camera, null);
    camera.ufpApi.isThrottled = true;
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 0 }, url: "rtsps://example/live" } as any;

    manager.acquire(rtspEntry);
    await manager.start(rtspEntry);
    await (manager as any).restartLivestream("0", false);

    expect(livestream.stop).toHaveBeenCalled();
    expect((manager as any).restarting["0"]).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect((manager as any).segmentTimer["0"]).toBeTruthy();
  });

  it("handles restart with failed reconnect by scheduling deferred retry", async () => {

    vi.useFakeTimers();
    const { camera, livestream } = createCamera();
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 0 }, url: "rtsps://example/live" } as any;

    manager.acquire(rtspEntry);
    await manager.start(rtspEntry);
    livestream.start.mockResolvedValue(false);
    await (manager as any).restartLivestream("0", false);

    expect((manager as any).segmentTimer["0"]).toBeTruthy();
    expect(camera.log.warn).toHaveBeenCalled();
  });

  it("handles external restart path without backoff growth", async () => {

    const { camera } = createCamera();
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 0 }, url: "rtsps://example/live" } as any;

    manager.acquire(rtspEntry);
    await manager.start(rtspEntry);
    (manager as any).restartDelay["0"] = 3;
    await (manager as any).restartLivestream("0", true);

    expect((manager as any).restartDelay["0"]).toBe(3);
    expect(camera.log.warn).toHaveBeenCalled();
  });

  it("returns early when restart has no subscribers", async () => {

    const { camera } = createCamera();
    const manager = new LivestreamManager(camera);
    (manager as any).subscriberCount["0"] = 0;
    (manager as any).segmentTimer["0"] = setTimeout(() => undefined, 10_000);

    await (manager as any).restartLivestream("0", false);
    expect((manager as any).restarting["0"]).toBe(false);
  });

  it("skips duplicate restart requests and clears timers on stop", async () => {

    const { camera, livestream } = createCamera();
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 0 }, url: "rtsps://example/live" } as any;

    manager.acquire(rtspEntry);
    await manager.start(rtspEntry);
    (manager as any).restarting["0"] = true;

    await (manager as any).restartLivestream("0", false);
    expect(livestream.stop).toHaveBeenCalledTimes(0);

    (manager as any).restarting["0"] = false;
    (manager as any).segmentTimer["0"] = setTimeout(() => undefined, 1_000);
    manager.stop(rtspEntry);
    expect(livestream.stop).toHaveBeenCalledOnce();
  });

  it("returns false when rtsp-mode start fails", async () => {

    const { camera } = createCamera({
      hasFeature: vi.fn((feature: string) => feature === "Debug.Video.HKSV.UseRtsp"),
      stream: {
        ffmpegOptions: {},
        hksv: { isAudioActive: false, recordingConfiguration: { prebufferLength: 4000 } }
      }
    });
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 0 }, url: "rtsps://example/live" } as any;
    const stream = manager.acquire(rtspEntry) as any;
    stream.start = vi.fn(() => undefined);

    await expect(manager.start(rtspEntry)).resolves.toBe(true);
    expect(stream.start).toHaveBeenCalledOnce();
  });

  it("returns false when livestream API start fails", async () => {

    const { camera, livestream } = createCamera();
    livestream.start = vi.fn(async () => false);
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 3 }, url: "rtsps://example/live" } as any;

    manager.acquire(rtspEntry);
    await expect(manager.start(rtspEntry)).resolves.toBe(false);
    expect(camera.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to access the Protect livestream API"));
  });

  it("resets restart counters on healthy segment activity and clears timers on shutdown", async () => {

    vi.useFakeTimers();
    const { camera, livestream } = createCamera();
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 4 }, url: "rtsps://example/live" } as any;

    manager.acquire(rtspEntry);
    await manager.start(rtspEntry);
    (manager as any).segmentTimer["4"] = setTimeout(() => undefined, 10_000);
    (manager as any).startTime["4"] = Date.now() - 120_000;
    (manager as any).restartCount["4"] = 3;
    (manager as any).restartDelay["4"] = 2;

    livestream.emit("segment", Buffer.from("seg"));
    expect((manager as any).restartCount["4"]).toBe(0);
    expect((manager as any).restartDelay["4"]).toBe(0);

    manager.shutdown();
    expect(livestream.stop).toHaveBeenCalled();
  });

  it("acquires ffmpeg livestream process in debug rtsp mode", () => {

    const { camera } = createCamera({
      hasFeature: vi.fn((feature: string) => feature === "Debug.Video.HKSV.UseRtsp"),
      stream: {
        ffmpegOptions: {},
        hksv: { isAudioActive: true, recordingConfiguration: { prebufferLength: 4000 } }
      }
    });
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 1 }, url: "rtsps://example/high" } as any;

    manager.acquire(rtspEntry);
    expect(camera.nvr.ufpApi.createLivestream).not.toHaveBeenCalled();
  });

  it("restarts ffmpeg rtsp streams via direct start path", async () => {

    const { camera } = createCamera({
      hasFeature: vi.fn((feature: string) => feature === "Debug.Video.HKSV.UseRtsp"),
      stream: {
        ffmpegOptions: {},
        hksv: { isAudioActive: true, recordingConfiguration: { prebufferLength: 4000 } }
      }
    });
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 7 }, url: "rtsps://example/live" } as any;
    const stream = manager.acquire(rtspEntry) as any;
    stream.start = vi.fn(() => undefined);
    stream.stop = vi.fn(() => undefined);

    await manager.start(rtspEntry);
    await (manager as any).restartLivestream("7", false);

    expect(stream.start).toHaveBeenCalledTimes(2);
    expect(stream.stop).toHaveBeenCalled();
  });

  it("self-heals by rebooting camera when restarts exceed threshold", async () => {

    const { camera } = createCamera();
    camera.nvr.ufpApi.retrieve = vi.fn(async () => ({ statusCode: 200 }));
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 0 }, url: "rtsps://example/live" } as any;

    manager.acquire(rtspEntry);
    await manager.start(rtspEntry);
    (manager as any).restartCount["0"] = 999;
    (manager as any).restartEvents = [ { timestamp: Date.now() } ];

    await (manager as any).restartLivestream("0", false);

    expect(camera.nvr.ufpApi.retrieve).toHaveBeenCalled();
  });

  it("schedules retry when camera reboot request is rejected", async () => {

    vi.useFakeTimers();
    const { camera } = createCamera();
    camera.nvr.ufpApi.responseOk = vi.fn(() => false);
    camera.nvr.ufpApi.retrieve = vi.fn(async () => ({ statusCode: 503 }));
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 5 }, url: "rtsps://example/live" } as any;

    manager.acquire(rtspEntry);
    await manager.start(rtspEntry);
    (manager as any).restartCount["5"] = 999;

    await (manager as any).restartLivestream("5", false);

    expect(camera.log.error).toHaveBeenCalledWith("Unable to restart the camera.");
    expect((manager as any).segmentTimer["5"]).toBeTruthy();
  });

  it("logs reconnect telemetry variants and ignores segments while restarting", async () => {

    vi.useFakeTimers();
    const { camera, livestream } = createCamera({
      hasFeature: vi.fn((feature: string) => [ "Device.SelfHealing", "Debug.Video.HKSV.Telemetry" ].includes(feature))
    });
    const manager = new LivestreamManager(camera);
    const rtspEntry = { channel: { id: 8 }, url: "rtsps://example/live" } as any;

    manager.acquire(rtspEntry);
    await manager.start(rtspEntry);

    (manager as any).lastSegmentTime["8"] = Date.now() - 3000;
    (manager as any).restartDelay["8"] = 1;
    (manager as any).restartEvents = [ { timestamp: Date.now() }, { timestamp: Date.now() }, { timestamp: Date.now() } ];

    await (manager as any).restartLivestream("8", false);
    expect(camera.activatePreferRtspLiveView).toHaveBeenCalled();
    expect(camera.log.warn).toHaveBeenCalledWith(expect.stringContaining("Retrying %s connection"), expect.any(String), expect.any(String));

    (manager as any).restartDelay["8"] = 0;
    await (manager as any).restartLivestream("8", false);
    expect(camera.log.warn).toHaveBeenCalledWith(expect.stringContaining("Reconnecting to the %s"), expect.any(String), expect.any(String));

    (manager as any).restarting["8"] = true;
    const previousTimer = (manager as any).segmentTimer["8"];
    livestream.emit("segment", Buffer.from("late"));
    expect((manager as any).segmentTimer["8"]).toBe(previousTimer);
  });
});
