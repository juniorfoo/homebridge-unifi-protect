#!/usr/bin/env python3
import pathlib
import sys

from mutation_apply import apply_unique

ROOT = pathlib.Path(__file__).resolve().parent.parent
WIRING = ROOT / "src/media/stream-live-wiring.ts"

MUTATIONS = {
    "R3": (
        'forcedTranscodeReason: "live ufp.channels missing buffer channel id"',
        "forcedTranscodeReason: null",
    ),
    "R5": (
        'forcedTranscodeReason: "timeshift buffer geometry differs from live channel (stale prefix)"',
        "forcedTranscodeReason: null",
    ),
    "X4": (
        "return (bufferChannel.fps !== liveChannel.fps) || (bufferChannel.width !== liveChannel.width) || (bufferChannel.height !== liveChannel.height);",
        "return (bufferChannel.fps !== liveChannel.fps) || (bufferChannel.height !== liveChannel.height);",
    ),
    "X5": (
        "return (bufferChannel.fps !== liveChannel.fps) || (bufferChannel.width !== liveChannel.width) || (bufferChannel.height !== liveChannel.height);",
        "return (bufferChannel.fps !== liveChannel.fps) || (bufferChannel.width !== liveChannel.width);",
    ),
    "FPS4": (
        "fps: encoderFps,",
        "fps: request.video.fps,",
    ),
    "FPS4b": (
        "fps: encoderFps,",
        "fps: channelProfile.channel.fps,",
    ),
    "FPS5": (
        '"fps=" + requestedFps.toString()',
        '"fps=" + channelProfile.channel.fps.toString()',
    ),
    "FP9_plugin_fps_cap": (
        "const encoderInputFps = policySourceFps;",
        "const encoderInputFps = encoderFps;",
    ),
    "FP9_unknown_caller_hwdownload": (
        """  const encoderInputFps = policySourceFps;

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
  }));""",
        """  const encoderInputFps = !isLiveSourceFpsKnown(rawSourceFps) ? encoderFps : policySourceFps;

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
      "minterpolate=fps=" + requestedFps.toString() + ":mi_mode=mci:mc_mode=aobmc:me=fss:me_mode=bidir:vsbmc=1:scd=none" ] } : (!isLiveSourceFpsKnown(rawSourceFps) ? { videoFilters: [ "fps=" + requestedFps.toString() ] } : {})),
    width: request.video.width
  }));""",
    ),
    "FP8_caller_fps_on_copy_path": (
        "width: request.video.width\n  }));",
        'width: request.video.width,\n    ...(!useInterpolation ? { videoFilters: ["fps=" + outputFps.toString()] } : {})\n  }));',
    ),
    "prime_mismatch": (
        "  return channelMatches ? trailingFromLastKeyframe : null;",
        "  return trailingFromLastKeyframe;",
    ),
    "PM3": (
        "  const channelMatches = (bufferProfile.channel.id === liveProfile.channel.id) && (bufferProfile.lens === liveProfile.lens);",
        "  const channelMatches = (bufferProfile.channel.id === liveProfile.channel.id);",
    ),
    "BD2": (
        "return !useTsb || ((sessionSource === \"bufferDegraded\") && !channelProfile && !standingTimeshiftPrefix);",
        "return !useTsb || ((sessionSource === \"bufferDegraded\") && !channelProfile);",
    ),
    "X9": (
        "  return (bufferChannel.fps !== liveChannel.fps) || (bufferChannel.width !== liveChannel.width) || (bufferChannel.height !== liveChannel.height);",
        "  return (bufferChannel.fps !== liveChannel.fps);",
    ),
    "BD7w": (
        """    const transcodeSource = input.protectCamera.selectChannel(
      usesHardwareEncoder ? 3840 : input.request.video.width,
      usesHardwareEncoder ? 2160 : input.request.video.height,""",
        """    const transcodeSource = input.protectCamera.selectChannel(
      input.request.video.width,
      input.request.video.height,""",
    ),
    "BD3b": (
        """      targetBitrate = resolveLiveTranscodeBitrate({

        homeKitBitrateKbps: input.request.video.max_bit_rate,
        isHighLatency: input.isHighLatency,
        sourceBitrateKbps: channelProfile.channel.bitrate / 1000,
        transcodeBitrateHint: input.protectCamera.hints.transcodeBitrate,
        transcodeHighLatencyBitrateHint: input.protectCamera.hints.transcodeHighLatencyBitrate
      });""",
        "      targetBitrate = targetBitrate;",
    ),
}

def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <{'|'.join(MUTATIONS)}>")
    mut_id = sys.argv[1]
    if mut_id not in MUTATIONS:
        raise SystemExit(f"unknown mutation {mut_id}")
    old, new = MUTATIONS[mut_id]
    text = WIRING.read_text()
    if mut_id == "FP9_unknown_caller_hwdownload" and "isLiveSourceFpsKnown" not in text:
        text = text.replace(
            "classifyVideoCopyFailure, decideLiveVideoEncode, normalizeLiveSourceFps, resolveForceTranscodeDueToUserOption,",
            "classifyVideoCopyFailure, decideLiveVideoEncode, isLiveSourceFpsKnown, normalizeLiveSourceFps, resolveForceTranscodeDueToUserOption,",
        )
    WIRING.write_text(apply_unique(text, old, new, mut_id))

if __name__ == "__main__":
    main()