// What installed apps and people downloading see. No auth.
//
// scope: { source: "public" } for the bare routes, or
//        { source: "token:<id>", channel } under /p/<token>/. Under a token,
//        the token's channel is served whatever channel name the app asks
//        for, so an unchanged build reading latest.yml gets the beta feed.

import { parseFeedName, isFileName, withRollout, parseTauriFeed } from "../lib/feed.js";
import { compareVersions, isVersion } from "../lib/semver.js";
import { channelRow, liveRelease, feedFile } from "../lib/releases.js";
import { serveObject } from "../lib/objects.js";
import { countCheck, countDownload } from "../lib/counts.js";
import { rolloutBucket, sha256Hex } from "../lib/crypto.js";
import { escapeHtml, json, notFound } from "../lib/http.js";

const truthy = (v, dflt) => String(v ?? dflt).toLowerCase() === "true";

/** The channel a request may read, or null if it may not. */
async function readableChannel(env, scope, asked) {
  if (scope.channel) return scope.channel;
  const ch = await channelRow(env, asked);
  if (!ch || ch.private) return null;
  return asked;
}

async function serveFeed(request, env, ctx, name, scope) {
  const meaning = parseFeedName(name);
  if (!meaning || meaning.type !== "electron") return null;

  const channel = await readableChannel(env, scope, meaning.channel);
  if (!channel) {
    // A channel this server has never had a release for: an older setup's
    // feed files at the bucket root, served as they are.
    if (!scope.channel && truthy(env.SERVE_UNMANAGED, "false") && !(await channelRow(env, meaning.channel))) {
      const served = await serveObject(request, env, name, name, "no-cache");
      return served?.response ?? notFound();
    }
    return notFound();
  }

  const release = await liveRelease(env, channel);
  if (!release) return notFound();
  const feed = await feedFile(env, release.id, meaning.platform);
  if (!feed) return notFound();
  const obj = await env.FILES.get(feed.r2_key);
  if (!obj) {
    console.error(`feed object missing: ${feed.r2_key}`);
    return notFound();
  }
  const body = withRollout(await obj.text(), release.rollout);
  if (request.method === "GET") countCheck(env, ctx, channel, meaning.platform, scope.source);
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "Content-Type": "text/yaml; charset=utf-8",
      "Cache-Control": "no-cache",
      "Content-Length": String(new TextEncoder().encode(body).length),
    },
  });
}

async function serveFile(request, env, ctx, name, scope) {
  if (!isFileName(name)) return notFound();
  const row = await env.DB.prepare(
    `SELECT rf.r2_key, rf.release_id FROM release_files rf
     JOIN releases r ON r.id = rf.release_id
     JOIN channels c ON c.name = r.channel
     WHERE rf.name = ?1 AND rf.kind = 'file'
       AND r.state IN ('live', 'superseded')
       AND (c.private = 0 OR r.channel = ?2)
     ORDER BY r.state = 'live' DESC, r.id DESC LIMIT 1`,
  )
    .bind(name, scope.channel ?? "")
    .first();

  let served;
  let releaseId = 0;
  // Files uploaded here live under files/ and a name always means one build,
  // so they're cached for good. Files at the bucket root (imported, or not
  // managed at all) may have been overwritten in place by an older setup.
  const ROOT_CACHE = "public, max-age=300";
  if (row) {
    served = await serveObject(request, env, row.r2_key, name, row.r2_key.includes("/") ? undefined : ROOT_CACHE);
    releaseId = row.release_id;
  } else if (!scope.channel && truthy(env.SERVE_UNMANAGED, "false")) {
    // Only objects no release manages: a managed one that didn't match above
    // is a draft's, a private channel's, a pulled or an expired release's.
    const managed = await env.DB.prepare("SELECT 1 FROM release_files WHERE r2_key = ?1 LIMIT 1").bind(name).first();
    if (!managed) served = await serveObject(request, env, name, name, ROOT_CACHE);
  }
  if (!served) return notFound();
  if (served.fromStart) countDownload(env, ctx, releaseId, name, scope.source);
  return served.response;
}

/** GET /tauri/<channel>/<target>/<arch>/<current_version> */
async function tauriUpdate(request, env, ctx, parts, scope, base) {
  if (parts.length !== 4) return notFound();
  const [asked, target, arch, current] = parts;
  if (!isVersion(current)) return json({ error: "current_version is not a version" }, 400);
  const channel = await readableChannel(env, scope, asked);
  if (!channel) return notFound();
  const platformKey = `${target}-${arch}`;
  countCheck(env, ctx, channel, `tauri:${platformKey}`, scope.source);

  const noUpdate = () => new Response(null, { status: 204, headers: { "Cache-Control": "no-cache" } });
  const release = await liveRelease(env, channel);
  if (!release) return noUpdate();
  const feed = await feedFile(env, release.id, "tauri");
  if (!feed) return noUpdate();
  const obj = await env.FILES.get(feed.r2_key);
  if (!obj) return noUpdate();
  const data = parseTauriFeed(await obj.text());
  const platform = data.platforms[platformKey];
  if (!platform || compareVersions(data.version, current) <= 0) return noUpdate();
  if (release.rollout < 100) {
    const clientId = request.headers.get("X-Client-Id");
    if (!clientId || (await rolloutBucket(clientId, release.id)) >= release.rollout) return noUpdate();
  }
  return json(
    {
      version: data.version,
      notes: release.notes || data.notes,
      pub_date: data.pub_date || release.publishedAt,
      url: `${base}/${encodeURIComponent(platform.name)}`,
      signature: platform.signature,
    },
    200,
    { "Cache-Control": "no-cache" },
  );
}

const PAGE_GROUPS = [
  ["Windows", /\.(exe|msi)$/i],
  ["macOS", /\.dmg$/i],
  ["Linux", /\.(AppImage|deb|rpm)$/i],
];

async function downloadsPage(env) {
  const appName = env.APP_NAME || "Downloads";
  const release = await liveRelease(env, "latest");
  const ch = release ? await channelRow(env, "latest") : null;
  let body;
  if (!release || ch?.private) {
    body = "<p>No release is available yet.</p>";
  } else {
    const { results } = await env.DB.prepare(
      "SELECT name, size FROM release_files WHERE release_id = ?1 AND kind = 'file' ORDER BY name",
    )
      .bind(release.id)
      .all();
    const sections = PAGE_GROUPS.map(([label, re]) => {
      const files = results.filter((f) => re.test(f.name) && !f.name.endsWith(".blockmap"));
      if (!files.length) return "";
      const items = files
        .map((f) => `<li><a href="/${encodeURIComponent(f.name)}">${escapeHtml(f.name)}</a> <span>${(f.size / 1048576).toFixed(1)} MB</span></li>`)
        .join("");
      return `<h2>${label}</h2><ul>${items}</ul>`;
    }).join("");
    body = `<p>Version ${escapeHtml(release.version)}</p>${sections || "<p>No installers in this release.</p>"}`;
  }
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(appName)}: downloads</title>
<style>:root{color-scheme:light dark}body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;line-height:1.5}
a{color:inherit}li{margin:.4rem 0}span{opacity:.6;font-size:.9em}</style>
<h1>${escapeHtml(appName)}</h1>${body}</html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" } });
}

/**
 * Handles everything that isn't the admin API.
 * @param {string[]} segments the decoded path after any /p/<token> prefix
 * @param {string} base the URL prefix files are served under (origin + /p/<token>)
 */
export async function handlePublic(request, env, ctx, segments, scope, base) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  if (segments.length === 0) {
    if (scope.channel || !truthy(env.DOWNLOADS_PAGE, "true")) return notFound();
    return downloadsPage(env);
  }
  if (segments[0] === "tauri") return tauriUpdate(request, env, ctx, segments.slice(1), scope, base);
  if (segments.length !== 1) return notFound();
  const name = segments[0];
  if (name.endsWith(".yml")) {
    const feed = await serveFeed(request, env, ctx, name, scope);
    if (feed) return feed;
  }
  return serveFile(request, env, ctx, name, scope);
}

/** /p/<token>/...: resolves the token, or 404 for an unknown or revoked one. */
export async function privateScope(env, token) {
  if (!token || token.length > 100) return null;
  const row = await env.DB.prepare("SELECT id, channel FROM feed_tokens WHERE token_hash = ?1 AND active = 1")
    .bind(await sha256Hex(token))
    .first();
  return row ? { source: `token:${row.id}`, channel: row.channel } : null;
}
