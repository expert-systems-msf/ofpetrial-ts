import { describe, expect, it } from "vitest";
import { OFPETRIAL_R_VERSION } from "./index.js";

describe("package", () => {
  it("pins the ofpetrial R reference version", () => {
    expect(OFPETRIAL_R_VERSION).toBe("0.1.3");
  });
});
