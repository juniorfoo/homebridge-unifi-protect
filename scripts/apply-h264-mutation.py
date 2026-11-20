#!/usr/bin/env python3
import pathlib
import sys

from mutation_apply import apply_unique

ROOT = pathlib.Path(__file__).resolve().parent.parent
H264 = ROOT / "src/media/h264-fmp4-avcc.ts"

MUTATIONS = {
    "P8_parent_bounds": (
        "((offset + boxSize) > parentEnd)",
        "((offset + boxSize) > data.length)",
    ),
    "P9_level_gate": (
        "parsed.levelIdc <= 30",
        "parsed.levelIdc <= 15",
    ),
    "P10_profile66": (
        "if((parsed.profileIdc === 66) ||",
        "if(false ||",
    ),
    "P12_num_sps": (
        """  if(numSps < 1) {

    return { known: false };
  }
""",
        "",
    ),
    "P17_pps_length": (
        "if((ppsLength < 1) || ((offset + ppsLength) > payload.length))",
        "if(((offset + ppsLength) > payload.length))",
    ),
    "P16_nal_type": (
        "if((spsNalType === undefined) || (((spsNalType & 0x1F) !== 7)))",
        "if(false)",
    ),
    "S1_profile_match": (
        "(spsProfileIdc !== profileIdc) || (spsLevelIdc !== levelIdc)",
        "(spsLevelIdc !== levelIdc)",
    ),
    "S2_level_match": (
        "(spsProfileIdc !== profileIdc) || (spsLevelIdc !== levelIdc)",
        "(spsProfileIdc !== profileIdc)",
    ),
    "S3_sps_short": (
        """    if(spsLength < 4) {

      return { known: false };
    }

""",
        "",
    ),
    "I2_depth_cap": (
        "const FMP4_BOX_WALK_MAX_DEPTH = 8;",
        "const FMP4_BOX_WALK_MAX_DEPTH = 64;",
    ),
    "V1_MAP_ANY_TRAK": (
        "  const parsed = parseFirstMappedVideoTrakAvcC(data);",
        "  const parsed = walkBoxes(data, 0, data.length);",
    ),
    "V1_OFFSET_BUG": (
        "const handlerType = readHandlerTypeInTrak(data, trakPayloadStart, trakEnd);",
        "const handlerType = readHandlerTypeInTrak(data, trakCursor, trakEnd);",
    ),
    "V1_LEGACY_HANDLER_SKIPS": (
        '          if(handlerType === FFMPEG_MAP_SKIP_SOUN_HANDLER) {',
        """          if((handlerType !== null) && (handlerType === "soun" || handlerType === "text" || handlerType === "sbtl" || handlerType === "hint")) {""",
    ),
    "V1_SKIP_SOUN_OFF": (
        """          if(handlerType === FFMPEG_MAP_SKIP_SOUN_HANDLER) {

            trakCursor += trakHeader.boxSize;

            continue;
          }

""",
        "",
    ),
    "V1_VIDE_ONLY": (
        """          if(handlerType === FFMPEG_MAP_SKIP_SOUN_HANDLER) {

            trakCursor += trakHeader.boxSize;

            continue;
          }

          if(!sampleDescriptionIndexGateAllows(data, header.payloadStart, moovEnd, trakPayloadStart, trakEnd)) {

            return { known: false };
          }

          return walkBoxes(data, trakPayloadStart, trakEnd);""",
        """          if(handlerType !== "vide") {

            trakCursor += trakHeader.boxSize;

            continue;
          }

          if(!sampleDescriptionIndexGateAllows(data, header.payloadStart, moovEnd, trakPayloadStart, trakEnd)) {

            return { known: false };
          }

          return walkBoxes(data, trakPayloadStart, trakEnd);""",
    ),
    "V2_gate_fail_continues": (
        """          if(!sampleDescriptionIndexGateAllows(data, header.payloadStart, moovEnd, trakPayloadStart, trakEnd)) {

            return { known: false };
          }""",
        """          if(!sampleDescriptionIndexGateAllows(data, header.payloadStart, moovEnd, trakPayloadStart, trakEnd)) {

            trakCursor += trakHeader.boxSize;

            continue;
          }""",
    ),
    "V1_NULL_FALLTHROUGH": (
        """          if(!sampleDescriptionIndexGateAllows(data, header.payloadStart, moovEnd, trakPayloadStart, trakEnd)) {

            return { known: false };
          }

          return walkBoxes(data, trakPayloadStart, trakEnd);""",
        """          if(handlerType !== null) {

            if(!sampleDescriptionIndexGateAllows(data, header.payloadStart, moovEnd, trakPayloadStart, trakEnd)) {

              return { known: false };
            }

            return walkBoxes(data, trakPayloadStart, trakEnd);
          }

          trakCursor += trakHeader.boxSize;

          continue;""",
    ),
    "V2_STSD_SKIP_NEXT_ENTRY": (
        """  const entry = stsdPayloadStart + 8;

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
}""",
        """  let sampleEntryOffset = stsdPayloadStart + 8;

  while(sampleEntryOffset + 8 <= stsdPayloadEnd) {

    const sampleHeader = readBoxHeader(data, sampleEntryOffset, stsdPayloadEnd);

    if(!sampleHeader) {

      break;
    }

    if((sampleHeader.boxType === "avc1") || (sampleHeader.boxType === "avc3")) {

      const avcC = findAvcCInVisualSampleEntry(data, sampleHeader.payloadStart + VISUAL_SAMPLE_ENTRY_CHILD_OFFSET,
        sampleEntryOffset + sampleHeader.boxSize);

      if(avcC.known) {

        return avcC;
      }
    }

    sampleEntryOffset += sampleHeader.boxSize;
  }

  return { known: false };
}""",
    ),
    "V3_TKHD_V0_OFFSET_ONLY": (
        """      const version = data[payloadStart];

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

      return null;""",
        """      if((payloadStart + 16) > payloadEnd) {

        return null;
      }

      return data.readUInt32BE(payloadStart + 12);""",
    ),
    "V2_STSD_IGNORE_ENTRY_COUNT": (
        """  if(entryCount !== 1) {

    return { known: false };
  }

""",
        "",
    ),
    "V2_STSD_ALLOW_ENTRY_COUNT_ZERO": (
        "  if(entryCount !== 1) {",
        "  if(entryCount > 1) {",
    ),
    "H6_hdlr_bound": (
        "const hdlrEnd = Math.min(mdiaChild + child.boxSize, trakEnd, data.length);",
        "const hdlrEnd = mdiaChild + child.boxSize;",
    ),
    "H6_hdlr_end_trak": (
        "const hdlrEnd = Math.min(mdiaChild + child.boxSize, trakEnd, data.length);",
        "const hdlrEnd = Math.min(trakEnd, data.length);",
    ),
    "I6_trex_track_id": (
        "if(trexTrackId === trackId) {",
        "if(true) {",
    ),
}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <{'|'.join(MUTATIONS)}>")
    mut_id = sys.argv[1]
    if mut_id not in MUTATIONS:
        raise SystemExit(f"unknown mutation {mut_id}")
    old, new = MUTATIONS[mut_id]
    text = H264.read_text()
    H264.write_text(apply_unique(text, old, new, mut_id))


if __name__ == "__main__":
    main()