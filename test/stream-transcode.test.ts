import { describe, expect, it } from "vitest";
import { formatTranscodeLog, resolveOutputFps, shouldTranscodeVideo } from "../src/stream-transcode.js";

describe("stream-transcode", () => {

  it("uses all transcode reason branches", () => {

    expect(shouldTranscodeVideo({

      crop: true,
      packetTime: 20,
      transcodeFeature: false,
      transcodeHighLatency: false,
      videoCodec: "h264"
    })).toEqual({ reason: "crop", transcode: true });

    expect(shouldTranscodeVideo({

      crop: false,
      packetTime: 20,
      transcodeFeature: false,
      transcodeHighLatency: false,
      videoCodec: "h265"
    })).toEqual({ reason: "codec", transcode: true });

    expect(shouldTranscodeVideo({

      crop: false,
      packetTime: 60,
      transcodeFeature: false,
      transcodeHighLatency: true,
      videoCodec: "h264"
    })).toEqual({ reason: "high-latency", transcode: true });
  });

  it("uses copy path on constrained hosts even when transcode feature is enabled", () => {

    const decision = shouldTranscodeVideo({

      crop: false,
      hostProfile: "software-constrained",
      packetTime: 20,
      transcodeFeature: true,
      transcodeHighLatency: true,
      videoCodec: "h264"
    });

    expect(decision).toEqual({ reason: "copy", transcode: false });
  });

  it("uses user transcode option on default profile", () => {

    expect(shouldTranscodeVideo({

      crop: false,
      hostProfile: "default",
      packetTime: 20,
      transcodeFeature: true,
      transcodeHighLatency: false,
      videoCodec: "h264"
    })).toEqual({ reason: "user", transcode: true });
  });

  it("matches source fps when below HomeKit request", () => {

    expect(resolveOutputFps(15, 30, false)).toBe(15);
    expect(resolveOutputFps(30, 30, false)).toBe(30);
  });

  it("uses source fps when interpolation is enabled", () => {

    expect(resolveOutputFps(20, 30, true)).toBe(20);
  });

  it("logs copy vs transcode decisions", () => {

    expect(formatTranscodeLog({ reason: "copy", transcode: false })).toBe("Using copy path");
    expect(formatTranscodeLog({ reason: "user", transcode: true })).toContain("Transcoding");
  });
});
