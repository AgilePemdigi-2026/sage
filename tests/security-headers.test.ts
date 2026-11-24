import assert from "node:assert/strict";
import test from "node:test";
import nextConfig from "../apps/web/next.config.ts";
import { contentSecurityPolicy, securityHeaders, strictTransportSecurity } from "../apps/web/lib/security-headers.ts";

test("every route receives the baseline security headers", async () => {
  const rules = await nextConfig.headers?.();
  assert.ok(rules, "next.config.ts must define headers()");
  const all = rules.find(rule => rule.source === "/:path*");
  assert.ok(all, "headers must apply to every route");
  const map = new Map(all.headers.map(header => [header.key, header.value]));
  assert.equal(map.get("X-Frame-Options"), "DENY");
  assert.equal(map.get("X-Content-Type-Options"), "nosniff");
  assert.equal(map.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.equal(map.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(map.get("Content-Security-Policy-Report-Only"), contentSecurityPolicy);
  assert.equal(map.has("Content-Security-Policy"), false, "CSP stays report-only until violations are resolved");
  assert.equal(map.has("Strict-Transport-Security"), false, "HSTS depends on the runtime AUTH_BASE_URL and is set by proxy.ts");
  assert.equal(securityHeaders.length, map.size);
});

test("CSP report-only covers framing, avatars, and the GitHub login redirect", () => {
  const directives = new Map(contentSecurityPolicy.split("; ").map(part => {
    const [name, ...values] = part.split(" ");
    return [name, values] as const;
  }));
  assert.deepEqual(directives.get("default-src"), ["'self'"]);
  assert.deepEqual(directives.get("frame-ancestors"), ["'none'"]);
  assert.deepEqual(directives.get("connect-src"), ["'self'"]);
  assert.ok(directives.get("img-src")?.includes("https://avatars.githubusercontent.com"));
  assert.ok(directives.get("form-action")?.includes("https://github.com"));
});

test("HSTS is only emitted for an https AUTH_BASE_URL", () => {
  assert.equal(strictTransportSecurity("https://sage.example.org/"), "max-age=31536000; includeSubDomains");
  assert.equal(strictTransportSecurity("http://localhost:3000/"), null);
  assert.equal(strictTransportSecurity(undefined), null);
  assert.equal(strictTransportSecurity("not a url"), null);
});
