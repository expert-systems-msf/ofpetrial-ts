import { describe, expect, it } from "vitest";
import { ExportError, GeometryError, OfpetrialError, ValidationError, plotKey } from "./types.js";

describe("plotKey", () => {
  it("joins stripId and plotId with a colon", () => {
    expect(plotKey(3, 5)).toBe("3:5");
  });

  it("supports strip/plot id 0", () => {
    expect(plotKey(0, 0)).toBe("0:0");
  });
});

describe("typed errors", () => {
  it("ValidationError is an OfpetrialError and an Error", () => {
    const error = new ValidationError("bad input");
    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(OfpetrialError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ValidationError");
    expect(error.message).toBe("bad input");
  });

  it("GeometryError is an OfpetrialError", () => {
    const error = new GeometryError("bad geometry");
    expect(error).toBeInstanceOf(GeometryError);
    expect(error).toBeInstanceOf(OfpetrialError);
    expect(error.name).toBe("GeometryError");
  });

  it("ExportError is an OfpetrialError", () => {
    const error = new ExportError("bad export");
    expect(error).toBeInstanceOf(ExportError);
    expect(error).toBeInstanceOf(OfpetrialError);
    expect(error.name).toBe("ExportError");
  });
});
