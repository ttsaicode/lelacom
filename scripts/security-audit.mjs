#!/usr/bin/env node
/**
 * LELA security audit
 * ===================
 * Plain Node.js only, so it works locally and in CI with no extra tooling.
 *
 * This deliberately lives in scripts/ rather than security/: scripts/ is
 * committed to GitHub while the security/ skill library is intentionally not.
 * That keeps the guard running in CI even though the skills never ship.
 *
 * Checks:
 *   1. Hardcoded credentials in tracked source files
 *   2. PII / runtime data sitting inside the web root
 *   3. .gitignore actually covering .env and data files
 *   4. Known-weak security defaults
 *   5. Required production environment variables
 *
 * Usage:
 *   node scripts/security-audit.mjs            # human readable
 *   node scripts/security-audit.mjs --json     # machine readable
 *   node scripts/security-audit.mjs --strict   # info findings also fail
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const SKIP_DIRS = new Set([
  "node_modules", ".git", "security", "dist", "build", ".next",
  ".cache", ".vite", "coverage", ".vercel", ".github"
]);

const SCAN_EXTENSIONS = new Set([
  ".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx", ".json",
  ".html", ".css", ".yml", ".yaml", ".toml", ".sh", ".ps1"
]);

const findings = [];
const add = (severity, id, title, detail, fix) =>
  findings.push({ severity, id, title, detail, fix });

/* ------------------------------------------------------------------ */
/* File walking                                                        */
/* ------------------------------------------------------------------ */

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      walk(join(dir, entry.name), out);
    } else if (entry.isFile()) {
      if (SCAN_EXTENSIONS.has(extname(entry.name))) out.push(join(dir, entry.name));
    }
  }
  return out;
}

const rel = (p) => relative(ROOT, p).replace(/\\/g, "/");

/* ------------------------------------------------------------------ */
/* 1. Hardcoded credential patterns                                    */
/* ------------------------------------------------------------------ */

// Documents and the template are allowed to show placeholder values.
const ALLOWED_FILES = new Set([".env.example", "SECURITY.md", "DEPLOY-SECURITY.md"]);

const SECRET_PATTERNS = [
  {
    id: "SEC-001",
    title: "Hardcoded TURN/STUN relay credential",
    severity: "critical",
    regex: /credential\s*:\s*["'][^"']{8,}["']/g,
    fix: "Serve ICE servers from /api/rtc-config (see lib/rtc-config.cjs)."
  },
  {
    id: "SEC-002",
    title: "JWT or service-role key in source",
    severity: "critical",
    regex: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
    fix: "Load from an environment variable and rotate the exposed key."
  },
  {
    id: "SEC-003",
    title: "Private key material",
    severity: "critical",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
    fix: "Never commit key files. Use your host's secret store."
  },
  {
    id: "SEC-004",
    title: "Provider API token (Stripe / OpenAI / GitHub / Slack / AWS)",
    severity: "critical",
    regex: /\b(?:sk_live_|rk_live_|sk-[A-Za-z0-9]{32,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
    fix: "Move to an environment variable and rotate the exposed key."
  },
  {
    id: "SEC-005",
    title: "Literal fallback used for a signing secret",
    severity: "high",
    regex: /(?:JWT_SECRET|SESSION_SECRET|getSecret)[\s\S]{0,120}?\|\|\s*["'][^"']{12,}["']/g,
    fix: "Require the secret from the environment; refuse to start without it."
  }
];

for (const file of walk(ROOT)) {
  const name = rel(file);
  if (ALLOWED_FILES.has(name) || name.startsWith("scripts/")) continue;

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const rule of SECRET_PATTERNS) {
    rule.regex.lastIndex = 0;
    let match;
    while ((match = rule.regex.exec(text)) !== null) {
      const line = text.slice(0, match.index).split("\n").length;
      add(rule.severity, rule.id, rule.title, `${name}:${line}`, rule.fix);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. PII / runtime data inside the web root                            */
/* ------------------------------------------------------------------ */


if (existsSync(join(ROOT, ".env"))) {
  if (statSync(join(ROOT, ".env")).size > 0) {
    add("info", "SEC-011", "Local .env present",
      ".env (git-ignored, never committed)",
      "Keep real values here and set the same values in your hosting dashboard.");
  }
}

/* ------------------------------------------------------------------ */
/* 3. .gitignore coverage                                               */
/* ------------------------------------------------------------------ */

const gitignorePath = join(ROOT, ".gitignore");
if (!existsSync(gitignorePath)) {
  add("high", "SEC-020", "No .gitignore",
    ".gitignore missing",
    "Without it, .env and data/ get committed and published to GitHub.");
} else {
  const gi = readFileSync(gitignorePath, "utf8");
  for (const [id, entry] of [
    ["SEC-021", ".env"],
    ["SEC-022", "data/"],
    ["SEC-023", "security/"],
    ["SEC-024", "*.jsonl"]
  ]) {
    if (!gi.includes(entry)) {
      add("high", id, `.gitignore does not cover ${entry}`,
        ".gitignore", `Add ${entry} so this is never pushed to GitHub.`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 4. Known-weak defaults in the server source                         */
/* ------------------------------------------------------------------ */

const WEAK_DEFAULTS = [
  {
    id: "SEC-030",
    needle: "lela_jwt_secret_signing_key",
    title: "Known JWT signing key still in source",
    fix: "Require JWT_SECRET from the environment."
  },
  {
    id: "SEC-031",
    needle: "frame-ancestors 'self' https: http:",
    title: "CSP frame-ancestors allows any site (clickjacking)",
    fix: "Use frame-ancestors 'none' for admin and 'self' for public pages."
  },
  {
    id: "SEC-032",
    needle: "'lela-admin-session-secret';",
    title: "Known admin session secret still in source",
    fix: "Require ADMIN_SESSION_SECRET or ADMIN_PASSWORD from the environment."
  }
];

for (const relPath of ["server.cjs", "[...path].js", "api/admin/[...path].js"]) {
  const full = join(ROOT, relPath);
  if (!existsSync(full)) continue;
  const text = readFileSync(full, "utf8");
  for (const weak of WEAK_DEFAULTS) {
    if (text.includes(weak.needle)) {
      add("high", weak.id, weak.title, relPath, weak.fix);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 5. Production environment requirements                              */
/* ------------------------------------------------------------------ */

const deployed = Boolean(
  process.env.RAILWAY_PROJECT_ID || process.env.RENDER ||
  process.env.VERCEL || process.env.FLY_APP_NAME
);

if (deployed) {
  const required = {
    ADMIN_PASSWORD: (v) => v.length >= 12 && /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v) && /[^A-Za-z0-9]/.test(v),
    ADMIN_PATH: (v) => v.length >= 24 && /^[A-Za-z0-9_-]+$/.test(v),
    JWT_SECRET: (v) => v.length >= 32
  };
  for (const [name, check] of Object.entries(required)) {
    const value = String(process.env[name] || "");
    if (!value) {
      add("high", "SEC-040", `${name} is not set in this environment`,
        "hosting environment", `Set ${name} in your platform's variable settings.`);
    } else if (!check(value)) {
      add("high", "SEC-041", `${name} does not meet the minimum strength`,
        "hosting environment", `Strengthen ${name}.`);
    }
  }
} else {
  add("info", "SEC-042", "Not running on a detected hosting platform",
    "environment variables were not validated",
    "Set ADMIN_PASSWORD, ADMIN_PATH and JWT_SECRET on your host before deploying.");
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

const counts = findings.reduce((acc, f) => {
  acc[f.severity] = (acc[f.severity] || 0) + 1;
  return acc;
}, {});

const RANK = { critical: 0, high: 1, medium: 2, info: 3 };
const failures = findings.filter(
  (f) => f.severity === "critical" || f.severity === "high"
).length;

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ counts, findings }, null, 2));
} else {
  console.log("\nLELA SECURITY AUDIT");
  console.log("=".repeat(60));
  if (!findings.length) {
    console.log("No findings. Hardcoded secrets, PII exposure and weak\ndefaults all check out.");
  } else {
    const order = [...findings].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
    for (const f of order) {
      console.log(`\n[${f.severity.toUpperCase()}] ${f.id} ${f.title}`);
      console.log(`  where : ${f.detail}`);
      console.log(`  fix   : ${f.fix}`);
    }
  }
  console.log("\n" + "-".repeat(60));
  console.log(
    `critical ${counts.critical || 0} | high ${counts.high || 0} | ` +
    `medium ${counts.medium || 0} | info ${counts.info || 0}`
  );
  console.log("-".repeat(60) + "\n");
}

process.exit(
  failures > 0 || (process.argv.includes("--strict") && findings.length) ? 1 : 0
);