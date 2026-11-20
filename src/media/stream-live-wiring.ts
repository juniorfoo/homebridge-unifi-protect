/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-live-wiring.ts: Production wiring helpers used from stream.ts (mutation-tested via imports, not duplicated in tests).
 */
/* eslint-disable sort-imports -- value/type import grouping follows dependency order */
import type { StartStreamRequest } from "homebridge";
import type { BackpressureWriter, FfmpegOptions, FfmpegStreamingProcess, Nullable } from "homebridge-plugin-utils";
import { HOMEKIT_IDR_INTERVAL, isHbpuAbortReason } from "homebridge-plugin-utils";
import type { ProtectCameraHost } from "./camera-host.ts";
import type { CopyEscalationTsbResume } from "./stream-copy-escalation.ts";
import type { ChannelProfile } from "./resolution.ts";
import type { LiveTsbFeedState, TsbSegmentWriterRail } from "./stream-live-feed.ts";
import { rotateBackpressureWriterForCopyEscalation } from "./stream-live-feed.ts";
import { formatResolution } from "./resolution.ts";
import type { LiveStreamSessionSource, LiveVideoEncodeDecision } from "./stream-transcode-policy.ts";
import { classifyVideoCopyFailure, decideLiveVideoEncode, normalizeLiveSourceFps, resolveForceTranscodeDueToUserOption,
  resolveLiveStreamDeclaredH264ForSource, resolveLiveStreamInterpolationActive, resolveLiveTranscodeBitrate, resolveStreamOutputFps,
  resolveVideoCopyExitBridgeAction, shouldEscalateCopyToTranscode } from "./stream-transcode-policy.ts";
import type { ProtectStreamingFfmpegProcess } from "./stream-ffmpeg-process.ts";

export { rotateBackpressureWriterForCopyEscalation };

export function resolveStartStreamForceTranscodeDueToUserOption(protectCamera: ProtectCameraHost, isHighLatency: boolean): boolean {

  return resolveForceTranscodeDueToUserOption(protectCamera.hasFeature("Video.Transcode"), isHighLatency,
    protectCamera.hasFeature("Video.Transcode.HighLatency"));
}

export function resolveStreamEgressBitrateBps(isTranscoding: boolean, transcodeTargetBitrateKbps: number, channelBitrateBps: number): number {

  return isTranscoding ? (transcodeTargetBitrateKbps * 1000) : channelBitrateBps;
}

/** fMP4 init bytes used for the avcC gate must match what will be prepended to FFmpeg (timeshift prefix slice, not the standing buffer alone). */
export function resolveFmp4InitForLiveDeclaredCheck(input: { sessionSource: LiveStreamSessionSource; timeshiftPrefixBuffer: Buffer | null;
}): Buffer | null {

  if(input.sessionSource !== "buffer") {

    return null;
  }

  return input.timeshiftPrefixBuffer;
}

/** Refresh a buffer-backed channel profile from the camera's live channel table (fps/geometry/bitrate). */
export function refreshBufferBackedChannelProfileForEncode(protectCamera: ProtectCameraHost, staleProfile: ChannelProfile): ChannelProfile | null {

  const liveChannel = protectCamera.ufp.channels.find((channel) => channel.id === staleProfile.channel.id);

  if(!liveChannel) {

    return null;
  }

  return {

    channel: liveChannel,
    lens: staleProfile.lens,
    name: formatResolution([ liveChannel.width, liveChannel.height, liveChannel.fps ]) + " (" + liveChannel.name + ")",
    resolution: [ liveChannel.width, liveChannel.height, liveChannel.fps ],
    url: staleProfile.url
  };
}

export interface TimeshiftBufferChannelResolution {

  encodeProfile: ChannelProfile;
  forcedTranscodeReason: string | null;
  subscriptionProfile: ChannelProfile;
}

function channelGeometryDiffers(bufferChannel: ChannelProfile["channel"], liveChannel: ChannelProfile["channel"]): boolean {

  return (bufferChannel.fps !== liveChannel.fps) || (bufferChannel.width !== liveChannel.width) || (bufferChannel.height !== liveChannel.height);
}

/**
 * Bind TSB livestream + encode facts to the timeshift buffer's channel. Never substitute selectChannel when the buffer profile's live row is missing or the standing
 * buffer geometry differs from live ufp.channels (prefix bytes remain from buffer start).
 */
export function resolveTimeshiftBufferLiveChannel(bufferProfile: ChannelProfile, protectCamera: ProtectCameraHost): TimeshiftBufferChannelResolution {

  const refreshed = refreshBufferBackedChannelProfileForEncode(protectCamera, bufferProfile);

  if(!refreshed) {

    return {

      encodeProfile: bufferProfile,
      forcedTranscodeReason: "live ufp.channels missing buffer channel id",
      subscriptionProfile: bufferProfile
    };
  }

  if(channelGeometryDiffers(bufferProfile.channel, refreshed.channel)) {

    return {

      encodeProfile: refreshed,
      forcedTranscodeReason: "timeshift buffer geometry differs from live channel (stale prefix)",
      subscriptionProfile: bufferProfile
    };
  }

  return {

    encodeProfile: refreshed,
    forcedTranscodeReason: null,
    subscriptionProfile: refreshed
  };
}

export function buildLiveVideoEncodeInput(protectCamera: ProtectCameraHost, request: StartStreamRequest, profile: ChannelProfile, isHighLatency: boolean,
  forceTranscodeDueToUserOption: boolean, sessionSource: LiveStreamSessionSource, fmp4InitSegmentData: Buffer | null): Parameters<typeof decideLiveVideoEncode>[0] {

  const declared = resolveLiveStreamDeclaredH264ForSource(sessionSource, fmp4InitSegmentData);

  return {

    crop: protectCamera.hints.crop,
    forceTranscodeDueToUserOption: forceTranscodeDueToUserOption,
    homeKitH264Level: request.video.level,
    homeKitH264Profile: request.video.profile,
    isHighLatency: isHighLatency,
    requestFps: request.video.fps,
    requestHeight: request.video.height,
    requestWidth: request.video.width,
    sourceDeclaredH264Known: declared.sourceDeclaredH264Known,
    sourceDeclaredH264Level: declared.sourceDeclaredH264Level,
    sourceDeclaredH264Profile: declared.sourceDeclaredH264Profile,
    sourceFps: profile.channel.fps,
    sourceHeight: profile.channel.height,
    sourceWidth: profile.channel.width,
    videoCodec: protectCamera.ufp.videoCodec
  };
}

export function resolveLiveTranscodeTargetBitrate(protectCamera: ProtectCameraHost, request: StartStreamRequest, profile: ChannelProfile,
  isHighLatency: boolean, targetBitrateKbps: number): number {

  return resolveLiveTranscodeBitrate({

    homeKitBitrateKbps: targetBitrateKbps,
    isHighLatency: isHighLatency,
    sourceBitrateKbps: profile.channel.bitrate / 1000,
    transcodeBitrateHint: protectCamera.hints.transcodeBitrate,
    transcodeHighLatencyBitrateHint: protectCamera.hints.transcodeHighLatencyBitrate
  });
}

export function shouldSubstituteSelectChannelForSession(useTsb: boolean, sessionSource: LiveStreamSessionSource, channelProfile: ChannelProfile | null,
  standingTimeshiftPrefix: boolean): boolean {

  return !useTsb || ((sessionSource === "bufferDegraded") && !channelProfile && !standingTimeshiftPrefix);
}

export function resolveCopyEscalationKeyframePrimingBuffer(bufferProfile: ChannelProfile | null | undefined, liveProfile: ChannelProfile | null | undefined,
  trailingFromLastKeyframe: Nullable<Buffer>, pooledLiveAndBuffer: boolean): Nullable<Buffer> {

  if(!bufferProfile || !liveProfile || !pooledLiveAndBuffer) {

    return null;
  }

  const channelMatches = (bufferProfile.channel.id === liveProfile.channel.id) && (bufferProfile.lens === liveProfile.lens);

  return channelMatches ? trailingFromLastKeyframe : null;
}

export function createCopyEscalationTsbResume(input: { feedState: LiveTsbFeedState; keyframePrimingBuffer?: Nullable<Buffer>;
  rail: TsbSegmentWriterRail; subscription: CopyEscalationTsbResume["subscription"]; }): CopyEscalationTsbResume {

  return {

    feedState: input.feedState,
    keyframePrimingBuffer: input.keyframePrimingBuffer ?? null,
    rotateSegmentWriter: (replacement: FfmpegStreamingProcess): BackpressureWriter => input.rail.rotateSegmentWriter(replacement),
    subscription: input.subscription
  };
}

export function appendLiveVideoEncodeToFfmpegArgs(ffmpegOptions: FfmpegOptions, ffmpegArgs: string[], encodeDecision: LiveVideoEncodeDecision,
  channelProfile: ChannelProfile, request: StartStreamRequest, targetBitrate: number, useInterpolationFilter: boolean, useTsb: boolean): void {

  // Check to see if we're transcoding. If we are, set the right FFmpeg encoder options. If not, copy the video stream.
  if(encodeDecision.mode === "copy") {

    // Configure our video parameters for just copying the input stream from Protect - it tends to be quite solid in most cases:
    //
    // -codec:v copy                  Copy the stream without reencoding it.
    ffmpegArgs.push(

      "-codec:v", "copy"
    );

    if(useTsb) {

      // The livestream API needs to be transmuxed before we use it directly.
      //
      // -bsf:v h264_mp4toannexb    Convert the livestream container format from MP4 to MPEG-TS.
      ffmpegArgs.push("-bsf:v", "h264_mp4toannexb");
    }

    return;
  }

  // Configure our video parameters for transcoding.
  const requestedFps = request.video.fps;
  const rawSourceFps = channelProfile.channel.fps;
  const policySourceFps = normalizeLiveSourceFps(rawSourceFps);
  const useInterpolation = resolveLiveStreamInterpolationActive(useInterpolationFilter, rawSourceFps, requestedFps);
  const outputFps = resolveStreamOutputFps({ requestedFps: requestedFps, sourceFps: rawSourceFps });
  const encoderFps = useInterpolation ? policySourceFps : outputFps;
  const encoderInputFps = policySourceFps;

  ffmpegArgs.push(...ffmpegOptions.streamEncoder({

    bitrate: targetBitrate,
    fps: encoderFps,
    height: request.video.height,
    idrInterval: HOMEKIT_IDR_INTERVAL,
    inputFps: encoderInputFps,
    level: request.video.level,
    profile: request.video.profile,
    // When interpolating, hand the encoder the fps and interpolation filters to smooth the presentation timestamps; it composes them into its own chain and bridges
    // any GPU-to-CPU download transfer itself.
    ...(useInterpolation ? { videoFilters: [ "fps=" + requestedFps.toString(),
      "minterpolate=fps=" + requestedFps.toString() + ":mi_mode=mci:mc_mode=aobmc:me=fss:me_mode=bidir:vsbmc=1:scd=none" ] } : {}),
    width: request.video.width
  }));
}

/** Mirrors startStream channel reselect + copy-first encode (before spawn). */
export function resolveStartStreamEncodePlan(input: { bufferForcedTranscodeReason?: string | null; channelProfile: ChannelProfile;
  ffmpegOptions: FfmpegOptions; fmp4InitSegmentData: Buffer | null; forceTranscodeDueToUserOption: boolean; homeKitBitrateKbps?: number; isHighLatency: boolean;
  preferCopyChannel: boolean; protectCamera: ProtectCameraHost; request: StartStreamRequest; sessionSource: LiveStreamSessionSource; useTsb: boolean; }): {

  channelProfile: ChannelProfile;
  declaredForLog: ReturnType<typeof buildLiveVideoEncodeInput>;
  encodeDecision: LiveVideoEncodeDecision;
  encoderBitrate: number;
  isTranscoding: boolean;
  targetBitrate: number;
  transcodeReselectMissing: boolean;
  transcodeTargetBitrate: number;
} {

  let channelProfile = input.channelProfile;
  let targetBitrate = input.homeKitBitrateKbps ?? input.request.video.max_bit_rate;

  const buildEncodeInput = (profile: ChannelProfile): ReturnType<typeof buildLiveVideoEncodeInput> => buildLiveVideoEncodeInput(
    input.protectCamera, input.request, profile, input.isHighLatency, input.forceTranscodeDueToUserOption, input.sessionSource, input.fmp4InitSegmentData);

  let encodeDecision = decideLiveVideoEncode(buildEncodeInput(channelProfile));
  const declaredForLog = buildEncodeInput(channelProfile);

  if(input.bufferForcedTranscodeReason) {

    encodeDecision = { logReason: input.bufferForcedTranscodeReason, mode: "transcode" };
  }

  let transcodeReselectMissing = false;

  if((encodeDecision.mode === "transcode") && input.preferCopyChannel && !input.useTsb) {

    const usesHardwareEncoder = input.ffmpegOptions.hardwareEncodes("stream");

    const transcodeSource = input.protectCamera.selectChannel(
      usesHardwareEncoder ? 3840 : input.request.video.width,
      usesHardwareEncoder ? 2160 : input.request.video.height,
      { bias: "higher", maxPixels: input.ffmpegOptions.maxSourcePixels("stream") }
    );

    if(!transcodeSource) {

      transcodeReselectMissing = true;
    } else {

      channelProfile = transcodeSource;
      targetBitrate = resolveLiveTranscodeBitrate({

        homeKitBitrateKbps: input.request.video.max_bit_rate,
        isHighLatency: input.isHighLatency,
        sourceBitrateKbps: channelProfile.channel.bitrate / 1000,
        transcodeBitrateHint: input.protectCamera.hints.transcodeBitrate,
        transcodeHighLatencyBitrateHint: input.protectCamera.hints.transcodeHighLatencyBitrate
      });

      encodeDecision = decideLiveVideoEncode(buildEncodeInput(channelProfile));
    }
  }

  const transcodeTargetBitrate = resolveLiveTranscodeBitrate({

    homeKitBitrateKbps: targetBitrate,
    isHighLatency: input.isHighLatency,
    sourceBitrateKbps: channelProfile.channel.bitrate / 1000,
    transcodeBitrateHint: input.protectCamera.hints.transcodeBitrate,
    transcodeHighLatencyBitrateHint: input.protectCamera.hints.transcodeHighLatencyBitrate
  });

  const isTranscoding = encodeDecision.mode === "transcode";
  const encoderBitrate = isTranscoding ? transcodeTargetBitrate : targetBitrate;

  return {

    channelProfile: channelProfile,
    declaredForLog: declaredForLog,
    encodeDecision: encodeDecision,
    encoderBitrate: encoderBitrate,
    isTranscoding: isTranscoding,
    targetBitrate: targetBitrate,
    transcodeReselectMissing: transcodeReselectMissing,
    transcodeTargetBitrate: transcodeTargetBitrate
  };
}

export function classifyLiveCopyEscalationEligible(input: { elapsedMs: number; escalatedFromCopy: boolean; segmentsFed: number; stderrLog: readonly string[];
  useTimeshiftBuffer: boolean; videoCopy: boolean; }): boolean {

  return shouldEscalateCopyToTranscode({

    copyFailure: classifyVideoCopyFailure(input.stderrLog),
    elapsedMs: input.elapsedMs,
    escalatedFromCopy: input.escalatedFromCopy,
    segmentsFed: input.segmentsFed,
    useTimeshiftBuffer: input.useTimeshiftBuffer,
    videoCopy: input.videoCopy
  });
}

export interface LiveFfmpegCopyExitBridgeInput {

  copyEscalationInFlightRef: { current: boolean };
  createTsbResume: () => CopyEscalationTsbResume | undefined;
  endFfmpegBridge: (exitedProcess: ProtectStreamingFfmpegProcess, ffmpegExitCode?: number | null) => void;
  escalateCopyFailure: (exitedProcess: ProtectStreamingFfmpegProcess, onRespawned: (respawned: ProtectStreamingFfmpegProcess) => void,
    tsbResume: CopyEscalationTsbResume | undefined) => Promise<ProtectStreamingFfmpegProcess | null>;
  onRespawned: (respawned: ProtectStreamingFfmpegProcess) => void;
  sessionDiagnostics: { escalatedFromCopy: boolean; segmentsFed: number; videoCopy: boolean };
  sessionStartedAt: number;
  sessionStillOwned: () => boolean;
  useTsb: boolean;
}

/** Factory for the started-then-died FFmpeg exit bridge used in startStream (mutation-tested). */
export function createLiveFfmpegCopyExitBridge(input: LiveFfmpegCopyExitBridgeInput): {

  bridgeFfmpegExit: (exitedProcess: ProtectStreamingFfmpegProcess, ffmpegExitCode?: number | null) => void;
  wireFfmpegExitBridge: (process: ProtectStreamingFfmpegProcess) => void;
} {

  const bridgeFfmpegExit = (exitedProcess: ProtectStreamingFfmpegProcess, ffmpegExitCode?: number | null): void => {

    const elapsedMs = Date.now() - input.sessionStartedAt;
    const eligibleForEscalation = classifyLiveCopyEscalationEligible({

      elapsedMs: elapsedMs, escalatedFromCopy: input.sessionDiagnostics.escalatedFromCopy, segmentsFed: input.sessionDiagnostics.segmentsFed,
      stderrLog: exitedProcess.stderrLog, useTimeshiftBuffer: input.useTsb, videoCopy: input.sessionDiagnostics.videoCopy
    });
    const bridgeAction = resolveVideoCopyExitBridgeAction({ copyEscalationInFlight: input.copyEscalationInFlightRef.current,
      eligibleForEscalation: eligibleForEscalation, exitIsReplaced: isHbpuAbortReason(exitedProcess.signal.reason, "replaced"),
      sessionStillOwned: input.sessionStillOwned() });

    if(bridgeAction === "ignore") {

      return;
    }

    if(bridgeAction === "escalate") {

      input.copyEscalationInFlightRef.current = true;

      const tsbResume = input.createTsbResume();

      void input.escalateCopyFailure(exitedProcess, (respawned) => {

        input.onRespawned(respawned);
        wireFfmpegExitBridge(respawned);
      }, tsbResume).then((respawned) => {

        if(!respawned && input.sessionStillOwned()) {

          input.copyEscalationInFlightRef.current = false;
          input.endFfmpegBridge(exitedProcess, ffmpegExitCode);
        }
      }, () => {

        if(input.sessionStillOwned()) {

          input.copyEscalationInFlightRef.current = false;
          input.endFfmpegBridge(exitedProcess, ffmpegExitCode);
        }
      });

      return;
    }

    input.endFfmpegBridge(exitedProcess, ffmpegExitCode);
  };

  const wireFfmpegExitBridge = (process: ProtectStreamingFfmpegProcess): void => {

    void process.exited.then((exitInfo) => bridgeFfmpegExit(process, exitInfo.exitCode), () => bridgeFfmpegExit(process));
  };

  return { bridgeFfmpegExit: bridgeFfmpegExit, wireFfmpegExitBridge: wireFfmpegExitBridge };
}

export function formatLiveEncodeDecisionLog(encodeDecision: LiveVideoEncodeDecision, declared: { sourceDeclaredH264Known: boolean;
  sourceDeclaredH264Level?: number; sourceDeclaredH264Profile?: number; }): string {

  const declaredLabel = declared.sourceDeclaredH264Known ?
    "profile rank " + String(declared.sourceDeclaredH264Profile) + ", level rank " + String(declared.sourceDeclaredH264Level) :
    "unknown";

  return "H.264 source " + declaredLabel + " -> " + encodeDecision.mode + (encodeDecision.logReason ? (" (" + encodeDecision.logReason + ")") : "");
}
