#!/usr/bin/env node
// perchlight-updates command-line tool. Node 22+, no dependencies.
//
//   PERCHLIGHT_UPDATES_URL=https://downloads.example.com
//   PERCHLIGHT_UPDATES_TOKEN=<your ADMIN_TOKEN>
//   node cli/perchlight-updates.mjs publish dist --channel latest --rollout 10
//
// Run with no arguments for the full list of commands.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { parseFeedName, referencedFiles } from "../src/lib/feed.js";

const HELP = `perchlight-updates: publish and manage releases on your update server.

Set PERCHLIGHT_UPDATES_URL (your server, e.g. https://downloads.example.com)
and PERCHLIGHT_UPDATES_TOKEN (its ADMIN_TOKEN) first. --url overrides the URL.

  publish <folder>            Upload a build folder (feeds + the files they list,
                              plus blockmaps) and publish it.
      --channel <name>        default: latest
      --private | --public    required the first time you publish to a new channel
                              (other than latest)
      --rollout <1-100>       publish to this percentage of users (default 100)
      --draft                 upload only; publish later with "publish-draft"
      --notes <text>          release notes (or --notes-file <file>)
      --force                 publish even if it isn't newer than the live release
  publish-draft <version>     Publish an uploaded draft   [--channel] [--rollout] [--force]
  releases                    List releases               [--channel]
  show <version>              One release and its files   [--channel]
  rollout <version> <1-100>   Change the live release's rollout   [--channel]
  pull <version>              Take the live release down; the one before it goes live   [--channel]
  restore <version>           Put a pulled release back   [--channel]
  delete <version>            Delete a draft              [--channel]
  channels                    List channels
  channel <name>              Change a channel   [--private | --public] [--keep <n>]
  token create <label>        A private feed link for testers   --channel <name>
  token list                  List private feed links
  token revoke <id>           Switch a link off
  import                      Register the feed files already at the bucket root
                              (an older setup) as a live release   [--channel]
  stats                       Downloads and update checks   [--days 30]
`;

const OPTIONS = {
  url: { type: "string" },
  channel: { type: "string", default: "latest" },
  rollout: { type: "string" },
  draft: { type: "boolean", default: false },
  notes: { type: "string" },
  "notes-file": { type: "string" },
  force: { type: "boolean", default: false },
  private: { type: "boolean", default: false },
  public: { type: "boolean", default: false },
  keep: { type: "string" },
  days: { type: "string", default: "30" },
  parallel: { type: "string", default: "2" },
  help: { type: "boolean", short: "h", default: false },
};

class CliError extends Error {}

function config(values) {
  const url = (values.url ?? process.env.PERCHLIGHT_UPDATES_URL ?? "").replace(/\/+$/, "");
  const token = process.env.PERCHLIGHT_UPDATES_TOKEN ?? "";
  if (!/^https?:\/\//.test(url)) throw new CliError("Set PERCHLIGHT_UPDATES_URL (or --url) to your server, e.g. https://downloads.example.com");
  if (!token) throw new CliError("Set PERCHLIGHT_UPDATES_TOKEN to your server's ADMIN_TOKEN.");
  const { protocol, hostname } = new URL(url);
  if (protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    throw new CliError("Use https:// for your server, so the admin token isn't sent unencrypted (http:// works only for localhost).");
  }
  return { url, token };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Calls the admin API. Retries network errors and 5xx a few times. */
async function request(cfg, method, apiPath, body, { raw = false, attempts = 4 } = {}) {
  const headers = { Authorization: `Bearer ${cfg.token}` };
  let payload = body;
  if (body !== undefined && !raw) {
    payload = JSON.stringify(body);
    headers["Content-Type"] = "application/json";
  }
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${cfg.url}/api/${apiPath}`, { method, headers, body: payload });
    } catch (err) {
      if (attempt >= attempts) throw new CliError(`Can't reach ${cfg.url}: ${err instanceof Error ? err.message : String(err)}`);
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (res.status >= 500 && attempt < attempts) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: false, error: text.slice(0, 300) || `HTTP ${res.status}` };
    }
    return { status: res.status, data };
  }
}

function check({ status, data }, what) {
  if (status >= 200 && status < 300 && data.ok !== false) return data;
  const problems = Array.isArray(data.problems) ? `\n  - ${data.problems.join("\n  - ")}` : "";
  throw new CliError(`${what}: ${data.error ?? `HTTP ${status}`}${problems}`);
}

const rel = (channel, version) => `releases/${encodeURIComponent(channel)}/${encodeURIComponent(version)}`;

function sha512File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("base64")));
  });
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function uploadOne(cfg, channel, version, dir, name) {
  const file = path.join(dir, name);
  const { size } = await stat(file);
  const sha512 = await sha512File(file);
  const start = check(await request(cfg, "POST", `${rel(channel, version)}/files`, { name, size, sha512 }), name);
  if (start.done) {
    console.log(`  ${name}: ${start.reused ? "already stored (reused)" : "already uploaded"}`);
    return;
  }
  const { id, partSize, partCount, partsDone } = start.upload;
  const handle = await open(file, "r");
  try {
    for (let n = 1; n <= partCount; n++) {
      if (partsDone.includes(n)) continue;
      const length = n < partCount ? partSize : size - partSize * (partCount - 1);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, (n - 1) * partSize);
      check(await request(cfg, "PUT", `uploads/${id}/parts/${n}`, buf, { raw: true, attempts: 5 }), `${name} part ${n}`);
      if (partCount > 1) console.log(`  ${name}: part ${n}/${partCount}`);
    }
  } finally {
    await handle.close();
  }
  const completed = await request(cfg, "POST", `uploads/${id}/complete`);
  if (completed.status === 404) {
    // A retried "complete" whose first attempt worked: the upload is gone
    // because the file is stored. Asking again confirms it.
    const again = check(await request(cfg, "POST", `${rel(channel, version)}/files`, { name, size, sha512 }), name);
    if (!again.done) throw new CliError(`${name}: the upload was lost; run publish again to resume.`);
  } else {
    check(completed, name);
  }
  console.log(`  ${name}: uploaded (${mb(size)})`);
}

/** Picks the feed files in a build folder: one per platform, preferring the
 *  target channel's own name, then latest*. */
async function findFeeds(dir, channel) {
  const names = await readdir(dir);
  const byPlatform = new Map();
  for (const name of names) {
    const meaning = parseFeedName(name);
    if (!meaning) continue;
    const rank = meaning.channel === channel ? 2 : meaning.channel === "latest" ? 1 : 0;
    if (!rank) continue;
    const prev = byPlatform.get(meaning.platform);
    if (!prev || rank > prev.rank) byPlatform.set(meaning.platform, { name, rank });
  }
  return { names, feeds: [...byPlatform.values()].map((f) => f.name) };
}

async function publishFolder(cfg, values, dir) {
  if (!dir) throw new CliError("Which folder? e.g. publish dist");
  const channel = values.channel;
  const { names, feeds } = await findFeeds(dir, channel);
  if (!feeds.length) throw new CliError(`No feed files in ${dir} (latest.yml, latest-mac.yml, latest-linux.yml or latest.json).`);

  const texts = new Map();
  const files = new Set();
  let version;
  for (const feed of feeds) {
    const text = await readFile(path.join(dir, feed), "utf8");
    texts.set(feed, text);
    let ref;
    try {
      ref = referencedFiles(feed, text);
    } catch (err) {
      throw new CliError(`${feed}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (version && ref.version !== version) throw new CliError(`${feed} is for ${ref.version}, but another feed is for ${version}.`);
    version = ref.version;
    for (const f of ref.files) {
      files.add(f.name);
      if (names.includes(`${f.name}.blockmap`)) files.add(`${f.name}.blockmap`);
    }
  }
  const missing = [...files].filter((f) => !names.includes(f));
  if (missing.length) throw new CliError(`These files are listed in the feeds but aren't in ${dir}:\n  - ${missing.join("\n  - ")}`);

  if (values.rollout !== undefined) rolloutArg(values.rollout); // refuse a typo before uploading anything
  if (values.private && values.public) throw new CliError("Choose --private or --public, not both.");

  // A new channel other than "latest" must be chosen public or private on
  // purpose, so a playtest build is never published to everyone by mistake.
  const { channels } = check(await request(cfg, "GET", "channels"), "Checking the channel");
  const known = channels.find((c) => c.name === channel);
  if (!known && channel !== "latest" && !values.private && !values.public) {
    throw new CliError(`"${channel}" is a new channel. Add --private (only people with a private link can get it) or --public (anyone can).`);
  }
  if (values.private || values.public) {
    check(await request(cfg, "PUT", `channels/${encodeURIComponent(channel)}`, { private: values.private }), "Setting up the channel");
  }

  const notes = values["notes-file"] ? await readFile(values["notes-file"], "utf8") : values.notes;
  console.log(`Release ${version} on ${channel} (${(known?.private ?? values.private) ? "private" : "public"}): ${feeds.length} feed file(s), ${files.size} file(s).`);
  const created = check(await request(cfg, "POST", "releases", { channel, version, ...(notes !== undefined ? { notes } : {}) }), "Creating the release");
  if (created.existing) console.log("  (continuing an existing draft)");

  for (const [feed, text] of texts) {
    check(await request(cfg, "PUT", `${rel(channel, version)}/feeds/${encodeURIComponent(feed)}`, text, { raw: true }), feed);
    console.log(`  ${feed}: uploaded`);
  }

  const queue = [...files];
  const parallel = Math.max(1, Math.min(6, Number.parseInt(values.parallel, 10) || 2));
  await Promise.all(
    Array.from({ length: parallel }, async () => {
      while (queue.length) await uploadOne(cfg, channel, version, dir, queue.shift());
    }),
  );

  if (values.draft) {
    console.log(`Uploaded as a draft. Publish it with: publish-draft ${version} --channel ${channel}`);
    return;
  }
  await publishDraft(cfg, values, version);
}

/** A rollout percentage from the command line, refused unless it's 1-100. */
function rolloutArg(s) {
  if (!/^\d{1,3}$/.test(String(s)) || Number(s) < 1 || Number(s) > 100) {
    throw new CliError(`Rollout must be a whole number from 1 to 100 (got "${s}").`);
  }
  return Number(s);
}

async function publishDraft(cfg, values, version) {
  if (!version) throw new CliError("Which version?");
  const body = { force: values.force };
  if (values.rollout !== undefined) body.rollout = rolloutArg(values.rollout);
  const done = check(await request(cfg, "POST", `${rel(values.channel, version)}/publish`, body), "Publishing");
  const pct = done.release.rollout < 100 ? ` to ${done.release.rollout}% of users` : "";
  console.log(`Published ${version} on ${values.channel}${pct}.${done.replaced ? ` (Replaced ${done.replaced}.)` : ""}`);
}

function table(rows, columns) {
  if (!rows.length) return console.log("(none)");
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  console.log(columns.map((c, i) => c.padEnd(widths[i])).join("  "));
  for (const r of rows) console.log(columns.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join("  "));
}

async function main() {
  const { values, positionals } = parseArgs({ options: OPTIONS, allowPositionals: true });
  const [command, ...args] = positionals;
  if (!command || values.help) {
    console.log(HELP);
    return;
  }
  const cfg = config(values);
  const ch = values.channel;

  switch (command) {
    case "publish":
      return publishFolder(cfg, values, args[0]);
    case "publish-draft":
      return publishDraft(cfg, values, args[0]);
    case "releases": {
      const q = process.argv.some((a) => a === "--channel" || a.startsWith("--channel=")) ? `?channel=${encodeURIComponent(ch)}` : "";
      const { releases } = check(await request(cfg, "GET", `releases${q}`), "Listing releases");
      return table(releases, ["channel", "version", "state", "rollout", "publishedAt"]);
    }
    case "show": {
      const data = check(await request(cfg, "GET", rel(ch, args[0] ?? "")), "Showing the release");
      console.log(`${data.release.version} on ${data.release.channel}: ${data.release.state}, rollout ${data.release.rollout}%`);
      return table(data.files.map((f) => ({ ...f, size: mb(f.size) })), ["name", "kind", "platform", "size"]);
    }
    case "rollout": {
      const data = check(await request(cfg, "POST", `${rel(ch, args[0] ?? "")}/rollout`, { rollout: rolloutArg(args[1]) }), "Changing the rollout");
      return console.log(`${data.release.version} now goes to ${data.release.rollout}% of users.`);
    }
    case "pull": {
      const data = check(await request(cfg, "POST", `${rel(ch, args[0] ?? "")}/pull`), "Pulling");
      return console.log(`Pulled ${args[0]}. Live now: ${data.live ?? "nothing (no earlier release to fall back to)"}.`);
    }
    case "restore":
      check(await request(cfg, "POST", `${rel(ch, args[0] ?? "")}/restore`), "Restoring");
      return console.log(`${args[0]} is live again.`);
    case "delete":
      check(await request(cfg, "DELETE", rel(ch, args[0] ?? "")), "Deleting the draft");
      return console.log(`Deleted the draft ${args[0]}.`);
    case "channels": {
      const { channels } = check(await request(cfg, "GET", "channels"), "Listing channels");
      return table(channels, ["name", "live", "private", "keep"]);
    }
    case "channel": {
      if (!args[0]) throw new CliError("Which channel?");
      const body = {};
      if (values.private) body.private = true;
      if (values.public) body.private = false;
      if (values.keep !== undefined) body.keep = values.keep === "default" ? null : Number(values.keep);
      const { channel } = check(await request(cfg, "PUT", `channels/${encodeURIComponent(args[0])}`, body), "Changing the channel");
      return console.log(`${channel.name}: ${channel.private ? "private" : "public"}, keeps ${channel.keep ?? "the default number of"} releases.`);
    }
    case "token": {
      const [sub, arg] = args;
      if (sub === "create") {
        const data = check(await request(cfg, "POST", "tokens", { label: arg ?? "", channel: ch }), "Creating the link");
        console.log(`Private feed for "${arg}" (channel ${ch}). This is shown once:\n\n  ${data.feedUrl}\n`);
        return console.log("Point a test build's update URL here (publish.url in electron-builder), or share its download links.");
      }
      if (sub === "list") {
        const { tokens } = check(await request(cfg, "GET", "tokens"), "Listing links");
        return table(tokens, ["id", "label", "channel", "active", "created_at"]);
      }
      if (sub === "revoke") {
        check(await request(cfg, "DELETE", `tokens/${encodeURIComponent(arg ?? "")}`), "Revoking");
        return console.log(`Link ${arg} is switched off.`);
      }
      throw new CliError("token create <label> | token list | token revoke <id>");
    }
    case "import": {
      const data = check(await request(cfg, "POST", "import", { channel: ch }), "Importing");
      return console.log(`Imported ${data.release.version} on ${ch}: ${data.feeds} feed file(s), ${data.files} file(s). It's live.`);
    }
    case "stats": {
      const days = Math.max(1, Number.parseInt(values.days, 10) || 30);
      const from = new Date(Date.now() - (days - 1) * 864e5).toISOString().slice(0, 10);
      const data = check(await request(cfg, "GET", `stats?from=${from}`), "Getting stats");
      const downloads = new Map();
      for (const d of data.downloads) {
        const k = `${d.version ?? "(unmanaged)"}  ${d.file_name}  ${d.source}`;
        downloads.set(k, (downloads.get(k) ?? 0) + d.count);
      }
      const checks = data.checks.reduce((n, c) => n + c.count, 0);
      console.log(`Since ${data.from}: ${checks} update checks.`);
      return table([...downloads].map(([k, count]) => ({ "version  file  source": k, downloads: count })), ["version  file  source", "downloads"]);
    }
    default:
      throw new CliError(`Unknown command "${command}". Run with no arguments for help.`);
  }
}

main().catch((err) => {
  console.error(err instanceof CliError ? `Error: ${err.message}` : err);
  process.exitCode = 1;
});
