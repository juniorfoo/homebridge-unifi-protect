/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-transcode-policy.test.ts: Copy-first encode ladder, output fps, and copy-failure escalation gates.
 */
/* eslint-disable sort-imports -- H264Level single import stays beside policy imports */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { H264_PROFILE_HIGH, H264_PROFILE_MAIN, VIDEO_COPY_ESCALATION_WINDOW_MS, VIDEO_COPY_FAILURE_PATTERNS, assessH264CopyProfileLevel, classifyVideoCopyFailure,
  decideLiveVideoEncode, estimateH264MinLevelRank, matchesSessionVideoFfmpegForEscalation, resolveForceTranscodeDueToUserOption, resolveLiveTranscodeBitrate,
  isLiveSourceFpsKnown, normalizeLiveSourceFps, resolveLiveStreamInterpolationActive, resolveStreamOutputFps, resolveVideoCopyExitBridgeAction,
  shouldEscalateCopyToTranscode, shouldRegisterOngoingSessionEntry, shouldRemoveOngoingSessionEntry,
  shouldRemovePendingSessionEntry } from "./stream-transcode-policy.ts";
import { H264Level } from "homebridge-plugin-utils";

function encodeInput(overrides: Partial<Parameters<typeof decideLiveVideoEncode>[0]> = {}): Parameters<typeof decideLiveVideoEncode>[0] {

  return { crop: false, forceTranscodeDueToUserOption: false, homeKitH264Level: H264Level.LEVEL4_0, homeKitH264Profile: H264_PROFILE_MAIN, isHighLatency: false,
    requestFps: 30,
    requestHeight: 720, requestWidth: 1280, sourceDeclaredH264Known: true, sourceDeclaredH264Level: H264Level.LEVEL4_0, sourceDeclaredH264Profile: H264_PROFILE_MAIN,
    sourceFps: 15,
    sourceHeight: 720, sourceWidth: 1280, videoCodec: "h264", ...overrides };
}

describe("resolveStreamOutputFps", () => {

  test("caps output at the source rate when HomeKit requests higher fps", () => {

    assert.equal(resolveStreamOutputFps({ requestedFps: 30, sourceFps: 15 }), 15);
  });

  test("passes through the HomeKit request when the source is not slower", () => {

    assert.equal(resolveStreamOutputFps({ requestedFps: 24, sourceFps: 30 }), 24);
  });

  test("uses the HomeKit request when the source fps is unknown (0)", () => {

    assert.equal(resolveStreamOutputFps({ requestedFps: 30, sourceFps: 0 }), 30);
  });

  test("uses the HomeKit request when the source fps is unknown (NaN)", () => {

    assert.equal(resolveStreamOutputFps({ requestedFps: 24, sourceFps: Number.NaN }), 24);
  });
});

describe("resolveLiveStreamInterpolationActive", () => {

  test("interpolation only when platform gate is on and source is known and not below the request", () => {

    assert.equal(resolveLiveStreamInterpolationActive(true, 30, 15), true);
    assert.equal(resolveLiveStreamInterpolationActive(true, 15, 30), false);
    assert.equal(resolveLiveStreamInterpolationActive(true, 0, 30), false);
    assert.equal(resolveLiveStreamInterpolationActive(true, Number.POSITIVE_INFINITY, 30), false);
    assert.equal(resolveLiveStreamInterpolationActive(true, Number.NaN, 30), false);
    assert.equal(resolveLiveStreamInterpolationActive(false, 30, 15), false);
  });
});

describe("normalizeLiveSourceFps", () => {

  test("maps unknown channel fps to the 0 sentinel", () => {

    assert.equal(normalizeLiveSourceFps(15), 15);
    assert.equal(normalizeLiveSourceFps(0), 0);
    assert.equal(normalizeLiveSourceFps(-1), 0);
    assert.equal(normalizeLiveSourceFps(Number.NaN), 0);
    assert.equal(normalizeLiveSourceFps(Number.POSITIVE_INFINITY), 0);
  });
});

describe("isLiveSourceFpsKnown", () => {

  test("treats non-finite and non-positive fps as unknown", () => {

    assert.equal(isLiveSourceFpsKnown(0), false);
    assert.equal(isLiveSourceFpsKnown(Number.NaN), false);
    assert.equal(isLiveSourceFpsKnown(Number.POSITIVE_INFINITY), false);
    assert.equal(isLiveSourceFpsKnown(Number.NEGATIVE_INFINITY), false);
    assert.equal(isLiveSourceFpsKnown(-1), false);
    assert.equal(isLiveSourceFpsKnown(15), true);
  });
});

describe("assessH264CopyProfileLevel", () => {

  test("transcodes when geometry implies a level above HomeKit's negotiation", () => {

    const result = assessH264CopyProfileLevel({ homeKitH264Level: H264Level.LEVEL3_1, homeKitH264Profile: H264_PROFILE_MAIN, sourceDeclaredH264Known: true,
      sourceDeclaredH264Level: H264Level.LEVEL3_1, sourceDeclaredH264Profile: H264_PROFILE_MAIN, sourceFps: 30, sourceHeight: 1080, sourceWidth: 1920 });

    assert.equal(result.compatible, false);
    assert.match(result.logReason ?? "", /level/i);
  });

  test("rejects a High-profile source against a Main negotiation", () => {

    const result = assessH264CopyProfileLevel({ homeKitH264Level: H264Level.LEVEL4_0, homeKitH264Profile: H264_PROFILE_MAIN, sourceDeclaredH264Known: true,
      sourceDeclaredH264Level: H264Level.LEVEL4_0, sourceDeclaredH264Profile: H264_PROFILE_HIGH, sourceFps: 24, sourceHeight: 720, sourceWidth: 1280 });

    assert.equal(result.compatible, false);
  });

  test("transcodes when profile compatibility cannot be established", () => {

    const result = assessH264CopyProfileLevel({

      homeKitH264Level: H264Level.LEVEL4_0, homeKitH264Profile: H264_PROFILE_MAIN, sourceDeclaredH264Known: false, sourceFps: 24, sourceHeight: 720, sourceWidth: 1280
    });

    assert.equal(result.compatible, false);
    assert.match(result.logReason ?? "", /unknown/i);
  });

  test("transcodes when declared level exceeds the HomeKit negotiation", () => {

    const result = assessH264CopyProfileLevel({ homeKitH264Level: H264Level.LEVEL4_0, homeKitH264Profile: H264_PROFILE_MAIN, sourceDeclaredH264Known: true,
      sourceDeclaredH264Level: 3, sourceDeclaredH264Profile: H264_PROFILE_MAIN, sourceFps: 15, sourceHeight: 720, sourceWidth: 1280 });

    assert.equal(result.compatible, false);
    assert.match(result.logReason ?? "", /declared H\.264 level exceeds/i);
  });
});

describe("estimateH264MinLevelRank", () => {

  test("1080p30 requires at least level 4.0", () => {

    assert.equal(estimateH264MinLevelRank(1920, 1080, 30), 2);
  });
});

describe("resolveForceTranscodeDueToUserOption", () => {

  test("matches upstream: home Enable or high-latency HighLatency enable", () => {

    assert.equal(resolveForceTranscodeDueToUserOption(true, false, false), true);
    assert.equal(resolveForceTranscodeDueToUserOption(false, true, true), true);
    assert.equal(resolveForceTranscodeDueToUserOption(false, false, true), false);
  });
});

describe("decideLiveVideoEncode - copy-first ladder", () => {

  test("forces transcode when Video.Transcode is enabled on a low-latency session", () => {

    assert.deepEqual(decideLiveVideoEncode(encodeInput({ forceTranscodeDueToUserOption: true, isHighLatency: false })),
      { logReason: "Video.Transcode is enabled", mode: "transcode" });
  });

  test("forces transcode when Video.Transcode.HighLatency is enabled", () => {

    assert.deepEqual(decideLiveVideoEncode(encodeInput({ forceTranscodeDueToUserOption: true, isHighLatency: true })),
      { logReason: "Video.Transcode.HighLatency is enabled", mode: "transcode" });
  });

  test("selects copy for a matching H.264 stream when transcode options are off", () => {

    assert.deepEqual(decideLiveVideoEncode(encodeInput()), { mode: "copy" });
  });

  test("transcodes when source width differs from the HomeKit request (X4)", () => {

    assert.deepEqual(decideLiveVideoEncode(encodeInput({ requestWidth: 1280, sourceWidth: 1920 })),
      { logReason: "source resolution does not match the HomeKit request", mode: "transcode" });
  });

  test("transcodes when source height differs from the HomeKit request (X5)", () => {

    assert.deepEqual(decideLiveVideoEncode(encodeInput({ requestHeight: 720, sourceHeight: 1080 })),
      { logReason: "source resolution does not match the HomeKit request", mode: "transcode" });
  });

  test("transcodes when declared avcC level exceeds the HomeKit negotiation even if geometry fits", () => {

    assert.deepEqual(decideLiveVideoEncode(encodeInput({ sourceDeclaredH264Level: 3 })),
      { logReason: "declared H.264 level exceeds the HomeKit-negotiated level", mode: "transcode" });
  });

  test("transcodes when declared parameters are unknown (RTSP / parse failure safe default)", () => {

    assert.deepEqual(decideLiveVideoEncode(encodeInput({ sourceDeclaredH264Known: false })),
      { logReason: "declared H.264 parameters unknown", mode: "transcode" });
  });

  test("transcodes buffer-backed H.264 when avcC declared parameters are unknown (third-party uses same gate)", () => {

    assert.deepEqual(decideLiveVideoEncode(encodeInput({ sourceDeclaredH264Known: false })),
      { logReason: "declared H.264 parameters unknown", mode: "transcode" });
  });

  test("keeps copy when the source fps is lower than the HomeKit request", () => {

    assert.deepEqual(decideLiveVideoEncode(encodeInput({ requestFps: 30, sourceFps: 15 })), { mode: "copy" });
  });

  test("unknown source fps fails closed to transcode (copy ladder)", () => {

    assert.deepEqual(decideLiveVideoEncode(encodeInput({ sourceFps: 0 })),
      { logReason: "source frame rate is unknown", mode: "transcode" });
    assert.deepEqual(decideLiveVideoEncode(encodeInput({ sourceFps: Number.NaN })),
      { logReason: "source frame rate is unknown", mode: "transcode" });
    assert.deepEqual(decideLiveVideoEncode(encodeInput({ sourceFps: Number.POSITIVE_INFINITY })),
      { logReason: "source frame rate is unknown", mode: "transcode" });
    assert.deepEqual(decideLiveVideoEncode(encodeInput({ sourceFps: -1 })),
      { logReason: "source frame rate is unknown", mode: "transcode" });
  });

  test("transcodes when the source fps exceeds the HomeKit request", () => {

    assert.deepEqual(decideLiveVideoEncode(encodeInput({ requestFps: 15, sourceFps: 30 })),
      { logReason: "source frame rate exceeds the HomeKit request", mode: "transcode" });
  });

  test("transcodes when resolution does not match", () => {

    assert.deepEqual(decideLiveVideoEncode(encodeInput({ requestHeight: 480, requestWidth: 640 })),
      { logReason: "source resolution does not match the HomeKit request", mode: "transcode" });
  });

  test("transcodes for crop and non-H.264 without an explicit Video.Transcode option", () => {

    assert.deepEqual(decideLiveVideoEncode(encodeInput({ crop: true })), { logReason: "video crop is enabled", mode: "transcode" });
    assert.deepEqual(decideLiveVideoEncode(encodeInput({ videoCodec: "av1" })), { logReason: "input codec is not H.264", mode: "transcode" });
    assert.deepEqual(decideLiveVideoEncode(encodeInput({ forceTranscodeDueToUserOption: false, isHighLatency: true })), { mode: "copy" });
  });
});

describe("classifyVideoCopyFailure", () => {

  test("each copy failure pattern is recognized", () => {

    for(const pattern of VIDEO_COPY_FAILURE_PATTERNS) {

      assert.equal(classifyVideoCopyFailure([pattern]), true, pattern);
    }
  });

  test("unrelated stderr lines do not classify as copy failure", () => {

    assert.equal(classifyVideoCopyFailure(["frame=  120 fps= 24 q=-1.0 size=    1024kB time=00:00:05.00 bitrate=1677.7kbits/s speed=1.0x"]), false);
  });
});

describe("resolveLiveTranscodeBitrate", () => {

  test("honors configured transcode bitrates and caps to the source channel", () => {

    assert.equal(resolveLiveTranscodeBitrate({ homeKitBitrateKbps: 800, isHighLatency: false, sourceBitrateKbps: 6000, transcodeBitrateHint: 450,
      transcodeHighLatencyBitrateHint: -1 }), 450);
    assert.equal(resolveLiveTranscodeBitrate({ homeKitBitrateKbps: 800, isHighLatency: false, sourceBitrateKbps: 400, transcodeBitrateHint: 450,
      transcodeHighLatencyBitrateHint: -1 }), 400);
  });
});

describe("shouldEscalateCopyToTranscode", () => {

  test("allows escalation early in the session when copy fails on TSB", () => {

    assert.equal(shouldEscalateCopyToTranscode({ copyFailure: true, elapsedMs: 500, escalatedFromCopy: false, segmentsFed: 2, useTimeshiftBuffer: true,
      videoCopy: true }), true);
  });

  test("allows classified RTSP copy failures without fed segments inside the window", () => {

    assert.equal(shouldEscalateCopyToTranscode({ copyFailure: true, elapsedMs: 5000, escalatedFromCopy: false, segmentsFed: 0, useTimeshiftBuffer: false,
      videoCopy: true }), true);
  });

  test("rejects TSB escalation without feed activity after the early-session grace", () => {

    assert.equal(shouldEscalateCopyToTranscode({ copyFailure: true, elapsedMs: 5000, escalatedFromCopy: false, segmentsFed: 0, useTimeshiftBuffer: true,
      videoCopy: true }), false);
  });

  test("pins VIDEO_COPY_ESCALATION_WINDOW_MS at 8000 ms for copy escalation eligibility", () => {

    assert.equal(VIDEO_COPY_ESCALATION_WINDOW_MS, 8000);
    assert.equal(shouldEscalateCopyToTranscode({ copyFailure: true, elapsedMs: 7999, escalatedFromCopy: false, segmentsFed: 2, useTimeshiftBuffer: true,
      videoCopy: true }), true);
    assert.equal(shouldEscalateCopyToTranscode({ copyFailure: true, elapsedMs: 8001, escalatedFromCopy: false, segmentsFed: 2, useTimeshiftBuffer: true,
      videoCopy: true }), false);
  });

  test("rejects escalation after the window, when already escalated, or when not on copy", () => {

    assert.equal(shouldEscalateCopyToTranscode({ copyFailure: true, elapsedMs: VIDEO_COPY_ESCALATION_WINDOW_MS + 1, escalatedFromCopy: false, segmentsFed: 2,
      useTimeshiftBuffer: true, videoCopy: true }), false);
    assert.equal(shouldEscalateCopyToTranscode({ copyFailure: true, elapsedMs: 500, escalatedFromCopy: true, segmentsFed: 2, useTimeshiftBuffer: true,
      videoCopy: true }), false);
    assert.equal(shouldEscalateCopyToTranscode({ copyFailure: true, elapsedMs: 500, escalatedFromCopy: false, segmentsFed: 2, useTimeshiftBuffer: true,
      videoCopy: false }), false);
  });

  test("allows TSB copy escalation with zero segments during the early-session grace", () => {

    assert.equal(shouldEscalateCopyToTranscode({ copyFailure: true, elapsedMs: 1500, escalatedFromCopy: false, segmentsFed: 0, useTimeshiftBuffer: true,
      videoCopy: true }), true);
  });
});

describe("establishment copy-failure wiring", () => {

  test("matches the registered video FFmpeg for escalation including pre-establishment registration", () => {

    const ffmpeg = { id: "ffmpeg" };

    assert.equal(matchesSessionVideoFfmpegForEscalation(ffmpeg, ffmpeg), true);
    assert.equal(matchesSessionVideoFfmpegForEscalation(ffmpeg, { id: "other" }), false);
    assert.equal(matchesSessionVideoFfmpegForEscalation(undefined, ffmpeg), false);
  });

  test("escalates an eligible early TSB copy failure instead of tearing down", () => {

    const eligible = shouldEscalateCopyToTranscode({ copyFailure: true, elapsedMs: 1500, escalatedFromCopy: false, segmentsFed: 0, useTimeshiftBuffer: true,
      videoCopy: true });

    assert.equal(eligible, true);
    assert.equal(resolveVideoCopyExitBridgeAction({ copyEscalationInFlight: false, eligibleForEscalation: eligible, exitIsReplaced: false,
      sessionStillOwned: true }), "escalate");
  });

  test("tears down a non-eligible early copy failure cleanly", () => {

    const eligible = shouldEscalateCopyToTranscode({ copyFailure: true, elapsedMs: 5000, escalatedFromCopy: false, segmentsFed: 0, useTimeshiftBuffer: true,
      videoCopy: true });

    assert.equal(eligible, false);
    assert.equal(resolveVideoCopyExitBridgeAction({ copyEscalationInFlight: false, eligibleForEscalation: eligible, exitIsReplaced: false,
      sessionStillOwned: true }), "teardown");
  });

  test("ignores replaced exits and stale session ownership", () => {

    assert.equal(resolveVideoCopyExitBridgeAction({ copyEscalationInFlight: false, eligibleForEscalation: true, exitIsReplaced: true,
      sessionStillOwned: true }), "ignore");
    assert.equal(resolveVideoCopyExitBridgeAction({ copyEscalationInFlight: false, eligibleForEscalation: true, exitIsReplaced: false,
      sessionStillOwned: false }), "ignore");
  });
});

describe("session id reuse lifecycle guards", () => {

  test("a stale dispose does not remove a replacement pending entry", () => {

    const stale = { id: "stale" };
    const replacement = { id: "replacement" };
    const pending = new Map<string, { id: string }>([[ "homekit-1", replacement ]]);

    assert.equal(shouldRemovePendingSessionEntry(pending.get("homekit-1"), stale), false);

    if(shouldRemovePendingSessionEntry(pending.get("homekit-1"), stale)) {

      pending.delete("homekit-1");
    }

    assert.equal(pending.get("homekit-1"), replacement);
    assert.equal(shouldRemovePendingSessionEntry(pending.get("homekit-1"), replacement), true);
  });

  test("a stale dispose does not remove a replacement ongoing entry", () => {

    const staleController = {};
    const replacementController = {};
    const stale = { abortController: staleController };
    const replacement = { abortController: replacementController };
    const ongoing = new Map<string, { abortController: object }>([[ "homekit-1", replacement ]]);

    assert.equal(shouldRemoveOngoingSessionEntry(ongoing.get("homekit-1"), stale), false);

    if(shouldRemoveOngoingSessionEntry(ongoing.get("homekit-1"), stale)) {

      ongoing.delete("homekit-1");
    }

    assert.equal(ongoing.get("homekit-1"), replacement);
    assert.equal(shouldRemoveOngoingSessionEntry(ongoing.get("homekit-1"), replacement), true);
  });

  test("a stale start cannot register or sync into a replacement ongoing slot", () => {

    const staleController = {};
    const replacementController = {};
    const stale = { abortController: staleController };
    const replacement = { abortController: replacementController };

    assert.equal(shouldRegisterOngoingSessionEntry(replacement, stale), false);
    assert.equal(shouldRegisterOngoingSessionEntry(undefined, stale), true);
    assert.equal(shouldRegisterOngoingSessionEntry(replacement, { abortController: replacementController }), true);
  });

  test("stop simulation releases the replacement when stale dispose left maps intact", () => {

    const replacementController = {};
    const replacementSession = { abortController: replacementController };
    const pending = new Map<string, typeof replacementSession>([[ "sess", replacementSession ]]);
    const ongoing = new Map<string, { abortController: object }>([[ "sess", { abortController: replacementController } ]]);

    // Stale establishment failure tries to dispose but must not clear the replacement maps.
    const staleSession = { abortController: {} };

    if(shouldRemovePendingSessionEntry(pending.get("sess"), staleSession)) {

      pending.delete("sess");
    }

    if(shouldRemoveOngoingSessionEntry(ongoing.get("sess"), staleSession)) {

      ongoing.delete("sess");
    }

    assert.equal(pending.get("sess"), replacementSession);
    assert.equal(ongoing.get("sess")?.abortController, replacementController);

    // Later STOP removes only the entry it aborted.
    const stopOngoing = ongoing.get("sess");

    if(stopOngoing && shouldRemoveOngoingSessionEntry(ongoing.get("sess"), stopOngoing)) {

      ongoing.delete("sess");
    }

    assert.equal(ongoing.has("sess"), false);
  });

  test("a stale stop does not delete a replacement ongoing entry", () => {

    const staleController = {};
    const replacementController = {};
    const staleOngoing = { abortController: staleController };
    const replacement = { abortController: replacementController };
    const ongoing = new Map<string, { abortController: object }>([[ "sess", replacement ]]);

    if(shouldRemoveOngoingSessionEntry(ongoing.get("sess"), staleOngoing)) {

      ongoing.delete("sess");
    }

    assert.equal(ongoing.get("sess"), replacement);
    assert.equal(shouldRemoveOngoingSessionEntry(ongoing.get("sess"), replacement), true);
  });

  test("pre-establishment escalation synth refuses a replacement-owned ongoing slot", () => {

    const replacementController = {};
    const pending = { abortController: {} };

    assert.equal(shouldRegisterOngoingSessionEntry({ abortController: replacementController }, pending), false);
  });
});
