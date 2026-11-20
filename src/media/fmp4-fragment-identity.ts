/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * fmp4-fragment-identity.ts: Read CMAF fragment timing from moof/tfdt (primary) and mfhd (fallback) for copy-escalation dedup.
 */
import type { HomebridgePluginLogging, Nullable } from "homebridge-plugin-utils";
import { PROTECT_LIVESTREAM_API_IDR_INTERVAL, PROTECT_SEGMENT_RESOLUTION } from "../settings.ts";

export interface Fmp4MediaFragmentIdentity {

  baseMediaDecodeTime: number | null;
  sequenceNumber: number | null;
  trackId: number | null;
}

/** One `traf` box with a mandatory `tfhd` and optional `tfdt`. */
export interface Fmp4TrafTiming {

  baseMediaDecodeTime: number | null;
  trackId: number;
}

/** Parsed timing for a single `moof` (all `traf` children, stream `mfhd`). */
export interface Fmp4MoofTiming {

  sequenceNumber: number | null;
  trafs: Fmp4TrafTiming[];
}

export interface LivePrimeMediaFloor {

  sequenceNumber: number | null;
  trackDecodeTimes: Record<number, number>;
  /** Primed `traf` boxes with `tfhd` but no `tfdt` (compared via mfhd during dedup). */
  trackMfhdOnly: Record<number, true>;
}

/**
 * Drop the floor after this many **written** live media moofs while dedup is still active (P4 stale-floor bound).
 * 2x one IDR window at segment resolution (5s / 100ms -> 50 moofs, cap 100) so a full prime replay can be skipped before expiry.
 */
export const COPY_ESCALATION_PRIME_FLOOR_MAX_WRITTEN_LIVE_MOOF_CHECKS =
  Math.ceil((PROTECT_LIVESTREAM_API_IDR_INTERVAL * 1000) / PROTECT_SEGMENT_RESOLUTION) * 2;

/** @deprecated Renamed - use {@link COPY_ESCALATION_PRIME_FLOOR_MAX_WRITTEN_LIVE_MOOF_CHECKS}. */
export const COPY_ESCALATION_PRIME_FLOOR_MAX_LIVE_MOOF_CHECKS = COPY_ESCALATION_PRIME_FLOOR_MAX_WRITTEN_LIVE_MOOF_CHECKS;

export function isTrackPrimedInFloor(floor: LivePrimeMediaFloor, trackId: number): boolean {

  return (floor.trackDecodeTimes[trackId] !== undefined) || (floor.trackMfhdOnly[trackId] === true);
}

export function isTrackMfhdOnlyInFloor(floor: LivePrimeMediaFloor, trackId: number): boolean {

  return (floor.trackMfhdOnly[trackId] === true) && (floor.trackDecodeTimes[trackId] === undefined);
}

export function isPrimeMediaFloorEmpty(floor: LivePrimeMediaFloor): boolean {

  return (Object.keys(floor.trackDecodeTimes).length === 0) && (Object.keys(floor.trackMfhdOnly).length === 0) &&
    (floor.sequenceNumber === null);
}

/** Test / harness helper: single-track floor from one parsed fragment identity. */
export function livePrimeMediaFloorFromIdentity(identity: Fmp4MediaFragmentIdentity): LivePrimeMediaFloor {

  const trackDecodeTimes: Record<number, number> = {};
  const trackMfhdOnly: Record<number, true> = {};

  if((identity.trackId !== null) && (identity.baseMediaDecodeTime !== null)) {

    trackDecodeTimes[identity.trackId] = identity.baseMediaDecodeTime;
  }

  return { sequenceNumber: identity.sequenceNumber, trackDecodeTimes, trackMfhdOnly };
}

interface ParsedBox {

  end: number;
  headerSize: number;
  size: number;
  start: number;
  type: string;
}

const readBoxType = (data: Buffer, offset: number): string => data.subarray(offset + 4, offset + 8).toString("ascii");

const payloadSlice = (_data: Buffer, box: ParsedBox): { end: number; start: number } => ({

  end: box.end,
  start: box.start + box.headerSize
});

/** Bounded ISO BMFF box header (size 0 -> parent EOF only when allowed). Returns null on any malformed header. */
const readBoxHeader = (data: Buffer, offset: number, parentEnd: number, allowSizeZeroToEof: boolean): Nullable<ParsedBox> => {

  if((offset + 8 > parentEnd) || (offset + 8 > data.length)) {

    return null;
  }

  const size32 = data.readUInt32BE(offset);
  const type = readBoxType(data, offset);
  let headerSize = 8;
  let boxSize: number;

  if(size32 === 0) {

    if(!allowSizeZeroToEof) {

      return null;
    }

    boxSize = parentEnd - offset;
  } else if(size32 === 1) {

    if((offset + 16 > parentEnd) || (offset + 16 > data.length)) {

      return null;
    }

    boxSize = Number(data.readBigUInt64BE(offset + 8));
    headerSize = 16;
  } else {

    boxSize = size32;
  }

  if(!Number.isFinite(boxSize) || (boxSize < headerSize)) {

    return null;
  }

  const end = offset + boxSize;

  // fmp4-bounded: child boxes must end within parent and buffer.
  if((end > parentEnd) || (end > data.length)) {

    return null;
  }

  return { end, headerSize, size: boxSize, start: offset, type };
};

const readTfdtBaseMediaDecodeTime = (data: Buffer, box: ParsedBox): Nullable<number> => {

  const { end, start } = payloadSlice(data, box);
  const payloadLen = end - start;

  if(payloadLen < 4) {

    return null;
  }

  const version = data[start];

  if(version === 0) {

    if(payloadLen < 8) {

      return null;
    }

    return data.readUInt32BE(start + 4);
  }

  if(version === 1) {

    if(payloadLen < 12) {

      return null;
    }

    return Number(data.readBigUInt64BE(start + 4));
  }

  return null;
};

const readMfhdSequenceNumber = (data: Buffer, box: ParsedBox): Nullable<number> => {

  const { end, start } = payloadSlice(data, box);

  if((end - start) < 8) {

    return null;
  }

  return data.readUInt32BE(start + 4);
};

const readTfhdTrackId = (data: Buffer, box: ParsedBox): Nullable<number> => {

  const { end, start } = payloadSlice(data, box);

  if((end - start) < 8) {

    return null;
  }

  return data.readUInt32BE(start + 4);
};

type BoxWalkResult = "continue" | "fail" | "stop";

const forEachChildBox = (data: Buffer, container: ParsedBox, visit: (child: ParsedBox) => BoxWalkResult): boolean => {

  let child = container.start + container.headerSize;

  while(child < container.end) {

    const box = readBoxHeader(data, child, container.end, false);

    if(!box) {

      return false;
    }

    const step = visit(box);

    if(step === "fail") {

      return false;
    }

    if(step === "stop") {

      return true;
    }

    child = box.end;
  }

  return true;
};

const parseTrafTimingInPlace = (data: Buffer, traf: ParsedBox, out: Fmp4TrafTiming): boolean => {

  let trackId: number | null = null;
  let baseMediaDecodeTime: number | null = null;

  const trafOk = forEachChildBox(data, traf, (trafChild) => {

    if(trafChild.type === "tfdt") {

      const decodeTime = readTfdtBaseMediaDecodeTime(data, trafChild);

      if(decodeTime === null) {

        return "fail";
      }

      baseMediaDecodeTime = decodeTime;

      return "continue";
    }

    if(trafChild.type === "tfhd") {

      const parsedTrackId = readTfhdTrackId(data, trafChild);

      if(parsedTrackId === null) {

        return "fail";
      }

      trackId = parsedTrackId;

      return "continue";
    }

    return "continue";
  });

  if(!trafOk) {

    return false;
  }

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tfhd may be absent when mutation strips moof guard
  if(trackId === null) {

    return false;
  }

  out.trackId = trackId;
  out.baseMediaDecodeTime = baseMediaDecodeTime;

  return true;
};

const parseFmp4MoofTimingBounded = (fragment: Buffer): Nullable<Fmp4MoofTiming> => {

  const fragmentEnd = fragment.length;
  let offset = 0;

  while(offset < fragmentEnd) {

    const top = readBoxHeader(fragment, offset, fragmentEnd, false);

    if(!top) {

      return null;
    }

    if(top.type === "moof") {

      const timing: Fmp4MoofTiming = {

        sequenceNumber: null,
        trafs: []
      };

      const moofOk = forEachChildBox(fragment, top, (child) => {

        if(child.type === "mfhd") {

          const sequenceNumber = readMfhdSequenceNumber(fragment, child);

          if(sequenceNumber === null) {

            return "fail";
          }

          timing.sequenceNumber = sequenceNumber;

          return "continue";
        }

        if(child.type === "traf") {

          let sawTfdtBox = false;
          let sawTfhdBox = false;

          if(!forEachChildBox(fragment, child, (trafChild) => {

            if(trafChild.type === "tfdt") {

              sawTfdtBox = true;
            }

            if(trafChild.type === "tfhd") {

              sawTfhdBox = true;
            }

            return "continue";
          })) {

            return "fail";
          }

          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- flags set inside forEachChildBox callback
          if(sawTfdtBox && !sawTfhdBox) {

            return "fail";
          }

          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- sawTfhdBox set inside forEachChildBox callback
          if(sawTfhdBox) {

            const trafTiming: Fmp4TrafTiming = { baseMediaDecodeTime: null, trackId: 0 };

            if(!parseTrafTimingInPlace(fragment, child, trafTiming)) {

              return "fail";
            }

            timing.trafs.push(trafTiming);
          }
        }

        return "continue";
      });

      if(!moofOk) {

        return null;
      }

      if((timing.trafs.length === 0) && (timing.sequenceNumber === null)) {

        return null;
      }

      return timing;
    }

    offset = top.end;
  }

  return null;
};

/** Parse per-`traf` timing from the first `moof` in a media fragment. */
export function parseFmp4MoofTiming(fragment: Buffer): Nullable<Fmp4MoofTiming> {

  try {

    return parseFmp4MoofTimingBounded(fragment);
  } catch {

    return null;
  }
}

const moofTimingToLegacyIdentity = (timing: Fmp4MoofTiming): Fmp4MediaFragmentIdentity => {

  const primary = timing.trafs[0];
  const timedTraf = timing.trafs.find((traf) => traf.baseMediaDecodeTime !== null);

  return {

    baseMediaDecodeTime: timedTraf?.baseMediaDecodeTime ?? primary?.baseMediaDecodeTime ?? null,
    sequenceNumber: timing.sequenceNumber,
    trackId: timedTraf?.trackId ?? primary?.trackId ?? null
  };
};

const parseFmp4MediaFragmentIdentityBounded = (fragment: Buffer): Nullable<Fmp4MediaFragmentIdentity> => {

  const timing = parseFmp4MoofTimingBounded(fragment);

  if(!timing) {

    return null;
  }

  return moofTimingToLegacyIdentity(timing);
};

/** Parse identity from one fMP4 media fragment (moof+mdat). Primary: tfdt baseMediaDecodeTime; fallback: mfhd sequence_number. */
export function parseFmp4MediaFragmentIdentity(fragment: Buffer): Nullable<Fmp4MediaFragmentIdentity> {

  try {

    return parseFmp4MediaFragmentIdentityBounded(fragment);
  } catch {

    return null;
  }
}

/** Snapshot per-track decode floors and stream mfhd across every top-level moof in a copy-escalation prime buffer. */
export function parsePrimeMediaFloorFromPrimingBuffer(primingBuffer: Buffer,
  log?: HomebridgePluginLogging): Nullable<LivePrimeMediaFloor> {

  try {

    const trackDecodeTimes: Record<number, number> = {};
    let trackMfhdOnly: Record<number, true> = {};
    let sequenceNumber: number | null = null;
    let offset = 0;
    const bufEnd = primingBuffer.length;

    while(offset < bufEnd) {

      const box = readBoxHeader(primingBuffer, offset, bufEnd, true);

      if(!box) {

        return null;
      }

      if(box.type === "moof") {

        const timing = parseFmp4MoofTimingBounded(primingBuffer.subarray(box.start));

        if(!timing) {

          return null;
        }

        if(timing.sequenceNumber !== null) {

          sequenceNumber = (sequenceNumber === null) ?
            timing.sequenceNumber :
            Math.max(sequenceNumber, timing.sequenceNumber);
        }

        for(const traf of timing.trafs) {

          if(traf.baseMediaDecodeTime !== null) {

            trackDecodeTimes[traf.trackId] = traf.baseMediaDecodeTime;

            if(trackMfhdOnly[traf.trackId] === true) {

              trackMfhdOnly = Object.fromEntries(Object.entries(trackMfhdOnly).filter(([id]) => Number(id) !== traf.trackId));
            }
          } else {

            if(trackDecodeTimes[traf.trackId] === undefined) {

              trackMfhdOnly[traf.trackId] = true;
            }
          }
        }
      }

      offset = box.end;
    }

    const hasPrimedTracks = (Object.keys(trackDecodeTimes).length > 0) || (Object.keys(trackMfhdOnly).length > 0);

    if(!hasPrimedTracks && (sequenceNumber === null)) {

      return null;
    }

    return { sequenceNumber, trackDecodeTimes, trackMfhdOnly };
  } catch(error) {

    log?.debug("Copy-escalation prime floor parse failed.", { error });

    return null;
  }
}

/** Harness-only: last top-level `moof` as a legacy single-track identity (walk tests; production uses `parsePrimeMediaFloorFromPrimingBuffer`). */
export function parseLastMediaFragmentIdentityInPrimingBuffer(primingBuffer: Buffer,
  log?: HomebridgePluginLogging): Nullable<Fmp4MediaFragmentIdentity> {

  try {

    let offset = 0;
    let lastMoofStart = -1;
    const bufEnd = primingBuffer.length;

    while(offset < bufEnd) {

      const box = readBoxHeader(primingBuffer, offset, bufEnd, true);

      if(!box) {

        return null;
      }

      if(box.type === "moof") {

        lastMoofStart = offset;
      }

      offset = box.end;
    }

    if(lastMoofStart < 0) {

      return null;
    }

    return parseFmp4MediaFragmentIdentity(primingBuffer.subarray(lastMoofStart));
  } catch(error) {

    log?.debug("Copy-escalation prime floor parse failed.", { error });

    return null;
  }
}

const clearPrimeMfhdWhenTracksEmpty = (floor: LivePrimeMediaFloor, liveSequenceNumber: number | null): boolean => {

  if((Object.keys(floor.trackDecodeTimes).length > 0) || (Object.keys(floor.trackMfhdOnly).length > 0)) {

    return false;
  }

  if(floor.sequenceNumber === null) {

    return false;
  }

  if((liveSequenceNumber === null) || (liveSequenceNumber > floor.sequenceNumber)) {

    floor.sequenceNumber = null;

    return true;
  }

  return false;
};

const mfhdSequenceLagging = (liveSeq: number | null, floorSeq: number | null, atOrBefore: boolean): boolean | null => {

  if((liveSeq === null) || (floorSeq === null)) {

    return null;
  }

  return atOrBefore ? (liveSeq <= floorSeq) : (liveSeq < floorSeq);
};

/** Skip only when every `traf` is primed and each compares by tfdt or mfhd per its floor entry. */
export function shouldSkipLiveSegmentAfterCopyPrime(floor: LivePrimeMediaFloor, segmentData: Buffer,
  options: { atOrBefore: boolean }, log?: HomebridgePluginLogging): boolean {

  try {

    const timing = parseFmp4MoofTimingBounded(segmentData);

    if(!timing) {

      return false;
    }

    if(timing.trafs.length === 0) {

      return false;
    }

    for(const traf of timing.trafs) {

      if(!isTrackPrimedInFloor(floor, traf.trackId)) {

        return false;
      }
    }

    for(const traf of timing.trafs) {

      if(traf.baseMediaDecodeTime !== null) {

        const floorTfdt = floor.trackDecodeTimes[traf.trackId];

        if(floorTfdt !== undefined) {

          const lagging = options.atOrBefore ?
            (traf.baseMediaDecodeTime <= floorTfdt) :
            (traf.baseMediaDecodeTime < floorTfdt);

          if(!lagging) {

            return false;
          }
        } else {

          const mfhdLag = mfhdSequenceLagging(timing.sequenceNumber, floor.sequenceNumber, options.atOrBefore);

          if((mfhdLag === null) || !mfhdLag) {

            return false;
          }
        }
      } else {

        const mfhdLag = mfhdSequenceLagging(timing.sequenceNumber, floor.sequenceNumber, options.atOrBefore);

        if((mfhdLag === null) || !mfhdLag) {

          return false;
        }
      }
    }

    return true;
  } catch(error) {

    log?.debug("Copy-escalation live segment dedup check failed.", { error });

    return false;
  }
}

/** Clear each ahead `traf` on its track; drop mfhd when the track map empties and live mfhd is ahead (or absent). */
export function applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor: LivePrimeMediaFloor, segmentData: Buffer,
  log?: HomebridgePluginLogging): boolean {

  try {

    const timing = parseFmp4MoofTimingBounded(segmentData);

    if(!timing) {

      return false;
    }

    let cleared = false;

    const clearMfhdOnlyTrack = (trackId: number): void => {

      if(!isTrackMfhdOnlyInFloor(floor, trackId)) {

        return;
      }

      if((timing.sequenceNumber === null) || (floor.sequenceNumber === null) || (timing.sequenceNumber <= floor.sequenceNumber)) {

        return;
      }

      floor.trackMfhdOnly = Object.fromEntries(Object.entries(floor.trackMfhdOnly).filter(([id]) => Number(id) !== trackId));
      cleared = true;
    };

    for(const traf of timing.trafs) {

      if(traf.baseMediaDecodeTime !== null) {

        const floorTfdt = floor.trackDecodeTimes[traf.trackId];

        if((floorTfdt !== undefined) && (traf.baseMediaDecodeTime > floorTfdt)) {

          floor.trackDecodeTimes = Object.fromEntries(Object.entries(floor.trackDecodeTimes).filter(([id]) => Number(id) !== traf.trackId));
          cleared = true;
        } else if(floorTfdt === undefined) {

          clearMfhdOnlyTrack(traf.trackId);
        }
      } else if(floor.trackDecodeTimes[traf.trackId] !== undefined) {

        if((timing.sequenceNumber !== null) && (floor.sequenceNumber !== null) && (timing.sequenceNumber > floor.sequenceNumber)) {

          floor.trackDecodeTimes = Object.fromEntries(Object.entries(floor.trackDecodeTimes).filter(([id]) => Number(id) !== traf.trackId));
          cleared = true;
        }
      } else {

        clearMfhdOnlyTrack(traf.trackId);
      }
    }

    if(clearPrimeMfhdWhenTracksEmpty(floor, timing.sequenceNumber)) {

      cleared = true;
    }

    return cleared;
  } catch(error) {

    log?.debug("Copy-escalation prime floor clear check failed.", { error });

    return false;
  }
}
