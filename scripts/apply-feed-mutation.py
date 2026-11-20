#!/usr/bin/env python3
import pathlib
import sys

from mutation_apply import apply_unique

ROOT = pathlib.Path(__file__).resolve().parent.parent
FEED = ROOT / "src/media/stream-live-feed.ts"

MUTATIONS = {
    "I2_keyframe_prime": (
        "  const header = keyframePrimingBuffer ?? subscription.initSegment?.data;",
        "  const header = subscription.initSegment?.data;",
    ),
    "PRIME_DEDUP_OFF": (
        """      if(feedState.primeMediaFloor && shouldSkipLiveSegmentAfterCopyPrime(feedState.primeMediaFloor, segment.data,
        { atOrBefore: true }, log)) {

        log.debug("Skipping live fMP4 fragment already covered by copy-escalation prime (pooled reader lag).");

        continue;
      }

""",
        "",
    ),
    "PRIME_FLOOR_NEVER_CLEAR": (
        """      if(feedState.primeMediaFloor && applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(feedState.primeMediaFloor, segment.data, log) &&
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

      // Write the media fragment. The homebridge-plugin-utils write() returns a typed-rejecting Promise; the .catch (debug) swallows BackpressureClosedStreamError /""",
        "      // Write the media fragment. The homebridge-plugin-utils write() returns a typed-rejecting Promise; the .catch (debug) swallows BackpressureClosedStreamError /",
    ),
    "PRIME_FLOOR_CLEAR_ANY": (
        """      if(feedState.primeMediaFloor && applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(feedState.primeMediaFloor, segment.data, log) &&
        isPrimeMediaFloorEmpty(feedState.primeMediaFloor)) {

        feedState.primeMediaFloor = null;
        feedState.primeMediaFloorWrittenLiveMoofs = undefined;
      }""",
        "      feedState.primeMediaFloor = null;",
    ),
    "PRIME_CLEAR_ALL_ON_ONE_TRACK": (
        """      if(feedState.primeMediaFloor && applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(feedState.primeMediaFloor, segment.data, log) &&
        isPrimeMediaFloorEmpty(feedState.primeMediaFloor)) {

        feedState.primeMediaFloor = null;
        feedState.primeMediaFloorWrittenLiveMoofs = undefined;
      }""",
        """      if(feedState.primeMediaFloor && applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(feedState.primeMediaFloor, segment.data, log)) {

        feedState.primeMediaFloor = null;
      }""",
    ),
    "PRIME_DEDUP_STRICT": (
        "{ atOrBefore: true }, log)) {",
        "{ atOrBefore: false }, log)) {",
    ),
    "D1w": (
        """      segmentWriter = rotateBackpressureWriterForCopyEscalation({

        getStdin: () => replacement.stdin,
        poisoned: poisoned,
        signal: input.signal,
        writerInit: input.writerInit
      });""",
        "      segmentWriter = poisoned;",
    ),
    "D1": (
        """      segmentWriter = rotateBackpressureWriterForCopyEscalation({

        getStdin: () => replacement.stdin,
        poisoned: poisoned,
        signal: input.signal,
        writerInit: input.writerInit
      });""",
        "      return poisoned;",
    ),
    "P4_FLOOR_NEVER_EXPIRE": (
        """      if(feedState.primeMediaFloor) {

        feedState.primeMediaFloorWrittenLiveMoofs = (feedState.primeMediaFloorWrittenLiveMoofs ?? 0) + 1;

        if(feedState.primeMediaFloorWrittenLiveMoofs > COPY_ESCALATION_PRIME_FLOOR_MAX_WRITTEN_LIVE_MOOF_CHECKS) {

          feedState.primeMediaFloor = null;
          feedState.primeMediaFloorWrittenLiveMoofs = undefined;
        }
      }

""",
        "",
    ),
    "M13_P4_EXPIRE_GTE": (
        """        if(feedState.primeMediaFloorWrittenLiveMoofs > COPY_ESCALATION_PRIME_FLOOR_MAX_WRITTEN_LIVE_MOOF_CHECKS) {
""",
        """        if(feedState.primeMediaFloorWrittenLiveMoofs >= COPY_ESCALATION_PRIME_FLOOR_MAX_WRITTEN_LIVE_MOOF_CHECKS) {
""",
    ),
    "M14_P4_CAP_TOO_LOW": (
        """        if(feedState.primeMediaFloorWrittenLiveMoofs > COPY_ESCALATION_PRIME_FLOOR_MAX_WRITTEN_LIVE_MOOF_CHECKS) {
""",
        """        if(feedState.primeMediaFloorWrittenLiveMoofs > 8) {
""",
    ),
    "M14b_P4_CAP_50": (
        """        if(feedState.primeMediaFloorWrittenLiveMoofs > COPY_ESCALATION_PRIME_FLOOR_MAX_WRITTEN_LIVE_MOOF_CHECKS) {
""",
        """        if(feedState.primeMediaFloorWrittenLiveMoofs > 50) {
""",
    ),
    "M14c_P4_CAP_30": (
        """        if(feedState.primeMediaFloorWrittenLiveMoofs > COPY_ESCALATION_PRIME_FLOOR_MAX_WRITTEN_LIVE_MOOF_CHECKS) {
""",
        """        if(feedState.primeMediaFloorWrittenLiveMoofs > 30) {
""",
    ),
    "M15_P4_COUNTER_ON_SKIP": (
        """      if(feedState.primeMediaFloor && shouldSkipLiveSegmentAfterCopyPrime(feedState.primeMediaFloor, segment.data,
        { atOrBefore: true }, log)) {

        log.debug("Skipping live fMP4 fragment already covered by copy-escalation prime (pooled reader lag).");

        continue;
      }

""",
        """      if(feedState.primeMediaFloor) {

        feedState.primeMediaFloorWrittenLiveMoofs = (feedState.primeMediaFloorWrittenLiveMoofs ?? 0) + 1;
      }

      if(feedState.primeMediaFloor && shouldSkipLiveSegmentAfterCopyPrime(feedState.primeMediaFloor, segment.data,
        { atOrBefore: true }, log)) {

        log.debug("Skipping live fMP4 fragment already covered by copy-escalation prime (pooled reader lag).");

        continue;
      }

""",
    ),
    "M16_P4_NO_COUNTER_RESET_ON_CLEAR": (
        """      if(feedState.primeMediaFloor && applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(feedState.primeMediaFloor, segment.data, log) &&
        isPrimeMediaFloorEmpty(feedState.primeMediaFloor)) {

        feedState.primeMediaFloor = null;
        feedState.primeMediaFloorWrittenLiveMoofs = undefined;
      }
""",
        """      if(feedState.primeMediaFloor && applyPrimeMediaFloorClearAfterComparableAheadLiveWrite(feedState.primeMediaFloor, segment.data, log) &&
        isPrimeMediaFloorEmpty(feedState.primeMediaFloor)) {

        feedState.primeMediaFloor = null;
      }
""",
    ),
}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <{'|'.join(MUTATIONS)}>")
    mut_id = sys.argv[1]
    if mut_id not in MUTATIONS:
        raise SystemExit(f"unknown mutation {mut_id}")
    old, new = MUTATIONS[mut_id]
    text = FEED.read_text()
    FEED.write_text(apply_unique(text, old, new, mut_id))


if __name__ == "__main__":
    main()