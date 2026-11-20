#!/usr/bin/env python3
import pathlib
import sys

from mutation_apply import apply_unique

ROOT = pathlib.Path(__file__).resolve().parent.parent
TESTING = ROOT / "src/testing.helpers.ts"

MUTATIONS: dict[str, tuple[str, str]] = {
    "FO2": (
        """    for(const iterator of iterators) {

      if(!iterator.terminated) {

        iterator.queue.push(item);
      }
    }""",
        """    let newest: IteratorFanout | undefined;
    for(const iterator of iterators) {
      newest = iterator;
    }
    if(newest && !newest.terminated) {
      newest.queue.push(item);
    }""",
    ),
    "ORPHAN_HANG": (
        """      if(orphanQueue.length > 0) {

        fanout.queue.push(...orphanQueue);
        orphanQueue.length = 0;
      }

""",
        "",
    ),
    "BETWEEN_LOST": (
        """    for(const iterator of iterators) {

      if(!iterator.terminated) {

        iterator.queue.push(item);
      }
    }""",
        """    let newest: IteratorFanout | undefined;
    for(const iterator of iterators) {
      newest = iterator;
    }
    if(newest && !newest.terminated) {
      newest.queue.push(item);
    }""",
    ),
    "ERROR_NO_TERM": (
        '    if((item.kind === "end") || (item.kind === "error")) {',
        '    if(item.kind === "end") {',
    ),
    "LATE_HANG": (
        """      if((terminated) && (fanout.queue.length === 0)) {

        iterators.delete(fanout);

        return;
      }

""",
        "",
    ),
}


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <{'|'.join(MUTATIONS)}>")
    mut_id = sys.argv[1]
    if mut_id not in MUTATIONS:
        raise SystemExit(f"unknown mutation {mut_id}")
    old, new = MUTATIONS[mut_id]
    text = TESTING.read_text()
    TESTING.write_text(apply_unique(text, old, new, mut_id))


if __name__ == "__main__":
    main()