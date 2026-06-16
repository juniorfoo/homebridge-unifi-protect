import pluginInitializer from "../src/index.js";
import { PLATFORM_NAME, PLUGIN_NAME } from "../src/settings.js";
import { ProtectPlatform } from "../src/protect-platform.js";
import { describe, expect, it, vi } from "vitest";

describe("index default export", () => {

  it("registers the platform with Homebridge", () => {

    const api = {
      registerPlatform: vi.fn()
    };

    pluginInitializer(api as never);

    expect(api.registerPlatform).toHaveBeenCalledTimes(1);
    expect(api.registerPlatform).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, ProtectPlatform);
  });
});
