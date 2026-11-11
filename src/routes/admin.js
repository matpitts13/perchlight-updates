// The admin API: everything under /api/, behind Authorization: Bearer <ADMIN_TOKEN>.

import { isChannel, isFileName, parseFeedName, parseElectronFeed, parseTauriFeed, referencedFiles, feedNameFor } from "../lib/feed.js";
import { compareVersions, isVersion } from "../lib/semver.js";
import {
  channelRow,
  liveRelease,
  releaseByVersion,
  releaseFiles,
  rowToRelease,
  cleanUp,
  deleteDraft,
} from "../lib/releases.js";
import { contentTypeFor } from "../lib/objects.js";
import { randomToken, safeEqual, sha256Hex } from "../lib/crypto.js";
import { fail, json, readJson } from "../lib/http.js";

const MIB = 1024 * 1024;
const DEFAULT_PART_SIZE = 50 * MIB; // under Workers' 100 MB request body limit
const MAX_FILE_SIZE = 5 * 1024 * MIB; // R2's limit for one object
const MAX_FEED_SIZE = MIB;
const SHA512_B64 = /^[A-Za-z0-9+/]{86}==$/;

function partSize(env) {
  const n = Number.parseInt(env.PART_SIZE ?? "", 10);
  return Number.isSafeInteger(n) && n >= 5 * MIB && n <= 95 * MIB ? n : DEFAULT_PART_SIZE;
}

const partCount = (size, ps) => Math.max(1, Math.ceil(size / ps));

async function authorised(request, env) {
  const header = request.headers.get("Authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(header);
  return Boolean(m) && (await safeEqual(m[1], env.ADMIN_TOKEN));
}

async function ensureChannel(env, name) {
  await env.DB.prepare("INSERT OR IGNORE INTO channels (name) VALUES (?1)").bind(name).run();
}

async function draftOr409(env, channel, version) {
  const release = await releaseByVersion(env, channel, version);
  if (!release) return { error: fail(404, `No release ${version} on channel ${channel}.`) };
  if (release.state !== "draft") return { error: fail(409, `${version} on ${channel} is ${release.state}; only drafts can change.`) };
  return { release };
}

// ── Releases ────────────────────────────────────────────────────────────────

async function listReleases(request, env) {
  const channel = new URL(request.url).searchParams.get("channel");
  const stmt = channel
    ? env.DB.prepare("SELECT * FROM releases WHERE channel = ?1 ORDER BY id DESC LIMIT 200").bind(channel)
    : env.DB.prepare("SELECT * FROM releases ORDER BY id DESC LIMIT 200");
  const { results } = await stmt.all();
  return json({ ok: true, releases: results.map(rowToRelease) });
}

async function createRelease(request, env) {
  const body = await readJson(request);
  if (!body) return fail(400, "Send a JSON body.");
  const { channel, version } = body;
  const notes = typeof body.notes === "string" ? body.notes : "";
  if (!isChannel(channel)) return fail(400, "channel must be lowercase letters and digits, starting with a letter.");
  if (!isVersion(version)) return fail(400, "version must be a version like 1.2.3 or 1.2.3-beta.1.");
  if (notes.length > 10000) return fail(400, "notes are limited to 10,000 characters.");
  const before = await channelRow(env, channel);
  await ensureChannel(env, channel);
  const channelInfo = { channelCreated: !before, channelPrivate: before?.private === 1 };
  const existing = await releaseByVersion(env, channel, version);
  if (existing) {
    if (existing.state !== "draft") return fail(409, `${version} on ${channel} was already published (${existing.state}).`);
    if (body.notes !== undefined) {
      await env.DB.prepare("UPDATE releases SET notes = ?1 WHERE id = ?2").bind(notes, existing.id).run();
    }
    return json({ ok: true, existing: true, ...channelInfo, release: await releaseByVersion(env, channel, version) });
  }
  await env.DB.prepare("INSERT INTO releases (channel, version, notes) VALUES (?1, ?2, ?3)").bind(channel, version, notes).run();
  return json({ ok: true, ...channelInfo, release: await releaseByVersion(env, channel, version) }, 201);
}

async function getRelease(_request, env, { channel, version }) {
  const release = await releaseByVersion(env, channel, version);
  if (!release) return fail(404, `No release ${version} on channel ${channel}.`);
  const files = await releaseFiles(env, release.id);
  const { results: uploads } = await env.DB.prepare("SELECT id, name, size FROM uploads WHERE release_id = ?1")
    .bind(release.id)
    .all();
  return json({
    ok: true,
    release,
    files: files.map((f) => ({ name: f.name, kind: f.kind, platform: f.platform, size: f.size })),
    uploadsInProgress: uploads,
  });
}

async function removeRelease(_request, env, { channel, version }) {
  const { release, error } = await draftOr409(env, channel, version);
  if (error) return error;
  await deleteDraft(env, release);
  return json({ ok: true });
}

// ── Uploads ─────────────────────────────────────────────────────────────────

async function putFeed(request, env, { channel, version, name }) {
  const { release, error } = await draftOr409(env, channel, version);
  if (error) return error;
  const meaning = parseFeedName(name);
  if (!meaning) return fail(400, `${name} is not a feed file (latest.yml, latest-mac.yml, latest-linux.yml, latest.json, ...).`);
  const len = Number(request.headers.get("Content-Length") ?? "0");
  if (len > MAX_FEED_SIZE) return fail(413, "Feed files are limited to 1 MB.");
  const text = await request.text();
  if (text.length > MAX_FEED_SIZE) return fail(413, "Feed files are limited to 1 MB.");

  let feedVersion;
  try {
    feedVersion = meaning.type === "electron" ? parseElectronFeed(text).version : parseTauriFeed(text).version;
  } catch (err) {
    return fail(400, `${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (feedVersion !== version) return fail(400, `${name} is for version ${feedVersion}, not ${version}.`);

  const key = `feeds/${channel}/${version}/${feedNameFor("latest", meaning.platform)}`;
  await env.FILES.put(key, text, { httpMetadata: { contentType: contentTypeFor(name) } });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM release_files WHERE release_id = ?1 AND kind = 'feed' AND platform = ?2").bind(release.id, meaning.platform),
    env.DB.prepare(
      "INSERT INTO release_files (release_id, name, kind, platform, r2_key, size) VALUES (?1, ?2, 'feed', ?3, ?4, ?5)",
    ).bind(release.id, name, meaning.platform, key, new TextEncoder().encode(text).length),
  ]);
  return json({ ok: true, platform: meaning.platform });
}

async function startUpload(request, env, { channel, version }) {
  const { release, error } = await draftOr409(env, channel, version);
  if (error) return error;
  const body = await readJson(request);
  if (!body) return fail(400, "Send a JSON body.");
  const { name, size, sha512 } = body;
  if (!isFileName(name)) return fail(400, "name must be a plain file name (letters, digits, . _ + ~ -).");
  if (parseFeedName(name)) return fail(400, `${name} is a feed file; upload it with PUT .../feeds/${name}.`);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_SIZE) return fail(400, "size must be a whole number of bytes, at most 5 GiB.");
  if (typeof sha512 !== "string" || !SHA512_B64.test(sha512)) return fail(400, "sha512 must be the file's SHA-512, base64 encoded.");

  const mine = await env.DB.prepare("SELECT size, sha512 FROM release_files WHERE release_id = ?1 AND name = ?2")
    .bind(release.id, name)
    .first();
  if (mine) {
    if (mine.size === size && mine.sha512 === sha512) return json({ ok: true, done: true });
    return fail(409, `${name} was already uploaded to this draft with different contents. Delete the draft to start again.`);
  }

  // The same file in another release (a re-run, or the same build on two
  // channels): reuse it. A different file with the same name: refuse, since
  // names must identify one build.
  const other = await env.DB.prepare(
    `SELECT rf.r2_key, rf.size, rf.sha512 FROM release_files rf JOIN releases r ON r.id = rf.release_id
     WHERE rf.name = ?1 AND rf.kind = 'file' AND r.state != 'expired' LIMIT 1`,
  )
    .bind(name)
    .first();
  if (other) {
    if (other.size !== size || other.sha512 !== sha512) {
      return fail(409, `Another release already has a different file named ${name}. Give each build's files their own names (include the version).`);
    }
    await env.DB.prepare(
      "INSERT INTO release_files (release_id, name, kind, r2_key, size, sha512) VALUES (?1, ?2, 'file', ?3, ?4, ?5)",
    ).bind(release.id, name, other.r2_key, size, sha512).run();
    return json({ ok: true, done: true, reused: true });
  }

  const key = `files/${name}`;
  if (size === 0) {
    await env.FILES.put(key, new Uint8Array(0), { httpMetadata: { contentType: contentTypeFor(name) } });
    await env.DB.prepare(
      "INSERT INTO release_files (release_id, name, kind, r2_key, size, sha512) VALUES (?1, ?2, 'file', ?3, 0, ?4)",
    ).bind(release.id, name, key, sha512).run();
    return json({ ok: true, done: true });
  }

  const existing = await env.DB.prepare("SELECT id, size, sha512, part_size FROM uploads WHERE release_id = ?1 AND name = ?2")
    .bind(release.id, name)
    .first();
  if (existing && existing.size === size && existing.sha512 === sha512) {
    const { results } = await env.DB.prepare("SELECT part_number FROM upload_parts WHERE upload_id = ?1 ORDER BY part_number")
      .bind(existing.id)
      .all();
    return json({
      ok: true,
      upload: { id: existing.id, partSize: existing.part_size, partCount: partCount(size, existing.part_size), partsDone: results.map((r) => r.part_number) },
    });
  }
  if (existing) {
    const old = await uploadRow(env, existing.id);
    try {
      await env.FILES.resumeMultipartUpload(old.r2_key, old.r2_upload_id).abort();
    } catch {
      // already gone
    }
    await env.DB.prepare("DELETE FROM uploads WHERE id = ?1").bind(existing.id).run();
  }

  // Another draft uploading a different file with this name right now would
  // write the same R2 key.
  const racing = await env.DB.prepare(
    "SELECT 1 FROM uploads WHERE name = ?1 AND release_id != ?2 AND (size != ?3 OR sha512 != ?4) LIMIT 1",
  )
    .bind(name, release.id, size, sha512)
    .first();
  if (racing) return fail(409, `Another draft is uploading a different file named ${name}. Give each build's files their own names.`);

  const ps = partSize(env);
  const mpu = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: contentTypeFor(name) } });
  const id = randomToken(18);
  await env.DB.prepare(
    "INSERT INTO uploads (id, release_id, name, r2_key, r2_upload_id, size, sha512, part_size) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
  ).bind(id, release.id, name, key, mpu.uploadId, size, sha512, ps).run();
  return json({ ok: true, upload: { id, partSize: ps, partCount: partCount(size, ps), partsDone: [] } }, 201);
}

/** An upload row, with its release's state. */
async function uploadRow(env, id) {
  return env.DB.prepare(
    `SELECT u.id, u.release_id, u.name, u.r2_key, u.r2_upload_id, u.size, u.sha512, u.part_size, r.state AS release_state
     FROM uploads u JOIN releases r ON r.id = u.release_id WHERE u.id = ?1`,
  )
    .bind(id)
    .first();
}

async function putPart(request, env, { id, n }) {
  const upload = await uploadRow(env, id);
  if (!upload) return fail(404, "No such upload (it may have finished, or been abandoned for over a day).");
  if (upload.release_state !== "draft") return fail(409, "That release has been published; its files can't change.");
  const count = partCount(upload.size, upload.part_size);
  const number = Number(n);
  if (!Number.isInteger(number) || number < 1 || number > count) return fail(400, `Part numbers run from 1 to ${count}.`);
  const expected = number < count ? upload.part_size : upload.size - upload.part_size * (count - 1);
  const len = Number(request.headers.get("Content-Length") ?? "-1");
  if (len !== expected) return fail(400, `Part ${number} must be exactly ${expected} bytes (Content-Length ${len}).`);
  if (!request.body) return fail(400, "No body.");

  const part = await env.FILES.resumeMultipartUpload(upload.r2_key, upload.r2_upload_id).uploadPart(number, request.body);
  await env.DB.prepare("INSERT OR REPLACE INTO upload_parts (upload_id, part_number, etag) VALUES (?1, ?2, ?3)")
    .bind(id, number, part.etag)
    .run();
  return json({ ok: true, part: number });
}

async function completeUpload(_request, env, { id }) {
  const upload = await uploadRow(env, id);
  if (!upload) return fail(404, "No such upload (it may have finished already).");
  if (upload.release_state !== "draft") return fail(409, "That release has been published; its files can't change.");
  const count = partCount(upload.size, upload.part_size);
  const { results: parts } = await env.DB.prepare(
    "SELECT part_number, etag FROM upload_parts WHERE upload_id = ?1 ORDER BY part_number",
  )
    .bind(id)
    .all();
  const missing = [];
  for (let i = 1; i <= count; i++) if (!parts.some((p) => p.part_number === i)) missing.push(i);
  if (missing.length) return fail(400, `Parts still missing: ${missing.join(", ")}.`);

  const mpu = env.FILES.resumeMultipartUpload(upload.r2_key, upload.r2_upload_id);
  try {
    await mpu.complete(parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })));
  } catch (err) {
    // A retry after a "complete" that worked but whose reply was lost: R2
    // refuses to complete twice, but the object is there. Finish the rows.
    const there = await env.FILES.head(upload.r2_key);
    if (!there || there.size !== upload.size) throw err;
    console.warn(`complete ${upload.name}: R2 refused (${err instanceof Error ? err.message : String(err)}); the object is already stored, so finishing.`);
  }
  const head = await env.FILES.head(upload.r2_key);
  if (!head || head.size !== upload.size) {
    await env.FILES.delete(upload.r2_key);
    await env.DB.prepare("DELETE FROM uploads WHERE id = ?1").bind(id).run();
    return fail(400, `${upload.name}: stored ${head?.size ?? 0} bytes, expected ${upload.size}. Upload it again.`);
  }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO release_files (release_id, name, kind, r2_key, size, sha512) VALUES (?1, ?2, 'file', ?3, ?4, ?5)",
    ).bind(upload.release_id, upload.name, upload.r2_key, upload.size, upload.sha512),
    env.DB.prepare("DELETE FROM uploads WHERE id = ?1").bind(id),
  ]);
  return json({ ok: true });
}

// ── Publishing ──────────────────────────────────────────────────────────────

/** undefined -> the default; anything but a whole number 1-100 -> null (refused). */
function parseRollout(v, dflt = 100) {
  if (v === undefined) return dflt;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 100 ? v : null;
}

/** Everything wrong with a draft that would stop it being published. */
async function publishProblems(env, release) {
  const files = await releaseFiles(env, release.id);
  const feeds = files.filter((f) => f.kind === "feed");
  const byName = new Map(files.filter((f) => f.kind === "file").map((f) => [f.name, f]));
  if (!feeds.length) return ["No feed files uploaded (latest.yml, latest-mac.yml, latest-linux.yml or latest.json)."];
  const problems = [];
  for (const feed of feeds) {
    const obj = await env.FILES.get(feed.r2_key);
    if (!obj) {
      problems.push(`${feed.name}: missing from storage; upload it again.`);
      continue;
    }
    let ref;
    try {
      ref = referencedFiles(feed.name, await obj.text());
    } catch (err) {
      problems.push(`${feed.name}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const f of ref.files) {
      const got = byName.get(f.name);
      if (!got) problems.push(`${feed.name} points at ${f.name}, which hasn't been uploaded.`);
      else if (f.size !== undefined && got.size !== f.size) problems.push(`${f.name}: ${got.size} bytes uploaded, ${feed.name} says ${f.size}.`);
      else if (f.sha512 !== undefined && got.sha512 !== f.sha512) problems.push(`${f.name}: its SHA-512 doesn't match ${feed.name}.`);
    }
  }
  return problems;
}

async function publish(request, env, { channel, version }, ctx) {
  const { release, error } = await draftOr409(env, channel, version);
  if (error) return error;
  const body = (await readJson(request)) ?? {};
  const rollout = parseRollout(body.rollout);
  if (rollout === null) return fail(400, "rollout must be a whole number from 1 to 100.");

  const problems = await publishProblems(env, release);
  if (problems.length) return json({ ok: false, error: "This release can't be published yet.", problems }, 400);

  const live = await liveRelease(env, channel);
  if (live && compareVersions(version, live.version) <= 0 && body.force !== true) {
    return fail(409, `${version} isn't newer than the live ${live.version}. Send force: true to publish it anyway.`);
  }
  // One transaction, and each statement re-checks the state it expects, so
  // two publishes at once (a double click, a retried request) can't leave
  // the channel with no live release: the second changes nothing.
  const [, promoted] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE releases SET state = 'superseded' WHERE channel = ?1 AND state = 'live'
         AND EXISTS (SELECT 1 FROM releases WHERE id = ?2 AND state = 'draft')`,
    ).bind(channel, release.id),
    env.DB.prepare(
      "UPDATE releases SET state = 'live', rollout = ?1, published_at = datetime('now') WHERE id = ?2 AND state = 'draft'",
    ).bind(rollout, release.id),
  ]);
  if (!promoted.meta.changes) return fail(409, `${version} on ${channel} was published by another request just now.`);
  ctx.waitUntil(cleanUp(env, channel).catch((err) => console.error(`clean-up after publish: ${err instanceof Error ? err.stack : String(err)}`)));
  return json({ ok: true, release: await releaseByVersion(env, channel, version), replaced: live?.version ?? null });
}

async function setRollout(request, env, { channel, version }) {
  const release = await releaseByVersion(env, channel, version);
  if (!release) return fail(404, `No release ${version} on channel ${channel}.`);
  if (release.state !== "live") return fail(409, `Only the live release has a rollout; ${version} is ${release.state}.`);
  const body = (await readJson(request)) ?? {};
  const rollout = parseRollout(body.rollout, null);
  if (rollout === null) return fail(400, "rollout must be a whole number from 1 to 100.");
  await env.DB.prepare("UPDATE releases SET rollout = ?1 WHERE id = ?2").bind(rollout, release.id).run();
  return json({ ok: true, release: await releaseByVersion(env, channel, version) });
}

async function pull(_request, env, { channel, version }) {
  const release = await releaseByVersion(env, channel, version);
  if (!release) return fail(404, `No release ${version} on channel ${channel}.`);
  if (release.state !== "live") return fail(409, `Only the live release can be pulled; ${version} is ${release.state}.`);
  const [taken] = await env.DB.batch([
    env.DB.prepare("UPDATE releases SET state = 'pulled', pulled_at = datetime('now') WHERE id = ?1 AND state = 'live'").bind(release.id),
    env.DB.prepare(
      `UPDATE releases SET state = 'live' WHERE id = (
         SELECT id FROM releases WHERE channel = ?1 AND state = 'superseded'
         ORDER BY published_at DESC, id DESC LIMIT 1)
       AND NOT EXISTS (SELECT 1 FROM releases WHERE channel = ?1 AND state = 'live')`,
    ).bind(channel),
  ]);
  if (!taken.meta.changes) return fail(409, `${version} on ${channel} was changed by another request just now.`);
  const now = await liveRelease(env, channel);
  return json({ ok: true, live: now?.version ?? null });
}

async function restore(_request, env, { channel, version }) {
  const release = await releaseByVersion(env, channel, version);
  if (!release) return fail(404, `No release ${version} on channel ${channel}.`);
  if (release.state !== "pulled") return fail(409, `Only a pulled release can be restored; ${version} is ${release.state}.`);
  const [, restored] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE releases SET state = 'superseded' WHERE channel = ?1 AND state = 'live'
         AND EXISTS (SELECT 1 FROM releases WHERE id = ?2 AND state = 'pulled')`,
    ).bind(channel, release.id),
    env.DB.prepare("UPDATE releases SET state = 'live', pulled_at = NULL WHERE id = ?1 AND state = 'pulled'").bind(release.id),
  ]);
  if (!restored.meta.changes) return fail(409, `${version} on ${channel} was changed by another request just now.`);
  return json({ ok: true, live: version });
}

// ── Channels, tokens, stats ─────────────────────────────────────────────────

async function listChannels(_request, env) {
  const { results } = await env.DB.prepare(
    `SELECT c.name, c.private, c.keep, (SELECT version FROM releases r WHERE r.channel = c.name AND r.state = 'live') AS live
     FROM channels c ORDER BY c.name`,
  ).all();
  return json({ ok: true, channels: results.map((c) => ({ name: c.name, private: c.private === 1, keep: c.keep, live: c.live })) });
}

async function updateChannel(request, env, { channel }) {
  if (!isChannel(channel)) return fail(400, "channel must be lowercase letters and digits, starting with a letter.");
  const body = await readJson(request);
  if (!body) return fail(400, "Send a JSON body.");
  await ensureChannel(env, channel);
  if (body.private !== undefined) {
    if (typeof body.private !== "boolean") return fail(400, "private must be true or false.");
    await env.DB.prepare("UPDATE channels SET private = ?1 WHERE name = ?2").bind(body.private ? 1 : 0, channel).run();
  }
  if (body.keep !== undefined) {
    const keep = body.keep === null ? null : Number(body.keep);
    if (keep !== null && (!Number.isInteger(keep) || keep < 1 || keep > 100)) return fail(400, "keep must be 1 to 100, or null for the default.");
    await env.DB.prepare("UPDATE channels SET keep = ?1 WHERE name = ?2").bind(keep, channel).run();
  }
  const c = await channelRow(env, channel);
  return json({ ok: true, channel: { name: c.name, private: c.private === 1, keep: c.keep } });
}

async function listTokens(_request, env) {
  const { results } = await env.DB.prepare(
    "SELECT id, label, channel, active, created_at, revoked_at FROM feed_tokens ORDER BY id DESC",
  ).all();
  return json({ ok: true, tokens: results.map((t) => ({ ...t, active: t.active === 1 })) });
}

async function createToken(request, env) {
  const body = await readJson(request);
  if (!body) return fail(400, "Send a JSON body.");
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label || label.length > 100) return fail(400, "label is required (up to 100 characters), e.g. \"Playtest group A\".");
  if (!isChannel(body.channel)) return fail(400, "channel must be lowercase letters and digits, starting with a letter.");
  await ensureChannel(env, body.channel);
  const token = randomToken();
  const row = await env.DB.prepare("INSERT INTO feed_tokens (token_hash, label, channel) VALUES (?1, ?2, ?3) RETURNING id")
    .bind(await sha256Hex(token), label, body.channel)
    .first();
  const origin = new URL(request.url).origin;
  return json({ ok: true, id: row.id, token, feedUrl: `${origin}/p/${token}` }, 201);
}

async function revokeToken(_request, env, { id }) {
  if (!/^\d{1,15}$/.test(id)) return fail(404, "No active token with that id.");
  const res = await env.DB.prepare("UPDATE feed_tokens SET active = 0, revoked_at = datetime('now') WHERE id = ?1 AND active = 1")
    .bind(Number(id))
    .run();
  if (!res.meta.changes) return fail(404, "No active token with that id.");
  return json({ ok: true });
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

async function stats(request, env) {
  const q = new URL(request.url).searchParams;
  const to = DAY_RE.test(q.get("to") ?? "") ? q.get("to") : new Date().toISOString().slice(0, 10);
  const from = DAY_RE.test(q.get("from") ?? "") ? q.get("from") : new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const [downloads, checks] = await Promise.all([
    env.DB.prepare(
      `SELECT d.day, r.channel, r.version, d.file_name, d.source, d.count
       FROM downloads_daily d LEFT JOIN releases r ON r.id = d.release_id
       WHERE d.day BETWEEN ?1 AND ?2 ORDER BY d.day, d.file_name`,
    ).bind(from, to).all(),
    env.DB.prepare(
      "SELECT day, channel, platform, source, count FROM checks_daily WHERE day BETWEEN ?1 AND ?2 ORDER BY day, channel, platform",
    ).bind(from, to).all(),
  ]);
  return json({ ok: true, from, to, downloads: downloads.results, checks: checks.results });
}

// ── Import ──────────────────────────────────────────────────────────────────

/** Registers the feed files at the bucket root (an older setup) as a live
 *  release, so switching to this server loses nothing. */
async function importExisting(request, env) {
  const body = (await readJson(request)) ?? {};
  const channel = body.channel ?? "latest";
  if (!isChannel(channel)) return fail(400, "channel must be lowercase letters and digits, starting with a letter.");
  const already = await env.DB.prepare("SELECT 1 FROM releases WHERE channel = ?1 LIMIT 1").bind(channel).first();
  if (already) return fail(409, `Channel ${channel} already has releases; import only works on a new channel.`);

  const listed = await env.FILES.list({ prefix: channel, limit: 1000 });
  const feeds = [];
  for (const o of listed.objects) {
    const meaning = !o.key.includes("/") && parseFeedName(o.key);
    if (meaning && meaning.type === "electron" && meaning.channel === channel) feeds.push({ key: o.key, platform: meaning.platform });
  }
  if (!feeds.length) return fail(404, `No ${channel}*.yml files at the bucket root.`);

  const parsed = [];
  for (const f of feeds) {
    const obj = await env.FILES.get(f.key);
    try {
      parsed.push({ ...f, text: await obj.text(), feed: null });
      parsed.at(-1).feed = parseElectronFeed(parsed.at(-1).text);
    } catch (err) {
      return fail(400, `${f.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const versions = [...new Set(parsed.map((p) => p.feed.version))];
  if (versions.length !== 1) return fail(400, `The feed files are for different versions (${versions.join(", ")}). Fix them first.`);
  const version = versions[0];
  if (!isVersion(version)) return fail(400, `${version} is not a version.`);

  const problems = [];
  const files = new Map();
  for (const p of parsed) {
    for (const f of p.feed.files) {
      const head = await env.FILES.head(f.name);
      if (!head) problems.push(`${p.key} points at ${f.name}, which isn't in the bucket.`);
      else if (head.size !== f.size) problems.push(`${f.name}: ${head.size} bytes in the bucket, ${p.key} says ${f.size}.`);
      else files.set(f.name, { size: f.size, sha512: f.sha512 });
      const map = await env.FILES.head(`${f.name}.blockmap`);
      if (map) files.set(`${f.name}.blockmap`, { size: map.size, sha512: "" });
    }
  }
  if (problems.length) return json({ ok: false, error: "The existing files don't match their feeds.", problems }, 400);

  // The feed copies first (re-running overwrites them harmlessly), then the
  // release and every file row in one transaction: an import either fully
  // happens or doesn't happen at all.
  for (const p of parsed) {
    p.copyKey = `feeds/${channel}/${version}/${feedNameFor("latest", p.platform)}`;
    await env.FILES.put(p.copyKey, p.text, { httpMetadata: { contentType: contentTypeFor(p.key) } });
  }
  const releaseId = "(SELECT id FROM releases WHERE channel = ?1 AND version = ?2)";
  const statements = [
    env.DB.prepare("INSERT OR IGNORE INTO channels (name) VALUES (?1)").bind(channel),
    env.DB.prepare(
      "INSERT INTO releases (channel, version, state, published_at, notes) VALUES (?1, ?2, 'live', datetime('now'), 'Imported')",
    ).bind(channel, version),
  ];
  for (const p of parsed) {
    statements.push(
      env.DB.prepare(`INSERT INTO release_files (release_id, name, kind, platform, r2_key, size) VALUES (${releaseId}, ?3, 'feed', ?4, ?5, ?6)`)
        .bind(channel, version, p.key, p.platform, p.copyKey, new TextEncoder().encode(p.text).length),
    );
  }
  for (const [name, f] of files) {
    statements.push(
      env.DB.prepare(`INSERT INTO release_files (release_id, name, kind, r2_key, size, sha512) VALUES (${releaseId}, ?3, 'file', ?3, ?4, ?5)`)
        .bind(channel, version, name, f.size, f.sha512),
    );
  }
  await env.DB.batch(statements);
  return json({ ok: true, release: await releaseByVersion(env, channel, version), files: files.size, feeds: parsed.length });
}

// ── Router ──────────────────────────────────────────────────────────────────

const V = "([^/]+)";
const ROUTES = [
  ["GET", /^releases$/, [], listReleases],
  ["POST", /^releases$/, [], createRelease],
  ["GET", new RegExp(`^releases/${V}/${V}$`), ["channel", "version"], getRelease],
  ["DELETE", new RegExp(`^releases/${V}/${V}$`), ["channel", "version"], removeRelease],
  ["PUT", new RegExp(`^releases/${V}/${V}/feeds/${V}$`), ["channel", "version", "name"], putFeed],
  ["POST", new RegExp(`^releases/${V}/${V}/files$`), ["channel", "version"], startUpload],
  ["POST", new RegExp(`^releases/${V}/${V}/publish$`), ["channel", "version"], publish],
  ["POST", new RegExp(`^releases/${V}/${V}/rollout$`), ["channel", "version"], setRollout],
  ["POST", new RegExp(`^releases/${V}/${V}/pull$`), ["channel", "version"], pull],
  ["POST", new RegExp(`^releases/${V}/${V}/restore$`), ["channel", "version"], restore],
  ["PUT", new RegExp(`^uploads/${V}/parts/${V}$`), ["id", "n"], putPart],
  ["POST", new RegExp(`^uploads/${V}/complete$`), ["id"], completeUpload],
  ["GET", /^channels$/, [], listChannels],
  ["PUT", new RegExp(`^channels/${V}$`), ["channel"], updateChannel],
  ["GET", /^tokens$/, [], listTokens],
  ["POST", /^tokens$/, [], createToken],
  ["DELETE", new RegExp(`^tokens/${V}$`), ["id"], revokeToken],
  ["GET", /^stats$/, [], stats],
  ["POST", /^import$/, [], importExisting],
];

/** @param {string} rest the raw (still percent-encoded) path after /api/ */
export async function handleAdmin(request, env, ctx, rest) {
  if (!env.ADMIN_TOKEN) return fail(503, "ADMIN_TOKEN isn't set. Run: npx wrangler secret put ADMIN_TOKEN");
  if (String(env.ADMIN_TOKEN).length < 16) {
    return fail(503, "ADMIN_TOKEN is too short to be safe. Set one of at least 16 characters (e.g. openssl rand -hex 32).");
  }
  if (!(await authorised(request, env))) return fail(401, "Missing or wrong admin token.");

  const allowed = [];
  for (const [method, re, names, handler] of ROUTES) {
    const m = re.exec(rest);
    if (!m) continue;
    if (method !== request.method) {
      allowed.push(method);
      continue;
    }
    const params = {};
    try {
      names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1])));
    } catch {
      return fail(400, "Badly encoded path.");
    }
    return handler(request, env, params, ctx);
  }
  return allowed.length ? json({ ok: false, error: "Method not allowed" }, 405, { Allow: allowed.join(", ") }) : fail(404, "Not found");
}
