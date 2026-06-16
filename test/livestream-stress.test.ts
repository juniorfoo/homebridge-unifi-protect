import { describe, expect, it } from "vitest";
import { countRecentRestarts, formatLivestreamStressAdvisory, isLivestreamUnderStress, shouldAutoPreferRtspLiveView,
  shouldSkipSelfHealingCameraReboot } from "../src/livestream-stress.js";

describe("livestream-stress", () => {

  it("counts recent restarts inside the stress window", () => {

    const now = Date.now();
    const events = [ { timestamp: now - 1000 }, { timestamp: now - 2000 }, { timestamp: now - (11 * 60 * 1000) } ];

    expect(countRecentRestarts(events, now)).toBe(2);
    expect(isLivestreamUnderStress(3)).toBe(true);
    expect(shouldAutoPreferRtspLiveView(3)).toBe(true);
  });

  it("skips self-healing camera reboot on constrained hosts", () => {

    expect(shouldSkipSelfHealingCameraReboot({

      hostProfile: "software-constrained",
      recentRestartCount: 99,
      selfHealingEnabled: true
    })).toBe(true);
  });

  it("returns skip decisions for disabled and stressed hosts", () => {

    expect(shouldSkipSelfHealingCameraReboot({

      hostProfile: "default",
      recentRestartCount: 1,
      selfHealingEnabled: false
    })).toBe(true);

    expect(shouldSkipSelfHealingCameraReboot({

      hostProfile: "default",
      recentRestartCount: 10,
      selfHealingEnabled: true,
      stressThreshold: 3
    })).toBe(true);

    expect(shouldSkipSelfHealingCameraReboot({

      hostProfile: "default",
      recentRestartCount: 1,
      selfHealingEnabled: true,
      stressThreshold: 3
    })).toBe(false);
  });

  it("formats stress advisory text", () => {

    expect(formatLivestreamStressAdvisory("Porch")).toContain("Porch");
  });
});
