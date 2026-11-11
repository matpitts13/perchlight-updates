const enc = new TextEncoder();

export async function sha256Hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings (hashes both first, so lengths
 *  don't leak either). */
export async function safeEqual(a, b) {
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b))),
  ]);
  return crypto.subtle.timingSafeEqual(x, y);
}

/** A URL-safe random token: 32 bytes, base64url. */
export function randomToken(bytes = 32) {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 0-99, stable for a client id and release: who's inside a partial rollout. */
export async function rolloutBucket(clientId, releaseId) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(`${clientId}:${releaseId}`));
  return new DataView(buf).getUint32(0) % 100;
}
