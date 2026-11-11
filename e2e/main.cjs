// A minimal Electron app (version 1.0.0, from package.json) that asks the
// server for an update the way an installed app does, downloads it, lets
// electron-updater verify its SHA-512, prints the outcome as JSON, and quits.
// It never installs anything.
const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { autoUpdater } = require("electron-updater");

const url = process.env.FEED_URL;
const userData = process.env.E2E_USER_DATA;
app.setPath("userData", userData);

// electron-updater's staging id: the last 4 bytes decide who's inside a
// partial rollout. ffffffff = 100%, i.e. outside every partial rollout.
if (process.env.STAGING_ID) fs.writeFileSync(path.join(userData, ".updaterId"), process.env.STAGING_ID);

const configPath = path.join(userData, "app-update.yml");
fs.writeFileSync(configPath, `provider: generic\nurl: ${url}\nupdaterCacheDirName: perchlight-e2e-updater\n`);

autoUpdater.forceDevUpdateConfig = true;
// Each run uses its own channel, so the app asks for <channel>.yml.
if (process.env.E2E_CHANNEL) autoUpdater.channel = process.env.E2E_CHANNEL;
autoUpdater.updateConfigPath = configPath;
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;
autoUpdater.logger = null;

function finish(result) {
  process.stdout.write(`E2E_RESULT ${JSON.stringify(result)}\n`);
  app.exit(0);
}

app.whenReady().then(async () => {
  try {
    const check = await autoUpdater.checkForUpdates();
    const available = Boolean(check?.isUpdateAvailable);
    if (!available) return finish({ available: false, current: app.getVersion() });
    const files = await autoUpdater.downloadUpdate();
    finish({ available: true, version: check.updateInfo.version, downloaded: files.map((f) => path.basename(f)) });
  } catch (err) {
    finish({ error: err instanceof Error ? err.message : String(err) });
  }
});
