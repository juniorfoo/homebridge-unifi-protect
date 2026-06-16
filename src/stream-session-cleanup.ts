/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-session-cleanup.ts: Shared helpers for failed HomeKit stream session startup.
 */
import type { StreamRequestCallback } from "homebridge";

export const LIVESTREAM_START_FAILURE_MESSAGE = "Unable to access the Protect livestream API for live view.";

export interface TsbLivestreamStartFailureDeps {

  accessoryName: string;
  cancelRtpPort: (reservation: number) => void;
  closeDemuxer: () => void;
  closeSegmentWriter: () => void;
  detachLivestreamListeners: () => void;
  forceStopStreamingSession: () => void;
  isFfmpegStarted: boolean;
  logError: (message: string) => void;
  stopFfmpeg: () => void;
  stopLivestream: () => void;
  turnOffFlashlight: () => void;
}

export function formatStreamStartFailureError(accessoryName: string, message = LIVESTREAM_START_FAILURE_MESSAGE): Error {

  return new Error(accessoryName + ": " + message);
}

export function releaseRtpPortReservations(reservations: readonly number[], cancel: (reservation: number) => void): void {

  for(const reservation of reservations) {

    cancel(reservation);
  }
}

// Clean up a TSB/API live view attempt when livestream.start() fails after FFmpeg was already spawned.
export function abortTsbLivestreamStart(callback: StreamRequestCallback, rtpPortReservations: readonly number[],
  deps: TsbLivestreamStartFailureDeps): void {

  deps.detachLivestreamListeners();
  deps.closeSegmentWriter();
  deps.stopFfmpeg();
  deps.stopLivestream();
  deps.turnOffFlashlight();
  deps.closeDemuxer();
  releaseRtpPortReservations(rtpPortReservations, deps.cancelRtpPort);

  deps.logError(LIVESTREAM_START_FAILURE_MESSAGE);

  if(deps.isFfmpegStarted) {

    // FFmpeg may have already invoked the HomeKit start callback on first stderr output.
    deps.forceStopStreamingSession();
  } else {

    callback(formatStreamStartFailureError(deps.accessoryName));
  }
}
