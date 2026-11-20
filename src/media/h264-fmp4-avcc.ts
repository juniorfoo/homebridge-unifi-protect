/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 *
 * h264-fmp4-avcc.ts: Parse profile/level from the avcC box inside an fMP4 initialization segment (buffer / timeshift path).
 */

export interface ParsedH264AvcC {

  levelIdc: number;
  profileIdc: number;
}

export type ParseH264AvcCResult = { known: false } | ({ known: true } & ParsedH264AvcC);

/** Map ITU-T H.264 level_idc to the HAP H264Level rank used in HomeKit negotiations (3.1 -> 0, 3.2 -> 1, 4.0 -> 2, ...). */
export function h264LevelIdcToRank(levelIdc: number): number | undefined {

  const table: [number, number][] = [

    [ 9, -1 ], [ 10, -1 ], [ 11, -1 ], [ 12, -1 ], [ 13, -1 ],
    [ 20, -1 ], [ 21, -1 ], [ 22, -1 ],
    [ 30, -1 ], [ 31, 0 ], [ 32, 1 ],
    [ 40, 2 ], [ 41, 3 ], [ 42, 4 ],
    [ 50, 5 ], [ 51, 6 ]
  ];

  for(const [ idc, rank ] of table) {

    if(levelIdc === idc) {

      return rank >= 0 ? rank : undefined;
    }
  }

  if(levelIdc > 51) {

    return 7;
  }

  return undefined;
}

/** Map AVCProfileIndication to HAP profile rank (baseline 0, main 1, high 2). Profile 66 rejects every Baseline-family indication (including Constrained Baseline). */
export function h264ProfileIdcToRank(profileIdc: number): number | undefined {

  switch(profileIdc) {

    case 66:

      return 0;

    case 77:

      return 1;

    case 100:

      return 2;

    default:

      return undefined;
  }
}

function readBoxHeader(data: Buffer, offset: number, parentEnd: number): { boxSize: number; boxType: string; headerSize: number; payloadStart: number } | null {

  if((offset + 8) > parentEnd) {

    return null;
  }

  let boxSize = data.readUInt32BE(offset);
  const boxType = data.subarray(offset + 4, offset + 8).toString("ascii");
  let headerSize = 8;
  let payloadStart = offset + 8;

  if(boxSize === 1) {

    if(offset + 16 > parentEnd) {

      return null;
    }

    const largesize = Number(data.readBigUInt64BE(offset + 8));

    if((!Number.isSafeInteger(largesize)) || (largesize < 16)) {

      return null;
    }

    boxSize = largesize;
    headerSize = 16;
    payloadStart = offset + 16;
  } else if(boxSize === 0) {

    boxSize = parentEnd - offset;
  }

  if((boxSize < headerSize) || ((offset + boxSize) > parentEnd)) {

    return null;
  }

  return { boxSize: boxSize, boxType: boxType, headerSize: headerSize, payloadStart: payloadStart };
}

function parseAvcCPayload(payload: Buffer): ParseH264AvcCResult {

  if((payload.length < 7) || (payload[0] !== 1)) {

    return { known: false };
  }

  const profileIdc = payload[1];
  const levelIdc = payload[3];

  if((profileIdc === undefined) || (levelIdc === undefined)) {

    return { known: false };
  }

  let offset = 5;

  if(offset >= payload.length) {

    return { known: false };
  }

  const numSpsNibble = payload[offset];

  if(numSpsNibble === undefined) {

    return { known: false };
  }

  const numSps = numSpsNibble & 0x1F;

  offset += 1;

  if(numSps < 1) {

    return { known: false };
  }

  for(let spsIndex = 0; spsIndex < numSps; spsIndex++) {

    if(offset + 2 > payload.length) {

      return { known: false };
    }

    const spsLength = payload.readUInt16BE(offset);

    offset += 2;

    if((spsLength < 1) || ((offset + spsLength) > payload.length)) {

      return { known: false };
    }

    const spsNalType = payload[offset];

    if((spsNalType === undefined) || (((spsNalType & 0x1F) !== 7))) {

      return { known: false };
    }

    if(spsLength < 4) {

      return { known: false };
    }

    const spsProfileIdc = payload[offset + 1];
    const spsLevelIdc = payload[offset + 3];

    if((spsProfileIdc === undefined) || (spsLevelIdc === undefined) || (spsProfileIdc !== profileIdc) || (spsLevelIdc !== levelIdc)) {

      return { known: false };
    }

    offset += spsLength;
  }

  if(offset >= payload.length) {

    return { known: false };
  }

  const numPpsByte = payload[offset];

  if(numPpsByte === undefined) {

    return { known: false };
  }

  const numPps = numPpsByte;

  offset += 1;

  if(numPps < 1) {

    return { known: false };
  }

  for(let ppsIndex = 0; ppsIndex < numPps; ppsIndex++) {

    if(offset + 2 > payload.length) {

      return { known: false };
    }

    const ppsLength = payload.readUInt16BE(offset);

    offset += 2;

    if((ppsLength < 1) || ((offset + ppsLength) > payload.length)) {

      return { known: false };
    }

    const ppsNalType = payload[offset];

    if((ppsNalType === undefined) || (((ppsNalType & 0x1F) !== 8))) {

      return { known: false };
    }

    offset += ppsLength;
  }

  return { known: true, levelIdc: levelIdc, profileIdc: profileIdc };
}

function findAvcCInVisualSampleEntry(data: Buffer, payloadStart: number, payloadEnd: number): ParseH264AvcCResult {

  let child = payloadStart;

  while(child + 8 <= payloadEnd) {

    const header = readBoxHeader(data, child, payloadEnd);

    if(!header) {

      break;
    }

    if(header.boxType === "avcC") {

      return parseAvcCPayload(data.subarray(header.payloadStart, child + header.boxSize));
    }

    child += header.boxSize;
  }

  return { known: false };
}

const NESTABLE_BOX_TYPES = new Set([ "moov", "trak", "mdia", "minf", "stbl", "edts", "dinf", "avc1", "avc3" ]);

const VISUAL_SAMPLE_ENTRY_CHILD_OFFSET = 78;

/** FFmpeg uses stsd sample description index 1 only; extra entries are not consulted for `0:v:0`. */
function walkStsdSampleEntries(data: Buffer, stsdPayloadStart: number, stsdPayloadEnd: number): ParseH264AvcCResult {

  if((stsdPayloadEnd - stsdPayloadStart) < 8) {

    return { known: false };
  }

  const entryCount = data.readUInt32BE(stsdPayloadStart + 4);

  if(entryCount !== 1) {

    return { known: false };
  }

  const entry = stsdPayloadStart + 8;

  if(entry + 8 > stsdPayloadEnd) {

    return { known: false };
  }

  const header = readBoxHeader(data, entry, stsdPayloadEnd);

  if(!header) {

    return { known: false };
  }

  const entryEnd = entry + header.boxSize;

  if(entryEnd > stsdPayloadEnd) {

    return { known: false };
  }

  if((header.boxType === "avc1") || (header.boxType === "avc3")) {

    return findAvcCInVisualSampleEntry(data, header.payloadStart + VISUAL_SAMPLE_ENTRY_CHILD_OFFSET, entryEnd);
  }

  return { known: false };
}

const TFHD_FLAG_SAMPLE_DESCRIPTION_INDEX = 0x000002;

function readTkhdTrackId(data: Buffer, trakPayloadStart: number, trakEnd: number): number | null {

  let cursor = trakPayloadStart;

  while(cursor + 8 <= trakEnd) {

    const header = readBoxHeader(data, cursor, trakEnd);

    if(!header) {

      break;
    }

    if(header.boxType === "tkhd") {

      const payloadStart = header.payloadStart;
      const payloadEnd = cursor + header.boxSize;

      if((payloadEnd - payloadStart) < 4) {

        return null;
      }

      const version = data[payloadStart];

      if(version === 0) {

        if((payloadStart + 16) > payloadEnd) {

          return null;
        }

        return data.readUInt32BE(payloadStart + 12);
      }

      if(version === 1) {

        if((payloadStart + 24) > payloadEnd) {

          return null;
        }

        return data.readUInt32BE(payloadStart + 20);
      }

      return null;
    }

    cursor += header.boxSize;
  }

  return null;
}

function readTrexDefaultSampleDescriptionIndex(data: Buffer, moovPayloadStart: number, moovEnd: number, trackId: number): number | null {

  let cursor = moovPayloadStart;

  while(cursor + 8 <= moovEnd) {

    const header = readBoxHeader(data, cursor, moovEnd);

    if(!header) {

      break;
    }

    if(header.boxType === "mvex") {

      const mvexEnd = cursor + header.boxSize;
      let mvexChild = header.payloadStart;

      while(mvexChild + 8 <= mvexEnd) {

        const trexHeader = readBoxHeader(data, mvexChild, mvexEnd);

        if(!trexHeader) {

          break;
        }

        if(trexHeader.boxType === "trex") {

          const payloadStart = trexHeader.payloadStart;
          const payloadEnd = mvexChild + trexHeader.boxSize;

          if((payloadStart + 12) <= payloadEnd) {

            const trexTrackId = data.readUInt32BE(payloadStart + 4);

            if(trexTrackId === trackId) {

              return data.readUInt32BE(payloadStart + 8);
            }
          }
        }

        mvexChild += trexHeader.boxSize;
      }
    }

    cursor += header.boxSize;
  }

  return null;
}

interface TfhdTrackSampleDescription { sampleDescriptionIndex: number | null; trackId: number }

function readTfhdTrackAndSampleDescriptionIndex(data: Buffer, payloadStart: number, payloadEnd: number): TfhdTrackSampleDescription | null {

  if((payloadEnd - payloadStart) < 8) {

    return null;
  }

  const versionAndFlags = data.readUInt32BE(payloadStart);
  const flags = versionAndFlags & 0x00FFFFFF;
  const trackId = data.readUInt32BE(payloadStart + 4);
  let offset = payloadStart + 8;

  if((flags & 0x000001) !== 0) {

    if((offset + 8) > payloadEnd) {

      return null;
    }

    offset += 8;
  }

  let sampleDescriptionIndex: number | null = null;

  if((flags & TFHD_FLAG_SAMPLE_DESCRIPTION_INDEX) !== 0) {

    if((offset + 4) > payloadEnd) {

      return null;
    }

    sampleDescriptionIndex = data.readUInt32BE(offset);
  }

  return { sampleDescriptionIndex, trackId };
}

function mappedTrackTfhdSampleDescriptionIndexNotOne(data: Buffer, dataEnd: number, mappedTrackId: number): boolean {

  const regions: { end: number; start: number }[] = [{ end: dataEnd, start: 0 }];

  while(regions.length > 0) {

    const region = regions.pop();

    if(region === undefined) {

      continue;
    }

    let cursor = region.start;

    while(cursor + 8 <= region.end) {

      const header = readBoxHeader(data, cursor, region.end);

      if(!header) {

        break;
      }

      const payloadEnd = cursor + header.boxSize;

      if(header.boxType === "tfhd") {

        const tfhd = readTfhdTrackAndSampleDescriptionIndex(data, header.payloadStart, payloadEnd);

        if((tfhd !== null) && (tfhd.trackId === mappedTrackId) && (tfhd.sampleDescriptionIndex !== null) && (tfhd.sampleDescriptionIndex !== 1)) {

          return true;
        }
      }

      if((header.boxType === "moov") || (header.boxType === "moof") || (header.boxType === "traf") || (header.boxType === "mvex")) {

        regions.push({ end: payloadEnd, start: header.payloadStart });
      }

      cursor += header.boxSize;
    }
  }

  return false;
}

function sampleDescriptionIndexGateAllows(data: Buffer, moovPayloadStart: number, moovEnd: number, trakPayloadStart: number, trakEnd: number): boolean {

  const trackId = readTkhdTrackId(data, trakPayloadStart, trakEnd);

  if(trackId === null) {

    return false;
  }
  const trexIndex = readTrexDefaultSampleDescriptionIndex(data, moovPayloadStart, moovEnd, trackId);

  if((trexIndex !== null) && (trexIndex !== 1)) {

    return false;
  }

  if(mappedTrackTfhdSampleDescriptionIndexNotOne(data, data.length, trackId)) {

    return false;
  }

  return true;
}

const FMP4_BOX_WALK_MAX_DEPTH = 8;

function readHandlerTypeInTrak(data: Buffer, trakStart: number, trakEnd: number): string | null {

  let cursor = trakStart;

  while(cursor + 8 <= trakEnd) {

    const header = readBoxHeader(data, cursor, trakEnd);

    if(!header) {

      break;
    }

    if(header.boxType === "mdia") {

      let mdiaChild = header.payloadStart;

      while(mdiaChild + 8 <= cursor + header.boxSize) {

        const child = readBoxHeader(data, mdiaChild, cursor + header.boxSize);

        if(!child) {

          break;
        }

        if(child.boxType === "hdlr") {

          const payloadStart = child.payloadStart;
          const hdlrEnd = Math.min(mdiaChild + child.boxSize, trakEnd, data.length);

          if((payloadStart + 12) > hdlrEnd) {

            return null;
          }

          return data.subarray(payloadStart + 8, payloadStart + 12).toString("ascii");
        }

        mdiaChild += child.boxSize;
      }
    }

    cursor += header.boxSize;
  }

  return null;
}

/** FFmpeg `-map 0:v:0` maps the first `trak` that is not `soun` (audio is excluded only). */
const FFMPEG_MAP_SKIP_SOUN_HANDLER = "soun";

/** Match FFmpeg `-map 0:v:0`: first non-`soun` `trak` is mapped; validate it or return unknown (no fall-through). */
function parseFirstMappedVideoTrakAvcC(data: Buffer): ParseH264AvcCResult {

  let cursor = 0;

  while(cursor + 8 <= data.length) {

    const header = readBoxHeader(data, cursor, data.length);

    if(!header) {

      break;
    }

    if(header.boxType === "moov") {

      const moovEnd = cursor + header.boxSize;
      let trakCursor = header.payloadStart;

      while(trakCursor + 8 <= moovEnd) {

        const trakHeader = readBoxHeader(data, trakCursor, moovEnd);

        if(!trakHeader) {

          break;
        }

        if(trakHeader.boxType === "trak") {

          const trakEnd = trakCursor + trakHeader.boxSize;
          const trakPayloadStart = trakHeader.payloadStart;
          const handlerType = readHandlerTypeInTrak(data, trakPayloadStart, trakEnd);

          if(handlerType === FFMPEG_MAP_SKIP_SOUN_HANDLER) {

            trakCursor += trakHeader.boxSize;

            continue;
          }

          if(!sampleDescriptionIndexGateAllows(data, header.payloadStart, moovEnd, trakPayloadStart, trakEnd)) {

            return { known: false };
          }

          return walkBoxes(data, trakPayloadStart, trakEnd);
        }

        trakCursor += trakHeader.boxSize;
      }

      return { known: false };
    }

    cursor += header.boxSize;
  }

  return { known: false };
}

function walkBoxes(data: Buffer, offset: number, end: number, depth = 0): ParseH264AvcCResult {

  if(depth > FMP4_BOX_WALK_MAX_DEPTH) {

    return { known: false };
  }

  let cursor = offset;

  while(cursor + 8 <= end) {

    const header = readBoxHeader(data, cursor, end);

    if(!header) {

      break;
    }

    const payloadEnd = cursor + header.boxSize;

    if(header.boxType === "stsd") {

      const stsd = walkStsdSampleEntries(data, header.payloadStart, payloadEnd);

      if(stsd.known) {

        return stsd;
      }
    }

    if(NESTABLE_BOX_TYPES.has(header.boxType)) {

      const nested = walkBoxes(data, header.payloadStart, payloadEnd, depth + 1);

      if(nested.known) {

        return nested;
      }
    }

    cursor += header.boxSize;
  }

  return { known: false };
}

/**
 * Walk the fMP4 box tree (moov/trak/mdia/minf/stbl/stsd/avc1|avc3/avcC) for profile/level.
 * Returns { known: false } on truncation, bad sizes, wrong avcC version, stray matches, missing path (safe default: transcode).
 * Profile 66 (all Baseline-family indications, including Constrained Baseline) is rejected for the copy gate.
 */
export function parseH264AvcCFromFmp4Init(data: Buffer): ParseH264AvcCResult {

  if(data.length < 8) {

    return { known: false };
  }

  const parsed = parseFirstMappedVideoTrakAvcC(data);

  if(!parsed.known) {

    return { known: false };
  }

  if((parsed.profileIdc === 66) || (parsed.levelIdc <= 30)) {

    return { known: false };
  }

  return parsed;
}
