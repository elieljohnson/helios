// Rivian vehicle-command crypto.
//
// Rivian's `sendVehicleCommand` mutation is HMAC-signed: the cloud
// verifies that the caller possesses the private key of an enrolled
// "phone." This file encapsulates the four crypto primitives needed:
//
//   1. Generate a SECP256R1 (P-256) keypair.
//   2. Encode our public key to the wire format Rivian expects
//      (X9.62 uncompressed-point hex), and decode the same format
//      coming back (Rivian returns the *vehicle's* public key in this
//      form, used as the ECDH peer).
//   3. ECDH(ours, vehicle) → HKDF-SHA256 → 32-byte derived key.
//   4. HMAC-SHA256(derived_key, command || timestamp) → hex.
//
// Algorithm canonical reference:
//   https://rivian-api.kaedenb.org/app/controls/send-vehicle-command/
// Reference implementation we verified against:
//   https://github.com/bretterer/rivian-python-client (utils.py)
//
// All primitives use Node's built-in `node:crypto` — no new deps.

import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "node:crypto";

export type RivianKeyPair = {
  /** Uncompressed-point hex (X9.62 form, 65 bytes / 130 hex chars).
   *  This is the wire format Rivian's `enrollPhone` mutation accepts
   *  and the format Rivian returns for `vehicles[].vas.vehiclePublicKey`. */
  publicKeyHex: string;
  /** PEM-encoded PKCS8 private key. Helios-internal — Rivian never
   *  sees this. PEM rather than the base64-wrapped-PEM the Python ref
   *  client uses, since we don't need cross-implementation portability
   *  and Node's KeyObject API consumes PEM directly. */
  privateKeyPem: string;
};

/** Generate a fresh SECP256R1 keypair. Run once per Rivian account at
 *  enrollment time; the private key is retained in the DB and used to
 *  sign every subsequent command. */
export function generateKeyPair(): RivianKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    publicKeyHex: publicKeyToHex(publicKey),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }) as string,
  };
}

/** Encode a P-256 public key to X9.62 uncompressed-point hex.
 *
 *  The standard SPKI DER for prime256v1 is 91 bytes: a 26-byte envelope
 *  (algorithm OIDs + BIT STRING wrapper with one zero "unused bits"
 *  byte) followed by a 65-byte uncompressed point (`0x04 || X || Y`).
 *  We strip the envelope and return the point as hex. */
export function publicKeyToHex(publicKey: KeyObject): string {
  const der = publicKey.export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 65)).toString("hex");
}

/** Decode an X9.62 uncompressed-point hex string into a KeyObject.
 *  Used for the *vehicle's* public key, which Rivian returns in this
 *  form via `getUserInfo → vehicles[].vas.vehiclePublicKey`. */
export function publicKeyFromHex(hex: string): KeyObject {
  if (!/^04[0-9a-fA-F]{128}$/.test(hex)) {
    throw new Error(
      `Rivian public key: expected 130-hex-char uncompressed P-256 point, got ${hex.length} chars`,
    );
  }
  // Reconstruct SPKI: prime256v1 prefix (26 bytes) + raw 65-byte point.
  const SPKI_PREFIX = Buffer.from(
    "3059301306072a8648ce3d020106082a8648ce3d030107034200",
    "hex",
  );
  const der = Buffer.concat([SPKI_PREFIX, Buffer.from(hex, "hex")]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Decode our stored PEM private key. Helper exists so tests and
 *  signCommand() share the same parser. */
export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
}

/** Sign a Rivian vehicle command.
 *
 *      secret = HKDF-SHA256(
 *                 ikm  = ECDH(ourPrivate, vehiclePublic),
 *                 salt = empty,
 *                 info = empty,
 *                 len  = 32 bytes,
 *               )
 *      signature = HMAC-SHA256(secret, command || timestamp).hex
 *
 *  Empty salt + empty info matches the Python ref client's
 *  `HKDF(salt=None, info=b"")`; OpenSSL/Node treat zero-length salt as
 *  HashLen zeros per RFC 5869, which is what Python's `cryptography`
 *  library does for `salt=None`. */
export function signCommand(opts: {
  command: string;
  timestamp: string;
  vehiclePublicKeyHex: string;
  ourPrivateKeyPem: string;
}): string {
  const sharedSecret = diffieHellman({
    privateKey: privateKeyFromPem(opts.ourPrivateKeyPem),
    publicKey: publicKeyFromHex(opts.vehiclePublicKeyHex),
  });
  const derivedKey = Buffer.from(
    hkdfSync("sha256", sharedSecret, Buffer.alloc(0), Buffer.alloc(0), 32),
  );
  const message = Buffer.from(opts.command + opts.timestamp, "utf-8");
  return createHmac("sha256", derivedKey).update(message).digest("hex");
}
