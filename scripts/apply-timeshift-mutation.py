#!/usr/bin/env python3
import pathlib
import sys

from mutation_apply import apply_unique

ROOT = pathlib.Path(__file__).resolve().parent.parent
TS = ROOT / "src/media/timeshift.ts"

MUTATIONS = {
    "KP3": (
        "...this._segments.slice(i).map((entry) => entry.data) ])",
        "...this._segments.slice(-1).map((entry) => entry.data) ])",
    ),
    "KP4": (
        "...this._segments.slice(i).map((entry) => entry.data) ])",
        "...this._segments.slice(i).map((entry) => entry.data), this._segments.at(-1)!.data ])",
    ),
    "SID1": (
        """  public get channelProfile(): Nullable<ChannelProfile> {

    return this._channelProfile;
  }

  // Return whether the underlying livestream connection is currently restarting itself.
  public get isRestarting(): boolean {
""",
        """  public get channelProfile(): Nullable<ChannelProfile> {

    return this._channelProfile;
  }

  // The active pooled livestream subscription when the buffer is running (for shared-feed identity checks at copy escalation).
  public get livestreamSubscription(): LivestreamSubscription | undefined {

    return this.subscription;
  }

  // Return whether the underlying livestream connection is currently restarting itself.
  public get isRestarting(): boolean {
""",
    ),
    "KP5": (
        """    for(let i = this._segments.length - 1; i >= 0; i--) {

      const seg = this._segments[i];

      if(seg?.isKeyframe) {

        return Buffer.concat([ this.subscription.initSegment.data, ...this._segments.slice(i).map((entry) => entry.data) ]);
      }
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
    text = TS.read_text()
    TS.write_text(apply_unique(text, old, new, mut_id))


if __name__ == "__main__":
    main()