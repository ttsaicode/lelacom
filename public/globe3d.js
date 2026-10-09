/* =========================================================================
   LELA — 3D Interactive World Globe Engine
   • Pure HTML5 Canvas 3D Orthographic Sphere Projection
   • Subdued Natural Spherical Visuals: Muted, non-bright blue gradients for
     water oceans and muted, non-bright earthy green gradients for landmasses
   • Smooth radial & linear spherical gradient lighting with specular depth
   • Interactive Connection Node Tooltip: Displays approximate continent &
     region upon clicking any connection node, anchored to 3D rotation
   • WebRTC Stranger Peer Great-Circle 3D arcs & traveling photon comets
   • Smooth touch & mouse drag with momentum physics & auto-rotation
   • Full Light & Dark mode adaptation
   ========================================================================= */

(function () {
  "use strict";

  var canvas = document.getElementById("globe3dCanvas");
  if (!canvas) return;

  var ctx = canvas.getContext("2d");
  if (!ctx) return;

  var tooltipEl = document.getElementById("globeTooltip");
  var tooltipTitleEl = document.getElementById("globeTooltipTitle");
  var tooltipRegionEl = document.getElementById("globeTooltipRegion");
  var tooltipCloseEl = document.getElementById("globeTooltipClose");

  var DEG2RAD = Math.PI / 180;
  var RAD2DEG = 180 / Math.PI;

  /* ── 1. Real Continent Polygon Outlines (Lat, Lon loops) ─────────────── */
  var CONTINENTS = [
    // Africa (Mainland)
    [
      { lat: 36, lon: -5.5 }, { lat: 37, lon: 3 }, { lat: 37, lon: 10 }, { lat: 33, lon: 13 },
      { lat: 32, lon: 20 }, { lat: 31.5, lon: 30 }, { lat: 30, lon: 32.5 }, { lat: 27.5, lon: 34 },
      { lat: 22, lon: 37 }, { lat: 15, lon: 40 }, { lat: 12, lon: 44 }, { lat: 11.5, lon: 51 },
      { lat: 9, lon: 50.5 }, { lat: 5, lon: 48 }, { lat: 0, lon: 42 }, { lat: -5, lon: 39 },
      { lat: -11, lon: 40.5 }, { lat: -16, lon: 39 }, { lat: -25, lon: 34 }, { lat: -30, lon: 31 },
      { lat: -34, lon: 26 }, { lat: -34.8, lon: 20 }, { lat: -33.9, lon: 18.5 }, { lat: -28, lon: 16 },
      { lat: -22, lon: 14.5 }, { lat: -16, lon: 12 }, { lat: -10, lon: 13 }, { lat: -5, lon: 12 },
      { lat: 0, lon: 9 }, { lat: 4, lon: 7 }, { lat: 5, lon: 1 }, { lat: 5, lon: -3 },
      { lat: 4.5, lon: -7.5 }, { lat: 6.5, lon: -11 }, { lat: 9.5, lon: -13.5 }, { lat: 12, lon: -16.5 },
      { lat: 14.7, lon: -17.5 }, { lat: 20, lon: -16.5 }, { lat: 24, lon: -15.5 }, { lat: 28, lon: -12 },
      { lat: 31, lon: -10 }, { lat: 33.5, lon: -7.5 }, { lat: 35.8, lon: -5.8 }
    ],
    // Madagascar
    [
      { lat: -12.2, lon: 49.3 }, { lat: -15.5, lon: 50.5 }, { lat: -20, lon: 48.5 }, { lat: -25.5, lon: 47 },
      { lat: -25.5, lon: 45 }, { lat: -22, lon: 43.5 }, { lat: -16, lon: 44.5 }, { lat: -13.5, lon: 48 }
    ],
    // Europe & Scandinavia
    [
      { lat: 36, lon: -5.5 }, { lat: 37, lon: -1.5 }, { lat: 41, lon: 2 }, { lat: 43.5, lon: 4 },
      { lat: 43.5, lon: 7 }, { lat: 44, lon: 10 }, { lat: 41, lon: 15 }, { lat: 38, lon: 16 },
      { lat: 38.5, lon: 15 }, { lat: 40.5, lon: 18 }, { lat: 42, lon: 19 }, { lat: 40, lon: 22 },
      { lat: 37, lon: 22 }, { lat: 36.5, lon: 23 }, { lat: 40, lon: 25 }, { lat: 41, lon: 29 },
      { lat: 44, lon: 29 }, { lat: 46.5, lon: 31 }, { lat: 45, lon: 36 }, { lat: 44, lon: 38 },
      { lat: 47, lon: 39 }, { lat: 55, lon: 38 }, { lat: 60, lon: 30 }, { lat: 60, lon: 24 },
      { lat: 65, lon: 25 }, { lat: 69, lon: 20 }, { lat: 71, lon: 28 }, { lat: 70, lon: 18 },
      { lat: 62, lon: 5 }, { lat: 58, lon: 8 }, { lat: 55, lon: 9 }, { lat: 53.5, lon: 8 },
      { lat: 52, lon: 4.5 }, { lat: 51, lon: 1.5 }, { lat: 48.5, lon: -4.5 }, { lat: 46, lon: -1.5 },
      { lat: 43.5, lon: -2 }, { lat: 43.5, lon: -8.5 }, { lat: 41.5, lon: -8.8 }, { lat: 37, lon: -9 },
      { lat: 36, lon: -6 }
    ],
    // Great Britain & Ireland
    [
      { lat: 50, lon: -5 }, { lat: 50.5, lon: 1.5 }, { lat: 53, lon: 0.5 }, { lat: 55, lon: -1.5 },
      { lat: 58.5, lon: -3 }, { lat: 58.5, lon: -5 }, { lat: 56, lon: -6 }, { lat: 54, lon: -3.5 },
      { lat: 51.5, lon: -4.5 }
    ],
    // Asia & Middle East
    [
      { lat: 30, lon: 32.5 }, { lat: 31, lon: 35 }, { lat: 33, lon: 36 }, { lat: 35, lon: 36 },
      { lat: 36, lon: 31 }, { lat: 40, lon: 27 }, { lat: 41, lon: 29 }, { lat: 41, lon: 40 },
      { lat: 38, lon: 48 }, { lat: 36, lon: 53 }, { lat: 25, lon: 57 }, { lat: 23, lon: 59 },
      { lat: 17, lon: 54 }, { lat: 12.5, lon: 44 }, { lat: 14, lon: 43 }, { lat: 25, lon: 57 },
      { lat: 25, lon: 62 }, { lat: 23, lon: 68 }, { lat: 19, lon: 72.8 }, { lat: 14, lon: 74 },
      { lat: 8, lon: 77 }, { lat: 10, lon: 79.5 }, { lat: 13, lon: 80 }, { lat: 17, lon: 83 },
      { lat: 21.5, lon: 87 }, { lat: 22, lon: 91 }, { lat: 16, lon: 94 }, { lat: 10, lon: 98.5 },
      { lat: 4, lon: 100 }, { lat: 1.3, lon: 103.8 }, { lat: 4.5, lon: 103.5 }, { lat: 7, lon: 101 },
      { lat: 10, lon: 104 }, { lat: 9, lon: 106.5 }, { lat: 12, lon: 109 }, { lat: 17, lon: 107 },
      { lat: 21, lon: 108 }, { lat: 22, lon: 114 }, { lat: 24, lon: 118 }, { lat: 30, lon: 122 },
      { lat: 35, lon: 119 }, { lat: 37, lon: 122 }, { lat: 39, lon: 124 }, { lat: 38, lon: 128 },
      { lat: 35, lon: 129 }, { lat: 36, lon: 126 }, { lat: 40, lon: 127 }, { lat: 43, lon: 132 },
      { lat: 50, lon: 141 }, { lat: 55, lon: 137 }, { lat: 60, lon: 150 }, { lat: 56, lon: 160 },
      { lat: 51, lon: 156 }, { lat: 56, lon: 163 }, { lat: 65, lon: 172 }, { lat: 67, lon: 180 },
      { lat: 70, lon: 170 }, { lat: 72, lon: 140 }, { lat: 75, lon: 110 }, { lat: 72, lon: 80 },
      { lat: 70, lon: 60 }, { lat: 60, lon: 60 }, { lat: 50, lon: 55 }, { lat: 45, lon: 50 },
      { lat: 40, lon: 50 }, { lat: 37, lon: 47 }, { lat: 31, lon: 48 }
    ],
    // Japan
    [
      { lat: 45, lon: 142 }, { lat: 43, lon: 145 }, { lat: 42, lon: 141 }, { lat: 41, lon: 141 },
      { lat: 38, lon: 142 }, { lat: 35, lon: 140 }, { lat: 33.5, lon: 135 }, { lat: 31, lon: 131 },
      { lat: 33, lon: 130 }, { lat: 35, lon: 133 }, { lat: 37, lon: 137 }, { lat: 40, lon: 140 }
    ],
    // Indonesia & Southeast Asian Archipelago
    [
      { lat: 5.5, lon: 95.5 }, { lat: -5.5, lon: 105.5 }, { lat: -8.5, lon: 115 }, { lat: -8, lon: 125 },
      { lat: -2, lon: 128 }, { lat: 2, lon: 117 }, { lat: 4, lon: 115 }, { lat: 7, lon: 117 },
      { lat: 4, lon: 108 }, { lat: 1, lon: 104 }
    ],
    // North America
    [
      { lat: 7, lon: -78 }, { lat: 9, lon: -83 }, { lat: 14, lon: -88 }, { lat: 16, lon: -95 },
      { lat: 20, lon: -105 }, { lat: 23, lon: -110 }, { lat: 31, lon: -116 }, { lat: 34, lon: -120 },
      { lat: 40, lon: -124 }, { lat: 48, lon: -125 }, { lat: 54, lon: -130 }, { lat: 60, lon: -140 },
      { lat: 58, lon: -155 }, { lat: 60, lon: -165 }, { lat: 65, lon: -168 }, { lat: 71, lon: -156 },
      { lat: 70, lon: -130 }, { lat: 68, lon: -105 }, { lat: 60, lon: -95 }, { lat: 55, lon: -85 },
      { lat: 58, lon: -80 }, { lat: 62, lon: -75 }, { lat: 55, lon: -60 }, { lat: 47, lon: -53 },
      { lat: 44, lon: -64 }, { lat: 42, lon: -70 }, { lat: 38, lon: -75 }, { lat: 32, lon: -80 },
      { lat: 25, lon: -80.5 }, { lat: 27, lon: -82.5 }, { lat: 30, lon: -86 }, { lat: 29, lon: -94 },
      { lat: 26, lon: -97 }, { lat: 21, lon: -97 }, { lat: 18, lon: -92 }, { lat: 21, lon: -87 },
      { lat: 17, lon: -88 }, { lat: 15, lon: -83.5 }, { lat: 10, lon: -83 }, { lat: 8, lon: -81 }
    ],
    // South America
    [
      { lat: 12, lon: -72 }, { lat: 10, lon: -62 }, { lat: 6, lon: -55 }, { lat: 1, lon: -50 },
      { lat: -3, lon: -40 }, { lat: -5, lon: -35 }, { lat: -10, lon: -36 }, { lat: -15, lon: -39 },
      { lat: -23, lon: -42 }, { lat: -28, lon: -49 }, { lat: -34, lon: -53 }, { lat: -39, lon: -62 },
      { lat: -46, lon: -66 }, { lat: -53, lon: -68 }, { lat: -55, lon: -66 }, { lat: -53, lon: -74 },
      { lat: -45, lon: -74 }, { lat: -35, lon: -72 }, { lat: -25, lon: -70 }, { lat: -18, lon: -70 },
      { lat: -12, lon: -77 }, { lat: -5, lon: -81 }, { lat: 1, lon: -79 }, { lat: 8, lon: -77 },
      { lat: 9, lon: -75 }
    ],
    // Australia & Oceania
    [
      { lat: -12, lon: 136 }, { lat: -15, lon: 141 }, { lat: -11, lon: 142 }, { lat: -18, lon: 146 },
      { lat: -25, lon: 153 }, { lat: -30, lon: 153 }, { lat: -37, lon: 150 }, { lat: -38, lon: 145 },
      { lat: -37, lon: 140 }, { lat: -33, lon: 134 }, { lat: -32, lon: 128 }, { lat: -35, lon: 118 },
      { lat: -32, lon: 115 }, { lat: -24, lon: 113 }, { lat: -20, lon: 118 }, { lat: -16, lon: 123 },
      { lat: -14, lon: 127 }, { lat: -12, lon: 131 }
    ],
    // Tasmania
    [
      { lat: -41, lon: 145 }, { lat: -41, lon: 148 }, { lat: -43.5, lon: 147 }, { lat: -43, lon: 145 }
    ],
    // New Zealand
    [
      { lat: -35, lon: 174 }, { lat: -38, lon: 178 }, { lat: -41.5, lon: 175 }, { lat: -39, lon: 174 },
      { lat: -41, lon: 173 }, { lat: -44, lon: 171 }, { lat: -46.5, lon: 169 }, { lat: -46, lon: 166 },
      { lat: -42, lon: 171 }
    ],
    // Greenland
    [
      { lat: 60, lon: -44 }, { lat: 65, lon: -40 }, { lat: 70, lon: -25 }, { lat: 76, lon: -20 },
      { lat: 81, lon: -18 }, { lat: 83, lon: -30 }, { lat: 82, lon: -50 }, { lat: 76, lon: -68 },
      { lat: 70, lon: -54 }, { lat: 65, lon: -52 }, { lat: 60, lon: -44 }
    ],
    // Antarctica (Northern Peninsular Arc)
    [
      { lat: -64, lon: -60 }, { lat: -68, lon: -55 }, { lat: -72, lon: -15 }, { lat: -70, lon: 30 },
      { lat: -68, lon: 75 }, { lat: -66, lon: 120 }, { lat: -68, lon: 155 }, { lat: -72, lon: 175 },
      { lat: -76, lon: -160 }, { lat: -73, lon: -110 }, { lat: -68, lon: -80 }, { lat: -64, lon: -60 }
    ]
  ];

  /* ── 2. Topography Matrix Points (Matching Gradient Density) ──────────── */
  var LAND_MATRIX = [];
  (function generateDenseLandGrid() {
    function addRegion(centerLat, centerLon, radiusLat, radiusLon, count) {
      for (var i = 0; i < count; i++) {
        var u = Math.random();
        var v = Math.random();
        var r = Math.sqrt(u);
        var theta = v * 2 * Math.PI;
        var lat = centerLat + r * radiusLat * Math.sin(theta);
        var lon = centerLon + r * radiusLon * Math.cos(theta);
        LAND_MATRIX.push({ lat: lat, lon: lon });
      }
    }

    addRegion(9.0, 38.7, 5.0, 4.5, 45);   // East Africa (Ethiopia)
    addRegion(26.0, 18.0, 7.0, 16.0, 75);  // North Africa
    addRegion(-1.0, 24.0, 9.0, 11.0, 90);  // Central Africa
    addRegion(-24.0, 26.0, 8.0, 9.0, 55);  // South Africa
    addRegion(49.0, 15.0, 7.5, 14.0, 85);  // Central Europe
    addRegion(54.0, -2.5, 3.5, 3.0, 30);   // UK
    addRegion(62.0, 16.0, 6.0, 8.0, 45);   // Scandinavia
    addRegion(32.0, 108.0, 11.0, 16.0, 105);// East Asia
    addRegion(22.0, 78.0, 9.0, 10.0, 80);  // South Asia
    addRegion(58.0, 92.0, 11.0, 28.0, 85); // North Asia
    addRegion(24.0, 45.0, 6.5, 9.0, 45);   // Middle East
    addRegion(36.0, 138.0, 4.5, 4.0, 40);  // Japan
    addRegion(4.0, 108.0, 6.0, 10.0, 50);  // Southeast Asia
    addRegion(40.0, -88.0, 8.0, 14.0, 95); // Eastern North America
    addRegion(54.0, -108.0, 9.0, 18.0, 70);// Canada
    addRegion(34.0, -112.0, 6.0, 7.0, 45); // Western North America
    addRegion(-5.0, -60.0, 10.0, 14.0, 100);// Amazon / South America
    addRegion(-28.0, -60.0, 8.0, 7.0, 50); // Southern South America
    addRegion(-25.0, 133.0, 8.0, 13.0, 70);// Australia
    addRegion(-41.0, 173.0, 4.0, 3.0, 25); // New Zealand
    addRegion(73.0, -40.0, 7.0, 12.0, 40); // Greenland
  })();

  /* ── 3. Connection Nodes with Continent & Regional Geodata ────────────── */
  var CITIES = [
    {
      id: "addis",
      name: "Addis Ababa",
      flag: "🇪🇹",
      continent: "Africa",
      region: "East Africa",
      lat: 9.03,
      lon: 38.74,
      color: "#ec4899",
      home: true
    },
    {
      id: "tokyo",
      name: "Tokyo",
      flag: "🇯🇵",
      continent: "Asia",
      region: "East Asia",
      lat: 35.68,
      lon: 139.69,
      color: "#06b6d4"
    },
    {
      id: "london",
      name: "London",
      flag: "🇬🇧",
      continent: "Europe",
      region: "Western Europe",
      lat: 51.51,
      lon: -0.13,
      color: "#8b5cf6"
    },
    {
      id: "newyork",
      name: "New York",
      flag: "🇺🇸",
      continent: "North America",
      region: "Eastern Seaboard",
      lat: 40.71,
      lon: -74.01,
      color: "#38bdf8"
    },
    {
      id: "saopaulo",
      name: "São Paulo",
      flag: "🇧🇷",
      continent: "South America",
      region: "Southeast Brazil",
      lat: -23.55,
      lon: -46.63,
      color: "#10b981"
    },
    {
      id: "sydney",
      name: "Sydney",
      flag: "🇦🇺",
      continent: "Oceania",
      region: "Eastern Australia",
      lat: -33.87,
      lon: 151.21,
      color: "#f59e0b"
    },
    {
      id: "nairobi",
      name: "Nairobi",
      flag: "🇰🇪",
      continent: "Africa",
      region: "East Africa",
      lat: -1.29,
      lon: 36.82,
      color: "#f43f5e"
    },
    {
      id: "berlin",
      name: "Berlin",
      flag: "🇩🇪",
      continent: "Europe",
      region: "Central Europe",
      lat: 52.52,
      lon: 13.40,
      color: "#a855f7"
    },
    {
      id: "seoul",
      name: "Seoul",
      flag: "🇰🇷",
      continent: "Asia",
      region: "East Asia",
      lat: 37.57,
      lon: 126.98,
      color: "#6366f1"
    },
    {
      id: "paris",
      name: "Paris",
      flag: "🇫🇷",
      continent: "Europe",
      region: "Western Europe",
      lat: 48.86,
      lon: 2.35,
      color: "#c084fc"
    },
    {
      id: "cairo",
      name: "Cairo",
      flag: "🇪🇬",
      continent: "Africa",
      region: "North Africa",
      lat: 30.04,
      lon: 31.24,
      color: "#fbbf24"
    },
    {
      id: "mumbai",
      name: "Mumbai",
      flag: "🇮🇳",
      continent: "Asia",
      region: "South Asia",
      lat: 19.08,
      lon: 72.88,
      color: "#34d399"
    },
    {
      id: "sf",
      name: "San Francisco",
      flag: "🇺🇸",
      continent: "North America",
      region: "West Coast",
      lat: 37.77,
      lon: -122.42,
      color: "#60a5fa"
    },
    {
      id: "singapore",
      name: "Singapore",
      flag: "🇸🇬",
      continent: "Asia",
      region: "Southeast Asia",
      lat: 1.35,
      lon: 103.82,
      color: "#2dd4bf"
    }
  ];

  /* ── 4. WebRTC Stranger Peer Arcs (3D Great-Circles) ──────────────────── */
  var ARCS = [
    { from: "addis", to: "tokyo", color: "#ec4899", speed: 0.0035, peak: 0.22 },
    { from: "london", to: "saopaulo", color: "#38bdf8", speed: 0.0032, peak: 0.18 },
    { from: "berlin", to: "newyork", color: "#a855f7", speed: 0.0034, peak: 0.16 },
    { from: "paris", to: "nairobi", color: "#10b981", speed: 0.0040, peak: 0.18 },
    { from: "tokyo", to: "sydney", color: "#f59e0b", speed: 0.0036, peak: 0.20 },
    { from: "sf", to: "seoul", color: "#06b6d4", speed: 0.0033, peak: 0.24 },
    { from: "addis", to: "london", color: "#ec4899", speed: 0.0038, peak: 0.15 },
    { from: "mumbai", to: "singapore", color: "#34d399", speed: 0.0042, peak: 0.14 }
  ];

  var pulses = ARCS.map(function (arc, idx) {
    return {
      arcIndex: idx,
      progress: (idx * 0.25) % 1,
      speed: arc.speed || 0.0035
    };
  });

  /* ── 5. Physics & Dynamic Orientation ─────────────────────────────────── */
  var rotY = 0.85;  // Longitude yaw
  var rotX = 0.26;  // Latitude pitch
  var velY = 0;
  var velX = 0;
  var isDragging = false;
  var dragDistance = 0;
  var lastMouseX = 0;
  var lastMouseY = 0;
  var autoSpin = true;
  var lastTime = performance.now();
  var radarClock = 0;
  var selectedCity = null;

  /* ── 6. 3D Spherical Projection Math ──────────────────────────────────── */
  function to3D(lat, lon, radius) {
    var phi = lat * DEG2RAD;
    var theta = lon * DEG2RAD + rotY;

    var x0 = radius * Math.cos(phi) * Math.sin(theta);
    var y0 = radius * Math.sin(phi);
    var z0 = radius * Math.cos(phi) * Math.cos(theta);

    // Realistic axial pitch rotation
    var cosX = Math.cos(rotX);
    var sinX = Math.sin(rotX);

    var y1 = y0 * cosX - z0 * sinX;
    var z1 = y0 * sinX + z0 * cosX;

    return {
      x: x0,
      y: -y1, // Invert for canvas space
      z: z1,
      lat: lat,
      lon: lon
    };
  }

  /* ── 7. Natural Muted Spherical Palettes (Blue Water & Green Land) ────── */
  /*
     Water: Subdued, non-bright oceanic slate-blue gradient.
     Land:  Subdued, non-bright natural earthy sage/forest green gradient.
  */
  function getThemeColors() {
    var isDark = document.documentElement.getAttribute("data-theme") === "dark";

    if (isDark) {
      return {
        isDark: true,
        // Water Gradient (Subdued, non-bright oceanic blue)
        ocean0: "#1d3b5c",           // Muted dark slate-blue highlight
        ocean1: "#13273e",           // Mid oceanic navy
        ocean2: "#0b1725",           // Deep marine abyssal
        ocean3: "#060d16",           // Dark terminator shadow
        // Land Gradient (Subdued, non-bright natural forest/moss green)
        land0: "#385c42",            // Muted sage/forest green highlight
        land1: "#274430",            // Natural forest green
        land2: "#182c1f",            // Shadowed deep forest
        landStroke: "rgba(72, 115, 84, 0.7)",
        landCoastGlow: "rgba(39, 68, 48, 0.35)",
        landDot0: "rgba(72, 115, 84, 0.75)",
        landDot1: "rgba(39, 68, 48, 0.45)",
        // Atmospheric Corona (Soft and subtle)
        limbRim: "rgba(45, 85, 125, 0.5)",
        halo0: "rgba(45, 85, 125, 0.22)",
        halo1: "rgba(19, 39, 62, 0.05)",
        specular: "rgba(255, 255, 255, 0.18)",
        graticule: "rgba(255, 255, 255, 0.05)",
        equator: "rgba(75, 125, 175, 0.2)",
        textMain: "#e2e8f0",
        textSub: "#94a3b8"
      };
    } else {
      return {
        isDark: false,
        // Water Gradient (Subdued, non-bright marine slate-blue)
        ocean0: "#3b678c",           // Calm, desaturated daylight slate-blue
        ocean1: "#284b6a",           // Mid oceanic blue
        ocean2: "#1b334a",           // Deep water shadow
        ocean3: "#102030",           // Edge limb
        // Land Gradient (Subdued, non-bright natural earthy sage green)
        land0: "#4d7254",            // Soft sage green highlight
        land1: "#3b5a41",            // Natural forest green
        land2: "#273e2c",            // Earthy deep shadow green
        landStroke: "rgba(45, 70, 50, 0.8)",
        landCoastGlow: "rgba(77, 114, 84, 0.25)",
        landDot0: "rgba(59, 90, 65, 0.75)",
        landDot1: "rgba(39, 62, 44, 0.45)",
        // Atmospheric Corona
        limbRim: "rgba(40, 75, 106, 0.6)",
        halo0: "rgba(59, 103, 140, 0.2)",
        halo1: "rgba(27, 51, 74, 0.05)",
        specular: "rgba(255, 255, 255, 0.25)",
        graticule: "rgba(255, 255, 255, 0.12)",
        equator: "rgba(255, 255, 255, 0.25)",
        textMain: "#0f172a",
        textSub: "#475569"
      };
    }
  }

  /* ── 8. Responsive Canvas Resizing with High-DPI Support ──────────────── */
  var width = 560;
  var height = 560;
  var centerX = 280;
  var centerY = 280;
  var globeRadius = 220;

  function resize() {
    var rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    width = rect.width;
    height = rect.height;
    centerX = width / 2;
    centerY = height / 2;
    globeRadius = Math.min(width, height) * 0.41;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    ctx.resetTransform ? ctx.resetTransform() : ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);

    updateTooltipPosition();
  }

  window.addEventListener("resize", resize);
  resize();

  /* ── 9. Tooltip Interactive Management ────────────────────────────────── */
  function showTooltip(city) {
    if (!tooltipEl || !city) return;
    selectedCity = city;

    if (tooltipTitleEl) {
      tooltipTitleEl.textContent = (city.flag || "📍") + " " + city.name;
    }
    if (tooltipRegionEl) {
      tooltipRegionEl.textContent = city.continent + " • " + city.region;
    }

    updateTooltipPosition();
    tooltipEl.classList.add("visible");
    tooltipEl.setAttribute("aria-hidden", "false");
  }

  function hideTooltip() {
    if (!tooltipEl) return;
    selectedCity = null;
    tooltipEl.classList.remove("visible");
    tooltipEl.setAttribute("aria-hidden", "true");
  }

  if (tooltipCloseEl) {
    tooltipCloseEl.addEventListener("click", function (e) {
      e.stopPropagation();
      hideTooltip();
    });
  }

  function updateTooltipPosition() {
    if (!tooltipEl || !selectedCity) return;
    if (selectedCity.isFront && selectedCity.screenX !== undefined) {
      tooltipEl.style.left = Math.round(selectedCity.screenX) + "px";
      tooltipEl.style.top = Math.round(selectedCity.screenY) + "px";
      tooltipEl.classList.add("visible");
      tooltipEl.setAttribute("aria-hidden", "false");
    } else {
      // Temporarily hide while dot is rotated behind sphere
      tooltipEl.classList.remove("visible");
      tooltipEl.setAttribute("aria-hidden", "true");
    }
  }

  /* ── 10. Main Render Loop ─────────────────────────────────────────────── */
  function render() {
    var now = performance.now();
    var dt = (now - lastTime) / 1000;
    lastTime = now;
    radarClock += dt;

    // Smooth physics momentum or auto-rotation
    if (!isDragging) {
      if (autoSpin) {
        rotY += 0.0036;
      } else {
        rotY += velY;
        rotX += velX;
        velY *= 0.92;
        velX *= 0.92;
        if (Math.abs(velY) < 0.0003 && Math.abs(velX) < 0.0003) {
          autoSpin = true;
        }
      }
    }

    // Clamp pitch
    rotX = Math.max(-1.1, Math.min(1.1, rotX));

    ctx.clearRect(0, 0, width, height);

    var theme = getThemeColors();

    /* A. Atmospheric Limb Halo (Outer Radial Gradient) */
    ctx.save();
    var haloGrad = ctx.createRadialGradient(
      centerX, centerY, globeRadius * 0.90,
      centerX, centerY, globeRadius * 1.30
    );
    haloGrad.addColorStop(0, theme.halo0);
    haloGrad.addColorStop(0.52, theme.halo1);
    haloGrad.addColorStop(1, "rgba(0, 0, 0, 0)");
    ctx.fillStyle = haloGrad;
    ctx.beginPath();
    ctx.arc(centerX, centerY, globeRadius * 1.30, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    /* B. Spherical Oceanic Water (Rich Multi-Stop Radial Gradient) */
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, globeRadius, 0, Math.PI * 2);

    var waterGrad = ctx.createRadialGradient(
      centerX - globeRadius * 0.36,
      centerY - globeRadius * 0.36,
      globeRadius * 0.05,
      centerX,
      centerY,
      globeRadius
    );
    waterGrad.addColorStop(0, theme.ocean0);
    waterGrad.addColorStop(0.38, theme.ocean1);
    waterGrad.addColorStop(0.75, theme.ocean2);
    waterGrad.addColorStop(1, theme.ocean3);
    ctx.fillStyle = waterGrad;
    ctx.fill();

    // Specular Sun Glint on Water
    var specGrad = ctx.createRadialGradient(
      centerX - globeRadius * 0.38,
      centerY - globeRadius * 0.38,
      2,
      centerX - globeRadius * 0.34,
      centerY - globeRadius * 0.34,
      globeRadius * 0.72
    );
    specGrad.addColorStop(0, theme.specular);
    specGrad.addColorStop(0.30, "rgba(255, 255, 255, 0.06)");
    specGrad.addColorStop(1, "transparent");
    ctx.fillStyle = specGrad;
    ctx.fill();

    // Outer Atmospheric Limb Stroke
    ctx.lineWidth = 2.2;
    ctx.strokeStyle = theme.limbRim;
    ctx.stroke();
    ctx.restore();

    /* C. Circular Clip for Front-Facing Globe Geometry */
    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, globeRadius - 0.5, 0, Math.PI * 2);
    ctx.clip();

    /* D. 3D Graticules (Latitude & Longitude Gridlines) */
    var lats = [-66.5, -45, -23.5, 0, 23.5, 45, 66.5];
    for (var li = 0; li < lats.length; li++) {
      var latVal = lats[li];
      var isEquator = latVal === 0;
      var isTropic = Math.abs(latVal) === 23.5;

      ctx.beginPath();
      ctx.lineWidth = isEquator ? 1.3 : isTropic ? 0.9 : 0.6;
      ctx.strokeStyle = isEquator ? theme.equator : theme.graticule;

      var firstLat = true;
      for (var lonStep = 0; lonStep <= 360; lonStep += 6) {
        var pLat = to3D(latVal, lonStep, globeRadius);
        if (pLat.z > 0) {
          if (firstLat) {
            ctx.moveTo(centerX + pLat.x, centerY + pLat.y);
            firstLat = false;
          } else {
            ctx.lineTo(centerX + pLat.x, centerY + pLat.y);
          }
        } else {
          firstLat = true;
        }
      }
      ctx.stroke();
    }

    // Longitude Meridians
    for (var lonVal = 0; lonVal < 360; lonVal += 30) {
      ctx.beginPath();
      ctx.lineWidth = 0.6;
      ctx.strokeStyle = theme.graticule;
      var firstLon = true;
      for (var latStep = -85; latStep <= 85; latStep += 5) {
        var pLon = to3D(latStep, lonVal, globeRadius);
        if (pLon.z > 0) {
          if (firstLon) {
            ctx.moveTo(centerX + pLon.x, centerY + pLon.y);
            firstLon = false;
          } else {
            ctx.lineTo(centerX + pLon.x, centerY + pLon.y);
          }
        } else {
          firstLon = true;
        }
      }
      ctx.stroke();
    }

    /* E. Real Continent Polygons (Rendered with the SAME Gradient Spectrum) */
    // Create unified spherical land gradient matching the ocean light source
    var landSphereGrad = ctx.createRadialGradient(
      centerX - globeRadius * 0.36,
      centerY - globeRadius * 0.36,
      globeRadius * 0.05,
      centerX,
      centerY,
      globeRadius
    );
    landSphereGrad.addColorStop(0, theme.land0);
    landSphereGrad.addColorStop(0.45, theme.land1);
    landSphereGrad.addColorStop(1, theme.land2);

    for (var ci = 0; ci < CONTINENTS.length; ci++) {
      var poly = CONTINENTS[ci];
      var drawnSegments = [];
      var currentSegment = [];

      for (var pi = 0; pi < poly.length; pi++) {
        var node = poly[pi];
        var pt = to3D(node.lat, node.lon, globeRadius);
        if (pt.z > -0.05) {
          currentSegment.push(pt);
        } else {
          if (currentSegment.length > 1) {
            drawnSegments.push(currentSegment);
          }
          currentSegment = [];
        }
      }
      if (currentSegment.length > 1) {
        drawnSegments.push(currentSegment);
      }

      for (var si = 0; si < drawnSegments.length; si++) {
        var seg = drawnSegments[si];

        // 1. Continental Shelf Glow (Harmonious gradient reef edge)
        ctx.beginPath();
        for (var sp0 = 0; sp0 < seg.length; sp0++) {
          var spt0 = seg[sp0];
          var sx0 = centerX + spt0.x;
          var sy0 = centerY + spt0.y;
          if (sp0 === 0) ctx.moveTo(sx0, sy0);
          else ctx.lineTo(sx0, sy0);
        }
        ctx.lineWidth = 4.0;
        ctx.strokeStyle = theme.landCoastGlow;
        ctx.stroke();

        // 2. Landmass Solid Fill with Matching Sphere Gradient
        ctx.beginPath();
        for (var sp = 0; sp < seg.length; sp++) {
          var spt = seg[sp];
          var sx = centerX + spt.x;
          var sy = centerY + spt.y;
          if (sp === 0) ctx.moveTo(sx, sy);
          else ctx.lineTo(sx, sy);
        }
        ctx.fillStyle = landSphereGrad;
        ctx.fill();

        // 3. Crisp Coastal Shoreline Stroke
        ctx.lineWidth = 1.3;
        ctx.strokeStyle = theme.landStroke;
        ctx.stroke();
      }
    }

    /* F. Dense Topography Matrix Points (Matching Gradient Hues) */
    for (var mi = 0; mi < LAND_MATRIX.length; mi++) {
      var lpt = LAND_MATRIX[mi];
      var pos = to3D(lpt.lat, lpt.lon, globeRadius);
      if (pos.z > 0) {
        var depth = pos.z / globeRadius;
        var alpha = Math.max(0.25, depth * 0.92);

        ctx.fillStyle = depth > 0.5 ? theme.landDot0 : theme.landDot1;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        var dSize = 1.4 + depth * 1.0;
        ctx.arc(centerX + pos.x, centerY + pos.y, dSize, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;

    /* G. Great-Circle 3D Parabolic Flight Arcs (Live Stranger Connections) */
    var cityMap = {};
    for (var c = 0; c < CITIES.length; c++) {
      cityMap[CITIES[c].id] = CITIES[c];
    }

    for (var a = 0; a < ARCS.length; a++) {
      var arc = ARCS[a];
      var cityA = cityMap[arc.from];
      var cityB = cityMap[arc.to];
      if (!cityA || !cityB) continue;

      var steps = 36;
      var arcPoints = [];
      var hasFrontPoints = false;

      for (var s = 0; s <= steps; s++) {
        var t = s / steps;
        var lat = cityA.lat + (cityB.lat - cityA.lat) * t;
        var lon = cityA.lon + (cityB.lon - cityA.lon) * t;
        var alt = globeRadius * (1 + (arc.peak || 0.18) * Math.sin(Math.PI * t));
        var pArc = to3D(lat, lon, alt);
        arcPoints.push(pArc);
        if (pArc.z > 0) hasFrontPoints = true;
      }

      if (hasFrontPoints) {
        ctx.save();
        ctx.beginPath();
        ctx.strokeStyle = arc.color;
        ctx.lineWidth = 2.2;
        ctx.shadowColor = arc.color;
        ctx.shadowBlur = 12;
        ctx.lineCap = "round";

        var pathStarted = false;
        for (var ap = 0; ap < arcPoints.length; ap++) {
          var p3 = arcPoints[ap];
          if (p3.z > -0.15) {
            var px = centerX + p3.x;
            var py = centerY + p3.y;
            if (!pathStarted) {
              ctx.moveTo(px, py);
              pathStarted = true;
            } else {
              ctx.lineTo(px, py);
            }
          }
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    /* H. Traveling Quantum Photon Pulses on Connecting Arcs */
    for (var pl = 0; pl < pulses.length; pl++) {
      var pulse = pulses[pl];
      pulse.progress = (pulse.progress + pulse.speed) % 1;
      var curArc = ARCS[pulse.arcIndex];
      if (!curArc) continue;

      var cA = cityMap[curArc.from];
      var cB = cityMap[curArc.to];
      if (!cA || !cB) continue;

      var prg = pulse.progress;
      var curLat = cA.lat + (cB.lat - cA.lat) * prg;
      var curLon = cA.lon + (cB.lon - cA.lon) * prg;
      var curAlt = globeRadius * (1 + (curArc.peak || 0.18) * Math.sin(Math.PI * prg));
      var photon = to3D(curLat, curLon, curAlt);

      if (photon.z > 0) {
        ctx.save();
        // Luminous Core
        ctx.beginPath();
        ctx.arc(centerX + photon.x, centerY + photon.y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.shadowColor = curArc.color;
        ctx.shadowBlur = 14;
        ctx.fill();

        // Comet Glow Halo
        ctx.beginPath();
        ctx.arc(centerX + photon.x, centerY + photon.y, 8.0, 0, Math.PI * 2);
        ctx.fillStyle = curArc.color;
        ctx.globalAlpha = 0.5;
        ctx.fill();
        ctx.restore();
      }
    }

    /* I. Connection Node Beacons & Concentric Radar Waves */
    for (var k = 0; k < CITIES.length; k++) {
      var city = CITIES[k];
      var beacon = to3D(city.lat, city.lon, globeRadius);

      city.screenX = centerX + beacon.x;
      city.screenY = centerY + beacon.y;
      city.isFront = beacon.z > 0;

      if (beacon.z > 0) {
        var depthScale = Math.max(0.3, beacon.z / globeRadius);
        var isSelected = selectedCity && selectedCity.id === city.id;

        // Concentric Radar Wave Ripple
        var waveRadius = (radarClock * 24 + k * 9) % 28;
        var waveAlpha = Math.max(0, 1 - waveRadius / 28) * 0.85;

        ctx.beginPath();
        ctx.arc(city.screenX, city.screenY, waveRadius, 0, Math.PI * 2);
        ctx.strokeStyle = city.color || "#8b5cf6";
        ctx.globalAlpha = waveAlpha * depthScale;
        ctx.lineWidth = isSelected ? 2.0 : 1.4;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Core Beacon Dot
        ctx.save();
        ctx.beginPath();
        var beaconSize = isSelected ? 7.2 : city.home ? 5.8 : 4.6;
        ctx.arc(city.screenX, city.screenY, beaconSize, 0, Math.PI * 2);
        ctx.fillStyle = city.color || "#8b5cf6";
        ctx.shadowColor = city.color || "#8b5cf6";
        ctx.shadowBlur = isSelected ? 22 : city.home ? 16 : 10;
        ctx.fill();

        // White Center Specular Highlight
        ctx.lineWidth = isSelected ? 2.2 : 1.8;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        ctx.restore();

        // City Tag when Front-Facing
        if (beacon.z > globeRadius * 0.32) {
          ctx.font = isSelected || city.home ? "700 11.5px var(--f-mono)" : "600 10px var(--f-mono)";
          ctx.fillStyle = theme.textMain;
          ctx.shadowColor = theme.isDark ? "rgba(0, 0, 0, 0.95)" : "rgba(255, 255, 255, 0.95)";
          ctx.shadowBlur = 5;
          var tag = city.name + " " + city.flag;
          ctx.fillText(tag, city.screenX + 10, city.screenY + 3.5);
        }
      }
    }

    ctx.restore(); // End Spherical Clip

    // Dynamic Tooltip Anchor Tracking with Globe 3D Rotation
    if (selectedCity) {
      updateTooltipPosition();
    }

    requestAnimationFrame(render);
  }

  requestAnimationFrame(render);

  /* ── 11. Mouse & Touch Interaction (Click Detection & 3D Drag) ────────── */
  function onStart(x, y) {
    isDragging = true;
    dragDistance = 0;
    autoSpin = false;
    lastMouseX = x;
    lastMouseY = y;
    velX = 0;
    velY = 0;
  }

  function onMove(x, y) {
    if (!isDragging) return;

    var dx = x - lastMouseX;
    var dy = y - lastMouseY;
    dragDistance += Math.hypot(dx, dy);
    lastMouseX = x;
    lastMouseY = y;

    var speed = 0.0065;
    rotY += dx * speed;
    rotX -= dy * speed;

    velY = dx * speed * 0.45;
    velX = -dy * speed * 0.45;
  }

  function onEnd() {
    isDragging = false;
  }

  // Find if click hit any connection dot
  function checkCityClick(clientX, clientY) {
    var rect = canvas.getBoundingClientRect();
    var clickX = clientX - rect.left;
    var clickY = clientY - rect.top;

    var clicked = null;
    var minDist = 28; // Click target radius

    for (var i = 0; i < CITIES.length; i++) {
      var c = CITIES[i];
      if (c.isFront) {
        var dist = Math.hypot(clickX - c.screenX, clickY - c.screenY);
        if (dist < minDist) {
          minDist = dist;
          clicked = c;
        }
      }
    }

    if (clicked) {
      showTooltip(clicked);

      // Trigger a new glowing great-circle arc to another random hub
      var otherIndex = (Math.floor(Math.random() * (CITIES.length - 1)) + 1) % CITIES.length;
      var otherCity = CITIES[otherIndex];
      if (otherCity.id !== clicked.id) {
        ARCS.push({
          from: clicked.id,
          to: otherCity.id,
          color: clicked.color,
          speed: 0.0045,
          peak: 0.22
        });
        pulses.push({
          arcIndex: ARCS.length - 1,
          progress: 0,
          speed: 0.0055
        });
        if (ARCS.length > 14) {
          ARCS.splice(8, 1);
          pulses.splice(8, 1);
        }
      }
    } else {
      // Clicked on background: dismiss tooltip if not dragging
      if (dragDistance < 6) {
        hideTooltip();
      }
    }
  }

  canvas.addEventListener("mousedown", function (e) {
    onStart(e.clientX, e.clientY);
  });

  window.addEventListener("mousemove", function (e) {
    onMove(e.clientX, e.clientY);
  });

  window.addEventListener("mouseup", function (e) {
    if (isDragging && dragDistance < 8) {
      checkCityClick(e.clientX, e.clientY);
    }
    onEnd();
  });

  canvas.addEventListener("touchstart", function (e) {
    if (e.touches.length === 1) {
      onStart(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  window.addEventListener("touchmove", function (e) {
    if (isDragging && e.touches.length === 1) {
      onMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: true });

  window.addEventListener("touchend", function (e) {
    if (isDragging && dragDistance < 8 && e.changedTouches.length === 1) {
      checkCityClick(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
    }
    onEnd();
  });

})();
