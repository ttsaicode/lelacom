/* Apply the stored theme and language before first paint — no flash of the
   wrong theme, no language popup. Storage failure falls back to defaults:
   system theme, English (or an Amharic browser, which is a choice the
   visitor's own device already made). */
(function () {
  "use strict";

  var root = document.documentElement;

  try {
    var theme = localStorage.getItem("lela-theme");
    if (theme === "dark" || theme === "light") {
      root.setAttribute("data-theme", theme);
    }

    var lang = localStorage.getItem("lela-lang");
    if (lang !== "am" && lang !== "en") {
      var browserLang = (navigator.language || "en").toLowerCase();
      lang = browserLang.indexOf("am") === 0 ? "am" : "en";
    }
    root.setAttribute("lang", lang);
    root.setAttribute("data-lang", lang);
  } catch (error) {
    /* Private mode or blocked storage: document defaults are fine. */
  }
})();
