/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-telemetry.test.ts: Pure helpers for live-view session diagnostics.
 */
import { describe, test } from "node:test";
/* eslint-disable-next-line sort-imports -- multi-member local import follows node:test per stream-ffmpeg-process.test.ts pattern. */
import { STREAM_NO_OUTPUT_WARNING_MS, StreamOutputWatchdog, establishmentFailureStopReason, formatLiveViewPathLabel, formatNoOutputWarning, formatStreamSessionStart,
  formatStreamSessionStop, recordStreamMediaActivityIfOwner } from "./stream-telemetry.ts";
import assert from "node:assert/strict";

const baseStart = {

  camera: "Example Camera",
  hardwareTranscode: true,
  path: "TSB/API",
  profile: "High",
  sessionId: "sess-1",
  transcode: false,
  verboseTelemetry: false
};

describe("formatLiveViewPathLabel", () => {

  test("direct RTSP when not using the timeshift buffer", () => {

    assert.equal(formatLiveViewPathLabel(false, false), "RTSP");
    assert.equal(formatLiveViewPathLabel(false, true), "RTSP");
  });

  test("timeshift buffer API vs RTSP substrate", () => {

    assert.equal(formatLiveViewPathLabel(true, false), "TSB/API");
    assert.equal(formatLiveViewPathLabel(true, true), "TSB/RTSP");
  });
});

describe("formatStreamSessionStart", () => {

  test("omits client network fields by default", () => {

    const line = formatStreamSessionStart({ ...baseStart, clientAddress: "192.0.2.1", dst: "192.0.2.1:5000", verboseTelemetry: false });

    assert.match(line, /^Stream started: camera=Example Camera session=sess-1 path=TSB\/API profile=High transcode=no hw=yes$/);
    assert.doesNotMatch(line, /client=/);
  });

  test("includes client and dst when verbose telemetry is enabled", () => {

    const line = formatStreamSessionStart({ ...baseStart, clientAddress: "192.0.2.1", dst: "192.0.2.1:5000", verboseTelemetry: true });

    assert.match(line, /client=192\.0\.2\.1 dst=192\.0\.2\.1:5000/);
  });
});

describe("formatStreamSessionStop", () => {

  test("formats duration, first-frame, segments, and ffmpeg exit", () => {

    const line = formatStreamSessionStop({

      ...baseStart,
      durationMs: 2500,
      ffmpegExitCode: 0,
      firstFrameMs: 120,
      reason: "homekit-stop",
      segmentsFed: 42
    });

    assert.match(line, /Stream ended: camera=Example Camera session=sess-1 path=TSB\/API profile=High transcode=no hw=yes reason=homekit-stop/);
    assert.match(line, /duration=2\.5s first-frame-ms=120 segments-fed=42 ffmpeg-exit=0/);
  });

  test("renders null placeholders for missing timing and exit code", () => {

    const line = formatStreamSessionStop({

      ...baseStart,
      durationMs: 100,
      reason: "livestream-acquire-failed",
      segmentsFed: 0
    });

    assert.match(line, /first-frame-ms=null/);
    assert.match(line, /ffmpeg-exit=null/);
  });
});

describe("formatNoOutputWarning", () => {

  test("uses the configured warning delay in the message", () => {

    const line = formatNoOutputWarning("Example Camera", "sess-1", "RTSP");

    assert.match(line, /No stream output after 10s/);
    assert.match(line, /session=sess-1, path=RTSP/);
    assert.equal(STREAM_NO_OUTPUT_WARNING_MS, 10000);
  });
});

describe("establishmentFailureStopReason", () => {

  test("returns livestream-acquire-failed when ffmpeg-exit was not logged yet", () => {

    assert.equal(establishmentFailureStopReason(false), "livestream-acquire-failed");
  });

  test("returns null after ffmpeg-exit telemetry so establishment cleanup does not mislabel the stop", () => {

    assert.equal(establishmentFailureStopReason(true), null);

    const ffmpegStopLine = formatStreamSessionStop({

      camera: "Example Camera",
      durationMs: 500,
      ffmpegExitCode: 1,
      hardwareTranscode: false,
      path: "TSB/API",
      profile: "High",
      reason: "ffmpeg-exit",
      segmentsFed: 0,
      sessionId: "sess-1",
      transcode: false,
      verboseTelemetry: true
    });

    assert.match(ffmpegStopLine, /reason=ffmpeg-exit/);
    assert.doesNotMatch(ffmpegStopLine, /livestream-acquire-failed/);
  });
});

describe("recordStreamMediaActivityIfOwner", () => {

  test("does not mutate a replacement diagnostics object after session id reuse", () => {

    const staleOwner = { firstFrameMs: undefined, segmentsFed: 0, sessionStartedAt: 1000 };
    const replacement = { firstFrameMs: undefined, segmentsFed: 0, sessionStartedAt: 2000 };
    const mapEntry = replacement;

    assert.equal(recordStreamMediaActivityIfOwner(mapEntry, staleOwner, 1500), false);
    assert.equal(replacement.segmentsFed, 0);
    assert.equal(replacement.firstFrameMs, undefined);
    assert.equal(staleOwner.segmentsFed, 0);
  });

  test("records segment count and first-frame timing for the current owner", () => {

    const owner = { firstFrameMs: undefined, segmentsFed: 0, sessionStartedAt: 1000 };

    assert.equal(recordStreamMediaActivityIfOwner(owner, owner, 1250), true);
    assert.equal(owner.segmentsFed, 1);
    assert.equal(owner.firstFrameMs, 250);
  });
});

describe("StreamOutputWatchdog", () => {

  test("fires once when no activity before the delay", async () => {

    let fired = 0;

    const watchdog = new StreamOutputWatchdog(() => { fired++; }, 20);

    watchdog.arm();
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(fired, 1);
    watchdog.clear();
  });

  test("activity before the delay suppresses the timeout", async () => {

    let fired = 0;

    const watchdog = new StreamOutputWatchdog(() => { fired++; }, 40);

    watchdog.arm();
    watchdog.activity();
    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(fired, 0);
    watchdog.clear();
  });

  test("clear prevents a pending timeout", async () => {

    let fired = 0;

    const watchdog = new StreamOutputWatchdog(() => { fired++; }, 20);

    watchdog.arm();
    watchdog.clear();
    await new Promise((resolve) => setTimeout(resolve, 40));

    assert.equal(fired, 0);
  });
});
