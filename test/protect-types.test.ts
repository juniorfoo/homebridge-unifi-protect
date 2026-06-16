import { ProtectDeviceCategories, ProtectReservedNames, exhaustiveGuard } from "../src/protect-types.js";
import { describe, expect, it } from "vitest";

describe("protect-types", () => {

  it("exports expected reserved name enum values", () => {

    expect(ProtectReservedNames.CONTACT_AUTHSENSOR).toBe("ContactAuthSensor");
    expect(ProtectReservedNames.CONTACT_MOTION_SMARTDETECT).toBe("ContactMotionSmartDetect");
    expect(ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE).toBe("ContactMotionSmartDetectLicense");
    expect(ProtectReservedNames.CONTACT_SENSOR).toBe("ContactSensor");
    expect(ProtectReservedNames.CONTACT_SENSOR_ALARM_SOUND).toBe("ContactAlarmSound");
    expect(ProtectReservedNames.LEAKSENSOR_EXTERNAL).toBe("External");
    expect(ProtectReservedNames.LEAKSENSOR_INTERNAL).toBe("Internal");
    expect(ProtectReservedNames.LIGHTBULB_DOORBELL_VOLUME).toBe("ChimeVolume");
    expect(ProtectReservedNames.LIGHTBULB_NIGHTVISION).toBe("NightVision");
    expect(ProtectReservedNames.LIGHTBULB_PACKAGE_FLASHLIGHT).toBe("PackageCamera.Flashlight");
    expect(ProtectReservedNames.LOCK_ACCESS).toBe("Access");
    expect(ProtectReservedNames.SWITCH_DOORBELL_CHIME_BUZZER).toBe("DoorbellChime.buzzer");
    expect(ProtectReservedNames.SWITCH_DOORBELL_CHIME_DIGITAL).toBe("DoorbellChime.digital");
    expect(ProtectReservedNames.SWITCH_DOORBELL_CHIME_MECHANICAL).toBe("DoorbellChime.mechanical");
    expect(ProtectReservedNames.SWITCH_DOORBELL_CHIME_NONE).toBe("DoorbellChime.none");
    expect(ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER).toBe("DoorbellChime.speaker");
    expect(ProtectReservedNames.SWITCH_DOORBELL_MUTE).toBe("DoorbellMute");
    expect(ProtectReservedNames.SWITCH_DOORBELL_TRIGGER).toBe("DoorbellTrigger");
    expect(ProtectReservedNames.SWITCH_HKSV_RECORDING).toBe("HKSVRecordingSwitch");
    expect(ProtectReservedNames.SWITCH_MOTION_SENSOR).toBe("MotionSensorSwitch");
    expect(ProtectReservedNames.SWITCH_MOTION_TRIGGER).toBe("MotionSensorTrigger");
    expect(ProtectReservedNames.SWITCH_STATUS_LED).toBe("StatusLedSwitch");
    expect(ProtectReservedNames.SWITCH_UFP_RECORDING_ALWAYS).toBe("UFPRecordingSwitch.always");
    expect(ProtectReservedNames.SWITCH_UFP_RECORDING_DETECTIONS).toBe("UFPRecordingSwitch.detections");
    expect(ProtectReservedNames.SWITCH_UFP_RECORDING_NEVER).toBe("UFPRecordingSwitch.never");
  });

  it("includes all supported protect device categories", () => {

    expect(ProtectDeviceCategories).toEqual([ "camera", "chime", "light", "sensor", "viewer" ]);
  });

  it("exhaustiveGuard is a runtime no-op", () => {

    expect(() => exhaustiveGuard("unexpected" as never)).not.toThrow();
    expect(exhaustiveGuard(undefined as never)).toBeUndefined();
  });
});
