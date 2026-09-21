import { beforeEach, describe, expect, it } from "vitest";
import { open, seal } from "../src/lib/secretBox.js";

const VALID_KEY = "a".repeat(64);

describe("secretBox", () => {
  beforeEach(() => {
    process.env.SECRET_BOX_KEY = VALID_KEY;
  });

  it("round-trips a plaintext through seal/open", () => {
    const sealed = seal("refresh-token-xyz");
    expect(open(sealed)).toBe("refresh-token-xyz");
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = seal("same plaintext");
    const b = seal("same plaintext");
    expect(a).not.toBe(b);
  });

  it("throws when a sealed string has been tampered with", () => {
    const sealed = seal("refresh-token-xyz");
    const [iv, tag, body] = sealed.split(".");
    const tamperedBody = Buffer.from(body, "base64url");
    tamperedBody[0] ^= 0xff;
    const tampered = [iv, tag, tamperedBody.toString("base64url")].join(".");
    expect(() => open(tampered)).toThrow();
  });

  it("throws naming SECRET_BOX_KEY when the key is missing", () => {
    delete process.env.SECRET_BOX_KEY;
    expect(() => seal("x")).toThrow(/SECRET_BOX_KEY/);
  });

  it("throws naming SECRET_BOX_KEY when the key is malformed", () => {
    process.env.SECRET_BOX_KEY = "not-hex";
    expect(() => seal("x")).toThrow(/SECRET_BOX_KEY/);
  });
});
