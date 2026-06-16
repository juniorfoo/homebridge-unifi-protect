import * as settings from "../src/settings.js";
import { describe, expect, it } from "vitest";

describe("settings constants", () => {

  it("exports expected plugin identity values", () => {

    expect(settings.PLUGIN_NAME).toBe("homebridge-unifi-protect");
    expect(settings.PLATFORM_NAME).toBe("UniFi Protect");
  });

  it("exports positive numeric timing and interval defaults", () => {

    const positiveConstants = [
      settings.PROTECT_CONTROLLER_REFRESH_INTERVAL,
      settings.PROTECT_CONTROLLER_RETRY_INTERVAL,
      settings.PROTECT_DEVICE_REMOVAL_DELAY_INTERVAL,
      settings.PROTECT_DOORBELL_AUTHSENSOR_DURATION,
      settings.PROTECT_DOORBELL_CHIME_DURATION_DIGITAL,
      settings.PROTECT_DOORBELL_CHIME_SPEAKER_DURATION,
      settings.PROTECT_DOORBELL_TRIGGER_DURATION,
      settings.PROTECT_FFMPEG_AUDIO_FILTER_FFTNR,
      settings.PROTECT_FFMPEG_AUDIO_FILTER_HIGHPASS,
      settings.PROTECT_FFMPEG_AUDIO_FILTER_LOWPASS,
      settings.PROTECT_LIVESTREAM_API_IDR_INTERVAL,
      settings.PROTECT_SEGMENT_RESOLUTION,
      settings.PROTECT_HKSV_TIMEOUT,
      settings.PROTECT_M3U_PLAYLIST_PORT,
      settings.PROTECT_MOTION_DURATION,
      settings.PROTECT_OCCUPANCY_DURATION,
      settings.PROTECT_RPI_GPU_MINIMUM,
      settings.PROTECT_SNAPSHOT_CACHE_MAXAGE,
      settings.PROTECT_TRANSCODE_BITRATE,
      settings.PROTECT_TRANSCODE_HIGH_LATENCY_BITRATE,
      settings.PROTECT_NVR_REBOOT_INTERVAL,
      settings.PROTECT_NVR_REBOOT_MIN_INTERVAL,
      settings.PROTECT_NVR_REBOOT_RECONNECT_DELAY
    ];

    for(const value of positiveConstants) {

      expect(typeof value).toBe("number");
      expect(value).toBeGreaterThan(0);
    }
  });

  it("keeps derived constants in sync with documented formulas", () => {

    expect(settings.PROTECT_HKSV_TIMESHIFT_BUFFER_MAXDURATION).toBe(settings.PROTECT_LIVESTREAM_API_IDR_INTERVAL * 1000 * 2);
    expect(settings.PROTECT_MQTT_TOPIC).toBe("unifi/protect");
  });
});
