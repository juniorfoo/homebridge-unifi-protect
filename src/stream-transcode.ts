/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-transcode.ts: Copy-first transcode and fps selection helpers.
 */
import type { HostProfile } from "./host-profile.js";

export type TranscodeReason = "codec" | "copy" | "crop" | "high-latency" | "user";

export interface TranscodeDecisionInput {

  crop: boolean;
  hostProfile?: HostProfile;
  packetTime: number;
  transcodeFeature: boolean;
  transcodeHighLatency: boolean;
  userForcedTranscode?: boolean;
  videoCodec: string;
}

export interface TranscodeDecision {

  reason: TranscodeReason;
  transcode: boolean;
}

export function isHighLatencyClient(packetTime: number): boolean {

  return packetTime >= 60;
}

export function shouldTranscodeVideo(input: TranscodeDecisionInput): TranscodeDecision {

  if(input.crop) {

    return { reason: "crop", transcode: true };
  }

  if(input.videoCodec !== "h264") {

    return { reason: "codec", transcode: true };
  }

  if(isHighLatencyClient(input.packetTime) && input.transcodeHighLatency) {

    return { reason: "high-latency", transcode: true };
  }

  const copyFirstProfile = (input.hostProfile === "pi") || (input.hostProfile === "software-constrained") || (input.hostProfile === "intel-qsv");

  if(copyFirstProfile) {

    return { reason: "copy", transcode: false };
  }

  if(input.transcodeFeature) {

    return { reason: "user", transcode: true };
  }

  return { reason: "copy", transcode: false };
}

export function resolveOutputFps(sourceFps: number, requestedFps: number, useInterpolationFilter: boolean): number {

  if(useInterpolationFilter) {

    return sourceFps;
  }

  return Math.min(sourceFps, requestedFps);
}

export function formatTranscodeLog(decision: TranscodeDecision): string {

  return decision.transcode ? "Transcoding because: " + decision.reason : "Using copy path";
}
