"use strict";

/* ============================================================
   DOM ELEMENTS
   ============================================================ */

const localVideo = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

const localPlaceholder = document.getElementById("localPlaceholder");
const remotePlaceholder = document.getElementById("remotePlaceholder");

const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const nextButton = document.getElementById("nextButton");
const recordButton = document.getElementById("recordButton");

const chatToggleButton = document.getElementById("chatToggleButton");
const reportButton = document.getElementById("reportButton");

const statusElement = document.getElementById("status");
const onlineCountElement = document.getElementById("onlineCountText");

const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");
const sendChatButton = document.getElementById("sendChatButton");

const reportModalBackdrop = document.getElementById("reportModalBackdrop");
const cancelReportButton = document.getElementById("cancelReportButton");
const submitReportButton = document.getElementById("submitReportButton");

const recordingStatus = document.getElementById("recordingStatus");
const recordingTime = document.getElementById("recordingTime");

const recordingResultBackdrop = document.getElementById("recordingResultBackdrop");
const recordingResultText = document.getElementById("recordingResultText");
const recordingPreview = document.getElementById("recordingPreview");
const downloadRecordingButton = document.getElementById("downloadRecordingButton");
const deleteRecordingButton = document.getElementById("deleteRecordingButton");
const recordingFormatSelect = document.getElementById("recordingFormatSelect");

const broadcastBanner = document.getElementById("broadcastBanner");
const broadcastMessage = document.getElementById("broadcastMessage");

// Sponsored Ads Elements
const adContainer = document.getElementById("sponsoredBannerContainer");
const adCard = document.getElementById("sponsoredCard");
const adMediaSlot = document.getElementById("sponsoredMediaSlot");
const adTitleEl = document.getElementById("sponsoredTitle");
const adDescEl = document.getElementById("sponsoredDesc");
const adCtaEl = document.getElementById("sponsoredCta");
const adCloseBtn = document.getElementById("sponsoredCloseBtn");
const strangerAdSlot = document.getElementById("strangerAdSlot");
const swapLayoutBtn = document.getElementById("swapLayoutBtn");
const videoGridEl = document.getElementById("videoGrid");

// SECURITY: mirror of the server-side sanitizeUrl(), applied before an ad URL is
// assigned to an href. Browsers rewrite a backslash to a forward slash when
// resolving a URL, so "https://\evil.com" passes a naive /^https?:\/\// test yet
// still navigates to evil.com. Reject backslashes and control characters, and
// allow only explicit http(s) absolute URLs.
function isSafeExternalUrl(value) {
  const candidate = String(value == null ? "" : value).trim();
  if (!candidate) return false;
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return false;
  if (candidate.includes("\\")) return false;
  return /^https?:\/\//i.test(candidate);
}

// Mobile layout swap handler
let isLayoutSwapped = false;
if (swapLayoutBtn && videoGridEl) {
  swapLayoutBtn.addEventListener("click", () => {
    isLayoutSwapped = !isLayoutSwapped;
    videoGridEl.classList.toggle("swapped", isLayoutSwapped);
    swapLayoutBtn.classList.toggle("active", isLayoutSwapped);
  });
}

/* ============================================================
   WEBRTC CONFIGURATION
   ============================================================ */

// ICE servers are fetched from the server at startup instead of being embedded
// here. TURN credentials used to be hardcoded in this public file, which meant
// anyone could read them and relay traffic through the account for free.
//
// SECURITY: the server holds the TURN secret and hands out short-lived
// credentials (see lib/rtc-config.cjs). The fallback below is STUN only, which
// needs no credentials and works on most networks, so video calling still
// functions even if the endpoint is unreachable.
let rtcConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" }
  ],
  iceTransportPolicy: "all",
  iceCandidatePoolSize: 2,
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require"
};

/**
 * Load the server-provided RTC configuration.
 * Any failure leaves the STUN-only defaults in place.
 */
async function loadRtcConfiguration() {
  // Abort after 4s so a slow endpoint can never block the first call.
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const abortTimer = controller ? setTimeout(() => controller.abort(), 4000) : null;
  try {
    const response = await fetch("/api/rtc-config", {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller ? controller.signal : undefined
    });
    if (!response.ok) return;

    const config = await response.json();
    if (config && Array.isArray(config.iceServers) && config.iceServers.length) {
      rtcConfiguration = {
        ...rtcConfiguration,
        iceServers: config.iceServers
      };
    }
  } catch (_) {
    // Offline or endpoint unavailable: keep the STUN-only defaults.
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
  }
}

// Kick this off immediately on page load. It runs in parallel with the camera
// permission prompt, and startCamera() waits for it (it never rejects) before
// matchmaking starts, so the first RTCPeerConnection always has TURN ready.
const rtcConfigReady = loadRtcConfiguration();

/* ============================================================
   STATE
   ============================================================ */

let localStream = null;
let peerConnection = null;
let socket = null;
let chatChannel = null;
let pendingIceCandidates = [];
let hasStartedCamera = false;
let isMatched = false;
let chatEnabled = true;

let mediaRecorder = null;
let recordingChunks = [];
let recordingCanvas = null;
let recordingContext = null;
let recordingCanvasStream = null;
let recordingAnimationFrame = null;
let recordingTimer = null;
let recordingStartedAt = 0;
let recordingElapsedMs = 0;

let recordingAudioContext = null;
let recordingAudioDestination = null;
let recordingAudioSources = [];
let recordingRemoteAudioSource = null;

let completedRecordingBlob = null;
let completedRecordingUrl = null;

// Dynamic Ads State
let activeAdsList = [];
let currentAdIndex = 0;
let adRotationTimer = null;
let adDismissed = false;
let adDisplayEligible = false;

// Number of SUCCESSFUL Next jumps since the last ad was served. A press of the
// Next button is only counted once it actually produces a new match, so skipped
// or failed attempts never earn an ad impression.
let nextClicksSinceAd = 0;

// Armed by nextStranger() and confirmed by the next "matched" signal.
let awaitingNextConfirmation = false;

const NEXTS_PER_AD = 5;

// WebSocket connection state. We pre-connect as soon as the app page loads,
// then only send `ready` once the camera is available. This removes the old
// 150 ms polling delay after every camera start/reconnect.
let socketReconnectTimer = null;
let socketReconnectDelay = 350;
let wantsMatchQueue = false;
let lastReadySentAt = 0;

/* ============================================================
   DEBUG & STATUS HELPERS
   ============================================================ */

function debug(...args) { console.log("[LELA]", ...args); }

function setStatus(message) {
  if (statusElement) statusElement.textContent = message;
  debug(message);
}

function updateVideoPlaceholders() {
  if (localPlaceholder) {
    localPlaceholder.style.display = localStream ? "none" : "flex";
  }
  if (remotePlaceholder) {
    remotePlaceholder.style.display = (remoteVideo && remoteVideo.srcObject) ? "none" : "flex";
  }
}

function updateMatchButtons() {
  if (nextButton) nextButton.disabled = !isMatched;
  if (reportButton) reportButton.disabled = !isMatched;
  if (chatToggleButton) chatToggleButton.disabled = !isMatched;

  updateRecordButton();

  if (isMatched && chatToggleButton) {
    chatToggleButton.innerHTML = chatEnabled
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg> Chat: ON'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg> Chat: OFF';
  }
}

function updateStopButton() {
  if (stopButton) stopButton.disabled = !hasStartedCamera;
}

function applyChatState() {
  const chatPanel = document.querySelector(".chat-panel");
  if (chatPanel) chatPanel.classList.toggle("chat-off", !chatEnabled);
  if (chatInput) {
    chatInput.disabled = !chatEnabled || isMaintenanceLocked;
    chatInput.placeholder = isMaintenanceLocked ? "Maintenance active" : (chatEnabled ? "Type a message..." : "Chat is off");
  }
  if (sendChatButton) {
    sendChatButton.disabled = !chatEnabled || isMaintenanceLocked;
  }
}

/* ============================================================
   ADMIN-CONTROLLED SPONSORED ADS ENGINE
   ============================================================ */

let adSettings = {
  enabled: true,
  defaultPlacement: "bottom-left",
  rotationSeconds: 12,
  allowDismiss: true,
  redisplayOnRotate: true
};

function isMobileOrCompressedViewport() {
  return window.innerWidth <= 768 || /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

function hideAllAds() {
  if (adContainer) adContainer.classList.remove("show", "stranger-overlay", "below-video", "corner");
  if (strangerAdSlot) strangerAdSlot.classList.remove("show");
}

function placeAdContainer(placement) {
  if (!adContainer) return;
  const videoGrid = document.getElementById("videoGrid");
  const mainContainer = videoGrid ? videoGrid.parentElement : null;
  adContainer.classList.remove("stranger-overlay", "below-video", "corner");

  if (placement === "stranger-overlay" && strangerAdSlot) {
    strangerAdSlot.appendChild(adContainer);
    strangerAdSlot.classList.add("show");
    adContainer.classList.add("stranger-overlay");
    return;
  }

  if (strangerAdSlot) strangerAdSlot.classList.remove("show");

  if (placement === "corner") {
    document.body.appendChild(adContainer);
    adContainer.classList.add("corner");
    return;
  }

  if (mainContainer && videoGrid) {
    mainContainer.insertBefore(adContainer, videoGrid.nextSibling);
  }
  adContainer.classList.add("below-video");
}

async function initAdsEngine() {
  try {
    const res = await fetch("/api/ads");
    if (!res.ok) return;
    const data = await res.json();
    if (data.settings) {
      adSettings = Object.assign(adSettings, data.settings);
    }
    if (adSettings.enabled === false) {
      activeAdsList = [];
      hideAllAds();
      return;
    }
    activeAdsList = Array.isArray(data.ads) ? data.ads : [];

    // Ads are loaded silently. If the user has already entered the camera
    // experience, show the first ad now; later ads are still gated by five
    // successful Next jumps.
    hideAllAds();
    adDisplayEligible = false;
    if (hasStartedCamera) {
      adDismissed = false;
      adDisplayEligible = true;
      renderCurrentAd();
    } else {
      maybeShowAdForCurrentMatch();
    }
  } catch (err) {
    console.warn("[ADS] Failed to load sponsored ads:", err);
  }
}

function renderCurrentAd() {
  if (!activeAdsList.length || !adDisplayEligible || adDismissed || !adCard) return;

  const isMobile = isMobileOrCompressedViewport();

  // Find next ad matching the device target (all, mobile, desktop)
  let candidateIndex = currentAdIndex;
  let attempts = 0;
  while (attempts < activeAdsList.length) {
    const candidate = activeAdsList[candidateIndex];
    if (candidate) {
      const target = candidate.device_target || "all";
      if (target === "mobile" && !isMobile) {
        candidateIndex = (candidateIndex + 1) % activeAdsList.length;
        attempts++;
        continue;
      }
      if (target === "desktop" && isMobile) {
        candidateIndex = (candidateIndex + 1) % activeAdsList.length;
        attempts++;
        continue;
      }
      break;
    }
    attempts++;
  }
  currentAdIndex = candidateIndex;
  const ad = activeAdsList[currentAdIndex];
  if (!ad) {
    hideAllAds();
    return;
  }

  // Track impression to backend telemetry
  fetch(`/api/ads/${encodeURIComponent(ad.id)}/impression`, { method: "POST" }).catch(() => { });

  if (adContainer && adCard) {
    if (adCard.parentElement !== adContainer) adContainer.appendChild(adCard);
    placeAdContainer(ad.placement || adSettings.defaultPlacement || "below-video");
    adContainer.classList.add("show");
  }

  // Title
  if (adTitleEl) adTitleEl.textContent = ad.title || "Sponsored";

  // Subtitle / Body Description
  if (adDescEl) {
    if (ad.body && ad.body.trim().length > 0) {
      adDescEl.textContent = ad.body.trim();
      adDescEl.style.display = "block";
    } else {
      adDescEl.style.display = "none";
    }
  }

  // CTA link & text (sanitized)
  if (adCtaEl) {
    adCtaEl.textContent = ad.cta_text || "Learn more ↗";
    // SECURITY: validate the URL before assigning it to href. A plain
    // /^https?:\/\// test is not enough: browsers rewrite a backslash to a
    // forward slash, so "https://\evil.com" passes that regex yet navigates to
    // evil.com. Reject backslashes and control characters outright.
    if (isSafeExternalUrl(ad.link_url)) {
      adCtaEl.href = ad.link_url;
      adCtaEl.rel = "noopener noreferrer";
      adCtaEl.style.display = "inline-flex";
      adCtaEl.onclick = () => {
        fetch(`/api/ads/${encodeURIComponent(ad.id)}/click`, { method: "POST" }).catch(() => { });
      };
    } else {
      adCtaEl.removeAttribute("href");
      adCtaEl.style.display = "none";
    }
  }

  // Dismiss button permission
  if (adCloseBtn) {
    adCloseBtn.style.display = adSettings.allowDismiss ? "block" : "none";
  }

  // Media preview (image or video in Picture-in-Picture style)
  if (adMediaSlot) {
    adMediaSlot.innerHTML = "";
    if (ad.media_type === "video") {
      if (adCard) adCard.classList.add("pip-mode");

      const wrapper = document.createElement("div");
      wrapper.className = "pip-video-wrapper";

      // Picture-in-Picture badge indicator
      const badge = document.createElement("div");
      badge.className = "pip-badge";
      badge.innerHTML = '<span class="pip-pulse-dot"></span><span>PiP Mode</span>';
      wrapper.appendChild(badge);

      // Floating video element
      const vid = document.createElement("video");
      vid.className = "pip-video-media sponsored-media";
      vid.src = ad.media_url;
      vid.autoplay = true;
      vid.muted = true;
      vid.loop = false;
      vid.playsInline = true;
      vid.preload = "auto";

      // Progress bar at the bottom of the PiP frame
      const progressTrack = document.createElement("div");
      progressTrack.className = "pip-progress-track";
      const progressFill = document.createElement("div");
      progressFill.className = "pip-progress-fill";
      progressTrack.appendChild(progressFill);

      vid.ontimeupdate = () => {
        if (vid.duration) {
          const pct = (vid.currentTime / vid.duration) * 100;
          progressFill.style.width = pct + "%";
        }
      };

      // PiP Overlay controls
      const controls = document.createElement("div");
      controls.className = "pip-overlay-controls";

      // Left control: Play/Pause only
      const leftControls = document.createElement("div");
      leftControls.style.display = "flex";
      leftControls.style.gap = "4px";

      const playBtn = document.createElement("button");
      playBtn.type = "button";
      playBtn.className = "pip-ctrl-btn";
      playBtn.title = "Play / Pause";
      playBtn.innerHTML = "⏸";
      playBtn.onclick = (e) => {
        e.stopPropagation();
        if (vid.paused) {
          vid.play().then(() => { playBtn.innerHTML = "⏸"; }).catch(() => { });
        } else {
          vid.pause();
          playBtn.innerHTML = "▶";
        }
      };

      leftControls.appendChild(playBtn);

      // Right control: Browser Picture-in-Picture pop-out
      const popoutBtn = document.createElement("button");
      popoutBtn.type = "button";
      popoutBtn.className = "pip-ctrl-btn";
      popoutBtn.title = "Pop-out Video (Picture-in-Picture window)";
      popoutBtn.innerHTML = "⧉ Pop-out";
      popoutBtn.onclick = async (e) => {
        e.stopPropagation();
        try {
          if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
          } else if (vid.requestPictureInPicture) {
            await vid.requestPictureInPicture();
          }
        } catch (_) { }
      };

      controls.appendChild(leftControls);
      controls.appendChild(popoutBtn);

      vid.onended = () => {
        // Keep the earned ad opportunity visible without creating another
        // impression/campaign rotation until the next 5-Next threshold.
        vid.currentTime = 0;
        vid.play().catch(() => { });
      };

      wrapper.appendChild(vid);
      wrapper.appendChild(controls);
      wrapper.appendChild(progressTrack);
      adMediaSlot.appendChild(wrapper);

      vid.play().catch(() => { });
    } else {
      if (adCard) adCard.classList.remove("pip-mode");
      const img = document.createElement("img");
      img.className = "sponsored-media";
      img.src = ad.media_url;
      img.alt = ad.title || "Ad";
      img.loading = "lazy";
      img.onerror = () => { img.style.display = "none"; };
      adMediaSlot.appendChild(img);
    }
  }
}

function maybeShowAdForCurrentMatch() {
  // Confirm a pending Next click only now that a real encounter was made.
  if (awaitingNextConfirmation) {
    awaitingNextConfirmation = false;
    nextClicksSinceAd += 1;
  }

  // Ads stay fully hidden until NEXTS_PER_AD successful Next jumps are done.
  if (!isMatched || nextClicksSinceAd < NEXTS_PER_AD || activeAdsList.length === 0) {
    return;
  }

  nextClicksSinceAd = 0;
  adDismissed = false;
  adDisplayEligible = true;

  // Rotate the campaign only when the next ad opportunity is earned.
  currentAdIndex = activeAdsList.length > 1
    ? (currentAdIndex + 1) % activeAdsList.length
    : 0;

  renderCurrentAd();
}

function scheduleNextAd() {
  // Intentionally disabled: a new ad opportunity is earned only after
  // NEXTS_PER_AD clicks of the Next button and a successful rematch.
  if (adRotationTimer) {
    clearTimeout(adRotationTimer);
    adRotationTimer = null;
  }
}

if (adCloseBtn) {
  adCloseBtn.addEventListener("click", () => {
    adDismissed = true;
    hideAllAds();
    if (adRotationTimer) clearTimeout(adRotationTimer);

    // Ads will remain hidden until user clicks "Next" button
    // Do not auto-redisplay on rotation cycle
  });
}

// Relocate ad seamlessly on viewport resize or orientation shift
window.addEventListener("resize", () => {
  if (activeAdsList.length > 0 && !adDismissed) {
    renderCurrentAd();
  }
});

/* ============================================================
   LOCAL VIDEO RECORDING
   ============================================================ */

function setRecordingIndicators(show) {
  if (!recordingStatus) return;
  recordingStatus.classList.toggle("show", show);
  if (!show && recordingTime) recordingTime.textContent = "00:00";
}

function getRecordingElapsedSeconds() {
  let elapsed = recordingElapsedMs;
  if (mediaRecorder && mediaRecorder.state === "recording" && recordingStartedAt) {
    elapsed += Date.now() - recordingStartedAt;
  }
  return elapsed / 1000;
}

function formatRecordingTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const secs = (total % 60).toString().padStart(2, "0");
  return `${minutes}:${secs}`;
}

function updateRecordingTimer() {
  if (!mediaRecorder) return;
  const formatted = formatRecordingTime(getRecordingElapsedSeconds());
  if (recordingTime) recordingTime.textContent = formatted;

  if (mediaRecorder.state === "recording" && recordButton) {
    recordButton.textContent = `⏹ Stop ${formatted}`;
    recordButton.classList.add("recording");
    recordButton.disabled = false;
  }
}

function updateRecordButton() {
  if (!recordButton) return;

  if (mediaRecorder && mediaRecorder.state === "recording") {
    const formatted = formatRecordingTime(getRecordingElapsedSeconds());
    recordButton.textContent = `⏹ Stop ${formatted}`;
    recordButton.classList.add("recording");
    recordButton.disabled = false;
    return;
  }

  recordButton.textContent = "🔴 Record";
  recordButton.classList.remove("recording");
  recordButton.disabled = !isMatched;
}

// Every key offered by the "Export Format" dropdown must exist here, otherwise
// the silently chosen format would not match what the user selected.
function getExportConfig(formatKey) {
  const configs = {
    // Delivered exactly as recorded (16:9 master, no re-encode).
    auto: {
      width: 1280,
      height: 720,
      label: "Best quality (original)",
      orientation: "original",
      passthrough: true,
      container: null,
      filename: "auto"
    },
    original: {
      width: 1280,
      height: 720,
      label: "Original",
      orientation: "original",
      passthrough: true,
      container: null,
      filename: "original"
    },
    // Horizontal destinations keep the master layout. They are only re-encoded
    // when the master container does not already match the requested one.
    youtube: {
      width: 1280,
      height: 720,
      label: "YouTube (MP4, 16:9)",
      orientation: "horizontal",
      passthrough: false,
      container: "mp4",
      filename: "youtube"
    },
    mp4: {
      width: 1280,
      height: 720,
      label: "MP4 (H.264/AAC)",
      orientation: "horizontal",
      passthrough: false,
      container: "mp4",
      filename: "mp4"
    },
    webm: {
      width: 1280,
      height: 720,
      label: "WebM (VP9/Opus)",
      orientation: "horizontal",
      passthrough: false,
      container: "webm",
      filename: "webm"
    },
    // Vertical destinations always need the two panes re-stacked.
    tiktok: {
      width: 720,
      height: 1280,
      label: "TikTok (MP4, 9:16)",
      orientation: "vertical",
      passthrough: false,
      container: "mp4",
      filename: "tiktok"
    },
    instagram: {
      width: 720,
      height: 1280,
      label: "Instagram Reels (MP4, 9:16)",
      orientation: "vertical",
      passthrough: false,
      container: "mp4",
      filename: "instagram-reels"
    },
    "youtube-shorts": {
      width: 720,
      height: 1280,
      label: "YouTube Shorts (MP4, 9:16)",
      orientation: "vertical",
      passthrough: false,
      container: "mp4",
      filename: "youtube-shorts"
    },
    "instagram-square": {
      width: 720,
      height: 720,
      label: "Instagram Feed (MP4, 1:1)",
      orientation: "square",
      passthrough: false,
      container: "mp4",
      filename: "instagram-feed"
    }
  };

  return configs[formatKey] || configs.auto;
}

function getBestExportRecorderFormat(targetContainer) {
  const mp4 = [
    { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4" },
    { mimeType: "video/mp4", extension: "mp4" }
  ];
  const webm = [
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" }
  ];

  // Prefer the container the user asked for, then fall back to the other one
  // so an unsupported container can never break the export.
  const candidates = targetContainer === "webm"
    ? webm.concat(mp4)
    : mp4.concat(webm);

  const supported = candidates.find((item) => {
    try {
      return !MediaRecorder.isTypeSupported || MediaRecorder.isTypeSupported(item.mimeType);
    } catch (_) {
      return false;
    }
  });

  return supported || { mimeType: "video/webm", extension: "webm" };
}

function drawExportCropFill(ctx, source, sx, sy, sw, sh, dx, dy, dw, dh) {
  if (!source || source.videoWidth <= 0 || source.videoHeight <= 0) {
    ctx.fillStyle = "#121526";
    ctx.fillRect(dx, dy, dw, dh);
    return;
  }

  const sourceRatio = sw / sh;
  const targetRatio = dw / dh;
  let cropW = sw;
  let cropH = sh;
  let cropX = sx;
  let cropY = sy;

  if (sourceRatio > targetRatio) {
    cropW = sh * targetRatio;
    cropX = sx + (sw - cropW) / 2;
  } else if (sourceRatio < targetRatio) {
    cropH = sw / targetRatio;
    cropY = sy + (sh - cropH) / 2;
  }

  ctx.drawImage(source, cropX, cropY, cropW, cropH, dx, dy, dw, dh);
}

async function waitForVideoReady(video) {
  if (video.readyState >= 2 && video.videoWidth && video.videoHeight) return;

  await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("The recording could not be prepared for export."));
    }, 12000);

    const done = () => {
      if (settled) return;
      if (video.videoWidth && video.videoHeight) {
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
    };

    video.addEventListener("loadedmetadata", done, { once: true });
    video.addEventListener("canplay", done, { once: true });
    video.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error("The recording could not be loaded."));
    }, { once: true });
  });
}

async function exportRecordingForDownload(formatKey) {
  if (!completedRecordingBlob) return null;

  const config = getExportConfig(formatKey);
  const masterContainer = completedRecordingBlob.type.includes("mp4") ? "mp4" : "webm";

  // Formats that already match the master recording are delivered untouched:
  // no second encode, no quality loss and no extra wait.
  if (
    config.passthrough === true ||
    (config.orientation === "horizontal" && config.container === masterContainer)
  ) {
    return {
      blob: completedRecordingBlob,
      extension: masterContainer,
      label: config.label
    };
  }

  const sourceUrl = URL.createObjectURL(completedRecordingBlob);
  const sourceVideo = document.createElement("video");
  sourceVideo.src = sourceUrl;
  sourceVideo.playsInline = true;
  sourceVideo.preload = "auto";
  sourceVideo.controls = false;
  sourceVideo.loop = false;
  sourceVideo.volume = 1;

  // Start muted so the browser can never reject play() for autoplay reasons.
  // It is unmuted immediately after play() succeeds, and the element audio is
  // routed through Web Audio into a recording-only destination, so the user's
  // speakers stay silent while the exported file keeps its sound.
  sourceVideo.muted = true;

  sourceVideo.style.position = "fixed";
  sourceVideo.style.width = "1px";
  sourceVideo.style.height = "1px";
  sourceVideo.style.opacity = "0";
  sourceVideo.style.pointerEvents = "none";
  sourceVideo.style.left = "-9999px";
  document.body.appendChild(sourceVideo);

  let exportCanvas = null;
  let exportContext = null;
  let exportRecorder = null;
  let exportAnimationFrame = null;
  let exportAudioContext = null;
  let exportAudioDestination = null;
  let exportAudioSource = null;
  let exportStream = null;

  try {
    await waitForVideoReady(sourceVideo);

    exportCanvas = document.createElement("canvas");
    exportCanvas.width = config.width;
    exportCanvas.height = config.height;
    exportContext = exportCanvas.getContext("2d");
    if (!exportContext) throw new Error("Could not create export canvas.");

    exportStream = exportCanvas.captureStream(30);

    // Capture the recorded audio without ever sending it to the speakers.
    let audioGraphReady = false;
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        exportAudioContext = new AudioContextClass();
        exportAudioDestination = exportAudioContext.createMediaStreamDestination();
        exportAudioSource = exportAudioContext.createMediaElementSource(sourceVideo);
        exportAudioSource.connect(exportAudioDestination);
        if (exportAudioContext.state === "suspended") {
          await exportAudioContext.resume().catch(() => { });
        }
        const audioTrack = exportAudioDestination.stream.getAudioTracks()[0];
        if (audioTrack) {
          exportStream.addTrack(audioTrack);
          audioGraphReady = true;
        }
      }
    } catch (_) {
      // Video-only export is still valid if the browser blocks audio capture.
      audioGraphReady = false;
    }

    try {
      await sourceVideo.play();
    } catch (_) {
      throw new Error("The browser blocked playback while preparing the video. Please try again.");
    }

    if (audioGraphReady) {
      // The element now feeds Web Audio only, so unmuting gives the export
      // full-volume sound while the speakers stay silent.
      sourceVideo.muted = false;
    } else {
      // No Web Audio graph available: take the element's own audio stream and
      // keep the element muted so nothing plays out loud during the export.
      try {
        const capture =
          typeof sourceVideo.captureStream === "function" ? sourceVideo.captureStream() :
            typeof sourceVideo.mozCaptureStream === "function" ? sourceVideo.mozCaptureStream() :
              null;

        if (capture) {
          capture.getAudioTracks().forEach((track) => {
            try { exportStream.addTrack(track); } catch (_) { }
          });
        }
      } catch (_) {
        // Video-only export still succeeds when audio capture is unavailable.
      }
    }

    const masterWidth = sourceVideo.videoWidth;
    const masterHeight = sourceVideo.videoHeight;
    const gap = Math.round(masterWidth * 0.015);
    const paneWidth = Math.floor((masterWidth - gap) / 2);

    const drawFrame = () => {
      if (!exportContext) return;

      exportContext.fillStyle = "#080a12";
      exportContext.fillRect(0, 0, config.width, config.height);

      if (config.orientation === "vertical" || config.orientation === "square") {
        const paneHeight = Math.floor(config.height / 2);

        // Stranger on top, user on bottom for a natural social layout.
        drawExportCropFill(
          exportContext,
          sourceVideo,
          0, 0, paneWidth, masterHeight,
          0, 0, config.width, paneHeight
        );

        drawExportCropFill(
          exportContext,
          sourceVideo,
          paneWidth + gap, 0, paneWidth, masterHeight,
          0, paneHeight, config.width, config.height - paneHeight
        );
      } else {
        // Fallback layout if another horizontal destination is ever added.
        drawExportCropFill(
          exportContext,
          sourceVideo,
          0, 0, masterWidth, masterHeight,
          0, 0, config.width, config.height
        );
      }

      exportAnimationFrame = requestAnimationFrame(drawFrame);
    };

    const recorderFormat = getBestExportRecorderFormat(config.container || masterContainer);
    const chunks = [];

    try {
      exportRecorder = new MediaRecorder(exportStream, {
        mimeType: recorderFormat.mimeType,
        videoBitsPerSecond: 3500000
      });
    } catch (_) {
      // Let the browser pick its own container rather than failing outright.
      exportRecorder = new MediaRecorder(exportStream, { videoBitsPerSecond: 3500000 });
    }

    const actualType = exportRecorder.mimeType || recorderFormat.mimeType || "video/webm";
    const actualExtension = actualType.includes("mp4") ? "mp4" : "webm";

    const finished = new Promise((resolve, reject) => {
      exportRecorder.addEventListener("dataavailable", (event) => {
        if (event.data && event.data.size > 0) chunks.push(event.data);
      });

      exportRecorder.addEventListener("error", () => {
        reject(new Error(`Could not create the ${config.label} export on this browser.`));
      }, { once: true });

      exportRecorder.addEventListener("stop", () => {
        resolve(new Blob(chunks, { type: actualType }));
      }, { once: true });

      sourceVideo.addEventListener("error", () => {
        reject(new Error("The recording could not be read for export."));
      }, { once: true });

      const stopRecorder = () => {
        if (exportRecorder && exportRecorder.state !== "inactive") {
          exportRecorder.stop();
        }
      };

      // Some recordings are already at their end by the time the recorder
      // is attached, so never wait for an "ended" event that already fired.
      if (sourceVideo.ended) stopRecorder();
      else sourceVideo.addEventListener("ended", stopRecorder, { once: true });
    });

    exportRecorder.start(250);
    drawFrame();

    // Wait for the source video to play through. Local MediaRecorder files
    // often report an unknown (Infinity) duration, so only a FINITE duration
    // gets a tight budget; otherwise a generous safety net applies instead of
    // aborting a perfectly valid export after a few seconds.
    const knownDuration =
      Number.isFinite(sourceVideo.duration) && sourceVideo.duration > 0
        ? sourceVideo.duration
        : null;

    const timeoutMs = knownDuration
      ? Math.ceil(knownDuration * 1000) + 30000
      : 15 * 60 * 1000;

    const blob = await Promise.race([
      finished,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("Video export timed out.")), timeoutMs);
      })
    ]);

    return {
      blob,
      extension: actualExtension,
      label: config.label
    };
  } finally {
    if (exportAnimationFrame) cancelAnimationFrame(exportAnimationFrame);
    try { if (exportRecorder && exportRecorder.state !== "inactive") exportRecorder.stop(); } catch (_) { }
    try { if (exportAudioSource) exportAudioSource.disconnect(); } catch (_) { }
    try {
      if (exportAudioContext && exportAudioContext.state !== "closed") {
        await exportAudioContext.close();
      }
    } catch (_) { }
    try {
      if (exportStream && exportStream.getTracks) {
        exportStream.getTracks().forEach((track) => {
          try { track.stop(); } catch (_) { }
        });
      }
    } catch (_) { }
    sourceVideo.pause();
    sourceVideo.removeAttribute("src");
    sourceVideo.load();
    sourceVideo.remove();
    URL.revokeObjectURL(sourceUrl);
  }
}

function drawVideoToCanvas(video, x, y, width, height) {
  if (!recordingContext || !video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    if (recordingContext) {
      recordingContext.fillStyle = "#121526";
      recordingContext.fillRect(x, y, width, height);
    }
    return;
  }

  const sourceRatio = video.videoWidth / video.videoHeight;
  const targetRatio = width / height;
  let sx = 0;
  let sy = 0;
  let sw = video.videoWidth;
  let sh = video.videoHeight;

  if (sourceRatio > targetRatio) {
    sw = Math.round(video.videoHeight * targetRatio);
    sx = Math.round((video.videoWidth - sw) / 2);
  } else if (sourceRatio < targetRatio) {
    sh = Math.round(video.videoWidth / targetRatio);
    sy = Math.round((video.videoHeight - sh) / 2);
  }

  recordingContext.drawImage(video, sx, sy, sw, sh, x, y, width, height);
}

function drawRecordingFrame() {
  if (!recordingContext || !recordingCanvas) return;

  const width = recordingCanvas.width;
  const height = recordingCanvas.height;
  const gap = Math.round(width * 0.015);
  const cardWidth = Math.floor((width - gap) / 2);

  recordingContext.fillStyle = "#080a12";
  recordingContext.fillRect(0, 0, width, height);

  // Keep the existing two-pane encounter recording layout.
  drawVideoToCanvas(remoteVideo, 0, 0, cardWidth, height);
  drawVideoToCanvas(localVideo, cardWidth + gap, 0, cardWidth, height);

  if (mediaRecorder && mediaRecorder.state === "recording") {
    recordingAnimationFrame = requestAnimationFrame(drawRecordingFrame);
  }
}

function attachRecordingRemoteAudio(stream) {
  if (!recordingAudioContext || !recordingAudioDestination || !stream ||
    !stream.getAudioTracks || !stream.getAudioTracks().length) {
    return null;
  }

  // The remote stream changes every time the user presses Next. Replace only
  // the remote audio source while keeping the same MediaRecorder running.
  if (recordingRemoteAudioSource) {
    try { recordingRemoteAudioSource.disconnect(); } catch (_) { }
    const oldIndex = recordingAudioSources.indexOf(recordingRemoteAudioSource);
    if (oldIndex >= 0) recordingAudioSources.splice(oldIndex, 1);
    recordingRemoteAudioSource = null;
  }

  try {
    const source = recordingAudioContext.createMediaStreamSource(stream);
    source.connect(recordingAudioDestination);
    recordingRemoteAudioSource = source;
    recordingAudioSources.push(source);
    return source;
  } catch (error) {
    console.warn("[REC] Could not attach the current remote audio source:", error);
    return null;
  }
}

function setupRecordingAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  const sourceStreams = [
    localStream,
    remoteVideo && remoteVideo.srcObject
  ].filter((stream) => stream && stream.getAudioTracks && stream.getAudioTracks().length);

  if (!sourceStreams.length) return null;

  try {
    recordingAudioContext = new AudioContextClass();
    recordingAudioDestination = recordingAudioContext.createMediaStreamDestination();
    recordingAudioSources = [];

    for (const stream of sourceStreams) {
      // Keep the local microphone source stable. The remote source is managed
      // separately because it is replaced whenever Next finds a new stranger.
      if (stream === (remoteVideo && remoteVideo.srcObject)) {
        attachRecordingRemoteAudio(stream);
        continue;
      }

      try {
        const source = recordingAudioContext.createMediaStreamSource(stream);
        source.connect(recordingAudioDestination);
        recordingAudioSources.push(source);
      } catch (error) {
        console.warn("[REC] Could not attach one audio source:", error);
      }
    }

    if (!recordingAudioSources.length) {
      cleanupRecordingAudioOnly();
      return null;
    }

    if (recordingAudioContext.state === "suspended") {
      recordingAudioContext.resume().catch(() => { });
    }

    return recordingAudioDestination.stream.getAudioTracks()[0] || null;
  } catch (error) {
    console.warn("[REC] Audio mixing unavailable; continuing without mixed audio:", error);
    cleanupRecordingAudioOnly();
    return null;
  }
}

function cleanupRecordingAudioOnly() {
  recordingAudioSources.forEach((source) => {
    try { source.disconnect(); } catch (_) { }
  });
  recordingAudioSources = [];
  recordingRemoteAudioSource = null;

  if (recordingAudioContext) {
    try {
      if (recordingAudioContext.state !== "closed") {
        recordingAudioContext.close().catch(() => { });
      }
    } catch (_) { }
  }

  recordingAudioContext = null;
  recordingAudioDestination = null;
}

function cleanupRecordingMediaResources() {
  if (recordingAnimationFrame) {
    cancelAnimationFrame(recordingAnimationFrame);
    recordingAnimationFrame = null;
  }

  if (recordingCanvasStream && recordingCanvasStream.getTracks) {
    recordingCanvasStream.getTracks().forEach((track) => {
      try { track.stop(); } catch (_) { }
    });
  }
  recordingCanvasStream = null;

  cleanupRecordingAudioOnly();
  recordingCanvas = null;
  recordingContext = null;
}

function getSupportedRecordingFormats() {
  const candidates = [
    { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4" },
    { mimeType: "video/mp4", extension: "mp4" },
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" }
  ];

  const supported = candidates.filter((item) => {
    try {
      return typeof MediaRecorder !== "undefined"
        && typeof MediaRecorder.isTypeSupported === "function"
        && MediaRecorder.isTypeSupported(item.mimeType);
    } catch (_) {
      return false;
    }
  });

  // Always keep a browser-default fallback as the last resort.
  supported.push({ mimeType: "", extension: "webm" });
  return supported;
}

function createRecordingRecorder(stream) {
  if (!window.MediaRecorder) {
    throw new Error("MediaRecorder is not supported by this browser.");
  }
  if (!stream || !stream.getVideoTracks || !stream.getVideoTracks().length) {
    throw new Error("No video track is available for recording.");
  }

  const formats = getSupportedRecordingFormats();
  let lastError = null;

  for (const format of formats) {
    try {
      const options = { videoBitsPerSecond: 3500000 };
      if (format.mimeType) options.mimeType = format.mimeType;
      const recorder = new MediaRecorder(stream, options);
      return { recorder, format };
    } catch (error) {
      lastError = error;
      console.warn("[REC] Recorder format rejected:", format.mimeType || "browser default", error);
    }
  }

  throw lastError || new Error("This browser could not create a recorder for the current video stream.");
}

async function startLocalRecording() {
  if (!isMatched) return;
  if (mediaRecorder && (mediaRecorder.state === "recording" || mediaRecorder.state === "paused")) return;

  if (!window.MediaRecorder) {
    alert("Recording is not supported by this browser. Please use a recent Chrome, Edge, Firefox, or Safari browser.");
    return;
  }

  try {
    recordingCanvas = document.createElement("canvas");
    recordingCanvas.width = 1280;
    recordingCanvas.height = 720;
    // Plain "2d" — the alpha:false variant can return null on some devices.
    recordingContext = recordingCanvas.getContext("2d");
    if (!recordingContext) throw new Error("Could not create the recording canvas.");

    if (typeof recordingCanvas.captureStream !== "function") {
      throw new Error("Canvas recording is not supported by this browser.");
    }

    recordingCanvasStream = recordingCanvas.captureStream(30);
    if (!recordingCanvasStream || !recordingCanvasStream.getVideoTracks().length) {
      throw new Error("The browser did not create a video recording track.");
    }

    // Optional mixed audio (user + stranger). Any failure is non-fatal:
    // recording continues silently without audio rather than aborting.
    let mixedAudioTrack = null;
    try {
      mixedAudioTrack = setupRecordingAudio();
    } catch (audioErr) {
      console.warn("[REC] Audio setup failed, continuing without audio:", audioErr);
      cleanupRecordingAudioOnly();
      mixedAudioTrack = null;
    }
    if (mixedAudioTrack) {
      try { recordingCanvasStream.addTrack(mixedAudioTrack); } catch (_) { }
    }

    const recorderResult = await createRecordingRecorder(recordingCanvasStream);

    mediaRecorder = recorderResult.recorder;
    recordingChunks = [];
    recordingElapsedMs = 0;
    recordingStartedAt = Date.now();

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data && event.data.size > 0) recordingChunks.push(event.data);
    });

    mediaRecorder.addEventListener("stop", finishLocalRecording, { once: true });

    // No post-start state check — some browsers only settle `state`
    // asynchronously and the old check caused false failures.
    mediaRecorder.start(500);

    setRecordingIndicators(true);
    updateRecordButton();
    setStatus("🔴 Recording encounter...");

    recordingTimer = setInterval(updateRecordingTimer, 250);
    drawRecordingFrame();
  } catch (err) {
    console.error("[REC] Recording failed to start:", err);

    if (mediaRecorder) {
      try {
        mediaRecorder.onstop = null;
        if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
      } catch (_) { }
    }
    mediaRecorder = null;
    recordingChunks = [];
    recordingStartedAt = 0;
    recordingElapsedMs = 0;
    clearInterval(recordingTimer);
    recordingTimer = null;
    setRecordingIndicators(false);
    cleanupRecordingMediaResources();
    updateRecordButton();
    setStatus("Recording could not be started.");

    const reason = err && err.message ? `\n\nDetails: ${err.message}` : "";
    alert(`Could not start recording on this device.${reason}`);
  }
}

function stopLocalRecording() {
  if (!mediaRecorder) return;
  if (mediaRecorder.state === "recording" && recordingStartedAt) {
    recordingElapsedMs += Date.now() - recordingStartedAt;
  }
  recordingStartedAt = 0;

  try {
    if (mediaRecorder.state !== "inactive") {
      mediaRecorder.requestData?.();
      mediaRecorder.stop();
    }
  } catch (error) {
    console.warn("[REC] Recorder stop error:", error);
    finishLocalRecording();
  }

  clearInterval(recordingTimer);
  recordingTimer = null;
  setRecordingIndicators(false);
  setStatus("Finishing recording...");
}

function finishLocalRecording() {
  const recorder = mediaRecorder;

  // The "stop" event can fire after the recorder was already finalized (for
  // example when a failed start is cleaned up). Ignore the duplicate so the
  // result modal and status are never overwritten by an empty second pass.
  if (!recorder) return;

  const recorderMimeType = recorder.mimeType || "video/webm";
  const blob = new Blob(recordingChunks, { type: recorderMimeType });
  recordingChunks = [];

  mediaRecorder = null;
  recordingStartedAt = 0;
  recordingElapsedMs = 0;
  clearInterval(recordingTimer);
  recordingTimer = null;
  setRecordingIndicators(false);
  updateRecordButton();
  cleanupRecordingMediaResources();

  if (!blob.size) {
    setStatus("Recording finished, but empty data was returned.");
    return;
  }

  completedRecordingBlob = blob;
  if (completedRecordingUrl) URL.revokeObjectURL(completedRecordingUrl);
  completedRecordingUrl = URL.createObjectURL(blob);

  if (recordingPreview) {
    recordingPreview.src = completedRecordingUrl;
    recordingPreview.load();
  }

  // The dropdown is the single source of truth: whatever is shown there is
  // exactly what "Save to device" will produce.
  if (recordingFormatSelect && recordingFormatSelect.value) {
    selectedRecordingFormat = recordingFormatSelect.value;
  }
  updateRecordingFormatDescription();

  if (recordingResultBackdrop) recordingResultBackdrop.classList.add("show");
  setStatus("Encounter ready. Preview or save it to your device.");
}

/* ============================================================
   WEBSOCKET SIGNALING & WEBRTC
   ============================================================ */

function scheduleSocketReconnect() {
  if (socketReconnectTimer) return;

  const delay = Math.min(socketReconnectDelay, 4000);
  socketReconnectTimer = setTimeout(() => {
    socketReconnectTimer = null;
    connectToSignalingServer();
  }, delay);

  socketReconnectDelay = Math.min(Math.round(socketReconnectDelay * 1.6), 4000);
}

function sendReadyWhenConnected() {
  if (!hasStartedCamera || !wantsMatchQueue) return false;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    connectToSignalingServer();
    return false;
  }

  const now = Date.now();
  if (now - lastReadySentAt < 300) return true;
  lastReadySentAt = now;

  if (!peerConnection) createPeerConnection();
  return sendMessage({ type: "ready" });
}

function queueForMatch(statusText = "Seeking stranger...") {
  if (!hasStartedCamera) return;
  wantsMatchQueue = true;

  if (!peerConnection) createPeerConnection();

  if (socket && socket.readyState === WebSocket.OPEN) {
    sendReadyWhenConnected();
    setStatus(statusText);
  } else {
    connectToSignalingServer();
    setStatus("Connecting to server...");
  }
}

// Random anonymous id kept in this browser only. It lets the server tell apart
// different reporters who share one IP address (same Wi-Fi / mobile network),
// so each person's report is counted once. It contains no personal data.
function getAnonymousClientId() {
  const KEY = "lela_cid";
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
  } catch (_) {}
  let id = "";
  try {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      id = window.crypto.randomUUID().replace(/-/g, "");
    } else if (window.crypto && window.crypto.getRandomValues) {
      const bytes = new Uint8Array(16);
      window.crypto.getRandomValues(bytes);
      id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch (_) {}
  if (!id) id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try { localStorage.setItem(KEY, id); } catch (_) {}
  return id;
}

function connectToSignalingServer() {
  if (socket && (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  )) {
    return;
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socketUrl = `${protocol}//${window.location.host}/?cid=${encodeURIComponent(getAnonymousClientId())}`;

  let currentSocket;
  try {
    currentSocket = new WebSocket(socketUrl);
  } catch (error) {
    console.error("[LELA] WebSocket creation failed:", error);
    scheduleSocketReconnect();
    return;
  }

  socket = currentSocket;

  currentSocket.addEventListener("open", () => {
    if (socket !== currentSocket) return;
    socketReconnectDelay = 350;

    if (hasStartedCamera && wantsMatchQueue) {
      if (!peerConnection) createPeerConnection();
      sendReadyWhenConnected();
      setStatus("Connected. Seeking match...");
    }
  });

  currentSocket.addEventListener("message", async (event) => {
    if (socket !== currentSocket) return;

    try {
      const message = JSON.parse(event.data);

      if (message.type === "online-count") {
        if (onlineCountElement) {
          const count = Number.isFinite(Number(message.count))
            ? Number(message.count)
            : 0;
          onlineCountElement.textContent = `${count} online`;
        }
        return;
      }

      await handleSignalingMessage(message);
    } catch (error) {
      console.error("[LELA] Socket message error:", error);
    }
  });

  currentSocket.addEventListener("close", () => {
    if (socket === currentSocket) socket = null;

    if (hasStartedCamera && wantsMatchQueue) {
      setStatus("Reconnecting...");
    }

    scheduleSocketReconnect();
  });

  currentSocket.addEventListener("error", () => {
    // close() follows in normal browsers. Do not create a second connection.
  });
}

let isMaintenanceLocked = false;
let maintenanceModalDismissed = false;
let lastMaintenanceAnnouncementId = null;

function sendMessage(message) {
  if (isMaintenanceLocked && message && message.type !== "ping") {
    console.warn("[LELA] Action blocked: Website update maintenance mode is active.");
    return false;
  }
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

async function startCamera() {
  if (isMaintenanceLocked) {
    return;
  }
  if (hasStartedCamera) return;

  try {
    setStatus("Requesting camera and microphone...");
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

    // TURN config has been loading since page start (parallel with the
    // permission prompt). Make sure it has settled before any peer is created.
    await rtcConfigReady;

    localStream = stream;
    localVideo.srcObject = localStream;
    watchLocalCameraTracks(stream);
    hasStartedCamera = true;
    startButton.disabled = true;
    wantsMatchQueue = true;

    updateStopButton();
    updateVideoPlaceholders();

    // Show the first sponsored ad as soon as the user enters video chat.
    // This is separate from the recurring 5-successful-Next ad threshold.
    if (activeAdsList.length > 0 && adSettings.enabled !== false) {
      adDismissed = false;
      adDisplayEligible = true;
      currentAdIndex = 0;
      renderCurrentAd();
    }

    // The socket is normally already connected because we pre-connect on page
    // load. If it is not, connect now and the open handler will queue instantly.
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      connectToSignalingServer();
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
      queueForMatch("Seeking stranger...");
    } else {
      queueForMatch();
    }
  } catch (err) {
    hasStartedCamera = false;
    wantsMatchQueue = false;
    startButton.disabled = false;
    updateStopButton();
    setStatus("Camera/Mic access denied.");
    alert("Please allow camera and microphone permissions to enter video chat.");
  }
}

function createPeerConnection() {
  if (peerConnection) {
    try { peerConnection.close(); } catch (e) { }
  }

  pendingIceCandidates = [];
  peerConnection = new RTCPeerConnection(rtcConfiguration);

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  }

  peerConnection.addEventListener("track", (event) => {
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      if (mediaRecorder && mediaRecorder.state === "recording") {
        attachRecordingRemoteAudio(event.streams[0]);
      }
      updateVideoPlaceholders();
      remoteVideo.play().catch(() => { });
    }
  });

  peerConnection.addEventListener("icecandidate", (event) => {
    if (event.candidate) {
      sendMessage({ type: "ice-candidate", candidate: event.candidate });
    }
  });

  peerConnection.addEventListener("iceconnectionstatechange", () => {
    if (!peerConnection) return;
    const state = peerConnection.iceConnectionState;
    if (state === "checking") setStatus("Connecting to peer...");
    if (state === "connected" || state === "completed") setStatus("Connected!");
    if (state === "failed") {
      recoverFromDeadPeer();
    }
    if (state === "disconnected") {
      // "disconnected" can be a brief blip that heals itself, so give it 3 seconds.
      const watchedConnection = peerConnection;
      setTimeout(() => {
        if (!peerConnection || peerConnection !== watchedConnection) return;
        const now = peerConnection.iceConnectionState;
        if (now === "disconnected" || now === "failed") recoverFromDeadPeer();
      }, 3000);
    }
  });

  peerConnection.addEventListener("datachannel", (event) => {
    setupChatChannel(event.channel);
  });
}

async function createOffer() {
  if (!peerConnection) return;
  try {
    if (!chatChannel) {
      const channel = peerConnection.createDataChannel("chat");
      setupChatChannel(channel);
    }
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    sendMessage({ type: "offer", offer: peerConnection.localDescription });
  } catch (err) {
    console.error("[LELA] Offer creation error:", err);
  }
}

async function handleSignalingMessage(message) {
  switch (message.type) {
    case "waiting":
      isMatched = false;
      updateMatchButtons();
      setStatus("Looking for someone...");
      break;

    case "matched":
      isMatched = true;
      chatEnabled = true;
      maybeShowAdForCurrentMatch();
      clearChat();
      applyChatState();

      if (!peerConnection) createPeerConnection();
      updateMatchButtons();
      updateRecordButton();
      setStatus("Matched! Connecting video...");
      break;

    case "create-offer":
      await createOffer();
      break;

    case "offer":
      if (!peerConnection) createPeerConnection();
      await peerConnection.setRemoteDescription(new RTCSessionDescription(message.offer));
      while (pendingIceCandidates.length) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(pendingIceCandidates.shift())).catch(() => { });
      }
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      sendMessage({ type: "answer", answer: peerConnection.localDescription });
      break;

    case "answer":
      if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
        while (pendingIceCandidates.length) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(pendingIceCandidates.shift())).catch(() => { });
        }
      }
      break;

    case "ice-candidate":
      if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate)).catch(() => { });
      } else {
        pendingIceCandidates.push(message.candidate);
      }
      break;

    case "peer-disconnected":
      handlePeerDisconnected();
      break;

    case "report-received":
      closeReportModal();
      if (message.duplicate) {
        setStatus(`Report already counted. ${message.reportCount || 1} report(s) for this reason. Seeking someone new...`);
      } else if (message.escalated) {
        setStatus(`Report submitted and flagged for review (${message.uniqueReportersCount || message.uniqueReporterCount || 1} unique reporter(s)). Seeking someone new...`);
      } else {
        setStatus("Report submitted. Seeking someone new...");
      }
      break;

    case "report-rate-limited":
      closeReportModal();
      setStatus(message.message || "Too many reports. Please try again later.");
      break;

    case "report-save-error":
      closeReportModal();
      setStatus(message.message || "Report could not be saved. Seeking someone new...");
      break;

    case "banned":
      handleBanned(message.reason);
      break;

    case "broadcast":
      handleBroadcast(message.text);
      break;

    case "system_announcement":
      handleSystemAnnouncement(message.announcement);
      break;

    case "announcement_cleared":
      handleAnnouncementCleared();
      break;

    case "maintenance_lockout":
      handleMaintenanceLockout(message.message);
      break;
  }
}

let broadcastBannerTimer = null;
let normalAnnouncementTimer = null;
let lastSeenNormalAnnouncementId = null;

function handleBroadcast(text, persistent = false) {
  if (!broadcastBanner || !broadcastMessage) return;
  broadcastMessage.textContent = text;
  broadcastBanner.classList.add("show");
  if (broadcastBannerTimer) {
    clearTimeout(broadcastBannerTimer);
    broadcastBannerTimer = null;
  }
  if (!persistent) {
    broadcastBannerTimer = setTimeout(() => {
      broadcastBanner.classList.remove("show");
    }, 10000);
  }
}

function handleSystemAnnouncement(announcement) {
  if (!announcement) {
    handleAnnouncementCleared();
    return;
  }

  if (announcement.lockout) {
    // Locked announcement: PERSISTENT! Do not change any functionalities of locked announcements.
    if (normalAnnouncementTimer) {
      clearTimeout(normalAnnouncementTimer);
      normalAnnouncementTimer = null;
    }
    applyMaintenanceLockout(announcement.title, announcement.message, announcement.id);
  } else {
    // Normal announcement: visible for some seconds only!
    removeMaintenanceLockout();
    showNormalAnnouncement(announcement);
  }
}

function showNormalAnnouncement(announcement) {
  if (!announcement) return;

  const annId = announcement.id || (announcement.title + ":" + announcement.message);

  // If this normal announcement has already been shown and its timer expired, do not re-show on polling
  if (annId === lastSeenNormalAnnouncementId && !normalAnnouncementTimer) {
    return;
  }

  // If this normal announcement is currently active and timing down, let it continue
  if (annId === lastSeenNormalAnnouncementId && normalAnnouncementTimer) {
    return;
  }

  lastSeenNormalAnnouncementId = annId;

  if (normalAnnouncementTimer) {
    clearTimeout(normalAnnouncementTimer);
    normalAnnouncementTimer = null;
  }

  const stickyBar = document.getElementById("lockoutStickyBar");
  const barTitle = document.getElementById("lockoutBarTitle");
  const barBadgeText = document.getElementById("lockoutBarBadgeText");
  const statusDot = document.querySelector(".lockout-status-dot");
  const reopenBtn = document.getElementById("reopenMaintenanceModalBtn");
  const modalIcon = document.getElementById("maintenanceModalIcon");

  if (stickyBar) {
    stickyBar.classList.add("normal-announcement");
    stickyBar.classList.remove("locked-announcement");
    stickyBar.style.display = "flex";
  }

  if (barTitle) {
    barTitle.textContent = announcement.title || "Announcement";
  }
  if (barBadgeText) {
    barBadgeText.textContent = "Announcement";
  }
  if (statusDot) {
    statusDot.style.background = "#38bdf8";
  }
  if (modalIcon) {
    modalIcon.textContent = "📢";
    modalIcon.classList.add("blue");
  }

  // Set popup details in case user clicks "View details"
  const titleEl = document.getElementById("maintenanceModalTitle");
  const textEl = document.getElementById("maintenanceModalText");
  if (titleEl) titleEl.textContent = announcement.title || "Announcement";
  if (textEl) textEl.textContent = announcement.message || "";

  if (reopenBtn) {
    reopenBtn.style.display = announcement.message ? "inline-block" : "none";
  }

  document.body.classList.add("has-announcement-bar");

  // The announcement bar is visible for some seconds for only normal announcement
  normalAnnouncementTimer = setTimeout(() => {
    hideNormalAnnouncement();
  }, 8000);
}

function hideNormalAnnouncement() {
  if (normalAnnouncementTimer) {
    clearTimeout(normalAnnouncementTimer);
    normalAnnouncementTimer = null;
  }
  if (!isMaintenanceLocked) {
    const stickyBar = document.getElementById("lockoutStickyBar");
    if (stickyBar) {
      stickyBar.style.display = "none";
      stickyBar.classList.remove("normal-announcement");
    }
    document.body.classList.remove("has-announcement-bar");
  }
}

function handleAnnouncementCleared() {
  if (normalAnnouncementTimer) {
    clearTimeout(normalAnnouncementTimer);
    normalAnnouncementTimer = null;
  }
  lastSeenNormalAnnouncementId = null;
  removeMaintenanceLockout();
  hideNormalAnnouncement();
  if (broadcastBanner) {
    broadcastBanner.classList.remove("show");
  }
}

function handleMaintenanceLockout(customMsg) {
  applyMaintenanceLockout("Website is in Update", customMsg || "We are currently making improvements to the website.");
}

function applyMaintenanceLockout(title, message, announcementId) {
  isMaintenanceLocked = true;
  document.body.classList.add("maintenance-locked");

  if (announcementId && announcementId !== lastMaintenanceAnnouncementId) {
    // New announcement published - show modal once for this new announcement
    maintenanceModalDismissed = false;
    lastMaintenanceAnnouncementId = announcementId;
  }

  // Immediately terminate active session/camera if running
  if (hasStartedCamera || isMatched) {
    stopVideoChat();
  }

  // Disable all interactive UI elements so user cannot match or send messages
  if (startButton) startButton.disabled = true;
  if (stopButton) stopButton.disabled = true;
  if (nextButton) nextButton.disabled = true;
  if (recordButton) recordButton.disabled = true;
  if (chatInput) chatInput.disabled = true;
  if (sendChatButton) sendChatButton.disabled = true;
  if (reportButton) reportButton.disabled = true;
  if (chatToggleButton) chatToggleButton.disabled = true;

  // Display persistent Lockout Sticky Bar (visible at all times while site is in update)
  const stickyBar = document.getElementById("lockoutStickyBar");
  const barTitle = document.getElementById("lockoutBarTitle");
  const barBadgeText = document.getElementById("lockoutBarBadgeText");
  const statusDot = document.querySelector(".lockout-status-dot");
  const reopenBtn = document.getElementById("reopenMaintenanceModalBtn");
  const modalIcon = document.getElementById("maintenanceModalIcon");

  if (stickyBar) {
    stickyBar.classList.add("locked-announcement");
    stickyBar.classList.remove("normal-announcement");
    stickyBar.style.display = "flex";
  }

  if (barTitle) barTitle.textContent = title || "Website is in Update";
  if (barBadgeText) barBadgeText.textContent = "Update";
  if (statusDot) statusDot.style.background = "#f59e0b";
  if (modalIcon) {
    modalIcon.textContent = "🛠️";
    modalIcon.classList.remove("blue");
  }
  if (reopenBtn) reopenBtn.style.display = "inline-block";
  document.body.classList.add("has-announcement-bar");

  // Display Maintenance Modal only if user has not closed/dismissed it
  const modal = document.getElementById("maintenanceModalBackdrop");
  const titleEl = document.getElementById("maintenanceModalTitle");
  const textEl = document.getElementById("maintenanceModalText");

  if (titleEl) titleEl.textContent = title || "Website is in Update";
  if (textEl) textEl.textContent = message || "We are currently updating the platform to bring you a better experience. We will be right back!";

  if (modal) {
    if (!maintenanceModalDismissed) {
      modal.style.display = "flex";
      modal.classList.add("show");
    } else {
      modal.style.display = "none";
      modal.classList.remove("show");
    }
  }

  setStatus("Website is in Update");
}

function dismissMaintenanceModal(e) {
  if (e && typeof e.stopPropagation === "function") {
    e.stopPropagation();
  }
  maintenanceModalDismissed = true;
  const modal = document.getElementById("maintenanceModalBackdrop");
  if (modal) {
    modal.style.display = "none";
    modal.classList.remove("show");
  }
}

function openMaintenanceModal() {
  maintenanceModalDismissed = false; // Persistent until user explicitly closes it with X button
  const modal = document.getElementById("maintenanceModalBackdrop");
  if (modal) {
    modal.style.display = "flex";
    modal.classList.add("show");
  }
}

function removeMaintenanceLockout() {
  if (!isMaintenanceLocked) return;
  isMaintenanceLocked = false;
  maintenanceModalDismissed = false;
  lastMaintenanceAnnouncementId = null;
  document.body.classList.remove("maintenance-locked");

  const stickyBar = document.getElementById("lockoutStickyBar");
  if (stickyBar && !normalAnnouncementTimer) {
    stickyBar.style.display = "none";
    document.body.classList.remove("has-announcement-bar");
  }

  const modal = document.getElementById("maintenanceModalBackdrop");
  if (modal) {
    modal.style.display = "none";
    modal.classList.remove("show");
  }

  if (startButton) startButton.disabled = false;
  if (chatToggleButton) chatToggleButton.disabled = false;
  updateMatchButtons();
  updateStopButton();
  updateRecordButton();
  applyChatState();
  setStatus("Click Start Camera to begin");
}

function handlePeerDisconnected() {
  isMatched = false;
  adDisplayEligible = false;
  hideAllAds();
  closeChatChannel();
  clearChat();

  if (peerConnection) {
    try { peerConnection.close(); } catch (e) { }
  }
  peerConnection = null;
  pendingIceCandidates = [];
  remoteVideo.srcObject = null;

  updateVideoPlaceholders();
  updateMatchButtons();
  updateRecordButton();

  if (hasStartedCamera) {
    queueForMatch("Stranger left. Seeking someone new...");
  }
}

function handleBanned(reason) {
  if (mediaRecorder) stopLocalRecording();
  adDisplayEligible = false;
  hideAllAds();
  remoteVideo.srcObject = null;
  isMatched = false;
  closeChatChannel();

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }
  localStream = null;
  localVideo.srcObject = null;
  hasStartedCamera = false;
  startButton.disabled = true;

  if (socket) {
    socket.close();
    socket = null;
  }

  const modal = document.getElementById("bannedModalBackdrop");
  const reasonText = document.getElementById("bannedReasonText");
  if (reasonText) reasonText.textContent = reason || "Access suspended by moderation.";
  if (modal) modal.classList.add("show");
  setStatus("Access suspended.");
}

// If the camera or microphone is switched off by the browser / OS (permission
// revoked, device unplugged, app killed in the background), the browser fires
// "ended" on the track but nothing told the server, so the other person sat on a
// frozen video until the connection timed out. Run the normal Stop flow instead:
// it tells the server right away, which puts the other person back in the queue.
function watchLocalCameraTracks(stream) {
  stream.getTracks().forEach((track) => {
    track.addEventListener("ended", () => {
      if (localStream !== stream || !hasStartedCamera) return;
      stopVideoChat();
      setStatus("Your camera or microphone stopped. Click Start Camera to continue.");
    }, { once: true });
  });
}

// The other side's connection died without a clean "stop" (network drop, app
// closed). Leave this match and look for someone new instead of waiting.
function recoverFromDeadPeer() {
  if (!hasStartedCamera || !isMatched) return;
  sendMessage({ type: "skip" });
  handlePeerDisconnected();
  setStatus("Connection lost. Finding someone new...");
}

function stopVideoChat() {
  if (mediaRecorder) stopLocalRecording();

  // A half-finished Next jump must not carry over into the next session, and
  // no ad may stay on screen once the encounter is over.
  awaitingNextConfirmation = false;
  adDisplayEligible = false;
  hideAllAds();

  wantsMatchQueue = false;
  sendMessage({ type: "stop" });
  isMatched = false;
  updateMatchButtons();
  closeChatChannel();
  clearChat();

  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
  }
  localStream = null;

  if (peerConnection) {
    try { peerConnection.close(); } catch (e) { }
  }
  peerConnection = null;

  remoteVideo.srcObject = null;
  localVideo.srcObject = null;

  hasStartedCamera = false;
  startButton.disabled = false;
  updateStopButton();
  updateVideoPlaceholders();
  setStatus("Stopped. Click Start Camera when ready.");
}

function nextStranger() {
  if (!hasStartedCamera || !isMatched) return;

  // One ad opportunity is earned for every NEXTS_PER_AD successful Next jumps.
  // Nothing is displayed right now: the click is only counted once the next
  // match is confirmed, and the ad appears on that match.
  awaitingNextConfirmation = true;
  adDisplayEligible = false;
  hideAllAds();
  scheduleNextAd();

  // Keep an active recording running across Next. The canvas keeps drawing the
  // local camera and will naturally show the new stranger when they connect.
  // Recording ends only when the user presses Stop Recording or stops the camera.
  sendMessage({ type: "skip" });
  handlePeerDisconnected();
}


/* ============================================================
   IN-VIDEO CHAT
   ============================================================ */

function setupChatChannel(channel) {
  chatChannel = channel;
  chatChannel.addEventListener("open", () => {
    chatEnabled = true;
    applyChatState();
  });
  chatChannel.addEventListener("close", () => {
    chatChannel = null;
  });
  chatChannel.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "chat" && typeof msg.text === "string") {
        addChatMessage(msg.text, false);
      }
    } catch (e) { }
  });
}

function closeChatChannel() {
  if (chatChannel) {
    try { chatChannel.close(); } catch (e) { }
    chatChannel = null;
  }
}

function sendChatMessage() {
  if (!chatEnabled || !chatChannel || chatChannel.readyState !== "open") return;
  const text = chatInput.value.trim();
  if (!text) return;

  chatChannel.send(JSON.stringify({ type: "chat", text }));
  addChatMessage(text, true);
  chatInput.value = "";
}

function addChatMessage(text, mine) {
  const el = document.createElement("div");
  el.className = `chat-message ${mine ? "mine" : "theirs"}`;
  el.textContent = text;
  chatMessages.appendChild(el);
  requestAnimationFrame(() => {
    chatMessages.scrollTop = chatMessages.scrollHeight;
  });
}

function clearChat() {
  if (chatMessages) chatMessages.innerHTML = "";
}

function toggleChat() {
  chatEnabled = !chatEnabled;
  applyChatState();
  updateMatchButtons();
}

/* ============================================================
   REPORT MODAL
   ============================================================ */

function openReportModal() {
  if (isMatched && reportModalBackdrop) reportModalBackdrop.classList.add("show");
}

function closeReportModal() {
  if (reportModalBackdrop) reportModalBackdrop.classList.remove("show");
}

function submitReport() {
  if (!isMatched) { closeReportModal(); return; }
  const selected = document.querySelector('input[name="reportReason"]:checked');
  if (!selected) {
    alert("Please choose a reason.");
    return;
  }
  sendMessage({ type: "report", reason: selected.value });
  closeReportModal();
  setStatus("Submitting report and ending this encounter...");
}

/* ============================================================
   RECORDING DOWNLOAD
   ============================================================ */

// Destination formats. The master recording is captured once in 16:9,
// then converted locally after the user stops recording.
const recordingFormats = {
  tiktok: { label: "TikTok (9:16 vertical)" },
  instagram: { label: "Instagram Reels (9:16 vertical)" },
  "youtube-shorts": { label: "YouTube Shorts (9:16 vertical)" },
  youtube: { label: "YouTube (16:9 horizontal)" },
  original: { label: "Original (16:9 horizontal)" }
};

// Start from what the dropdown actually shows (the first option) so the
// description, this state and the exported file can never disagree.
let selectedRecordingFormat = (recordingFormatSelect && recordingFormatSelect.value) || "auto";

function updateRecordingFormatDescription() {
  if (!recordingResultText) return;
  const config = getExportConfig(selectedRecordingFormat);
  recordingResultText.textContent =
    `Captured locally on this device. Saving will create: ${config.label}.`;
}

if (recordingFormatSelect) {
  recordingFormatSelect.addEventListener("change", (e) => {
    selectedRecordingFormat = e.target.value;
    updateRecordingFormatDescription();
  });
  updateRecordingFormatDescription();
}

if (downloadRecordingButton) {
  downloadRecordingButton.addEventListener("click", async () => {
    if (!completedRecordingBlob || downloadRecordingButton.disabled) return;

    const originalText = downloadRecordingButton.textContent;
    downloadRecordingButton.disabled = true;

    try {
      const config = getExportConfig(selectedRecordingFormat);
      downloadRecordingButton.textContent = "Preparing video...";

      const exported = await exportRecordingForDownload(selectedRecordingFormat);
      if (!exported || !exported.blob || !exported.blob.size) {
        throw new Error("No recording data was produced.");
      }

      const url = URL.createObjectURL(exported.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lela-encounter-${Date.now()}-${config.filename}.${exported.extension}`;
      document.body.appendChild(a);
      a.click();
      a.remove();

      setTimeout(() => URL.revokeObjectURL(url), 3000);

      if (recordingResultBackdrop) recordingResultBackdrop.classList.remove("show");
      setStatus(`${config.label} video saved to your device.`);
    } catch (error) {
      console.error("[REC] Export failed:", error);
      alert(error.message || "Could not prepare the video for download.");
    } finally {
      downloadRecordingButton.disabled = false;
      downloadRecordingButton.textContent = originalText;
    }
  });
}

if (deleteRecordingButton) {
  deleteRecordingButton.addEventListener("click", () => {
    completedRecordingBlob = null;
    if (completedRecordingUrl) {
      URL.revokeObjectURL(completedRecordingUrl);
      completedRecordingUrl = null;
    }
    if (recordingPreview) {
      recordingPreview.pause();
      recordingPreview.removeAttribute("src");
      recordingPreview.load();
    }
    if (recordingResultBackdrop) recordingResultBackdrop.classList.remove("show");
    setStatus("Recording deleted.");
  });
}

/* ============================================================
   EVENT BINDINGS & INIT
   ============================================================ */

if (startButton) startButton.addEventListener("click", startCamera);
if (stopButton) stopButton.addEventListener("click", stopVideoChat);
if (nextButton) nextButton.addEventListener("click", nextStranger);

if (recordButton) {
  recordButton.addEventListener("click", async () => {
    if (!isMatched) return;
    if (mediaRecorder && mediaRecorder.state === "recording") {
      stopLocalRecording();
      return;
    }
    await startLocalRecording();
  });
}

if (chatToggleButton) chatToggleButton.addEventListener("click", toggleChat);
if (reportButton) reportButton.addEventListener("click", openReportModal);
if (cancelReportButton) cancelReportButton.addEventListener("click", closeReportModal);
if (submitReportButton) submitReportButton.addEventListener("click", submitReport);

const closeMaintenanceBtn = document.getElementById("closeMaintenanceModalBtn");
if (closeMaintenanceBtn) {
  closeMaintenanceBtn.addEventListener("click", dismissMaintenanceModal);
}

const dismissMaintenanceBtn = document.getElementById("dismissMaintenanceModalBtn");
if (dismissMaintenanceBtn) {
  dismissMaintenanceBtn.addEventListener("click", dismissMaintenanceModal);
}

const reopenMaintenanceBtn = document.getElementById("reopenMaintenanceModalBtn");
if (reopenMaintenanceBtn) {
  reopenMaintenanceBtn.addEventListener("click", openMaintenanceModal);
}

if (chatForm) {
  chatForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendChatMessage();
  });
}

if (reportModalBackdrop) {
  reportModalBackdrop.addEventListener("click", (e) => {
    if (e.target === reportModalBackdrop) closeReportModal();
  });
}

const maintenanceModalBackdrop = document.getElementById("maintenanceModalBackdrop");
if (maintenanceModalBackdrop) {
  maintenanceModalBackdrop.addEventListener("click", (e) => {
    if (e.target === maintenanceModalBackdrop) {
      dismissMaintenanceModal(e);
    }
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const modal = document.getElementById("maintenanceModalBackdrop");
    if (modal && (modal.style.display === "flex" || modal.classList.contains("show"))) {
      dismissMaintenanceModal();
      return;
    }
    if (isMatched && hasStartedCamera) nextStranger();
  }
});

async function checkInitialAnnouncement() {
  try {
    const res = await fetch("/api/announcement", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.announcement) {
      handleSystemAnnouncement(data.announcement);
    } else {
      if (isMaintenanceLocked || lastSeenNormalAnnouncementId) {
        handleAnnouncementCleared();
      }
    }
  } catch (_) { }
}

// Startup
updateMatchButtons();
updateStopButton();
updateRecordButton();
updateVideoPlaceholders();
applyChatState();
setStatus("Click Start Camera to begin");
checkInitialAnnouncement();
// Continuous active polling ensures lockout announcement stays visible all time until admin deletes it.
setInterval(checkInitialAnnouncement, 3000);

// Pre-connect the WebSocket immediately. This makes the camera start path fast:
// by the time the user clicks Start Camera, the signaling socket is usually
// already open and only the WebRTC offer/match negotiation remains.
connectToSignalingServer();
initAdsEngine();
