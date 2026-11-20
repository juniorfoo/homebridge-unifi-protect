/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-transcode-policy.ts: Pure copy-first live-video encode decisions, output fps, and copy-failure detection.
 *
 * No FFmpeg, no I/O, no `this` - the live stream delegate injects camera facts and HomeKit request fields, then consumes the mode and logged reason.
 */
import { h264LevelIdcToRank, h264ProfileIdcToRank, parseH264AvcCFromFmp4Init } from "./h264-fmp4-avcc.ts";
import type { Nullable } from "homebridge-plugin-utils";

// HAP `H264Level` ranks this plugin advertises to HomeKit (3.1, 3.2, 4.0).
export const HOMEKIT_H264_MAX_LEVEL_RANK = 2;

// HAP `H264Profile` ranks: 0 baseline, 1 main, 2 high.
export const H264_PROFILE_MAIN = 1;
export const H264_PROFILE_HIGH = 2;

interface H264LevelLimit {

  maxFs: number;
  maxMbs: number;
  rank: number;
}

// ITU-T H.264 Annex A macroblock limits for minimum level estimation from Protect channel geometry (when no bitstream is available yet).
const H264_LEVEL_LIMITS: readonly H264LevelLimit[] = [

  { maxFs: 3600, maxMbs: 108800, rank: 0 },
  { maxFs: 5120, maxMbs: 216000, rank: 1 },
  { maxFs: 8192, maxMbs: 245760, rank: 2 },
  { maxFs: 8704, maxMbs: 522240, rank: 4 },
  { maxFs: 22080, maxMbs: 589824, rank: 5 },
  { maxFs: 36864, maxMbs: 983040, rank: 6 }
];

export interface LiveVideoEncodeInput {

  crop: boolean;
  forceTranscodeDueToUserOption: boolean;
  homeKitH264Level: number;
  homeKitH264Profile: number;
  isHighLatency: boolean;
  requestFps: number;
  requestHeight: number;
  requestWidth: number;
  sourceFps: number;
  sourceDeclaredH264Known: boolean;
  sourceDeclaredH264Level?: number;
  sourceDeclaredH264Profile?: number;
  sourceHeight: number;
  sourceWidth: number;
  videoCodec: string;
}

export type LiveVideoEncodeMode = "copy" | "transcode";

export interface LiveVideoEncodeDecision {

  logReason?: string;
  mode: LiveVideoEncodeMode;
}

// Substrings that indicate an H.264 copy path failed and a transcode retry is warranted. Generic demux errors are excluded (too many false positives).
export const VIDEO_COPY_FAILURE_PATTERNS: readonly string[] = [

  "Could not write header for output file",
  "Error initializing output stream",
  "Error while opening encoder for output stream",
  "Could not find a valid video bitstream filter",
  "Failed to inject global side data",
  "Bitrate not supported by the encoder",
  "dimensions not set",
  "Non-existing PPS 0 referenced"
];

export function classifyVideoCopyFailure(stderrLog: readonly string[]): boolean {

  return stderrLog.some((line) => VIDEO_COPY_FAILURE_PATTERNS.some((pattern) => line.includes(pattern)));
}

export function estimateH264MinLevelRank(width: number, height: number, fps: number): number {

  const frameMacroblocks = Math.ceil(width / 16) * Math.ceil(height / 16);
  const macroblocksPerSecond = frameMacroblocks * fps;

  for(const limit of H264_LEVEL_LIMITS) {

    if((frameMacroblocks <= limit.maxFs) && (macroblocksPerSecond <= limit.maxMbs)) {

      return limit.rank;
    }
  }

  return H264_LEVEL_LIMITS.length;
}

export function assessH264CopyProfileLevel(input: { homeKitH264Level: number; homeKitH264Profile: number; sourceFps: number; sourceDeclaredH264Known: boolean;
  sourceDeclaredH264Level?: number; sourceDeclaredH264Profile?: number; sourceHeight: number; sourceWidth: number; }): { compatible: boolean; logReason?: string } {

  if(!input.sourceDeclaredH264Known) {

    return { compatible: false, logReason: "declared H.264 parameters unknown" };
  }

  if((input.sourceDeclaredH264Profile === undefined) || (input.sourceDeclaredH264Level === undefined)) {

    return { compatible: false, logReason: "declared H.264 parameters unknown" };
  }

  if(input.sourceDeclaredH264Profile !== input.homeKitH264Profile) {

    return { compatible: false, logReason: "declared H.264 profile does not match the HomeKit negotiation" };
  }

  if(input.sourceDeclaredH264Level > input.homeKitH264Level) {

    return { compatible: false, logReason: "declared H.264 level exceeds the HomeKit-negotiated level" };
  }

  const sourceLevelRank = estimateH264MinLevelRank(input.sourceWidth, input.sourceHeight, input.sourceFps);

  if(sourceLevelRank > HOMEKIT_H264_MAX_LEVEL_RANK) {

    return { compatible: false, logReason: "source H.264 level exceeds HomeKit's supported maximum" };
  }

  if(sourceLevelRank > input.homeKitH264Level) {

    return { compatible: false, logReason: "source H.264 level exceeds the HomeKit-negotiated level" };
  }

  return { compatible: true };
}

/** Parse fMP4 init (timeshift buffer path) into HAP profile/level ranks; unknown on missing or bad data. */
export function resolveDeclaredH264FromFmp4Init(initData: Nullable<Buffer>,
  parseInit: (data: Buffer) => ReturnType<typeof parseH264AvcCFromFmp4Init> = parseH264AvcCFromFmp4Init): { sourceDeclaredH264Known: boolean;
  sourceDeclaredH264Level?: number; sourceDeclaredH264Profile?: number; } {

  if(!initData) {

    return { sourceDeclaredH264Known: false };
  }

  let parsed: ReturnType<typeof parseH264AvcCFromFmp4Init>;

  try {

    parsed = parseInit(initData);
  } catch {

    return { sourceDeclaredH264Known: false };
  }

  if(!parsed.known) {

    return { sourceDeclaredH264Known: false };
  }

  const sourceDeclaredH264Profile = h264ProfileIdcToRank(parsed.profileIdc);
  const sourceDeclaredH264Level = h264LevelIdcToRank(parsed.levelIdc);

  if((sourceDeclaredH264Profile === undefined) || (sourceDeclaredH264Level === undefined)) {

    return { sourceDeclaredH264Known: false };
  }

  return {

    sourceDeclaredH264Known: true,
    sourceDeclaredH264Level: sourceDeclaredH264Level,
    sourceDeclaredH264Profile: sourceDeclaredH264Profile
  };
}

export type LiveStreamSessionSource = "buffer" | "bufferDegraded" | "rtsp" | "unavailable";

/** Merge session-source rules: only the running timeshift buffer supplies a trusted declared profile/level from fMP4 init. */
export function resolveLiveStreamDeclaredH264ForSource(source: LiveStreamSessionSource,
  fmp4InitSegmentData: Nullable<Buffer>): { sourceDeclaredH264Known: boolean; sourceDeclaredH264Level?: number; sourceDeclaredH264Profile?: number } {

  if(source !== "buffer") {

    return { sourceDeclaredH264Known: false };
  }

  return resolveDeclaredH264FromFmp4Init(fmp4InitSegmentData);
}

/** Upstream force-transcode gate: explicit Video.Transcode at home, or explicit Video.Transcode.HighLatency when packet_time marks high latency. */
export function resolveForceTranscodeDueToUserOption(hasVideoTranscode: boolean, isHighLatency: boolean, hasVideoTranscodeHighLatency: boolean): boolean {

  return hasVideoTranscode || (isHighLatency && hasVideoTranscodeHighLatency);
}

export function isLiveSourceFpsKnown(sourceFps: number): boolean {

  return Number.isFinite(sourceFps) && (sourceFps > 0);
}

/** Policy-facing source fps: finite strictly-positive values pass through; unknown is **0** (non-finite or <= 0). */
export function normalizeLiveSourceFps(sourceFps: number): number {

  return isLiveSourceFpsKnown(sourceFps) ? sourceFps : 0;
}

/** Apple Silicon minterpolate: only when the platform gate is on and the source rate is known and not below the HomeKit request. */
export function resolveLiveStreamInterpolationActive(platformInterpolationEnabled: boolean, sourceFps: number, requestedFps: number): boolean {

  const normalizedSourceFps = normalizeLiveSourceFps(sourceFps);

  return platformInterpolationEnabled && isLiveSourceFpsKnown(normalizedSourceFps) && (normalizedSourceFps >= requestedFps);
}

/** Live transcode output fps: request when source is unknown; source when below request; otherwise the request (never upsample). */
export function resolveStreamOutputFps(input: { requestedFps: number; sourceFps: number }): number {

  const normalizedSourceFps = normalizeLiveSourceFps(input.sourceFps);

  if(!isLiveSourceFpsKnown(normalizedSourceFps)) {

    return input.requestedFps;
  }

  if(normalizedSourceFps < input.requestedFps) {

    return normalizedSourceFps;
  }

  return input.requestedFps;
}

export function decideLiveVideoEncode(input: LiveVideoEncodeInput): LiveVideoEncodeDecision {

  if(input.forceTranscodeDueToUserOption) {

    return { logReason: input.isHighLatency ? "Video.Transcode.HighLatency is enabled" : "Video.Transcode is enabled", mode: "transcode" };
  }

  if(input.videoCodec !== "h264") {

    return { logReason: "input codec is not H.264", mode: "transcode" };
  }

  if(input.crop) {

    return { logReason: "video crop is enabled", mode: "transcode" };
  }

  if((input.sourceWidth !== input.requestWidth) || (input.sourceHeight !== input.requestHeight)) {

    return { logReason: "source resolution does not match the HomeKit request", mode: "transcode" };
  }

  if(!isLiveSourceFpsKnown(input.sourceFps)) {

    return { logReason: "source frame rate is unknown", mode: "transcode" };
  }

  const profileSourceFps = normalizeLiveSourceFps(input.sourceFps);

  if(profileSourceFps > input.requestFps) {

    return { logReason: "source frame rate exceeds the HomeKit request", mode: "transcode" };
  }

  const profileLevel = assessH264CopyProfileLevel({

    homeKitH264Level: input.homeKitH264Level,
    homeKitH264Profile: input.homeKitH264Profile,
    sourceDeclaredH264Known: input.sourceDeclaredH264Known,
    sourceDeclaredH264Level: input.sourceDeclaredH264Level,
    sourceDeclaredH264Profile: input.sourceDeclaredH264Profile,
    sourceFps: profileSourceFps,
    sourceHeight: input.sourceHeight,
    sourceWidth: input.sourceWidth
  });

  if(!profileLevel.compatible) {

    return { logReason: profileLevel.logReason, mode: "transcode" };
  }

  return { mode: "copy" };
}

// How long after session start a copy failure may still trigger an in-session transcode escalation instead of ending the HomeKit session.
export const VIDEO_COPY_ESCALATION_WINDOW_MS = 8000;

export function resolveLiveTranscodeBitrate(input: { homeKitBitrateKbps: number; isHighLatency: boolean; sourceBitrateKbps: number; transcodeBitrateHint: number;
  transcodeHighLatencyBitrateHint: number; }): number {

  let targetBitrate = input.homeKitBitrateKbps;

  if(input.isHighLatency && (input.transcodeHighLatencyBitrateHint > 0)) {

    targetBitrate = input.transcodeHighLatencyBitrateHint;
  } else if(!input.isHighLatency && (input.transcodeBitrateHint > 0)) {

    targetBitrate = input.transcodeBitrateHint;
  }

  if(targetBitrate > input.sourceBitrateKbps) {

    targetBitrate = input.sourceBitrateKbps;
  }

  return targetBitrate;
}

export function shouldEscalateCopyToTranscode(input: { copyFailure: boolean; elapsedMs: number; escalatedFromCopy: boolean; segmentsFed: number;
  useTimeshiftBuffer: boolean; videoCopy: boolean; }): boolean {

  if(!input.videoCopy || input.escalatedFromCopy || !input.copyFailure) {

    return false;
  }

  if(input.elapsedMs > VIDEO_COPY_ESCALATION_WINDOW_MS) {

    return false;
  }

  if(!input.useTimeshiftBuffer) {

    return true;
  }

  // TSB/API: require early feed activity or a very young session so we do not escalate on instant teardown before the pipeline connects.
  return (input.segmentsFed > 0) || (input.elapsedMs < 3000);
}

export function matchesSessionVideoFfmpegForEscalation(registeredVideoFfmpeg: unknown, exitedVideoFfmpeg: unknown): boolean {

  return (registeredVideoFfmpeg !== undefined) && (registeredVideoFfmpeg === exitedVideoFfmpeg);
}

export type VideoCopyExitBridgeAction = "escalate" | "ignore" | "teardown";

export function shouldRemovePendingSessionEntry(mappedSession: unknown, sessionInfo: unknown): boolean {

  return mappedSession === sessionInfo;
}

export function shouldRemoveOngoingSessionEntry(mappedOngoing: { abortController: unknown } | undefined, sessionInfo: { abortController: unknown }): boolean {

  return (mappedOngoing !== undefined) && (mappedOngoing.abortController === sessionInfo.abortController);
}

export function shouldRegisterOngoingSessionEntry(mappedOngoing: { abortController: unknown } | undefined, sessionInfo: { abortController: unknown }): boolean {

  return (mappedOngoing === undefined) || (mappedOngoing.abortController === sessionInfo.abortController);
}

export function resolveVideoCopyExitBridgeAction(input: { copyEscalationInFlight: boolean; eligibleForEscalation: boolean; exitIsReplaced: boolean;
  sessionStillOwned: boolean; }): VideoCopyExitBridgeAction {

  if(input.exitIsReplaced) {

    return "ignore";
  }

  if(!input.sessionStillOwned) {

    return "ignore";
  }

  if(input.eligibleForEscalation && !input.copyEscalationInFlight) {

    return "escalate";
  }

  return "teardown";
}
