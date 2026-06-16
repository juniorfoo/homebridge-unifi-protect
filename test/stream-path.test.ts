import { describe, expect, it } from "vitest";
import { formatStreamPathLabel, isLanClient, resolveLiveViewRtspEntry, shouldPreferRtspLiveView, shouldUseTsbApi } from "../src/stream-path.js";

describe("stream-path", () => {

  const base = {

    hksvRecording: true,
    isPackageCamera: false,
    packetTime: 20,
    preferRtspLiveView: false,
    useApiFeature: true,
    videoCodec: "h264"
  };

  it("detects LAN clients", () => {

    expect(isLanClient(20)).toBe(true);
    expect(isLanClient(60)).toBe(false);
  });

  it("prefers RTSP on LAN with HKSV and UseApi enabled", () => {

    expect(shouldUseTsbApi(base)).toBe(false);
  });

  it("prefers RTSP based on explicit override and constrained profile", () => {

    expect(shouldPreferRtspLiveView({ hostProfile: "default", packetTime: 80, preferRtspLiveView: true })).toBe(true);
    expect(shouldPreferRtspLiveView({ hostProfile: "pi", packetTime: 80, preferRtspLiveView: false })).toBe(true);
    expect(shouldPreferRtspLiveView({ hostProfile: "default", packetTime: 80, preferRtspLiveView: false })).toBe(false);
  });

  it("requires TSB/API for package cameras", () => {

    expect(shouldUseTsbApi({ ...base, isPackageCamera: true })).toBe(true);
  });

  it("requires TSB/API for AV1", () => {

    expect(shouldUseTsbApi({ ...base, packetTime: 60, videoCodec: "av1" })).toBe(true);
  });

  it("uses TSB/API remotely when UseApi is enabled", () => {

    expect(shouldUseTsbApi({ ...base, hostProfile: "default", packetTime: 60 })).toBe(true);
  });

  it("honors preferRtspLiveView stress override", () => {

    expect(shouldUseTsbApi({ ...base, packetTime: 60, preferRtspLiveView: true })).toBe(false);
  });

  it("runs AB-test branch for API flipping", () => {

    expect(shouldUseTsbApi({ ...base, abTestFlip: true, debugAbTestEnabled: true })).toBe(false);
    expect(shouldUseTsbApi({ ...base, abTestFlip: true, debugAbTestEnabled: true, hksvRecording: false })).toBe(true);
  });

  it("decouples live view rtsp entry from HKSV buffer entry", () => {

    const live = { name: "Medium" } as never;
    const hksv = { name: "Low" } as never;

    expect(resolveLiveViewRtspEntry({

      findLiveRtsp: () => live,
      hksvRtspEntry: hksv,
      useTsb: true
    })?.name).toBe("Medium");
  });

  it("returns null when no RTSP profile exists", () => {

    expect(resolveLiveViewRtspEntry({ findLiveRtsp: () => null, hksvRtspEntry: null, useTsb: false })).toBeNull();
    expect(resolveLiveViewRtspEntry({ findLiveRtsp: () => null, hksvRtspEntry: { name: "fallback" } as never, useTsb: true })?.name).toBe("fallback");
  });

  it("formats stream path labels", () => {

    expect(formatStreamPathLabel(false, false)).toBe("RTSP");
    expect(formatStreamPathLabel(true, false)).toBe("TSB/API");
    expect(formatStreamPathLabel(true, true)).toBe("TSB/RTSP");
  });
});
