// K-1762, K-832: AES-GCM 256 under a key that HKDF-SHA-256 derives from a Worker secret, one `info` per use.

const text = new TextEncoder();

/** An AES-GCM key from a Worker secret; `info` keeps the keys of two uses apart. */
export async function aesKey(secret: string, info: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", text.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: text.encode(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** A new random 12-byte IV and the ciphertext of `plain`, bound to `data`, which the open must give again. */
export async function seal(
  key: CryptoKey,
  plain: string,
  data: string,
): Promise<{ readonly iv: Uint8Array; readonly sealed: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: text.encode(data) },
    key,
    text.encode(plain),
  );
  return { iv, sealed: new Uint8Array(sealed) };
}

/** The plain text of a seal; it throws when the key, the IV or the bound data differ. */
export async function open(
  key: CryptoKey,
  box: { readonly iv: Uint8Array; readonly sealed: Uint8Array },
  data: string,
) {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: box.iv, additionalData: text.encode(data) },
    key,
    box.sealed,
  );
  return new TextDecoder().decode(plain);
}
