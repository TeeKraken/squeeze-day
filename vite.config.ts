import { defineConfig } from "vitest/config";

// The same security headers Vercel sends (see vercel.json), so `vite preview`
// behaves like the live site.
const csp =
  "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'";

export default defineConfig({
  build: { target: "es2022" },
  worker: { format: "es" },
  preview: { headers: { "Content-Security-Policy": csp } },
  test: {
    // Tests run as if the device were in New York, so time zone handling is
    // checked against a zone with daylight saving (CI machines run in UTC).
    env: { TZ: "America/New_York" },
  },
});
