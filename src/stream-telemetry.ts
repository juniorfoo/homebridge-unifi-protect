/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-telemetry.ts: Structured live view session telemetry (privacy-safe defaults).
 */
export type StreamStopReason = "error" | "ffmpeg-exit" | "homekit-stop" | "livestream-acquire-failed" | "no-output";

export interface StreamSessionStartInfo {

  camera: string;
  clientAddress?: string;
  dst?: string;
  hardwareTranscode: boolean;
  path: string;
  profile: string;
  sessionId: string;
  src?: string;
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

export function formatStreamSessionStart(info: StreamSessionStartInfo): string {

  const network = info.verboseTelemetry && info.clientAddress ?
    " client=" + info.clientAddress + (info.dst ? " dst=" + info.dst : "") : "";

  return "Stream started: camera=" + info.camera + " session=" + info.sessionId + " path=" + info.path + " profile=" + info.profile +
    " transcode=" + (info.transcode ? "yes" : "no") + " hw=" + (info.hardwareTranscode ? "yes" : "no") + network;
}

export function formatStreamSessionStop(info: StreamSessionStopInfo): string {

  const firstFrame = (info.firstFrameMs === undefined) || (info.firstFrameMs === null) ? "null" : info.firstFrameMs.toString();
  const ffmpegExit = info.ffmpegExitCode === undefined ? "null" : info.ffmpegExitCode?.toString() ?? "null";

  return "Stream ended: camera=" + info.camera + " session=" + info.sessionId + " reason=" + info.reason +
    " duration=" + (info.durationMs / 1000).toFixed(1) + "s first-frame-ms=" + firstFrame +
    " segments-fed=" + info.segmentsFed.toString() + " ffmpeg-exit=" + ffmpegExit;
}

export function formatNoOutputWarning(camera: string, sessionId: string, path: string): string {

  return camera + ": No stream output after 10s (session=" + sessionId + ", path=" + path +
    "). Check UDP path, livestream API availability, or RTSP URL.";
}

export class StreamOutputWatchdog {

  private timer?: NodeJS.Timeout;

  constructor(private readonly onTimeout: () => void, private readonly delayMs: number) {}

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
