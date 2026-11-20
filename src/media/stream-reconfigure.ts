/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-reconfigure.ts: HomeKit RECONFIGURE material-change policy for live streaming.
 */
import type { LiveVideoEncodeDecision } from "./stream-transcode-policy.ts";

export interface HomeKitStreamVideoSnapshot {

  fps: number;
  h264Level: number;
  h264Profile: number;
  height: number;
  maxBitRateKbps: number;
  width: number;
}

export interface LiveStreamReconfigureDecision {

  material: boolean;
  reason: string;
}

/** HomeKit passes max_bit_rate in kbps (HAP convention). */
export function homeKitStreamVideoSnapshotFromRequest(video: { fps: number; height: number; level: number; max_bit_rate: number; profile: number;
  width: number; }): HomeKitStreamVideoSnapshot {

  return {

    fps: video.fps,
    h264Level: video.level,
    h264Profile: video.profile,
    height: video.height,
    maxBitRateKbps: video.max_bit_rate,
    width: video.width
  };
}

/** Bitrate deltas below this (kbps) are treated as immaterial while transcoding. */
export const LIVE_STREAM_RECONFIGURE_TRANSCODE_BITRATE_THRESHOLD_KBPS = 100;

export function isMaterialLiveStreamReconfigure(input: { next: HomeKitStreamVideoSnapshot; nextEncode: LiveVideoEncodeDecision["mode"];
  previous: HomeKitStreamVideoSnapshot | undefined; previousEncode: LiveVideoEncodeDecision["mode"] | undefined; }): LiveStreamReconfigureDecision {

  if(!input.previous || !input.previousEncode) {

    return { material: false, reason: "no-running-encode-plan" };
  }

  if((input.previous.width !== input.next.width) || (input.previous.height !== input.next.height) || (input.previous.fps !== input.next.fps)) {

    return { material: true, reason: "resolution-or-fps" };
  }

  if((input.previous.h264Level !== input.next.h264Level) || (input.previous.h264Profile !== input.next.h264Profile)) {

    return { material: true, reason: "h264-negotiation" };
  }

  if(input.previousEncode !== input.nextEncode) {

    return { material: true, reason: "encode-mode" };
  }

  if((input.nextEncode === "transcode") &&
    (Math.abs(input.previous.maxBitRateKbps - input.next.maxBitRateKbps) >= LIVE_STREAM_RECONFIGURE_TRANSCODE_BITRATE_THRESHOLD_KBPS)) {

    return { material: true, reason: "transcode-bitrate" };
  }

  return { material: false, reason: "immaterial" };
}
