import { vi } from "vitest";
import type { PlatformAccessory, Service, WithUUID } from "homebridge";
import type { ProtectCameraConfig, ProtectChimeConfig, ProtectLightConfig, ProtectSensorConfig, ProtectViewerConfig } from "unifi-protect";
import type { ProtectNvr } from "../../src/protect-nvr.js";
import type { ProtectPlatform } from "../../src/protect-platform.js";

export { apiFromNvr, hapFromDevice, hapFromNvr, mutableApi, mutableCodecSupport, mutablePlatformApi, nvrBootstrap, setNvrBootstrap, testInternals } from "./test-utils.js";

export interface MockCharacteristic {

  onGet?: () => unknown;
  onSet?: (value: unknown) => void | Promise<void>;
  value: unknown;
}

export interface MockService extends Service {

  _characteristics: Map<string, MockCharacteristic>;
  displayName: string;
  subtype?: string;
}

export function createMockService(uuid = "service"): MockService {

  const characteristics = new Map<string, MockCharacteristic>();

  return {

    UUID: uuid,
    displayName: "Mock Service",
    subtype: undefined,
    _characteristics: characteristics,
    updateCharacteristic: vi.fn((name: string, value: unknown) => {

      const existing = characteristics.get(String(name));

      if(existing) {

        existing.value = value;
      } else {

        characteristics.set(String(name), { value: value });
      }
    }),
    setCharacteristic: vi.fn((name: string, value: unknown) => {

      const existing = characteristics.get(String(name));

      if(existing) {

        existing.value = value;
      } else {

        characteristics.set(String(name), { value: value });
      }
    }),
    addOptionalCharacteristic: vi.fn(),
    addLinkedService: vi.fn(),
    removeCharacteristic: vi.fn(),
    setPrimaryService: vi.fn(),
    getCharacteristic: vi.fn((name: string) => {

      if(!characteristics.has(String(name))) {

        characteristics.set(String(name), { value: false });
      }

      const char = characteristics.get(String(name))!;

      return {

        value: char.value,
        onGet: vi.fn(function(this: { onGet?: () => unknown }, fn: () => unknown) {

          char.onGet = fn;

          return this;
        }),
        onSet: vi.fn(function(this: { onSet?: (value: unknown) => void | Promise<void> }, fn: (value: unknown) => void | Promise<void>) {

          char.onSet = fn;

          return this;
        })
      };
    })
  } as unknown as MockService;
}

export function createMockHap() {

  const svc = (uuid: string) => ({ UUID: uuid });

  return {

    Service: {

      AccessoryInformation: svc("accessory-info"),
      CameraOperatingMode: svc("camera-op"),
      Lightbulb: svc("lightbulb"),
      MotionSensor: svc("motion"),
      OccupancySensor: svc("occupancy"),
      SecuritySystem: svc("security"),
      LockMechanism: svc("lock"),
      Switch: svc("switch"),
      ContactSensor: svc("contact"),
      LeakSensor: svc("leak"),
      TemperatureSensor: svc("temperature"),
      HumiditySensor: svc("humidity"),
      LightSensor: svc("light-sensor"),
      StatelessProgrammableSwitch: svc("stateless"),
      Doorbell: svc("doorbell"),
      Speaker: svc("speaker"),
      Microphone: svc("microphone")
    },
    Characteristic: {

      Name: "Name",
      Manufacturer: "Manufacturer",
      Model: "Model",
      SerialNumber: "SerialNumber",
      FirmwareRevision: "FirmwareRevision",
      HardwareRevision: "HardwareRevision",
      On: "On",
      Brightness: "Brightness",
      MotionDetected: "MotionDetected",
      OccupancyDetected: "OccupancyDetected",
      StatusActive: "StatusActive",
      ContactSensorState: "ContactSensorState",
      LeakDetected: "LeakDetected",
      CurrentTemperature: "CurrentTemperature",
      CurrentRelativeHumidity: "CurrentRelativeHumidity",
      CurrentAmbientLightLevel: "CurrentAmbientLightLevel",
      ProgrammableSwitchEvent: "ProgrammableSwitchEvent",
      Volume: "Volume",
      SecuritySystemCurrentState: "SecuritySystemCurrentState",
      SecuritySystemTargetState: "SecuritySystemTargetState",
      LockCurrentState: { SECURED: 1, UNSECURED: 0 },
      LockTargetState: { SECURED: 1, UNSECURED: 0 },
      EventSnapshotsActive: "EventSnapshotsActive",
      HomeKitCameraActive: "HomeKitCameraActive",
      NightVision: "NightVision",
      CameraOperatingModeIndicator: "CameraOperatingModeIndicator",
      StatusLowBattery: "StatusLowBattery",
      StatusTampered: "StatusTampered",
      LockPhysicalControls: "LockPhysicalControls",
      RotationSpeed: "RotationSpeed",
      TargetDoorState: "TargetDoorState",
      CurrentDoorState: "CurrentDoorState",
      StreamingStatus: "StreamingStatus",
      SupportedAudioStreamConfiguration: "SupportedAudioStreamConfiguration",
      SupportedVideoStreamConfiguration: "SupportedVideoStreamConfiguration",
      SupportedRecordingConfiguration: "SupportedRecordingConfiguration",
      Active: "Active"
    },
    uuid: {

      generate: (input: string): string => input
    }
  };
}

export function createMockAccessory(overrides: Record<string, unknown> = {}): PlatformAccessory {

  const services: Service[] = [];
  const infoService = createMockService("accessory-info");

  services.push(infoService);

  return {

    UUID: "accessory-uuid",
    context: {},
    displayName: "Test Accessory",
    services: services,
    getService: vi.fn((type: { UUID: string }) => services.find(s => s.UUID === type.UUID)),
    getServiceById: vi.fn((type: { UUID: string }, id: string) => services.find(s => s.UUID === type.UUID && (s as MockService).subtype === id)),
    removeService: vi.fn((service: Service) => {

      const index = services.indexOf(service);

      if(index >= 0) {

        services.splice(index, 1);
      }
    }),
    addService: vi.fn((service: Service) => { services.push(service); }),
    configureController: vi.fn(),
    removeController: vi.fn(),
    _associatedHAPAccessory: { displayName: "Test Accessory" },
    ...overrides
  } as unknown as PlatformAccessory;
}

export function createMockPlatform(overrides: Partial<ProtectPlatform> = {}): ProtectPlatform {

  const log = {

    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn()
  };

  const hap = createMockHap();

  return {

    accessories: [],
    api: {

      hap: hap,
      on: vi.fn(),
      publishExternalAccessories: vi.fn(),
      registerPlatformAccessories: vi.fn(),
      unregisterPlatformAccessories: vi.fn(),
      updatePlatformAccessories: vi.fn(),
      platformAccessory: vi.fn(function(this: PlatformAccessory, _name: string, uuid: string) {

        return {

          UUID: uuid,
          _associatedHAPAccessory: { displayName: "Test Accessory" },
          addService: vi.fn(),
          configureController: vi.fn(),
          context: {},
          displayName: "Test Accessory",
          getService: vi.fn(),
          getServiceById: vi.fn(),
          removeController: vi.fn(),
          removeService: vi.fn(),
          services: []
        } as unknown as PlatformAccessory;
      })
    },
    codecSupport: {

      probe: vi.fn(async () => true),
      hostSystem: "linux",
      hasEncoder: vi.fn(() => false),
      ffmpegVersion: "7.0",
      cpuGeneration: 0
    },
    config: {

      controllers: [],
      debugAll: false,
      options: [],
      ringDelay: 0,
      verboseFfmpeg: false,
      videoProcessor: process.execPath
    },
    debug: vi.fn(),
    featureOptions: {

      test: vi.fn(() => false),
      getFloat: vi.fn(() => undefined),
      getInteger: vi.fn(() => undefined),
      getString: vi.fn(() => undefined),
      value: vi.fn(() => undefined),
      scope: vi.fn(() => "global")
    },
    log: log,
    rtpPorts: {

      reserve: vi.fn(() => 50000),
      cancel: vi.fn()
    },
    verboseFfmpeg: false,
    ...overrides
  } as unknown as ProtectPlatform;
}

export function createMockNvr(overrides: Record<string, unknown> & { featureTest?: (name: string) => boolean } = {}): ProtectNvr {

  const overrideRecord = overrides as Partial<ProtectNvr> & { featureTest?: (name: string) => boolean };
  const platform = overrideRecord.platform ?? createMockPlatform();
  const featureTest = overrideRecord.featureTest ?? ((): boolean => false);
  const eventHandlers = new Map<string, ((packet: unknown) => void)[]>();

  const mqtt = {

    publish: vi.fn(),
    subscribeGet: vi.fn(),
    subscribeSet: vi.fn(),
    unsubscribe: vi.fn()
  };

  const nvr = {

    platform: platform,
    config: {

      address: "192.168.1.1",
      username: "admin",
      password: "password",
      mqttTopic: "unifi/protect"
    },
    configuredDevices: new Map(),
    events: {

      on: vi.fn((event: string, handler: (packet: unknown) => void) => {

        const list = eventHandlers.get(event) ?? [];

        list.push(handler);
        eventHandlers.set(event, list);
      }),
      off: vi.fn((event: string, handler: (packet: unknown) => void) => {

        const list = eventHandlers.get(event) ?? [];
        const index = list.indexOf(handler);

        if(index >= 0) {

          list.splice(index, 1);
        }
      }),
      emit: vi.fn((event: string, packet: unknown) => {

        for(const handler of eventHandlers.get(event) ?? []) {

          handler(packet);
        }
      }),
      motionEventHandler: vi.fn(),
      doorbellEventHandler: vi.fn()
    },
    log: platform.log,
    logFeature: vi.fn(),
    logApiErrors: true,
    hasFeature: vi.fn(() => false),
    mqtt: mqtt,
    getDeviceById: vi.fn(() => undefined),
    ufp: {

      mac: "AA:BB:CC:DD:EE:01",
      id: "nvr-id",
      host: "192.168.1.1",
      name: "Test NVR",
      ports: { rtsp: 7447, rtsps: 7441 },
      doorbellSettings: { defaultMessageResetTimeoutMs: 60000 }
    },
    ufpApi: {

      name: "Test NVR",
      bootstrap: { liveviews: [], ringtones: [], cameras: [], sensors: [], lights: [], chimes: [], viewers: [] },
      isThrottled: false,
      updateDevice: vi.fn(async (device: { mac: string }, update: object) => ({ ...device, ...update })),
      retrieve: vi.fn(async () => ({ statusCode: 200 })),
      getApiEndpoint: vi.fn((modelKey: string) => "/api/" + modelKey),
      getDeviceName: vi.fn((device: { name?: string; marketName?: string }) => device.name ?? device.marketName ?? "Unknown Device"),
      responseOk: vi.fn((code?: number) => code === 200),
      enableRtsp: vi.fn(async (device: object) => device),
      getBootstrap: vi.fn(async () => ({})),
      login: vi.fn(async () => true),
      createLivestream: vi.fn(() => {

        const { EventEmitter } = require("node:events");

        return new EventEmitter();
      })
    },
    ...overrideRecord
  } as unknown as ProtectNvr;

  (platform.featureOptions as { test: (name: string) => boolean }).test = vi.fn(featureTest);

  return nvr;
}

export function createMockCameraConfig(overrides: object = {}): ProtectCameraConfig {

  return {

    accessDeviceMetadata: { featureFlags: { supportUnlock: false } },
    channels: [
      { fps: 30, height: 1080, id: 0, isRtspEnabled: true, name: "High", rtspAlias: "high", width: 1920 },
      { fps: 24, height: 720, id: 1, isRtspEnabled: true, name: "Medium", rtspAlias: "medium", width: 1280 },
      { fps: 15, height: 360, id: 2, isRtspEnabled: true, name: "Low", rtspAlias: "low", width: 640 },
      { fps: 15, height: 1200, id: 3, isRtspEnabled: true, name: "Package Camera", rtspAlias: "pkg", width: 1600 }
    ],
    chimeDuration: 0,
    connectionHost: "192.168.1.1",
    enableNfc: false,
    featureFlags: {
      hasChime: true,
      hasFingerprintSensor: false,
      hasInfrared: true,
      hasLcdScreen: true,
      hasLedStatus: true,
      hasLuxCheck: true,
      hasPackageCamera: true,
      hasSmartDetect: true,
      hasSpeaker: true,
      hasTamperDetection: true,
      isDoorbell: false,
      smartDetectAudioTypes: [],
      smartDetectTypes: [ "person", "vehicle", "licensePlate" ]
    },
    hardwareRevision: "1",
    id: "camera-1",
    isAdoptedByAccessApp: false,
    isConnected: true,
    isDark: true,
    isPairedWithAiPort: false,
    isThirdPartyCamera: false,
    ispSettings: {
      icrCustomValue: 5,
      irLedMode: "auto"
    },
    lastMotion: 0,
    lastRing: null,
    lcdMessage: null,
    ledSettings: { isEnabled: true },
    mac: "AA:BB:CC:DD:EE:10",
    marketName: "G5 Pro",
    modelKey: "cameras",
    name: "Front Door",
    recordingSettings: { mode: "detections" },
    smartDetectSettings: { enableTamperDetection: true },
    talkbackSettings: {},
    type: "camera",
    videoCodec: "h264",
    ...overrides
  } as unknown as ProtectCameraConfig;
}

export function createMockLightConfig(overrides: object = {}): ProtectLightConfig {

  return {

    mac: "AA:BB:CC:DD:EE:02",
    id: "light-1",
    name: "Porch Light",
    marketName: "Flood Light",
    type: "light",
    isConnected: true,
    isLightOn: false,
    lightDeviceSettings: { ledLevel: 3, isIndicatorEnabled: true },
    ...overrides
  } as ProtectLightConfig;
}

export function createMockChimeConfig(overrides: object = {}): ProtectChimeConfig {

  return {

    mac: "AA:BB:CC:DD:EE:03",
    id: "chime-1",
    name: "Door Chime",
    marketName: "UA Chime",
    type: "chime",
    modelKey: "chimes",
    isConnected: true,
    ringSettings: [ { ringtoneId: "tone-1", repeatTimes: 1, volume: 80 } ],
    ...overrides
  } as unknown as ProtectChimeConfig;
}

export function createMockSensorConfig(overrides: object = {}): ProtectSensorConfig {

  return {
    alarmSettings: { isEnabled: true },
    alarmTriggeredAt: null,
    batteryStatus: { isLow: false, percentage: 91 },
    id: "sensor-1",
    isConnected: true,
    isOpened: true,
    leakDetectedAt: null,
    leakSettings: { isExternalEnabled: true, isInternalEnabled: true },
    externalLeakDetectedAt: null,
    humiditySettings: { isEnabled: true },
    lightSettings: { isEnabled: true },
    mac: "AA:BB:CC:DD:EE:04",
    marketName: "UA Sensor",
    modelKey: "sensors",
    motionDetectedAt: null,
    motionSettings: { isEnabled: true },
    mountType: "door",
    name: "Entry Sensor",
    stats: {
      humidity: { value: 41 },
      light: { value: 200 },
      temperature: { value: 19.3 }
    },
    tamperingDetectedAt: null,
    temperatureSettings: { isEnabled: true },
    ledSettings: { isEnabled: true },
    ...overrides
  } as unknown as ProtectSensorConfig;
}

export function createMockViewerConfig(overrides: object = {}): ProtectViewerConfig {

  return {
    id: "viewer-1",
    isConnected: true,
    liveview: "lv1",
    mac: "AA:BB:CC:DD:EE:05",
    marketName: "Protect Viewer",
    modelKey: "viewers",
    name: "Viewer One",
    ...overrides
  } as unknown as ProtectViewerConfig;
}

export function pluginUtilsMockFactory(createService: typeof createMockService) {

  return {

    acquireService: vi.fn(() => createService()),
    validService: vi.fn(() => true),
    sanitizeName: (value: string): string => value,
    toStartCase: (value: string): string => value,
    sleep: vi.fn(async (): Promise<void> => undefined),
    retry: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => fn()),
    runWithTimeout: vi.fn(async <T>(promise: Promise<T>): Promise<T> => promise),
    formatBps: (bps: number): string => bps.toString() + " bps",
    isKeyframe: vi.fn(() => true),
    MqttClient: vi.fn(),
    RtpPortAllocator: vi.fn().mockImplementation(() => ({

      reserve: vi.fn(() => 50000),
      cancel: vi.fn()
    })),
    FeatureOptions: vi.fn().mockImplementation((_categories, _options, selected: string[]) => ({

      test: vi.fn((name: string) => selected.includes(name)),
      getFloat: vi.fn(() => undefined),
      getInteger: vi.fn(() => undefined),
      getString: vi.fn(() => undefined),
      value: vi.fn(() => undefined),
      scope: vi.fn(() => "global")
    })),
    FfmpegCodecs: vi.fn().mockImplementation(() => ({

      probe: vi.fn(async () => true),
      hostSystem: "linux",
      hasEncoder: vi.fn(() => false),
      ffmpegVersion: "7.0",
      cpuGeneration: 0
    })),
    FfmpegOptions: vi.fn().mockImplementation(() => ({

      hostSystemMaxPixels: 8294400,
      videoDecoder: vi.fn(() => []),
      audioDecoder: "aac",
      audioEncoder: vi.fn(() => []),
      streamEncoder: vi.fn(() => []),
      audioDecoderName: "aac"
    })),
    FfmpegStreamingProcess: vi.fn().mockImplementation((_delegate, _sessionId, _options, _args, _returnInfo, callback) => {

      const proc = {

        ffmpegProcess: { once: vi.fn(), stdin: { end: vi.fn() } },
        isStarted: false,
        stop: vi.fn(),
        stdin: { write: vi.fn(), end: vi.fn() }
      };

      setImmediate(() => callback(undefined));

      return proc;
    }),
    FfmpegLivestreamProcess: vi.fn().mockImplementation(function(this: { on: typeof vi.fn; removeAllListeners: typeof vi.fn; stop: typeof vi.fn }) {

      this.on = vi.fn();
      this.removeAllListeners = vi.fn();
      this.stop = vi.fn();

      return this;
    }),
    FfmpegExec: vi.fn().mockImplementation(() => ({

      exec: vi.fn(async () => Buffer.from("jpeg")),
      stop: vi.fn()
    })),
    FfmpegRecordingProcess: vi.fn().mockImplementation(() => ({

      isEnded: false,
      isTimedOut: false,
      segmentGenerator: vi.fn(async function*() {}),
      start: vi.fn(),
      stderrLog: [],
      stdin: { end: vi.fn(), write: vi.fn() },
      stop: vi.fn()
    })),
    BackpressureWriter: vi.fn().mockImplementation(() => ({

      write: vi.fn(),
      close: vi.fn()
    })),
    RtpDemuxer: vi.fn().mockImplementation(() => ({

      close: vi.fn()
    })),
    HKSV_FRAGMENT_LENGTH: 4000,
    HOMEKIT_IDR_INTERVAL: 2
  };
}

export function getServiceCharacteristicHandlers(service: MockService, name: string | WithUUID<unknown>): MockCharacteristic {

  const key = typeof name === "string" ? name : (name as { UUID?: string }).UUID ?? String(name);

  service.getCharacteristic(key);

  return service._characteristics.get(String(key))!;
}
