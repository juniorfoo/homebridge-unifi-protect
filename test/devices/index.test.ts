import { describe, expect, it } from "vitest";
import * as devices from "../../src/devices/index.js";
import { ProtectCamera } from "../../src/devices/protect-camera.js";
import { ProtectCameraPackage } from "../../src/devices/protect-camera-package.js";
import { ProtectChime } from "../../src/devices/protect-chime.js";
import { ProtectBase, ProtectDevice } from "../../src/devices/protect-device.js";
import { ProtectDoorbell } from "../../src/devices/protect-doorbell.js";
import { ProtectLight } from "../../src/devices/protect-light.js";
import { ProtectLiveviews } from "../../src/devices/protect-liveviews.js";
import { ProtectNvrSystemInfo } from "../../src/devices/protect-nvr-systeminfo.js";
import { ProtectSecuritySystem } from "../../src/devices/protect-securitysystem.js";
import { ProtectSensor } from "../../src/devices/protect-sensor.js";
import { ProtectViewer } from "../../src/devices/protect-viewer.js";

describe("devices index exports", () => {

  it("re-exports all device classes", () => {

    expect(devices.ProtectBase).toBe(ProtectBase);
    expect(devices.ProtectDevice).toBe(ProtectDevice);
    expect(devices.ProtectCamera).toBe(ProtectCamera);
    expect(devices.ProtectCameraPackage).toBe(ProtectCameraPackage);
    expect(devices.ProtectChime).toBe(ProtectChime);
    expect(devices.ProtectDoorbell).toBe(ProtectDoorbell);
    expect(devices.ProtectLight).toBe(ProtectLight);
    expect(devices.ProtectLiveviews).toBe(ProtectLiveviews);
    expect(devices.ProtectNvrSystemInfo).toBe(ProtectNvrSystemInfo);
    expect(devices.ProtectSecuritySystem).toBe(ProtectSecuritySystem);
    expect(devices.ProtectSensor).toBe(ProtectSensor);
    expect(devices.ProtectViewer).toBe(ProtectViewer);
  });
});
