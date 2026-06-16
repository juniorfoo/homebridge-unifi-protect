import { describe, expect, it } from "vitest";
import { decideReconfigure, hasMaterialStreamChange } from "../src/stream-reconfigure.js";

describe("stream-reconfigure", () => {

  it("returns initial decision for first configure", () => {

    expect(decideReconfigure(undefined, { fps: 30, height: 720, maxBitRate: 300, width: 1280 })).toEqual({ reason: "initial", restart: false });
  });

  it("restarts only on material changes and bitrate threshold", () => {

    expect(decideReconfigure({ fps: 30, height: 720, maxBitRate: 300, width: 1280 }, {

      fps: 30,
      height: 720,
      maxBitRate: 300,
      width: 1280
    }).restart).toBe(false);

    expect(hasMaterialStreamChange(

      { fps: 30, height: 720, maxBitRate: 300, width: 1280 },
      { fps: 15, height: 720, maxBitRate: 300, width: 1280 }
    )).toBe(true);

    expect(hasMaterialStreamChange(

      { fps: 30, height: 720, maxBitRate: 300, width: 1280 },
      { fps: 30, height: 720, maxBitRate: 399, width: 1280 }
    )).toBe(false);

    expect(hasMaterialStreamChange(

      { fps: 30, height: 720, maxBitRate: 300, width: 1280 },
      { fps: 30, height: 720, maxBitRate: 400, width: 1280 }
    )).toBe(true);
  });
});
