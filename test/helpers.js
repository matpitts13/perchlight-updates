import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index.js";

export const ORIGIN = "https://updates.test";
const TOKEN = "test-admin-token";

/** Sends a request through the Worker and waits for its background work. */
export async function call(path, init = {}, envOverrides = {}) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), { ...env, ...envOverrides }, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

/** Admin API call with the test token. body: object (JSON), string or bytes. */
export async function api(method, path, body, extraHeaders = {}) {
  const headers = { Authorization: `Bearer ${TOKEN}`, ...extraHeaders };
  let payload = body;
  if (body !== undefined && typeof body === "object" && !(body instanceof Uint8Array)) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  const res = await call(`/api/${path}`, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

export function bytes(n, seed = 1) {
  const b = new Uint8Array(n);
  let x = seed * 2654435761;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    b[i] = x >>> 24;
  }
  return b;
}

export async function sha512(b) {
  const buf = await crypto.subtle.digest("SHA-512", b);
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

/** An electron-builder style feed for the given files. */
export function electronFeed(version, files) {
  const lines = [`version: ${version}`, "files:"];
  for (const f of files) {
    lines.push(`  - url: ${f.name}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`);
  }
  lines.push(`path: ${files[0].name}`, `sha512: ${files[0].sha512}`, `releaseDate: '2026-11-10T12:00:00.000Z'`);
  return `${lines.join("\n")}\n`;
}

/** Uploads one file through the multipart API. */
export async function uploadFile(channel, version, name, content) {
  const start = await api("POST", `releases/${channel}/${encodeURIComponent(version)}/files`, {
    name,
    size: content.length,
    sha512: await sha512(content),
  });
  if (start.status >= 300) return start;
  if (start.data.done) return start;
  const { id, partSize, partCount, partsDone } = start.data.upload;
  for (let n = 1; n <= partCount; n++) {
    if (partsDone.includes(n)) continue;
    const part = content.slice((n - 1) * partSize, n * partSize);
    const res = await api("PUT", `uploads/${id}/parts/${n}`, part, { "Content-Length": String(part.length) });
    if (res.status !== 200) return res;
  }
  return api("POST", `uploads/${id}/complete`);
}

/**
 * Makes a complete Windows release: an installer, its blockmap and latest.yml.
 * Returns the installer's bytes and name.
 */
export async function makeRelease(channel, version, { publish = true, rollout, size = 1000, seed, force } = {}) {
  const name = `App-Setup-${version}.exe`;
  const content = bytes(size, seed ?? version.length + size);
  const hash = await sha512(content);
  await api("POST", "releases", { channel, version });
  const feed = electronFeed(version, [{ name, sha512: hash, size: content.length }]);
  await api("PUT", `releases/${channel}/${encodeURIComponent(version)}/feeds/latest.yml`, feed, { "Content-Type": "text/yaml" });
  await uploadFile(channel, version, name, content);
  await uploadFile(channel, version, `${name}.blockmap`, bytes(50, 9));
  let published;
  if (publish) {
    published = await api("POST", `releases/${channel}/${encodeURIComponent(version)}/publish`, {
      ...(rollout ? { rollout } : {}),
      ...(force ? { force } : {}),
    });
  }
  return { name, content, feed, published };
}

export async function resetAll() {
  await env.DB.batch(
    ["upload_parts", "uploads", "release_files", "feed_tokens", "downloads_daily", "checks_daily", "releases", "channels"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  let cursor;
  do {
    const listed = await env.FILES.list({ cursor, limit: 1000 });
    if (listed.objects.length) await env.FILES.delete(listed.objects.map((o) => o.key));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}
