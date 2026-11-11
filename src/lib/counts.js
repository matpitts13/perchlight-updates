import { today } from "./http.js";

/** Counters run after the response is sent; a failed count never fails a download. */
export function countDownload(env, ctx, releaseId, fileName, source) {
  ctx.waitUntil(
    env.DB.prepare(
      `INSERT INTO downloads_daily (day, release_id, file_name, source, count) VALUES (?1, ?2, ?3, ?4, 1)
       ON CONFLICT (day, release_id, file_name, source) DO UPDATE SET count = count + 1`,
    )
      .bind(today(), releaseId, fileName, source)
      .run()
      .catch((err) => console.warn(`count download: ${err instanceof Error ? err.message : String(err)}`)),
  );
}

export function countCheck(env, ctx, channel, platform, source) {
  if (String(env.COUNT_CHECKS ?? "true").toLowerCase() !== "true") return;
  ctx.waitUntil(
    env.DB.prepare(
      `INSERT INTO checks_daily (day, channel, platform, source, count) VALUES (?1, ?2, ?3, ?4, 1)
       ON CONFLICT (day, channel, platform, source) DO UPDATE SET count = count + 1`,
    )
      .bind(today(), channel, platform, source)
      .run()
      .catch((err) => console.warn(`count check: ${err instanceof Error ? err.message : String(err)}`)),
  );
}
