/* =========================================================================
   LELA — landing behaviour
   • Passive WebSocket: listen only for the online count. This page never
     sends matchmaking payloads; it only observes.
   • Contact form: client-side validation, then POST /api/contact.
   • Theme toggle (light/dark) and language switch (EN/AM), both persisted.
   • Hamburger drawer for responsive navigation.
   ========================================================================= */
(function () {
  "use strict";

  /* ── Language ────────────────────────────────────────────────────────── */

  function currentLang() {
    return window.lelaCurrentLang ? window.lelaCurrentLang() : "en";
  }

  function t(key) {
    var dict = (window.LELA_I18N || {})[currentLang()] || {};
    var value = dict[key];
    if (value == null) {
      value = (window.LELA_I18N || {}).en ? window.LELA_I18N.en[key] : null;
    }
    return value == null ? "" : value;
  }

  /* Apply the stored language once language.js is ready. */
  if (window.lelaApplyLang) {
    window.lelaApplyLang(currentLang());
  }

  /* ── Live count ──────────────────────────────────────────────────────── */

  var liveCount = null;

  function renderCount() {
    var els = document.querySelectorAll(".js-live-count");

    for (var i = 0; i < els.length; i += 1) {
      if (liveCount === null) {
        els[i].textContent = t("live.initial");
      } else {
        els[i].textContent = t("live.count").replace("{n}", String(liveCount));
      }
    }
  }

  renderCount();

  /* Passive observer: connects, listens, never sends. */
  (function connectCount() {
    var url =
      (window.location.protocol === "https:" ? "wss://" : "ws://") +
      window.location.host;

    var socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      return; // Count stays at its resting label; nothing else depends on it.
    }

    socket.addEventListener("message", function (event) {
      var payload;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        return;
      }

      if (payload && payload.type === "online-count") {
        liveCount = typeof payload.count === "number" ? payload.count : null;
        renderCount();
      }
    });

    /* The server may restart; reconnect quietly after a pause. */
    socket.addEventListener("close", function () {
      liveCount = null;
      renderCount();
      window.setTimeout(connectCount, 8000);
    });
  })();

  /* ── Theme ───────────────────────────────────────────────────────────── */

  function effectiveTheme() {
    var attr = document.documentElement.getAttribute("data-theme");
    if (attr === "dark" || attr === "light") return attr;
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  function updateThemeLabels() {
    var next =
      effectiveTheme() === "dark" ? t("theme.toLight") : t("theme.toDark");
    var toggles = document.querySelectorAll(".theme-toggle");

    for (var i = 0; i < toggles.length; i += 1) {
      toggles[i].setAttribute("aria-label", next);
    }
  }

  function toggleTheme() {
    var next = effectiveTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);

    try {
      window.localStorage.setItem("lela-theme", next);
    } catch (error) {
      /* Storage blocked: the session still honors the toggle. */
    }

    updateThemeLabels();
  }

  updateThemeLabels();

  /* Follow the OS if the visitor has not chosen yet. */
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", function () {
      if (!document.documentElement.getAttribute("data-theme")) {
        updateThemeLabels();
      }
    });

  var themeToggles = document.querySelectorAll(".theme-toggle");
  for (var i = 0; i < themeToggles.length; i += 1) {
    themeToggles[i].addEventListener("click", toggleTheme);
  }

  /* ── Language buttons ────────────────────────────────────────────────── */

  function setLang(lang) {
    if (lang !== "am" && lang !== "en") return;

    try {
      window.localStorage.setItem("lela-lang", lang);
    } catch (error) {
      /* Storage blocked: the switch still works for this page view. */
    }

    if (window.lelaApplyLang) window.lelaApplyLang(lang);

    renderCount();
    updateThemeLabels();
    updateFormLabels();
  }

  var langButtons = document.querySelectorAll("[data-lang]");
  for (var j = 0; j < langButtons.length; j += 1) {
    langButtons[j].addEventListener("click", function (event) {
      setLang(event.currentTarget.getAttribute("data-lang"));
    });
  }

  /* ── Hamburger drawer ────────────────────────────────────────────────── */

  var burger = document.getElementById("navBurger");
  var drawer = document.getElementById("navDrawer");
  var backdrop = document.getElementById("drawerBackdrop");
  var drawerClose = document.getElementById("drawerClose");

  function drawerIsOpen() {
    return document.body.classList.contains("nav-open");
  }

  function openDrawer() {
    document.body.classList.add("nav-open");
    if (burger) burger.setAttribute("aria-expanded", "true");
    if (drawerClose) drawerClose.focus();
  }

  function closeDrawer(returnFocus) {
    document.body.classList.remove("nav-open");
    if (burger) burger.setAttribute("aria-expanded", "false");
    if (returnFocus && burger) burger.focus();
  }

  if (burger) {
    burger.addEventListener("click", function () {
      if (drawerIsOpen()) closeDrawer(true);
      else openDrawer();
    });
  }

  if (drawerClose) {
    drawerClose.addEventListener("click", function () {
      closeDrawer(true);
    });
  }

  if (backdrop) {
    backdrop.addEventListener("click", function () {
      closeDrawer(true);
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && drawerIsOpen()) {
      closeDrawer(true);
    }
  });

  /* Navigating from the drawer should close it (same-page hash links). */
  if (drawer) {
    var drawerLinks = drawer.querySelectorAll("a");
    for (var k = 0; k < drawerLinks.length; k += 1) {
      drawerLinks[k].addEventListener("click", function () {
        closeDrawer(false);
      });
    }
  }

  /* ── Contact form (only on /contact) ─────────────────────────────────── */

  var form = document.getElementById("contact-form");

  function updateFormLabels() {
    if (!form) return;
    /* Re-translate the validation messages currently on screen. */
    var emailError = document.getElementById("c-email-error");
    var messageError = document.getElementById("c-message-error");
    if (emailError && emailError.getAttribute("data-i18n-err") === "email") {
      emailError.textContent = t("ct.err.email");
    }
    if (messageError && messageError.getAttribute("data-i18n-err") === "message") {
      messageError.textContent = t("ct.err.message");
    }
  }

  if (form) {
    var panel = document.getElementById("form-panel");
    var formMsg = document.getElementById("form-msg");
    var submitBtn = document.getElementById("c-submit");
    var emailInput = document.getElementById("c-email");
    var messageInput = document.getElementById("c-message");
    var emailError = document.getElementById("c-email-error");
    var messageError = document.getElementById("c-message-error");
    var againBtn = document.getElementById("c-again");
    var sentHeading = document.getElementById("sent-heading");

    function setError(errorEl, inputEl, key) {
      if (key) {
        errorEl.textContent = t(key);
        errorEl.setAttribute("data-i18n-err", key === "ct.err.email" ? "email" : "message");
        inputEl.setAttribute("aria-invalid", "true");
        inputEl.setAttribute("aria-describedby", errorEl.id);
      } else {
        errorEl.textContent = "";
        errorEl.removeAttribute("data-i18n-err");
        inputEl.removeAttribute("aria-invalid");
        inputEl.removeAttribute("aria-describedby");
      }
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();

      var valid = true;

      if (!emailInput.value.trim() || emailInput.value.indexOf("@") === -1) {
        setError(emailError, emailInput, "ct.err.email");
        valid = false;
      } else {
        setError(emailError, emailInput, null);
      }

      if (messageInput.value.trim().length < 10) {
        setError(messageError, messageInput, "ct.err.message");
        valid = false;
      } else {
        setError(messageError, messageInput, null);
      }

      if (!valid) {
        formMsg.textContent = "";
        var firstInvalid = form.querySelector('[aria-invalid="true"]');
        if (firstInvalid) firstInvalid.focus();
        return;
      }

      var originalLabel = t("ct.send");

      submitBtn.disabled = true;
      submitBtn.textContent = t("ct.sending");
      form.setAttribute("aria-busy", "true");
      formMsg.textContent = "";

      var payload = {
        topic: document.getElementById("c-topic").value,
        email: emailInput.value.trim(),
        message: messageInput.value.trim(),
        website: document.getElementById("c-website").value
      };

      var nameInput = document.getElementById("c-name");
      if (nameInput && nameInput.value.trim()) {
        payload.name = nameInput.value.trim();
      }

      fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      })
        .then(function (response) {
          if (response.status === 429) return Promise.reject("rate");
          if (response.status >= 400) return Promise.reject("generic");
          return response;
        })
        .then(function () {
          panel.classList.add("is-sent");
          form.removeAttribute("aria-busy");
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
          if (sentHeading) sentHeading.focus();
        })
        .catch(function (reason) {
          form.removeAttribute("aria-busy");
          submitBtn.disabled = false;
          submitBtn.textContent = originalLabel;
          if (reason === "rate") formMsg.textContent = t("ct.err.rate");
          else if (!navigator.onLine) formMsg.textContent = t("ct.err.offline");
          else formMsg.textContent = t("ct.err.generic");
        });
    });

    if (againBtn) {
      againBtn.addEventListener("click", function () {
        panel.classList.remove("is-sent");
        form.reset();
        setError(emailError, emailInput, null);
        setError(messageError, messageInput, null);
        formMsg.textContent = "";
        emailInput.focus();
      });
    }
  }

  /* ── Magnetic hover: a gradient trail that follows the pointer
     and blooms over interactive targets. ─────────────────────────────────────
     • Only on fine pointers + no reduced-motion.
     • 4 trail segments, each chasing the one ahead with increasing lag.
     • Lead segment blooms on hot targets; tail fades naturally. */
  (function setupMagneticGlow() {
    if (!window.matchMedia("(pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    var TRAIL_COUNT = 4;
    var trail = [];
    for (var i = 0; i < TRAIL_COUNT; i++) {
      var node = document.createElement("div");
      node.className = "mag-glow" + (i === 0 ? " mag-glow-lead" : "");
      node.setAttribute("aria-hidden", "true");
      document.body.appendChild(node);
      trail.push({ el: node, x: -100, y: -100 });
    }

    var targetX = -100;
    var targetY = -100;
    var tracking = false;
    var hot = false;

    function frame() {
      // Lead chases pointer
      trail[0].x += (targetX - trail[0].x) * 0.22;
      trail[0].y += (targetY - trail[0].y) * 0.22;
      trail[0].el.style.transform = "translate3d(" + trail[0].x + "px, " + trail[0].y + "px, 0)";

      // Each tail segment chases the one ahead with increasing lag
      for (var i = 1; i < TRAIL_COUNT; i++) {
        var lag = 0.12 + i * 0.06; // 0.18, 0.24, 0.30
        trail[i].x += (trail[i - 1].x - trail[i].x) * lag;
        trail[i].y += (trail[i - 1].y - trail[i].y) * lag;
        trail[i].el.style.transform = "translate3d(" + trail[i].x + "px, " + trail[i].y + "px, 0)";
      }
      window.requestAnimationFrame(frame);
    }
    window.requestAnimationFrame(frame);

    document.addEventListener("pointermove", function (e) {
      targetX = e.clientX;
      targetY = e.clientY;
      if (!tracking) {
        tracking = true;
        // Snap all segments to pointer on entry
        for (var i = 0; i < TRAIL_COUNT; i++) {
          trail[i].x = targetX;
          trail[i].y = targetY;
        }
        trail[0].el.classList.add("is-on");
      }
    });

    document.addEventListener("pointerover", function (e) {
      var t = e.target;
      var isHot = t && t.closest
        ? t.closest("a, button, input, select, textarea, .pane, .never-card, .about-band")
        : null;
      if (isHot !== hot) {
        hot = !!isHot;
        trail[0].el.classList.toggle("is-hot", hot);
      }
    });

    document.documentElement.addEventListener("pointerleave", function () {
      tracking = false;
      hot = false;
      trail[0].el.classList.remove("is-on", "is-hot");
    });
  })();

})();
