# perchlight-updates

[![CI](https://github.com/matpitts13/perchlight-updates/actions/workflows/ci.yml/badge.svg)](https://github.com/matpitts13/perchlight-updates/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/matpitts13/perchlight-updates)

**A free, self-hosted update server for desktop apps, on your own Cloudflare account.** It serves your installers and the auto-update feed that Electron (electron-builder) and Tauri apps already read, and adds what plain file hosting can't: release channels, gradual rollouts, pulling a bad release in one command, private feeds for beta testers and playtests, and download counts.

It's for developers whose code is private (so GitHub Releases can't serve their users) and who don't want to pay for update hosting. It runs on Cloudflare Workers, R2 and D1, and a typical indie app fits inside the free plans.

Part of [Perchlight](https://github.com/matpitts13/perchlight), a free toolkit for running a product on Cloudflare.

## What it does

- **A drop-in for electron-builder's `generic` provider.** Your app keeps reading `https://downloads.example.com/latest.yml`; nothing in the app changes. The feed is served as electron-builder wrote it, apart from the rollout line (and Windows line endings, which become `\n`).
- **Safe publishing.** Uploading never changes what users see; publishing does. Publishing is refused if any file a feed lists is missing, its stored size doesn't match, or the SHA-512 the publish tool computed doesn't match the feed. A feed can't point at a file that isn't there. (The server can't re-hash large files within the free plan's CPU limit; electron-updater checks the SHA-512 again on each user's machine and refuses a damaged download.)
- **Channels:** `latest` plus any others (`beta`, `alpha`, ...), with electron-builder's own file names (`beta.yml`, `beta-mac.yml`, ...).
- **Gradual rollouts:** publish to 10% of users, raise it later. It uses electron-updater's built-in `stagingPercentage`, so the app needs no changes.
- **Pull a bad release:** one command, and the feed serves the previous release at once. Restore it just as quickly.
- **Private feeds** for testers and playtests: a secret link per group, which you can switch off, with its downloads counted separately.
- **Download counts** per release, file and day, plus update checks. No IP addresses or user ids are stored.
- **Uploads through the server:** the publish tool uploads in parts, resumes after a failure, and needs one secret. No R2 keys anywhere.
- **Tauri:** a dynamic update endpoint, with rollouts.
- **Stays inside the free tier:** keeps the newest 3 releases per channel (you choose) and deletes older files.
- **Moving from plain R2 hosting:** serve your existing bucket as-is, then import it as a live release.
- **A downloads page** at `/`, and screens for the [Perchlight desktop app](https://github.com/matpitts13/perchlight).

## What it costs

| | Free plan | Enough for |
|---|---|---|
| Workers | 100,000 requests a day | an update check and a download are one request each |
| R2 storage | 10 GB | about 3 releases of a 1 GB (all platforms) app per channel |
| R2 downloads | free egress; 10 million reads a month | |
| D1 writes | 100,000 a day | one per counted download or check (`COUNT_CHECKS` can be turned off) |

**R2 needs a payment method on file** before Cloudflare lets you turn it on, even though staying inside the free tier costs nothing.

## Set up

### One click

Click **Deploy to Cloudflare** above. Cloudflare copies this repo to your GitHub account, creates the R2 bucket and D1 database, applies the migrations and deploys the Worker. Its setup page asks for `ADMIN_TOKEN`: use a long random string (`openssl rand -hex 32`; the server refuses anything under 16 characters) and keep it somewhere safe. Anyone with it can publish to your users. Then edit `vars` in `wrangler.jsonc` in your copy (`APP_NAME` at least).

### By hand

You need Node 22+ and a Cloudflare account with R2 turned on.

```sh
git clone https://github.com/matpitts13/perchlight-updates
cd perchlight-updates
npm install
npx wrangler login
npm run deploy                       # creates the bucket and database, deploys
npx wrangler secret put ADMIN_TOKEN  # a long random string
```

Your server is now at `https://perchlight-updates.<your-account>.workers.dev`. To use your own domain, uncomment `routes` in `wrangler.jsonc` and deploy again.

### Settings (`vars` in `wrangler.jsonc`)

| Setting | Default | |
|---|---|---|
| `APP_NAME` | `My App` | shown on the downloads page |
| `KEEP_RELEASES` | `3` | releases per channel that keep their files (the live one included) |
| `COUNT_CHECKS` | `true` | count update checks (one D1 write each) |
| `SERVE_UNMANAGED` | `false` | serve bucket files no release manages, as-is (see [Moving from plain R2 hosting](#moving-from-plain-r2-hosting)) |
| `DOWNLOADS_PAGE` | `true` | a downloads page at `/` for the `latest` channel |

## Point your app at it

**Electron (electron-builder):**

```js
// electron-builder config
publish: { provider: "generic", url: "https://downloads.example.com" }
```

electron-updater then reads `latest.yml` (Windows), `latest-mac.yml` and `latest-linux.yml` from your server. For a beta channel, set `autoUpdater.channel = "beta"` in the app, or publish your betas to a [private feed](#private-feeds-for-testers-and-playtests).

**Tauri (v2 updater plugin):**

```json
"plugins": {
  "updater": {
    "pubkey": "YOUR TAURI PUBLIC KEY",
    "endpoints": ["https://downloads.example.com/tauri/latest/{{target}}/{{arch}}/{{current_version}}"]
  }
}
```

The server answers with Tauri's JSON when there's a newer version, and `204 No Content` when there isn't. For rollouts, send a stable per-install id in an `X-Client-Id` header (the updater plugin's `headers` option); without one, a client is only offered releases at 100%.

## Publish a release

Set two environment variables, then point the tool at your build folder:

```sh
export PERCHLIGHT_UPDATES_URL=https://downloads.example.com
export PERCHLIGHT_UPDATES_TOKEN=<your ADMIN_TOKEN>

node cli/perchlight-updates.mjs publish dist                  # everything, to all users
node cli/perchlight-updates.mjs publish dist --rollout 10     # to 10% first
node cli/perchlight-updates.mjs publish dist --channel beta
node cli/perchlight-updates.mjs publish dist --draft          # upload now, publish later
```

It finds the feed files (`latest*.yml`, or `latest.json` for Tauri), uploads every file they list plus their blockmaps, then publishes. It stops before uploading anything if a listed file is missing. If an upload fails halfway, run the same command again and it resumes.

File names may use letters, digits and `. _ + ~ -`, but not spaces. If your `productName` has a space, set electron-builder's `artifactName` (for example `"${productName}-Setup-${version}.${ext}"` with a product name like `My-App`), or the tool will say the files listed in the feed aren't in the folder.

For Tauri, put a `latest.json` in the folder: the format [tauri-action](https://github.com/tauri-apps/tauri-action) writes (`version`, `notes`, `pub_date`, and `platforms` with each `signature` and `url`). Only the file name at the end of each `url` matters; the server serves the files itself.

**In CI:** [docs/examples/electron-builder-release.yml](docs/examples/electron-builder-release.yml) builds Windows, macOS and Linux on a tag and publishes them.

## After publishing

```sh
node cli/perchlight-updates.mjs releases                # everything, newest first
node cli/perchlight-updates.mjs rollout 1.4.0 50        # raise the rollout
node cli/perchlight-updates.mjs pull 1.4.0              # take it down; 1.3.x goes live again
node cli/perchlight-updates.mjs restore 1.4.0           # put it back
node cli/perchlight-updates.mjs stats --days 7
```

- **Rollouts** only ever add users as you raise them. Lowering one doesn't take the update back from people who already have it.
- **A pull** stops new updates, and the pulled release's files stop being served (in case the build is broken or unsafe). Copies that already updated stay on that version; ship a fixed, higher version to move them on. `restore` brings it all back.

## Private feeds for testers and playtests

```sh
node cli/perchlight-updates.mjs publish dist --channel playtest --private
node cli/perchlight-updates.mjs token create "Playtest group A" --channel playtest
```

The first time you publish to a new channel (other than `latest`), the tool asks you to add `--private` or `--public`, so a test build is never published to everyone by mistake. `channel <name> --private` changes it later.

The last command prints a link like `https://downloads.example.com/p/<token>` (shown once). Under that link the channel is served as if it were `latest`, so a test build with `publish.url` set to the link needs no other change, and testers can download the files directly from it. `token revoke <id>` switches a link off; each link's downloads are counted on their own.

Treat a link like a password that only gives read access: anyone who has it can download that channel's builds.

## Moving from plain R2 hosting

If your installers and `latest*.yml` already sit at the root of an R2 bucket (for example, uploaded by `aws s3 cp` in CI):

1. Point `bucket_name` in `wrangler.jsonc` at that bucket, set `SERVE_UNMANAGED` to `"true"`, and deploy to the workers.dev address. The server now serves the bucket exactly as before; check a few files.
2. `node cli/perchlight-updates.mjs import` registers the root `latest*.yml` files and everything they list as the live release. Nothing is moved or rewritten.
3. Move your domain to the Worker (`routes` in `wrangler.jsonc`), and switch your CI to the publish tool.

Keep `SERVE_UNMANAGED` on while older installers' blockmaps are still useful (differential updates from older versions read them). Imported files are cleaned up like any other once they're older than `KEEP_RELEASES`; files no release manages never are. Files at the bucket root are cached for 5 minutes rather than for good, since an older setup may have overwritten them in place.

## Perchlight desktop app

[`perchlight/perchlight.json`](perchlight/perchlight.json) adds screens for releases, files, downloads, checks, channels and private links. Put your D1 database id in place of `YOUR-D1-DATABASE-ID` and import it in the app. They're for looking and small changes (rollout, a channel's settings, switching a link off). Publish, pull and restore with the tool, since those run the safety checks.

## Test before you rely on it

- `npm test`: 48 tests against a local R2 and D1 (feeds, rollouts, pulls, ranges, uploads, clean-up, tokens, Tauri, import).
- **End-to-end, free and local:** [`e2e/`](e2e) runs a real Electron app with electron-updater against `wrangler dev`. It checks that an update is offered, downloaded and its SHA-512 verified; that a pulled release isn't offered; and that a 50% rollout includes and excludes the right installs. It installs nothing. See the top of [`e2e/run.mjs`](e2e/run.mjs).
- Then publish a test version of your own app to a private channel before your first real release.

**Not tested, because it costs money or needs things we don't have:** code-signed macOS updates (an Apple developer account is $99 a year), a real Tauri app (the JSON is checked against Tauri's documented format, not a running app), differential downloads (several byte ranges in one request aren't supported, so electron-updater should fall back to a full download), and traffic beyond the free plan.

## Admin API

Everything the tool does goes through `/api/`, with `Authorization: Bearer <ADMIN_TOKEN>`:

| | |
|---|---|
| `POST /api/releases` | `{ channel, version, notes? }`: create a draft |
| `PUT /api/releases/:channel/:version/feeds/:name` | a feed file's text |
| `POST /api/releases/:channel/:version/files` | `{ name, size, sha512 }`: start (or resume) an upload |
| `PUT /api/uploads/:id/parts/:n` | one part, exactly `partSize` bytes (the last may be shorter) |
| `POST /api/uploads/:id/complete` | finish an upload |
| `POST /api/releases/:channel/:version/publish` | `{ rollout?, force? }` |
| `POST .../rollout`, `.../pull`, `.../restore` | |
| `GET /api/releases`, `GET /api/releases/:channel/:version`, `DELETE` (drafts) | |
| `GET /api/channels`, `PUT /api/channels/:name` | `{ private?, keep? }` |
| `GET /api/tokens`, `POST /api/tokens`, `DELETE /api/tokens/:id` | private feed links |
| `GET /api/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` | |
| `POST /api/import` | `{ channel? }` |

Design notes: [docs/SDD.md](docs/SDD.md) and [docs/adr](docs/adr).

## License

MIT. See [LICENSE](LICENSE). Not affiliated with Cloudflare, Electron or Tauri.
