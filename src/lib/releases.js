// Release queries shared by the public routes, the admin API and the clean-up.

const RELEASE_COLUMNS = "id, channel, version, state, rollout, notes, created_at, published_at, pulled_at";

export function rowToRelease(row) {
  if (!row) return null;
  return {
    id: row.id,
    channel: row.channel,
    version: row.version,
    state: row.state,
    rollout: row.rollout,
    notes: row.notes,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    pulledAt: row.pulled_at,
  };
}

export async function channelRow(env, name) {
  return env.DB.prepare("SELECT name, private, keep FROM channels WHERE name = ?1").bind(name).first();
}

export async function liveRelease(env, channel) {
  const row = await env.DB.prepare(`SELECT ${RELEASE_COLUMNS} FROM releases WHERE channel = ?1 AND state = 'live'`)
    .bind(channel)
    .first();
  return rowToRelease(row);
}

export async function releaseByVersion(env, channel, version) {
  const row = await env.DB.prepare(`SELECT ${RELEASE_COLUMNS} FROM releases WHERE channel = ?1 AND version = ?2`)
    .bind(channel, version)
    .first();
  return rowToRelease(row);
}

export async function releaseFiles(env, releaseId) {
  const { results } = await env.DB.prepare(
    "SELECT name, kind, platform, r2_key, size, sha512 FROM release_files WHERE release_id = ?1 ORDER BY kind, name",
  )
    .bind(releaseId)
    .all();
  return results;
}

export async function feedFile(env, releaseId, platform) {
  return env.DB.prepare(
    "SELECT name, r2_key FROM release_files WHERE release_id = ?1 AND kind = 'feed' AND platform = ?2",
  )
    .bind(releaseId, platform)
    .first();
}

// D1 allows 100 bound parameters per query; stay well under it.
const CHUNK = 50;

function chunks(list) {
  const out = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

const marks = (n, from = 1) => Array.from({ length: n }, (_, i) => `?${i + from}`).join(", ");

/**
 * Deletes the R2 objects among `keys` that no release still uses, apart from
 * those in `excludeIds` (releases about to go away). A few queries per 50
 * keys, not one per key.
 */
async function deleteUnusedObjects(env, keys, excludeIds = []) {
  const unique = [...new Set(keys)];
  if (!unique.length) return 0;
  const exclude = excludeIds.length ? excludeIds : [-1];
  const inUse = new Set();
  for (const part of chunks(unique)) {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT rf.r2_key FROM release_files rf JOIN releases r ON r.id = rf.release_id
       WHERE rf.r2_key IN (${marks(part.length)}) AND r.state != 'expired'
         AND r.id NOT IN (${marks(exclude.length, part.length + 1)})`,
    )
      .bind(...part, ...exclude)
      .all();
    for (const r of results) inUse.add(r.r2_key);
  }
  const unused = unique.filter((k) => !inUse.has(k));
  for (let i = 0; i < unused.length; i += 1000) await env.FILES.delete(unused.slice(i, i + 1000));
  return unused.length;
}

/**
 * Keeps the newest `keep` releases of each channel (the live one first, then
 * by publish date) and deletes the files of the rest. Drafts aren't touched.
 * @returns {Promise<{ expired: number, deleted: number }>}
 */
export async function cleanUp(env, onlyChannel = null) {
  const defaultKeep = Math.max(1, Number.parseInt(env.KEEP_RELEASES ?? "3", 10) || 3);
  const { results: channels } = onlyChannel
    ? await env.DB.prepare("SELECT name, keep FROM channels WHERE name = ?1").bind(onlyChannel).all()
    : await env.DB.prepare("SELECT name, keep FROM channels").all();

  let expired = 0;
  let deleted = 0;
  for (const ch of channels) {
    const keep = ch.keep ?? defaultKeep;
    const { results } = await env.DB.prepare(
      `SELECT id FROM releases WHERE channel = ?1 AND state IN ('live', 'superseded', 'pulled')
       ORDER BY state = 'live' DESC, published_at DESC, id DESC`,
    )
      .bind(ch.name)
      .all();
    // At most 50 releases a run (the daily job picks up the rest), so a big
    // backlog can't run a single invocation out of its limits.
    const old = results.slice(keep).map((r) => r.id).slice(0, CHUNK);
    if (!old.length) continue;

    // Mark them expired first, then delete: if the deletes fail halfway,
    // the worst case is files left in the bucket, never a release that
    // looks restorable but whose files are gone.
    const { results: files } = await env.DB.prepare(
      `SELECT r2_key FROM release_files WHERE release_id IN (${marks(old.length)})`,
    )
      .bind(...old)
      .all();
    await env.DB.prepare(`UPDATE releases SET state = 'expired' WHERE id IN (${marks(old.length)})`).bind(...old).run();
    expired += old.length;
    deleted += await deleteUnusedObjects(env, files.map((f) => f.r2_key));
  }
  return { expired, deleted };
}

/** Aborts multipart uploads started more than a day ago. */
export async function abortStaleUploads(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, r2_key, r2_upload_id FROM uploads WHERE created_at < datetime('now', '-1 day')",
  ).all();
  for (const u of results) {
    try {
      await env.FILES.resumeMultipartUpload(u.r2_key, u.r2_upload_id).abort();
    } catch (err) {
      console.warn(`abort upload ${u.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await env.DB.prepare("DELETE FROM uploads WHERE id = ?1").bind(u.id).run();
  }
  return results.length;
}

/** Deletes a draft: its uploads, the files only it uses, and the row. */
export async function deleteDraft(env, release) {
  const { results: uploads } = await env.DB.prepare(
    "SELECT r2_key, r2_upload_id FROM uploads WHERE release_id = ?1",
  )
    .bind(release.id)
    .all();
  for (const u of uploads) {
    try {
      await env.FILES.resumeMultipartUpload(u.r2_key, u.r2_upload_id).abort();
    } catch {
      // already completed or aborted
    }
  }
  const files = await releaseFiles(env, release.id);
  const res = await env.DB.prepare("DELETE FROM releases WHERE id = ?1 AND state = 'draft'").bind(release.id).run();
  if (res.meta.changes) await deleteUnusedObjects(env, files.map((f) => f.r2_key));
}
