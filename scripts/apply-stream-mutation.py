#!/usr/bin/env python3
import pathlib
import sys

from mutation_apply import apply_unique

ROOT = pathlib.Path(__file__).resolve().parent.parent
STREAM = ROOT / "src/media/stream.ts"

G4A_OLD = "const tsBuffer: Nullable<Buffer> = useTsb ? (this.timeshift?.buffer.getLast(PROTECT_LIVESTREAM_API_IDR_INTERVAL * 1000) ?? null) : null;"
G4A_NEW = "const tsBuffer: Nullable<Buffer> = null;"

MUTATIONS: dict[str, tuple[str, str]] = {
    "D1": (
        "onRotateSegmentWriter: this.streamTestOptions?.onRotateSegmentWriter,",
        "onRotateSegmentWriter: undefined,",
    ),
    "G4a": (G4A_OLD, G4A_NEW),
    "D1b": (
        """        return createCopyEscalationTsbResume({

          feedState: tsbFeedState,
          keyframePrimingBuffer: keyframePrimingBuffer,
          rail: tsbWriterRail,
          subscription: subscription
        });""",
        "        return undefined;",
    ),
    "R5_callsite": (
        """      case "bufferDegraded": {

        useTsb = true;
        const bufferProfile = this.timeshift?.buffer.channelProfile ?? this.protectCamera.selectSubstrateChannel();

        if(bufferProfile) {

          const resolved = resolveTimeshiftBufferLiveChannel(bufferProfile, this.protectCamera);

          subscriptionChannelProfile = resolved.subscriptionProfile;
          channelProfile = resolved.encodeProfile;
          bufferForcedTranscodeReason = resolved.forcedTranscodeReason;
        } else {

          channelProfile = null;
        }

        break;
      }""",
        """      case "bufferDegraded": {

        useTsb = true;
        const bufferProfile = this.timeshift?.buffer.channelProfile ?? this.protectCamera.selectSubstrateChannel();

        if(bufferProfile) {

          subscriptionChannelProfile = bufferProfile;
          channelProfile = bufferProfile;
          bufferForcedTranscodeReason = null;
        } else {

          channelProfile = null;
        }

        break;
      }""",
    ),
    "PM4": (
        "        const keyframePrimingBuffer = resolveCopyEscalationKeyframePrimingBuffer(bufferProfile, liveProfile,",
        "        const keyframePrimingBuffer = resolveCopyEscalationKeyframePrimingBuffer(bufferProfile, bufferProfile,",
    ),
    "BD5": (
        "    if(shouldSubstituteSelectChannelForSession(useTsb, decision.source, channelProfile, standingTimeshiftPrefix)) {",
        "    if(shouldSubstituteSelectChannelForSession(useTsb, decision.source, channelProfile, false)) {",
    ),
    "PM5": (
        "        const liveProfile = subscriptionChannelProfile ?? channelProfile;",
        "        const liveProfile = channelProfile;",
    ),
    "BD7": (
        """        const transcodeChannel = channelProfile ??= this.protectCamera.selectChannel(
          usesHardwareEncoder ? 3840 : request.video.width,
          usesHardwareEncoder ? 2160 : request.video.height,
          { biasHigher: true, maxPixels: this.ffmpegOptions.maxSourcePixels("stream") }
        );""",
        """        const transcodeChannel = channelProfile ??= this.protectCamera.selectChannel(
          request.video.width,
          request.video.height,
          { maxPixels: this.ffmpegOptions.maxSourcePixels("stream") }
        );""",
    ),
    "K2": (
        """      escalateCopyFailure: (exitedProcess, onRespawned, tsbResume) => this.escalateCopyFailureToTranscode(request.sessionID, sessionDiagnostics, exitedProcess,
        "H.264 copy path failed at runtime", onRespawned, tsbResume),""",
        "      escalateCopyFailure: async () => null,",
    ),
    "BD6r": (
        "      if(preferCopyChannel) {",
        "      if(preferCopyChannel && (decision.source !== \"bufferDegraded\")) {",
    ),
}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <{'|'.join(MUTATIONS)}>")
    mut_id = sys.argv[1]
    if mut_id not in MUTATIONS:
        raise SystemExit(f"unknown mutation {mut_id}")
    old, new = MUTATIONS[mut_id]
    text = STREAM.read_text()
    STREAM.write_text(apply_unique(text, old, new, mut_id))


if __name__ == "__main__":
    main()