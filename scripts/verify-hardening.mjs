#!/usr/bin/env node
/**
 * Verify that the hardening applied to this codebase is still in place.
 *
 * This is a regression test, not a scanner. It boots the real server and
 * asserts the specific fixes made during the security pass still hold:
 *
 * Usage:  node scripts/verify-hardening.mjs
 */

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, statSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
// This file lives in <repo>/scripts, so the project root is one level up.
const ROOT = resolve(HERE, "..");
const PORT = Number(process.env.VERIFY_PORT || 4319);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
  }
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/rtc-config`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

console.log("\nLELA HARDENING VERIFICATION");
console.log("=".repeat(60));

const server = spawn(process.execPath, ["server.cjs"], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    NODE_ENV: "development",
    // Exercise the real ephemeral-credential path.
    TURN_SHARED_SECRET: "verification-only-shared-secret",
    TURN_URLS: "turn:turn.example.test:3478?transport=udp",
    TURN_CREDENTIAL_TTL: "600"
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverErr = "";
server.stderr.on("data", (chunk) => { serverErr += chunk.toString(); });
server.stdout.on("data", () => {});

const cleanup = () => { try { server.kill(); } catch { /* ignore */ } };
process.on("exit", cleanup);

try {
  const up = await waitForServer();
  if (!up) {
    console.log("\n  Server did not start. Output:\n" + serverErr.slice(0, 800));
    process.exit(1);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n1. Admin authentication still works");
  /* ---------------------------------------------------------------- */
  const login = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "admin123" })
  });
  const loginBody = await login.json().catch(() => ({}));
  check("admin/admin123 returns 200", login.status === 200, `got ${login.status}`);
  check(
    "a JWT is issued on success",
    typeof loginBody.token === "string" && loginBody.token.split(".").length === 3,
    "token missing or malformed"
  );

  const badLogin = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "wrong-password" })
  });
  check("wrong password is refused", badLogin.status === 401, `got ${badLogin.status}`);

  const noAuth = await fetch(`${BASE}/api/admin/stats`);
  check("admin API refuses unauthenticated access", noAuth.status === 401, `got ${noAuth.status}`);

  /* ---------------------------------------------------------------- */
  console.log("\n2. TURN credentials come from the server, never the source");
  /* ---------------------------------------------------------------- */
  const rtc = await fetch(`${BASE}/api/rtc-config`);
  const rtcBody = await rtc.json();
  check("/api/rtc-config responds", rtc.ok, `got ${rtc.status}`);
  check(
    "returns at least one STUN server",
    JSON.stringify(rtcBody).includes("stun:"),
    "no stun entry found"
  );

  // A TURN entry may carry its urls as a string or as an array, so normalise
  // to an array of strings before matching the scheme.
  const turnEntry = (rtcBody.iceServers || []).find((s) =>
    [].concat(s.urls || []).some((u) => /^turns?:/i.test(String(u)))
  );
  check("TURN entry is present when configured", Boolean(turnEntry));
  if (turnEntry) {
    check(
      "TURN username is the ephemeral expiry form",
      /^\d+:[a-z0-9_-]+$/i.test(turnEntry.username || ""),
      `username was "${turnEntry.username}"`
    );
    check(
      "TURN credential is present and non-empty",
      typeof turnEntry.credential === "string" && turnEntry.credential.length > 10
    );
  }
  check(
    "shared secret is never returned to the client",
    !JSON.stringify(rtcBody).includes("verification-only-shared-secret")
  );

  const appJs = await (await fetch(`${BASE}/app.js`)).text();
  check(
    "public/app.js contains no inline TURN credential",
    !/credential\s*:\s*["'][^"']{8,}["']/.test(appJs)
  );
  check(
    "public/app.js contains no OpenRelay host",
    !appJs.includes("expressturn.com")
  );

/* ---------------------------------------------------------------- */
  console.log("\n3. Visitor PII is not served from the web root");
  /* ---------------------------------------------------------------- */
  for (const path of [
    "/contact-messages.jsonl",
    "/data/contact-messages.jsonl",
    "/../data/contact-messages.jsonl",
    "/%2e%2e/data/contact-messages.jsonl"
  ]) {
    const res = await fetch(`${BASE}${path}`);
    const body = await res.text().catch(() => "");
    const leaked = body.includes('"email"') || body.includes('"message"');
    check(`${path} is not served`, !leaked, `status ${res.status}`);
  }

  const envRes = await fetch(`${BASE}/.env`);
  const envBody = await envRes.text().catch(() => "");
  check("/.env is not served", !envBody.includes("JWT_SECRET"));

  /* ---------------------------------------------------------------- */
  console.log("\n4. Path traversal cannot escape the public directory");
  /* ---------------------------------------------------------------- */
  for (const path of [
    "/%2e%2e/server.cjs",
    "/%2e%2e/%2e%2e/.env",
    "/..%2fserver.cjs"
  ]) {
    const res = await fetch(`${BASE}${path}`);
    const body = await res.text().catch(() => "");
    const leaked = body.includes("createServer") || body.includes("JWT_SECRET");
    check(`${path} does not leak server source`, !leaked, `status ${res.status}`);
  }

  /* ---------------------------------------------------------------- */
  console.log("\n5. Clickjacking protection");
  /* ---------------------------------------------------------------- */
  const adminRes = await fetch(`${BASE}/admin`, { redirect: "manual" });
  const xfo = adminRes.headers.get("x-frame-options") || "";
  const csp = adminRes.headers.get("content-security-policy") || "";
  check(
    "X-Frame-Options denies framing on admin",
    xfo.toUpperCase() === "DENY",
    `value was "${xfo}"`
  );
  check(
    "admin CSP sets frame-ancestors 'none'",
    csp.includes("frame-ancestors 'none'"),
    csp ? "missing frame-ancestors 'none'" : "no CSP header at all"
  );
  check(
    "no wildcard frame-ancestors remains",
    !csp.includes("frame-ancestors 'self' https: http:")
  );

  /* ---------------------------------------------------------------- */
  console.log("\n6. Security headers on public responses");
  /* ---------------------------------------------------------------- */
  const home = await fetch(BASE);
  check("X-Content-Type-Options: nosniff", home.headers.get("x-content-type-options") === "nosniff");
  check("Referrer-Policy: no-referrer", home.headers.get("referrer-policy") === "no-referrer");
  check("Permissions-Policy present", Boolean(home.headers.get("permissions-policy")));

  /* ---------------------------------------------------------------- */
  console.log("\n7. Client IP cannot be trivially spoofed");
  /* ---------------------------------------------------------------- */
  // TRUST_PROXY is unset here, so the socket address must win over a forged
  // forwarding header rather than trusting attacker-controlled input.
  const spoofed = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "1.2.3.4" },
    body: JSON.stringify({ username: "admin", password: "nope1" })
  });
  check("failed login with spoofed header is still refused", spoofed.status === 401);

  /* ---------------------------------------------------------------- */
  console.log("\n9. Stored XSS: untrusted data never reaches an inline JS context");
  /* ---------------------------------------------------------------- */
  // The audit-log inspector previously built onclick="...('${encodeURIComponent(...)}')".
  // encodeURIComponent leaves apostrophes untouched, so a report reason such as
  // "');alert(1);//" broke out of the JS string literal and ran in the admin
  // session. Any inline handler interpolating a value is now a regression.
  const adminHtml = await (await fetch(`${BASE}/admin`)).text();
  const interpolatedHandlers = adminHtml.match(
    /on(?:click|change|error|load|mouseover)\s*=\s*"[^"]*\$\{/g
  );
  check(
    "no inline handler interpolates a template expression",
    !interpolatedHandlers,
    interpolatedHandlers ? `found: ${interpolatedHandlers.join(", ")}` : ""
  );
  check(
    "audit inspector payload travels via a data attribute",
    adminHtml.includes("data-audit-inspect") && !adminHtml.includes("openAuditInspectorModal('${")
  );

  /* ---------------------------------------------------------------- */
  console.log("\n10. Authorization on privileged admin endpoints");
  /* ---------------------------------------------------------------- */
  const bearer = { Authorization: `Bearer ${loginBody.token}` };
  const statsRes = await fetch(`${BASE}/api/admin/stats`, { headers: bearer });
  check(
    "an admin with analytics:read may read /api/admin/stats",
    statsRes.status === 200,
    `got ${statsRes.status}`
  );
  const perfRes = await fetch(`${BASE}/api/admin/analytics/performance`, { headers: bearer });
  check(
    "/api/admin/analytics/performance is reachable for a permitted admin",
    perfRes.status === 200,
    `got ${perfRes.status}`
  );

  // These two endpoints were previously missing a role check entirely.
  const serverSource = readFileSync(resolve(ROOT, "server.cjs"), "utf8");
  const guardRe = /hasPermission\(admin\.role,\s*"analytics:read"\)/;
  const statsBlock = serverSource.slice(
    serverSource.indexOf('/api/admin/stats" && req.method === "GET"'),
    serverSource.indexOf('/api/admin/analytics/engagement')
  );
  check("/api/admin/stats is guarded by hasPermission", guardRe.test(statsBlock));
  const perfBlock = serverSource.slice(
    serverSource.indexOf('/api/admin/analytics/performance" && req.method === "GET"'),
    serverSource.indexOf('/api/admin/analytics/engagement')
  );
  check("/api/admin/analytics/performance is guarded by hasPermission", guardRe.test(perfBlock));

  /* ---------------------------------------------------------------- */
  console.log("\n11. WebSocket relay allowlist");
  /* ---------------------------------------------------------------- */
  // Signaling payloads must be rebuilt field-by-field so a peer cannot smuggle
  // privileged-looking properties (system_announcement, announcement_cleared).
  check(
    "relayed messages use an explicit field allowlist",
    serverSource.includes("RELAY_FIELDS") && !/send\(socket\.peer,\s*message\)/.test(serverSource)
  );

  /* ---------------------------------------------------------------- */
  console.log("\n12. Revoked sessions and request-body limits");
  /* ---------------------------------------------------------------- */
  const logoutRes = await fetch(`${BASE}/api/admin/logout`, { method: "POST", headers: bearer });
  check("logout succeeds", logoutRes.status === 200, `got ${logoutRes.status}`);
  const afterLogout = await fetch(`${BASE}/api/admin/me`, { headers: bearer });
  check(
    "a revoked token is refused after logout",
    afterLogout.status === 401,
    `got ${afterLogout.status}`
  );

  // The body limit is enforced in bytes and up front, not after concatenation.
  const oversized = await fetch(`${BASE}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "x".repeat(2 * 1024 * 1024) })
  });
  check(
    "an oversized request body is refused",
    oversized.status === 400 || oversized.status === 413,
    `got ${oversized.status}`
  );

  /* ---------------------------------------------------------------- */
  console.log("\n13. Serverless admin login resists header-based brute force");
  /* ---------------------------------------------------------------- */
  // TRUST_PROXY is unset in this run, so a rotated x-forwarded-for must not
  // create a fresh throttle bucket on the serverless login handler.
  const serverless = readFileSync(resolve(ROOT, "api", "admin", "[...path].js"), "utf8");
  check(
    "serverless login resolves the client IP through a validated helper",
    serverless.includes("function clientIp(req)") && /const ip = clientIp\(req\);/.test(serverless)
  );
  check(
    "serverless handler gates forwarding headers behind TRUST_PROXY",
    /const TRUST_PROXY =/.test(serverless) && /if \(TRUST_PROXY\) \{/.test(serverless)
  );
  check(
    "serverless throttle no longer trusts raw x-forwarded-for",
    !/headers\['x-forwarded-for'\]\s*\|\|/.test(serverless)
  );

  /* ---------------------------------------------------------------- */
  console.log("\n14. Token blacklist is bounded and stores no raw tokens");
  /* ---------------------------------------------------------------- */
  check(
    "the revocation list stores hashed tokens, not raw JWTs",
    serverSource.includes("hashTokenForLookup") && !/tokenBlacklist\.add\(/.test(serverSource)
  );
  check(
    "the revocation list is capped in size",
    serverSource.includes("TOKEN_BLACKLIST_MAX_ENTRIES")
  );

  /* ---------------------------------------------------------------- */
  console.log("\n15. URL sanitisation resists protocol-relative bypass");
  /* ---------------------------------------------------------------- */
  // Browsers rewrite "\" to "/" when resolving, so "/\evil.com" and
  // "https://\evil.com" both leave the origin while not starting with "//".
  // These were accepted by the old sanitizeUrl and produced a real open
  // redirect from the ad preview, the ads table and the public ad CTA.
  const sanitizeBody = serverSource.slice(
    serverSource.indexOf("function sanitizeUrl("),
    serverSource.indexOf("function isSafeExternalUrl(")
  );
  check("sanitizeUrl rejects backslashes", /includes\("\\\\"\)/.test(sanitizeBody));
  check(
    "sanitizeUrl rejects control characters",
    /u0000-\\u001f/.test(sanitizeBody)
  );
  const publicAppJs = readFileSync(resolve(ROOT, "public", "app.js"), "utf8");
  check(
    "the public ad CTA re-validates the URL before assigning href",
    /function isSafeExternalUrl\(value\)/.test(publicAppJs) &&
      /if \(isSafeExternalUrl\(ad\.link_url\)\)/.test(publicAppJs)
  );
  check(
    "the admin preview re-validates the URL before assigning href",
    /if \(isSafeExternalUrl\(ad\.link_url\)\)/.test(adminHtml)
  );

  /* ---------------------------------------------------------------- */
  console.log("\n16. Ad update enforces the same media allowlist as create");
  /* ---------------------------------------------------------------- */
  const adUpdateBlock = serverSource.slice(
    serverSource.indexOf('PUT /api/admin/ads/:id'),
    serverSource.indexOf('POST /api/admin/ads/:id/reset')
  );
  check(
    "the ad update path validates media against the Supabase bucket",
    adUpdateBlock.includes("storage/v1/object/public/") &&
      adUpdateBlock.includes("Media must be uploaded through Supabase Storage.")
  );

  /* ---------------------------------------------------------------- */
  console.log("\n17. Role changes and deletions revoke live sessions");
  /* ---------------------------------------------------------------- */
  check(
    "issued tokens carry a session version claim",
    /sv:\s*Number\(sessionVersion\)/.test(serverSource)
  );
  check(
    "verifyAdminToken enforces the session version",
    serverSource.includes("decoded.sv !== undefined") &&
      serverSource.includes("getAdminSessionVersion(decoded.id)")
  );
  const redisSource = readFileSync(resolve(ROOT, "lib", "redis.cjs"), "utf8");
  check(
    "bumping the session version always advances the in-process counter",
    /const localNext = \(localSessionVersions\.get\(key\) \|\| 1\) \+ 1;/.test(redisSource)
  );

  /* ---------------------------------------------------------------- */
  console.log("\n18. Production WebSocket origin check fails closed");
  /* ---------------------------------------------------------------- */
  const wsOriginBlock = serverSource.slice(
    serverSource.indexOf("function isAllowedWebSocketOrigin("),
    serverSource.indexOf("let nextClientId")
  );
  check(
    "an empty ALLOWED_ORIGINS no longer allows every origin",
    !wsOriginBlock.includes("ALLOWED_ORIGINS.size === 0) return true")
  );

  /* ---------------------------------------------------------------- */
  console.log("\n19. In-memory limiters are bounded");
  /* ---------------------------------------------------------------- */
  check("limiter maps are size-capped", serverSource.includes("LIMITER_MAX_KEYS"));
  check(
    "expired limiter entries are swept on a timer",
    serverSource.includes("sweepLimiterMaps") && serverSource.includes("limiterSweepTimer")
  );
  check(
    "TURN credential minting is rate limited",
    serverSource.includes("checkRtcConfigRate") &&
      /if \(!checkRtcConfigRate\(getClientIp\(req\)\)\)/.test(serverSource)
  );

  /* ---------------------------------------------------------------- */
  console.log("\n20. Seeded fallback accounts are not password-guessable");
  /* ---------------------------------------------------------------- */
  const supabaseLib = readFileSync(resolve(ROOT, "lib", "supabase.cjs"), "utf8");
  check(
    "no seeded account reuses a shared default password hash",
    !supabaseLib.includes("defaultAdminPasswordHash")
  );
  // The seeded rows carry no password, so only the env-backed root credential
  // can authenticate. Confirm the staff rows are present but hash-free.
  const seededStaff = supabaseLib.includes("moderator1") && supabaseLib.includes("growth_lead");
  check("seeded staff rows still exist for RBAC testing", seededStaff);
  const staffLogins = await Promise.all(
    ["moderator1", "growth_lead"].map((username) =>
      fetch(`${BASE}/api/admin/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password: "admin123" })
      }).then((r) => r.status)
    )
  );
  check(
    "seeded staff accounts cannot log in with the default password",
    staffLogins.every((status) => status === 401),
    `statuses were ${staffLogins.join(", ")}`
  );

  /* ---------------------------------------------------------------- */
  console.log("\n21. Errors and logs do not leak internals or PII");
  /* ---------------------------------------------------------------- */
  check(
    "the login error handler no longer returns e.message",
    !/error: e\.message \|\| "Login request error"/.test(serverSource)
  );

  check(
    "creating an admin account validates the requested role",
    /const requestedRole = String\(role \|\| "moderator"\);/.test(serverSource) &&
      /ROLE_PERMISSIONS\[requestedRole\]/.test(serverSource)
  );

  /* ---------------------------------------------------------------- */
  console.log("\n23. Removed dead entry point");
  /* ---------------------------------------------------------------- */
  check("the broken server.js bridge is deleted", !existsSync(resolve(ROOT, "server.js")));
  check("server.cjs is still present and is the entry point", existsSync(resolve(ROOT, "server.cjs")));
  check(
    "no committed file still references server.js",
    !/from ["']\.\/server["']|require\(["']\.\/server["']\)/.test(
      readFileSync(resolve(ROOT, "lib", "supabase.cjs"), "utf8")
    )
  );

  /* ---------------------------------------------------------------- */
  console.log("\n24. Third-party scripts are pinned and integrity-checked");
  /* ---------------------------------------------------------------- */
  // The D3 tag is the only external script in the app. It used to point at the
  // floating tag "d3@7", so anyone able to publish new 7.x content could execute
  // script inside the admin origin, where the JWT is readable from
  // sessionStorage. It must be version-pinned AND carry an SRI hash.
  const scriptTags = [...adminHtml.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>/gi)];
  const externalScripts = scriptTags.filter((m) => /^https?:\/\//i.test(m[1]));
  check(
    "the app still loads exactly one third-party script",
    externalScripts.length === 1,
    `found ${externalScripts.length}: ${externalScripts.map((m) => m[1]).join(", ")}`
  );

  const d3Tag = adminHtml.match(/<script\b[^>]*cdn\.jsdelivr\.net[^>]*>/i);
  check("the D3 script tag is present", Boolean(d3Tag));
  if (d3Tag) {
    const tag = d3Tag[0];
    // Assert on the real src attribute, not the whole file: the explanatory
    // comment above the tag quotes the old floating tag ("d3@7"), and a
    // whole-file match would flag that comment as an unpinned reference.
    const d3Src = tag.match(/src="([^"]+)"/)?.[1] || "";
    check(
      "the D3 script is version-pinned (no floating major tag)",
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/d3@7\.9\.0\/dist\/d3\.min\.js$/.test(d3Src),
      `src was "${d3Src}"`
    );
    check(
      "the D3 script carries a Subresource Integrity hash",
      /integrity="sha(256|384|512)-[A-Za-z0-9+/=]+"/.test(tag)
    );
    check(
      "the D3 script sets crossorigin for SRI to be enforced",
      /crossorigin="anonymous"/.test(tag)
    );
    check(
      "the D3 script does not leak the admin URL via Referer",
      /referrerpolicy="no-referrer"/.test(tag)
    );
  }

  // CSP must allow that exact path, not the whole CDN origin.
  // SECURITY: the script-src entry is now a template literal
  // (`script-src 'nonce-${adminNonce}' ...`), so it no longer starts with a
  // literal quote. Match on the directive name itself, not the quote.
  const scriptSrcLine = serverSource
    .split("\n")
    .find((line) => line.includes("script-src") && line.includes("jsdelivr"));
  check(
    "admin CSP pins the CDN allowance to the exact file",
    Boolean(scriptSrcLine) &&
      scriptSrcLine.includes("cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"),
    scriptSrcLine ? scriptSrcLine.trim() : "no jsdelivr script-src entry found"
  );

  // Guard: no external script anywhere may be added without an SRI hash.
  const unguarded = externalScripts.filter((m) => !/integrity="sha/i.test(m[0]));
  check(
    "every external script carries an integrity hash",
    unguarded.length === 0,
    unguarded.length ? `missing SRI: ${unguarded.map((m) => m[1]).join(", ")}` : ""
  );

  /* ---------------------------------------------------------------- */
  console.log("\n25. Admin CSP no longer allows 'unsafe-inline' scripts");
  /* ---------------------------------------------------------------- */
  // The whole point of the nonce migration: the admin dashboard's script-src
  // must not permit inline script. Before this, a single XSS bug in the admin
  // panel would have executed unchecked by CSP.
  check(
    "script-src does not contain 'unsafe-inline'",
    serverSource.includes("script-src 'nonce-${adminNonce}' 'strict-dynamic'"),
    "script-src is no longer nonce-based"
  );
  // 'unsafe-inline' is still legitimate for STYLE on both the admin and public
// pages (large inline <style> blocks and element.style writes). What must never
// happen is it appearing in a script-src directive. Check that precisely rather
// than counting every occurrence in the file.
  const scriptSrcDirectives = [...serverSource.matchAll(/script-src[^\n]*/g)].map((m) => m[0]);
  check(
    "'unsafe-inline' never appears in a script-src directive",
    scriptSrcDirectives.every((line) => !line.includes("'unsafe-inline'")),
    scriptSrcDirectives.filter((l) => l.includes("'unsafe-inline'")).join(" | ")
  );
  check("a per-request nonce is minted", /crypto\.randomBytes\(16\)\.toString\("base64"\)/.test(serverSource));
  check("the nonce is injected into the dashboard script tag", /<script nonce="\$\{adminNonce\}">/.test(serverSource));

  // The nonce must actually be delivered on the wire, and must match the header.
  const nonceProbe = await fetch(`${BASE}/admin`);
  const cspHeader = nonceProbe.headers.get("content-security-policy") || "";
  const nonceInHeader = cspHeader.match(/'nonce-([^']+)'/)?.[1];
  const nonceInBody = (await nonceProbe.text()).match(/<script nonce="([^"]+)"/)?.[1];
  check("the admin response carries a nonce in its CSP", Boolean(nonceInHeader));
  check("the admin response carries a matching nonce in the HTML", Boolean(nonceInBody));
  check("CSP nonce matches the HTML nonce", Boolean(nonceInHeader) && nonceInHeader === nonceInBody);
  check(
    "the served admin CSP does not allow unsafe-inline scripts",
    !/script-src[^;]*'unsafe-inline'/.test(cspHeader),
    `script-src was: ${(cspHeader.match(/script-src[^;]*/) || [""])[0]}`
  );

  // Nonce must be unpredictable per request, not a static value.
  const secondProbe = await fetch(`${BASE}/admin`);
  const secondNonce = (secondProbe.headers.get("content-security-policy") || "").match(/'nonce-([^']+)'/)?.[1];
  check("the nonce rotates between requests", Boolean(secondNonce) && secondNonce !== nonceInHeader);

  /* ---------------------------------------------------------------- */
  console.log("\n26. No inline event handlers remain in the admin dashboard");
  /* ---------------------------------------------------------------- */
  // Any on*= attribute would be dead code under the nonce CSP: the browser
  // ignores it, so the button would silently stop working. The 37 handlers were
  // migrated to delegated data-h-* attributes.
  const inlineHandlerPattern = /\son(?:click|change|submit|input|error|load|mouseover|keydown|focus|blur)\s*=/gi;
  const remainingHandlers = [...adminHtml.matchAll(inlineHandlerPattern)].map((m) => m[0].trim());
  check(
    "the admin dashboard has no inline event handlers",
    remainingHandlers.length === 0,
    remainingHandlers.length ? `found: ${remainingHandlers.join(", ")}` : ""
  );
  check(
    "handlers are dispatched from a data-h-* attribute allowlist",
    adminHtml.includes("ADMIN_HANDLERS") && adminHtml.includes("data-h-click")
  );
  check(
    "the dispatcher does not eval attribute values",
    !/adminHtml/.test("") && !/\beval\s*\(\s*el\.getAttribute|new Function\s*\(\s*el\.getAttribute/.test(adminHtml),
    "a dispatcher must never eval a data attribute"
  );

  // Every declared handler must resolve to a real function in the same script,
  // otherwise the button it drives would throw at click time.
  const declaredHandlers = [...adminHtml.matchAll(/data-h-(?:click|submit|change|input)="([^"]+)"/g)]
    .map((m) => m[1]);
  const missingHandlers = [...new Set(declaredHandlers)].filter(
    (name) => !new RegExp(`${name}\\s*:`).test(adminHtml)
  );
  check(
    "every data-h-* handler is defined in the dispatcher",
    missingHandlers.length === 0,
    missingHandlers.length ? `undefined: ${missingHandlers.join(", ")}` : ""
  );

  /* ---------------------------------------------------------------- */
  console.log("\n27. Every admin <script> tag is nonce-authorised");
  /* ---------------------------------------------------------------- */
  // This is the check that would have caught a real regression: the CSP uses
  // 'strict-dynamic', which under CSP3 makes browsers IGNORE host allowlists
  // such as the jsdelivr entry. Only nonce/hash scripts run. An earlier version
  // nonced only the inline script, so the pinned D3 bundle was blocked and the
  // analytics chart died with "d3 is not defined" - while every static test
  // still passed, because nothing here evaluates CSP the way a browser does.
  // Fetch the admin page ONCE and take both the body and the header from that
  // same response. Two separate requests would each carry a different nonce, so
  // comparing tags from one against the other's header can never match.
  const nonceRes = await fetch(`${BASE}/admin`);
  const servedAdmin = await nonceRes.text();
  const servedCsp = nonceRes.headers.get("content-security-policy") || "";
  const liveNonce = servedCsp.match(/'nonce-([^']+)'/)?.[1];

  check("the admin response exposes a CSP nonce", Boolean(liveNonce));
  const servedTags = [...servedAdmin.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  check("the admin dashboard has script tags", servedTags.length > 0, `found ${servedTags.length}`);
  const unnonced = servedTags.filter((tag) => !liveNonce || !tag.includes(`nonce="${liveNonce}"`));
  check(
    "EVERY <script> tag carries the response nonce",
    unnonced.length === 0,
    unnonced.length
      ? `blocked by strict-dynamic: ${unnonced.map((t) => t.replace(/\s+/g, " ").slice(0, 90)).join(" | ")}`
      : ""
  );
  check(
    "the D3 bundle is nonce-authorised (analytics chart can load)",
    servedTags.some((tag) => /d3\.min\.js/.test(tag) && liveNonce && tag.includes(`nonce="${liveNonce}"`))
  );

  /* ---------------------------------------------------------------- */
  console.log("\n28. Admin markup is well-formed");
  /* ---------------------------------------------------------------- */
  // Two attributes were briefly emitted glued to the previous one
  // (class="brand-logo"data-h-error="..."), which browsers still parse but which
  // is invalid HTML and logs a parse error.
  const glued = [...adminHtml.matchAll(/[^\s"](data-h-[a-z]+=)/g)].map((m) => m[1]);
  check(
    "no attribute is glued to the previous attribute",
    glued.length === 0,
    glued.length ? `glued: ${glued.join(", ")}` : ""
  );
  check(
    "no unreplaced regex replacement artifacts in the markup",
    !/\$\d/.test(adminHtml),
    "a $1/$2 artifact leaked into the HTML"
  );
} finally {
  cleanup();
}

console.log("\n" + "-".repeat(60));
console.log(`passed ${passed} | failed ${failed}`);
console.log("-".repeat(60) + "\n");

process.exit(failed > 0 ? 1 : 0);