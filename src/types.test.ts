import { describe, expect, it } from "vitest";
import {
  ExportError,
  GeometryError,
  OfpetrialError,
  ValidationError,
  plotKey,
} from "./types.js";

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
    const err = new ValidationError("bad input");
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toBeInstanceOf(OfpetrialError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ValidationError");
    expect(err.message).toBe("bad input");
  });

  it("GeometryError is an OfpetrialError", () => {
    const err = new GeometryError("bad geometry");
    expect(err).toBeInstanceOf(GeometryError);
    expect(err).toBeInstanceOf(OfpetrialError);
    expect(err.name).toBe("GeometryError");
  });

  it("ExportError is an OfpetrialError", () => {
    const err = new ExportError("bad export");
    expect(err).toBeInstanceOf(ExportError);
    expect(err).toBeInstanceOf(OfpetrialError);
    expect(err.name).toBe("ExportError");
  });
});
