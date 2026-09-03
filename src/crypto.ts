const encoder = new TextEncoder();

export function randomToken(bits: number): string {
  const bytes = new Uint8Array(Math.ceil(bits / 8));
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function hmacKey(pepper: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export async function hashWithPepper(pepper: string, value: string): Promise<string> {
  const key = await hmacKey(pepper);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncode(new Uint8Array(signature));
}

export async function verifyWithPepper(pepper: string, value: string, expectedHash: string): Promise<boolean> {
  const actual = await hashWithPepper(pepper, value);
  return timingSafeEqual(actual, expectedHash);
}

export function timingSafeEqualStrings(a: string, b: string): boolean {
  return timingSafeEqual(a, b);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
