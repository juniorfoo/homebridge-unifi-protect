import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pluginUtils from "homebridge-plugin-utils";
import { ProtectSecuritySystem } from "../../src/devices/protect-securitysystem.js";
import { ProtectReservedNames } from "../../src/protect-types.js";
import { createMockAccessory, createMockNvr, createMockService, nvrBootstrap, setNvrBootstrap, type MockService } from "../helpers/mocks.js";

function installChainableAcquireService(): void {

  vi.mocked(pluginUtils.acquireService).mockImplementation((accessory, serviceType, name) => {

    const existing = accessory.getService(serviceType);
    if(existing) {
      return existing;
    }

    const service = createMockService(serviceType.UUID) as MockService & { setCharacteristic?: () => unknown };

    service.displayName = name ?? "Mock Service";
    service.updateCharacteristic = vi.fn((characteristic: string, value: unknown) => {
      const current = service._characteristics.get(characteristic) ?? { value };
      current.value = value;
      service._characteristics.set(characteristic, current);
      return service;
    }) as never;
    const baseGetCharacteristic = service.getCharacteristic.bind(service);
    service.getCharacteristic = vi.fn((characteristic: string) => {
      const base = baseGetCharacteristic(characteristic) as unknown as Record<string, unknown>;
      return {
        ...base,
        setProps: vi.fn(() => base)
      };
    }) as never;

    accessory.addService(service);
    return service;
  });
}

function installSecurityEnums(hap: ReturnType<typeof createMockNvr>["platform"]["api"]["hap"]): void {

  (hap.Characteristic as unknown as Record<string, unknown>).SecuritySystemCurrentState = {
    ALARM_TRIGGERED: 4,
    AWAY_ARM: 1,
    DISARMED: 3,
    NIGHT_ARM: 2,
    STAY_ARM: 0
  };
  (hap.Characteristic as unknown as Record<string, unknown>).SecuritySystemTargetState = {
    AWAY_ARM: 1,
    DISARM: 3,
    NIGHT_ARM: 2,
    STAY_ARM: 0
  };
}

describe("ProtectSecuritySystem", () => {

  beforeEach(() => {

    vi.clearAllMocks();
    installChainableAcquireService();
    vi.mocked(pluginUtils.validService).mockReturnValue(true);
  });

  it("configures security service and mqtt state mapping", () => {

    const nvr = createMockNvr();
    installSecurityEnums(nvr.platform.api.hap);
    (nvr as unknown as { hasFeature: (name: string) => boolean }).hasFeature = vi.fn((name: string) => name === "SecuritySystem.Alarm");
    nvrBootstrap(nvr).liveviews = [
      { name: "Protect-Home", slots: [{ cameras: ["cam-1"] }] },
      { name: "Protect-Away", slots: [{ cameras: ["cam-2"] }] },
      { name: "Protect-Night", slots: [{ cameras: ["cam-1", "cam-2"] }] }
    ] as never;

    const accessory = createMockAccessory({ context: { securityState: 0 } });
    new ProtectSecuritySystem(nvr, accessory);

    const mqttGet = vi.mocked(nvr.mqtt!.subscribeGet).mock.calls.find(call => call[1] === "securitysystem")?.[3] as () => string;
    expect(mqttGet()).toBe("Home");
  });

  it("updates state and camera detectMotion via mqtt set", () => {

    const nvr = createMockNvr();
    installSecurityEnums(nvr.platform.api.hap);
    (nvr as unknown as { hasFeature: (name: string) => boolean }).hasFeature = vi.fn((name: string) => name === "SecuritySystem.Alarm");
    nvrBootstrap(nvr).liveviews = [
      { name: "Protect-Home", slots: [{ cameras: ["cam-1"] }] },
      { name: "Protect-Off", slots: [{ cameras: [] }] }
    ] as never;

    const cameraAccessory = createMockAccessory({ UUID: "cam-uuid-1", displayName: "Front Cam", context: { nvr: nvr.ufp.mac, detectMotion: false } });
    const motionSwitch = createMockService(nvr.platform.api.hap.Service.Switch.UUID);
    motionSwitch.subtype = ProtectReservedNames.SWITCH_MOTION_SENSOR;
    cameraAccessory.addService(motionSwitch);
    nvr.platform.accessories.push(cameraAccessory);
    nvr.configuredDevices.set(cameraAccessory.UUID, { ufp: { id: "cam-1" } } as never);

    const accessory = createMockAccessory({ context: { securityState: 3 } });
    nvr.platform.accessories.push(accessory);
    const security = new ProtectSecuritySystem(nvr, accessory);

    const mqttSet = vi.mocked(nvr.mqtt!.subscribeSet).mock.calls.find(call => call[1] === "securitysystem")?.[3] as (value: string) => void;
    mqttSet("home");

    expect(cameraAccessory.context.detectMotion).toBe(true);
    expect(motionSwitch.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.On, true);

    mqttSet("off");
    expect(cameraAccessory.context.detectMotion).toBe(false);
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(nvr.ufp.mac, "securitysystem", "Off");

    expect(security.updateDevice()).toBe(true);
  });

  it("handles alarm mqtt commands and invalid command path", () => {

    const nvr = createMockNvr();
    installSecurityEnums(nvr.platform.api.hap);
    (nvr as unknown as { hasFeature: (name: string) => boolean }).hasFeature = vi.fn(() => true);
    nvrBootstrap(nvr).liveviews = [{ name: "Protect-Home", slots: [{ cameras: ["cam-1"] }] }] as never;

    const accessory = createMockAccessory();
    new ProtectSecuritySystem(nvr, accessory);
    const mqttSet = vi.mocked(nvr.mqtt!.subscribeSet).mock.calls.find(call => call[1] === "securitysystem")?.[3] as (value: string) => void;

    mqttSet("alarmon");
    mqttSet("alarmoff");
    mqttSet("bad-value");

    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(nvr.ufp.mac, "securitysystem", "Alarm");
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to process MQTT security system setting: bad-value."));
  });

  it("returns false from updateDevice without matching liveview states", () => {

    const nvr = createMockNvr();
    installSecurityEnums(nvr.platform.api.hap);
    (nvr as unknown as { hasFeature: (name: string) => boolean }).hasFeature = vi.fn(() => false);
    nvrBootstrap(nvr).liveviews = [{ name: "Random", slots: [{ cameras: ["cam-1"] }] }] as never;
    const accessory = createMockAccessory();
    const security = new ProtectSecuritySystem(nvr, accessory);

    expect(security.updateDevice()).toBe(false);
  });

  it("logs missing scene mappings and ignores duplicate alarm toggles", () => {

    const nvr = createMockNvr();
    installSecurityEnums(nvr.platform.api.hap);
    (nvr as unknown as { hasFeature: (name: string) => boolean }).hasFeature = vi.fn(() => true);
    nvrBootstrap(nvr).liveviews = [{ name: "Protect-Off", slots: [{ cameras: [] }] }] as never;
    const accessory = createMockAccessory({ context: { securityState: 3 } });
    const security = new ProtectSecuritySystem(nvr, accessory) as any;

    security.setSecurityState(nvr.platform.api.hap.Characteristic.SecuritySystemTargetState.STAY_ARM);
    expect((nvr.log.info as ReturnType<typeof vi.fn>).mock.calls.some(call =>
      String(call[0]).includes("No liveview configured for this security system state"))).toBe(true);

    security.setSecurityAlarm(false);
    expect(nvr.mqtt?.publish).not.toHaveBeenCalledWith(nvr.ufp.mac, "securitysystem", "Alarm");
  });

  it("maps away and night states through mqtt commands", () => {

    const nvr = createMockNvr();
    installSecurityEnums(nvr.platform.api.hap);
    (nvr as unknown as { hasFeature: (name: string) => boolean }).hasFeature = vi.fn(() => true);
    nvrBootstrap(nvr).liveviews = [
      { name: "Protect-Away", slots: [{ cameras: ["cam-1"] }] },
      { name: "Protect-Night", slots: [{ cameras: ["cam-1"] }] },
      { name: "Protect-Off", slots: [{ cameras: [] }] }
    ] as never;

    const cameraAccessory = createMockAccessory({ UUID: "cam-uuid-night", displayName: "Night Cam", context: { nvr: nvr.ufp.mac, detectMotion: false } });
    nvr.platform.accessories.push(cameraAccessory);
    nvr.configuredDevices.set(cameraAccessory.UUID, { ufp: { id: "cam-1" } } as never);

    const accessory = createMockAccessory({ context: { securityState: 3 } });
    nvr.platform.accessories.push(accessory);
    new ProtectSecuritySystem(nvr, accessory);

    const mqttSet = vi.mocked(nvr.mqtt!.subscribeSet).mock.calls.find(call => call[1] === "securitysystem")?.[3] as (value: string) => void;
    mqttSet("away");
    mqttSet("night");
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(nvr.ufp.mac, "securitysystem", "Night");
  });

  it("covers configuration failures and unsupported state transitions", () => {

    const nvr = createMockNvr();
    installSecurityEnums(nvr.platform.api.hap);
    (nvr as unknown as { hasFeature: (name: string) => boolean }).hasFeature = vi.fn(() => true);
    nvrBootstrap(nvr).liveviews = [{ name: "Protect-Home", slots: [{ cameras: ["cam-1"] }] }] as never;

    const accessory = createMockAccessory({ context: { securityState: nvr.platform.api.hap.Characteristic.SecuritySystemCurrentState.AWAY_ARM } });
    const security = new ProtectSecuritySystem(nvr, accessory) as any;

    security.accessory.context.securityState = nvr.platform.api.hap.Characteristic.SecuritySystemCurrentState.NIGHT_ARM;
    security.configureSecuritySystem();

    const originalAcquire = vi.mocked(pluginUtils.acquireService).getMockImplementation();
    vi.mocked(pluginUtils.acquireService).mockImplementationOnce(() => null);
    expect(security.configureSecuritySystem()).toBe(false);
    vi.mocked(pluginUtils.acquireService).mockImplementation(originalAcquire ?? (() => createMockService("security")) as never);

    vi.mocked(pluginUtils.validService).mockReturnValue(false);
    expect(security.configureSecurityAlarm()).toBe(false);
    vi.mocked(pluginUtils.validService).mockReturnValue(true);
    vi.mocked(pluginUtils.acquireService).mockImplementationOnce(() => null);
    expect(security.configureSecurityAlarm()).toBe(false);

    setNvrBootstrap(nvr, null);
    security.setSecurityState(nvr.platform.api.hap.Characteristic.SecuritySystemTargetState.STAY_ARM);
    setNvrBootstrap(nvr, { ...createMockNvr().ufpApi.bootstrap, liveviews: [{ name: "Protect-Home", slots: [{ cameras: ["cam-1"] }] }] });
    security.setSecurityState(999 as never);
  });
});
