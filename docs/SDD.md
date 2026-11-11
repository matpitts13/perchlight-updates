# SDD: perchlight-updates

**Version:** 1.0
**Date:** 2026-11-10
**Status:** Active (v0.1 built)

## Summary

A free, self-hosted update server and download site for desktop apps, running on the developer's own Cloudflare account (Workers + R2 + D1). It serves installers and the auto-update feed that Electron (electron-builder / electron-updater) and Tauri apps already know how to read. It adds what plain file hosting can't do: release channels, gradual rollouts, pulling a bad release, private beta and playtest feeds, and download counts. It is for indie developers whose code is private (so GitHub Releases can't serve their users) and who don't want to pay an update-hosting service. Part of the Perchlight family; the first real user is Ravenburst.

## Requirements

### Must have

- **Drop-in for electron-builder's `generic` provider.** An app that today reads `https://downloads.example.com/latest.yml` keeps working with no change to the app. The same file names, the same paths, `latest.yml` / `latest-mac.yml` / `latest-linux.yml`.
- **Installers served from R2** with `Range` requests (electron-updater's differential downloads and resumable downloads need them), correct content types, and long cache headers. Feed files are never cached.
- **Releases with a lifecycle:** `draft` → `live` → `pulled`. Uploading never changes what users see; only publishing does.
- **Channels:** `latest` (stable) plus any others (`beta`, `alpha`), using electron-builder's own file names (`beta.yml`, `beta-mac.yml`, ...).
- **Gradual rollouts:** publish to a percentage of users and raise it later. Electron: electron-updater's built-in `stagingPercentage` field, injected when the feed is served. Tauri: decided server-side from the client's id.
- **Pull a release:** one command takes a release down; the feed points back at the previous live release at once. (Installed copies that already updated stay on it; this stops new updates, it doesn't uninstall.)
- **Private feeds** for beta testers and playtests: a feed at `/p/<token>/...` that serves a chosen channel. Each token has a label ("Steam playtest group"), can be switched off, and its downloads are counted on their own.
- **Download counts** per release, platform, file and day, plus update checks per day. No IP addresses or user ids are stored.
- **Uploading without R2 keys:** a small command-line tool (`publish`) uploads a build folder through the Worker's admin API in parts (each under Workers' 100 MB request limit), installers first and feed files last, then optionally publishes. CI needs one secret: the admin token.
- **Tauri updater endpoint:** `GET /tauri/<channel>/<target>/<arch>/<current_version>` returns Tauri's JSON (`version`, `url`, `signature`, `notes`, `pub_date`) or `204 No Content` when up to date. Signatures are the `.sig` files Tauri builds; the server never signs anything.
- **Keep storage inside the free tier:** keep the newest N releases' files per channel (default 3); older releases' files are deleted from R2 automatically after a newer one goes live. Pulled releases' files are kept until then, so a pull can be undone.
- **Admin API** with one bearer token: create release, upload parts, publish, set rollout, pull, un-pull, list releases and stats, create and revoke private-feed tokens.
- **Import an existing bucket:** a one-time command that registers what's already in an R2 bucket (for example Ravenburst's current files) as live releases, so switching over loses nothing.
- **Works with the Perchlight desktop app:** ships a Perchlight screen config (releases, rollouts, stats, private feeds) that reads and edits the same D1 tables.
- **Deploy to Cloudflare button**, tests, README, a v0.1.0 release.

### Should have (if time allows)

- A simple public downloads page (`/`) listing the latest version for each platform, with download buttons.
- A GitHub Actions example for electron-builder and one for Tauri.

### Out of scope (v0.1)

- macOS Squirrel/`RELEASES` feeds other than electron-updater's, Sparkle appcast (macOS native apps), MSIX/AppInstaller, Linux repositories (apt/rpm).
- Code signing. The server serves what it's given; signing stays in the developer's build.
- Licence-gated downloads (that's the separate license-keys tool).

## Technical design

### Pieces

```
CI / laptop ── publish CLI ──(admin API, parts ≤ 95 MB)──▶ Worker ──▶ R2 (files)
                                                            │   └──▶ D1 (releases, stats, tokens)
Installed apps ──(GET latest.yml, installers, Range)──────▶ Worker ──▶ R2
Perchlight desktop app ──(Cloudflare API)──────────────────▶ D1 (same tables)
```

- **Worker** (`src/`): public routes, the admin API, and a daily cron (storage clean-up, folding counters).
- **R2 binding** `FILES`: installers, blockmaps, signatures, and every release's own copy of its feed files. Uploads use R2 multipart uploads through the binding, so no S3 keys are needed anywhere.
- **D1 binding** `DB`: the source of truth for which release is live.
- **CLI** (`cli/publish.mjs`, plain Node 22, no dependencies): `publish`, `pull`, `rollout`, `import`, `token`.

### Storage layout (R2)

- `files/<file name>`: installers and their companions, named as the build named them. Every name already carries the version, so names don't collide across releases. **Ravenburst's current files at the bucket root stay where they are**; import records each file's actual key.
- `feeds/<channel>/<version>/<feed file>`: each release's own `latest*.yml` (or `beta*.yml`), exactly as built.
- The served `/latest.yml` is **not a stored file**. It's the live release's copy, with `stagingPercentage` added when a rollout is below 100%. So publish, rollout and pull are a single D1 update, never a file shuffle, and there's no moment when the feed points at a missing file.

### Data model (D1)

- `releases`: `id`, `channel`, `version`, `state` (`draft` | `live` | `superseded` | `pulled` | `expired`), `rollout` (1–100), `notes`, `created_at`, `published_at`, `pulled_at`. One `live` release per channel.
- `release_files`: `release_id`, `platform` (`win` | `mac` | `linux` | `tauri-<target>-<arch>`), `kind` (`installer` | `feed` | `blockmap` | `signature` | `other`), `name`, `r2_key`, `size`, `sha512`.
- `uploads`: in-progress multipart uploads (`upload_id`, `r2_key`, parts done), cleaned up after 24 hours.
- `feed_tokens`: `token_hash` (SHA-256; the token itself is shown once), `label`, `channel`, `active`, `created_at`.
- `downloads_daily`: `day`, `release_id`, `file_name`, `source` (`public` or a token id), `count`. `checks_daily`: `day`, `channel`, `platform`, `count`.

### Routes

Public (no auth):
- `GET|HEAD /<feed file>`: `latest.yml`, `latest-mac.yml`, `latest-linux.yml`, `<channel>.yml`, ... → the live release's feed, rollout applied, `Cache-Control: no-cache`. Counts a check.
- `GET|HEAD /<file name>`: an installer of a live (or still-kept) release, with `Range`, `ETag` and `Cache-Control: public, max-age=31536000, immutable`. Counts a download only on requests that start at byte 0, so resumed and differential downloads aren't over-counted.
- `GET /tauri/<channel>/<target>/<arch>/<current_version>` → JSON or 204. Rollout: the client sends its id in a header (documented); no header = treated as outside a partial rollout.
- `/p/<token>/...`: the same routes, for the token's channel, counted under that token.
- `GET /`: downloads page (should-have).

Admin (`Authorization: Bearer <ADMIN_TOKEN>`, constant-time compare):
- `POST /api/releases` (channel, version, notes) → draft
- `POST /api/releases/:id/files` (name, size, kind, platform) → upload id; `PUT /api/uploads/:id/parts/:n` (≤ 95 MB body); `POST /api/uploads/:id/complete` (checks size and SHA-512 against what the feed file says)
- `POST /api/releases/:id/publish` (rollout) · `POST /api/releases/:id/rollout` · `POST /api/releases/:id/pull` · `POST /api/releases/:id/restore`
- `GET /api/releases` · `GET /api/stats?from&to`
- `POST /api/tokens` (label, channel) → token shown once · `DELETE /api/tokens/:id`

### Publishing rules

- Publish refuses unless every file named in the release's feed files has been uploaded, with a matching size and SHA-512. That's the bug Ravenburst hit once (a feed pointing at a file that wasn't there yet); here it can't happen.
  - **Size** is checked against the object R2 actually stored.
  - **SHA-512** is computed by the CLI and compared with the feed's value. The Worker can't hash a 150 MB file inside the Free plan's 10 ms CPU limit, so this catches a wrong or stale file, not corruption in transit. electron-updater checks the SHA-512 again on the user's machine and refuses a file that doesn't match, so a damaged upload fails safe.
- Version must be higher than the channel's current live version (semver compare), unless `--force`.
- Publishing a new release changes the previous live one to `superseded`: no longer served in the feed, but its files are kept so a pull can fall back to it. The clean-up keeps the newest N per channel and marks older ones `expired` (files deleted). So `state` is `draft` | `live` | `superseded` | `pulled` | `expired`.

### Edge cases

- **An app checking during a publish:** the feed switches in one D1 statement; the files were uploaded earlier, so whatever the app reads is consistent.
- **Rollout and electron-updater:** electron-updater picks a stable random id per install and compares it with `stagingPercentage`; raising the percentage only ever adds users. Lowering it doesn't take the update back from users who already have it.
- **Pull while a download is in progress:** a pulled release's files stop being served at once (the build may be broken or unsafe), so that download fails and electron-updater tries again later against the fallback release. The files are kept in R2 so `restore` can bring them back. (Changed after review: v1.0 of this document kept them served.)
- **Two publishes at once** (a double click, a retried request): each state change is one D1 batch whose statements re-check the state they expect, so the second changes nothing and gets 409; a channel can never be left without a live release.
- **Big files:** parts of up to 95 MB, retried individually; a 2 GB installer is about 22 parts. R2's 5 GB per-upload limit applies.
- **Free plan:** an update check is one Worker request; the Free plan's 100,000 requests a day covers roughly that many daily checks. Serving a file streams from R2, so CPU time stays low. R2 egress is free; R2 storage is 10 GB free, which is why old releases are cleaned up.
- **Counting uses D1 writes,** and D1's free plan allows 100,000 rows written a day. Each counted download or check is one upsert. Counting update checks can be turned off (`COUNT_CHECKS`) for apps with many users.
- **Files the server doesn't manage** (for example Ravenburst's older installers at the bucket root) are served as-is when `SERVE_UNMANAGED` is on, so old blockmaps used by differential updates keep working. Clean-up never deletes them.
- **Tokens in URLs** can leak (shared screenshots, logs). They only give read access to one channel and can be switched off; the README says so.

### Ravenburst switch-over (after v0.1 is released)

1. Deploy perchlight-updates to a workers.dev address bound to Ravenburst's existing R2 bucket. Run `import`. Check that the served `latest*.yml` matches the current files byte for byte (apart from rollout).
2. Point an installed copy at the workers.dev address (a test build) and check it updates.
3. Add the Worker route for `downloads.ravenburst.com/*`. The bucket's public custom domain stays as a fallback until the Worker has run cleanly for a week, then is removed.
4. Change Ravenburst's `build.yml` publish job to use the CLI (one secret, the admin token) instead of `aws s3 cp`.

Each step is reversible by removing the route.

## Testing

- Unit and integration tests with `@cloudflare/vitest-plugin` (local R2 and D1): feed serving and rollout injection, Range requests, publish checks, pull and restore, Tauri responses, tokens, clean-up, import, counting.
- An end-to-end check, free and local: a tiny Electron app with electron-updater, pointed at `wrangler dev`, updates from 1.0.0 to 1.0.1, then a pulled 1.0.2 is not offered.
- **Not tested, because it costs money or needs things we don't have:** real code-signed macOS updates (needs an Apple developer account, $99/year), a real Tauri app (the JSON format is tested against Tauri's documentation, not a running app), and very large installs at Workers Paid scale.

## Open questions

- **R2 needs a payment method on file** to turn on, even though usage inside the free tier costs nothing. Ravenburst already has R2, so this doesn't block us, but the README must say it up front.
- Whether a Worker route takes priority over an R2 bucket's custom domain on the same hostname. To be checked in switch-over step 3 (it's free to check); if it doesn't, the custom domain is removed first, during a quiet hour.

## Acceptance criteria

- An electron-builder app with `publish: { provider: "generic", url }` updates through the Worker with no app changes.
- Publish is refused when a file is missing or its SHA-512 doesn't match.
- Pulling the live release makes the feed serve the previous release within one request.
- At rollout 10%, the served feed contains `stagingPercentage: 10`; at 100% it has none.
- A revoked private-feed token gets 404.
- Range requests return 206 with the right bytes.
- Clean-up never deletes a live release's files, or a pulled one's while it could still be restored.
- Everything above runs on the Workers Free plan.
