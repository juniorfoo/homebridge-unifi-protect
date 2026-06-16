import type { API, HAP } from "homebridge";
import type { ProtectNvr } from "../../src/protect-nvr.js";
import type { ProtectPlatform } from "../../src/protect-platform.js";

type UfpApi = ProtectNvr["ufpApi"];
type Bootstrap = NonNullable<UfpApi["bootstrap"]>;

/** Access protected/private members in unit tests without per-line suppressions. */
export function testInternals<T>(instance: object): T {

  return instance as T;
}

/** Writable bootstrap for tests (Protect API exposes bootstrap as read-only). */
export function setNvrBootstrap(nvr: { ufpApi: UfpApi }, bootstrap: UfpApi["bootstrap"] | object): void {

  testInternals<{ bootstrap: UfpApi["bootstrap"] }>(nvr.ufpApi).bootstrap = bootstrap as UfpApi["bootstrap"];
}

/** Non-null bootstrap for tests that mutate bootstrap fields. */
export function nvrBootstrap(nvr: { ufpApi: UfpApi }): Bootstrap {

  const api = testInternals<{ bootstrap: UfpApi["bootstrap"] }>(nvr.ufpApi);

  if(!api.bootstrap) {

    api.bootstrap = {
      cameras: [],
      chimes: [],
      lights: [],
      liveviews: [],
      ringtones: [],
      sensors: [],
      viewers: []
    } as unknown as Bootstrap;
  }

  return api.bootstrap as Bootstrap;
}

export function hapFromNvr(nvr: ProtectNvr): HAP {

  return nvr.platform.api.hap;
}

export function hapFromDevice(device: { nvr: ProtectNvr }): HAP {

  return hapFromNvr(device.nvr);
}

export function apiFromNvr(nvr: ProtectNvr): API {

  return nvr.platform.api;
}

export function mutableApi(nvr: ProtectNvr): Record<string, unknown> {

  return testInternals(nvr.platform.api);
}

export function mutablePlatformApi(platform: ProtectPlatform): Record<string, unknown> {

  return testInternals(platform.api);
}

export function mutableCodecSupport(platform: ProtectPlatform): Record<string, unknown> {

  return testInternals(platform.codecSupport);
}
