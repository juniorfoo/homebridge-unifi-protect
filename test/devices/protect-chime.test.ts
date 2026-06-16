import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pluginUtils from "homebridge-plugin-utils";
import { ProtectChime } from "../../src/devices/protect-chime.js";
import { PROTECT_DOORBELL_CHIME_SPEAKER_DURATION } from "../../src/settings.js";
import { ProtectReservedNames } from "../../src/protect-types.js";
import {
  createMockAccessory,
  createMockChimeConfig,
  createMockNvr,
  createMockService,
  getServiceCharacteristicHandlers,
  nvrBootstrap,
  type MockService
} from "../helpers/mocks.js";

function createConfiguredNvr(): ReturnType<typeof createMockNvr> {

  const nvr = createMockNvr();
  (nvr.ufpApi as unknown as { getDeviceName: (device: { name?: string; marketName?: string }) => string }).getDeviceName =
    vi.fn((device) => device.name ?? device.marketName ?? "Device");
  (nvr as unknown as { logFeature: (feature: string, message: string) => void }).logFeature = vi.fn();
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

describe("ProtectChime", () => {

  beforeEach(() => {

    vi.clearAllMocks();
    vi.useRealTimers();
    installAccessoryAwareAcquireService();
    vi.mocked(pluginUtils.validService).mockReturnValue(true);
  });

  it("constructs with buzzer and ringtone switches from bootstrap", () => {

    const nvr = createConfiguredNvr();
    nvrBootstrap(nvr).ringtones = [
      { id: "tone-1", name: "Chime", nvrMac: "AA:BB:CC:DD:EE:01" },
      { id: "tone-2", name: "Bell", nvrMac: "AA:BB:CC:DD:EE:01" },
      { id: "tone-3", name: "Other", nvrMac: "OTHER-MAC" }
    ] as never;
    const accessory = createMockAccessory();
    const chime = new ProtectChime(nvr, createMockChimeConfig(), accessory);

    const buzzer = accessory.getServiceById(chime.api.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_BUZZER);
    const tone1 = accessory.getServiceById(chime.api.hap.Service.Switch, `${ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER}.tone-1`);
    const tone2 = accessory.getServiceById(chime.api.hap.Service.Switch, `${ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER}.tone-2`);
    const tone3 = accessory.getServiceById(chime.api.hap.Service.Switch, `${ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER}.tone-3`);

    expect(buzzer).toBeTruthy();
    expect(tone1).toBeTruthy();
    expect(tone2).toBeTruthy();
    expect(tone3).toBeFalsy();
  });

  it("toggles switch handlers and uses timers for reset", async () => {

    vi.useFakeTimers();

    const nvr = createConfiguredNvr();
    nvrBootstrap(nvr).ringtones = [{ id: "tone-1", name: "Chime", nvrMac: "AA:BB:CC:DD:EE:01" }] as never;
    const accessory = createMockAccessory();
    new ProtectChime(nvr, createMockChimeConfig(), accessory);

    const buzzerService = accessory.getServiceById(nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_BUZZER) as MockService;
    const handlers = getServiceCharacteristicHandlers(buzzerService, nvr.platform.api.hap.Characteristic.On);

    expect(handlers.onGet?.()).toBe(false);
    await handlers.onSet?.(true);
    expect(nvr.ufpApi.retrieve).toHaveBeenCalled();
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith("AA:BB:CC:DD:EE:03", "tone", "buzzer");
    expect(nvr.log.info).toHaveBeenCalledWith(expect.stringContaining("Playing buzzer."));

    vi.advanceTimersByTime(PROTECT_DOORBELL_CHIME_SPEAKER_DURATION + 20);
    expect(buzzerService.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.On, false);
  });

  it("handles playTone failures and reset branch", async () => {

    vi.useFakeTimers();
    const nvr = createConfiguredNvr();
    nvrBootstrap(nvr).ringtones = [{ id: "tone-1", name: "Chime", nvrMac: "AA:BB:CC:DD:EE:01" }] as never;
    vi.mocked(nvr.ufpApi.responseOk).mockReturnValue(false);
    const accessory = createMockAccessory();
    new ProtectChime(nvr, createMockChimeConfig(), accessory);

    const service = accessory.getServiceById(nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_BUZZER) as MockService;
    const handlers = getServiceCharacteristicHandlers(service, nvr.platform.api.hap.Characteristic.On);

    await handlers.onSet?.(true);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to play buzzer."));
    vi.advanceTimersByTime(60);
    expect(service.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.On, false);
  });

  it("supports false onSet path without triggering play", async () => {

    vi.useFakeTimers();

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    new ProtectChime(nvr, createMockChimeConfig(), accessory);

    const service = accessory.getServiceById(nvr.platform.api.hap.Service.Switch, ProtectReservedNames.SWITCH_DOORBELL_CHIME_BUZZER) as MockService;
    const handlers = getServiceCharacteristicHandlers(service, nvr.platform.api.hap.Characteristic.On);

    await handlers.onSet?.(false);
    vi.advanceTimersByTime(60);

    expect(nvr.ufpApi.retrieve).not.toHaveBeenCalled();
    expect(service.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.On, false);
  });

  it("handles MQTT tone set callback and unknown tone branch", () => {

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    new ProtectChime(nvr, createMockChimeConfig(), accessory);

    const callback = vi.mocked(nvr.mqtt!.subscribeSet).mock.calls.find(call => call[1] === "tone")?.[3] as (value: string) => void;

    callback("chime");
    callback("buzzer");
    callback("invalid-tone");

    expect(nvr.ufpApi.retrieve).toHaveBeenCalledTimes(2);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unknown chime tone."));
  });

  it("removes stale ringtone services during updateDevice", () => {

    const nvr = createConfiguredNvr();
    nvrBootstrap(nvr).ringtones = [{ id: "tone-1", name: "Chime", nvrMac: "AA:BB:CC:DD:EE:01" }] as never;
    const accessory = createMockAccessory();
    const staleService = createMockService(nvr.platform.api.hap.Service.Switch.UUID);
    staleService.subtype = `${ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER}.stale`;
    accessory.addService(staleService);

    const chime = new ProtectChime(nvr, createMockChimeConfig(), accessory);
    chime.updateDevice();

    expect(accessory.removeService).toHaveBeenCalledWith(staleService);
  });

  it("handles missing tone payload metadata and invalid endpoint", async () => {

    const nvr = createConfiguredNvr();
    const accessory = createMockAccessory();
    const chime = new ProtectChime(nvr, createMockChimeConfig({ ringSettings: [] }), accessory);

    await expect((chime as any).playTone("tone", "")).resolves.toBe(false);
    await expect((chime as any).playTone("tone", "play-speaker", "unknown-tone")).resolves.toBe(false);
  });

  it("removes legacy services and handles switch creation failure", async () => {

    const nvr = createConfiguredNvr();
    nvrBootstrap(nvr).ringtones = [{ id: "tone-1", name: "Chime", nvrMac: "AA:BB:CC:DD:EE:01" }] as never;
    const accessory = createMockAccessory();
    accessory.addService(createMockService(nvr.platform.api.hap.Service.Lightbulb.UUID));
    const legacySpeaker = createMockService(nvr.platform.api.hap.Service.Switch.UUID);
    legacySpeaker.subtype = ProtectReservedNames.SWITCH_DOORBELL_CHIME_SPEAKER;
    accessory.addService(legacySpeaker);

    const chime = new ProtectChime(nvr, createMockChimeConfig(), accessory);
    expect(accessory.removeService).toHaveBeenCalledWith(legacySpeaker);

    await expect((chime as any).playTone("tone", "play-speaker", "tone-1")).resolves.toBe(true);
    expect(nvr.ufpApi.retrieve).toHaveBeenCalledWith(expect.stringContaining("/play-speaker"), expect.objectContaining({
      body: expect.stringContaining("\"ringtoneId\":\"tone-1\"")
    }));

    vi.spyOn(chime as never, "acquireService" as never).mockReturnValueOnce(null);
    expect((chime as any).configureChimeSwitch("broken", "play-speaker", "broken")).toBe(false);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to add broken switch."));
  });
});
