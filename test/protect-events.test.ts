import { ProtectEvents } from "../src/protect-events.js";
import { PROTECT_DOORBELL_TRIGGER_DURATION } from "../src/settings.js";
import { ProtectReservedNames } from "../src/protect-types.js";
import { createMockAccessory, createMockNvr, createMockService, testInternals } from "./helpers/mocks.js";
import type { ProtectNvr } from "../src/protect-nvr.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const devicesMocks = vi.hoisted(() => {

  class ProtectCameraMock {}
  class ProtectDoorbellMock extends ProtectCameraMock {}

  return {
    ProtectCameraMock,
    ProtectDoorbellMock
  };
});

vi.mock("../src/devices/index.js", () => ({
  ProtectCamera: devicesMocks.ProtectCameraMock,
  ProtectDoorbell: devicesMocks.ProtectDoorbellMock
}));

function createNvrWithUfpEmitter(enableTelemetry = false) {

  const emitter = new EventEmitter() as EventEmitter & {
    getDeviceName: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };

  emitter.getDeviceName = vi.fn(() => "Mock Device");
  emitter.on = vi.fn(emitter.on.bind(emitter));

  return createMockNvr({
    addHomeKitDevice: vi.fn(),
    getDeviceById: vi.fn(() => null),
    hasFeature: vi.fn((option: string) => enableTelemetry && option === "Nvr.Publish.Telemetry"),
    removeHomeKitDevice: vi.fn(),
    ufpApi: emitter
  });
}

function createService(uuid: string, subtype?: string) {

  const service = createMockService(uuid);

  (service as unknown as { subtype?: string }).subtype = subtype;
  (service as unknown as { testCharacteristic: ReturnType<typeof vi.fn> }).testCharacteristic = vi.fn(() => true);

  return service;
}

function createProtectDevice(overrides: Record<string, unknown> = {}) {

  const nvr = createNvrWithUfpEmitter();
  const hap = nvr.platform.api.hap;
  const accessory = createMockAccessory({
    context: { detectMotion: true, doorbellMuted: false },
    getService: vi.fn((type: { UUID: string }) => accessory.services.find(s => s.UUID === type.UUID)),
    getServiceById: vi.fn((type: { UUID: string }, id: string) => accessory.services.find(s => s.UUID === type.UUID && (s as unknown as { subtype?: string }).subtype === id))
  });
  const motionService = createService(hap.Service.MotionSensor.UUID);
  const occupancyService = createService(hap.Service.OccupancySensor.UUID);
  const doorbellService = createService(hap.Service.Doorbell.UUID);
  const triggerService = createService(hap.Service.Switch.UUID, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER);
  const motionTriggerService = createService(hap.Service.Switch.UUID, ProtectReservedNames.SWITCH_MOTION_TRIGGER);
  const personContact = createService(hap.Service.ContactSensor.UUID, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + ".person");
  const vehicleContact = createService(hap.Service.ContactSensor.UUID, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT + ".vehicle");
  const plateContact = createService(hap.Service.ContactSensor.UUID, ProtectReservedNames.CONTACT_MOTION_SMARTDETECT_LICENSE + ".ABC123");

  const programmableSwitch = { sendEventNotification: vi.fn() };

  doorbellService.getCharacteristic = vi.fn(() => programmableSwitch) as never;
  for(const service of accessory.services) {

    (service as unknown as { testCharacteristic?: (name: string) => boolean }).testCharacteristic ??= vi.fn(() => false);
  }

  accessory.services.push(motionService, occupancyService, doorbellService, triggerService, motionTriggerService, personContact, vehicleContact, plateContact);

  const protectDevice = {
    accessory: accessory,
    configureInfo: vi.fn(),
    hints: {
      logDoorbell: true,
      logMotion: true,
      motionDuration: 1,
      occupancyDuration: 1,
      smartDetect: true,
      smartOccupancy: [ "person", "vehicle" ],
      syncName: true
    },
    id: "camera-1",
    isOnline: true,
    isRinging: false,
    log: {
      debug: vi.fn(),
      info: vi.fn()
    },
    programmableSwitch: programmableSwitch,
    ufp: {
      featureFlags: { isDoorbell: false },
      id: "camera-1",
      mac: "AA:BB:CC:DD:EE:11",
      modelKey: "camera",
      name: "Front Door"
    },
    ...overrides
  };

  return { nvr, protectDevice };
}

describe("ProtectEvents", () => {

  beforeEach(() => {

    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("routes add, remove, update and default message actions", () => {

    const nvr = createNvrWithUfpEmitter();
    const events = new ProtectEvents(nvr as never);
    const addAny = vi.fn();
    const removeAny = vi.fn();
    const updateAny = vi.fn();

    events.on("addEvent", addAny);
    events.on("removeEvent", removeAny);
    events.on("updateEvent", updateAny);

    nvr.ufpApi.emit("message", {
      header: { action: "add", id: "event-1", modelKey: "event" },
      payload: { cameraId: "camera-1", type: "motion" }
    });
    nvr.ufpApi.emit("message", {
      header: { action: "remove", id: "camera-2", modelKey: "camera" },
      payload: {}
    });
    nvr.ufpApi.emit("message", {
      header: { action: "update", id: "camera-3", modelKey: "camera", recordId: "record-99" },
      payload: { isConnected: true }
    });
    nvr.ufpApi.emit("message", {
      header: { action: "noop", id: "none", modelKey: "camera" },
      payload: {}
    });

    expect(addAny).toHaveBeenCalledTimes(1);
    expect(removeAny).toHaveBeenCalledTimes(1);
    expect(updateAny).toHaveBeenCalledTimes(1);
    expect(events.listenerCount("updateEvent.record-99")).toBeGreaterThanOrEqual(0);
  });

  it("publishes telemetry when telemetry feature is enabled", () => {

    const nvr = createNvrWithUfpEmitter(true);
    const events = new ProtectEvents(nvr as never);
    const packet = {
      header: { action: "update", id: "camera-4", modelKey: "camera" },
      payload: { isConnected: true }
    };

    nvr.ufp.mac = "AA:BB";
    nvr.ufpApi.emit("message", packet);

    expect(events).toBeDefined();
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith("AA:BB", "telemetry", JSON.stringify(packet));
  });

  it("updates nvr state and merges device updates", () => {

    const { nvr, protectDevice } = createProtectDevice();
    const events = new ProtectEvents(nvr as never);
    const statusService = createService(nvr.platform.api.hap.Service.Switch.UUID);

    protectDevice.accessory.services.push(statusService);
    testInternals<ProtectNvr>(nvr).getDeviceById = vi.fn(() => protectDevice) as never;
    nvr.ufp = { name: "old", nested: { old: true } } as never;

    nvr.ufpApi.emit("message", {
      header: { action: "update", id: "nvr-id", modelKey: "nvr" },
      payload: { nested: { new: true }, version: "7.0.0" }
    });
    nvr.ufpApi.emit("message", {
      header: { action: "update", id: "camera-1", modelKey: "camera" },
      payload: { isConnected: true, nested: { value: 1 }, name: "Updated Name" }
    });
    nvr.ufpApi.emit("message", {
      header: { action: "update", hbupBootstrap: true, id: "camera-1", modelKey: "camera" },
      payload: { featureFlags: { isDoorbell: false }, id: "camera-1", mac: "AA", modelKey: "camera", name: "Bootstrap Camera" }
    });

    expect((nvr.ufp as { version?: string }).version).toBe("7.0.0");
    expect(protectDevice.configureInfo).toHaveBeenCalledTimes(1);
    expect(protectDevice.log.info).toHaveBeenCalledWith("Name change detected. A restart of Homebridge may be needed in order to complete name synchronization with HomeKit.");
  });

  it("reconfigures camera when doorbell feature appears", () => {

    const nvr = createNvrWithUfpEmitter();
    const events = new ProtectEvents(nvr as never);
    const camera = Object.assign(new devicesMocks.ProtectCameraMock(), {
      accessory: createMockAccessory(),
      hints: { syncName: false },
      id: "camera-1",
      isOnline: true,
      ufp: { featureFlags: { isDoorbell: false }, id: "camera-1", modelKey: "camera" }
    });

    testInternals<ProtectNvr>(nvr).getDeviceById = vi.fn(() => camera) as never;
    nvr.reconfigureAsDoorbell = vi.fn();
    nvr.ufpApi.emit("message", {
      header: { action: "update", id: "camera-1", modelKey: "camera" },
      payload: { featureFlags: { isDoorbell: true } }
    });

    expect(nvr.reconfigureAsDoorbell).toHaveBeenCalledWith(camera);
    expect(events).toBeDefined();
  });

  it("handles adoption and unadoption add events with metadata guards", () => {

    const nvr = createNvrWithUfpEmitter();
    const events = new ProtectEvents(nvr as never);
    const devicePayload = {
      featureFlags: { isDoorbell: false },
      id: "device-1",
      isAdopted: true,
      isAdoptedByOther: false,
      mac: "AA:BB:CC:DD",
      modelKey: "camera"
    };
    const accessory = createMockAccessory({ UUID: "accessory-1" });

    testInternals<ProtectNvr>(nvr).getDeviceById = vi.fn(() => null) as never;
    nvr.ufpApi.emit("message", {
      header: { action: "update", id: "device-1", modelKey: "camera" },
      payload: devicePayload
    });
    nvr.ufpApi.emit("message", {
      header: { action: "add", id: "event-adopt", modelKey: "event" },
      payload: { metadata: { deviceId: { text: "device-1" } }, type: "deviceAdopted" }
    });
    nvr.ufpApi.emit("message", {
      header: { action: "add", id: "event-bad", modelKey: "event" },
      payload: { metadata: {}, type: "deviceAdopted" }
    });
    testInternals<ProtectNvr>(nvr).getDeviceById = vi.fn(() => ({ accessory: accessory })) as never;
    nvr.ufpApi.emit("message", {
      header: { action: "add", id: "event-unadopt", modelKey: "event" },
      payload: { metadata: { deviceId: { text: "device-1" } }, type: "deviceUnadopted" }
    });

    expect(events).toBeDefined();
    expect(nvr.addHomeKitDevice).toHaveBeenCalledWith(devicePayload);
    expect(nvr.removeHomeKitDevice).toHaveBeenCalledWith(accessory);
  });

  it("ignores adopted events for already-configured devices and unadopt for missing devices", () => {

    const nvr = createNvrWithUfpEmitter();
    const events = new ProtectEvents(nvr as never);

    testInternals<ProtectNvr>(nvr).getDeviceById = vi.fn(() => ({ accessory: createMockAccessory() })) as never;
    nvr.ufpApi.emit("message", {
      header: { action: "add", id: "event-adopt-existing", modelKey: "event" },
      payload: { metadata: { deviceId: { text: "device-1" } }, type: "deviceAdopted" }
    });

    testInternals<ProtectNvr>(nvr).getDeviceById = vi.fn(() => null) as never;
    nvr.ufpApi.emit("message", {
      header: { action: "add", id: "event-unadopt-missing", modelKey: "event" },
      payload: { metadata: { deviceId: { text: "device-1" } }, type: "deviceUnadopted" }
    });

    expect(nvr.addHomeKitDevice).not.toHaveBeenCalled();
    expect(nvr.removeHomeKitDevice).not.toHaveBeenCalled();
    expect(events).toBeDefined();
  });

  it("delivers motion events, smart detections, metadata and occupancy", () => {

    vi.useFakeTimers();
    const { nvr, protectDevice } = createProtectDevice();
    const events = new ProtectEvents(nvr as never);

    events.motionEventHandler(protectDevice as never, [ "person", "vehicle" ], {
      detectedThumbnails: [
        {
          attributes: {
            color: { confidence: 92, val: "black" },
            vehicleType: { confidence: 88, val: "sedan" }
          },
          confidence: 91,
          name: "abc123",
          type: "vehicle"
        }
      ]
    } as never);

    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(protectDevice.ufp.mac, "motion", "true");
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(protectDevice.ufp.mac, "motion/smart/person", "true");
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(protectDevice.ufp.mac, "motion/smart/vehicle/metadata", expect.stringContaining("\"type\":\"vehicle\""));
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(protectDevice.ufp.mac, "occupancy", "true");

    vi.advanceTimersByTime(1_100);

    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(protectDevice.ufp.mac, "motion", "false");
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(protectDevice.ufp.mac, "motion/smart/person", "false");
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(protectDevice.ufp.mac, "occupancy", "false");
    expect(protectDevice.log.debug).toHaveBeenCalled();
  });

  it("ignores motion when detection is disabled or service missing", () => {

    const { nvr, protectDevice } = createProtectDevice();
    const events = new ProtectEvents(nvr as never);

    protectDevice.accessory.context.detectMotion = false;
    events.motionEventHandler(protectDevice as never, [ "person" ]);
    expect(nvr.mqtt?.publish).not.toHaveBeenCalledWith(protectDevice.ufp.mac, "motion", "true");

    protectDevice.accessory.services = [];
    events.motionEventHandler(protectDevice as never, [ "person" ]);
    expect(nvr.mqtt?.publish).not.toHaveBeenCalled();
  });

  it("handles doorbell rings, mute state and timer throttling", () => {

    vi.useFakeTimers();
    const { nvr, protectDevice } = createProtectDevice();
    const events = new ProtectEvents(nvr as never);
    const switchService = protectDevice.accessory.getServiceById(nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_TRIGGER) as
      ReturnType<typeof createService>;
    const programmableSwitch = (protectDevice as unknown as { programmableSwitch: { sendEventNotification: ReturnType<typeof vi.fn> } }).programmableSwitch;

    nvr.platform.config.ringDelay = 2;
    events.doorbellEventHandler(protectDevice as never, 12345);

    expect(programmableSwitch.sendEventNotification).toHaveBeenCalledTimes(1);
    expect(switchService.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.On, true);
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(protectDevice.ufp.mac, "doorbell", "true");

    events.doorbellEventHandler(protectDevice as never, 12346);
    expect(programmableSwitch.sendEventNotification).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(PROTECT_DOORBELL_TRIGGER_DURATION + 10);
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith(protectDevice.ufp.mac, "doorbell", "false");

    protectDevice.accessory.context.doorbellMuted = true;
    events.doorbellEventHandler(protectDevice as never, 12347);
    expect(programmableSwitch.sendEventNotification).toHaveBeenCalledTimes(1);
  });

  it("clears in-flight smart-detect, occupancy, and doorbell timers", () => {

    vi.useFakeTimers();
    const { nvr, protectDevice } = createProtectDevice();
    const events = new ProtectEvents(nvr as never);
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const smartKey = protectDevice.id + ".Motion.SmartDetect.ObjectSensors.vehicle";
    const plateKey = smartKey + ".ABC123";
    const occupancyKey = protectDevice.id + ".Motion.OccupancySensor";
    const triggerKey = protectDevice.id + ".Doorbell.Ring.Trigger";
    const mqttKey = protectDevice.id + ".Doorbell.Ring.MQTT";
    (events as any).eventTimers.set(smartKey, setTimeout(() => undefined, 60_000));
    (events as any).eventTimers.set(plateKey, setTimeout(() => undefined, 60_000));
    (events as any).eventTimers.set(occupancyKey, setTimeout(() => undefined, 60_000));
    (events as any).eventTimers.set(triggerKey, setTimeout(() => undefined, 60_000));
    (events as any).eventTimers.set(mqttKey, setTimeout(() => undefined, 60_000));
    nvr.platform.config.ringDelay = undefined as unknown as number;

    events.motionEventHandler(protectDevice as never, [ "vehicle" ], {
      detectedThumbnails: [ { confidence: 88, name: "abc123", type: "vehicle" } ]
    } as never);
    events.doorbellEventHandler(protectDevice as never, 777);

    expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect((events as any).eventTimers.has(triggerKey)).toBe(true);
    expect((events as any).eventTimers.has(mqttKey)).toBe(true);
  });

  it("skips doorbell handling when ring is invalid or no service", () => {

    const { nvr, protectDevice } = createProtectDevice();
    const events = new ProtectEvents(nvr as never);

    events.doorbellEventHandler(protectDevice as never, null);
    expect(nvr.mqtt?.publish).not.toHaveBeenCalled();

    protectDevice.accessory.services = [];
    events.doorbellEventHandler(protectDevice as never, 111);
    expect(nvr.mqtt?.publish).not.toHaveBeenCalled();
  });
});
