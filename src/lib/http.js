export function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

/** An admin API error: { ok: false, error }. */
export function fail(status, error) {
  return json({ ok: false, error }, status);
}

export function notFound() {
  return new Response("Not found\n", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
}

/** @param {unknown} s */
export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/** Reads a JSON body of at most maxBytes. Returns null if it isn't JSON. */
export async function readJson(request, maxBytes = 64 * 1024) {
  const len = Number(request.headers.get("Content-Length") ?? "0");
  if (len > maxBytes) return null;
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    const v = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}
