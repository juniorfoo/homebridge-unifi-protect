/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved. */
/* eslint-disable camelcase -- HomeKit StartStreamRequest wire field names */
/* eslint-disable sort-imports -- node:test before homebridge-plugin-utils */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { H264Level, H264Profile } from "homebridge-plugin-utils";
import { LIVE_STREAM_RECONFIGURE_TRANSCODE_BITRATE_THRESHOLD_KBPS, homeKitStreamVideoSnapshotFromRequest, isMaterialLiveStreamReconfigure } from
  "./stream-reconfigure.ts";

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
  });
});
