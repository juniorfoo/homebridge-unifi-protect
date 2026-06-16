/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-path.ts: Live view path selection between RTSP and TSB/API.
 */
import type { HostProfile } from "./host-profile.js";
import type { RtspEntry } from "./devices/protect-camera.js";

export interface UseTsbInput {

  abTestFlip?: boolean;
  debugAbTestEnabled?: boolean;
  hksvRecording: boolean;
  hostProfile?: HostProfile;
  isPackageCamera: boolean;
  packetTime: number;
  preferRtspLiveView: boolean;
  useApiFeature: boolean;
  videoCodec: string;
}

export interface LiveViewRtspSelectionInput {

  findLiveRtsp: () => RtspEntry | null;
  hksvRtspEntry: RtspEntry | null;
  useTsb: boolean;
}

export function isLanClient(packetTime: number): boolean {

  return packetTime < 60;
}

export function shouldPreferRtspLiveView(input: {

  hostProfile?: HostProfile;
  packetTime: number;
  preferRtspLiveView: boolean;
}): boolean {

  if(input.preferRtspLiveView) {

    return true;
  }

  if(isLanClient(input.packetTime)) {

    return true;
  }

  return (input.hostProfile === "pi") || (input.hostProfile === "software-constrained");
}

export function shouldUseTsbApi(input: UseTsbInput): boolean {

  if(input.debugAbTestEnabled && input.abTestFlip) {

    return !(input.useApiFeature && input.hksvRecording);
  }

  if(!input.useApiFeature || !input.hksvRecording) {

    return false;
  }

  if(input.isPackageCamera || (input.videoCodec === "av1")) {

    return true;
  }

  return !shouldPreferRtspLiveView({

    hostProfile: input.hostProfile,
    packetTime: input.packetTime,
    preferRtspLiveView: input.preferRtspLiveView
  });
}

export function resolveLiveViewRtspEntry(input: LiveViewRtspSelectionInput): RtspEntry | null {

  if(input.useTsb) {

    return input.findLiveRtsp() ?? input.hksvRtspEntry;
  }

  return input.findLiveRtsp();
}

export function formatStreamPathLabel(useTsb: boolean, debugUseRtspForHksv: boolean): string {

  return useTsb ? "TSB/" + (debugUseRtspForHksv ? "RTSP" : "API") : "RTSP";
}
