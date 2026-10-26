/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-telemetry.ts: Structured live view session telemetry and no-output watchdog (privacy-safe defaults).
 */
export type StreamStopReason = "ffmpeg-exit" | "homekit-stop" | "livestream-acquire-failed";

export interface StreamSessionStartInfo {

  camera: string;
  clientAddress?: string;
  dst?: string;
  hardwareTranscode: boolean;
  path: string;
  profile: string;
  sessionId: string;
  transcode: boolean;
  verboseTelemetry: boolean;
}

export interface StreamSessionStopInfo extends StreamSessionStartInfo {

  durationMs: number;
  ffmpegExitCode?: number | null;
  firstFrameMs?: number | null;
  reason: StreamStopReason;
  segmentsFed: number;
}

/** Milliseconds after session start before warning when no media activity is observed. */
export const STREAM_NO_OUTPUT_WARNING_MS = 10000;

export function formatLiveViewPathLabel(useTimeshiftBuffer: boolean, timeshiftUsesRtsp: boolean): string {

  return useTimeshiftBuffer ? "TSB/" + (timeshiftUsesRtsp ? "RTSP" : "API") : "RTSP";
}

export function formatStreamSessionStart(info: StreamSessionStartInfo): string {

  const network = info.verboseTelemetry && info.clientAddress ?
    " client=" + info.clientAddress + (info.dst ? " dst=" + info.dst : "") : "";

  return "Stream started: camera=" + info.camera + " session=" + info.sessionId + " path=" + info.path + " profile=" + info.profile +
    " transcode=" + (info.transcode ? "yes" : "no") + " hw=" + (info.hardwareTranscode ? "yes" : "no") + network;
}

export function formatStreamSessionStop(info: StreamSessionStopInfo): string {

  const firstFrame = (info.firstFrameMs === undefined) || (info.firstFrameMs === null) ? "null" : info.firstFrameMs.toString();
  const ffmpegExit = info.ffmpegExitCode === undefined ? "null" : info.ffmpegExitCode?.toString() ?? "null";

  return "Stream ended: camera=" + info.camera + " session=" + info.sessionId + " path=" + info.path + " profile=" + info.profile +
    " transcode=" + (info.transcode ? "yes" : "no") + " hw=" + (info.hardwareTranscode ? "yes" : "no") + " reason=" + info.reason +
    " duration=" + (info.durationMs / 1000).toFixed(1) + "s first-frame-ms=" + firstFrame +
    " segments-fed=" + info.segmentsFed.toString() + " ffmpeg-exit=" + ffmpegExit;
}

export function formatNoOutputWarning(camera: string, sessionId: string, path: string): string {

  return camera + ": No stream output after " + (STREAM_NO_OUTPUT_WARNING_MS / 1000).toString() + "s (session=" + sessionId + ", path=" + path +
    "). Check UDP path, livestream API availability, or RTSP URL.";
}

export interface StreamMediaActivityState {

  firstFrameMs?: number | null;
  segmentsFed: number;
  sessionStartedAt: number;
}

// Identity guard for live-view diagnostics: only the diagnostics object still registered for a session id may accrue media-segment activity. Stale subscription
// callbacks can drain queued segments after STOP/START reuses the same HomeKit session id (see timeshift.ts consumeSegments identity guard).
export function recordStreamMediaActivityIfOwner(mapEntry: StreamMediaActivityState | undefined, owner: StreamMediaActivityState, nowMs: number): boolean {

  if(mapEntry !== owner) {

    return false;
  }

  owner.segmentsFed++;

  if(owner.firstFrameMs === undefined) {

    owner.firstFrameMs = nowMs - owner.sessionStartedAt;
  }

  return true;
}

// One-shot watchdog: the first activity() disarms the timer; arm() starts the no-output deadline from session start.
export class StreamOutputWatchdog {

  private readonly delayMs: number;
  private readonly onTimeout: () => void;
  private timer?: NodeJS.Timeout;

  constructor(onTimeout: () => void, delayMs: number) {

    this.onTimeout = onTimeout;
    this.delayMs = delayMs;
  }

  public activity(): void {

    this.clear();
  }

  public arm(): void {

    this.clear();
    this.timer = setTimeout(this.onTimeout, this.delayMs);
  }

  public clear(): void {

    if(this.timer) {

      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
