import { describe, expect, it, vi } from "vitest";
import { ProtectSnapshot } from "../src/protect-snapshot.js";
import { createMockNvr, createMockPlatform } from "./helpers/mocks.js";
import { FfmpegExec } from "homebridge-plugin-utils";

function createSnapshotCamera(overrides: Record<string, unknown> = {}) {

  const platform = createMockPlatform();
  const nvr = createMockNvr({ platform });

  return {

    camera: {

      accessory: { context: {} },
      api: platform.api,
      findRtsp: vi.fn(() => ({ channel: { fps: 20 }, url: "rtsps://example/live" })),
      hasFeature: vi.fn(() => false),
      hints: { crop: false, highResSnapshots: true },
      isOnline: true,
      log: platform.log,
      nvr,
      platform,
      stream: {

        ffmpegOptions: {

          cropFilter: "crop=iw:ih",
          hardwareDownloadFilters: [],
          videoDecoder: vi.fn(() => [])
        },
        hksv: {

          rtspEntry: { channel: { fps: 20 } },
          timeshift: {

            getLast: vi.fn(() => null),
            getLastKeyframe: vi.fn(() => null)
          }
        },
        probesize: 500000
      },
      ufp: { id: "camera-id" },
      ufpApi: { bootstrap: {}, isThrottled: false },
      ...overrides
    } as any
  };
}

describe("protect-snapshot", () => {

  it("returns null when camera or controller is offline", async () => {

    const { camera } = createSnapshotCamera({ isOnline: false });
    const snapshot = new ProtectSnapshot(camera);

    await expect(snapshot.getSnapshot()).resolves.toBeNull();
  });

  it("returns null when controller is throttled or missing bootstrap", async () => {

    const { camera } = createSnapshotCamera({ isOnline: true, ufpApi: { bootstrap: null, isThrottled: true } });
    const snapshot = new ProtectSnapshot(camera);

    await expect(snapshot.getSnapshot()).resolves.toBeNull();
  });

  it("falls back to cached snapshot when all sources fail", async () => {

    const { camera } = createSnapshotCamera();
    const snapshot = new ProtectSnapshot(camera);
    const cached = Buffer.from("cached-image");

    (snapshot as any)._cachedSnapshot = { image: cached, time: Date.now() };
    vi.spyOn(snapshot as any, "snapFromTimeshift").mockResolvedValue(null);
    vi.spyOn(snapshot as any, "snapFromRtsp").mockResolvedValue(null);
    camera.nvr.ufpApi.getSnapshot = vi.fn(async () => null);

    const result = await snapshot.getSnapshot({ height: 720, width: 1280 } as any);
    expect(result).toEqual(cached);
    expect(camera.log.warn).toHaveBeenCalled();
  });

  it("coalesces concurrent getSnapshot requests", async () => {

    const { camera } = createSnapshotCamera();
    const snapshot = new ProtectSnapshot(camera);
    const acquireSpy = vi.spyOn(snapshot as any, "acquireSnapshot").mockImplementation(async () => {

      await new Promise(resolve => setTimeout(resolve, 10));

      return Buffer.from("coalesced");
    });

    const [ first, second ] = await Promise.all([ snapshot.getSnapshot(), snapshot.getSnapshot() ]);

    expect(first?.toString()).toBe("coalesced");
    expect(second?.toString()).toBe("coalesced");
    expect(acquireSpy).toHaveBeenCalledOnce();
  });

  it("uses timeshift snapshots first and caches result", async () => {

    const { camera } = createSnapshotCamera();
    const snapshot = new ProtectSnapshot(camera);
    const image = Buffer.from("timeshift");

    vi.spyOn(snapshot as any, "snapFromTimeshift").mockResolvedValue(image);
    const rtspSpy = vi.spyOn(snapshot as any, "snapFromRtsp");

    await expect(snapshot.getSnapshot({ height: 720, width: 1280 } as any)).resolves.toEqual(image);
    expect(rtspSpy).not.toHaveBeenCalled();
    expect((snapshot as any)._cachedSnapshot.image).toEqual(image);
  });

  it("prefers package camera API snapshot before rtsp", async () => {

    const { camera } = createSnapshotCamera({
      accessory: { context: { packageCamera: true } }
    });
    const snapshot = new ProtectSnapshot(camera);
    const apiImage = Buffer.from("package");

    vi.spyOn(snapshot as any, "snapFromTimeshift").mockResolvedValue(null);
    vi.spyOn(snapshot as any, "cropSnapshot").mockResolvedValue(Buffer.from("cropped"));
    vi.spyOn(snapshot as any, "snapFromRtsp").mockResolvedValue(Buffer.from("rtsp"));
    camera.hints.crop = true;
    camera.nvr.ufpApi.getSnapshot = vi.fn(async () => apiImage);

    await expect(snapshot.getSnapshot({ height: 360, width: 640 } as any)).resolves.toEqual(Buffer.from("cropped"));
    expect(camera.nvr.ufpApi.getSnapshot).toHaveBeenCalledWith(camera.ufp, { height: 360, usePackageCamera: true, width: 640 });
    expect((snapshot as any).snapFromRtsp).not.toHaveBeenCalled();
  });

  it("falls back from rtsp to protect api for non-package cameras", async () => {

    const { camera } = createSnapshotCamera();
    const snapshot = new ProtectSnapshot(camera);
    const apiImage = Buffer.from("api");

    vi.spyOn(snapshot as any, "snapFromTimeshift").mockResolvedValue(null);
    vi.spyOn(snapshot as any, "snapFromRtsp").mockResolvedValue(null);
    camera.nvr.ufpApi.getSnapshot = vi.fn(async () => apiImage);

    await expect(snapshot.getSnapshot({ height: 1080, width: 1920 } as any)).resolves.toEqual(apiImage);
    expect(camera.nvr.ufpApi.getSnapshot).toHaveBeenCalledWith(camera.ufp, { height: 1080, width: 1920 });
  });

  it("builds ffmpeg command with crop and scaling filters", async () => {

    const { camera } = createSnapshotCamera();
    camera.hints.crop = true;
    camera.stream.ffmpegOptions.hardwareDownloadFilters = [ "hwdownload", "format=nv12" ];
    const snapshot = new ProtectSnapshot(camera);
    const ffmpegCtor = vi.mocked(FfmpegExec);
    const execSpy = vi.fn(async () => ({ exitCode: 0, stdout: Buffer.from("jpeg-output") }));

    ffmpegCtor.mockImplementationOnce(((_options: unknown, args: string[]) => ({
      args,
      exec: execSpy
    } as any)) as never);

    const result = await (snapshot as any).snapFromFfmpeg([ "-i", "pipe:0" ], { height: 720, width: 1280 }, Buffer.from("in"));

    const args = (ffmpegCtor.mock.calls.at(-1) as any[])[1] as string[];
    expect(result).toEqual(Buffer.from("jpeg-output"));
    expect(args).toContain("-filter:v");
    expect(args.join(" ")).toContain("hwdownload,format=nv12,crop=iw:ih,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2");
    expect(execSpy).toHaveBeenCalledWith(Buffer.from("in"));
  });

  it("returns null when ffmpeg snapshot output is empty or failed", async () => {

    const { camera } = createSnapshotCamera();
    const snapshot = new ProtectSnapshot(camera);
    const ffmpegCtor = vi.mocked(FfmpegExec);

    ffmpegCtor.mockImplementationOnce(() => ({
      exec: vi.fn(async () => ({ exitCode: 0, stdout: Buffer.alloc(0) }))
    } as any));

    await expect((snapshot as any).snapFromFfmpeg([ "-i", "pipe:0" ])).resolves.toBeNull();

    ffmpegCtor.mockImplementationOnce(() => ({
      exec: vi.fn(async () => ({ exitCode: 1, stdout: Buffer.from("bad") }))
    } as any));

    await expect((snapshot as any).snapFromFfmpeg([ "-i", "pipe:0" ])).resolves.toBeNull();
  });

  it("crops API snapshots and logs crop errors", async () => {

    const { camera } = createSnapshotCamera();
    const snapshot = new ProtectSnapshot(camera);
    const ffmpegCtor = vi.mocked(FfmpegExec);

    ffmpegCtor.mockImplementationOnce(() => ({
      exec: vi.fn(async () => ({ exitCode: 0, stdout: Buffer.from("crop-ok") }))
    } as any));
    await expect((snapshot as any).cropSnapshot(Buffer.from("input"))).resolves.toEqual(Buffer.from("crop-ok"));

    ffmpegCtor.mockImplementationOnce(() => ({
      exec: vi.fn(async () => ({ exitCode: 1, stdout: Buffer.alloc(0) }))
    } as any));
    await expect((snapshot as any).cropSnapshot(Buffer.from("input"))).resolves.toBeNull();
    expect(camera.log.error).toHaveBeenCalledWith("Unable to crop snapshot.");
  });

  it("handles null sources and cache expiry behavior", async () => {

    const { camera } = createSnapshotCamera();
    const snapshot = new ProtectSnapshot(camera);
    vi.spyOn(snapshot as any, "snapFromTimeshift").mockResolvedValue(null);
    vi.spyOn(snapshot as any, "snapFromRtsp").mockResolvedValue(null);
    camera.nvr.ufpApi.getSnapshot = vi.fn(async () => null);

    await expect((snapshot as any).acquireSnapshot({ width: 1920, height: 1080 })).resolves.toBeNull();
    expect(camera.log.error).toHaveBeenCalledWith("Unable to retrieve a snapshot.");

    (snapshot as any)._cachedSnapshot = { image: Buffer.from("old"), time: Date.now() - (120_000) };
    expect((snapshot as any).cachedSnapshot).toBeNull();
  });

  it("short-circuits timeshift and rtsp when high-res snapshots disabled", async () => {

    const { camera } = createSnapshotCamera({ hints: { crop: false, highResSnapshots: false }, stream: null });
    const snapshot = new ProtectSnapshot(camera);

    await expect((snapshot as any).snapFromTimeshift()).resolves.toBeNull();
    await expect((snapshot as any).snapFromRtsp()).resolves.toBeNull();
    await expect((snapshot as any).snapFromFfmpeg([ "-i", "pipe:0" ])).resolves.toBeNull();
    await expect((snapshot as any).cropSnapshot(Buffer.from("x"))).resolves.toBeNull();
  });

  it("falls back to rtsp when package camera api snapshot fails", async () => {

    const { camera } = createSnapshotCamera({
      accessory: { context: { packageCamera: true } }
    });
    const snapshot = new ProtectSnapshot(camera);
    const rtspImage = Buffer.from("rtsp-fallback");

    vi.spyOn(snapshot as any, "snapFromTimeshift").mockResolvedValue(null);
    vi.spyOn(snapshot as any, "snapFromRtsp").mockResolvedValue(rtspImage);
    camera.nvr.ufpApi.getSnapshot = vi.fn(async () => null);

    await expect(snapshot.getSnapshot({ height: 360, width: 640 } as any)).resolves.toEqual(rtspImage);
    expect((snapshot as any).snapFromRtsp).toHaveBeenCalled();
  });

  it("returns null when timeshift buffer has no data", async () => {

    const { camera } = createSnapshotCamera();
    const snapshot = new ProtectSnapshot(camera);

    camera.stream.hksv.timeshift.getLastKeyframe = vi.fn(() => null);
    camera.stream.hksv.timeshift.getLast = vi.fn(() => null);

    await expect((snapshot as any).snapFromTimeshift()).resolves.toBeNull();
  });

  it("uses timeshift getLast fallback and default fps", async () => {

    const { camera } = createSnapshotCamera();
    const snapshot = new ProtectSnapshot(camera);
    const ffmpegSpy = vi.spyOn(snapshot as any, "snapFromFfmpeg").mockResolvedValue(Buffer.from("ok"));
    const fallbackBuffer = Buffer.from("tsb-buffer");

    camera.stream.hksv.rtspEntry = null;
    camera.stream.hksv.timeshift.getLastKeyframe = vi.fn(() => null);
    camera.stream.hksv.timeshift.getLast = vi.fn(() => fallbackBuffer);

    await (snapshot as any).snapFromTimeshift({ width: 1280, height: 720 });

    const args = ffmpegSpy.mock.calls[0]?.[0] as string[];
    expect(args).toEqual([
      "-r", "30",
      "-probesize", fallbackBuffer.length.toString(),
      "-f", "mp4",
      "-i", "pipe:0"
    ]);
  });

  it("returns null when rtsp profile is unavailable", async () => {

    const { camera } = createSnapshotCamera();
    const snapshot = new ProtectSnapshot(camera);

    camera.findRtsp = vi.fn(() => null);

    await expect((snapshot as any).snapFromRtsp()).resolves.toBeNull();
  });

  it("enables verbose ffmpeg logging when debug snapshot feature is set", async () => {

    const { camera } = createSnapshotCamera();
    const snapshot = new ProtectSnapshot(camera);
    const ffmpegCtor = vi.mocked(FfmpegExec);

    camera.hasFeature = vi.fn((option: string) => option === "Debug.Video.Snapshot");
    ffmpegCtor.mockImplementationOnce(((_options: unknown, args: string[]) => ({
      args,
      exec: vi.fn(async () => ({ exitCode: 0, stdout: Buffer.from("jpeg-output") }))
    } as any)) as never);

    await expect((snapshot as any).snapFromFfmpeg([ "-i", "pipe:0" ])).resolves.toEqual(Buffer.from("jpeg-output"));

    const args = (ffmpegCtor.mock.calls.at(-1) as any[])[1] as string[];
    const logLevelIndex = args.indexOf("-loglevel");
    expect(logLevelIndex).toBeGreaterThanOrEqual(0);
    expect(args[logLevelIndex + 1]).toBe("level+verbose");
  });
});
