import { vi } from "vitest";
import { createMockService, pluginUtilsMockFactory } from "./helpers/mocks.js";

vi.mock("homebridge-plugin-utils", () => pluginUtilsMockFactory(createMockService));

vi.mock("ffmpeg-for-homebridge", () => ({

  default: process.execPath
}));
