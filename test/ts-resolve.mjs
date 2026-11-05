// Test-only resolver: lets `node --experimental-strip-types` load the
// extensionless relative TypeScript imports that Vercel's bundler resolves.
// Usage: node --experimental-strip-types --import ./test/ts-resolve.mjs test/<name>.mjs
import { register } from "node:module";

if (!globalThis.__tsResolveHook) {
  globalThis.__tsResolveHook = true;
  register("data:text/javascript," + encodeURIComponent(`
    export async function resolve(spec, ctx, next) {
      try { return await next(spec, ctx); }
      catch (e) {
        if (e && e.code === "ERR_MODULE_NOT_FOUND" && spec.startsWith(".") && !spec.endsWith(".ts")) return next(spec + ".ts", ctx);
        throw e;
      }
    }`), import.meta.url);
}
