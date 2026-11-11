import { describe, it, expect } from "vitest";
import {
  parseElectronFeed,
  parseFeedName,
  parseTauriFeed,
  withRollout,
  isFileName,
  fileNameFromUrl,
  feedNameFor,
} from "../src/lib/feed.js";
import { compareVersions, isVersion } from "../src/lib/semver.js";

// The shape electron-builder writes (copied from a real latest-linux.yml,
// with made-up names and hashes).
const LINUX = `version: 1.0.0-beta.3
files:
  - url: MyApp-1.0.0-beta.3.AppImage
    sha512: J66VZjFUwj6NAHdBp54oLzm5Wix3z28Ya0LxBYgsvuGB8V05ViTFij59glUOMTvNRLKV7EAQEJXdS4djuXrGBQ==
    size: 194243621
    blockMapSize: 203833
  - url: myapp_1.0.0-beta.3_amd64.deb
    sha512: XpS7OlQqPFIP6xUgwMILqMzF0P85/EawxgCKNSDql88W1SCvDGezQR23uwfwXPfXZwIq7nrMsMkzkBO7nmqdFw==
    size: 156453732
path: MyApp-1.0.0-beta.3.AppImage
sha512: J66VZjFUwj6NAHdBp54oLzm5Wix3z28Ya0LxBYgsvuGB8V05ViTFij59glUOMTvNRLKV7EAQEJXdS4djuXrGBQ==
releaseDate: '2026-10-21T21:31:31.107Z'
`;

describe("electron-builder feeds", () => {
  it("reads version, files, sizes and hashes", () => {
    const feed = parseElectronFeed(LINUX);
    expect(feed.version).toBe("1.0.0-beta.3");
    expect(feed.releaseDate).toBe("2026-10-21T21:31:31.107Z");
    expect(feed.files).toHaveLength(2);
    expect(feed.files[0]).toMatchObject({ name: "MyApp-1.0.0-beta.3.AppImage", size: 194243621, blockMapSize: 203833 });
    expect(feed.files[1].sha512).toMatch(/==$/);
  });

  it("skips release notes written as a block or a list", () => {
    const block = LINUX.replace("releaseDate", "releaseNotes: |-\n  Fixed: things.\n  - not a list item\nreleaseDate");
    expect(parseElectronFeed(block).files).toHaveLength(2);
    const list = `${LINUX}releaseNotes:\n  - version: 1.0.0\n    note: hi\n`;
    expect(parseElectronFeed(list).version).toBe("1.0.0-beta.3");
  });

  it("accepts YAML document markers and block indicators like |+ and >2", () => {
    expect(parseElectronFeed(`---\n${LINUX}...\n`).version).toBe("1.0.0-beta.3");
    expect(parseElectronFeed(LINUX.replace("releaseDate", "releaseNotes: |+\n  kept\nreleaseDate")).files).toHaveLength(2);
    expect(parseElectronFeed(LINUX.replace("releaseDate", "releaseNotes: >2\n  folded\nreleaseDate")).files).toHaveLength(2);
  });

  it("handles Windows line endings and double-quoted values", () => {
    const crlf = LINUX.replace(/\n/g, "\r\n").replace("version: 1.0.0-beta.3", 'version: "1.0.0-beta.3"');
    expect(parseElectronFeed(crlf).version).toBe("1.0.0-beta.3");
  });

  it("takes file names from URLs, decoding them", () => {
    expect(fileNameFromUrl("https://x.test/dl/My%20App.exe?x=1")).toBe("My App.exe");
    const feed = LINUX.replace("url: myapp_1.0.0-beta.3_amd64.deb", "url: https://cdn.test/a/myapp_1.0.0-beta.3_amd64.deb");
    expect(parseElectronFeed(feed).files[1].name).toBe("myapp_1.0.0-beta.3_amd64.deb");
  });

  it("refuses what isn't a feed", () => {
    expect(() => parseElectronFeed("")).toThrow(/empty/);
    expect(() => parseElectronFeed("files:\n  - url: a.exe\n    sha512: x\n    size: 1\n")).toThrow(/no version/);
    expect(() => parseElectronFeed("version: 1.0.0\n")).toThrow(/no files/);
    expect(() => parseElectronFeed("version: 1.0.0\nfiles:\n  - url: a.exe\n    size: 1\n")).toThrow(/sha512/);
    expect(() => parseElectronFeed("version: 1.0.0\nfiles:\n  - url: a.exe\n    sha512: x\n    size: big\n")).toThrow(/size/);
    expect(() => parseElectronFeed("version: 1.0.0\nfiles:\n  - url: has space.exe\n    sha512: x\n    size: 1\n")).toThrow(/file name/);
    expect(() => parseElectronFeed("<html>nope</html>")).toThrow();
  });

  it("adds stagingPercentage only below 100%, replacing any already there", () => {
    expect(withRollout(LINUX, 100)).not.toMatch(/stagingPercentage/);
    expect(withRollout(LINUX, 10)).toMatch(/\nstagingPercentage: 10\n$/);
    const twice = withRollout(withRollout(LINUX, 10), 25);
    expect(twice.match(/stagingPercentage/g)).toHaveLength(1);
    expect(twice).toMatch(/stagingPercentage: 25\n$/);
    expect(withRollout(withRollout(LINUX, 10), 100)).toBe(LINUX);
    expect(parseElectronFeed(withRollout(LINUX, 10)).stagingPercentage).toBe("10");
  });
});

describe("feed names", () => {
  it("knows each platform's file", () => {
    expect(parseFeedName("latest.yml")).toEqual({ type: "electron", channel: "latest", platform: "" });
    expect(parseFeedName("latest-mac.yml")).toEqual({ type: "electron", channel: "latest", platform: "-mac" });
    expect(parseFeedName("beta-linux.yml")).toEqual({ type: "electron", channel: "beta", platform: "-linux" });
    expect(parseFeedName("latest-linux-arm64.yml")).toEqual({ type: "electron", channel: "latest", platform: "-linux-arm64" });
    expect(parseFeedName("latest.json")).toEqual({ type: "tauri", channel: "latest", platform: "tauri" });
    expect(parseFeedName("App-1.0.exe")).toBeNull();
    expect(parseFeedName("builder-debug.yml")).toBeNull();
    expect(feedNameFor("beta", "-mac")).toBe("beta-mac.yml");
    expect(feedNameFor("beta", "tauri")).toBe("beta.json");
  });

  it("only accepts plain file names", () => {
    expect(isFileName("App-Setup-1.2.3.exe")).toBe(true);
    expect(isFileName("app_1.2.3+build.4_amd64.deb")).toBe(true);
    for (const bad of ["", "a/b.exe", "..", "a..b", ".hidden", "a b.exe", "a\\b", "x".repeat(201)]) {
      expect(isFileName(bad), bad).toBe(false);
    }
  });
});

describe("Tauri feeds", () => {
  const TAURI = JSON.stringify({
    version: "v1.2.0",
    notes: "Fixes",
    pub_date: "2026-11-10T12:00:00Z",
    platforms: {
      "windows-x86_64": { signature: "sig-win", url: "https://github.com/me/app/releases/download/v1.2.0/app_1.2.0_x64-setup.nsis.zip" },
      "darwin-aarch64": { signature: "sig-mac", url: "app.app.tar.gz" },
    },
  });

  it("reads version (without a leading v), notes and platforms", () => {
    const f = parseTauriFeed(TAURI);
    expect(f.version).toBe("1.2.0");
    expect(f.platforms["windows-x86_64"].name).toBe("app_1.2.0_x64-setup.nsis.zip");
    expect(f.platforms["darwin-aarch64"].signature).toBe("sig-mac");
  });

  it("refuses incomplete feeds", () => {
    expect(() => parseTauriFeed("nope")).toThrow(/JSON/);
    expect(() => parseTauriFeed('{"version":"1.0.0","platforms":{}}')).toThrow(/platforms/);
    expect(() => parseTauriFeed('{"version":"1.0.0","platforms":{"windows-x86_64":{"url":"a.zip"}}}')).toThrow(/signature/);
  });
});

describe("versions", () => {
  it("orders versions the semver way", () => {
    const sorted = ["1.0.0", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "0.9.9", "1.0.1", "1.10.0", "1.2.0"].sort(compareVersions);
    expect(sorted).toEqual(["0.9.9", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.2.0", "1.10.0"]);
    expect(compareVersions("v2.0.0", "2.0.0+build.5")).toBe(0);
    expect(isVersion("1.2")).toBe(false);
    expect(() => compareVersions("1.2", "1.2.0")).toThrow();
  });
});
