import { APIEvent } from "homebridge";
import type { VideoProcessorValidation } from "../src/video-processor.js";
import { ProtectPlatform } from "../src/protect-platform.js";
import { PROTECT_MQTT_TOPIC } from "../src/settings.js";
import { createMockAccessory, createMockHap } from "./helpers/mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const { ProtectNvrMock, validateVideoProcessorPathMock } = vi.hoisted(() => ({
  ProtectNvrMock: vi.fn(() => ({
    login: vi.fn()
  })),
  validateVideoProcessorPathMock: vi.fn((): VideoProcessorValidation => ({
    resolvedPath: "/usr/bin/ffmpeg",
    valid: true
  }))
}));

vi.mock("../src/protect-nvr.js", () => ({
  ProtectNvr: ProtectNvrMock
}));

vi.mock("../src/video-processor.js", () => ({
  validateVideoProcessorPath: validateVideoProcessorPathMock
}));

function createApi() {

  const emitter = new EventEmitter() as EventEmitter & {
    hap: ReturnType<typeof createMockHap>;
  };

  emitter.hap = createMockHap();

  return emitter;
}

function createLog() {

  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn()
  };
}

describe("ProtectPlatform", () => {

  beforeEach(() => {

    ProtectNvrMock.mockClear();
    validateVideoProcessorPathMock.mockClear();
    validateVideoProcessorPathMock.mockReturnValue({
      resolvedPath: "/usr/bin/ffmpeg",
      valid: true
    });
    ProtectNvrMock.mockImplementation(() => ({
      login: vi.fn()
    }));
  });

  it("logs and exits when no controllers are configured", () => {

    const api = createApi();
    const log = createLog();

    new ProtectPlatform(log as never, {} as never, api as never);

    expect(log.info).toHaveBeenCalledWith("No UniFi Protect controllers have been configured.");
    expect(ProtectNvrMock).not.toHaveBeenCalled();
  });

  it("logs an error when configured video processor path validation fails", () => {

    validateVideoProcessorPathMock.mockReturnValueOnce({
      error: "invalid ffmpeg path",
      resolvedPath: "/tmp/bad-ffmpeg",
      valid: false
    });

    const api = createApi();
    const log = createLog();
    const config = {
      controllers: [],
      videoProcessor: "/tmp/bad-ffmpeg"
    };

    new ProtectPlatform(log as never, config as never, api as never);

    expect(log.error).toHaveBeenCalledWith("invalid ffmpeg path");
  });

  it("uses fallback validation error when validator omits details", () => {

    validateVideoProcessorPathMock.mockReturnValueOnce({
      resolvedPath: "/tmp/fallback-ffmpeg",
      valid: false
    });

    const api = createApi();
    const log = createLog();
    const config = {
      controllers: [],
      videoProcessor: "/tmp/custom-ffmpeg"
    };

    new ProtectPlatform(log as never, config as never, api as never);

    expect(log.error).toHaveBeenCalledWith(
      "Configured FFmpeg path failed validation. Falling back to the resolved path: /tmp/fallback-ffmpeg"
    );
  });

  it("routes debug output when debugAll is enabled", () => {

    const api = createApi();
    const log = createLog();
    const config = {
      controllers: [ { address: "nvr.local", password: "pass", username: "user" } ],
      debug: true
    };
    const platform = new ProtectPlatform(log as never, config as never, api as never);

    platform.debug("Debug path %s", "active");
    expect(log.warn).toHaveBeenCalledWith("Debug path active");
  });

  it("enables verbose FFmpeg logging when configured", () => {

    const api = createApi();
    const log = createLog();
    const config = {
      controllers: [ { address: "nvr.local", password: "pass", username: "user" } ],
      verboseFfmpeg: true
    };
    const platform = new ProtectPlatform(log as never, config as never, api as never);

    expect(platform.verboseFfmpeg).toBe(true);
    expect(log.info).toHaveBeenCalledWith("Verbose logging of video streaming sessions enabled. Expect a lot of data.");
  });

  it("skips controllers with missing address or credentials", () => {

    const api = createApi();
    const log = createLog();
    const config = {
      controllers: [
        { password: "pass", username: "user" },
        { address: "no-creds.local", password: "", username: "" },
        { address: "valid.local", password: "goodpass", username: "gooduser" }
      ]
    };

    new ProtectPlatform(log as never, config as never, api as never);

    expect(ProtectNvrMock).toHaveBeenCalledTimes(1);
    expect((ProtectNvrMock.mock.calls[0] as unknown[])[1]).toMatchObject({
      address: "valid.local",
      mqttTopic: PROTECT_MQTT_TOPIC
    });
    expect(log.info).toHaveBeenCalledWith("No host or IP address has been configured.");
    expect(log.info).toHaveBeenCalledWith("No UniFi Protect login credentials have been configured.");
  });

  it("stores cached accessories via configureAccessory", () => {

    const api = createApi();
    const log = createLog();
    const config = {
      controllers: [ { address: "nvr.local", password: "pass", username: "user" } ]
    };
    const platform = new ProtectPlatform(log as never, config as never, api as never);
    const accessory = createMockAccessory();

    platform.configureAccessory(accessory as never);

    expect(platform.accessories).toContain(accessory);
  });

  it("does not launch controllers when ffmpeg probe fails", async () => {

    const api = createApi();
    const log = createLog();
    const config = {
      controllers: [ { address: "nvr.local", password: "pass", username: "user" } ]
    };

    const platform = new ProtectPlatform(log as never, config as never, api as never);
    vi.spyOn(platform.codecSupport, "probe").mockResolvedValue(false);
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await Promise.resolve();

    const controller = ProtectNvrMock.mock.results.at(-1)?.value;

    expect(controller?.login).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("This plugin requires a working version of FFmpeg."));
  });

  it("launches controllers when ffmpeg probe succeeds", async () => {

    ProtectNvrMock.mockImplementation(() => ({
      login: vi.fn()
    }));

    const api = createApi();
    const log = createLog();
    const config = {
      controllers: [ { address: "nvr.local", password: "pass", username: "user" } ]
    };

    const platform = new ProtectPlatform(log as never, config as never, api as never);
    vi.spyOn(platform.codecSupport, "probe").mockResolvedValue(true);
    api.emit(APIEvent.DID_FINISH_LAUNCHING);
    await Promise.resolve();

    const controller = ProtectNvrMock.mock.results.at(-1)?.value;

    expect(controller?.login).toHaveBeenCalledTimes(1);
  });
});
