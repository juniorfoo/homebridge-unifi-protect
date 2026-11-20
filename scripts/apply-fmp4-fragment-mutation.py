#!/usr/bin/env python3
import pathlib
import sys

from mutation_apply import apply_unique

ROOT = pathlib.Path(__file__).resolve().parent.parent
FMP4 = ROOT / "src/media/fmp4-fragment-identity.ts"

MUTATIONS = {
    "PRIME_MOOF_BYTESCAN": (
        """  try {

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
  }""",
        """  try {

  let lastMoof = -1;

  for(let i = 0; i + 8 <= primingBuffer.length; i++) {

    if(readBoxType(primingBuffer, i) === "moof") {

      lastMoof = i;
    }
  }

  if(lastMoof < 0) {

    return null;
  }

  return parseFmp4MediaFragmentIdentity(primingBuffer.subarray(lastMoof));
  } catch(error) {

    log?.debug("Copy-escalation prime floor parse failed.", { error });

    return null;
  }""",
    ),
    "NO_PARENT_BOUND": (
        "  // fmp4-bounded: child boxes must end within parent and buffer.\n  if((end > parentEnd) || (end > data.length))",
        "  if(end > data.length)",
    ),
    "NO_LEAF_LEN": (
        """  const payloadLen = end - start;

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
  }""",
        """  const version = data[start];

  if(version === 0) {

    return data.readUInt32BE(start + 4);
  }

  if(version === 1) {

    return Number(data.readBigUInt64BE(start + 4));
  }""",
    ),
    "LEAF_HDR8": (
        "  start: box.start + box.headerSize",
        "  start: box.start + 8",
    ),
    "DEDUP_SKIP_UNREADABLE": (
        """export function shouldSkipLiveSegmentAfterCopyPrime(floor: LivePrimeMediaFloor, segmentData: Buffer,
  options: { atOrBefore: boolean }, log?: HomebridgePluginLogging): boolean {

  try {

    const timing = parseFmp4MoofTimingBounded(segmentData);

    if(!timing) {

      return false;
    }""",
        """export function shouldSkipLiveSegmentAfterCopyPrime(floor: LivePrimeMediaFloor, segmentData: Buffer,
  options: { atOrBefore: boolean }, log?: HomebridgePluginLogging): boolean {

  try {

    const timing = parseFmp4MoofTimingBounded(segmentData);

    if(!timing) {

      return true;
    }""",
    ),
    "MFHD_FALLBACK_OFF": (
        """      } else {

        const mfhdLag = mfhdSequenceLagging(timing.sequenceNumber, floor.sequenceNumber, options.atOrBefore);

        if((mfhdLag === null) || !mfhdLag) {

          return false;
        }
      }
    }

    return true;""",
        """      } else {

        return false;
      }
    }

    return true;""",
    ),
    "MFHD_STRICT_LT": (
        "  return atOrBefore ? (liveSeq <= floorSeq) : (liveSeq < floorSeq);",
        "  return atOrBefore ? (liveSeq < floorSeq) : (liveSeq < floorSeq);",
    ),
    "PRIME_FLOOR_CLEAR_UNREADABLE": (
        """export function applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor: LivePrimeMediaFloor, segmentData: Buffer,
  log?: HomebridgePluginLogging): boolean {

  try {

    const timing = parseFmp4MoofTimingBounded(segmentData);

    if(!timing) {

      return false;
    }""",
        """export function applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(floor: LivePrimeMediaFloor, segmentData: Buffer,
  log?: HomebridgePluginLogging): boolean {

  try {

    const timing = parseFmp4MoofTimingBounded(segmentData);

    if(!timing) {

      floor.trackDecodeTimes = {};
      floor.sequenceNumber = null;

      return true;
    }""",
    ),
    "MFHD_CLEAR_OFF": (
        """  if((liveSequenceNumber === null) || (liveSequenceNumber > floor.sequenceNumber)) {

    floor.sequenceNumber = null;

    return true;
  }""",
        "  return false;",
    ),
    "PRIME_SKIP_UNKNOWN_TRACK": (
        """      if(!isTrackPrimedInFloor(floor, traf.trackId)) {

        return false;
      }""",
        """      if(!isTrackPrimedInFloor(floor, traf.trackId)) {

        return true;
      }""",
    ),
    "TRAF_UNPAIRED_FLOOR": (
        """        for(const traf of timing.trafs) {

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
        }""",
        """        const legacy = moofTimingToLegacyIdentity(timing);

        if((legacy.trackId !== null) && (legacy.baseMediaDecodeTime !== null)) {

          trackDecodeTimes[legacy.trackId] = legacy.baseMediaDecodeTime;
        }""",
    ),
    "TRAF_FLOOR_FIRST_ONLY": (
        """        for(const traf of timing.trafs) {

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
        }""",
        """        const firstTraf = timing.trafs.find((traf) => traf.baseMediaDecodeTime !== null);

        if((firstTraf !== undefined) && (firstTraf.baseMediaDecodeTime !== null)) {

          trackDecodeTimes[firstTraf.trackId] = firstTraf.baseMediaDecodeTime;
        }""",
    ),
    "SKIP_ANY_TRAF_LAGS": (
        """    for(const traf of timing.trafs) {

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

    return true;""",
        """    for(const traf of timing.trafs) {

      if(traf.baseMediaDecodeTime !== null) {

        const floorTfdt = floor.trackDecodeTimes[traf.trackId];

        if(floorTfdt !== undefined) {

          const lagging = options.atOrBefore ?
            (traf.baseMediaDecodeTime <= floorTfdt) :
            (traf.baseMediaDecodeTime < floorTfdt);

          if(lagging) {

            return true;
          }
        } else {

          const mfhdLag = mfhdSequenceLagging(timing.sequenceNumber, floor.sequenceNumber, options.atOrBefore);

          if((mfhdLag !== null) && mfhdLag) {

            return true;
          }
        }
      } else {

        const mfhdLag = mfhdSequenceLagging(timing.sequenceNumber, floor.sequenceNumber, options.atOrBefore);

        if((mfhdLag !== null) && mfhdLag) {

          return true;
        }
      }
    }

    return false;""",
    ),
    "TFDT_ORPHAN_TRACK1": (
        """  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- tfhd may be absent when mutation strips moof guard
  if(trackId === null) {

    return false;
  }""",
        """  if(trackId === null) {

    if(baseMediaDecodeTime === null) {

      return false;
    }

    trackId = 1;
  }""",
    ),
    "IS_PRIME_FLOOR_EMPTY_TRACKS_ONLY": (
        """  return (Object.keys(floor.trackDecodeTimes).length === 0) && (Object.keys(floor.trackMfhdOnly).length === 0) &&
    (floor.sequenceNumber === null);""",
        "  return (Object.keys(floor.trackDecodeTimes).length === 0) && (Object.keys(floor.trackMfhdOnly).length === 0);",
    ),
    "IS_PRIME_FLOOR_EMPTY_SEQ_ONLY": (
        """  return (Object.keys(floor.trackDecodeTimes).length === 0) && (Object.keys(floor.trackMfhdOnly).length === 0) &&
    (floor.sequenceNumber === null);""",
        "  return floor.sequenceNumber === null;",
    ),
    "MFHD_CLEAR_ON_TFDT_AHEAD": (
        """    if(clearPrimeMfhdWhenTracksEmpty(floor, timing.sequenceNumber)) {

      cleared = true;
    }""",
        "",
    ),
    "CHILD_SIZE_ZERO": (
        "    const box = readBoxHeader(data, child, container.end, false);",
        "    const box = readBoxHeader(data, child, container.end, true);",
    ),
    "R1c_CLEAR_FIRST_TRAF_ONLY": (
        """    const clearMfhdOnlyTrack = (trackId: number): void => {

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

      if(traf.baseMediaDecodeTime !== null) {""",
        """    const clearMfhdOnlyTrack = (trackId: number): void => {

      if(!isTrackMfhdOnlyInFloor(floor, trackId)) {

        return;
      }

      if((timing.sequenceNumber === null) || (floor.sequenceNumber === null) || (timing.sequenceNumber <= floor.sequenceNumber)) {

        return;
      }

      floor.trackMfhdOnly = Object.fromEntries(Object.entries(floor.trackMfhdOnly).filter(([id]) => Number(id) !== trackId));
      cleared = true;
    };

    for(const traf of timing.trafs.slice(0, 1)) {

      if(traf.baseMediaDecodeTime !== null) {""",
    ),
    "R3_UNKNOWN_GUARD_TFDT_ONLY": (
        """    for(const traf of timing.trafs) {

      if(!isTrackPrimedInFloor(floor, traf.trackId)) {

        return false;
      }
    }

    for(const traf of timing.trafs) {""",
        """    for(const traf of timing.trafs) {""",
    ),
    "R4_MFHD_WHEN_TFDT": (
        """        if(floorTfdt !== undefined) {

          const lagging = options.atOrBefore ?
            (traf.baseMediaDecodeTime <= floorTfdt) :
            (traf.baseMediaDecodeTime < floorTfdt);

          if(!lagging) {

            return false;
          }
        } else {""",
        """        if(floorTfdt !== undefined) {

          const mfhdLag = mfhdSequenceLagging(timing.sequenceNumber, floor.sequenceNumber, options.atOrBefore);

          if((mfhdLag === null) || !mfhdLag) {

            return false;
          }
        } else {""",
    ),
    "R5a_MFHD_CLEAR_REQUIRES_LIVE_SEQ": (
        """  if((liveSequenceNumber === null) || (liveSequenceNumber > floor.sequenceNumber)) {

    floor.sequenceNumber = null;

    return true;
  }""",
        """  if(liveSequenceNumber === null) {

    return false;
  }

  if(liveSequenceNumber > floor.sequenceNumber) {

    floor.sequenceNumber = null;

    return true;
  }""",
    ),
    "R5b_MFHD_CLEAR_GTE": (
        """  if((liveSequenceNumber === null) || (liveSequenceNumber > floor.sequenceNumber)) {""",
        """  if((liveSequenceNumber === null) || (liveSequenceNumber >= floor.sequenceNumber)) {""",
    ),
    "R5c_MFHD_CLEAR_ANY_SEQ": (
        """  if((liveSequenceNumber === null) || (liveSequenceNumber > floor.sequenceNumber)) {

    floor.sequenceNumber = null;

    return true;
  }""",
        """  if(floor.sequenceNumber !== null) {

    floor.sequenceNumber = null;

    return true;
  }""",
    ),
    "R11_CLEAR_GTE_TFDT": (
        """      if((floorTfdt !== undefined) && (traf.baseMediaDecodeTime > floorTfdt)) {""",
        """      if((floorTfdt !== undefined) && (traf.baseMediaDecodeTime >= floorTfdt)) {""",
    ),
    "R8_MFHD_ONLY_CLEAR_OFF": (
        """    const clearMfhdOnlyTrack = (trackId: number): void => {

      if(!isTrackMfhdOnlyInFloor(floor, trackId)) {

        return;
      }

      if((timing.sequenceNumber === null) || (floor.sequenceNumber === null) || (timing.sequenceNumber <= floor.sequenceNumber)) {

        return;
      }

      floor.trackMfhdOnly = Object.fromEntries(Object.entries(floor.trackMfhdOnly).filter(([id]) => Number(id) !== trackId));
      cleared = true;
    };""",
        """    const clearMfhdOnlyTrack = (_trackId: number): void => {
    };""",
    ),
    "TFDT_GUARD4": (
        "    if(payloadLen < 8) {",
        "    if(payloadLen < 4) {",
    ),
    "PRIME_MOOF_LASTINDEXOF": (
        """    let offset = 0;
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
    }""",
        """    let lastMoofStart = -1;

    for(let i = primingBuffer.length - 4; i >= 0; i--) {

      if(readBoxType(primingBuffer, i) === "moof") {

        lastMoofStart = i;
        break;
      }
    }""",
    ),
    "M1_MFHD_CLEAR_EQUAL_SEQ": (
        "      if((timing.sequenceNumber === null) || (floor.sequenceNumber === null) || (timing.sequenceNumber <= floor.sequenceNumber)) {",
        "      if((timing.sequenceNumber === null) || (floor.sequenceNumber === null) || (timing.sequenceNumber < floor.sequenceNumber)) {",
    ),
    "M2_MFHD_CLEAR_NULL_LIVE_SEQ": (
        """      if((timing.sequenceNumber === null) || (floor.sequenceNumber === null) || (timing.sequenceNumber <= floor.sequenceNumber)) {

        return;
      }

      floor.trackMfhdOnly = Object.fromEntries(Object.entries(floor.trackMfhdOnly).filter(([id]) => Number(id) !== trackId));""",
        """      if(floor.sequenceNumber === null) {

        return;
      }

      if((timing.sequenceNumber !== null) && (timing.sequenceNumber <= floor.sequenceNumber)) {

        return;
      }

      floor.trackMfhdOnly = Object.fromEntries(Object.entries(floor.trackMfhdOnly).filter(([id]) => Number(id) !== trackId));""",
    ),
    "M3_PRIME_SEQ_LAST_NOT_MAX": (
        """          sequenceNumber = (sequenceNumber === null) ?
            timing.sequenceNumber :
            Math.max(sequenceNumber, timing.sequenceNumber);""",
        "          sequenceNumber = timing.sequenceNumber;",
    ),
    "M4_MFHD_ONLY_STICKY": (
        """            if(trackMfhdOnly[traf.trackId] === true) {

              trackMfhdOnly = Object.fromEntries(Object.entries(trackMfhdOnly).filter(([id]) => Number(id) !== traf.trackId));
            }""",
        "",
    ),
    "M5_NO_MFHD_ONLY_BOOKKEEP": (
        """          } else {

            if(trackDecodeTimes[traf.trackId] === undefined) {

              trackMfhdOnly[traf.trackId] = true;
            }
          }""",
        "          }",
    ),
    "M7_MFHD_CLEAR_WIPE_ALL": (
        "      floor.trackMfhdOnly = Object.fromEntries(Object.entries(floor.trackMfhdOnly).filter(([id]) => Number(id) !== trackId));",
        "      floor.trackMfhdOnly = {};",
    ),
    "M9_SKIP_ON_NULL_MFHD_TFDT_TRAF": (
        """          if((mfhdLag === null) || !mfhdLag) {

            return false;
          }""",
        """          if(mfhdLag === null) {

            return true;
          }

          if(!mfhdLag) {

            return false;
          }""",
    ),
    "M10_SKIP_ON_NULL_MFHD_TFDTLESS": (
        """        if((mfhdLag === null) || !mfhdLag) {

          return false;
        }""",
        """        if(mfhdLag === null) {

          return true;
        }

        if(!mfhdLag) {

          return false;
        }""",
    ),
    "M11_SKIP_AHEAD_MFHD_ON_TFDT_TRAF": (
        """        } else {

          const mfhdLag = mfhdSequenceLagging(timing.sequenceNumber, floor.sequenceNumber, options.atOrBefore);

          if((mfhdLag === null) || !mfhdLag) {

            return false;
          }
        }""",
        """        } else if(traf.baseMediaDecodeTime !== null) {

          return true;
        } else {

          const mfhdLag = mfhdSequenceLagging(timing.sequenceNumber, floor.sequenceNumber, options.atOrBefore);

          if((mfhdLag === null) || !mfhdLag) {

            return false;
          }
        }""",
    ),
    "M12_SKIP_EMPTY_TRAFS": (
        """    if(timing.trafs.length === 0) {

      return false;
    }""",
        """    if(timing.trafs.length === 0) {

      return true;
    }""",
    ),
    "M19_G2_TFDT_FLOOR_CLEAR_OFF": (
        """      } else if(floor.trackDecodeTimes[traf.trackId] !== undefined) {

        if((timing.sequenceNumber !== null) && (floor.sequenceNumber !== null) && (timing.sequenceNumber > floor.sequenceNumber)) {

          floor.trackDecodeTimes = Object.fromEntries(Object.entries(floor.trackDecodeTimes).filter(([id]) => Number(id) !== traf.trackId));
          cleared = true;
        }
      } else {""",
        "      } else {",
    ),
    "G2a_MFHD_CLEAR_GTE": (
        "(timing.sequenceNumber > floor.sequenceNumber)",
        "(timing.sequenceNumber >= floor.sequenceNumber)",
    ),
    "G2b_NULL_LIVE_SEQ_CLEARS_TFDT": (
        """        if((timing.sequenceNumber !== null) && (floor.sequenceNumber !== null) && (timing.sequenceNumber > floor.sequenceNumber)) {

          floor.trackDecodeTimes = Object.fromEntries(Object.entries(floor.trackDecodeTimes).filter(([id]) => Number(id) !== traf.trackId));
          cleared = true;
        }""",
        """        if((floor.sequenceNumber === null) || (timing.sequenceNumber === null) || (timing.sequenceNumber > floor.sequenceNumber)) {

          floor.trackDecodeTimes = Object.fromEntries(Object.entries(floor.trackDecodeTimes).filter(([id]) => Number(id) !== traf.trackId));
          cleared = true;
        }""",
    ),
    "G2c_ALWAYS_CLEAR_TFDT": (
        """        if((floorTfdt !== undefined) && (traf.baseMediaDecodeTime > floorTfdt)) {

          floor.trackDecodeTimes = Object.fromEntries(Object.entries(floor.trackDecodeTimes).filter(([id]) => Number(id) !== traf.trackId));
          cleared = true;
        } else if(floorTfdt === undefined) {

          clearMfhdOnlyTrack(traf.trackId);
        }""",
        """        if(floorTfdt !== undefined) {

          floor.trackDecodeTimes = Object.fromEntries(Object.entries(floor.trackDecodeTimes).filter(([id]) => Number(id) !== traf.trackId));
          cleared = true;
        } else if(floorTfdt === undefined) {

          clearMfhdOnlyTrack(traf.trackId);
        }""",
    ),
    "G2d_CLEAR_ALL_TRACKS": (
        """      } else if(floor.trackDecodeTimes[traf.trackId] !== undefined) {

        if((timing.sequenceNumber !== null) && (floor.sequenceNumber !== null) && (timing.sequenceNumber > floor.sequenceNumber)) {

          floor.trackDecodeTimes = Object.fromEntries(Object.entries(floor.trackDecodeTimes).filter(([id]) => Number(id) !== traf.trackId));
          cleared = true;
        }
      } else {""",
        """      } else if(floor.trackDecodeTimes[traf.trackId] !== undefined) {

        if((timing.sequenceNumber !== null) && (floor.sequenceNumber !== null) && (timing.sequenceNumber > floor.sequenceNumber)) {

          floor.trackDecodeTimes = {};
          cleared = true;
        }
      } else {""",
    ),
    "G2e_NULL_FLOOR_SEQ_CLEARS": (
        """      if((timing.sequenceNumber === null) || (floor.sequenceNumber === null) || (timing.sequenceNumber <= floor.sequenceNumber)) {

        return;
      }""",
        """      if(floor.sequenceNumber === null) {

        floor.trackMfhdOnly = Object.fromEntries(Object.entries(floor.trackMfhdOnly).filter(([id]) => Number(id) !== trackId));
        cleared = true;

        return;
      }

      if((timing.sequenceNumber === null) || (timing.sequenceNumber <= floor.sequenceNumber)) {

        return;
      }""",
    ),
    "G2f_TFDT_ON_MFHD_CLEAR_OFF": (
        """        } else if(floorTfdt === undefined) {

          clearMfhdOnlyTrack(traf.trackId);
        }""",
        "        } else if(floorTfdt === undefined) {\n\n        }",
    ),
    "NO_TRYCATCH": (
        """export function parseFmp4MediaFragmentIdentity(fragment: Buffer): Nullable<Fmp4MediaFragmentIdentity> {

  try {

    return parseFmp4MediaFragmentIdentityBounded(fragment);
  } catch {

    return null;
  }
}""",
        """export function parseFmp4MediaFragmentIdentity(fragment: Buffer): Nullable<Fmp4MediaFragmentIdentity> {

  return parseFmp4MediaFragmentIdentityBounded(fragment);
}""",
    ),
}

NO_TRYCATCH_EXTRA = [
    (
        """  try {

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
  }""",
        """  let offset = 0;
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

  return parseFmp4MediaFragmentIdentity(primingBuffer.subarray(lastMoofStart));""",
    ),
    (
        """  try {

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
  }""",
        """  const timing = parseFmp4MoofTimingBounded(segmentData);

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

  return true;""",
    ),
]


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <{'|'.join(MUTATIONS)}>")
    mut_id = sys.argv[1]
    if mut_id not in MUTATIONS:
        raise SystemExit(f"unknown mutation {mut_id}")
    old, new = MUTATIONS[mut_id]
    text = FMP4.read_text()
    text = apply_unique(text, old, new, mut_id)
    if mut_id == "NO_LEAF_LEN":
        leaf_guard = """  if((end - start) < 8) {

    return null;
  }

"""
        if leaf_guard not in text:
            raise SystemExit("pattern not found for NO_LEAF_LEN follow-up")
        if text.count(leaf_guard) != 2:
            raise SystemExit("pattern for NO_LEAF_LEN leaf_guard matched != 2 times")
        text = text.replace(leaf_guard, "", 2)
        old, new = MUTATIONS["NO_TRYCATCH"]
        if old not in text:
            raise SystemExit("pattern not found for NO_LEAF_LEN parse try/catch strip")
        text = apply_unique(text, old, new, f"{mut_id}-parse-trycatch")
    if mut_id == "NO_TRYCATCH":
        for extra_old, extra_new in NO_TRYCATCH_EXTRA:
            text = apply_unique(text, extra_old, extra_new, f"{mut_id}-extra")
    if mut_id == "TFDT_ORPHAN_TRACK1":
        moof_old = """          if(sawTfdtBox && !sawTfhdBox) {

            return "fail";
          }"""
        text = apply_unique(text, moof_old, "", f"{mut_id}-moof-fail-off")
    FMP4.write_text(text)


if __name__ == "__main__":
    main()