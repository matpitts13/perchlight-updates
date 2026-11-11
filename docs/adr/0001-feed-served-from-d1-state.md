# ADR 0001: The served feed is the live release's own copy, chosen in D1

**Date:** 2026-11-10
**Status:** Accepted

## Context

Plain R2 hosting (the setup this replaces) serves `latest.yml` as a file. Publishing means overwriting it, a pull means overwriting it again by hand, and a feed uploaded before its installer points every installed app at a missing file. We want publish, rollout and pull to be instant and safe, inside the Workers Free plan, and to stay a drop-in for electron-builder's `generic` provider.

## Options considered

1. **Overwrite `latest.yml` in R2 on each change.** Pros: the simplest server. Cons: not atomic across the three platform feeds, nothing to roll back to, and rollouts mean rewriting files.
2. **Generate feeds from file metadata in D1.** Pros: no stored feed at all. Cons: we would have to re-create electron-builder's format (and every field future versions add) exactly; any drift breaks updates.
3. **Store each release's feed files as built; D1 says which release is live; the Worker serves that copy, adding only `stagingPercentage`.** Pros: the bytes apps read are the bytes electron-builder wrote; publish, pull and restore are one D1 batch; rollouts reuse electron-updater's own field. Cons: every feed request reads D1 and R2 (one Worker request, two binding calls).

## Decision

Option 3: it changes nothing about what apps read except the one field electron-updater defines for rollouts, and every state change is a single transactional D1 batch.

## Consequences

- Positive: no moment where the feed points at a missing file (publish checks every listed file first); a pull falls back to the previous release in the same statement; feeds for every platform switch together.
- Positive: drafts, pulled releases and history come free from the `releases` table.
- Negative: SHA-512 can't be computed by the Worker inside the Free plan's CPU limit, so the CLI's hash is trusted and compared with the feed; electron-updater re-checks on the user's machine, so a damaged upload fails safe.
- Negative: multi-range requests (used by differential downloads) get the whole file; electron-updater then falls back to a full download.
- Follow-up: Workers Analytics Engine instead of D1 counters, if D1's 100,000 writes a day becomes a limit for big apps.
