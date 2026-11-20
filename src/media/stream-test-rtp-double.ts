/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * Harness RtpDemuxer double for start-path integration tests (mediaReady resolves immediately).
 */
import type { RtpDemuxer } from "homebridge-plugin-utils";

export interface HarnessRtpDemuxerInit {

  signal: AbortSignal;
}

export function makeHarnessRtpDemuxer(init: HarnessRtpDemuxerInit): RtpDemuxer {

  return {

    abort: (): void => undefined,
    get aborted(): boolean {

      return init.signal.aborted;
    },
    get inputPort(): number {

      return 0;
    },
    get isTimedOut(): boolean {

      return false;
    },
    mediaReady: Promise.resolve(),
    ready: Promise.resolve(),
    signal: init.signal,
    async [Symbol.asyncDispose](): Promise<void> {

      return undefined;
    }
  } as unknown as RtpDemuxer;
}
