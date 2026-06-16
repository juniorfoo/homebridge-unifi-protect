import { describe, expect, it, vi } from "vitest";
import { formatNoOutputWarning, formatStreamSessionStart, formatStreamSessionStop, StreamOutputWatchdog } from "../src/stream-telemetry.js";

describe("stream-telemetry", () => {

  it("omits client IP unless verbose telemetry is enabled", () => {

    const line = formatStreamSessionStart({

      camera: "Doorbell",
      clientAddress: "192.168.3.31",
      hardwareTranscode: false,
      path: "RTSP",
      profile: "Medium",
      sessionId: "abc",
      transcode: false,
      verboseTelemetry: false
    });

    expect(line).not.toContain("192.168.3.31");
    expect(line).toContain("path=RTSP");
  });

  it("includes client network fields in verbose mode", () => {

    const line = formatStreamSessionStart({

      camera: "Doorbell",
      clientAddress: "192.168.1.10",
      dst: "192.168.1.20:50000",
      hardwareTranscode: true,
      path: "TSB/API",
      profile: "High",
      sessionId: "verbose-1",
      transcode: true,
      verboseTelemetry: true
    });

    expect(line).toContain("client=192.168.1.10");
    expect(line).toContain("dst=192.168.1.20:50000");
  });

  it("formats stop lines with duration and segments-fed", () => {

    const line = formatStreamSessionStop({

      camera: "Doorbell",
      durationMs: 12500,
      hardwareTranscode: false,
      path: "RTSP",
      profile: "Medium",
      firstFrameMs: 200,
      ffmpegExitCode: 1,
      reason: "homekit-stop",
      segmentsFed: 42,
      sessionId: "abc",
      transcode: false,
      verboseTelemetry: false
    });

    expect(line).toContain("segments-fed=42");
    expect(line).toContain("reason=homekit-stop");
  });

  it("formats stop lines when ffmpeg exit code is null", () => {

    const line = formatStreamSessionStop({

      camera: "Doorbell",
      durationMs: 2000,
      ffmpegExitCode: null,
      hardwareTranscode: false,
      path: "RTSP",
      profile: "Medium",
      reason: "ffmpeg-exit",
      segmentsFed: 3,
      sessionId: "null-exit",
      transcode: false,
      verboseTelemetry: false
    });

    expect(line).toContain("ffmpeg-exit=null");
  });

  it("includes verbose client field without destination endpoint", () => {

    const line = formatStreamSessionStart({

      camera: "Doorbell",
      clientAddress: "192.168.1.25",
      hardwareTranscode: false,
      path: "RTSP",
      profile: "Medium",
      sessionId: "client-only",
      transcode: false,
      verboseTelemetry: true
    });

    expect(line).toContain("client=192.168.1.25");
    expect(line).not.toContain("dst=");
  });

  it("warns when no output is produced", () => {

    expect(formatNoOutputWarning("Cam", "s1", "TSB/API")).toContain("No stream output after 10s");
  });

  it("fires watchdog callbacks once", () => {

    vi.useFakeTimers();
    const spy = vi.fn();

    new StreamOutputWatchdog(spy, 1000).arm();
    vi.advanceTimersByTime(1000);
    expect(spy).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("clears watchdog on activity", () => {

    vi.useFakeTimers();
    const spy = vi.fn();
    const watchdog = new StreamOutputWatchdog(spy, 1000);
    watchdog.arm();
    watchdog.activity();
    vi.advanceTimersByTime(1000);
    expect(spy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("formats stop lines with undefined first-frame and ffmpeg exit values", () => {

    const line = formatStreamSessionStop({

      camera: "Doorbell",
      durationMs: 500,
      hardwareTranscode: false,
      path: "RTSP",
      profile: "Medium",
      reason: "error",
      segmentsFed: 0,
      sessionId: "undef",
      transcode: false,
      verboseTelemetry: false
    });

    expect(line).toContain("first-frame-ms=null");
    expect(line).toContain("ffmpeg-exit=null");
  });
});
