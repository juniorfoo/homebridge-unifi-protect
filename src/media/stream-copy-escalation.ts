/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-copy-escalation.ts: In-session copy-to-transcode replacement (spawn-injectable for effect tests).
 */
/* eslint-disable sort-imports -- type and value imports from the same package stay paired */
import type { BackpressureWriter, FfmpegStreamingProcess, HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { HbpuAbortError } from "homebridge-plugin-utils";
import type { StartStreamRequest } from "homebridge";
import type { ChannelProfile } from "./resolution.ts";
import type { LiveTsbFeedState } from "./stream-live-feed.ts";
import { primeLiveFfmpegStdinAfterRespawn } from "./stream-live-feed.ts";
import type { LiveVideoFfmpegSpawnContext } from "./stream-live-ffmpeg-spawn.ts";
import type { LivestreamSubscription } from "./livestream.ts";
import type { HomeKitStreamVideoSnapshot } from "./stream-reconfigure.ts";
import type { LiveStreamSessionSource } from "./stream-transcode-policy.ts";
import { matchesSessionVideoFfmpegForEscalation, shouldRegisterOngoingSessionEntry } from "./stream-transcode-policy.ts";

export interface StreamLiveEncodeRebuild {

  bufferForcedTranscodeReason: string | null;
  channelProfile: ChannelProfile;
  ffmpegArgsThroughVideoMap: string[];
  fmp4InitSegmentData: Buffer | null;
  forceTranscodeDueToUserOption: boolean;
  homeKitVideo: HomeKitStreamVideoSnapshot;
  isHighLatency: boolean;
  preferCopyChannel: boolean;
  request: StartStreamRequest;
  sessionInfo: { abortController: AbortController; addressVersion: "ipv4" | "ipv6"; hasAudioSupport: boolean; videoReturnPort: number };
  sessionSource: LiveStreamSessionSource;
  transcodeTargetBitrate: number;
  useInterpolationFilter: boolean;
  useTsb: boolean;
}

export interface CopyEscalationSessionDiagnostics {

  escalatedFromCopy: boolean;
  hardwareTranscode: boolean;
  liveEncodeRebuild?: StreamLiveEncodeRebuild;
  profile: string;
  transcode: boolean;
  videoCopy: boolean;
}

export interface CopyEscalationOngoingEntry {

  abortController: AbortController;
  ffmpeg: FfmpegStreamingProcess[];
}

export interface CopyEscalationPendingSession {

  abortController: AbortController;
}

export interface CopyEscalationTsbResume {

  feedState: LiveTsbFeedState;
  /** Init plus standing buffer from the last keyframe (when available) for decoder priming after copy exit. */
  keyframePrimingBuffer: Nullable<Buffer>;
  /** Spawn a new writer for the replacement stdin and abandon the prior writer (which may already be failed after copy exit). */
  rotateSegmentWriter: (replacement: FfmpegStreamingProcess) => BackpressureWriter;
  subscription: LivestreamSubscription;
}

export interface CopyEscalationReplaceInput {

  hardwareTranscodes: boolean;
  log: HomebridgePluginLogging;
  onRespawned: (process: FfmpegStreamingProcess) => void;
  ongoingSessions: Map<string, CopyEscalationOngoingEntry>;
  owner: CopyEscalationSessionDiagnostics;
  pendingSessions: Map<string, CopyEscalationPendingSession>;
  prior: FfmpegStreamingProcess;
  sessionDiagnosticsById: Map<string, CopyEscalationSessionDiagnostics>;
  sessionId: string;
  spawnLiveVideo: (ctx: LiveVideoFfmpegSpawnContext, ffmpegAbort: AbortController) => FfmpegStreamingProcess;
  transcodeTargetBitrate: number;
  transcodeReason: string;
  tsbResume?: CopyEscalationTsbResume;
  updateRtspRebuild?: (rebuild: StreamLiveEncodeRebuild) => {
    channelProfile: ChannelProfile;
    ffmpegArgsThroughVideoMap: string[];
    transcodeTargetBitrate: number;
  } | null;
}

/** Replace a failed H.264 copy FFmpeg with a transcode instance without tearing down the HomeKit session. */
export async function replaceFailedCopyWithTranscode(input: CopyEscalationReplaceInput): Promise<FfmpegStreamingProcess | null> {

  const { owner, sessionId } = input;

  if(input.sessionDiagnosticsById.get(sessionId) !== owner) {

    return null;
  }

  const rebuild = owner.liveEncodeRebuild;

  if(!rebuild) {

    return null;
  }

  let ongoing = input.ongoingSessions.get(sessionId);

  if(!ongoing) {

    const pending = input.pendingSessions.get(sessionId);
    const rebuildSession = owner.liveEncodeRebuild?.sessionInfo;

    if(pending && rebuildSession && (pending === rebuildSession)) {

      ongoing = {

        abortController: pending.abortController,
        ffmpeg: [input.prior]
      };

      if(shouldRegisterOngoingSessionEntry(input.ongoingSessions.get(sessionId), pending)) {

        input.ongoingSessions.set(sessionId, ongoing);
      } else {

        return null;
      }
    }
  }

  if(!ongoing || !matchesSessionVideoFfmpegForEscalation(ongoing.ffmpeg[0], input.prior)) {

    return null;
  }

  const ffmpegAbort = new AbortController();

  const sessionSignal = rebuild.sessionInfo.abortController.signal;
  const linkSessionAbort = (): void => {

    if(!ffmpegAbort.signal.aborted) {

      ffmpegAbort.abort(sessionSignal.reason);
    }
  };

  const unlinkSessionAbort = (): void => {

    sessionSignal.removeEventListener("abort", linkSessionAbort);
  };

  if(sessionSignal.aborted) {

    linkSessionAbort();
  } else {

    sessionSignal.addEventListener("abort", linkSessionAbort);
  }

  try {

    input.prior.abort(new HbpuAbortError("replaced"));

    input.log.warn("H.264 copy path failed; escalating to transcode: %s.", input.transcodeReason);

    let channelProfile = rebuild.channelProfile;
    // copy-time argv below is RTSP-only; TSB escalation rebuilds in spawnLiveVideo (stream.ts).
    let ffmpegArgsThroughVideoMap = rebuild.ffmpegArgsThroughVideoMap;
    let transcodeTargetBitrate = rebuild.transcodeTargetBitrate;

    if(!rebuild.useTsb && input.updateRtspRebuild) {

      const updated = input.updateRtspRebuild(rebuild);

      if(!updated) {

        unlinkSessionAbort();

        return null;
      }

      channelProfile = updated.channelProfile;
      ffmpegArgsThroughVideoMap = updated.ffmpegArgsThroughVideoMap;
      transcodeTargetBitrate = updated.transcodeTargetBitrate;
      rebuild.channelProfile = channelProfile;
      rebuild.ffmpegArgsThroughVideoMap = ffmpegArgsThroughVideoMap;
      rebuild.transcodeTargetBitrate = transcodeTargetBitrate;
      owner.profile = channelProfile.name;
    }

    const ffmpegStream = input.spawnLiveVideo({

      channelProfile: channelProfile,
      ffmpegArgsThroughVideoMap: ffmpegArgsThroughVideoMap,
      request: rebuild.request,
      sessionInfo: rebuild.sessionInfo,
      targetBitrate: transcodeTargetBitrate,
      transcodeReason: input.transcodeReason,
      useInterpolationFilter: rebuild.useInterpolationFilter,
      useTsb: rebuild.useTsb
    }, ffmpegAbort);

    if(input.sessionDiagnosticsById.get(sessionId) !== owner) {

      ffmpegStream.abort(new HbpuAbortError("replaced"));
      unlinkSessionAbort();

      return null;
    }

    ongoing.ffmpeg[0] = ffmpegStream;
    owner.escalatedFromCopy = true;
    owner.transcode = true;
    owner.videoCopy = false;
    owner.hardwareTranscode = input.hardwareTranscodes;

    if(input.tsbResume) {

      input.tsbResume.rotateSegmentWriter(ffmpegStream);
      primeLiveFfmpegStdinAfterRespawn(input.tsbResume.feedState, input.tsbResume.subscription, ffmpegStream, input.tsbResume.keyframePrimingBuffer,
        input.log);
    }

    input.onRespawned(ffmpegStream);

    await ffmpegStream.ready;

    if(input.sessionDiagnosticsById.get(sessionId) !== owner) {

      ffmpegStream.abort(new HbpuAbortError("replaced"));
      unlinkSessionAbort();

      return null;
    }

    return ffmpegStream;
  } catch(error) {

    unlinkSessionAbort();

    throw error;
  }
}
