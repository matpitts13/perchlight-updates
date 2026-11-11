// Runs the end-to-end check against a running server.
//
//   cd perchlight-updates && npx wrangler dev --port 8799   (with ADMIN_TOKEN in .dev.vars)
//   cd e2e && npm install && PERCHLIGHT_UPDATES_URL=http://127.0.0.1:8799 PERCHLIGHT_UPDATES_TOKEN=... npm run check
//
// Uses a fresh channel name each run, so it can run against a server that
// already has releases. Installs nothing.

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electron from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "cli", "perchlight-updates.mjs");
const server = (process.env.PERCHLIGHT_UPDATES_URL ?? "").replace(/\/+$/, "");
if (!server || !process.env.PERCHLIGHT_UPDATES_TOKEN) {
  console.error("Set PERCHLIGHT_UPDATES_URL and PERCHLIGHT_UPDATES_TOKEN.");
  process.exit(1);
}
const channel = `e2e${Date.now().toString(36)}`;
const work = await mkdtemp(path.join(os.tmpdir(), "perchlight-e2e-"));

function cliRun(...args) {
  const r = spawnSync(process.execPath, [cli, ...args, "--channel", channel], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`cli ${args.join(" ")} failed:\n${r.stdout}${r.stderr}`);
  return r.stdout;
}

/** A build folder for `version`: a fake installer and electron-builder's
 *  <channel>.yml feed for it. */
async function build(version) {
  const dir = path.join(work, version);
  await mkdir(dir, { recursive: true });
  const name = `E2E-${channel}-Setup-${version}.exe`;
  const data = randomBytes(2 * 1024 * 1024);
  const sha512 = createHash("sha512").update(data).digest("base64");
  await writeFile(path.join(dir, name), data);
  await writeFile(
    path.join(dir, `${channel}.yml`),
    `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${data.length}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`,
  );
  return dir;
}

let n = 0;
async function app(stagingId) {
  const userData = path.join(work, `user-${++n}`);
  await mkdir(userData, { recursive: true });
  // Editors built on Electron (VS Code) set ELECTRON_RUN_AS_NODE, which
  // would start Electron as plain Node.
  const { ELECTRON_RUN_AS_NODE: _ignored, ...inherited } = process.env;
  const r = spawnSync(electron, [here], {
    encoding: "utf8",
    env: {
      ...inherited,
      FEED_URL: server,
      E2E_USER_DATA: userData,
      E2E_CHANNEL: channel,
      ...(stagingId ? { STAGING_ID: stagingId } : {}),
    },
    timeout: 120_000,
  });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("E2E_RESULT "));
  if (!line) throw new Error(`the app printed no result:\n${r.stdout}\n${r.stderr}`);
  return JSON.parse(line.slice("E2E_RESULT ".length));
}

const results = [];
function expect(label, ok, detail) {
  results.push({ label, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      ${JSON.stringify(detail)}`}`);
}

try {
  cliRun("publish", await build("1.0.1"), "--public");
  let r = await app();
  expect("offers and downloads 1.0.1 (SHA-512 verified by electron-updater)", r.available && r.version === "1.0.1" && r.downloaded?.length === 1, r);

  cliRun("publish", await build("1.0.2"));
  cliRun("pull", "1.0.2");
  r = await app();
  expect("after pulling 1.0.2, offers 1.0.1 again", r.available && r.version === "1.0.1", r);

  cliRun("restore", "1.0.2");
  cliRun("rollout", "1.0.2", "50");
  r = await app("00000000-0000-4000-8000-0000ffffffff");
  expect("a client outside a 50% rollout isn't offered 1.0.2 (stays on its version)", r.available === false || r.version !== "1.0.2", r);
  r = await app("00000000-0000-4000-8000-000000000001");
  expect("a client inside a 50% rollout is offered 1.0.2", r.available && r.version === "1.0.2", r);
} finally {
  await rm(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed.` : `\nAll ${results.length} checks passed.`);
process.exitCode = failed ? 1 : 0;
