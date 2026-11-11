// Reading and serving update feeds. Shared by the Worker and the CLI, so
// nothing here may use Worker-only or Node-only APIs.
//
// Electron: electron-builder writes latest.yml, latest-mac.yml,
// latest-linux.yml (and <channel>*.yml for other channels). They're small,
// regular YAML written by js-yaml: top-level "key: value" lines, a `files:`
// list of maps, and sometimes releaseNotes as a block or a list. Only the
// fields an updater needs are read; the file is served as built, apart from
// stagingPercentage.
//
// Tauri: latest.json, the format tauri-action writes:
// { version, notes, pub_date, platforms: { "<target>-<arch>": { signature, url } } }

const CHANNEL_RE = /^[a-z][a-z0-9]{0,31}$/;
const ELECTRON_FEED_RE = /^([a-z][a-z0-9]{0,31})((?:-mac|-linux(?:-[a-z0-9]+)?)?)\.yml$/;
const TAURI_FEED_RE = /^([a-z][a-z0-9]{0,31})\.json$/;
const FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+~-]{0,199}$/;

export function isChannel(s) {
  return typeof s === "string" && CHANNEL_RE.test(s);
}

/** A file name the server will store and serve: no slashes, no "..". */
export function isFileName(s) {
  return typeof s === "string" && FILE_NAME_RE.test(s) && !s.includes("..");
}

/**
 * What a feed file name means.
 * "latest-mac.yml" -> { type: "electron", channel: "latest", platform: "-mac" }
 * "latest.yml"     -> { type: "electron", channel: "latest", platform: "" }
 * "latest.json"    -> { type: "tauri", channel: "latest", platform: "tauri" }
 * anything else    -> null
 */
export function parseFeedName(name) {
  let m = ELECTRON_FEED_RE.exec(name);
  if (m) return { type: "electron", channel: m[1], platform: m[2] };
  m = TAURI_FEED_RE.exec(name);
  if (m) return { type: "tauri", channel: m[1], platform: "tauri" };
  return null;
}

/** The name a channel's feed is served under for a platform key. */
export function feedNameFor(channel, platform) {
  return platform === "tauri" ? `${channel}.json` : `${channel}${platform}.yml`;
}

function unquote(v) {
  const s = v.trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

function splitKeyValue(line) {
  const i = line.indexOf(":");
  if (i < 1) return null;
  const key = line.slice(0, i).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  const rest = line.slice(i + 1);
  if (rest !== "" && !rest.startsWith(" ")) return null;
  return [key, rest.trim()];
}

function scalar(key, raw) {
  const v = unquote(raw);
  if ((key === "size" || key === "blockMapSize") && /^\d+$/.test(v)) return Number(v);
  return v;
}

/** The last path segment of a feed URL: the file name it points at. */
export function fileNameFromUrl(url) {
  const noQuery = String(url).split(/[?#]/)[0];
  const last = noQuery.slice(noQuery.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/**
 * Parses an electron-builder feed. Throws an Error with a plain-language
 * message if it isn't one.
 * @returns {{ version: string, files: Array<{ url: string, name: string, sha512: string, size: number, blockMapSize?: number }>, path?: string, sha512?: string, releaseDate?: string }}
 */
export function parseElectronFeed(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("the feed file is empty");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out = { files: [] };
  let inFiles = false;
  let current = null;
  let skippingBlock = false;

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (line === "---" || line === "...") continue; // YAML document markers
    const indent = line.length - line.trimStart().length;

    if (indent === 0) {
      inFiles = false;
      skippingBlock = false;
      current = null;
      const kv = splitKeyValue(line);
      if (!kv) throw new Error(`unexpected line in feed: ${line.slice(0, 80)}`);
      const [key, value] = kv;
      if (key === "files" && value === "") {
        inFiles = true;
      } else if (value === "" || /^[|>][+-]?\d?[+-]?$/.test(value)) {
        skippingBlock = true; // e.g. releaseNotes: a block or a list we don't need
      } else {
        out[key] = scalar(key, value);
      }
      continue;
    }

    if (skippingBlock) continue;
    if (!inFiles) throw new Error(`unexpected indented line in feed: ${line.slice(0, 80)}`);

    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      current = {};
      out.files.push(current);
      const kv = splitKeyValue(trimmed.slice(2));
      if (!kv) throw new Error(`unexpected list item in feed: ${line.slice(0, 80)}`);
      current[kv[0]] = scalar(kv[0], kv[1]);
    } else {
      const kv = splitKeyValue(trimmed);
      if (!kv || !current) throw new Error(`unexpected line in feed files: ${line.slice(0, 80)}`);
      current[kv[0]] = scalar(kv[0], kv[1]);
    }
  }

  if (typeof out.version !== "string" || !out.version) throw new Error("the feed has no version");
  if (!out.files.length) throw new Error("the feed lists no files");
  for (const f of out.files) {
    if (typeof f.url !== "string" || !f.url) throw new Error("a file in the feed has no url");
    if (typeof f.sha512 !== "string" || !f.sha512) throw new Error(`${f.url}: no sha512 in the feed`);
    if (!Number.isSafeInteger(f.size) || f.size < 0) throw new Error(`${f.url}: no valid size in the feed`);
    f.name = fileNameFromUrl(f.url);
    if (!isFileName(f.name)) throw new Error(`${f.url}: not a file name this server can serve`);
  }
  return out;
}

/** Serves a feed with the rollout applied: electron-updater's own
 *  stagingPercentage field, present only below 100%. */
export function withRollout(text, rollout) {
  let body = text.replace(/\r\n?/g, "\n").replace(/^stagingPercentage:.*\n?/gm, "");
  if (!body.endsWith("\n")) body += "\n";
  if (rollout < 100) body += `stagingPercentage: ${rollout}\n`;
  return body;
}

/**
 * Parses a Tauri latest.json. Throws an Error with a plain-language message.
 * @returns {{ version: string, notes: string, pub_date: string, platforms: Record<string, { signature: string, url: string, name: string }> }}
 */
export function parseTauriFeed(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("latest.json is not valid JSON");
  }
  if (!data || typeof data !== "object") throw new Error("latest.json is not an object");
  const version = String(data.version ?? "").replace(/^v/, "");
  if (!version) throw new Error("latest.json has no version");
  if (!data.platforms || typeof data.platforms !== "object" || !Object.keys(data.platforms).length) {
    throw new Error("latest.json lists no platforms");
  }
  const platforms = {};
  for (const [key, p] of Object.entries(data.platforms)) {
    if (!/^[a-z0-9_]+(-[a-z0-9_]+){1,2}$/.test(key)) throw new Error(`latest.json: unexpected platform "${key}"`);
    if (!p || typeof p.signature !== "string" || !p.signature) throw new Error(`latest.json: ${key} has no signature`);
    if (typeof p.url !== "string" || !p.url) throw new Error(`latest.json: ${key} has no url`);
    const name = fileNameFromUrl(p.url);
    if (!isFileName(name)) throw new Error(`latest.json: ${key}: not a file name this server can serve`);
    platforms[key] = { signature: p.signature, url: p.url, name };
  }
  return {
    version,
    notes: typeof data.notes === "string" ? data.notes : "",
    pub_date: typeof data.pub_date === "string" ? data.pub_date : "",
    platforms,
  };
}

/** Every file a feed points at, by name. */
export function referencedFiles(feedName, text) {
  const meaning = parseFeedName(feedName);
  if (!meaning) throw new Error(`${feedName} is not a feed file name`);
  if (meaning.type === "electron") {
    const feed = parseElectronFeed(text);
    return { version: feed.version, files: feed.files.map((f) => ({ name: f.name, size: f.size, sha512: f.sha512 })) };
  }
  const feed = parseTauriFeed(text);
  return { version: feed.version, files: Object.values(feed.platforms).map((p) => ({ name: p.name })) };
}
