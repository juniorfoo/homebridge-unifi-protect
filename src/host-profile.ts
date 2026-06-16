/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * host-profile.ts: Adaptive host capability profiles for streaming defaults.
 */
import os from "node:os";

export type HostProfile = "apple-silicon-hw" | "default" | "intel-qsv" | "pi" | "software-constrained";

export interface HostProfileInput {

  cpuCores?: number;
  hardwareTranscoding: boolean;
  hasQsv?: boolean;
  hostSystem: string;
}

export interface HostProfileDefaults {

  preferRtspLiveView: boolean;
  recordingDefault: string;
  transcodeByDefault: boolean;
}

export function detectHostProfile(input: HostProfileInput): HostProfile {

  if(input.hostSystem === "raspbian") {

    return "pi";
  }

  if((input.hostSystem === "macOS.Apple") && input.hardwareTranscoding) {

    return "apple-silicon-hw";
  }

  if(input.hasQsv && input.hardwareTranscoding) {

    return "intel-qsv";
  }

  const cpuCores = input.cpuCores ?? os.cpus().length;

  if(!input.hardwareTranscoding && (cpuCores <= 4) && !input.hostSystem.startsWith("macOS")) {

    return "software-constrained";
  }

  return "default";
}

export function getHostProfileDefaults(profile: HostProfile, hardwareTranscoding: boolean): HostProfileDefaults {

  switch(profile) {

    case "apple-silicon-hw":

      return {

        preferRtspLiveView: false,
        recordingDefault: hardwareTranscoding ? "High" : "Medium",
        transcodeByDefault: false
      };

    case "intel-qsv":

      return {

        preferRtspLiveView: false,
        recordingDefault: "Medium",
        transcodeByDefault: false
      };

    case "pi":
    case "software-constrained":

      return {

        preferRtspLiveView: true,
        recordingDefault: "Medium",
        transcodeByDefault: false
      };

    default:

      return {

        preferRtspLiveView: false,
        recordingDefault: hardwareTranscoding ? "High" : "",
        transcodeByDefault: true
      };
  }
}

export function resolveHksvRecordingDefault(profile: HostProfile, hardwareTranscoding: boolean, max1080ProfileName = ""): string {

  const defaults = getHostProfileDefaults(profile, hardwareTranscoding);

  if(defaults.recordingDefault === "Medium") {

    return "Medium";
  }

  if(((profile === "pi") || (profile === "software-constrained")) && max1080ProfileName) {

    return max1080ProfileName;
  }

  return defaults.recordingDefault;
}

export function formatHostProfileLog(profile: HostProfile, hardwareTranscoding: boolean, qsvAvailable: boolean): string {

  switch(profile) {

    case "software-constrained":

      return "Host profile: software-constrained" + (qsvAvailable ? "" : " (QSV unavailable)") +
        "; live view prefers RTSP, HKSV capped at Medium.";

    case "pi":

      return "Host profile: pi; live view prefers RTSP, HKSV capped at ≤1080p Medium.";

    case "intel-qsv":

      return "Host profile: intel-qsv; copy-first transcode, HKSV Medium–High.";

    case "apple-silicon-hw":

      return "Host profile: apple-silicon-hw; hardware transcode enabled.";

    default:

      return "Host profile: default; hardware transcode " + (hardwareTranscoding ? "enabled" : "disabled") + ".";
  }
}
