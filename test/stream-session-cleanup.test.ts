import { describe, expect, it, vi } from "vitest";
import { abortTsbLivestreamStart, formatStreamStartFailureError, LIVESTREAM_START_FAILURE_MESSAGE, releaseRtpPortReservations } from "../src/stream-session-cleanup.js";

describe("stream-session-cleanup", () => {

  it("formats livestream failure errors", () => {

    expect(formatStreamStartFailureError("Cam").message).toContain(LIVESTREAM_START_FAILURE_MESSAGE);
  });

  it("releases all RTP ports", () => {

    const cancel = vi.fn();

    releaseRtpPortReservations([ 1, 2 ], cancel);
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("forces HomeKit stop when ffmpeg already started", () => {

    const forceStop = vi.fn();
    const callback = vi.fn();

    abortTsbLivestreamStart(callback, [], {

      accessoryName: "Cam",
      cancelRtpPort: vi.fn(),
      closeDemuxer: vi.fn(),
      closeSegmentWriter: vi.fn(),
      detachLivestreamListeners: vi.fn(),
      forceStopStreamingSession: forceStop,
      isFfmpegStarted: true,
      logError: vi.fn(),
      stopFfmpeg: vi.fn(),
      stopLivestream: vi.fn(),
      turnOffFlashlight: vi.fn()
    });

    expect(forceStop).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });

  it("calls callback error when ffmpeg has not started", () => {

    const callback = vi.fn();
    const deps = {

      accessoryName: "Cam",
      cancelRtpPort: vi.fn(),
      closeDemuxer: vi.fn(),
      closeSegmentWriter: vi.fn(),
      detachLivestreamListeners: vi.fn(),
      forceStopStreamingSession: vi.fn(),
      isFfmpegStarted: false,
      logError: vi.fn(),
      stopFfmpeg: vi.fn(),
      stopLivestream: vi.fn(),
      turnOffFlashlight: vi.fn()
    };

    abortTsbLivestreamStart(callback, [ 1, 2 ], deps);

    expect(deps.detachLivestreamListeners).toHaveBeenCalledOnce();
    expect(deps.closeSegmentWriter).toHaveBeenCalledOnce();
    expect(deps.stopFfmpeg).toHaveBeenCalledOnce();
    expect(deps.stopLivestream).toHaveBeenCalledOnce();
    expect(deps.turnOffFlashlight).toHaveBeenCalledOnce();
    expect(deps.closeDemuxer).toHaveBeenCalledOnce();
    expect(deps.cancelRtpPort).toHaveBeenCalledTimes(2);
    expect(deps.logError).toHaveBeenCalledWith(LIVESTREAM_START_FAILURE_MESSAGE);
    expect(deps.forceStopStreamingSession).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledOnce();
  });
});
