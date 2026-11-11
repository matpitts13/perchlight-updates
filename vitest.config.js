import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(root, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ADMIN_TOKEN: "test-admin-token",
            APP_NAME: "Test App",
            // R2's smallest multipart part, so tests can use small files.
            PART_SIZE: String(5 * 1024 * 1024),
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.js"],
      include: ["test/**/*.test.js"],
    },
  };
});
