/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-transcode-feature-options.test.ts: Video.Transcode feature-option defaults and stream force-transcode gating via the real FeatureOptions engine.
 */
/* eslint-disable sort-imports */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { FeatureOptions, H264Level, H264Profile } from "homebridge-plugin-utils";
import { featureOptionCategories, featureOptions } from "../options.ts";
import { decideLiveVideoEncode, resolveForceTranscodeDueToUserOption } from "./stream-transcode-policy.ts";
const DEVICE_MAC = "aa:bb:cc:dd:ee:01";
const NVR_MAC = "11:22:33:44:55:66";

function engine(userOptions: string[] = []): FeatureOptions {

  return new FeatureOptions(featureOptionCategories, featureOptions, userOptions);
}

function forceTranscodeDueToUserOption(featureEngine: FeatureOptions, isHighLatency: boolean): boolean {

  return resolveForceTranscodeDueToUserOption(featureEngine.test("Video.Transcode", DEVICE_MAC, NVR_MAC), isHighLatency,
    featureEngine.test("Video.Transcode.HighLatency", DEVICE_MAC, NVR_MAC));
}

/** Geometry and HAP ranks aligned with production (`request.video.level` / `profile`, not numeric 3.1). */
const matchingEncodeInput = {

  crop: false,
  forceTranscodeDueToUserOption: false,
  homeKitH264Level: H264Level.LEVEL3_1,
  homeKitH264Profile: H264Profile.MAIN,
  isHighLatency: false,
  requestFps: 15,
  requestHeight: 720,
  requestWidth: 1280,
  sourceDeclaredH264Known: true,
  sourceDeclaredH264Level: H264Level.LEVEL3_1,
  sourceDeclaredH264Profile: H264Profile.MAIN,
  sourceFps: 15,
  sourceHeight: 720,
  sourceWidth: 1280,
  videoCodec: "h264"
};

describe("Video.Transcode feature options", () => {

  test("catalog default: home copy-first, cellular transcode-by-default", () => {

    const options = engine();

    assert.equal(options.test("Video.Transcode", DEVICE_MAC, NVR_MAC), false);
    assert.equal(options.test("Video.Transcode.HighLatency", DEVICE_MAC, NVR_MAC), true);
    assert.equal(featureOptions["Video"]?.find((entry) => entry.name === "Transcode")?.default, false);
    assert.equal(featureOptions["Video"]?.find((entry) => entry.name === "Transcode.HighLatency")?.default, true);
  });

  test("explicit Enable.Video.Transcode forces transcode at home", () => {

    const options = engine(["Enable.Video.Transcode"]);

    assert.equal(forceTranscodeDueToUserOption(options, false), true);
    assert.deepEqual(decideLiveVideoEncode({ ...matchingEncodeInput, forceTranscodeDueToUserOption: true }),
      { logReason: "Video.Transcode is enabled", mode: "transcode" });
  });

  test("explicit Disable.Video.Transcode keeps home copy when compatible", () => {

    const options = engine(["Disable.Video.Transcode"]);

    assert.equal(forceTranscodeDueToUserOption(options, false), false);
    assert.deepEqual(decideLiveVideoEncode({ ...matchingEncodeInput, forceTranscodeDueToUserOption: false }), { mode: "copy" });
  });

  test("explicit Disable.Video.Transcode.HighLatency allows cellular copy when compatible", () => {

    const options = engine(["Disable.Video.Transcode.HighLatency"]);

    assert.equal(forceTranscodeDueToUserOption(options, true), false);
    assert.deepEqual(decideLiveVideoEncode({ ...matchingEncodeInput, forceTranscodeDueToUserOption: false, isHighLatency: true }), { mode: "copy" });
  });

  test("HomeKit LEVEL3_1 (rank 0) against 1080p15 source transcodes for level, not copy", () => {

    assert.deepEqual(decideLiveVideoEncode({

      ...matchingEncodeInput,
      forceTranscodeDueToUserOption: false,
      homeKitH264Level: H264Level.LEVEL3_1,
      requestFps: 15,
      requestHeight: 1080,
      requestWidth: 1920,
      sourceDeclaredH264Known: true,
      sourceDeclaredH264Level: H264Level.LEVEL3_1,
      sourceDeclaredH264Profile: H264Profile.MAIN,
      sourceFps: 15,
      sourceHeight: 1080,
      sourceWidth: 1920
    }), { logReason: "source H.264 level exceeds the HomeKit-negotiated level", mode: "transcode" });
  });

  test("catalog exposes Video.Transcode.Bitrate without parent gating when Transcode defaults off", () => {

    const bitrate = featureOptions["Video"]?.find((entry) => entry.name === "Transcode.Bitrate");
    const highLatencyBitrate = featureOptions["Video"]?.find((entry) => entry.name === "Transcode.HighLatency.Bitrate");

    assert.ok(bitrate);
    assert.equal(bitrate.group, undefined);
    assert.equal(bitrate.default, true);
    assert.ok((bitrate.defaultValue as number) > 0);

    assert.ok(highLatencyBitrate);
    assert.equal(highLatencyBitrate.group, "Transcode.HighLatency");
  });

  test("resolveForceTranscodeDueToUserOption: Enable.Video.Transcode at home", () => {

    assert.equal(resolveForceTranscodeDueToUserOption(true, false, true), true);
    assert.equal(resolveForceTranscodeDueToUserOption(false, true, true), true);
    assert.equal(resolveForceTranscodeDueToUserOption(false, false, true), false);
  });
});
