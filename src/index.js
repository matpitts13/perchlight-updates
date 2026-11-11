// perchlight-updates: a self-hosted update server for desktop apps on
// Cloudflare Workers + R2 + D1.
import { handleAdmin } from "./routes/admin.js";
import { handlePublic, privateScope } from "./routes/public.js";
import { abortStaleUploads, cleanUp } from "./lib/releases.js";
import { fail, notFound } from "./lib/http.js";

function decodeSegments(path) {
  const parts = path.split("/").filter(Boolean);
  try {
    return parts.map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api" || path.startsWith("/api/")) return await handleAdmin(request, env, ctx, path.slice(5));

      let scope = { source: "public" };
      let base = url.origin;
      let rest = path;
      const p = /^\/p\/([^/]+)(\/.*)?$/.exec(path);
      if (p) {
        scope = await privateScope(env, p[1]);
        if (!scope) return notFound();
        base = `${url.origin}/p/${p[1]}`;
        rest = p[2] ?? "/";
      }
      const segments = decodeSegments(rest);
      if (!segments) return notFound();
      return await handlePublic(request, env, ctx, segments, scope, base);
    } catch (err) {
      // Never log a private feed's token.
      const logged = path.replace(/^\/p\/[^/]+/, "/p/<token>");
      console.error(`${request.method} ${logged}: ${err instanceof Error ? err.stack : String(err)}`);
      return path.startsWith("/api/")
        ? fail(500, "Something went wrong on the server. Check the Worker's logs.")
        : new Response("Server error\n", { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const { expired, deleted } = await cleanUp(env);
          if (expired) console.log(`clean-up: ${expired} releases expired, ${deleted} files deleted`);
        } catch (err) {
          console.error(`clean-up: ${err instanceof Error ? err.stack : String(err)}`);
        }
        try {
          await abortStaleUploads(env);
        } catch (err) {
          console.error(`abort stale uploads: ${err instanceof Error ? err.stack : String(err)}`);
        }
      })(),
    );
  },
};
