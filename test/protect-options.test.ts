import { featureOptionCategories, featureOptions } from "../src/protect-options.js";
import { describe, expect, it } from "vitest";

describe("protect-options definitions", () => {

  it("contains options for every declared category", () => {

    for(const category of featureOptionCategories) {

      expect(featureOptions[category.name]).toBeDefined();
      expect(Array.isArray(featureOptions[category.name])).toBe(true);
      expect(featureOptions[category.name].length).toBeGreaterThan(0);
    }
  });

  it("ensures each option entry has required structure", () => {

    for(const [categoryName, options] of Object.entries(featureOptions)) {

      expect(options.length).toBeGreaterThan(0);

      for(const option of options) {

        expect(typeof option.default).toBe("boolean");
        expect(typeof option.description).toBe("string");
        expect(option.description.length).toBeGreaterThan(0);
        expect(typeof option.name).toBe("string");
      }

      expect(featureOptionCategories.some(category => category.name === categoryName)).toBe(true);
    }
  });
});
