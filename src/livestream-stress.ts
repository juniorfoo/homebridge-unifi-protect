/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * livestream-stress.ts: Protect livestream API stress detection and adaptation.
 */
import type { HostProfile } from "./host-profile.js";

export const LIVESTREAM_STRESS_RESTART_THRESHOLD = 3;
export const LIVESTREAM_STRESS_WINDOW_MS = 10 * 60 * 1000;
export const LIVESTREAM_PREFER_RTSP_DURATION_MS = 30 * 60 * 1000;
export const LIVESTREAM_SELF_HEALING_RESTART_THRESHOLD = 10;

export interface LivestreamRestartEvent {

  timestamp: number;
}

export function countRecentRestarts(events: readonly LivestreamRestartEvent[], now: number,
  windowMs = LIVESTREAM_STRESS_WINDOW_MS): number {

  return events.filter(event => (now - event.timestamp) <= windowMs).length;
}

export function isLivestreamUnderStress(restartCount: number, threshold = LIVESTREAM_STRESS_RESTART_THRESHOLD): boolean {

  return restartCount >= threshold;
}

export function shouldAutoPreferRtspLiveView(restartCount: number, threshold = LIVESTREAM_STRESS_RESTART_THRESHOLD): boolean {

  return isLivestreamUnderStress(restartCount, threshold);
}

export function shouldSkipSelfHealingCameraReboot(input: {

  hostProfile?: HostProfile;
  recentRestartCount: number;
  selfHealingEnabled: boolean;
  stressThreshold?: number;
}): boolean {

  if(!input.selfHealingEnabled) {

    return true;
  }

  if((input.hostProfile === "pi") || (input.hostProfile === "software-constrained")) {

    return true;
  }

  return isLivestreamUnderStress(input.recentRestartCount, input.stressThreshold);
}

export function formatLivestreamStressAdvisory(camera: string): string {

  return "Protect livestream API under stress for " + camera + "; preferring RTSP live view for 30 minutes.";
}
