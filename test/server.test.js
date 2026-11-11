import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach } from "vitest";
import { api, bytes, call, electronFeed, makeRelease, resetAll, sha512, uploadFile } from "./helpers.js";
import { cleanUp } from "../src/lib/releases.js";

beforeEach(resetAll);

const MIB = 1024 * 1024;

describe("admin API access", () => {
  it("refuses requests without the right token", async () => {
    expect((await call("/api/releases")).status).toBe(401);
    expect((await call("/api/releases", { headers: { Authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("says what to do when ADMIN_TOKEN isn't set, or is too short", async () => {
    const res = await call("/api/releases", {}, { ADMIN_TOKEN: "" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/wrangler secret put ADMIN_TOKEN/);
    const short = await call("/api/releases", { headers: { Authorization: "Bearer abc" } }, { ADMIN_TOKEN: "abc" });
    expect(short.status).toBe(503);
  });

  it("validates new releases", async () => {
    expect((await api("POST", "releases", { channel: "Beta", version: "1.0.0" })).status).toBe(400);
    expect((await api("POST", "releases", { channel: "beta", version: "1.0" })).status).toBe(400);
    expect((await api("POST", "releases", { channel: "beta", version: "1.0.0" })).status).toBe(201);
    expect((await api("POST", "releases", { channel: "beta", version: "1.0.0" })).data.existing).toBe(true);
  });
});

describe("publishing and serving", () => {
  it("serves the live feed exactly as built, and its files", async () => {
    const { name, content, feed, published } = await makeRelease("latest", "1.0.0");
    expect(published.status).toBe(200);

    const res = await call("/latest.yml");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(await res.text()).toBe(feed);

    const file = await call(`/${name}`);
    expect(file.status).toBe(200);
    expect(file.headers.get("Cache-Control")).toMatch(/immutable/);
    expect(file.headers.get("Accept-Ranges")).toBe("bytes");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(content);

    const head = await call(`/${name}`, { method: "HEAD" });
    expect(head.headers.get("Content-Length")).toBe(String(content.length));
  });

  it("serves single byte ranges, and refuses impossible ones", async () => {
    const { name, content } = await makeRelease("latest", "1.0.0");
    const mid = await call(`/${name}`, { headers: { Range: "bytes=10-19" } });
    expect(mid.status).toBe(206);
    expect(mid.headers.get("Content-Range")).toBe(`bytes 10-19/${content.length}`);
    expect(new Uint8Array(await mid.arrayBuffer())).toEqual(content.slice(10, 20));

    const tail = await call(`/${name}`, { headers: { Range: "bytes=-5" } });
    expect(new Uint8Array(await tail.arrayBuffer())).toEqual(content.slice(-5));

    const open = await call(`/${name}`, { headers: { Range: "bytes=990-" } });
    expect(new Uint8Array(await open.arrayBuffer())).toEqual(content.slice(990));

    const bad = await call(`/${name}`, { headers: { Range: "bytes=5000-6000" } });
    expect(bad.status).toBe(416);
    expect(bad.headers.get("Content-Range")).toBe(`bytes */${content.length}`);

    const several = await call(`/${name}`, { headers: { Range: "bytes=0-1,5-6" } });
    expect(several.status).toBe(200);
    const backwards = await call(`/${name}`, { headers: { Range: "bytes=9-2" } });
    expect(backwards.status).toBe(200);
  });

  it("answers If-None-Match with 304 and a failed If-Match with 412", async () => {
    const { name } = await makeRelease("latest", "1.0.0");
    const etag = (await call(`/${name}`)).headers.get("ETag");
    expect((await call(`/${name}`, { headers: { "If-None-Match": etag } })).status).toBe(304);
    expect((await call(`/${name}`, { headers: { "If-Match": '"not-it"' } })).status).toBe(412);
  });

  it("counts downloads from the first byte only, and update checks", async () => {
    const { name } = await makeRelease("latest", "1.0.0");
    await call(`/${name}`);
    await call(`/${name}`, { headers: { Range: "bytes=0-99" } });
    await call(`/${name}`, { headers: { Range: "bytes=100-199" } });
    await call(`/${name}`, { method: "HEAD" });
    await call("/latest.yml");
    await call("/latest.yml");
    const { data } = await api("GET", "stats");
    expect(data.downloads).toHaveLength(1);
    expect(data.downloads[0]).toMatchObject({ file_name: name, version: "1.0.0", source: "public", count: 2 });
    expect(data.checks[0]).toMatchObject({ channel: "latest", platform: "", count: 2 });
  });

  it("doesn't count checks when COUNT_CHECKS is off", async () => {
    await makeRelease("latest", "1.0.0");
    await call("/latest.yml", {}, { COUNT_CHECKS: "false" });
    expect((await api("GET", "stats")).data.checks).toHaveLength(0);
  });

  it("serves nothing from a draft", async () => {
    const { name } = await makeRelease("latest", "1.0.0", { publish: false });
    expect((await call("/latest.yml")).status).toBe(404);
    expect((await call(`/${name}`)).status).toBe(404);
  });

  it("refuses to publish a feed whose files are missing or different", async () => {
    await api("POST", "releases", { channel: "latest", version: "2.0.0" });
    const a = bytes(500, 3);
    const b = bytes(500, 4);
    const feed = electronFeed("2.0.0", [
      { name: "A-2.0.0.exe", sha512: await sha512(a), size: a.length },
      { name: "B-2.0.0.exe", sha512: await sha512(b), size: b.length },
      { name: "C-2.0.0.exe", sha512: await sha512(b), size: 7 },
    ]);
    await api("PUT", "releases/latest/2.0.0/feeds/latest.yml", feed);
    await uploadFile("latest", "2.0.0", "A-2.0.0.exe", a);
    await uploadFile("latest", "2.0.0", "C-2.0.0.exe", b);
    const res = await api("POST", "releases/latest/2.0.0/publish");
    expect(res.status).toBe(400);
    expect(res.data.problems.join("\n")).toMatch(/B-2\.0\.0\.exe, which hasn't been uploaded/);
    expect(res.data.problems.join("\n")).toMatch(/C-2\.0\.0\.exe: 500 bytes uploaded, latest\.yml says 7/);
    expect((await call("/latest.yml")).status).toBe(404);
  });

  it("refuses a feed for another version, and a draft with no feed", async () => {
    await api("POST", "releases", { channel: "latest", version: "2.0.0" });
    const wrong = electronFeed("1.9.0", [{ name: "A.exe", sha512: await sha512(bytes(5)), size: 5 }]);
    expect((await api("PUT", "releases/latest/2.0.0/feeds/latest.yml", wrong)).status).toBe(400);
    expect((await api("PUT", "releases/latest/2.0.0/feeds/notes.yml", wrong)).status).toBe(400);
    expect((await api("POST", "releases/latest/2.0.0/publish")).data.problems[0]).toMatch(/No feed files/);
  });

  it("refuses an older version unless forced", async () => {
    await makeRelease("latest", "2.0.0");
    const older = await makeRelease("latest", "1.5.0");
    expect(older.published.status).toBe(409);
    const forced = await api("POST", "releases/latest/1.5.0/publish", { force: true });
    expect(forced.status).toBe(200);
    expect(forced.data.replaced).toBe("2.0.0");
  });

  it("can't change a published release", async () => {
    await makeRelease("latest", "1.0.0");
    expect((await api("PUT", "releases/latest/1.0.0/feeds/latest.yml", "version: 1.0.0\n")).status).toBe(409);
    expect((await api("DELETE", "releases/latest/1.0.0")).status).toBe(409);
  });
});

describe("rollouts, pulls and restores", () => {
  it("adds stagingPercentage for a partial rollout, and removes it at 100%", async () => {
    await makeRelease("latest", "1.0.0", { rollout: 10 });
    expect(await (await call("/latest.yml")).text()).toMatch(/\nstagingPercentage: 10\n$/);
    expect((await api("POST", "releases/latest/1.0.0/rollout", { rollout: 50 })).status).toBe(200);
    expect(await (await call("/latest.yml")).text()).toMatch(/stagingPercentage: 50/);
    await api("POST", "releases/latest/1.0.0/rollout", { rollout: 100 });
    expect(await (await call("/latest.yml")).text()).not.toMatch(/stagingPercentage/);
    expect((await api("POST", "releases/latest/1.0.0/rollout", { rollout: 0 })).status).toBe(400);
  });

  it("pulling the live release serves the one before it at once; restoring undoes it", async () => {
    const v1 = await makeRelease("latest", "1.0.0");
    const v2 = await makeRelease("latest", "1.1.0");
    expect(await (await call("/latest.yml")).text()).toBe(v2.feed);

    const pulled = await api("POST", "releases/latest/1.1.0/pull");
    expect(pulled.data.live).toBe("1.0.0");
    expect(await (await call("/latest.yml")).text()).toBe(v1.feed);
    // A pulled build may be broken or unsafe: its files stop being served too.
    expect((await call(`/${v2.name}`)).status).toBe(404);
    expect((await api("POST", "releases/latest/1.1.0/pull")).status).toBe(409);

    expect((await api("POST", "releases/latest/1.1.0/restore")).status).toBe(200);
    expect(await (await call("/latest.yml")).text()).toBe(v2.feed);
    expect((await call(`/${v2.name}`)).status).toBe(200);
    expect((await api("POST", "releases/latest/1.1.0/restore")).status).toBe(409);
  });

  it("two publishes of the same draft at once leave exactly one live release", async () => {
    await makeRelease("latest", "1.0.0");
    await makeRelease("latest", "1.1.0", { publish: false });
    const [a, b] = await Promise.all([
      api("POST", "releases/latest/1.1.0/publish"),
      api("POST", "releases/latest/1.1.0/publish"),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const live = (await api("GET", "releases?channel=latest")).data.releases.filter((r) => r.state === "live");
    expect(live.map((r) => r.version)).toEqual(["1.1.0"]);
    expect((await call("/latest.yml")).status).toBe(200);
  });

  it("refuses a rollout that isn't a whole number from 1 to 100", async () => {
    await makeRelease("latest", "1.0.0");
    for (const rollout of [null, "50", true, 0, 101, 12.5]) {
      expect((await api("POST", "releases/latest/1.0.0/rollout", { rollout })).status, String(rollout)).toBe(400);
    }
  });

  it("pulling the only release leaves the channel with no feed", async () => {
    await makeRelease("latest", "1.0.0");
    expect((await api("POST", "releases/latest/1.0.0/pull")).data.live).toBeNull();
    expect((await call("/latest.yml")).status).toBe(404);
  });
});

describe("channels and private feeds", () => {
  it("serves each channel's own feed file names", async () => {
    await makeRelease("beta", "1.1.0-beta.1");
    expect((await call("/beta.yml")).status).toBe(200);
    expect((await call("/latest.yml")).status).toBe(404);
  });

  it("hides a private channel except under a token, which serves it as latest.yml", async () => {
    const { name, feed } = await makeRelease("playtest", "0.5.0");
    await api("PUT", "channels/playtest", { private: true });
    expect((await call("/playtest.yml")).status).toBe(404);
    expect((await call(`/${name}`)).status).toBe(404);

    const created = await api("POST", "tokens", { label: "Group A", channel: "playtest" });
    expect(created.status).toBe(201);
    const { token, feedUrl } = created.data;
    expect(feedUrl).toBe(`https://updates.test/p/${token}`);

    expect(await (await call(`/p/${token}/latest.yml`)).text()).toBe(feed);
    expect((await call(`/p/${token}/${name}`)).status).toBe(200);
    expect((await call(`/p/${token}/`)).status).toBe(404);

    const stats = (await api("GET", "stats")).data;
    expect(stats.downloads[0].source).toBe(`token:${created.data.id}`);

    expect((await api("DELETE", `tokens/${created.data.id}`)).status).toBe(200);
    expect((await call(`/p/${token}/latest.yml`)).status).toBe(404);
    expect((await call("/p/not-a-token/latest.yml")).status).toBe(404);
    expect((await api("DELETE", "tokens/abc")).status).toBe(404);
    const listed = (await api("GET", "tokens")).data.tokens;
    expect(listed[0]).toMatchObject({ label: "Group A", active: false });
    expect(JSON.stringify(listed)).not.toContain(token);
  });
});

describe("uploads", () => {
  it("uploads in parts, resumes, and checks each part's length", async () => {
    await api("POST", "releases", { channel: "latest", version: "3.0.0" });
    const big = bytes(12 * MIB, 7);
    const hash = await sha512(big);
    const start = await api("POST", "releases/latest/3.0.0/files", { name: "Big-3.0.0.exe", size: big.length, sha512: hash });
    expect(start.data.upload).toMatchObject({ partSize: 5 * MIB, partCount: 3, partsDone: [] });
    const { id } = start.data.upload;

    const short = big.slice(0, 1000);
    expect((await api("PUT", `uploads/${id}/parts/1`, short, { "Content-Length": "1000" })).status).toBe(400);
    expect((await api("PUT", `uploads/${id}/parts/4`, short, { "Content-Length": "1000" })).status).toBe(400);

    const p1 = big.slice(0, 5 * MIB);
    expect((await api("PUT", `uploads/${id}/parts/1`, p1, { "Content-Length": String(p1.length) })).status).toBe(200);
    expect((await api("POST", `uploads/${id}/complete`)).data.error).toMatch(/missing: 2, 3/);

    const again = await api("POST", "releases/latest/3.0.0/files", { name: "Big-3.0.0.exe", size: big.length, sha512: hash });
    expect(again.data.upload).toMatchObject({ id, partsDone: [1] });

    expect((await uploadFile("latest", "3.0.0", "Big-3.0.0.exe", big)).status).toBe(200);
    const stored = await env.FILES.get("files/Big-3.0.0.exe");
    expect(stored.size).toBe(big.length);
    expect(await sha512(new Uint8Array(await stored.arrayBuffer()))).toBe(hash);
  });

  it("reuses an identical file from another release, and refuses a different one with the same name", async () => {
    const one = await makeRelease("beta", "1.0.0");
    await api("POST", "releases", { channel: "latest", version: "1.0.0" });
    const reused = await uploadFile("latest", "1.0.0", one.name, one.content);
    expect(reused.data.reused).toBe(true);
    const clash = await uploadFile("latest", "1.0.0", `${one.name}.blockmap`, bytes(50, 99));
    expect(clash.status).toBe(409);
  });

  it("finishes a retried 'complete' whose first attempt worked", async () => {
    await api("POST", "releases", { channel: "latest", version: "3.0.0" });
    const content = bytes(6 * MIB, 8);
    const start = await api("POST", "releases/latest/3.0.0/files", { name: "R-3.0.0.exe", size: content.length, sha512: await sha512(content) });
    const { id, partSize } = start.data.upload;
    for (const n of [1, 2]) {
      const part = content.slice((n - 1) * partSize, n * partSize);
      await api("PUT", `uploads/${id}/parts/${n}`, part, { "Content-Length": String(part.length) });
    }
    // Complete it in R2 behind the API's back, as if the reply had been lost.
    const row = await env.DB.prepare("SELECT r2_key, r2_upload_id FROM uploads WHERE id = ?1").bind(id).first();
    const { results } = await env.DB.prepare("SELECT part_number, etag FROM upload_parts WHERE upload_id = ?1 ORDER BY part_number").bind(id).all();
    await env.FILES.resumeMultipartUpload(row.r2_key, row.r2_upload_id).complete(results.map((p) => ({ partNumber: p.part_number, etag: p.etag })));
    const retried = await api("POST", `uploads/${id}/complete`);
    expect(retried.status).toBe(200);
    expect((await api("GET", "releases/latest/3.0.0")).data.files.map((f) => f.name)).toContain("R-3.0.0.exe");
  });

  it("refuses two drafts uploading different files with the same name at once", async () => {
    await api("POST", "releases", { channel: "latest", version: "1.0.0" });
    await api("POST", "releases", { channel: "beta", version: "1.0.0" });
    const a = bytes(6 * MIB, 1);
    const b = bytes(6 * MIB, 2);
    expect((await api("POST", "releases/latest/1.0.0/files", { name: "Same.exe", size: a.length, sha512: await sha512(a) })).status).toBe(201);
    expect((await api("POST", "releases/beta/1.0.0/files", { name: "Same.exe", size: b.length, sha512: await sha512(b) })).status).toBe(409);
  });

  it("validates file details", async () => {
    await api("POST", "releases", { channel: "latest", version: "1.0.0" });
    const ok = { name: "a.exe", size: 1, sha512: await sha512(bytes(1)) };
    expect((await api("POST", "releases/latest/1.0.0/files", { ...ok, name: "../a.exe" })).status).toBe(400);
    expect((await api("POST", "releases/latest/1.0.0/files", { ...ok, name: "latest.yml" })).status).toBe(400);
    expect((await api("POST", "releases/latest/1.0.0/files", { ...ok, size: -1 })).status).toBe(400);
    expect((await api("POST", "releases/latest/1.0.0/files", { ...ok, sha512: "abc" })).status).toBe(400);
    expect((await api("POST", "releases/latest/9.9.9/files", ok)).status).toBe(404);
  });

  it("deleting a draft removes its files", async () => {
    await makeRelease("latest", "1.0.0", { publish: false });
    expect((await env.FILES.list({ prefix: "files/" })).objects.length).toBe(2);
    expect((await api("DELETE", "releases/latest/1.0.0")).status).toBe(200);
    expect((await env.FILES.list({ prefix: "files/" })).objects.length).toBe(0);
  });
});

describe("clean-up", () => {
  it("keeps the newest releases' files, deletes older ones, and never a file still in use", async () => {
    await api("PUT", "channels/latest", { keep: 2 });
    const v1 = await makeRelease("latest", "1.0.0");
    await makeRelease("latest", "1.1.0");
    await makeRelease("latest", "1.2.0"); // publishing runs the clean-up itself
    expect((await cleanUp(env, "latest")).expired).toBe(0); // and running it again changes nothing
    expect(await env.FILES.head(`files/${v1.name}`)).toBeNull();
    const releases = (await api("GET", "releases?channel=latest")).data.releases;
    expect(releases.map((r) => `${r.version}:${r.state}`)).toEqual(["1.2.0:live", "1.1.0:superseded", "1.0.0:expired"]);
    expect((await call(`/${v1.name}`)).status).toBe(404);
  });

  it("doesn't delete a file another channel still uses", async () => {
    await api("PUT", "channels/beta", { keep: 1 });
    const shared = await makeRelease("beta", "1.0.0");
    await api("POST", "releases", { channel: "latest", version: "1.0.0" });
    await api("PUT", "releases/latest/1.0.0/feeds/latest.yml", shared.feed);
    await uploadFile("latest", "1.0.0", shared.name, shared.content);
    await api("POST", "releases/latest/1.0.0/publish");
    await makeRelease("beta", "1.1.0");
    await cleanUp(env, "beta");
    expect(await env.FILES.head(`files/${shared.name}`)).not.toBeNull();
    expect((await call(`/${shared.name}`)).status).toBe(200);
  });
});

describe("Tauri", () => {
  async function tauriRelease(version, rollout) {
    const zip = bytes(300, 5);
    await api("POST", "releases", { channel: "latest", version });
    const feed = JSON.stringify({
      version: `v${version}`,
      notes: "Tauri notes",
      pub_date: "2026-11-10T12:00:00Z",
      platforms: { "windows-x86_64": { signature: "SIG", url: `https://example.test/app_${version}_x64-setup.nsis.zip` } },
    });
    await api("PUT", `releases/latest/${version}/feeds/latest.json`, feed);
    await uploadFile("latest", version, `app_${version}_x64-setup.nsis.zip`, zip);
    return api("POST", `releases/latest/${version}/publish`, rollout ? { rollout } : {});
  }

  it("answers with the update when there's a newer version, and 204 otherwise", async () => {
    expect((await tauriRelease("1.2.0")).status).toBe(200);
    const res = await call("/tauri/latest/windows/x86_64/1.1.0");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      version: "1.2.0",
      notes: "Tauri notes",
      pub_date: "2026-11-10T12:00:00Z",
      url: "https://updates.test/app_1.2.0_x64-setup.nsis.zip",
      signature: "SIG",
    });
    expect((await call("/tauri/latest/windows/x86_64/1.2.0")).status).toBe(204);
    expect((await call("/tauri/latest/darwin/aarch64/1.0.0")).status).toBe(204);
    expect((await call("/tauri/latest/windows/x86_64/nope")).status).toBe(400);
    expect((await call("/app_1.2.0_x64-setup.nsis.zip")).status).toBe(200);
  });

  it("offers a partial rollout only to clients inside it", async () => {
    await tauriRelease("1.2.0", 50);
    expect((await call("/tauri/latest/windows/x86_64/1.0.0")).status).toBe(204);
    let yes = 0;
    for (let i = 0; i < 40; i++) {
      const res = await call("/tauri/latest/windows/x86_64/1.0.0", { headers: { "X-Client-Id": `client-${i}` } });
      if (res.status === 200) yes++;
    }
    expect(yes).toBeGreaterThan(5);
    expect(yes).toBeLessThan(35);
    // Stable: the same client gets the same answer every time.
    const a = (await call("/tauri/latest/windows/x86_64/1.0.0", { headers: { "X-Client-Id": "client-1" } })).status;
    const b = (await call("/tauri/latest/windows/x86_64/1.0.0", { headers: { "X-Client-Id": "client-1" } })).status;
    expect(a).toBe(b);
  });
});

describe("switching from an older setup", () => {
  async function legacyBucket() {
    const exe = bytes(800, 11);
    const map = bytes(40, 12);
    const feed = electronFeed("0.9.0", [{ name: "Old-Setup-0.9.0.exe", sha512: await sha512(exe), size: exe.length }]);
    await env.FILES.put("Old-Setup-0.9.0.exe", exe);
    await env.FILES.put("Old-Setup-0.9.0.exe.blockmap", map);
    await env.FILES.put("Old-Setup-0.8.0.exe.blockmap", map);
    await env.FILES.put("latest.yml", feed);
    return { exe, feed };
  }

  it("serves the bucket as it was before import when SERVE_UNMANAGED is on", async () => {
    const { feed } = await legacyBucket();
    const on = { SERVE_UNMANAGED: "true" };
    expect(await (await call("/latest.yml", {}, on)).text()).toBe(feed);
    expect((await call("/Old-Setup-0.9.0.exe", {}, on)).status).toBe(200);
    expect((await call("/latest.yml")).status).toBe(404);
  });

  it("imports the root feed as a live release, then publishes on top of it", async () => {
    const { feed } = await legacyBucket();
    const imported = await api("POST", "import", { channel: "latest" });
    expect(imported.status).toBe(200);
    expect(imported.data).toMatchObject({ files: 2, feeds: 1, release: { version: "0.9.0", state: "live" } });
    expect(await (await call("/latest.yml")).text()).toBe(feed);
    const exe = await call("/Old-Setup-0.9.0.exe");
    expect(exe.status).toBe(200);
    // Root files may have been overwritten in place by the old setup: short caching.
    expect(exe.headers.get("Cache-Control")).toBe("public, max-age=300");
    expect((await call("/Old-Setup-0.9.0.exe.blockmap")).status).toBe(200);
    expect((await api("POST", "import", { channel: "latest" })).status).toBe(409);

    await makeRelease("latest", "1.0.0");
    expect(await (await call("/latest.yml")).text()).toMatch(/version: 1\.0\.0/);
    // An older blockmap no release manages is still served for differential updates.
    expect((await call("/Old-Setup-0.8.0.exe.blockmap", {}, { SERVE_UNMANAGED: "true" })).status).toBe(200);
  });

  it("never serves a managed file through SERVE_UNMANAGED (e.g. an imported file on a channel made private)", async () => {
    await legacyBucket();
    await api("POST", "import", { channel: "latest" });
    await api("PUT", "channels/latest", { private: true });
    expect((await call("/Old-Setup-0.9.0.exe", {}, { SERVE_UNMANAGED: "true" })).status).toBe(404);
    expect((await call("/Old-Setup-0.8.0.exe.blockmap", {}, { SERVE_UNMANAGED: "true" })).status).toBe(200);
  });

  it("refuses to import a feed whose files are missing", async () => {
    await legacyBucket();
    await env.FILES.delete("Old-Setup-0.9.0.exe");
    const res = await api("POST", "import", { channel: "latest" });
    expect(res.status).toBe(400);
    expect(res.data.problems[0]).toMatch(/isn't in the bucket/);
  });
});

describe("downloads page", () => {
  it("lists the latest release's installers", async () => {
    await makeRelease("latest", "1.0.0");
    const html = await (await call("/")).text();
    expect(html).toContain("Test App");
    expect(html).toContain("App-Setup-1.0.0.exe");
    expect(html).not.toContain(".blockmap");
    expect((await call("/", {}, { DOWNLOADS_PAGE: "false" })).status).toBe(404);
  });

  it("is plain when nothing is published", async () => {
    expect(await (await call("/")).text()).toContain("No release is available yet");
  });
});
