import { describe, expect, it } from "vitest";
import { CopyPathFanoutRegistry } from "../src/protect-stream-fanout.js";

describe("protect-stream-fanout", () => {

  it("tracks refcounts and removes sessions when the last viewer leaves", () => {

    const registry = new CopyPathFanoutRegistry();

    registry.acquire("camera:0");
    registry.acquire("camera:0");
    expect(registry.release("camera:0")).toBe(false);
    expect(registry.release("camera:0")).toBe(true);
    expect(registry.size()).toBe(0);
  });

  it("returns false when releasing unknown key", () => {

    expect(new CopyPathFanoutRegistry().release("missing")).toBe(false);
  });
});
