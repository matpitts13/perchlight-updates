// Serving R2 objects: HEAD, conditional GET and single byte ranges.

const TYPES = {
  yml: "text/yaml; charset=utf-8",
  json: "application/json",
  exe: "application/vnd.microsoft.portable-executable",
  msi: "application/x-msi",
  dmg: "application/x-apple-diskimage",
  zip: "application/zip",
  gz: "application/gzip",
  deb: "application/vnd.debian.binary-package",
  rpm: "application/x-rpm",
  sig: "text/plain; charset=utf-8",
};

export function contentTypeFor(name) {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return TYPES[ext] ?? "application/octet-stream";
}

const IMMUTABLE = "public, max-age=31536000, immutable";

function baseHeaders(obj, name, cacheControl) {
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", contentTypeFor(name));
  headers.set("ETag", obj.httpEtag);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", cacheControl);
  return headers;
}

/** A single "bytes=a-b" / "bytes=a-" / "bytes=-n" range, or null. Several
 *  ranges at once aren't supported: those requests get the whole file. */
function singleRange(header) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  return { start: m[1] === "" ? null : Number(m[1]), end: m[2] === "" ? null : Number(m[2]) };
}

/**
 * Serves an R2 object. Returns null if it doesn't exist.
 * @returns {Promise<{ response: Response, fromStart: boolean } | null>}
 *   fromStart: a GET that sends the file from its first byte (what's counted
 *   as a download, so resumed and partial downloads aren't counted twice).
 */
export async function serveObject(request, env, key, name, cacheControl = IMMUTABLE) {
  if (request.method === "HEAD") {
    const obj = await env.FILES.head(key);
    if (!obj) return null;
    const headers = baseHeaders(obj, name, cacheControl);
    headers.set("Content-Length", String(obj.size));
    return { response: new Response(null, { status: 200, headers }), fromStart: false };
  }

  const wanted = singleRange(request.headers.get("Range"));
  let range;
  if (wanted) {
    const head = await env.FILES.head(key);
    if (!head) return null;
    const size = head.size;
    let start;
    let end;
    if (wanted.start === null) {
      start = Math.max(0, size - wanted.end);
      end = size - 1;
    } else {
      start = wanted.start;
      end = wanted.end === null ? size - 1 : Math.min(wanted.end, size - 1);
    }
    if (wanted.start !== null && wanted.end !== null && wanted.start > wanted.end) {
      // "bytes=5-2" is invalid: ignore the header and send the whole file.
    } else if (start >= size) {
      return {
        response: new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } }),
        fromStart: false,
      };
    } else {
      range = { offset: start, length: end - start + 1 };
    }
  }

  const obj = await env.FILES.get(key, { onlyIf: request.headers, ...(range ? { range } : {}) });
  if (!obj) return null;
  if (!("body" in obj) || !obj.body) {
    // A condition failed. If-None-Match / If-Modified-Since: not modified.
    // If-Match / If-Unmodified-Since: precondition failed.
    const h = request.headers;
    const status = h.has("If-Match") || h.has("If-Unmodified-Since") ? 412 : 304;
    const headers = baseHeaders(obj, name, cacheControl);
    return { response: new Response(null, { status, headers }), fromStart: false };
  }

  const headers = baseHeaders(obj, name, cacheControl);
  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`);
    headers.set("Content-Length", String(range.length));
    return { response: new Response(obj.body, { status: 206, headers }), fromStart: range.offset === 0 };
  }
  headers.set("Content-Length", String(obj.size));
  return { response: new Response(obj.body, { status: 200, headers }), fromStart: true };
}
