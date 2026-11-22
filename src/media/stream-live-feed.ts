/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * stream-live-feed.ts: TSB/API livestream segment feeding and post-respawn fMP4 priming (spawn-free, testable).
 */
/* eslint-disable sort-imports -- type and value imports from the same package stay paired */
import type { Writable } from "node:stream";
import type { BackpressureWriter, Clock, HomebridgePluginLogging, Mp4FrameFeed, Nullable, StreamingProcess } from "homebridge-plugin-utils";
import { BackpressureWriter as BackpressureWriterImpl, HbpuAbortError, Mp4FrameFeed as Mp4FrameFeedImpl } from "homebridge-plugin-utils";
import type { LivestreamSubscription } from "./livestream.ts";
import type { ProtectStreamingFfmpegProcess } from "./stream-ffmpeg-process.ts";

// Re-export for tests and fork modules that only need stdin from a replacement process.
export type LiveFfmpegStdinSource = StreamingProcess;

import { logLivestreamIterationError } from "./livestream.ts";
import type { LivePrimeMediaFloor } from "./fmp4-fragment-identity.ts";
import { applyPrimeMediaFloorClearAfterComparableAheadLiveWrite, COPY_ESCALATION_PRIME_FLOOR_MAX_WRITTEN_LIVE_MOOF_CHECKS,
  isPrimeMediaFloorEmpty, parsePrimeMediaFloorFromPrimingBuffer, shouldSkipLiveSegmentAfterCopyPrime } from "./fmp4-fragment-identity.ts";

export interface LiveTsbFeedState {

  allowTimeshiftPrefix: boolean;
  headerWritten: boolean;
  primeMediaFloor: LivePrimeMediaFloor | null;
  /** Written live media moofs while `primeMediaFloor` is active (P4 expiry; skipped moofs do not increment). */
  primeMediaFloorWrittenLiveMoofs?: number;
}

export interface TsbSegmentWriterRail {

  getFrameFeed: () => Mp4FrameFeed;
  getSegmentWriter: () => BackpressureWriter;
  rotateSegmentWriter: (replacement: StreamingProcess) => BackpressureWriter;
}

// Build the frame feed a buffer-backed live view writes FFmpeg's input through, over that session's writer and on the platform's clock, the one that writer paces
// on...the feed times each fragment's start and the writer holds it, so the two have to read the same time.
export function createLiveFrameFeed(writer: BackpressureWriter, clock: Clock, log: HomebridgePluginLogging): Mp4FrameFeed {

  return new Mp4FrameFeedImpl(writer, {

    clock: clock,
    onUnpaced: (_fragment, reason): void => {

      if(reason === "no-video") {

        log.debug("A livestream fragment with no video in it was sent to HomeKit as it arrived.");

        return;
      }

      log.warn("Some of this camera's video could not be read frame by frame, so it was sent to HomeKit as it arrived. " +
        "Live views may look less smooth.");
    }
  });
}

/** Production TSB segment writer rail (rotation uses rotateBackpressureWriterForCopyEscalation). */
export function createTsbSegmentWriterRail(input: { clock: Clock; feedState?: LiveTsbFeedState; getStdin: () => Writable; log: HomebridgePluginLogging;
  onRotateSegmentWriter?: (event: { poisoned: BackpressureWriter; replacement: BackpressureWriter }) => void; signal: AbortSignal;
  // eslint-disable-next-line @typescript-eslint/no-generated-empty-object-type -- HBPU BackpressureWriter opts are only clock/signal here
  writerInit?: Omit<ConstructorParameters<typeof BackpressureWriterImpl>[1], "clock" | "signal">; }): TsbSegmentWriterRail & { feedState: LiveTsbFeedState } {

  const feedState = input.feedState ?? { allowTimeshiftPrefix: true, headerWritten: false, primeMediaFloor: null };
  const writerBase = { clock: input.clock, signal: input.signal, ...input.writerInit };
  let segmentWriter = new BackpressureWriterImpl(input.getStdin, writerBase);
  let frameFeed = createLiveFrameFeed(segmentWriter, input.clock, input.log);

  return {

    feedState: feedState,

    getFrameFeed: (): Mp4FrameFeed => frameFeed,

    getSegmentWriter: (): BackpressureWriter => segmentWriter,

    rotateSegmentWriter: (replacement: StreamingProcess): BackpressureWriter => {

      const poisoned = segmentWriter;

      segmentWriter = rotateBackpressureWriterForCopyEscalation({

        getStdin: () => replacement.stdin,
        poisoned: poisoned,
        signal: input.signal,
        writerInit: writerBase
      });
      frameFeed = createLiveFrameFeed(segmentWriter, input.clock, input.log);

      input.onRotateSegmentWriter?.({ poisoned: poisoned, replacement: segmentWriter });

      return segmentWriter;
    }
  };
}

/* Consume Segments from a livestream subscription and feed them to FFmpeg through the supplied frame feed. FFmpeg needs a valid fMP4 header before any MOOF/MDAT
 * data, so we write the header whole, exactly once, on the first media: either the pre-existing timeshift buffer slice (which already contains the init segment
 * followed by recent frames) or the subscription's cached init segment data on its own. The unifi-protect library's pool yields the init as its own Segment, so we
 * SKIP the init-typed segment here (writing both the header and the init segment would double-write the fMP4 header and corrupt FFmpeg's -f mp4 input) and
 * consume the cached initSegment.data instead. Error classification is centralised in logLivestreamIterationError so every livestream consumer uses identical
 * phrasing.
 *
 * Every media fragment after the header reaches FFmpeg as its video frames, the first when the video's own time says it is due and each later one a frame's
 * duration after the one before it.
 */
export async function consumeLiveStreamSegments(getFfmpeg: () => ProtectStreamingFfmpegProcess, feedState: LiveTsbFeedState,
  subscription: LivestreamSubscription, getFeed: () => Mp4FrameFeed, tsBuffer: Nullable<Buffer>, log: HomebridgePluginLogging,
  onMediaSegment?: () => void): Promise<void> {

  try {

    for await(const segment of subscription) {

      // The init segment is consumed through the cached subscription.initSegment getter and prepended once below as the header, not written here. Skip it.
      if(segment.type === "init") {

        continue;
      }

      // The first media segment after a genuine reconnect carries discontinuity:true: its tfdt baseMediaDecodeTime has been rebased near zero (a backward timeline
      // jump). Our live -f mp4 input carries +discardcorrupt / ignore_err but NOT +genpts, so feeding the rebased fragment would corrupt FFmpeg's demux. We end
      // FFmpeg's stdin instead - the .exited force-stop bridge then re-establishes the HomeKit session cleanly, ending the stream on every visible disconnect (the
      // discontinuity marker sources that decision inline). A unifi-protect-side timeline-continuity alternative (stitching the timeline across reconnects rather
      // than ending) is backlogged. This check is BEFORE the write so the rebased fragment is never forwarded; it mirrors timeshift.ts's check-before-forward
      // ordering.
      if(segment.discontinuity) {

        getFfmpeg().stdin.end();

        return;
      }

      // Prepend the fMP4 header once, on the first media segment. The whenEstablished contract guarantees subscription.initSegment is non-null by the time media
      // flows...the unifi-protect library delivers the init segment before the first media segment. If the library ever violates this and we see a null header
      // here, fail the stream cleanly rather than feeding FFmpeg MOOF/MDAT chunks without a header (which would silently corrupt the output).
      if(!feedState.headerWritten) {

        feedState.headerWritten = true;

        const header = (feedState.allowTimeshiftPrefix ? tsBuffer : null) ?? subscription.initSegment?.data;

        if(!header) {

          log.error("Live streaming aborted: the livestream API delivered its first segment before the initialization segment.");
          getFfmpeg().stdin.end();

          return;
        }

        if(feedState.allowTimeshiftPrefix && tsBuffer) {

          feedState.allowTimeshiftPrefix = false;
        }

        void getFeed().writeHeader(header).catch((error: unknown) => log.debug("Live stream backpressure write dropped.", { error }));
      }

      onMediaSegment?.();

      if(feedState.primeMediaFloor && shouldSkipLiveSegmentAfterCopyPrime(feedState.primeMediaFloor, segment.data,
        { atOrBefore: true }, log)) {

        log.debug("Skipping live fMP4 fragment already covered by copy-escalation prime (pooled reader lag).");

        continue;
      }

      if(feedState.primeMediaFloor && applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(feedState.primeMediaFloor, segment.data, log) &&
        isPrimeMediaFloorEmpty(feedState.primeMediaFloor)) {

        feedState.primeMediaFloor = null;
        feedState.primeMediaFloorWrittenLiveMoofs = undefined;
      }

      if(feedState.primeMediaFloor) {

        feedState.primeMediaFloorWrittenLiveMoofs = (feedState.primeMediaFloorWrittenLiveMoofs ?? 0) + 1;

        if(feedState.primeMediaFloorWrittenLiveMoofs > COPY_ESCALATION_PRIME_FLOOR_MAX_WRITTEN_LIVE_MOOF_CHECKS) {

          feedState.primeMediaFloor = null;
          feedState.primeMediaFloorWrittenLiveMoofs = undefined;
        }
      }

      // Feed the media fragment as its frames, without awaiting it. The feed's write returns a typed-rejecting Promise; the .catch (debug) swallows
      // BackpressureClosedStreamError / signal.reason on teardown (the common case when FFmpeg exits mid-write), when the frames of a fragment still waiting their turn
      // are dropped. No highWaterMark (unbounded) and no segment-count accounting, unlike HKSV.
      void getFeed().writeFragment(segment.data).catch((error: unknown) => log.debug("Live stream backpressure write dropped.", { error }));
    }
  } catch(error) {

    logLivestreamIterationError({ consumer: "Live streaming", error, log: log });

    // The iterator terminated out-of-band (the subscription is disposed, no more segments will arrive). Ending FFmpeg's stdin lets the process wrap up cleanly
    // on its own schedule rather than waiting for its internal stall timeout to fire. There is no consumer-side reboot here - the live and HKSV-timeshift
    // consumers share one pooled session and the timeshift owns the single reboot anchor; logLivestreamIterationError already warns on the recovery give-up.
    getFfmpeg().stdin.end();
  }
}

/** Reprime fMP4 init on the rotated Mp4FrameFeed so later media fragments stay frame-paced (init once, never double-init). */
export function primeLiveFfmpegStdinAfterRespawn(feedState: LiveTsbFeedState, subscription: LivestreamSubscription, feed: Mp4FrameFeed,
  keyframePrimingBuffer?: Nullable<Buffer>, log?: HomebridgePluginLogging): void {

  feedState.allowTimeshiftPrefix = false;
  feedState.headerWritten = false;
  feedState.primeMediaFloor = null;
  feedState.primeMediaFloorWrittenLiveMoofs = undefined;

  const header = keyframePrimingBuffer ?? subscription.initSegment?.data;

  if(!header) {

    return;
  }

  feedState.headerWritten = true;
  void feed.writeHeader(header).catch((error: unknown) => log?.debug("Live stream backpressure write dropped.", { error }));

  if(!keyframePrimingBuffer) {

    return;
  }

  const floor = parsePrimeMediaFloorFromPrimingBuffer(keyframePrimingBuffer, log);

  if(floor) {

    feedState.primeMediaFloor = floor;
    feedState.primeMediaFloorWrittenLiveMoofs = 0;

    return;
  }

  log?.debug("Copy-escalation prime dedup disabled: could not read tfdt or mfhd from the last fragment in the priming buffer.");
}

/** Allocate a new segment writer for a copy-to-transcode replacement and abandon the prior writer (which may already be failed after copy exit EPIPE). */
export function rotateBackpressureWriterForCopyEscalation(input: { getStdin: () => Writable; poisoned: BackpressureWriter; signal: AbortSignal;
  writerInit?: ConstructorParameters<typeof BackpressureWriterImpl>[1]; }): BackpressureWriter {

  const replacement = new BackpressureWriterImpl(input.getStdin, { signal: input.signal, ...input.writerInit });

  input.poisoned.abort(new HbpuAbortError("replaced"));

  return replacement;
}
