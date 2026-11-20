/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved. */
/* eslint-disable camelcase -- HomeKit StartStreamRequest wire field names */
/* eslint-disable sort-imports -- node:test before homebridge-plugin-utils */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { H264Level, H264Profile } from "homebridge-plugin-utils";
import { LIVE_STREAM_RECONFIGURE_TRANSCODE_BITRATE_THRESHOLD_KBPS, homeKitStreamVideoSnapshotFromRequest, isMaterialLiveStreamReconfigure,
  resolveReconfigureMaterialityBaseline, unlinkOnFfmpegExitedSettled } from "./stream-reconfigure.ts";

const baseVideo = {

  fps: 30,
  height: 720,
  level: H264Level.LEVEL3_1,
  max_bit_rate: 300,
  profile: H264Profile.MAIN,
  width: 1280
};

describe("stream-reconfigure", () => {

  test("treats missing previous snapshot as immaterial (no replan)", () => {

    const next = homeKitStreamVideoSnapshotFromRequest(baseVideo);

    assert.deepEqual(isMaterialLiveStreamReconfigure({ next: next, nextEncode: "copy", previous: undefined, previousEncode: undefined }),
      { material: false, reason: "no-running-encode-plan" });
  });

  test("restarts on resolution, fps, profile, level, encode-mode, and transcode bitrate threshold", () => {

    const previous = homeKitStreamVideoSnapshotFromRequest(baseVideo);
    const fpsChange = homeKitStreamVideoSnapshotFromRequest({ ...baseVideo, fps: 15 });

    assert.equal(isMaterialLiveStreamReconfigure({ next: fpsChange, nextEncode: "copy", previous: previous, previousEncode: "copy" }).material, true);

    const immaterialBitrate = homeKitStreamVideoSnapshotFromRequest({

      ...baseVideo,
      max_bit_rate: baseVideo.max_bit_rate + LIVE_STREAM_RECONFIGURE_TRANSCODE_BITRATE_THRESHOLD_KBPS - 1
    });

    assert.equal(isMaterialLiveStreamReconfigure({

      next: immaterialBitrate,
      nextEncode: "transcode",
      previous: previous,
      previousEncode: "transcode"
    }).material, false);

    const materialBitrate = homeKitStreamVideoSnapshotFromRequest({

      ...baseVideo,
      max_bit_rate: baseVideo.max_bit_rate + LIVE_STREAM_RECONFIGURE_TRANSCODE_BITRATE_THRESHOLD_KBPS
    });

    assert.equal(isMaterialLiveStreamReconfigure({

      next: materialBitrate,
      nextEncode: "transcode",
      previous: previous,
      previousEncode: "transcode"
    }).reason, "transcode-bitrate");

    assert.equal(isMaterialLiveStreamReconfigure({

      next: previous,
      nextEncode: "transcode",
      previous: previous,
      previousEncode: "copy"
    }).reason, "encode-mode");

    const copyBitrateBump = homeKitStreamVideoSnapshotFromRequest({ ...baseVideo, max_bit_rate: 900 });

    assert.equal(isMaterialLiveStreamReconfigure({

      next: copyBitrateBump,
      nextEncode: "copy",
      previous: previous,
      previousEncode: "copy"
    }).material, false);

    const appliedTranscode = homeKitStreamVideoSnapshotFromRequest({ ...baseVideo, max_bit_rate: 800 });
    const negotiate750 = homeKitStreamVideoSnapshotFromRequest({ ...baseVideo, max_bit_rate: 750 });

    assert.equal(isMaterialLiveStreamReconfigure({

      next: negotiate750,
      nextEncode: "transcode",
      previous: appliedTranscode,
      previousEncode: "transcode"
    }).material, false);

    const negotiate650 = homeKitStreamVideoSnapshotFromRequest({ ...baseVideo, max_bit_rate: 650 });

    assert.equal(isMaterialLiveStreamReconfigure({

      next: negotiate650,
      nextEncode: "transcode",
      previous: appliedTranscode,
      previousEncode: "transcode"
    }).material, true);
  });

  test("resolveReconfigureMaterialityBaseline uses negotiated rebuild target before applied catches up", () => {

    const applied = homeKitStreamVideoSnapshotFromRequest(baseVideo);
    const inFlightVideo = { ...baseVideo, fps: 15 };
    const restoreVideo = { ...baseVideo, fps: 30 };

    const baseline = resolveReconfigureMaterialityBaseline({

      applied: applied,
      pendingRequestVideo: undefined,
      rebuildRequestVideo: inFlightVideo,
      reconfigureInFlight: false
    });
    const decision = isMaterialLiveStreamReconfigure({

      next: homeKitStreamVideoSnapshotFromRequest(restoreVideo),
      nextEncode: "copy",
      previous: baseline,
      previousEncode: "copy"
    });

    assert.equal(decision.material, true, "restore to 30 fps must be material vs negotiated 15 fps before ready, even if applied is still 30");
  });

  test("resolveReconfigureMaterialityBaseline uses in-flight target while replan is pending", () => {

    const applied = homeKitStreamVideoSnapshotFromRequest(baseVideo);
    const inFlightVideo = { ...baseVideo, fps: 15 };
    const restoreVideo = { ...baseVideo, fps: 30 };

    const baseline = resolveReconfigureMaterialityBaseline({

      applied: applied,
      pendingRequestVideo: undefined,
      rebuildRequestVideo: inFlightVideo,
      reconfigureInFlight: true
    });
    const decision = isMaterialLiveStreamReconfigure({

      next: homeKitStreamVideoSnapshotFromRequest(restoreVideo),
      nextEncode: "copy",
      previous: baseline,
      previousEncode: "copy"
    });

    assert.equal(decision.material, true, "restore to 30 fps must be material vs in-flight 15 fps, not applied 30 fps");
  });

  test("unlinkOnFfmpegExitedSettled does not leave rejected exited promises unhandled", async () => {

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {

      unhandled.push(reason);
    };

    process.on("unhandledRejection", onUnhandled);

    try {

      let unlinked = false;

      unlinkOnFfmpegExitedSettled(Promise.reject(new Error("exited failed")), () => {

        unlinked = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(unhandled.length, 0);
      assert.equal(unlinked, true);
    } finally {

      process.off("unhandledRejection", onUnhandled);
    }
  });
});
