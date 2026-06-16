import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pluginUtils from "homebridge-plugin-utils";
import { ProtectViewer } from "../../src/devices/protect-viewer.js";
import {
  createMockAccessory,
  createMockNvr,
  createMockService,
  createMockViewerConfig,
  getServiceCharacteristicHandlers,
  nvrBootstrap,
  setNvrBootstrap,
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

function createViewerConfig(overrides: object = {}) {

  return createMockViewerConfig(overrides);
}

describe("ProtectViewer", () => {

  beforeEach(() => {

    vi.clearAllMocks();
    installAccessoryAwareAcquireService();
    vi.mocked(pluginUtils.validService).mockReturnValue(true);
  });

  it("configures and updates liveview switches", () => {

    const nvr = createConfiguredNvr();
    nvrBootstrap(nvr).liveviews = [
      { id: "lv1", name: "Front" },
      { id: "lv2", name: "Back" }
    ] as never;

    const accessory = createMockAccessory();
    const viewer = new ProtectViewer(nvr, createViewerConfig(), accessory);

    expect(viewer.updateDevice()).toEqual(["Front", "Back"]);
    expect(accessory.getServiceById(nvr.platform.api.hap.Service.Switch, "lv1")).toBeTruthy();
    expect(accessory.getServiceById(nvr.platform.api.hap.Service.Switch, "lv2")).toBeTruthy();
  });

  it("sets liveview switch state via characteristic handlers", async () => {

    const nvr = createConfiguredNvr();
    nvrBootstrap(nvr).liveviews = [{ id: "lv1", name: "Front" }] as never;
    const accessory = createMockAccessory();
    const viewer = new ProtectViewer(nvr, createViewerConfig({ liveview: null }), accessory);
    const service = accessory.getServiceById(nvr.platform.api.hap.Service.Switch, "lv1") as MockService;
    const handlers = getServiceCharacteristicHandlers(service, nvr.platform.api.hap.Characteristic.On);

    expect(handlers.onGet?.()).toBe(false);
    await handlers.onSet?.(true);

    expect(nvr.ufpApi.updateDevice).toHaveBeenCalledWith(expect.any(Object), { liveview: "lv1" });
    expect(nvr.mqtt?.publish).toHaveBeenCalledWith("AA:BB:CC:DD:EE:05", "liveview", "Front");
    expect(service.updateCharacteristic).toHaveBeenCalledWith(nvr.platform.api.hap.Characteristic.On, true);
  });

  it("logs when liveview set fails", async () => {

    const nvr = createConfiguredNvr();
    nvrBootstrap(nvr).liveviews = [{ id: "lv1", name: "Front" }] as never;
    vi.mocked(nvr.ufpApi.updateDevice).mockResolvedValueOnce(null as never);

    const accessory = createMockAccessory();
    new ProtectViewer(nvr, createViewerConfig(), accessory);
    const service = accessory.getServiceById(nvr.platform.api.hap.Service.Switch, "lv1") as MockService;
    const handlers = getServiceCharacteristicHandlers(service, nvr.platform.api.hap.Characteristic.On);

    await handlers.onSet?.(false);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to clear the liveview."));
  });

  it("handles mqtt get/set and unknown liveview path", async () => {

    const nvr = createConfiguredNvr();
    nvrBootstrap(nvr).liveviews = [{ id: "lv1", name: "Front" }] as never;
    const accessory = createMockAccessory();
    new ProtectViewer(nvr, createViewerConfig(), accessory);

    const getCb = vi.mocked(nvr.mqtt!.subscribeGet).mock.calls.find(call => call[1] === "liveview")?.[3] as () => string;
    const setCb = vi.mocked(nvr.mqtt!.subscribeSet).mock.calls.find(call => call[1] === "liveview")?.[3] as (value: string) => Promise<void>;

    expect(getCb()).toBe("Front");
    await setCb("front");
    expect(nvr.log.info).toHaveBeenCalledWith(expect.stringContaining("Liveview set via MQTT to Front."));

    await setCb("missing");
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to locate a liveview named missing."));
  });

  it("handles viewer update events", () => {

    const nvr = createConfiguredNvr();
    nvrBootstrap(nvr).liveviews = [{ id: "lv1", name: "Front" }] as never;
    const accessory = createMockAccessory();
    const viewer = new ProtectViewer(nvr, createViewerConfig(), accessory);
    const updateSpy = vi.spyOn(viewer, "updateDevice");

    nvr.events.emit("updateEvent.viewer-1", { payload: { liveview: "lv1" } });
    nvr.events.emit("updateEvent.viewer-1", { payload: { somethingElse: true } });

    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it("logs when no liveviews are configured and handles add failures", () => {

    const nvr = createConfiguredNvr();
    nvrBootstrap(nvr).liveviews = [] as never;
    const accessory = createMockAccessory();
    const viewer = new ProtectViewer(nvr, createViewerConfig(), accessory);
    expect(nvr.log.info).toHaveBeenCalledWith(expect.stringContaining("No liveviews configured."));

    vi.spyOn(viewer as never, "acquireService" as never).mockReturnValue(null);
    const result = (viewer as any).addLiveviewSwitch([ "", "missing-liveview" ]);
    expect(result).toBe(false);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to add liveview switch"));
  });

  it("removes stale switches and handles liveview update failures", async () => {

    const nvr = createConfiguredNvr();
    nvrBootstrap(nvr).liveviews = [{ id: "lv1", name: "Front" }] as never;
    const accessory = createMockAccessory();
    accessory.addService(createMockService(nvr.platform.api.hap.Service.Switch.UUID));
    const staleSwitch = createMockService(nvr.platform.api.hap.Service.Switch.UUID);
    staleSwitch.subtype = "stale";
    accessory.addService(staleSwitch);

    const viewer = new ProtectViewer(nvr, createViewerConfig(), accessory);
    expect(accessory.removeService).toHaveBeenCalledWith(staleSwitch);

    vi.mocked(nvr.ufpApi.updateDevice).mockResolvedValueOnce(null as never);
    const liveviewSwitch = accessory.getServiceById(nvr.platform.api.hap.Service.Switch, "lv1") as MockService;
    const liveviewHandlers = getServiceCharacteristicHandlers(liveviewSwitch, nvr.platform.api.hap.Characteristic.On);
    await liveviewHandlers.onSet?.(true);
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to set the liveview to"));

    vi.mocked(nvr.ufpApi.updateDevice).mockResolvedValueOnce(null as never);
    const mqttSet = vi.mocked(nvr.mqtt!.subscribeSet).mock.calls.find(call => call[1] === "liveview")?.[3] as (value: string) => Promise<void>;
    await mqttSet("front");
    expect(nvr.log.error).toHaveBeenCalledWith(expect.stringContaining("Unable to set liveview via MQTT"));
  });

  it("handles undefined bootstrap liveviews and active liveview mqtt state", () => {

    const nvr = createConfiguredNvr();
    setNvrBootstrap(nvr, null);
    const accessory = createMockAccessory();
    const viewer = new ProtectViewer(nvr, createViewerConfig({ liveview: null }), accessory);

    expect(viewer.updateDevice()).toEqual([]);

    setNvrBootstrap(nvr, { liveviews: [ { id: "lv1", name: "Front" } ] });
    const activeViewer = new ProtectViewer(nvr, createViewerConfig({ liveview: "lv1" }), createMockAccessory());
    const getCb = vi.mocked(nvr.mqtt!.subscribeGet).mock.calls.at(-1)?.[3] as () => string;
    const service = activeViewer.accessory.getServiceById(nvr.platform.api.hap.Service.Switch, "lv1") as MockService;
    const handlers = getServiceCharacteristicHandlers(service, nvr.platform.api.hap.Characteristic.On);

    expect(getCb()).toBe("Front");
    expect(handlers.onGet?.()).toBe(true);
  });
});
