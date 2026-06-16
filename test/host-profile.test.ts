import { describe, expect, it } from "vitest";
import { detectHostProfile, formatHostProfileLog, getHostProfileDefaults, resolveHksvRecordingDefault } from "../src/host-profile.js";
import * as hostProfileModule from "../src/host-profile.js";

describe("host-profile", () => {

  it("detects all host profiles", () => {

    expect(detectHostProfile({ hardwareTranscoding: false, hostSystem: "linux", cpuCores: 4 })).toBe("software-constrained");
    expect(detectHostProfile({ hardwareTranscoding: false, hostSystem: "raspbian" })).toBe("pi");
    expect(detectHostProfile({ hardwareTranscoding: true, hasQsv: true, hostSystem: "linux", cpuCores: 8 })).toBe("intel-qsv");
    expect(detectHostProfile({ hardwareTranscoding: true, hostSystem: "macOS.Apple", cpuCores: 8 })).toBe("apple-silicon-hw");
    expect(detectHostProfile({ hardwareTranscoding: false, hostSystem: "macOS.Intel", cpuCores: 2 })).toBe("default");
    expect(detectHostProfile({ hardwareTranscoding: true, hostSystem: "linux" })).toBe("default");
  });

  it("returns defaults for all profile branches", () => {

    expect(resolveHksvRecordingDefault("software-constrained", false)).toBe("Medium");
    expect(getHostProfileDefaults("software-constrained", false).preferRtspLiveView).toBe(true);
    expect(getHostProfileDefaults("apple-silicon-hw", true).recordingDefault).toBe("High");
    expect(getHostProfileDefaults("apple-silicon-hw", false).recordingDefault).toBe("Medium");
    expect(getHostProfileDefaults("intel-qsv", true).recordingDefault).toBe("Medium");
    expect(getHostProfileDefaults("pi", false).preferRtspLiveView).toBe(true);
    expect(getHostProfileDefaults("default", false).transcodeByDefault).toBe(true);
  });

  it("resolves HKSV recording defaults and fallback profile names", () => {

    expect(resolveHksvRecordingDefault("default", true)).toBe("High");
    expect(resolveHksvRecordingDefault("default", false)).toBe("");
    expect(resolveHksvRecordingDefault("pi", false, "Low")).toBe("Medium");
  });

  it("keeps constrained profiles pinned to Medium even with max1080 fallback", () => {

    expect(resolveHksvRecordingDefault("software-constrained", false, "Low")).toBe("Medium");
    expect(hostProfileModule.getHostProfileDefaults("software-constrained", false).recordingDefault).toBe("Medium");
  });

  it("formats startup log lines for every profile branch", () => {

    expect(formatHostProfileLog("software-constrained", false, false)).toContain("software-constrained");
    expect(formatHostProfileLog("software-constrained", false, true)).toContain("software-constrained");
    expect(formatHostProfileLog("pi", false, false)).toContain("pi");
    expect(formatHostProfileLog("intel-qsv", true, true)).toContain("intel-qsv");
    expect(formatHostProfileLog("apple-silicon-hw", true, false)).toContain("apple-silicon-hw");
    expect(formatHostProfileLog("default", false, false)).toContain("disabled");
    expect(formatHostProfileLog("default", true, false)).toContain("enabled");
  });
});
