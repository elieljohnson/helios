import { describe, expect, it } from "vitest";
import {
  generateKeyPair,
  publicKeyFromHex,
  publicKeyToHex,
  privateKeyFromPem,
  signCommand,
} from "./crypto";

describe("rivian/crypto", () => {
  describe("generateKeyPair", () => {
    it("returns a 65-byte uncompressed P-256 point as 130 hex chars", () => {
      const { publicKeyHex } = generateKeyPair();
      expect(publicKeyHex).toMatch(/^04[0-9a-f]{128}$/);
      expect(publicKeyHex.length).toBe(130);
    });

    it("returns a parseable PKCS8 PEM private key", () => {
      const { privateKeyPem } = generateKeyPair();
      expect(privateKeyPem).toContain("-----BEGIN PRIVATE KEY-----");
      expect(privateKeyPem).toContain("-----END PRIVATE KEY-----");
      // Should not throw — parser is the same one signCommand uses.
      expect(() => privateKeyFromPem(privateKeyPem)).not.toThrow();
    });

    it("each call yields a different keypair", () => {
      const a = generateKeyPair();
      const b = generateKeyPair();
      expect(a.publicKeyHex).not.toBe(b.publicKeyHex);
      expect(a.privateKeyPem).not.toBe(b.privateKeyPem);
    });
  });

  describe("publicKey hex round-trip", () => {
    it("encode → decode → re-encode produces the same hex", () => {
      const { publicKeyHex } = generateKeyPair();
      const decoded = publicKeyFromHex(publicKeyHex);
      const reEncoded = publicKeyToHex(decoded);
      expect(reEncoded).toBe(publicKeyHex);
    });

    it("rejects malformed hex (wrong length)", () => {
      expect(() => publicKeyFromHex("04abc")).toThrow(/130-hex-char/);
    });

    it("rejects compressed-point hex (leading 02/03)", () => {
      const compressed = "02" + "ab".repeat(32);
      expect(() => publicKeyFromHex(compressed)).toThrow(/uncompressed/);
    });

    it("rejects non-hex characters", () => {
      const bad = "04" + "z".repeat(128);
      expect(() => publicKeyFromHex(bad)).toThrow();
    });
  });

  describe("signCommand", () => {
    // Two valid keypairs simulate "us" and "the vehicle." Generated at
    // test-load time so we don't need to hand-verify on-curveness of a
    // hardcoded hex string. Within a single test run both keypairs are
    // stable, which is what the determinism / sensitivity checks need.
    const us = generateKeyPair();
    const vehicle = generateKeyPair();
    const OUR_PRIVATE_KEY_PEM = us.privateKeyPem;
    const VEHICLE_PUBLIC_KEY_HEX = vehicle.publicKeyHex;

    it("produces a 64-char hex SHA-256 HMAC", () => {
      const sig = signCommand({
        command: "STOP_CHARGING",
        timestamp: "1714521600",
        vehiclePublicKeyHex: VEHICLE_PUBLIC_KEY_HEX,
        ourPrivateKeyPem: OUR_PRIVATE_KEY_PEM,
      });
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is deterministic for fixed inputs", () => {
      const args = {
        command: "STOP_CHARGING",
        timestamp: "1714521600",
        vehiclePublicKeyHex: VEHICLE_PUBLIC_KEY_HEX,
        ourPrivateKeyPem: OUR_PRIVATE_KEY_PEM,
      };
      expect(signCommand(args)).toBe(signCommand(args));
    });

    it("changes when the timestamp changes", () => {
      const base = {
        command: "STOP_CHARGING",
        vehiclePublicKeyHex: VEHICLE_PUBLIC_KEY_HEX,
        ourPrivateKeyPem: OUR_PRIVATE_KEY_PEM,
      };
      const a = signCommand({ ...base, timestamp: "1714521600" });
      const b = signCommand({ ...base, timestamp: "1714521601" });
      expect(a).not.toBe(b);
    });

    it("changes when the command changes", () => {
      const base = {
        timestamp: "1714521600",
        vehiclePublicKeyHex: VEHICLE_PUBLIC_KEY_HEX,
        ourPrivateKeyPem: OUR_PRIVATE_KEY_PEM,
      };
      const stop = signCommand({ ...base, command: "STOP_CHARGING" });
      const start = signCommand({ ...base, command: "START_CHARGING" });
      expect(stop).not.toBe(start);
    });

    it("changes when the vehicle public key changes (different ECDH peer)", () => {
      const base = {
        command: "STOP_CHARGING",
        timestamp: "1714521600",
        ourPrivateKeyPem: OUR_PRIVATE_KEY_PEM,
      };
      const sigA = signCommand({ ...base, vehiclePublicKeyHex: VEHICLE_PUBLIC_KEY_HEX });
      // Generate a different valid public key for comparison.
      const otherKp = generateKeyPair();
      const sigB = signCommand({ ...base, vehiclePublicKeyHex: otherKp.publicKeyHex });
      expect(sigA).not.toBe(sigB);
    });
  });
});
