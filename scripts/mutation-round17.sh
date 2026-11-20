#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

STREAM=src/media/stream.ts
TS=src/media/timeshift.ts
FEED=src/media/stream-live-feed.ts
H264=src/media/h264-fmp4-avcc.ts
WIRING=src/media/stream-live-wiring.ts
POLICY=src/media/stream-transcode-policy.ts
TESTING=src/testing.helpers.ts
FMP4=src/media/fmp4-fragment-identity.ts

any_issue=0

# One process per test file so stream.ts mutations are picked up by integration tests (C1, G4c).
run_tests() {
  node --test --experimental-test-coverage --test-timeout=15000 --experimental-test-isolation=process "src/**/*.test.ts" 2>/dev/null
}

on_sigint() {
  restore_all || true
  exit 130
}

on_sigterm() {
  restore_all || true
  exit 143
}

trap 'restore_all || true' EXIT
trap on_sigint INT
trap on_sigterm TERM

baseline() {
  run_tests
}

restore_all() {
  [[ -f "$STREAM.bak" ]] && mv -f "$STREAM.bak" "$STREAM" || true
  [[ -f "$TS.bak" ]] && mv -f "$TS.bak" "$TS" || true
  [[ -f "$FEED.bak" ]] && mv -f "$FEED.bak" "$FEED" || true
  [[ -f "$H264.bak" ]] && mv -f "$H264.bak" "$H264" || true
  [[ -f "$WIRING.bak" ]] && mv -f "$WIRING.bak" "$WIRING" || true
  [[ -f "$POLICY.bak" ]] && mv -f "$POLICY.bak" "$POLICY" || true
  [[ -f "$TESTING.bak" ]] && mv -f "$TESTING.bak" "$TESTING" || true
  [[ -f "$FMP4.bak" ]] && mv -f "$FMP4.bak" "$FMP4" || true
}

mutant_typechecks() {
  npx tsc --noEmit >/dev/null 2>&1
}

files_changed() {
  local path
  local any=0
  for path in "$@"; do
    if ! diff -q "${path}.bak" "$path" >/dev/null 2>&1; then
      any=1
    fi
  done
  [[ "$any" -eq 1 ]]
}

report_row() {
  local id="$1"
  local status="$2"
  echo "$id,$status"
  if [[ "$status" != "CAUGHT" && "$status" != "EQUIVALENT" ]]; then
    any_issue=1
  fi
}

# Keep going when a mutation applier fails; row status must fail the ledger.
apply_mutation_or_report() {
  local id="$1"
  shift
  set +e
  eval "$@"
  local apply_exit=$?
  set -e
  if [[ "$apply_exit" -ne 0 ]]; then
    echo "$id mutation APPLY-FAIL"
    report_row "$id" "APPLY-FAIL"
    return 1
  fi
  return 0
}

run_mut_expected_survivor() {
  local id="$1"
  shift
  local touched=( "$STREAM" "$TS" "$FEED" "$H264" "$WIRING" "$POLICY" "$FMP4" )
  echo "=== $id baseline ==="
  baseline && echo "$id baseline PASS" || { echo "$id baseline FAIL"; exit 1; }
  cp "$STREAM" "$STREAM.bak"
  cp "$TS" "$TS.bak"
  cp "$FEED" "$FEED.bak"
  cp "$H264" "$H264.bak"
  cp "$WIRING" "$WIRING.bak"
  cp "$POLICY" "$POLICY.bak"
  cp "$FMP4" "$FMP4.bak"
  apply_mutation_or_report "$id" "$@" || { restore_all; return; }
  if ! files_changed "${touched[@]}"; then
    echo "$id mutation NO-OP"
    report_row "$id" "NO-OP"
    restore_all
    return
  fi
  if ! mutant_typechecks; then
    echo "$id mutation COMPILE-FAIL"
    report_row "$id" "COMPILE-FAIL"
    restore_all
    return
  fi
  echo "=== $id mutation (expected survivor) ==="
  set +e
  run_tests
  mutation_exit=$?
  set -e
  if [ "$mutation_exit" -ne 0 ]; then
    echo "$id mutation UNEXPECTED-CAUGHT (equivalent regression)"
    report_row "$id" "UNEXPECTED-CAUGHT"
  else
    echo "$id mutation PASS (equivalent survivor)"
    report_row "$id" "EQUIVALENT"
  fi
  restore_all
}

run_mut() {
  local id="$1"
  shift
  local touched=( "$STREAM" "$TS" "$FEED" "$H264" "$WIRING" "$POLICY" "$FMP4" )
  echo "=== $id baseline ==="
  baseline && echo "$id baseline PASS" || { echo "$id baseline FAIL"; exit 1; }
  cp "$STREAM" "$STREAM.bak"
  cp "$TS" "$TS.bak"
  cp "$FEED" "$FEED.bak"
  cp "$H264" "$H264.bak"
  cp "$WIRING" "$WIRING.bak"
  cp "$POLICY" "$POLICY.bak"
  cp "$FMP4" "$FMP4.bak"
  apply_mutation_or_report "$id" "$@" || { restore_all; return; }
  if ! files_changed "${touched[@]}"; then
    echo "$id mutation NO-OP"
    report_row "$id" "NO-OP"
    restore_all
    return
  fi
  if ! mutant_typechecks; then
    echo "$id mutation COMPILE-FAIL"
    report_row "$id" "COMPILE-FAIL"
    restore_all
    return
  fi
  echo "=== $id mutation ==="
  set +e
  run_tests
  mutation_exit=$?
  set -e
  if [ "$mutation_exit" -eq 0 ]; then
    echo "$id mutation UNEXPECTED PASS"
    report_row "$id" "UNEXPECTED"
  else
    echo "$id mutation FAIL (good)"
    report_row "$id" "CAUGHT"
  fi
  restore_all
}

run_testing_mut() {
  local id="$1"
  shift
  echo "=== $id baseline ==="
  baseline && echo "$id baseline PASS" || { echo "$id baseline FAIL"; exit 1; }
  cp "$TESTING" "$TESTING.bak"
  apply_mutation_or_report "$id" "$@" || { mv -f "$TESTING.bak" "$TESTING"; return; }
  if ! files_changed "$TESTING"; then
    echo "$id mutation NO-OP"
    report_row "$id" "NO-OP"
    mv -f "$TESTING.bak" "$TESTING"
    return
  fi
  if ! mutant_typechecks; then
    echo "$id mutation COMPILE-FAIL"
    report_row "$id" "COMPILE-FAIL"
    mv -f "$TESTING.bak" "$TESTING"
    return
  fi
  echo "=== $id mutation ==="
  set +e
  run_tests
  mutation_exit=$?
  set -e
  if [ "$mutation_exit" -eq 0 ]; then
    echo "$id mutation UNEXPECTED PASS"
    report_row "$id" "UNEXPECTED"
  else
    echo "$id mutation FAIL (good)"
    report_row "$id" "CAUGHT"
  fi
  mv -f "$TESTING.bak" "$TESTING"
}

run_feed_mut() {
  local id="$1"
  shift
  echo "=== $id baseline ==="
  baseline && echo "$id baseline PASS" || { echo "$id baseline FAIL"; exit 1; }
  cp "$FEED" "$FEED.bak"
  apply_mutation_or_report "$id" "$@" || { mv -f "$FEED.bak" "$FEED"; return; }
  if ! files_changed "$FEED"; then
    echo "$id mutation NO-OP"
    report_row "$id" "NO-OP"
    mv -f "$FEED.bak" "$FEED"
    return
  fi
  if ! mutant_typechecks; then
    echo "$id mutation COMPILE-FAIL"
    report_row "$id" "COMPILE-FAIL"
    mv -f "$FEED.bak" "$FEED"
    return
  fi
  echo "=== $id mutation ==="
  set +e
  run_tests
  mutation_exit=$?
  set -e
  if [ "$mutation_exit" -eq 0 ]; then
    echo "$id mutation UNEXPECTED PASS"
    report_row "$id" "UNEXPECTED"
  else
    echo "$id mutation FAIL (good)"
    report_row "$id" "CAUGHT"
  fi
  mv -f "$FEED.bak" "$FEED"
}

run_fmp4_mut() {
  local id="$1"
  shift
  echo "=== $id baseline ==="
  baseline && echo "$id baseline PASS" || { echo "$id baseline FAIL"; exit 1; }
  cp "$FMP4" "$FMP4.bak"
  apply_mutation_or_report "$id" "$@" || { mv -f "$FMP4.bak" "$FMP4"; return; }
  if ! files_changed "$FMP4"; then
    echo "$id mutation NO-OP"
    report_row "$id" "NO-OP"
    mv -f "$FMP4.bak" "$FMP4"
    return
  fi
  if ! mutant_typechecks; then
    echo "$id mutation COMPILE-FAIL"
    report_row "$id" "COMPILE-FAIL"
    mv -f "$FMP4.bak" "$FMP4"
    return
  fi
  echo "=== $id mutation ==="
  set +e
  run_tests
  mutation_exit=$?
  set -e
  if [ "$mutation_exit" -eq 0 ]; then
    echo "$id mutation UNEXPECTED PASS"
    report_row "$id" "UNEXPECTED"
  else
    echo "$id mutation FAIL (good)"
    report_row "$id" "CAUGHT"
  fi
  mv -f "$FMP4.bak" "$FMP4"
}

run_h264_mut() {
  local id="$1"
  shift
  echo "=== $id baseline ==="
  baseline && echo "$id baseline PASS" || { echo "$id baseline FAIL"; exit 1; }
  cp "$H264" "$H264.bak"
  apply_mutation_or_report "$id" "$@" || { mv -f "$H264.bak" "$H264"; return; }
  if ! files_changed "$H264"; then
    echo "$id mutation NO-OP"
    report_row "$id" "NO-OP"
    mv -f "$H264.bak" "$H264"
    return
  fi
  if ! mutant_typechecks; then
    echo "$id mutation COMPILE-FAIL"
    report_row "$id" "COMPILE-FAIL"
    mv -f "$H264.bak" "$H264"
    return
  fi
  echo "=== $id mutation ==="
  set +e
  run_tests
  mutation_exit=$?
  set -e
  if [ "$mutation_exit" -eq 0 ]; then
    echo "$id mutation UNEXPECTED PASS"
    report_row "$id" "UNEXPECTED"
  else
    echo "$id mutation FAIL (good)"
    report_row "$id" "CAUGHT"
  fi
  mv -f "$H264.bak" "$H264"
}

run_mut C1 "sed -i 's/resolveStartStreamForceTranscodeDueToUserOption(this.protectCamera, isHighLatency);/false;/' \"$STREAM\""
run_mut C2 "sed -i 's/forceTranscodeDueToUserOption: forceTranscodeDueToUserOption,/forceTranscodeDueToUserOption: false,/' \"$STREAM\""
run_mut D1 "python3 scripts/apply-stream-mutation.py D1"
run_mut D1b "python3 scripts/apply-stream-mutation.py D1b"
run_mut D1w "python3 scripts/apply-feed-mutation.py D1w"
run_mut K2 "python3 scripts/apply-stream-mutation.py K2"
run_mut K3 "sed -i 's/activeFfmpeg = respawned;/\/\/ onRespawned noop/' \"$STREAM\""
run_mut N "sed -i 's/resolveStreamEgressBitrateBps(isTranscoding, transcodeTargetBitrate, channelProfile.channel.bitrate);/(isTranscoding ? transcodeTargetBitrate : targetBitrate) * 1000;/' \"$STREAM\""
run_mut G4a "sed -i 's/const timeshiftPrefixBuffer = useTsb ? (this.timeshift?.buffer.getLast(PROTECT_LIVESTREAM_API_IDR_INTERVAL \\* 1000) ?? null) : null;/const timeshiftPrefixBuffer: Nullable<Buffer> = null;/' \"$STREAM\""
run_mut G4c "sed -i 's/this.timeshift?.buffer.getLast(PROTECT_LIVESTREAM_API_IDR_INTERVAL \\* 1000)/this.timeshift?.buffer.fmp4InitSegmentData/' \"$STREAM\"; sed -i 's/getLast(PROTECT_LIVESTREAM_API_IDR_INTERVAL \\* 1000)/fmp4InitSegmentData/' \"$STREAM\"; sed -i '/channel profile backing/i\\  public get fmp4InitSegmentData(): Nullable<Buffer> { return this.subscription?.initSegment?.data ?? null; }' \"$TS\""
run_mut G4stdin "sed -i 's/}, tsBuffer, (): void =>/}, null, (): void =>/' \"$STREAM\""
run_mut R3 "python3 scripts/apply-wiring-mutation.py R3"
run_mut R5 "python3 scripts/apply-wiring-mutation.py R5"
run_mut R5_callsite "python3 scripts/apply-stream-mutation.py R5_callsite"
run_mut I2_keyframe_prime "python3 scripts/apply-feed-mutation.py I2_keyframe_prime"
run_mut KP3 "python3 scripts/apply-timeshift-mutation.py KP3"
run_mut KP4 "python3 scripts/apply-timeshift-mutation.py KP4"
run_mut KP5 "python3 scripts/apply-timeshift-mutation.py KP5"
run_mut prime_mismatch "python3 scripts/apply-wiring-mutation.py prime_mismatch"
run_mut PM3 "python3 scripts/apply-wiring-mutation.py PM3"
run_mut PM4 "python3 scripts/apply-stream-mutation.py PM4"
run_mut BD5 "python3 scripts/apply-stream-mutation.py BD5"
run_mut BD7 "python3 scripts/apply-stream-mutation.py BD7"
run_mut BD7w "python3 scripts/apply-wiring-mutation.py BD7w"
run_mut X9 "python3 scripts/apply-wiring-mutation.py X9"
run_mut_expected_survivor BD3b "python3 scripts/apply-wiring-mutation.py BD3b"
run_mut I1 "python3 scripts/apply-policy-mutation.py I1"
run_mut_expected_survivor PM5 "python3 scripts/apply-stream-mutation.py PM5"
run_mut_expected_survivor BD6r "python3 scripts/apply-stream-mutation.py BD6r"
run_feed_mut PRIME_DEDUP_OFF "python3 scripts/apply-feed-mutation.py PRIME_DEDUP_OFF"
run_feed_mut PRIME_DEDUP_STRICT "python3 scripts/apply-feed-mutation.py PRIME_DEDUP_STRICT"
run_feed_mut PRIME_FLOOR_NEVER_CLEAR "python3 scripts/apply-feed-mutation.py PRIME_FLOOR_NEVER_CLEAR"
run_feed_mut PRIME_FLOOR_CLEAR_ANY "python3 scripts/apply-feed-mutation.py PRIME_FLOOR_CLEAR_ANY"
run_feed_mut PRIME_CLEAR_ALL_ON_ONE_TRACK "python3 scripts/apply-feed-mutation.py PRIME_CLEAR_ALL_ON_ONE_TRACK"
run_fmp4_mut PRIME_MOOF_BYTESCAN "python3 scripts/apply-fmp4-fragment-mutation.py PRIME_MOOF_BYTESCAN"
run_fmp4_mut NO_PARENT_BOUND "python3 scripts/apply-fmp4-fragment-mutation.py NO_PARENT_BOUND"
run_fmp4_mut NO_LEAF_LEN "python3 scripts/apply-fmp4-fragment-mutation.py NO_LEAF_LEN"
run_fmp4_mut LEAF_HDR8 "python3 scripts/apply-fmp4-fragment-mutation.py LEAF_HDR8"
run_fmp4_mut NO_TRYCATCH "python3 scripts/apply-fmp4-fragment-mutation.py NO_TRYCATCH"
run_fmp4_mut DEDUP_SKIP_UNREADABLE "python3 scripts/apply-fmp4-fragment-mutation.py DEDUP_SKIP_UNREADABLE"
run_fmp4_mut MFHD_FALLBACK_OFF "python3 scripts/apply-fmp4-fragment-mutation.py MFHD_FALLBACK_OFF"
run_fmp4_mut MFHD_STRICT_LT "python3 scripts/apply-fmp4-fragment-mutation.py MFHD_STRICT_LT"
run_fmp4_mut TFDT_GUARD4 "python3 scripts/apply-fmp4-fragment-mutation.py TFDT_GUARD4"
run_fmp4_mut PRIME_MOOF_LASTINDEXOF "python3 scripts/apply-fmp4-fragment-mutation.py PRIME_MOOF_LASTINDEXOF"
run_fmp4_mut PRIME_FLOOR_CLEAR_UNREADABLE "python3 scripts/apply-fmp4-fragment-mutation.py PRIME_FLOOR_CLEAR_UNREADABLE"
run_fmp4_mut MFHD_CLEAR_OFF "python3 scripts/apply-fmp4-fragment-mutation.py MFHD_CLEAR_OFF"
run_fmp4_mut TRAF_UNPAIRED_FLOOR "python3 scripts/apply-fmp4-fragment-mutation.py TRAF_UNPAIRED_FLOOR"
run_fmp4_mut TRAF_FLOOR_FIRST_ONLY "python3 scripts/apply-fmp4-fragment-mutation.py TRAF_FLOOR_FIRST_ONLY"
run_fmp4_mut SKIP_ANY_TRAF_LAGS "python3 scripts/apply-fmp4-fragment-mutation.py SKIP_ANY_TRAF_LAGS"
run_fmp4_mut TFDT_ORPHAN_TRACK1 "python3 scripts/apply-fmp4-fragment-mutation.py TFDT_ORPHAN_TRACK1"
run_fmp4_mut IS_PRIME_FLOOR_EMPTY_TRACKS_ONLY "python3 scripts/apply-fmp4-fragment-mutation.py IS_PRIME_FLOOR_EMPTY_TRACKS_ONLY"
run_fmp4_mut IS_PRIME_FLOOR_EMPTY_SEQ_ONLY "python3 scripts/apply-fmp4-fragment-mutation.py IS_PRIME_FLOOR_EMPTY_SEQ_ONLY"
run_fmp4_mut MFHD_CLEAR_ON_TFDT_AHEAD "python3 scripts/apply-fmp4-fragment-mutation.py MFHD_CLEAR_ON_TFDT_AHEAD"
run_fmp4_mut PRIME_SKIP_UNKNOWN_TRACK "python3 scripts/apply-fmp4-fragment-mutation.py PRIME_SKIP_UNKNOWN_TRACK"
run_fmp4_mut CHILD_SIZE_ZERO "python3 scripts/apply-fmp4-fragment-mutation.py CHILD_SIZE_ZERO"
run_fmp4_mut R1c_CLEAR_FIRST_TRAF_ONLY "python3 scripts/apply-fmp4-fragment-mutation.py R1c_CLEAR_FIRST_TRAF_ONLY"
run_fmp4_mut R3_UNKNOWN_GUARD_TFDT_ONLY "python3 scripts/apply-fmp4-fragment-mutation.py R3_UNKNOWN_GUARD_TFDT_ONLY"
run_fmp4_mut R4_MFHD_WHEN_TFDT "python3 scripts/apply-fmp4-fragment-mutation.py R4_MFHD_WHEN_TFDT"
run_fmp4_mut R5a_MFHD_CLEAR_REQUIRES_LIVE_SEQ "python3 scripts/apply-fmp4-fragment-mutation.py R5a_MFHD_CLEAR_REQUIRES_LIVE_SEQ"
run_fmp4_mut R5b_MFHD_CLEAR_GTE "python3 scripts/apply-fmp4-fragment-mutation.py R5b_MFHD_CLEAR_GTE"
run_fmp4_mut R5c_MFHD_CLEAR_ANY_SEQ "python3 scripts/apply-fmp4-fragment-mutation.py R5c_MFHD_CLEAR_ANY_SEQ"
run_fmp4_mut R11_CLEAR_GTE_TFDT "python3 scripts/apply-fmp4-fragment-mutation.py R11_CLEAR_GTE_TFDT"
run_fmp4_mut R8_MFHD_ONLY_CLEAR_OFF "python3 scripts/apply-fmp4-fragment-mutation.py R8_MFHD_ONLY_CLEAR_OFF"
run_feed_mut P4_FLOOR_NEVER_EXPIRE "python3 scripts/apply-feed-mutation.py P4_FLOOR_NEVER_EXPIRE"
run_feed_mut M13_P4_EXPIRE_GTE "python3 scripts/apply-feed-mutation.py M13_P4_EXPIRE_GTE"
run_feed_mut M14_P4_CAP_TOO_LOW "python3 scripts/apply-feed-mutation.py M14_P4_CAP_TOO_LOW"
run_feed_mut M14b_P4_CAP_50 "python3 scripts/apply-feed-mutation.py M14b_P4_CAP_50"
run_feed_mut M14c_P4_CAP_30 "python3 scripts/apply-feed-mutation.py M14c_P4_CAP_30"
run_feed_mut M15_P4_COUNTER_ON_SKIP "python3 scripts/apply-feed-mutation.py M15_P4_COUNTER_ON_SKIP"
run_fmp4_mut M1_MFHD_CLEAR_EQUAL_SEQ "python3 scripts/apply-fmp4-fragment-mutation.py M1_MFHD_CLEAR_EQUAL_SEQ"
run_fmp4_mut M2_MFHD_CLEAR_NULL_LIVE_SEQ "python3 scripts/apply-fmp4-fragment-mutation.py M2_MFHD_CLEAR_NULL_LIVE_SEQ"
run_fmp4_mut M3_PRIME_SEQ_LAST_NOT_MAX "python3 scripts/apply-fmp4-fragment-mutation.py M3_PRIME_SEQ_LAST_NOT_MAX"
run_fmp4_mut M4_MFHD_ONLY_STICKY "python3 scripts/apply-fmp4-fragment-mutation.py M4_MFHD_ONLY_STICKY"
run_fmp4_mut M9_SKIP_ON_NULL_MFHD_TFDT_TRAF "python3 scripts/apply-fmp4-fragment-mutation.py M9_SKIP_ON_NULL_MFHD_TFDT_TRAF"
run_fmp4_mut M10_SKIP_ON_NULL_MFHD_TFDTLESS "python3 scripts/apply-fmp4-fragment-mutation.py M10_SKIP_ON_NULL_MFHD_TFDTLESS"
run_fmp4_mut M11_SKIP_AHEAD_MFHD_ON_TFDT_TRAF "python3 scripts/apply-fmp4-fragment-mutation.py M11_SKIP_AHEAD_MFHD_ON_TFDT_TRAF"
run_fmp4_mut M12_SKIP_EMPTY_TRAFS "python3 scripts/apply-fmp4-fragment-mutation.py M12_SKIP_EMPTY_TRAFS"
run_fmp4_mut M19_G2_TFDT_FLOOR_CLEAR_OFF "python3 scripts/apply-fmp4-fragment-mutation.py M19_G2_TFDT_FLOOR_CLEAR_OFF"
run_fmp4_mut G2a_MFHD_CLEAR_GTE "python3 scripts/apply-fmp4-fragment-mutation.py G2a_MFHD_CLEAR_GTE"
run_fmp4_mut G2b_NULL_LIVE_SEQ_CLEARS_TFDT "python3 scripts/apply-fmp4-fragment-mutation.py G2b_NULL_LIVE_SEQ_CLEARS_TFDT"
run_fmp4_mut G2c_ALWAYS_CLEAR_TFDT "python3 scripts/apply-fmp4-fragment-mutation.py G2c_ALWAYS_CLEAR_TFDT"
run_fmp4_mut G2d_CLEAR_ALL_TRACKS "python3 scripts/apply-fmp4-fragment-mutation.py G2d_CLEAR_ALL_TRACKS"
run_fmp4_mut G2e_NULL_FLOOR_SEQ_CLEARS "python3 scripts/apply-fmp4-fragment-mutation.py G2e_NULL_FLOOR_SEQ_CLEARS"
run_fmp4_mut G2f_TFDT_ON_MFHD_CLEAR_OFF "python3 scripts/apply-fmp4-fragment-mutation.py G2f_TFDT_ON_MFHD_CLEAR_OFF"
run_testing_mut FO2 "python3 scripts/apply-testing-mutation.py FO2"
run_testing_mut ORPHAN_HANG "python3 scripts/apply-testing-mutation.py ORPHAN_HANG"
run_testing_mut BETWEEN_LOST "python3 scripts/apply-testing-mutation.py BETWEEN_LOST"
run_testing_mut ERROR_NO_TERM "python3 scripts/apply-testing-mutation.py ERROR_NO_TERM"
run_testing_mut LATE_HANG "python3 scripts/apply-testing-mutation.py LATE_HANG"
run_mut BD2 "python3 scripts/apply-wiring-mutation.py BD2"
run_mut FPS4 "python3 scripts/apply-wiring-mutation.py FPS4"
run_mut FPS4b "python3 scripts/apply-wiring-mutation.py FPS4b"
run_mut FP2b "python3 scripts/apply-policy-mutation.py FP2b"
run_mut COPY_unknown_fps "python3 scripts/apply-policy-mutation.py COPY_unknown_fps"
run_mut FPS5 "python3 scripts/apply-wiring-mutation.py FPS5"
run_mut FPS6_minterpolate_upscale "python3 scripts/apply-policy-mutation.py FPS6_minterpolate_upscale"
run_mut FP8_caller_fps_on_copy_path "python3 scripts/apply-wiring-mutation.py FP8_caller_fps_on_copy_path"
run_mut FP9_unknown_fps_as_one "python3 scripts/apply-policy-mutation.py FP9_unknown_fps_as_one"
run_mut FP9_plugin_fps_cap "python3 scripts/apply-wiring-mutation.py FP9_plugin_fps_cap"
run_mut FP9_unknown_caller_hwdownload "python3 scripts/apply-wiring-mutation.py FP9_unknown_caller_hwdownload"
run_mut DC4 "python3 scripts/apply-policy-mutation.py DC4"
run_mut DC6 "python3 scripts/apply-policy-mutation.py DC6"
run_h264_mut I2_depth_cap "python3 scripts/apply-h264-mutation.py I2_depth_cap"
run_mut_expected_survivor H6_hdlr_bound "python3 scripts/apply-h264-mutation.py H6_hdlr_bound"
run_h264_mut H6_hdlr_end_trak "python3 scripts/apply-h264-mutation.py H6_hdlr_end_trak"
run_h264_mut I6_trex_track_id "python3 scripts/apply-h264-mutation.py I6_trex_track_id"
run_mut X4 "python3 scripts/apply-wiring-mutation.py X4"
run_mut X5 "python3 scripts/apply-wiring-mutation.py X5"
run_h264_mut P8_parent_bounds "python3 scripts/apply-h264-mutation.py P8_parent_bounds"
run_h264_mut P9_level_gate "python3 scripts/apply-h264-mutation.py P9_level_gate"
run_h264_mut P10_profile66 "python3 scripts/apply-h264-mutation.py P10_profile66"
run_h264_mut P12_num_sps "python3 scripts/apply-h264-mutation.py P12_num_sps"
run_h264_mut P16_nal_type "python3 scripts/apply-h264-mutation.py P16_nal_type"
run_h264_mut P17_pps_length "python3 scripts/apply-h264-mutation.py P17_pps_length"
run_h264_mut S1_profile_match "python3 scripts/apply-h264-mutation.py S1_profile_match"
run_h264_mut S2_level_match "python3 scripts/apply-h264-mutation.py S2_level_match"
run_h264_mut S3_sps_short "python3 scripts/apply-h264-mutation.py S3_sps_short"
run_h264_mut V1_MAP_ANY_TRAK "python3 scripts/apply-h264-mutation.py V1_MAP_ANY_TRAK"
run_h264_mut V1_OFFSET_BUG "python3 scripts/apply-h264-mutation.py V1_OFFSET_BUG"
run_h264_mut V1_LEGACY_HANDLER_SKIPS "python3 scripts/apply-h264-mutation.py V1_LEGACY_HANDLER_SKIPS"
run_h264_mut V1_SKIP_SOUN_OFF "python3 scripts/apply-h264-mutation.py V1_SKIP_SOUN_OFF"
run_h264_mut V2_gate_fail_continues "python3 scripts/apply-h264-mutation.py V2_gate_fail_continues"
run_h264_mut V1_VIDE_ONLY "python3 scripts/apply-h264-mutation.py V1_VIDE_ONLY"
run_h264_mut V1_NULL_FALLTHROUGH "python3 scripts/apply-h264-mutation.py V1_NULL_FALLTHROUGH"
run_h264_mut V2_STSD_SKIP_NEXT_ENTRY "python3 scripts/apply-h264-mutation.py V2_STSD_SKIP_NEXT_ENTRY"
run_h264_mut V2_STSD_IGNORE_ENTRY_COUNT "python3 scripts/apply-h264-mutation.py V2_STSD_IGNORE_ENTRY_COUNT"
run_h264_mut V2_STSD_ALLOW_ENTRY_COUNT_ZERO "python3 scripts/apply-h264-mutation.py V2_STSD_ALLOW_ENTRY_COUNT_ZERO"
run_h264_mut V3_TKHD_V0_OFFSET_ONLY "python3 scripts/apply-h264-mutation.py V3_TKHD_V0_OFFSET_ONLY"
run_fmp4_mut M5_NO_MFHD_ONLY_BOOKKEEP "python3 scripts/apply-fmp4-fragment-mutation.py M5_NO_MFHD_ONLY_BOOKKEEP"
run_fmp4_mut M7_MFHD_CLEAR_WIPE_ALL "python3 scripts/apply-fmp4-fragment-mutation.py M7_MFHD_CLEAR_WIPE_ALL"
run_feed_mut M16_P4_NO_COUNTER_RESET_ON_CLEAR "python3 scripts/apply-feed-mutation.py M16_P4_NO_COUNTER_RESET_ON_CLEAR"

echo "mutation-ledger-exit:$any_issue"
exit "$any_issue"