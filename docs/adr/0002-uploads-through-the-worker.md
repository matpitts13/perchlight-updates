# ADR 0002: Uploads go through the Worker as R2 multipart parts

**Date:** 2026-11-10
**Status:** Accepted

## Context

Installers are 100–250 MB each. A Worker request body is limited to 100 MB on the Free plan, and R2's own upload API (S3) needs an access key pair. The previous setup gave CI R2 keys with write access to the whole bucket, uploaded with `aws s3 cp`, and relied on upload order (installers before feeds) to stay consistent.

## Options considered

1. **CI uploads straight to R2 with S3 keys** (the old way). Pros: no request-size limit; fastest. Cons: two more secrets with full bucket write access; the server never sees uploads, so it can't check them or track drafts.
2. **The Worker signs presigned S3 URLs; CI uploads to those.** Pros: CI never holds R2 keys. Cons: the Worker needs the S3 key pair as secrets anyway, and a hand-written SigV4 presigner to maintain.
3. **CI sends parts of ≤ 95 MB to the Worker, which writes them with the R2 binding's multipart API.** Pros: one secret (the admin token); no R2 keys anywhere; every upload is tied to a draft release, resumable part by part, and checked for size on completion. Cons: uploads pass through the Worker (more requests; wall time, not CPU, so it fits the Free plan), and the Worker can't hash files inside the CPU limit.

## Decision

Option 3: one narrowly scoped secret, and uploads the server knows about, which is what makes publish-time checks possible.

## Consequences

- Positive: CI needs only `PERCHLIGHT_UPDATES_TOKEN`; a leaked token can't touch other buckets; a failed upload resumes from the last part.
- Negative: SHA-512 is computed by the CLI, not verified by the Worker (see ADR 0001); electron-updater verifies it on the user's machine.
- Negative: parts must be at least 5 MiB (R2) and the same size except the last, so part size is fixed by the server per upload.
- Follow-up: if Workers' request limit rises or R2 adds server-side checksums for multipart uploads, verify SHA-512 on the server.
