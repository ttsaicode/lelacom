"use strict";

/* ============================================================
   DOM ELEMENTS
   ============================================================ */

const localVideo  = document.getElementById("localVideo");
const remoteVideo = document.getElementById("remoteVideo");

const localPlaceholder  = document.getElementById("localPlaceholder");
const remotePlaceholder = document.getElementById("remotePlaceholder");

const startButton  = document.getElementById("startButton");
const stopButton   = document.getElementById("stopButton");
const nextButton   = document.getElementById("nextButton");
const recordButton = document.getElementById("recordButton");

const chatToggleButton = document.getElementById("chatToggleButton");
const reportButton     = document.getElementById("reportButton");

const statusElement      = document.getElementById("status");
const onlineCountElement = document.getElementById("onlineCountText");

const chatForm       = document.getElementById("chatForm");
const chatInput      = document.getElementById("chatInput");
const chatMessages   = document.getElementById("chatMessages");
const sendChatButton = document.getElementById("sendChatButton");

const reportModalBackdrop = document.getElementById("reportModalBackdrop");
const cancelReportButton  = document.getElementById("cancelReportButton");
const submitReportButton  = document.getElementById("submitReportButton");

const recordingStatus = document.getElementById("recordingStatus");
const recordingTime   = document.getElementById("recordingTime");

const recordingResultBackdrop = document.getElementById("recordingResultBackdrop");
const recordingResultText     = document.getElementById("recordingResultText");
const recordingPreview        = document.getElementById("recordingPreview");
const downloadRecordingButton = document.getElementById("downloadRecordingButton");
const deleteRecordingButton   = document.getElementById("deleteRecordingButton");
const recordingFormatSelect   = document.getElementById("recordingFormatSelect");

const broadcastBanner  = document.getElementById("broadcastBanner");
const broadcastMessage = document.getElementById("broadcastMessage");

// Sponsored Ads Elements
const adContainer    = document.getElementById("sponsoredBannerContainer");
const adCard         = document.getElementById("sponsoredCard");
const adMediaSlot    = document.getElementById("sponsoredMediaSlot");
const adTitleEl      = document.getElementById("sponsoredTitle");
const adDescEl       = document.getElementById("sponsoredDesc");
const adCtaEl        = document.getElementById("sponsoredCta");
const adCloseBtn     = document.getElementById("sponsoredCloseBtn");
const strangerAdSlot = document.getElementById("strangerAdSlot");
const swapLayoutBtn  = document.getElementById("swapLayoutBtn");
const videoGridEl    = document.getElementById("videoGrid");

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

let rtcConfiguration = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:free.expressturn.com:3478" },
    {
      urls: [
        "turn:free.expressturn.com:3478?transport=udp",
        "turn:free.expressturn.com:3478?transport=tcp"
      ],
      username: "000000002103732653",
      credential: "rgTyOIK/8pVvQzdnm7e5jave1MA="
    }
  ],
  iceTransportPolicy: "all",
  iceCandidatePoolSize: 10,
  bundlePolicy: "max-bundle",
  rtcpMuxPolicy: "require"
};

/* ============================================================
   STATE
   ============================================================ */

let localStream          = null;
let peerConnection       = null;
let socket               = null;
let chatChannel          = null;
let pendingIceCandidates = [];
let hasStartedCamera     = false;
let isMatched            = false;
let chatEnabled          = true;

let mediaRecorder           = null;
let recordingChunks         = [];
let recordingCanvas         = null;
let recordingContext        = null;
let recordingCanvasStream   = null;
let recordingAnimationFrame = null;
let recordingTimer          = null;
let recordingStartedAt      = 0;
let recordingElapsedMs      = 0;

let recordingAudioContext     = null;
let recordingAudioDestination = null;
let recordingAudioSources     = [];

let completedRecordingBlob    = null;
let completedRecordingUrl     = null;

// Dynamic Ads State
let activeAdsList = [];
let currentAdIndex = 0;
let adRotationTimer = null;
let adDismissed = false;

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
  if (nextButton)       nextButton.disabled       = !isMatched;
  if (reportButton)     reportButton.disabled     = !isMatched;
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

    if (activeAdsList.length > 0 && !adDismissed) {
      currentAdIndex = 0;
      renderCurrentAd();
      scheduleNextAd();
    } else {
      hideAllAds();
    }
  } catch (err) {
    console.warn("[ADS] Failed to load sponsored ads:", err);
  }
}

function renderCurrentAd() {
  if (!activeAdsList.length || adDismissed || !adCard) return;

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
  fetch(`/api/ads/${encodeURIComponent(ad.id)}/impression`, { method: "POST" }).catch(() => {});

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
    if (ad.link_url && /^https?:\/\//i.test(ad.link_url)) {
      adCtaEl.href = ad.link_url;
      adCtaEl.style.display = "inline-flex";
      adCtaEl.onclick = () => {
        fetch(`/api/ads/${encodeURIComponent(ad.id)}/click`, { method: "POST" }).catch(() => {});
      };
    } else {
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

      // Left controls: Play/Pause and Mute toggle
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
          vid.play().then(() => { playBtn.innerHTML = "⏸"; }).catch(() => {});
        } else {
          vid.pause();
          playBtn.innerHTML = "▶";
        }
      };

      const muteBtn = document.createElement("button");
      muteBtn.type = "button";
      muteBtn.className = "pip-ctrl-btn";
      muteBtn.title = "Mute / Unmute Sound";
      muteBtn.innerHTML = "🔇";
      muteBtn.onclick = (e) => {
        e.stopPropagation();
        vid.muted = !vid.muted;
        muteBtn.innerHTML = vid.muted ? "🔇" : "🔊";
      };

      leftControls.appendChild(playBtn);
      leftControls.appendChild(muteBtn);

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
        } catch (_) {}
      };

      controls.appendChild(leftControls);
      controls.appendChild(popoutBtn);

      vid.onended = () => {
        if (activeAdsList.length > 1 && !adDismissed) {
          if (adRotationTimer) clearTimeout(adRotationTimer);
          currentAdIndex = (currentAdIndex + 1) % activeAdsList.length;
          renderCurrentAd();
          scheduleNextAd();
        } else {
          vid.currentTime = 0;
          vid.play().catch(() => {});
        }
      };

      wrapper.appendChild(vid);
      wrapper.appendChild(controls);
      wrapper.appendChild(progressTrack);
      adMediaSlot.appendChild(wrapper);

      vid.play().catch(() => {});
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

function scheduleNextAd() {
  if (adRotationTimer) clearTimeout(adRotationTimer);
  if (activeAdsList.length <= 1) return;

  const current = activeAdsList[currentAdIndex];
  const delayMs = (current?.rotation_seconds || adSettings.rotationSeconds || 12) * 1000;

  adRotationTimer = setTimeout(() => {
    if (adDismissed) return;
    currentAdIndex = (currentAdIndex + 1) % activeAdsList.length;
    renderCurrentAd();
    scheduleNextAd();
  }, delayMs);
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
  const total   = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60).toString().padStart(2, "0");
  const secs    = (total % 60).toString().padStart(2, "0");
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

function chooseRecordingFormat() {
  const format = getRecordingFormat();
  if (format.mimeType) {
    return { mimeType: format.mimeType, extension: format.extension };
  }
  
  const candidates = [
    { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4" },
    { mimeType: "video/mp4", extension: "mp4" },
    { mimeType: "video/webm;codecs=vp9,opus", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8,opus", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" }
  ];
  return candidates.find((item) => MediaRecorder.isTypeSupported(item.mimeType)) || { mimeType: "video/webm", extension: "webm" };
}

function drawRecordingFrame() {
  if (!recordingContext || !recordingCanvas) return;

  const width  = recordingCanvas.width;
  const height = recordingCanvas.height;
  const gap    = Math.round(width * 0.015);
  const cardWidth = Math.floor((width - gap) / 2);

  recordingContext.fillStyle = "#080a12";
  recordingContext.fillRect(0, 0, width, height);

  drawVideoToCanvas(remoteVideo, 0, 0, cardWidth, height);
  drawVideoToCanvas(localVideo, cardWidth + gap, 0, cardWidth, height);

  if (mediaRecorder && mediaRecorder.state === "recording") {
    recordingAnimationFrame = requestAnimationFrame(drawRecordingFrame);
  }
}

function drawVideoToCanvas(video, x, y, width, height) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    recordingContext.fillStyle = "#121526";
    recordingContext.fillRect(x, y, width, height);
    return;
  }

  const sourceRatio = video.videoWidth / video.videoHeight;
  const targetRatio = width / height;

  let sx = 0, sy = 0;
  let sw = video.videoWidth;
  let sh = video.videoHeight;

  if (sourceRatio > targetRatio) {
    sw = Math.round(video.videoHeight * targetRatio);
    sx = Math.round((video.videoWidth - sw) / 2);
  } else {
    sh = Math.round(video.videoWidth / targetRatio);
    sy = Math.round((video.videoHeight - sh) / 2);
  }

  recordingContext.drawImage(video, sx, sy, sw, sh, x, y, width, height);
}

function setupRecordingAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;

  try {
    recordingAudioContext     = new AudioContextClass();
    recordingAudioDestination = recordingAudioContext.createMediaStreamDestination();
    recordingAudioSources     = [];

    const addStream = (stream) => {
      if (!stream || !stream.getAudioTracks().length) return;
      try {
        const source = recordingAudioContext.createMediaStreamSource(stream);
        source.connect(recordingAudioDestination);
        recordingAudioSources.push(source);
      } catch (e) {}
    };

    addStream(localStream);
    addStream(remoteVideo.srcObject);

    if (recordingAudioContext.state === "suspended") {
      recordingAudioContext.resume().catch(() => {});
    }

    return recordingAudioDestination.stream.getAudioTracks()[0] || null;
  } catch (error) {
    return null;
  }
}

async function startLocalRecording() {
  if (!isMatched) return;
  if (mediaRecorder && (mediaRecorder.state === "recording" || mediaRecorder.state === "paused")) return;

  try {
    recordingCanvas = document.createElement("canvas");
    recordingCanvas.width  = 1280;
    recordingCanvas.height = 720;
    recordingContext = recordingCanvas.getContext("2d");
    if (!recordingContext) throw new Error("Could not create canvas context");

    recordingCanvasStream = recordingCanvas.captureStream(30);

    const audioTrack = setupRecordingAudio();
    if (audioTrack) recordingCanvasStream.addTrack(audioTrack);

    const recordingFormat = chooseRecordingFormat();

    mediaRecorder = new MediaRecorder(recordingCanvasStream, {
      mimeType: recordingFormat.mimeType,
      videoBitsPerSecond: 3500000
    });

    recordingChunks    = [];
    recordingElapsedMs = 0;
    recordingStartedAt = Date.now();

    mediaRecorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0) recordingChunks.push(e.data);
    });

    mediaRecorder.addEventListener("stop", finishLocalRecording, { once: true });
    mediaRecorder.start(500);

    setRecordingIndicators(true);
    updateRecordButton();
    setStatus("🔴 Recording encounter...");

    recordingTimer = setInterval(updateRecordingTimer, 250);
    drawRecordingFrame();
  } catch (err) {
    console.error("[REC] Recording failed to start:", err);
    alert("Could not start recording on this device.");
  }
}

function stopLocalRecording() {
  if (!mediaRecorder) return;
  if (mediaRecorder.state === "recording" && recordingStartedAt) {
    recordingElapsedMs += Date.now() - recordingStartedAt;
  }
  recordingStartedAt = 0;

  try {
    if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
  } catch (e) {
    finishLocalRecording();
  }

  clearInterval(recordingTimer);
  recordingTimer = null;
  setRecordingIndicators(false);
  setStatus("Finishing recording...");
}

function finishLocalRecording() {
  const recorderMimeType = mediaRecorder?.mimeType || "video/webm";
  const blob = new Blob(recordingChunks, { type: recorderMimeType });
  recordingChunks = [];

  mediaRecorder = null;
  clearInterval(recordingTimer);
  recordingTimer = null;
  if (recordingAnimationFrame) cancelAnimationFrame(recordingAnimationFrame);
  recordingAnimationFrame = null;

  setRecordingIndicators(false);
  updateRecordButton();

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

  if (recordingResultBackdrop) recordingResultBackdrop.classList.add("show");
  setStatus("Encounter ready. Preview or save it to your device.");
}

/* ============================================================
   WEBSOCKET SIGNALING & WEBRTC
   ============================================================ */

function connectToSignalingServer() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const protocol  = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socketUrl = `${protocol}//${window.location.host}`;

  socket = new WebSocket(socketUrl);

  socket.addEventListener("open", () => {
    if (hasStartedCamera) setStatus("Connected. Seeking match...");
  });

  socket.addEventListener("message", async (event) => {
    try {
      const message = JSON.parse(event.data);

      if (message.type === "online-count") {
        if (onlineCountElement) {
          const count = Number.isFinite(Number(message.count)) ? Number(message.count) : 0;
          onlineCountElement.textContent = `${count} online`;
        }
        return;
      }

      await handleSignalingMessage(message);
    } catch (error) {
      console.error("[LELA] Socket message error:", error);
    }
  });

  socket.addEventListener("close", () => {
    socket = null;
    if (hasStartedCamera) setStatus("Disconnected. Reconnecting...");
    setTimeout(() => { if (hasStartedCamera) connectToSignalingServer(); }, 2000);
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

    localStream          = stream;
    localVideo.srcObject = localStream;
    hasStartedCamera     = true;
    startButton.disabled = true;

    updateStopButton();
    updateVideoPlaceholders();

    connectToSignalingServer();

    if (socket && socket.readyState === WebSocket.OPEN) {
      createPeerConnection();
      sendMessage({ type: "ready" });
      setStatus("Seeking stranger...");
    } else {
      setStatus("Connecting to server...");
      const interval = setInterval(() => {
        if (!hasStartedCamera) { clearInterval(interval); return; }
        if (socket && socket.readyState === WebSocket.OPEN) {
          clearInterval(interval);
          createPeerConnection();
          sendMessage({ type: "ready" });
          setStatus("Seeking stranger...");
        }
      }, 150);
    }
  } catch (err) {
    hasStartedCamera = false;
    startButton.disabled = false;
    updateStopButton();
    setStatus("Camera/Mic access denied.");
    alert("Please allow camera and microphone permissions to enter video chat.");
  }
}

function createPeerConnection() {
  if (peerConnection) {
    try { peerConnection.close(); } catch (e) {}
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
      updateVideoPlaceholders();
      remoteVideo.play().catch(() => {});
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
    if (state === "failed") setStatus("Connection failed. Try Next.");
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
      isMatched   = true;
      chatEnabled = true;
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
        await peerConnection.addIceCandidate(new RTCIceCandidate(pendingIceCandidates.shift())).catch(() => {});
      }
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      sendMessage({ type: "answer", answer: peerConnection.localDescription });
      break;

    case "answer":
      if (peerConnection) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(message.answer));
        while (pendingIceCandidates.length) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(pendingIceCandidates.shift())).catch(() => {});
        }
      }
      break;

    case "ice-candidate":
      if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate)).catch(() => {});
      } else {
        pendingIceCandidates.push(message.candidate);
      }
      break;

    case "peer-disconnected":
      handlePeerDisconnected();
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
  closeChatChannel();
  clearChat();

  if (peerConnection) {
    try { peerConnection.close(); } catch (e) {}
  }
  peerConnection = null;
  pendingIceCandidates = [];
  remoteVideo.srcObject = null;

  updateVideoPlaceholders();
  updateMatchButtons();
  updateRecordButton();

  if (hasStartedCamera) {
    createPeerConnection();
    sendMessage({ type: "ready" });
    setStatus("Stranger left. Seeking someone new...");
  }
}

function handleBanned(reason) {
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

function stopVideoChat() {
  if (mediaRecorder) stopLocalRecording();

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
    try { peerConnection.close(); } catch (e) {}
  }
  peerConnection = null;

  remoteVideo.srcObject = null;
  localVideo.srcObject  = null;

  hasStartedCamera = false;
  startButton.disabled = false;
  updateStopButton();
  updateVideoPlaceholders();
  setStatus("Stopped. Click Start Camera when ready.");
}

function nextStranger() {
  if (!hasStartedCamera) return;
  
  // Reset ad dismissal state so ads can show again after Next is clicked
  adDismissed = false;
  if (activeAdsList.length > 0) {
    currentAdIndex = 0;
    renderCurrentAd();
    scheduleNextAd();
  }
  
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
    } catch (e) {}
  });
}

function closeChatChannel() {
  if (chatChannel) {
    try { chatChannel.close(); } catch (e) {}
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
  alert("Violation report submitted to moderators.");
}

/* ============================================================
   RECORDING DOWNLOAD
   ============================================================ */

// Format configurations for different platforms
const recordingFormats = {
  auto: { mimeType: null, extension: "webm", label: "Auto (Best Quality)" },
  youtube: { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4", label: "YouTube (MP4, 16:9)" },
  tiktok: { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4", label: "TikTok (MP4, 9:16)" },
  instagram: { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4", label: "Instagram Reels (MP4, 9:16)" },
  "instagram-square": { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4", label: "Instagram Feed (MP4, 1:1)" },
  webm: { mimeType: "video/webm;codecs=vp9,opus", extension: "webm", label: "WebM (VP9/Opus)" },
  mp4: { mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", extension: "mp4", label: "MP4 (H.264/AAC)" }
};

let selectedRecordingFormat = "auto";

function getRecordingFormat() {
  const format = recordingFormats[selectedRecordingFormat] || recordingFormats.auto;
  // Check if the mimeType is supported, fallback to auto
  if (format.mimeType && !MediaRecorder.isTypeSupported(format.mimeType)) {
    return recordingFormats.auto;
  }
  return format;
}

if (recordingFormatSelect) {
  recordingFormatSelect.addEventListener("change", (e) => {
    selectedRecordingFormat = e.target.value;
  });
}

if (downloadRecordingButton) {
  downloadRecordingButton.addEventListener("click", () => {
    if (!completedRecordingBlob) return;
    
    const format = getRecordingFormat();
    const url = URL.createObjectURL(completedRecordingBlob);
    const a = document.createElement("a");
    a.href = url;
    const timestamp = Date.now();
    const platformSuffix = selectedRecordingFormat !== "auto" ? `-${selectedRecordingFormat}` : "";
    a.download = `lela-encounter-${timestamp}${platformSuffix}.${format.extension}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    if (recordingResultBackdrop) recordingResultBackdrop.classList.remove("show");
  });
}

if (deleteRecordingButton) {
  deleteRecordingButton.addEventListener("click", () => {
    completedRecordingBlob = null;
    if (recordingResultBackdrop) recordingResultBackdrop.classList.remove("show");
  });
}

/* ============================================================
   EVENT BINDINGS & INIT
   ============================================================ */

if (startButton) startButton.addEventListener("click", startCamera);
if (stopButton)  stopButton.addEventListener("click", stopVideoChat);
if (nextButton)  nextButton.addEventListener("click", nextStranger);

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

if (chatToggleButton)   chatToggleButton.addEventListener("click", toggleChat);
if (reportButton)       reportButton.addEventListener("click", openReportModal);
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
  } catch (_) {}
}

// Startup
updateMatchButtons();
updateStopButton();
updateRecordButton();
updateVideoPlaceholders();
applyChatState();
setStatus("Click Start Camera to begin");
checkInitialAnnouncement();
// Continuous active polling ensures lockout announcement stays visible all time until admin deletes it
setInterval(checkInitialAnnouncement, 3000);
connectToSignalingServer();
initAdsEngine();
