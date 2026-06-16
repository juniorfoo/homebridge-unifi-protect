import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pluginUtils from "homebridge-plugin-utils";
import type { PlatformAccessory } from "homebridge";
import { ProtectReservedNames } from "../../src/protect-types.js";
import { ProtectDevice } from "../../src/devices/protect-device.js";
import { createMockAccessory, createMockLightConfig, createMockNvr, createMockService, getServiceCharacteristicHandlers, type MockService } from "../helpers/mocks.js";

function createConfiguredNvr(...args: Parameters<typeof createMockNvr>): ReturnType<typeof createMockNvr> {

  const nvr = createMockNvr(...args);
  (nvr as unknown as { logFeature: (feature: string, message: string) => void }).logFeature = vi.fn();
  (nvr.ufpApi as unknown as { getDeviceName: (device: { name?: string; marketName?: string }) => string }).getDeviceName =
    vi.fn((device) => device.name ?? device.marketName ?? "Device");

  return nvr;
}

function installAccessoryAwareAcquireService(): void {

  vi.mocked(pluginUtils.acquireService).mockImplementation((accessory, serviceType, name, subtype) => {

    const existing = subtype ? accessory.getServiceById(serviceType, subtype) : accessory.getService(serviceType);

    if(existing) {
      return existing;
    }

    const service = createMockService(serviceType.UUID) as MockService;
    service.displayName = name ?? "Mock Service";
    service.subtype = subtype;
    accessory.addService(service);

    return service;
  });
}

class TestDevice extends ProtectDevice {

  constructor(nvr: ReturnType<typeof createMockNvr>, accessory: PlatformAccessory) {

    super(nvr, accessory);
    this.ufp = createMockLightConfig();
  }

  public runConfigureHints(): boolean {
    return this.configureHints();
  }

  public runConfigureInfo(): boolean {
    return this.configureInfo();
  }

  public runRegisterListener(event: string, handler: (packet: unknown) => void): void {
    this.registerListener(event, handler as never);
  }

  public runRegisterTimeout(key: string, callback: () => void, delay: number): void {
    this.registerTimeout(key, callback, delay);
  }

  public runClearTimer(key: string): void {
    this.clearTimer(key);
  }

  public runRegisterInterval(key: string, callback: () => void, interval: number): void {
    this.registerInterval(key, callback, interval);
  }

  public runPublish(topic: string, message: string): void {
    this.publish(topic, message);
  }

  public runSubscribeGet(topic: string, type: string, handler: () => string): void {
    this.subscribeGet(topic, type, handler);
  }

  public runSubscribeSet(topic: string, type: string, handler: (value: string, raw: string) => void): void {
    this.subscribeSet(topic, type, handler);
  }

  public runConfigureMotionSensor(isEnabled = true, isInitialized = false): boolean {
    return this.configureMotionSensor(isEnabled, isInitialized);
  }

  public runConfigureOccupancySensor(isEnabled = true, isInitialized = false): boolean {
    return this.configureOccupancySensor(isEnabled, isInitialized);
  }

  public runConfigureStatusLedSwitch(isEnabled = true): boolean {
    return this.configureStatusLedSwitch(isEnabled);
  }
}

describe("ProtectDevice", () => {

  beforeEach(() => {

    vi.clearAllMocks();
    vi.useRealTimers();
    installAccessoryAwareAcquireService();
    vi.mocked(pluginUtils.validService).mockReturnValue(true);
  });

  it("configureHints applies syncName and duration overrides with bounds", () => {

    const nvr = createConfiguredNvr({
      featureTest: (name: string) => name === "Device" || name === "Device.SyncName"
    });
    vi.mocked(nvr.platform.featureOptions.getInteger)
      .mockImplementation((option: string) => {
        if(option === "Motion.Duration") {
          return 1;
        }
        if(option === "Motion.OccupancySensor.Duration") {
          return 30;
        }
        return undefined;
      });

    const accessory = createMockAccessory();
    const device = new TestDevice(nvr, accessory);
    device.runConfigureHints();

    expect(device.hints.enabled).toBe(true);
    expect(device.hints.syncName).toBe(true);
    expect(device.hints.motionDuration).toBe(2);
    expect(device.hints.occupancyDuration).toBe(60);
  });

  it("configureInfo syncs accessory name when enabled", () => {

    const nvr = createConfiguredNvr({
      featureTest: (name: string) => name === "Device.SyncName"
    });
    (nvr.ufpApi as unknown as { getDeviceName: (device: unknown) => string }).getDeviceName = vi.fn(() => "Device Name");
    const accessory = createMockAccessory();
    const device = new TestDevice(nvr, accessory);

    device.runConfigureHints();
    device.ufp = createMockLightConfig({ name: "Synced Name" });
    device.runConfigureInfo();

    expect(accessory.displayName).toBe("Synced Name");
    expect((accessory.getService(nvr.platform.api.hap.Service.AccessoryInformation) as any).updateCharacteristic)
      .toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.Name, "Synced Name");
  });

  it("registerListener and cleanup deregister listeners and timers", () => {

    vi.useFakeTimers();

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    const device = new TestDevice(nvr, accessory);
    const handler = vi.fn();
    const timeoutCb = vi.fn();

    device.runRegisterListener("updateEvent.test", handler);
    device.runRegisterTimeout("timer-key", timeoutCb, 1000);

    expect(nvr.events.on).toHaveBeenCalledWith("updateEvent.test", handler);

    device.cleanup();

    expect(nvr.events.off).toHaveBeenCalledWith("updateEvent.test", handler);
    vi.advanceTimersByTime(1200);
    expect(timeoutCb).not.toHaveBeenCalled();
  });

  it("registerTimeout replaces existing timer and clearTimer cancels it", () => {

    vi.useFakeTimers();

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    const device = new TestDevice(nvr, accessory);
    const first = vi.fn();
    const second = vi.fn();

    device.runRegisterTimeout("a", first, 1000);
    device.runRegisterTimeout("a", second, 500);
    device.runClearTimer("a");

    vi.advanceTimersByTime(1200);

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("publishes and subscribes via mqtt wrappers", () => {

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    const device = new TestDevice(nvr, accessory);
    const getCb = vi.fn(() => "ok");
    const setCb = vi.fn();

    device.runPublish("test/topic", "payload");
    device.runSubscribeGet("test/get", "get type", getCb);
    device.runSubscribeSet("test/set", "set type", setCb);

    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(device.ufp.mac, "test/topic", "payload");
    expect(nvr.mqtt?.subscribeGet).toHaveBeenCalledWith(device.ufp.mac, "test/get", "get type", getCb);
    expect(nvr.mqtt?.subscribeSet).toHaveBeenCalledWith(device.ufp.mac, "test/set", "set type", setCb);
  });

  it("registerInterval replaces existing interval", () => {

    vi.useFakeTimers();

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    const device = new TestDevice(nvr, accessory);
    const first = vi.fn();
    const second = vi.fn();

    device.runRegisterInterval("i", first, 500);
    device.runRegisterInterval("i", second, 500);
    vi.advanceTimersByTime(1100);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(2);
  });

  it("configures motion services and trigger behavior", async () => {

    vi.useFakeTimers();

    const nvr = createConfiguredNvr({
      featureTest: (name: string) => name === "Motion.Switch" || name === "Motion.Trigger"
    });
    const accessory = createMockAccessory();
    const device = new TestDevice(nvr, accessory);

    expect(device.runConfigureMotionSensor(true, false)).toBe(true);

    const motionSwitch = accessory.getServiceById(nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_SENSOR) as MockService;
    const triggerSwitch = accessory.getServiceById(nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER) as MockService;
    const motionService = accessory.getService(nvr.platform.api.hap.Service.MotionSensor) as MockService;

    const motionHandlers = getServiceCharacteristicHandlers(motionSwitch, nvr.platform.api.hap.Characteristic.On);
    const triggerHandlers = getServiceCharacteristicHandlers(triggerSwitch, nvr.platform.api.hap.Characteristic.On);

    await motionHandlers.onSet?.(false);
    expect(accessory.context.detectMotion).toBe(false);

    await triggerHandlers.onSet?.(true);
    vi.advanceTimersByTime(60);
    expect(triggerSwitch.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.On, false);

    await motionHandlers.onSet?.(true);
    await triggerHandlers.onSet?.(true);
    expect(nvr.events.motionEventHandler).toHaveBeenCalledWith(device);

    motionService.updateCharacteristic(nvr.platform.api.hap.Characteristic.MotionDetected, true);
    await triggerHandlers.onSet?.(false);
    vi.advanceTimersByTime(60);
    expect(triggerSwitch.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.On, true);
  });

  it("configures occupancy and status LED switch branches", async () => {

    const nvr = createConfiguredNvr({
      featureTest: (name: string) => name === "Motion.OccupancySensor" || name === "Device.StatusLed.Switch"
    });
    const accessory = createMockAccessory();
    const device = new TestDevice(nvr, accessory);

    device.hints.smartDetect = true;
    device.hints.smartOccupancy = [];
    (device.ufp as any).featureFlags = { smartDetectAudioTypes: [], smartDetectTypes: [ "person" ] };

    expect(device.runConfigureOccupancySensor(true, false)).toBe(true);
    expect(nvr.log.info).toHaveBeenCalledWith(expect.stringContaining("no smart motion detection object type configured"));

    expect(device.runConfigureStatusLedSwitch(true)).toBe(true);
    const ledSwitch = accessory.getServiceById(nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_STATUS_LED) as MockService;
    const ledHandlers = getServiceCharacteristicHandlers(ledSwitch, nvr.platform.api.hap.Characteristic.On);

    vi.spyOn(device, "setStatusLed").mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await ledHandlers.onSet?.(false);
    await ledHandlers.onSet?.(true);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to turn the status light off"));
  });

  it("updates status LED state and utility getters", async () => {

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    const device = new TestDevice(nvr, accessory);

    vi.mocked(nvr.ufpApi.updateDevice).mockResolvedValueOnce(null as never);
    await expect(device.setStatusLed(true)).resolves.toBe(false);

    const updated = { ...device.ufp, ledSettings: { isEnabled: false } };
    vi.mocked(nvr.ufpApi.updateDevice).mockResolvedValueOnce(updated as never);
    await expect(device.setStatusLed(false)).resolves.toBe(true);
    expect(device.statusLed).toBe(false);
    expect(device.id).toBe(device.ufp.mac);
    expect(device.isReservedName(ProtectReservedNames.SWITCH_MOTION_SENSOR)).toBe(true);

    (device as any).ufp = { ...device.ufp, isConnected: true };
    expect(device.isOnline).toBe(true);
  });

  it("covers service failure and device-scoped logging branches", async () => {

    vi.useFakeTimers();
    const nvr = createConfiguredNvr({
      featureTest: (name: string) => name === "Device.SyncName"
    });
    vi.mocked(nvr.platform.featureOptions.scope).mockImplementation((option: string) => option === "Device.SyncName" ? "device" : "global");

    const accessory = createMockAccessory();
    const device = new TestDevice(nvr, accessory);
    device.ufp = createMockLightConfig({ firmwareVersion: "1.0.0", name: "Light One" });
    device.hints.syncName = false;
    device.runConfigureHints();
    device.runConfigureInfo();
    expect((accessory.getService(nvr.platform.api.hap.Service.AccessoryInformation) as any).updateCharacteristic)
      .toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.FirmwareRevision, "1.0.0");

    vi.spyOn(device as never, "acquireService" as never).mockReturnValueOnce(null).mockReturnValueOnce(null).mockReturnValueOnce(null);
    expect(device.runConfigureMotionSensor(true, false)).toBe(false);
    expect(device.runConfigureOccupancySensor(true, false)).toBe(false);
    expect(device.runConfigureStatusLedSwitch(true)).toBe(false);

    const enabledNvr = createConfiguredNvr({
      featureTest: (name: string) => [ "Motion.Switch", "Motion.Trigger", "Motion.OccupancySensor", "Motion.OccupancySensor.person" ].includes(name)
    });
    const enabledAccessory = createMockAccessory();
    const enabledDevice = new TestDevice(enabledNvr, enabledAccessory);
    enabledDevice.runConfigureHints();
    enabledDevice.hints.smartDetect = true;
    (enabledDevice.ufp as any).featureFlags = { smartDetectAudioTypes: [], smartDetectTypes: [ "person" ] };
    expect(enabledDevice.runConfigureMotionSensor(true, false)).toBe(true);
    expect(enabledDevice.runConfigureOccupancySensor(true, false)).toBe(true);
    expect(enabledDevice.hints.smartOccupancy).toContain("person");

    const motionSet = vi.mocked(enabledNvr.mqtt!.subscribeSet).mock.calls.find(call => call[1] === "motion")?.[3] as (value: string) => void;
    motionSet("false");

    const triggerSwitch = enabledAccessory.getServiceById(enabledNvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_MOTION_TRIGGER) as MockService;
    const triggerHandlers = getServiceCharacteristicHandlers(triggerSwitch, enabledNvr.platform.api.hap.Characteristic.On);
    await triggerHandlers.onSet?.(true);
    vi.advanceTimersByTime(60);

    vi.spyOn(enabledDevice as never, "acquireService" as never).mockReturnValueOnce(null).mockReturnValueOnce(null);
    expect((enabledDevice as any).configureMotionSwitch(true)).toBe(false);
    expect((enabledDevice as any).configureMotionTrigger(true)).toBe(false);
  });
});
