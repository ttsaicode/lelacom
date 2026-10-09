"use strict";

/**
 * WebRTC / TURN configuration.
 *
 * Security model
 * --------------
 * TURN credentials MUST reach the browser, so they can never be truly
 * secret. What we CAN control is how long they stay valid and whether
 * they are ever written into committed source.
 *
 * If neither is configured we still return the public STUN servers. Peers on
 * most networks can connect with STUN alone, so video calling keeps working
 * and we never break the app because a secret is missing.
 */

const crypto = require("crypto");

const DEFAULT_STUN_URLS = [
  "stun:stun.l.google.com:19302",
  "stun:stun1.l.google.com:19302"
];

const MIN_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_TTL_SECONDS = 60 * 60;

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function splitList(value) {
  return clean(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getStunUrls() {
  const configured = splitList(process.env.STUN_URLS);
  return configured.length ? configured : DEFAULT_STUN_URLS.slice();
}

/**
 * coturn shared-secret credential format:
 *   username  = <unix expiry>:<optional label>
 *   credential = base64(HMAC-SHA1(sharedSecret, username))
 */
function buildEphemeralTurnEntry(secret, urls, ttlSeconds, label) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const username = `${nowSeconds + ttlSeconds}:${label || "lela"}`;
  const credential = crypto
    .createHmac("sha1", secret)
    .update(username)
    .digest("base64");

  return { urls, username, credential };
}

function getTurnCredentialTtl() {
  const parsed = Number.parseInt(clean(process.env.TURN_CREDENTIAL_TTL), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_TTL_SECONDS;
  return Math.min(MAX_TTL_SECONDS, Math.max(MIN_TTL_SECONDS, parsed));
}

/**
 * Build the public RTC configuration served to browsers.
 * Never returns the shared secret itself.
 */
function getRtcConfiguration() {
  const iceServers = getStunUrls().map((urls) => ({ urls }));

  const turnUrls = splitList(process.env.TURN_URLS);
  const sharedSecret = clean(process.env.TURN_SHARED_SECRET);

  if (turnUrls.length && sharedSecret) {
    // Preferred: short-lived credentials derived from a server-only secret.
    iceServers.push(
      buildEphemeralTurnEntry(
        sharedSecret,
        turnUrls,
        getTurnCredentialTtl(),
        clean(process.env.TURN_USER_LABEL) || "lela"
      )
    );
    return { iceServers };
  }

  if (turnUrls.length) {
    // No shared secret, but a static pair was supplied through the env.
    const staticUsername = clean(process.env.TURN_USERNAME);
    const staticCredential = clean(process.env.TURN_CREDENTIAL);
    if (staticUsername && staticCredential) {
      iceServers.push({
        urls: turnUrls,
        username: staticUsername,
        credential: staticCredential
      });
    }
  }

  return { iceServers };
}

/** True when a relay is actually available, not just STUN. */
function hasTurnRelay() {
  return getRtcConfiguration().iceServers.some((server) =>
    Array.isArray(server.urls)
      ? server.urls.some((url) => /^turns?:/i.test(url))
      : /^turns?:/i.test(server.urls)
  );
}

module.exports = {
  getRtcConfiguration,
  hasTurnRelay,
  getTurnCredentialTtl
};