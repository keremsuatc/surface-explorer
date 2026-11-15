// NISAR Flood Explorer — start screen: a 3D globe (MapLibre GL JS, loaded only when needed) and an accessible event list.
// The globe is only for choosing an event; the Leaflet analysis map is not touched here.
// Event names, dates, descriptions and product status come from web/data (events.json, <event>/text.en.json, <event>/layers.json).
(function () {
  const I = window.I18N;
  const t = (k, v) => I.t(k, v);
  const LIB = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.6.0/";
  // NASA Blue Marble Shaded Relief and Bathymetry (MODIS) via NASA GIBS, EPSG:3857, max level 8
  const TILES = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg";
  const ATTRIB = "NASA Blue Marble via NASA GIBS (ESDIS)"; // full acknowledgement is printed under the event list
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const narrow = window.matchMedia("(max-width: 720px)");

  let api = null;          // provided by app.js: { events, texts, getLayers(id), openEvent(id) }
  let items = [];          // [{ id, entry, text, center: [lon, lat] }]
  let selected = null;
  let cards = {};          // v76: data/cards.json (record web.card): image, short title, place, one sentence per event
  const cardOf = (it) => (cards[it.id] ? I.tx(cards[it.id]) : null);
  let globe = null;        // the single MapLibre map (created once, reused)
  let libPromise = null;   // the library is requested once
  let globeState = "idle"; // idle | loading | ready | failed  ("ready" = map created; its style and imagery may still be loading)
  let travelling = false;  // a start-screen → analysis or event → event transition owns the globe camera
  const SELECT_Z = 3.2;    // globe zoom when an event is chosen on the start screen
  let globeImagery = "pending"; // pending | ok | failed: first Blue Marble tiles shown (needed for a visible flight)
  const markers = {};
  // v69: event type (catalog record "hazard", copied to events.json) → one emblem used on the globe, in the event list, in the preview and in the
  // map's event cards. Same box, same stroke width; flood: two blue waves, wildfire: an amber flame. The type filter shows one type or all.
  const HAZ = {
    flood: { svg: '<path d="M3 10c1.5-1.6 3-1.6 4.5 0s3 1.6 4.5 0 3-1.6 4.5 0 3 1.6 4.5 0"/><path d="M3 15.5c1.5-1.6 3-1.6 4.5 0s3 1.6 4.5 0 3-1.6 4.5 0 3 1.6 4.5 0"/>', name: "Flood" },
    wildfire: { svg: '<path d="M12 3.5c.6 2.6 2.6 4.3 3.9 6.4 1.6 2.6 1.1 6.1-1.3 7.9a5 5 0 0 1-7.7-4.4c.1-1.9 1.1-3.3 2.4-4.5.1 1.5.7 2.6 1.8 3.1-.5-3 .2-5.8.9-8.5z"/>', name: "Wildfire" },
    // v73: earthquake: a purple broken (zigzag) line, like a seismogram trace
    earthquake: { svg: '<path d="M2.5 12.5h3.2l1.9-4.6 2.6 9.2 2.9-12.6 2.6 10.4 1.7-2.4h4.1"/>', name: "Earthquake" },
  };
  const hazardOf = (it) => (it && HAZ[it.hazard] ? it.hazard : "flood");
  const emblem = (hz, cls = "") => `<span class="hz hz-${hz} ${cls}" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${HAZ[hz].svg}</svg></span>`;
  window.NFEHazard = { emblem: (hz, cls) => emblem(HAZ[hz] ? hz : "flood", cls), types: () => Object.keys(HAZ) };
  let hazardFilter = "all"; // all | flood | wildfire | earthquake
  // v69: on phones the label beside a globe marker is the short name (before " · "), so it is not cut off at the globe's edge
  // v76: the globe names an event like its card (the part of the card title before ":", e.g. "Tibet–Nepal")
  const markerLabel = (it) => { const c = cards[it.id], cd = c ? I.t(c.marker || c.title) : null; // v78: optional short "marker" name
    return cd ? cd.split(":")[0] : (narrow.matches ? it.text.event.place.split(" · ")[0] : it.text.event.place); };
  const shownByFilter = (it) => hazardFilter === "all" || hazardOf(it) === hazardFilter;

  function webglAvailable() {
    try {
      const c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
    } catch (e) { return false; }
  }

  // Loads the MapLibre stylesheet and script once; rejects if either fails or takes too long
  function loadLibrary() {
    if (window.maplibregl) return Promise.resolve(window.maplibregl);
    if (libPromise) return libPromise;
    libPromise = new Promise((resolve, reject) => {
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = LIB + "maplibre-gl.css";
      document.head.appendChild(css);
      const js = document.createElement("script");
      js.src = LIB + "maplibre-gl.js";
      js.async = true;
      const timer = setTimeout(() => reject(new Error("timed out")), 20000);
      js.onload = () => { clearTimeout(timer); window.maplibregl ? resolve(window.maplibregl) : reject(new Error("library missing")); };
      js.onerror = () => { clearTimeout(timer); reject(new Error("could not be downloaded")); };
      document.head.appendChild(js);
    });
    libPromise.catch(() => { libPromise = null; }); // a later visit may try again
    return libPromise;
  }

  function globeFailed(reason) {
    globeState = "failed";
    $("globe").hidden = true;
    $("globe-loading").hidden = true;
    $("globe-hint").hidden = true;
    const box = $("globe-fallback");
    box.hidden = false;
    failReason = reason;
    box.textContent = t("The 3D globe is not available here ({reason}). Use the list to choose an event.", { reason: t(reason) });
  }
  let failReason = null;

  // Diameter of the globe on screen, from the projected limb along the equator through the current centre
  function globeDiameter() {
    const c = globe.getCenter();
    const mid = globe.project([c.lng, 0]).x;
    let edge = -Infinity;
    for (let d = 40; d <= 90; d += 0.5) edge = Math.max(edge, globe.project([c.lng + d, 0]).x);
    return 2 * (edge - mid);
  }
  // Zoom so that the globe fills ~90 % of the shorter side of its box (bisection; projection only, no animation)
  function fitGlobe() {
    const el = $("globe");
    const target = 0.9 * Math.min(el.clientWidth, el.clientHeight);
    if (!(target > 0)) return;
    let lo = 0, hi = 4;
    for (let i = 0; i < 18; i++) {
      const z = (lo + hi) / 2;
      globe.jumpTo({ zoom: z });
      globeDiameter() < target ? (lo = z) : (hi = z);
    }
    globe.jumpTo({ zoom: (lo + hi) / 2 });
    startZoom = (lo + hi) / 2;
  }
  let startZoom = 1;

  async function initGlobe() {
    if (globeState === "ready" || globeState === "loading") return;
    if (!webglAvailable()) return globeFailed("this browser or device does not support WebGL");
    globeState = "loading";
    $("globe-fallback").hidden = true;
    $("globe").hidden = false;
    let ml;
    try { ml = await loadLibrary(); } catch (e) { return globeFailed("the globe library could not be loaded"); }
    // Start size: the globe fills about 90 % of the shorter side of its box.
    // Start size: the globe fills about 90 % of the shorter side of its box. The on-screen size of a MapLibre globe is not a simple
    // function of zoom, so the zoom is found by measuring the projected edge of the globe (fitGlobe, after the style has loaded).
    const box = $("globe");
    try {
      globe = new ml.Map({
        container: "globe",
        style: {
          version: 8,
          projection: { type: "globe" },
          sources: { bluemarble: { type: "raster", tiles: [TILES], tileSize: 256, maxzoom: 8, attribution: ATTRIB } },
          layers: [
            { id: "space", type: "background", paint: { "background-color": "#0b1220" } },
            { id: "bluemarble", type: "raster", source: "bluemarble" },
          ],
        },
        center: [62, 2], zoom: 1, minZoom: 0, maxZoom: 6,
        attributionControl: { compact: true },
        cooperativeGestures: narrow.matches, // on phones one finger scrolls the page; two fingers move the globe
        dragRotate: false, pitchWithRotate: false, touchPitch: false,
        fadeDuration: reducedMotion.matches ? 0 : 300,
      });
    } catch (e) { return globeFailed("the globe could not start"); }
    window.nfeGlobe = globe; // for debugging (like window.nisarMap)
    globe.addControl(new ml.NavigationControl({ showCompass: false }), "top-right");
    // Movement hint, shown once the globe exists. With cooperative gestures (phones) one finger scrolls the page and only
    // two fingers turn the globe, so the hint says exactly that instead of "Drag to rotate".
    const coop = !!(globe.cooperativeGestures && globe.cooperativeGestures.isEnabled());
    globeHint = () => {
      $("globe-hint").textContent = coop ? t("Use two fingers to turn the globe.") : t("Drag to rotate · Select a marker");
      // v66: MapLibre's own two-finger / Ctrl+scroll messages, in the chosen language (they are English by default)
      const box = globe.getContainer();
      const mob = box.querySelector(".maplibregl-mobile-message"), desk = box.querySelector(".maplibregl-desktop-message");
      if (mob) mob.textContent = t("Use two fingers to move the map");
      if (desk) desk.textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? t("Use ⌘ + scroll to zoom the map") : t("Use Ctrl + scroll to zoom the map");
    };
    globeHint();
    $("globe-hint").hidden = false;

    // Loading message: removed only when imagery tiles have really loaded, or replaced by an error message
    const t0 = performance.now();
    let tilesOk = 0, tilesErr = 0, loadDone = false;
    window.nfeGlobeTiming = { started: Math.round(t0) };
    $("globe-loading").hidden = false;
    $("globe-loading").textContent = t("Loading the globe…");
    globe.on("sourcedata", (e) => {
      if (e.sourceId === "bluemarble" && e.tile && !tilesOk++) window.nfeGlobeTiming.firstTileMs = Math.round(performance.now() - t0);
    });
    globe.on("error", (e) => {
      if (e && e.sourceId === "bluemarble") tilesErr++;
      if (window.console) console.warn("Globe:", e && e.error ? e.error.message : e);
    });
    const onIdle = () => {
      if (loadDone) return;
      if (tilesOk > 0) {
        loadDone = true;
        globeImagery = "ok";
        window.nfeGlobeTiming.loadedMs = Math.round(performance.now() - t0);
        $("globe-loading").hidden = true;
      } else if (tilesErr > 0) {
        loadDone = true;
        globeImagery = "failed";
        window.nfeGlobeTiming.failedMs = Math.round(performance.now() - t0);
        $("globe-loading").textContent = t("The globe imagery could not be loaded. The markers and the event list still work.");
      }
    };
    globe.on("idle", onIdle);
    globeAria = () => {
      globe.getCanvas().setAttribute("aria-label", t("Globe. Drag to turn it, use the + and − buttons or the arrow keys to move. The event list next to it does the same."));
      for (const [sel, k] of [[".maplibregl-ctrl-zoom-in", "Zoom in"], [".maplibregl-ctrl-zoom-out", "Zoom out"]]) {
        const b = globe.getContainer().querySelector(sel);
        if (b) { b.title = t(k); b.setAttribute("aria-label", t(k)); }
      }
      for (const it of items) if (markers[it.id]) {
        const el = markers[it.id].getElement();
        el.setAttribute("aria-label", t("{place}: open this event", { place: it.text.event.place }));
        el.querySelector(".gm-label").textContent = markerLabel(it);
      }
    };
    globeAria();

    // Markers: the element is only the dot, centred exactly on the study-area centre; the label sits beside it (CSS)
    for (const it of items) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "globe-marker gm-" + hazardOf(it);
      el.setAttribute("aria-label", t("{place}: open this event", { place: it.text.event.place }));
      el.innerHTML = emblem(hazardOf(it), "gm-emblem") + `<span class="gm-label" aria-hidden="true">${esc(markerLabel(it))}</span>`;
      el.addEventListener("click", (ev) => { ev.stopPropagation(); select(it.id, { from: "marker" }); });
      markers[it.id] = new ml.Marker({ element: el, anchor: "center", opacityWhenCovered: "0" }).setLngLat(it.center).addTo(globe);
    }
    // Markers on the far side: hidden, not clickable and skipped by Tab. Checked on every move with MapLibre's own occlusion test
    // (the same test it uses for opacityWhenCovered), so the state never lags one view behind.
    const occluded = (m) => (globe.transform && globe.transform.isLocationOccluded
      ? globe.transform.isLocationOccluded(m.getLngLat()) : m.getElement().style.opacity === "0");
    const syncCovered = () => {
      const width = globe.getContainer().clientWidth;
      for (const m of Object.values(markers)) {
        const el = m.getElement();
        // label on the left when it would run past the right edge (the dot itself never moves)
        const x = globe.project(m.getLngLat()).x;
        const lab = el.querySelector(".gm-label");
        el.classList.toggle("label-left", x + 30 + lab.offsetWidth > width);
        const covered = occluded(m) || el.classList.contains("filtered");
        if (el.classList.contains("covered") !== covered) {
          el.classList.toggle("covered", covered);
          el.tabIndex = covered ? -1 : 0;
          if (covered && document.activeElement === el) $("intro-list").querySelector("button").focus();
        }
      }
    };
    globe.on("move", syncCovered);
    globe.on("render", syncCovered);
    // First load: fit the whole globe only while nothing is chosen. An event chosen before the globe finished loading keeps its
    // view (no jump back to the start view), and a running transition keeps full control of the camera.
    globe.once("load", () => {
      syncCovered();
      if (travelling) return;
      if (!selected) { fitGlobe(); return; }
      const it = itemOf(selected);
      if (it && !globe.isMoving()) globe.jumpTo({ center: it.center, zoom: SELECT_Z });
    });
    // box size changed (window resized, phone rotated): keep the whole globe in view while no event is selected
    // (not during a transition: the globe box is resized there on purpose and fitGlobe would cut the flight short)
    globe.on("resize", () => { if (!selected && !travelling && !stageOn && globe.isStyleLoaded()) { fitGlobe(); syncCovered(); } });
    globeState = "ready";
    syncPressed();
  }

  function syncPressed() {
    for (const it of items) {
      const on = it.id === selected;
      const li = document.querySelector(`#intro-list [data-id="${it.id}"]`);
      if (li) li.setAttribute("aria-pressed", String(on));
      if (markers[it.id]) markers[it.id].getElement().classList.toggle("on", on);
    }
  }

  // v58: one tap on an event card (or its globe marker) opens that event. No second button: the card shows "Opening…" while the
  // map loads, and further taps are ignored until the event is open (or the start screen is shown again).
  let opening = null;
  // v61 (design of v57): choosing an event (list or globe marker) opens a short preview on the same screen —
  // place, short date, one sentence and one button. Only "Open map" starts the move to the map.
  function setCardsBusy(id) {
    opening = id;
    for (const b of document.querySelectorAll("#intro-list .intro-item")) b.setAttribute("aria-disabled", String(!!id));
    for (const b of document.querySelectorAll("#intro-list .ie-open")) { b.disabled = !!id; b.textContent = id === b.dataset.id ? t("Opening…") : t("Open map"); }
    const ob = $("intro-open");
    if (ob) { ob.disabled = !!id; ob.textContent = id ? t("Opening…") : t("Open map"); if (id) ob.setAttribute("aria-busy", "true"); else ob.removeAttribute("aria-busy"); }
  }
  function renderPreview() {
    const box = $("intro-card");
    const it = items.find((x) => x.id === selected);
    if (!it) { box.hidden = true; box.innerHTML = ""; document.body.classList.remove("preview-open"); return; }
    const ev = it.text.event, cd = cardOf(it);
    box.hidden = false;
    document.body.classList.add("preview-open");
    box.innerHTML = `<button type="button" class="ic-close" aria-label="${esc(t("Close preview"))}">×</button>` +
      `<p class="ic-place" id="intro-card-title">${emblem(hazardOf(it), "ic-emblem")}<span>${esc(cd ? cd.title : ev.place.replace(" · ", ", "))}</span></p>` +
      `<p class="ic-dates">${esc(it.eventDate ? I.fmt.day(it.eventDate) : cap(I.fmt.month(it.lastDate)))}</p>` + // v65: a one-day event shows its day
      `<p class="ic-lede">${esc(cd ? cd.sentence : ev.lede)}</p>` +
      `<button type="button" id="intro-open" class="btn btn-primary">${esc(opening === it.id ? t("Opening…") : t("Open map"))}</button>`;
    $("intro-open").addEventListener("click", () => openCard(it.id));
    box.querySelector(".ic-close").addEventListener("click", closePreview);
    if (opening) setCardsBusy(opening);
  }
  function closePreview() {
    if (opening) return;
    const id = selected;
    selected = null;
    syncPressed();
    renderPreview();
    const li = id && document.querySelector(`#intro-list [data-id="${id}"]`);
    if (li) li.focus({ preventScroll: true });
  }
  function openCard(id) {
    if (opening) return;                // double tap while the map opens
    const it = items.find((x) => x.id === id);
    if (!it) return;
    selected = id;
    syncPressed();
    setCardsBusy(id);
    explore(id);
  }
  function select(id) {
    if (opening) return;
    const it = items.find((x) => x.id === id);
    if (!it) return;
    selected = id;
    syncPressed();
    renderPreview();
    if (globe && globeState === "ready") {
      const to = { center: it.center, zoom: SELECT_Z };
      reducedMotion.matches || document.hidden ? globe.jumpTo(to) : globe.flyTo({ ...to, duration: 1600, essential: false });
    }
    $("intro-open").focus({ preventScroll: true });
  }

  function setAppInert(on) {
    for (const el of document.querySelectorAll("body > .top, body > main.layout, body > .skip")) {
      if (on) el.setAttribute("inert", ""); else el.removeAttribute("inert"); // inert: not focusable and hidden from screen readers
    }
    document.body.classList.toggle("intro-open", on);
  }

  function show() {
    travelToken++;          // cancel any running transition
    travelling = false;
    if (stageOn) clearStage();
    for (const n of SCREENS) $(n).hidden = true; // v75: the start menu and the stories are closed
    document.body.classList.remove("story-open");
    $("intro").hidden = false;
    setCardsBusy(null);
    selected = null; syncPressed(); renderPreview();
    setAppInert(true);
    history.replaceState(null, "", location.pathname + location.search + "#map"); // v75: the globe and event list (#map); no event in the address
    document.title = t("Surface Explorer — NISAR flood observations");
    $("intro-h").focus({ preventScroll: true });
    window.scrollTo(0, 0);
    $("intro").scrollTop = 0;
    if (globeState === "ready") requestAnimationFrame(() => { globe.resize(); if (globe.isStyleLoaded()) fitGlobe(); }); // same map object, no new WebGL context
    else initGlobe();
  }

  function explore(id) { return travel(id); }

  // ---------------------------------------------------------------------------------------------------------------
  // Camera transitions between the globe (MapLibre) and the analysis map (Leaflet).
  // The two maps are different libraries, so the hand-off is a short cross-fade at a matched view: same centre, same
  // screen rectangle (the globe box is moved onto the Leaflet map's rectangle) and the same metres-per-pixel scale,
  // measured on the globe at that moment. No terrain or event-date imagery is added; the globe keeps its Blue Marble texture.
  //   "Explore event" (from the globe):  globe box → map rectangle, globe flies in, cross-fade, Leaflet flies to the study area (~3 s)
  //   event → event (from the analysis): Leaflet zooms out, cross-fade, globe arcs to the new place, cross-fade, Leaflet zooms in (~4.8 s)
  // Every step checks a token, so a newer request (or "Skip animation") cancels older steps; only the last choice opens.
  const HANDOFF_Z = 6;       // globe zoom at the hand-off (its maximum; Leaflet ≈ zoom 7 at the same scale, measured at run time)
  const OUT_Z = 7;           // Leaflet zoom where the analysis map hands over to the globe
  const FADE_MS = 300;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const GLOBE_WAIT_MS = 4000; // longest wait for the globe before an event opens directly instead

  // The globe can show a flight: map created, style loaded and the first imagery tiles drawn
  const globeFlyable = () => globeState === "ready" && !!globe && globe.isStyleLoaded() && globeImagery === "ok";
  // Waits (with a short message) until the globe can fly; false if it fails, is too slow, or a newer choice was made
  async function waitForGlobe(tok, it) {
    if (globeFlyable()) return true;
    if (globeState === "idle") initGlobe();
    // On the start screen the button itself shows the message (the floating bar would cover the event card on phones);
    // the bar stays in the page as a status line for screen readers. From the analysis the bar is shown as usual.
    const onStart = !$("intro").hidden && !stageOn;
    const bar = $("travel-bar");
    bar.hidden = false;
    bar.classList.toggle("sr-status", onStart);
    setLabel(t("Preparing the globe for {place}…", { place: placeName(it) }), false);
    const btn = null; // v58: the event card itself says "Opening…"
    const t0 = performance.now();
    while (!globeFlyable()) {
      if (tok !== travelToken || globeState === "failed" || globeImagery === "failed" || performance.now() - t0 > GLOBE_WAIT_MS) break;
      await sleep(100);
    }
    if (window.nfeTravelLog) window.nfeTravelLog.push({ name: globeFlyable() ? "globe-wait-ok" : "globe-wait-gave-up", ms: Math.round(performance.now() - t0) });
    void btn;
    bar.classList.remove("sr-status");
    return globeFlyable();
  }
  let travelToken = 0;
  let stageOn = false;       // globe box shown over the analysis map
  let travelTarget = null;
  let loading = null;        // promise of the target event's loadEvent
  window.nfeTravelLog = [];  // phase timings of the last transitions (for testing)
  const logPhase = (tok, name) => { if (tok === travelToken) window.nfeTravelLog.push({ tok, name, t: Math.round(performance.now()) }); };

  const placeName = (it) => it.text.event.place.split(" · ").reverse().join(", "); // "Chokwe, Mozambique"
  const itemOf = (id) => items.find((x) => x.id === id);

  // The label + "Skip animation" bar sits on top of everything (not inside the globe box, which is invisible while the analysis map
  // zooms out), centred near the bottom of the analysis map's rectangle
  function setLabel(text, showSkip = true) {
    const bar = $("travel-bar");
    if (bar.parentNode !== document.body) document.body.appendChild(bar);
    $("travel-label").textContent = text;
    $("travel-skip").hidden = !showSkip;
    const r = api.leaflet.rect();
    Object.assign(bar.style, { left: `${r.left + r.width / 2}px`, bottom: `${Math.max(8, window.innerHeight - r.bottom + 40)}px`, maxWidth: `${r.width - 24}px` });
  }
  // Waits for a map's moveend, with a safety timeout (animations stall in background tabs)
  const waitMoveEnd = (m, ms) => new Promise((res) => { let done = false; const f = () => { if (!done) { done = true; res(); } }; m.once("moveend", f); setTimeout(f, ms); });
  const waitTransition = (ms) => sleep(ms + 30);
  // Resolves when the loaded Leaflet tiles on screen have finished their fade-in (or after maxMs)
  async function tilesShown(m, maxMs) {
    const t0 = performance.now(), box = m.getContainer().getBoundingClientRect();
    while (performance.now() - t0 < maxMs) {
      const fading = [...m.getContainer().querySelectorAll(".leaflet-tile.leaflet-tile-loaded")].some((t) => {
        const r = t.getBoundingClientRect();
        return r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom && +getComputedStyle(t).opacity < 0.99;
      });
      if (!fading) return true;
      await sleep(30);
    }
    return false;
  }

  // Globe scale at its centre: pixels per degree of latitude (the globe is locally conformal)
  function globePxPerDegLat() {
    const c = globe.getCenter();
    const a = globe.project([c.lng, c.lat - 0.02]), b = globe.project([c.lng, c.lat + 0.02]);
    return Math.hypot(a.x - b.x, a.y - b.y) / 0.04;
  }
  // Leaflet (Web Mercator, 256 px tiles): px per degree latitude at lat φ = 256·2^z / 360 / cos φ
  const leafletZoomFor = (pxPerDeg, lat) => Math.log2((pxPerDeg * Math.cos((lat * Math.PI) / 180) * 360) / 256);
  function globeZoomForLeaflet(z, center) {
    const target = (256 * Math.pow(2, z)) / 360 / Math.cos((center.lat * Math.PI) / 180);
    let gz = z - 1;
    for (let i = 0; i < 4; i++) { globe.jumpTo({ center, zoom: gz }); gz += Math.log2(target / globePxPerDegLat()); }
    globe.jumpTo({ center, zoom: gz });
  }
  // Leaflet view with exactly this centre and (fractional) zoom
  function leafletSetExact(center, z) {
    const m = api.leaflet.map, snap = m.options.zoomSnap;
    m.options.zoomSnap = 0;
    m.setView([center.lat, center.lng], z, { animate: false });
    m.options.zoomSnap = snap;
  }

  // Globe box: from its place on the start screen (or invisible) onto the analysis map's rectangle
  function placeStage(rect, animate) {
    const wrap = document.querySelector(".globe-wrap");
    const from = wrap.getBoundingClientRect();
    $("intro").hidden = false;
    $("intro").classList.add("travel");
    document.body.classList.add("travelling");
    setAppInert(true);
    wrap.style.transition = "none";
    Object.assign(wrap.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
    void wrap.offsetWidth; // apply the start geometry before the transition
    wrap.style.transition = animate ? "left .45s ease-in-out, top .45s ease-in-out, width .45s ease-in-out, height .45s ease-in-out, border-radius .45s" : "none";
    Object.assign(wrap.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    // keep the globe canvas matched to its box while the box moves (same map object, same WebGL context)
    const t0 = performance.now();
    const f = () => { globe.resize(); if (performance.now() - t0 < 520) requestAnimationFrame(f); };
    requestAnimationFrame(f);
    stageOn = true;
  }
  // Keeps the globe box on the analysis map's rectangle (the header can change height when the new event's title loads)
  function followMapRect(animate) {
    const wrap = document.querySelector(".globe-wrap"), r = api.leaflet.rect();
    const cur = wrap.getBoundingClientRect();
    if (Math.abs(cur.left - r.left) + Math.abs(cur.top - r.top) + Math.abs(cur.width - r.width) + Math.abs(cur.height - r.height) < 1) return;
    wrap.style.transition = animate ? "left .35s ease-in-out, top .35s ease-in-out, width .35s ease-in-out, height .35s ease-in-out" : "none";
    Object.assign(wrap.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    const t0 = performance.now();
    const f = () => { globe.resize(); if (performance.now() - t0 < 400) requestAnimationFrame(f); };
    animate ? requestAnimationFrame(f) : globe.resize();
  }
  function clearStage() {
    const wrap = document.querySelector(".globe-wrap");
    wrap.style.cssText = "";
    $("intro").classList.remove("travel");
    document.body.classList.remove("travelling");
    $("travel-bar").hidden = true;
    stageOn = false;
  }
  // Leaves the transition: analysis visible and usable, focus on the story panel
  function finishToAnalysis() {
    travelling = false;
    clearStage();
    $("intro").hidden = true;
    for (const n of SCREENS) $(n).hidden = true; // v75
    document.body.classList.remove("story-open");
    setAppInert(false);
    if (globe) requestAnimationFrame(() => globe.resize());
    setCardsBusy(null);
    document.body.classList.remove("preview-open");
    // v58: the event screen starts at the top, with focus on its title (place name first, then the map description, then the map)
    window.scrollTo(0, 0);
    $("title").focus({ preventScroll: true });
  }
  const fadeStage = async (to) => {
    const wrap = document.querySelector(".globe-wrap");
    wrap.style.transition = `opacity ${FADE_MS}ms ease-in-out`;
    wrap.style.opacity = String(to);
    await waitTransition(FADE_MS);
  };

  // Direct open (reduced motion, no globe, hidden tab, or any error): short fade only
  async function quickOpen(id, tok) {
    const it = itemOf(id);
    if (!$("intro").hidden && !stageOn) { // from the start screen: label, then a short fade
      $("intro").classList.add("fading");
    }
    if (it) { $("travel-bar").hidden = !stageOn; setLabel(t("Opening {place}…", { place: placeName(it) }), false); }
    await api.openEvent(id); // moves the map without animation when motion is reduced
    if (tok !== travelToken) return;
    await sleep(reducedMotion.matches ? 150 : 0);
    if (tok !== travelToken) return;
    $("intro").classList.remove("fading");
    finishToAnalysis();
  }

  // Skip: stop the animation and show the result as soon as the data is there
  async function skip() {
    const id = travelTarget;
    const tok = ++travelToken;
    if (globe) globe.stop();
    api.leaflet.stop();
    setLabel(t("Opening {place}…", { place: placeName(itemOf(id)) }), false);
    try {
      await (loading || api.openEvent(id, { move: false }));
      if (api.currentEvent() !== id) await api.openEvent(id, { move: false });
    } catch (e) { /* the analysis reports its own load errors */ }
    if (tok !== travelToken) return;
    api.leaflet.fitArea(false);
    finishToAnalysis();
  }

  async function travel(id) {
    const it = itemOf(id);
    if (!it) return api.openEvent(id);
    const tok = ++travelToken;
    travelTarget = id;
    travelling = true; // cleared by finishToAnalysis (every completed path) or show()
    const fromGlobe = !$("intro").hidden && !stageOn;   // start screen visible
    const midFlight = stageOn;                            // a transition is already showing the globe
    if (globe) globe.stop();
    api.leaflet.stop();
    // back to the event that is already open (choice changed before the globe appeared): just return to its study area
    if (!fromGlobe && !midFlight && api.currentEvent() === id) {
      $("travel-bar").hidden = true;
      api.leaflet.fitArea(!(reducedMotion.matches || document.hidden), 0.8);
      return;
    }
    try {
      // No flight: reduced motion, hidden tab, or no usable globe (an analysis → analysis switch without a globe is direct)
      if (reducedMotion.matches || document.hidden) return quickOpen(id, tok);
      window.nfeTravelLog = [];
      // Globe still loading (e.g. "Explore event" right after the page opened): wait briefly, else open directly.
      // No WebGL / library failed: globeState "failed" → direct open.
      if (!(await waitForGlobe(tok, it))) {
        if (tok !== travelToken) return;
        return quickOpen(id, tok);
      }
      if (tok !== travelToken) return;
      $("travel-bar").hidden = false;
      setLabel(t("Travelling to {place}…", { place: placeName(it) }));
      logPhase(tok, fromGlobe ? "start:globe" : midFlight ? "start:mid-flight" : "start:analysis");
      const rect = () => api.leaflet.rect();
      window.scrollTo(0, 0);

      if (fromGlobe || midFlight) {
        if (fromGlobe) placeStage(rect(), true);
        loading = api.openEvent(id, { move: false }); // loads behind the globe; clears the old event's layers
      } else {
        // 1) zoom out of the current study area (Leaflet), keeping the old layers on screen
        const m = api.leaflet.map;
        const c0 = m.getCenter();
        if (m.getZoom() > OUT_Z + 0.2) {
          m.flyTo(c0, OUT_Z, { duration: 1.0, easeLinearity: 0.2 });
          await waitMoveEnd(m, 2500);
          if (tok !== travelToken) return;
        }
        logPhase(tok, "leaflet-out-done");
        // 2) the globe appears at the same view and fades in over the analysis map
        placeStage(rect(), false);
        const wrap = document.querySelector(".globe-wrap");
        wrap.style.opacity = "0";
        globe.resize();
        const cl = m.getCenter();
        globeZoomForLeaflet(m.getZoom(), { lng: cl.lng, lat: cl.lat });
        await Promise.race([new Promise((r) => globe.once("idle", r)), sleep(600)]); // tiles at the old place; do not wait long
        if (tok !== travelToken) return;
        await fadeStage(1);
        if (tok !== travelToken) return;
        logPhase(tok, "globe-visible");
        loading = api.openEvent(id, { move: false }); // the old event's layers are cleared behind the globe
      }

      // 3) the globe flies to the target (from the analysis: an arc that rises to a whole-globe view)
      const dur = fromGlobe ? 1700 : 2400;
      const gc0 = globe.getCenter();
      const atHandoff = Math.abs(globe.getZoom() - HANDOFF_Z) < 0.01 &&
        Math.abs(gc0.lng - it.center[0]) < 1e-5 && Math.abs(gc0.lat - it.center[1]) < 1e-5;
      if (!atHandoff) globe.flyTo({ center: it.center, zoom: HANDOFF_Z, duration: dur, easing: easeInOut, essential: true,
        ...(fromGlobe ? {} : { minZoom: 1.8 }) });
      // pre-position Leaflet at the expected hand-off view so its tiles load during the flight
      loading.then(() => {
        if (tok !== travelToken) return;
        api.leaflet.map.invalidateSize();
        followMapRect(true);
        leafletSetExact({ lng: it.center[0], lat: it.center[1] }, HANDOFF_Z + 1);
      });
      // Already at the hand-off view (no flight started, or it ended at once): no moveend will come, so do not wait for one
      if (globe.isMoving()) await waitMoveEnd(globe, dur + 2500);
      if (tok !== travelToken) return;
      logPhase(tok, globe.isMoving() ? "globe-arrived-timeout" : "globe-arrived");
      // 4) data not ready yet: stay here and say so
      let ready = false;
      loading.then(() => { ready = true; });
      await sleep(0);
      if (!ready) setLabel(t("Loading {place}…", { place: placeName(it) }));
      await loading;
      if (tok !== travelToken) return;
      if (api.currentEvent() !== id) return quickOpen(id, tok);
      // 5) match Leaflet to the globe's view (centre, scale) and wait briefly for its background tiles
      api.leaflet.map.invalidateSize();
      followMapRect(false);
      const gc = globe.getCenter();
      leafletSetExact(gc, leafletZoomFor(globePxPerDegLat(), gc.lat));
      const tilesOk = await api.leaflet.satTilesLoaded();
      if (tok !== travelToken) return;
      logPhase(tok, tilesOk ? "leaflet-ready" : "leaflet-tiles-timeout");
      { // hand-off check (testing): Leaflet vs globe scale and centre at the moment of the cross-fade
        const m = api.leaflet.map, lc = m.getCenter();
        const p1 = m.latLngToContainerPoint([lc.lat - 0.02, lc.lng]), p2 = m.latLngToContainerPoint([lc.lat + 0.02, lc.lng]);
        const sizeL = m.getSize(), cg = globe.project([lc.lng, lc.lat]);
        window.nfeTravelLog.push({ name: "handoff-check", scaleRatio: +((Math.hypot(p1.x - p2.x, p1.y - p2.y) / 0.04) / globePxPerDegLat()).toFixed(4),
          centreOffsetPx: +Math.hypot(cg.x - sizeL.x / 2, cg.y - sizeL.y / 2).toFixed(2),
          boxDiffPx: Math.round(Math.abs(globe.getContainer().clientWidth - sizeL.x) + Math.abs(globe.getContainer().clientHeight - sizeL.y)) });
      }
      // Leaflet fades newly placed tiles in (~200 ms). Wait until they are fully shown, otherwise the globe fades out over
      // half-transparent tiles and the empty map background shows through in the middle of the cross-fade.
      await tilesShown(api.leaflet.map, 400);
      if (tok !== travelToken) return;
      // 6) cross-fade while both cameras stand still at the same centre and scale; only when the globe has fully faded out
      //    does the last Leaflet zoom into the study area start
      await fadeStage(0);
      if (tok !== travelToken) return;
      logPhase(tok, "handoff-done");
      finishToAnalysis();
      logPhase(tok, "leaflet-zoom-start");
      api.leaflet.fitArea(true, 0.9);
      await waitMoveEnd(api.leaflet.map, 2500);
      logPhase(tok, "arrived");
    } catch (err) {
      // the transition failed: open the event directly; the list and the analysis stay usable
      if (window.console) console.warn("Transition failed, opening directly:", err);
      if (tok !== travelToken) return;
      try { finishToAnalysis(); await api.openEvent(id); } catch (e) { /* analysis shows its own error */ }
    }
  }

  // Short date on the card: month and year of the last observation, in the chosen language ("July 2026", "Temmuz 2026" …)
  let globeHint = () => {}, globeAria = () => {};
  const cap = (x) => x.charAt(0).toLocaleUpperCase(I.lang) + x.slice(1); // "juillet 2026" → "Juillet 2026" at the start of a line
  // v69: type filter above the list: it updates the list and the globe markers together
  function renderFilter() {
    const box = $("intro-filter");
    if (!box) return;
    const types = Object.keys(HAZ).filter((k) => items.some((it) => hazardOf(it) === k)); // v73: one button per type in the list
    box.hidden = types.length < 2;
    const btn = (key, label) => `<button type="button" class="if-btn" data-hz="${key}" aria-pressed="${hazardFilter === key}">${key === "all" ? "" : emblem(key, "if-emblem")}<span>${esc(label)}</span></button>`;
    const names = { flood: t("Floods"), wildfire: t("Wildfires"), earthquake: t("Earthquakes") };
    box.className = `intro-filter if-n${types.length + 1}`;
    box.innerHTML = btn("all", t("All")) + types.map((k) => btn(k, names[k])).join("");
    box.setAttribute("aria-label", t("Event type"));
    box.querySelectorAll(".if-btn").forEach((b) => b.addEventListener("click", () => setHazardFilter(b.dataset.hz)));
  }
  function setHazardFilter(key) {
    hazardFilter = key;
    if (selected && !shownByFilter(items.find((x) => x.id === selected))) { selected = null; syncPressed(); }
    for (const it of items) if (markers[it.id]) markers[it.id].getElement().classList.toggle("filtered", !shownByFilter(it));
    renderFilter();
    renderList();
    if (globe && globeState === "ready") {
      globe.triggerRepaint(); // markers re-check "covered" (hidden, not focusable) on the next frame
      // all the events of the chosen type on the far side of the globe: turn it to the first of them (same zoom)
      const shown = items.filter(shownByFilter), occl = (it) => globe.transform && globe.transform.isLocationOccluded && globe.transform.isLocationOccluded(new window.maplibregl.LngLat(it.center[0], it.center[1]));
      if (!selected && shown.length && shown.every(occl)) {
        const to = { center: shown[0].center };
        reducedMotion.matches || document.hidden ? globe.jumpTo(to) : globe.easeTo({ ...to, duration: 1200, essential: false });
      }
    }
    const b = $("intro-filter").querySelector(`[data-hz="${key}"]`);
    if (b) b.focus({ preventScroll: true });
  }
  function renderList() {
    const list = $("intro-list");
    list.innerHTML = "";
    for (const it of items.filter(shownByFilter)) {
      const li = document.createElement("li");
      // v57 card: place, dates, product label; choosing it opens the preview (the map opens from the preview's button)
      const cd = cardOf(it);
      if (cd) { // v76: one card = what happened (picture, short title), where and when, one sentence, and the button that opens the map
        li.className = "ie";
        li.innerHTML = `<button type="button" class="intro-item ie-pick" data-id="${esc(it.id)}" aria-pressed="${it.id === selected}" aria-controls="intro-card">` +
          `<span class="ie-media"><img src="data/${esc(cd.image.file)}" width="${cd.image.width}" height="${cd.image.height}" alt="${esc(cd.image.alt)}" loading="lazy" decoding="async">` +
          `<span class="ie-cap">${esc(cd.image.caption)}</span></span>` +
          `<span class="ie-body">${emblem(hazardOf(it), "ii-emblem")}<span class="ie-title">${esc(cd.title)}</span>` +
          `<span class="ie-place">${esc(cd.place)} · ${esc(it.eventDate ? I.fmt.day(it.eventDate) : it.text.event.dates)}</span>` +
          `<span class="ie-sent">${esc(cd.sentence)}</span></span></button>` +
          `<span class="ie-foot"><button type="button" class="btn btn-primary ie-open" data-id="${esc(it.id)}">${esc(opening === it.id ? t("Opening…") : t("Open map"))}</button>` +
          `<span class="ie-credit">${esc(cd.image.credit)}</span></span>`;
        li.querySelector(".ie-open").addEventListener("click", () => openCard(it.id));
      } else {
        li.innerHTML = `<button type="button" class="intro-item" data-id="${esc(it.id)}" aria-pressed="${it.id === selected}" aria-controls="intro-card">` +
          emblem(hazardOf(it), "ii-emblem") + `<span class="ii-place">${esc(it.text.event.place)}</span><span class="ii-dates">${esc(it.text.event.dates)}</span></button>`; // v64: no product label; v69: type emblem
      }
      li.querySelector(".intro-item").addEventListener("click", () => select(it.id));
      list.appendChild(li);
    }
    renderPreview();
  }
  async function init(a) {
    api = a;
    try { const r = await fetch("data/cards.json"); cards = r.ok ? (await r.json()).cards || {} : {}; } catch (err) { cards = {}; } // optional: without it the short list
    items = (await Promise.all(api.events.map(async (entry) => {
      if (!api.texts[entry.id]) return null;
      try {
        const lay = await api.getLayers(entry.id);
        const [[s, w], [n, e]] = lay.bounds_latlon; // registered study area
        // text: the event text in the current language (read again after every language change)
        return { id: entry.id, entry, hazard: entry.hazard, get text() { return api.text(entry.id); }, lastDate: (lay.dates || []).length ? lay.dates[lay.dates.length - 1].label : lay.event_date, eventDate: lay.event_date || null, center: [(w + e) / 2, (s + n) / 2] };
      } catch (err) { return null; }
    }))).filter(Boolean);
    renderFilter();
    renderList();
    I.onChange(() => {
      renderFilter();
      if (failReason) $("globe-fallback").textContent = t("The 3D globe is not available here ({reason}). Use the list to choose an event.", { reason: t(failReason) });
      renderList(); globeHint(); globeAria(); if (!$("intro").hidden) document.title = t("Surface Explorer — NISAR flood observations"); });
    $("to-globe").addEventListener("click", show);
    $("travel-skip").addEventListener("click", skip);
    // v75: start menu and stories
    $("to-home").addEventListener("click", () => showHome(true));
    $("home-choices").addEventListener("click", (e) => { const b = e.target.closest(".home-choice"); if (!b) return; if (b.dataset.go === "map") goMap(); else showStories(true); });
    I.onChange(() => {
      if (!$("home").hidden) renderHome();
      if (!$("stories").hidden) showStories(false);
      if (!$("story").hidden && story) { // the open picture, and an open shaking panel with its place and building, stay
        const k = slide, reopen = sh.open, refire = fi.open, run = fi.running, reriver = rg.open, reflow = pf.open; // v81: an open fire panel keeps its map, wind and run
        openStory(story.id, false, refire || reriver || reflow).then(() => { slide = k; drawSlide(true); if (reopen) openShaking(true); if (refire) { openFire(true); if (run) { fiRun(); fiButtons(); } } if (reriver) openRiver(true); if (reflow) openFlow(true); });
      }
    });
    loadStories(); // readiness of the stories is known before the list opens
  }
  // ---------------------------------------------------------------------------------------------------------------
  // v75: start menu and "How do disasters happen?" stories.
  // Screens (address): start menu (no hash or #home) · globe and event list (#map) · story list (#stories) · one story (#story=<id>).
  // #event=<id> links open the event as before (app.js). Story content: web/data/stories.json — one record per story with its
  // pictures, the five-language captions and the event its last picture leads to. A story opens only when it is "ready" (six
  // pictures, each with a caption); others are listed as "in preparation". Local test: ?stories=preview opens drafts with
  // drawn placeholder frames (no image files are used for them).
  const PREVIEW = new URLSearchParams(location.search).get("stories") === "preview";
  const STORY_N = 6;
  const SCREENS = ["home", "stories", "story"];
  // story pictures use the event emblems; the ice-and-rock flood has its own (a mountain with an ice cap)
  const STORY_ICON = { icerock: '<path d="M2.5 19.5 9 8.5l3.2 5 2.3-3 7 9z"/><path d="m7.4 11.2 1.6 1.3 1.4-1.6"/>' };
  const storyEmblem = (hz) => (HAZ[hz] ? emblem(hz, "st-emblem")
    : `<span class="hz hz-${esc(hz)} st-emblem" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false">${STORY_ICON[hz] || HAZ.flood.svg}</svg></span>`);
  let storiesP = null, storyData = { stories: [] };
  let story = null, slide = 0;
  const loc = (o) => (o && typeof o === "object" ? o[I.lang] || o.en || "" : o || "");
  const storyReady = (s) => !!(s && s.status === "ready" && Array.isArray(s.slides) && s.slides.length === STORY_N &&
    s.slides.every((x) => x && x.image && x.caption && x.caption.en));
  const storyOpenable = (s) => storyReady(s) || !!(PREVIEW && s && Array.isArray(s.slides) && s.slides.length);
  const storyById = (id) => (storyData.stories || []).find((s) => s.id === id);
  const eventExists = (id) => !!(id && api && api.events.some((e) => e.id === id));
  function loadStories() {
    if (!storiesP) storiesP = fetch("data/stories.json?v=75", { cache: "no-store" }).then((r) => (r.ok ? r.json() : { stories: [] }))
      .catch(() => ({ stories: [] })).then((d) => { storyData = d && Array.isArray(d.stories) ? d : { stories: [] }; return storyData; });
    return storiesP;
  }
  // one screen at a time over the (inert) analysis app
  function showScreen(name) {
    shStop(); fiStop(); rgStop(); pfStop(); // v80/v81/v84/v86: no shaking, fire, flood or flow game keeps running behind another screen
    for (const n of SCREENS) $(n).hidden = n !== name;
    if (name !== "intro") { travelToken++; travelling = false; if (stageOn) clearStage(); $("intro").hidden = true; }
    setAppInert(true);
    document.body.classList.toggle("story-open", name === "story");
    window.scrollTo(0, 0);
  }
  function renderHome() {
    const n = api ? api.events.length : 0;
    $("home-choices").innerHTML =
      `<button type="button" class="home-choice hc-stories" data-go="stories"><span class="hc-icons" aria-hidden="true">` +
        ["earthquake", "flood", "icerock", "wildfire"].map(storyEmblem).join("") + `</span>` +
        `<span class="hc-title">${esc(t("How do disasters happen?"))}</span><span class="hc-sub">${esc(t("Short illustrated stories, one picture at a time."))}</span></button>` +
      `<div class="hc-map-wrap"><button type="button" class="home-choice hc-map" data-go="map">` +
        `<span class="hc-title">${esc(t("Explore on the map"))}</span><span class="hc-sub">${esc(t("Real satellite observations of {n} events.", { n }))}</span></button>` +
        `<div class="hc-globe" role="group" aria-label="${esc(t("Globe with event locations"))}"><canvas class="hg-canvas" aria-hidden="true"></canvas><div class="hg-marks"></div></div>` +
        `<span class="hg-credit" lang="en">NASA Blue Marble · GIBS</span></div>`;
    hgMount();
  }
  // ---------------------------------------------------------------------------------------------------------------
  // v91: the globe on the "Explore on the map" card is the real Earth: NASA Blue Marble Shaded Relief and Bathymetry
  // (the same NASA GIBS layer as the big globe), one whole-world image wrapped on a small sphere drawn pixel by pixel.
  // It turns slowly (not with reduced motion) and can be turned by dragging; a tap on it opens the globe screen. The event
  // markers sit on the sphere and open their own map. Until the image arrives (or if it cannot be loaded) the blue sphere stays.
  const HG_TEX = "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0" +
    "&LAYERS=BlueMarble_ShadedRelief_Bathymetry&STYLES=&CRS=EPSG:4326&BBOX=-90,-180,90,180&WIDTH=1024&HEIGHT=512&FORMAT=image/jpeg";
  const HG_TILT = 18 * Math.PI / 180; // seen a little from above the equator
  const hg = { tex: null, texP: null, lon0: 20, raf: 0, last: 0, drag: null, grid: null, n: 0, img: null };
  function hgLoad() {
    if (!hg.texP) hg.texP = fetch(HG_TEX, { mode: "cors" }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(r.status))))
      .then((b) => createImageBitmap(b)).then((bm) => {
        const c = document.createElement("canvas"); c.width = bm.width; c.height = bm.height;
        const x = c.getContext("2d"); x.drawImage(bm, 0, 0);
        hg.tex = { d: x.getImageData(0, 0, c.width, c.height).data, w: c.width, h: c.height };
        return hg.tex;
      }).catch(() => null);
    return hg.texP;
  }
  function hgGrid(n) { // per pixel: texture row, longitude offset (degrees) and light; only the sphere's own pixels
    const idx = [], row = [], lon = [], lit = [], ct = Math.cos(HG_TILT), st = Math.sin(HG_TILT);
    for (let py = 0; py < n; py++) for (let px = 0; px < n; px++) {
      const u = ((px + 0.5) / n) * 2 - 1, v = ((py + 0.5) / n) * 2 - 1, r2 = u * u + v * v; if (r2 > 1) continue;
      const z = Math.sqrt(1 - r2), w = -v, y = w * ct + z * st, Z = -w * st + z * ct;
      idx.push(py * n + px); row.push(Math.max(0, Math.min(511, Math.round(((90 - Math.asin(y) * 57.2958) / 180) * 511)))); // texture row (the image is 1024 × 512)
      lon.push(Math.atan2(u, Z) * 57.2958);
      const sun = 0.62 + 0.38 * Math.max(0, -0.45 * u + 0.35 * w + 0.82 * z), edge = Math.min(1, 0.35 + 1.4 * z); lit.push(sun * edge);
    }
    return { idx: Int32Array.from(idx), row: Int16Array.from(row), lon: Float32Array.from(lon), lit: Float32Array.from(lit) };
  }
  function hgProject(lon, lat) { // a place on the sphere → [x, y] in -1..1, and whether it faces us
    const a = (lon - hg.lon0) * Math.PI / 180, f = lat * Math.PI / 180, x = Math.cos(f) * Math.sin(a), y = Math.sin(f), Z = Math.cos(f) * Math.cos(a);
    const ct = Math.cos(HG_TILT), st = Math.sin(HG_TILT), w = y * ct - Z * st, z = y * st + Z * ct;
    return [x, -w, z];
  }
  function hgDraw() {
    const box = $("home-choices") && $("home-choices").querySelector(".hc-globe"); if (!box) return;
    const cv = box.querySelector(".hg-canvas"), size = box.clientWidth; if (!size) return;
    if (hg.tex) {
      const n = Math.min(420, Math.round(size * Math.min(2, window.devicePixelRatio || 1)));
      if (cv.width !== n) { cv.width = n; cv.height = n; hg.grid = null; }
      if (!hg.grid || hg.n !== n) { hg.grid = hgGrid(n); hg.n = n; hg.img = cv.getContext("2d").createImageData(n, n); }
      const G = hg.grid, T = hg.tex, d = hg.img.data, sh = hg.lon0 + 180;
      for (let k = 0; k < G.idx.length; k++) {
        let c = Math.floor(((G.lon[k] + sh) / 360) * T.w) % T.w; if (c < 0) c += T.w;
        const ti = (G.row[k] * T.w + c) * 4, o = G.idx[k] * 4, l = G.lit[k];
        d[o] = T.d[ti] * l; d[o + 1] = T.d[ti + 1] * l; d[o + 2] = T.d[ti + 2] * l; d[o + 3] = 255;
      }
      cv.getContext("2d").putImageData(hg.img, 0, 0);
      box.classList.add("earth");
    }
    // markers on the side that faces us (hidden and skipped by Tab on the far side); places close together (Nepal and
    // Bangladesh) are pushed apart a little on screen so each marker can be tapped on its own
    const R = size / 2, gap = 22, P = [...box.querySelectorAll(".hg-mk")].map((m) => { const [x, y, z] = hgProject(+m.dataset.lon, +m.dataset.lat); return { m, x: R + x * R, y: R + y * R, on: z > 0.12 }; });
    for (let it = 0; it < 3; it++) for (let a = 0; a < P.length; a++) for (let b = a + 1; b < P.length; b++) {
      const A = P[a], B = P[b]; if (!A.on || !B.on) continue;
      let dx = B.x - A.x, dy = B.y - A.y, d = Math.hypot(dx, dy); if (d >= gap) continue;
      if (d < 0.01) { dx = 1; dy = 0; d = 1; } const k = (gap - d) / 2 / d; A.x -= dx * k; A.y -= dy * k; B.x += dx * k; B.y += dy * k;
    }
    for (const { m, x, y, on } of P) {
      m.style.left = `${x}px`; m.style.top = `${y}px`;
      if (m.classList.contains("off") === on) { m.classList.toggle("off", !on); m.tabIndex = on ? 0 : -1; }
    }
  }
  function hgLoop(now) {
    hg.raf = 0;
    if ($("home").hidden) return; // only while the start menu is shown
    const dt = hg.last ? Math.min(0.1, (now - hg.last) / 1000) : 0; hg.last = now;
    if (!hg.drag && !reducedMotion.matches) hg.lon0 = (hg.lon0 + dt * 7) % 360; // a slow turn, west to east
    hgDraw();
    hg.raf = requestAnimationFrame(hgLoop);
  }
  function hgMount() {
    const box = $("home-choices").querySelector(".hc-globe"); if (!box) return;
    const marks = box.querySelector(".hg-marks");
    marks.innerHTML = items.map((it) => `<button type="button" class="hg-mk off" tabindex="-1" data-id="${esc(it.id)}" data-lon="${it.center[0]}" data-lat="${it.center[1]}"` +
      ` aria-label="${esc(t("{place}: open this event", { place: it.text.event.place }))}">${emblem(hazardOf(it), "hg-emblem")}</button>`).join("");
    marks.addEventListener("click", (e) => { const b = e.target.closest(".hg-mk"); if (!b) return; e.stopPropagation(); goMap(); openCard(b.dataset.id); });
    const cv = box.querySelector(".hg-canvas");
    cv.addEventListener("pointerdown", (e) => { hg.drag = { x: e.clientX, y: e.clientY, lon: hg.lon0, moved: false }; try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
    cv.addEventListener("pointermove", (e) => { const D = hg.drag; if (!D) return; const dx = e.clientX - D.x; if (Math.abs(dx) + Math.abs(e.clientY - D.y) > 6) D.moved = true;
      hg.lon0 = D.lon - (dx / Math.max(40, box.clientWidth)) * 180; if (reducedMotion.matches) hgDraw(); });
    const up = (e, cancel) => { const D = hg.drag; hg.drag = null; if (D && !D.moved && !cancel) goMap(); }; // a tap opens the globe screen
    cv.addEventListener("pointerup", (e) => up(e, false));
    cv.addEventListener("pointercancel", (e) => up(e, true));
    hgLoad().then(() => { hgDraw(); });
    hgDraw();
    if (!hg.raf) { hg.last = 0; hg.raf = requestAnimationFrame(hgLoop); }
  }
  function showHome(push) {
    if (push) history.pushState(null, "", location.pathname + location.search);
    else if (location.hash && location.hash !== "#home") history.replaceState(null, "", location.pathname + location.search);
    showScreen("home");
    renderHome();
    document.title = t("Surface Explorer — NISAR flood observations");
    $("home-h").focus({ preventScroll: true });
  }
  function goMap() { history.pushState(null, "", "#map"); show(); }
  async function showStories(push) {
    if (push) history.pushState(null, "", "#stories");
    showScreen("stories");
    const box = $("stories");
    box.innerHTML = `<div class="sl-wrap"><div class="sl-top"><button type="button" class="btn btn-small sl-home">${esc(t("← Start"))}</button><div class="lang-pick-slot sl-lang"></div></div>` +
      `<h1 id="stories-h" tabindex="-1">${esc(t("How do disasters happen?"))}</h1>` +
      `<p class="sl-sub">${esc(t("Illustrations of how each kind of disaster unfolds. Each story ends at a real event on the map."))}</p>` +
      `<ul class="sl-list" role="list"></ul></div>`;
    I.picker(box.querySelector(".sl-lang"));
    box.querySelector(".sl-home").addEventListener("click", () => showHome(true));
    box.querySelector("h1").focus({ preventScroll: true });
    document.title = `${t("How do disasters happen?")} — Surface Explorer`;
    await loadStories();
    if ($("stories").hidden) return;
    const list = box.querySelector(".sl-list");
    list.innerHTML = (storyData.stories || []).map((s) => {
      const ok = storyOpenable(s), draft = ok && !storyReady(s);
      return `<li><button type="button" class="sl-card" data-id="${esc(s.id)}"${ok ? "" : ` aria-disabled="true"`}>` + storyEmblem(s.hazard) +
        `<span class="sl-title">${esc(loc(s.title) || s.id)}</span>` +
        `<span class="sl-state">${esc(!ok ? t("In preparation") : draft ? t("Preview with placeholder pictures") : t("{n} pictures", { n: STORY_N }))}</span></button></li>`;
    }).join("") || `<li class="sl-none">${esc(t("The stories are in preparation."))}</li>`;
    list.querySelectorAll(".sl-card").forEach((b) => b.addEventListener("click", () => { if (b.getAttribute("aria-disabled") !== "true") openStory(b.dataset.id, true); }));
  }
  async function openStory(id, push, keepFire) {
    await loadStories();
    const s = storyById(id);
    if (!storyOpenable(s)) { showStories(false); history.replaceState(null, "", "#stories"); return; } // never an empty or broken story screen
    if (push) history.pushState(null, "", `#story=${encodeURIComponent(id)}`);
    story = s; slide = 0;
    showScreen("story");
    const box = $("story");
    // v77: the language button is in the story too (the open picture stays when the language changes); "1 / 6" sits between the buttons
    box.innerHTML = `<div class="sv-top"><button type="button" class="btn btn-small sv-back">${esc(t("← Stories"))}</button>` +
      `<h1 id="story-h" class="sv-title" tabindex="-1">${esc(loc(s.title) || s.id)}</h1><div class="lang-pick-slot sv-lang"></div></div>` +
      `<figure class="sv-fig"><div class="sv-frame"><span class="sv-badge">${esc(t("Illustration"))}</span>` +
        (storyReady(s) ? "" : `<span class="sv-draft">${esc(t("Preview"))}</span>`) + `</div>` +
      `<figcaption class="sv-cap"></figcaption></figure>` +
      `<div class="sv-try-row" hidden><button type="button" class="btn btn-small sv-try">${esc(fireStory(s) ? t("Try how the fire spreads") : riverStory(s) ? t("Protect the village from the flood") : flowStory(s) ? t("Protect the village from the snow flow") : t("Try the shaking"))}</button></div>` + // v80, v81, v84
      `<div class="sv-nav"><button type="button" class="btn sv-prev">${esc(t("← Previous"))}</button><span class="sv-prog" aria-live="polite"></span>` +
      `<button type="button" class="btn btn-primary sv-next"></button></div>` +
      `<section class="sh-panel" aria-labelledby="sh-h" hidden></section>`;
    shStop(); sh.open = false; if (sh.map) { sh.map.remove(); sh.map = null; } // v80: a new story view starts without the shaking panel
    fiStop(); fi.open = false; if (!keepFire) fi.state = null; // v81: nor the fire panel (a language change keeps its map)
    rgStop(); rg.open = false; rg.pointers.clear(); rg.gest = null; rg.pinch = null; rg.pan = null; if (!keepFire) rg.g = null; // v84: nor the flood game
    pfStop(); pf.open = false; if (!keepFire) { pf.g = null; } // v86: nor the flow game (a language change keeps its round)
    box.classList.remove("sh-on");
    box.querySelector(".sv-try").addEventListener("click", () => (fireStory(s) ? openFire(false) : riverStory(s) ? openRiver(false) : flowStory(s) ? openFlow(false) : openShaking(false)));
    I.picker(box.querySelector(".sv-lang"));
    box.querySelector(".sv-back").addEventListener("click", () => showStories(true));
    box.querySelector(".sv-prev").addEventListener("click", () => goSlide(slide - 1));
    box.querySelector(".sv-next").addEventListener("click", () => (slide < s.slides.length - 1 ? goSlide(slide + 1) : storyEnd()));
    // swipe on the picture (touch): left = next, right = previous
    const fr = box.querySelector(".sv-frame");
    let x0 = null;
    fr.addEventListener("pointerdown", (e) => { x0 = e.clientX; });
    fr.addEventListener("pointerup", (e) => { if (x0 == null) return; const dx = e.clientX - x0; x0 = null; if (Math.abs(dx) > 40) goSlide(slide + (dx < 0 ? 1 : -1)); });
    document.title = `${loc(s.title)} — ${t("How do disasters happen?")}`;
    drawSlide(true);
    box.querySelector(".sv-title").focus({ preventScroll: true });
  }
  // the last picture leads to the story's real event (or back to the list when the event is not on the map)
  function storyEnd() {
    shStop(); fiStop(); rgStop(); rg.open = false; pfStop(); pf.open = false; // v81/v84/v86: leaving for the map stops a running animation or game at once
    if (story && eventExists(story.event_id)) { const id = story.event_id; show(); history.replaceState(null, "", "#map"); openCard(id); }
    else showStories(true);
  }
  function goSlide(i) {
    if (!story || i < 0 || i >= story.slides.length || i === slide) return;
    slide = i;
    drawSlide(false);
  }
  // one picture (or its drawn placeholder) with a short cross-fade; the caption fades with it
  function drawSlide(first) {
    const box = $("story"), s = story, x = s.slides[slide], n = s.slides.length;
    const frame = box.querySelector(".sv-frame"), cap = box.querySelector(".sv-cap");
    const layer = document.createElement("div");
    layer.className = "sv-layer";
    if (x.image) {
      const im = new Image();
      im.className = "sv-img"; im.alt = loc(x.alt) || loc(x.caption);
      im.src = `data/${x.image}`;
      im.addEventListener("error", () => { layer.innerHTML = placeholder(s, slide, n); }, { once: true });
      layer.appendChild(im);
    } else layer.innerHTML = placeholder(s, slide, n);
    const old = [...frame.querySelectorAll(".sv-layer")];
    frame.insertBefore(layer, frame.firstChild);
    const quick = first || reducedMotion.matches;
    if (quick) old.forEach((o) => o.remove());
    else {
      const showNew = () => layer.classList.remove("fade-in"); // the timer covers a background tab, where animation frames wait
      layer.classList.add("fade-in"); requestAnimationFrame(() => requestAnimationFrame(showNew)); setTimeout(showNew, 60);
      old.forEach((o) => { o.classList.add("fade-out"); setTimeout(() => o.remove(), 420); });
    }
    if (!quick) { cap.classList.add("fade"); setTimeout(() => { cap.textContent = loc(x.caption); cap.classList.remove("fade"); }, 180); } else cap.textContent = loc(x.caption);
    box.querySelector(".sv-prog").textContent = `${slide + 1} / ${n}`;
    box.querySelector(".sv-prog").setAttribute("aria-label", t("Picture {i} of {n}", { i: slide + 1, n }));
    const prev = box.querySelector(".sv-prev"), next = box.querySelector(".sv-next");
    prev.disabled = slide === 0;
    const last = slide === n - 1;
    next.textContent = !last ? t("Next →") : eventExists(s.event_id) ? t("Explore on the map") : t("Back to the stories");
    next.classList.toggle("sv-to-map", last);
    // v80: "Try the shaking" (small) on the last picture when the story's event has shaking data; "Explore on the map" stays the main button
    const tryRow = box.querySelector(".sv-try-row");
    tryRow.hidden = true;
    if (last && fireStory(s)) tryRow.hidden = fi.open; // v81: the fire model needs no data file
    else if (last && riverStory(s)) tryRow.hidden = rg.open; // v84: the flood game needs no data file
    else if (last && flowStory(s)) tryRow.hidden = pf.open; // v86: the flow game needs no data file
    else if (last) loadShaking(s.event_id).then((d) => { if (story === s && slide === n - 1 && !sh.open) tryRow.hidden = !d; });
    // the next picture is fetched ahead, so the step is immediate
    const nx = s.slides[slide + 1];
    if (nx && nx.image) { const pre = new Image(); pre.src = `data/${nx.image}`; }
  }
  function placeholder(s, i, n) {
    return `<div class="sv-ph sv-ph-${esc(s.hazard)}" role="img" aria-label="${esc(t("Placeholder: picture {i} of {n} is not ready yet.", { i: i + 1, n }))}">` +
      storyEmblem(s.hazard) + `<span>${esc(t("Placeholder picture {i} / {n}", { i: i + 1, n }))}</span></div>`;
  }
  document.addEventListener("keydown", (e) => {
    if ($("story").hidden || !story || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest && e.target.closest(".lang-pick")) return;
    if (sh.open || fi.open || rg.open || pf.open) { if (e.key === "Escape") { e.preventDefault(); closeShaking(); } return; } // v80/v81/v84: the panel has its own controls
    if (e.key === "ArrowRight") { e.preventDefault(); slide < story.slides.length - 1 ? goSlide(slide + 1) : null; }
    else if (e.key === "ArrowLeft") { e.preventDefault(); goSlide(slide - 1); }
    else if (e.key === "Home") { e.preventDefault(); goSlide(0); }
    else if (e.key === "End") { e.preventDefault(); goSlide(story.slides.length - 1); }
    else if (e.key === "Escape") { e.preventDefault(); showStories(true); }
  });
  // the address decides the screen (first load, Back / Forward, a pasted link); #event=… is handled by app.js
  function route() {
    const h = location.hash, m = h.match(/story=([\w-]+)/);
    if (m) {
      // v84b: "&play=1" opens the story on its last picture with its game / try panel open (a direct link to the game)
      const play = /[&?]play=1\b/.test(h);
      if ($("story").hidden || !story || story.id !== m[1]) openStory(m[1], false).then(() => {
        if (!play || !story || story.id !== m[1]) return;
        slide = story.slides.length - 1; drawSlide(true);
        if (riverStory(story)) openRiver(false); else if (flowStory(story)) openFlow(false); else if (fireStory(story)) openFire(false); else openShaking(false);
      });
      return true;
    }
    if (/^#stories\b/.test(h)) { if ($("stories").hidden) showStories(false); return true; }
    if (/^#map\b/.test(h)) { if ($("intro").hidden) show(); return true; }
    if (!h || h === "#" || h === "#home") { if ($("home").hidden) showHome(false); return true; }
    return false;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // v80: "Try the shaking" — on the last picture of a story whose event has data/<event>/shaking.json (USGS ShakeMap values of a few
  // places, built by pipeline/export/build_shaking.py). Three steps on the same page: choose a place (mini map + keyboard buttons),
  // choose a building (low-rise / high-rise, more flexible / stiffer), start a short illustrative animation. The animation strength is
  // the file's ready level (1–9) only: no extra soil factor, and the building choice changes only how the drawing sways (no damage
  // share, no safe / unsafe verdict). Reduced motion: a still drawing with the sway range as dashed outlines.
  const SH_TILES = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg";
  const SH_TILE_CREDIT = 'EOxCloudless <a href="https://cloudless.eox.at">https://cloudless.eox.at</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)';
  const shakingCache = {};
  const sh = { open: false, region: null, tall: false, flexible: false, playing: 0, done: false, map: null };
  function loadShaking(ev) {
    // only an earthquake event can have shaking data: other stories ask for nothing (no failed requests)
    const e = ev && api && api.events.find((x) => x.id === ev);
    if (!e || e.hazard !== "earthquake") return Promise.resolve(null);
    if (!(ev in shakingCache)) shakingCache[ev] = fetch(`data/${ev}/shaking.json?v=80`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
      .then((d) => (d && Array.isArray(d.regions) && d.regions.length ? d : null)).catch(() => null);
    return shakingCache[ev];
  }
  // the product's own shaking words and the NEHRP site classes, in the chosen language
  const shakeWord = (w) => ({ "Not felt": t("Not felt"), Weak: t("Weak"), Light: t("Light"), Moderate: t("Moderate"),
    Strong: t("Strong"), "Very strong": t("Very strong"), Severe: t("Severe"), Violent: t("Violent"), Extreme: t("Extreme") }[w] || w);
  const siteText = (c) => ({ A: t("Hard rock"), B: t("Rock"), C: t("Very dense soil and soft rock"), D: t("Stiff soil"), E: t("Soft clay soil") }[c] || "");
  const shRegion = (d) => d.regions.find((r) => r.id === sh.region) || d.regions[0];
  function shSoil(r) {
    const s = r.soil || {};
    if (s.status !== "estimated" || s.vs30_m_s == null) return t("No soil data");
    return t("Class {c} · Vs30 about {v} m/s · {text}", { c: s.site_class || "?", v: I.fmt.num(Math.round(s.vs30_m_s / 10) * 10, 0), text: siteText(s.site_class) });
  }
  async function openShaking(restore) {
    const d = await loadShaking(story && story.event_id);
    if (!d || !story || $("story").hidden) return;
    const box = $("story"), panel = box.querySelector(".sh-panel");
    if (!restore) { sh.region = d.regions[0].id; sh.tall = false; sh.flexible = false; sh.done = false; }
    sh.open = true;
    box.classList.add("sh-on");
    for (const el of box.querySelectorAll(".sv-fig, .sv-try-row, .sv-nav")) el.hidden = true;
    const shocks = ((api && api.events.find((e) => e.id === story.event_id)) || {}).shocks || [];
    const seg = (name, opts) => `<div class="sh-seg" role="radiogroup" aria-label="${esc(name)}">` + opts.map(([v, label, on]) =>
      `<button type="button" role="radio" class="sh-opt" data-v="${v}" aria-checked="${on}">${esc(label)}</button>`).join("") + `</div>`;
    const p = d.product || {}, gap = shocks.length > 1 ? Math.round((Date.parse(shocks[1].time_utc) - Date.parse(shocks[0].time_utc)) / 1000) : null;
    const mag = (x) => `M${Number(x).toLocaleString(I.lang, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`;
    panel.innerHTML = `<div class="sh-head"><h2 id="sh-h" tabindex="-1">${esc(t("Try the shaking"))}</h2><span class="sv-badge sh-badge">${esc(t("Illustrative animation"))}</span></div>` +
      `<p class="sh-intro">${esc(t("Choose a place and a building type, then start the shaking."))}</p>` + // v91: the first action, in one line
      `<ol class="sh-steps">` +
      `<li class="sh-step"><h3>${esc(t("1. Choose a place"))}</h3><div class="sh-map" aria-hidden="true"></div>` +
        `<div class="sh-regions" role="radiogroup" aria-label="${esc(t("Places"))}">` + d.regions.map((r) =>
          `<button type="button" role="radio" class="sh-reg" data-id="${esc(r.id)}" aria-checked="${r.id === sh.region}"><b>${esc(r.name)}</b><small>${esc(t("{km} km from the epicentre", { km: I.fmt.num(r.distance_km, 0) }))}</small></button>`).join("") + `</div>` +
        `<dl class="sh-info" aria-live="polite"></dl></li>` +
      `<li class="sh-step"><h3>${esc(t("2. Choose a building"))}</h3>` +
        seg(t("Building height"), [["low", t("Low-rise"), !sh.tall], ["tall", t("High-rise"), sh.tall]]) +
        seg(t("Building frame"), [["flex", t("More flexible"), sh.flexible], ["stiff", t("Stiffer"), !sh.flexible]]) + `</li>` +
      `<li class="sh-step"><h3>${esc(t("3. Start the shaking"))}</h3>` +
        `<div class="sh-stage"><svg class="sh-svg" viewBox="0 0 320 190" role="img" aria-labelledby="sh-cap"></svg></div>` +
        `<p class="sh-cap" id="sh-cap"></p>` +
        `<button type="button" class="btn sh-play">${esc(t("Start the shaking"))}</button></li></ol>` +
      `<details class="sh-data"><summary>${esc(t("Data and sources"))}</summary>` +
        `<p>${esc(t("Estimated shaking of the {mag} earthquake in three places, from the USGS ShakeMap.", { mag: mag(d.shock.mag) }))}</p>` +
        `<p>${esc(t("USGS ShakeMap of the {mag} earthquake ({id}), version {v} of {date}, status: {status}.", { mag: mag(d.shock.mag), id: d.shock.usgs_id, v: p.version, date: I.fmt.day(String(p.process_timestamp || "").slice(0, 10)), status: p.map_status === "automatic" ? t("automatic") : (p.map_status || "") }))} ` +
          `<a href="${esc(p.page)}" target="_blank" rel="noopener">USGS ↗</a></p>` +
        `<ul class="sh-limits">` +
          `<li>${esc(t("Estimates, not recordings: {n} felt reports (“Did You Feel It?”) and {s} seismic stations, with ground-motion models.", { n: I.fmt.num(p.intensity_observations, 0), s: I.fmt.num(p.seismic_stations, 0) }))}</li>` +
          `<li>${esc(gap != null ? t("The {m1} shock came {s} seconds before the {m2}; felt reports cannot separate the two, so this map may include shaking from both.", { m1: mag(shocks[0].mag), m2: mag(shocks[1].mag), s: gap }) : (d.limits || [])[1] || "")}</li>` +
          `<li>${esc(t("The ground (Vs30) is ShakeMap's estimate for the top 30 m from the slope of the land, not a measurement at the site. No extra soil factor is applied: the values already include the ground."))}</li>` +
          `<li>${esc(t("The map status is automatic (version {v}); USGS may still revise it.", { v: p.version }))}</li>` +
          `<li>${esc(t("The buildings are illustrative: no damage share and no safe or unsafe verdict."))}</li></ul>` +
        `<ul class="sh-values">` + d.regions.map((r) => `<li><b>${esc(r.name)}</b> · ${esc(t("{km} km from the epicentre", { km: I.fmt.num(r.distance_km, 1) }))} · MMI ${esc(I.fmt.num(r.mmi, 1))} · ` +
          `PGA ${esc(I.fmt.num(r.pga_pct_g, 1))} %g · PGV ${esc(I.fmt.num(r.pgv_cm_s, 1))} cm/s</li>`).join("") + `</ul>` +
        `<p class="sh-note">${esc(t("Places: OpenStreetMap (ODbL). The radar ground-motion layers stay on the event map."))}</p></details>` +
      `<div class="sv-nav sh-nav"><button type="button" class="btn sh-back">${esc(t("← Back to the story"))}</button>` +
        `<button type="button" class="btn btn-primary sh-to-map">${esc(t("Explore on the map"))}</button></div>`;
    panel.hidden = false;
    panel.querySelectorAll(".sh-reg").forEach((b) => b.addEventListener("click", () => shPick(d, b.dataset.id)));
    panel.querySelectorAll(".sh-seg").forEach((g, k) => g.querySelectorAll(".sh-opt").forEach((b) => b.addEventListener("click", () => {
      if (k === 0) sh.tall = b.dataset.v === "tall"; else sh.flexible = b.dataset.v === "flex";
      g.querySelectorAll(".sh-opt").forEach((o) => o.setAttribute("aria-checked", String(o === b)));
      shStop(); sh.done = false; shDraw(d); // the place and its level stay; only the drawn building changes
    })));
    for (const g of panel.querySelectorAll('[role="radiogroup"]')) g.addEventListener("keydown", (e) => { // arrow keys move inside a group
      if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const o = [...g.querySelectorAll('[role="radio"]')], k = o.indexOf(document.activeElement), n2 = o[(k + (/Right|Down/.test(e.key) ? 1 : -1) + o.length) % o.length];
      n2.focus(); n2.click();
    });
    panel.querySelector(".sh-play").addEventListener("click", () => shPlay(d));
    panel.querySelector(".sh-back").addEventListener("click", closeShaking);
    panel.querySelector(".sh-to-map").addEventListener("click", storyEnd);
    shMap(d);
    shInfo(d);
    shDraw(d);
    if (!restore) panel.querySelector("#sh-h").focus({ preventScroll: false });
  }
  function closeShaking() { // closes either panel (shaking or fire) and stops its animation
    shStop(); fiStop(); rgStop(); pfStop();
    sh.open = false; fi.open = false; rg.open = false; pf.open = false;
    const box = $("story");
    box.classList.remove("sh-on");
    if (sh.map) { sh.map.remove(); sh.map = null; }
    const panel = box.querySelector(".sh-panel");
    if (panel) { panel.hidden = true; panel.innerHTML = ""; }
    for (const el of box.querySelectorAll(".sv-fig, .sv-nav")) el.hidden = false;
    drawSlide(true);
    const b = box.querySelector(".sv-try"); if (b) b.focus({ preventScroll: true });
  }
  function shPick(d, id) {
    sh.region = id; shStop(); sh.done = false;
    $("story").querySelectorAll(".sh-reg").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.id === id)));
    shMarkers(d);
    shInfo(d);
    shDraw(d);
  }
  // v91: one label for the place's estimated shaking, used the same way in the info box and under the drawing
  const shClass = (r) => `${r.mmi_class} · ${shakeWord(r.shaking)}`;
  const shMmi = (r) => `(MMI ${I.fmt.num(r.mmi, 1)})`;
  function shInfo(d) {
    const r = shRegion(d), box = $("story").querySelector(".sh-info");
    box.innerHTML = `<dt>${esc(t("Estimated shaking"))}</dt><dd><b>${esc(shClass(r))}</b> <span class="sh-mmi">${esc(shMmi(r))}</span></dd>` +
      `<dt>${esc(t("Estimated ground"))}</dt><dd>${esc(shSoil(r))}</dd>`;
  }
  // mini map: the same satellite background as the analysis map, the epicentre and the places (a tap chooses a place)
  function shMap(d) {
    const el = $("story").querySelector(".sh-map");
    if (sh.map) { sh.map.remove(); sh.map = null; }
    if (!window.L || !el) return;
    const m = L.map(el, { zoomControl: false, attributionControl: true, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, touchZoom: false, tap: false });
    L.tileLayer(SH_TILES, { maxZoom: 13, attribution: SH_TILE_CREDIT }).addTo(m);
    m.attributionControl.setPrefix(false);
    const pts = d.regions.map((r) => [r.lat, r.lon]).concat([d.map.epicentre]);
    m.fitBounds(L.latLngBounds(pts).pad(0.25), { animate: false });
    L.marker(d.map.epicentre, { interactive: false, keyboard: false, icon: L.divIcon({ className: "sh-epi", html: "<i></i>", iconSize: [0, 0] }) }).addTo(m);
    sh.map = m; sh.layer = L.layerGroup().addTo(m);
    shMarkers(d);
    requestAnimationFrame(() => m.invalidateSize());
    setTimeout(() => { if (sh.map === m) { m.invalidateSize(); m.fitBounds(L.latLngBounds(pts).pad(0.25), { animate: false }); } }, 120);
  }
  function shMarkers(d) {
    if (!sh.map) return;
    sh.layer.clearLayers();
    for (const r of d.regions) {
      const on = r.id === sh.region;
      // two places close together: the northern label above its point, the southern one below (no overlap); others to the right
      const near = d.regions.find((q) => q !== r && Math.abs(q.lat - r.lat) < 0.6 && Math.abs(q.lon - r.lon) < 0.6);
      const side = near ? (r.lat >= near.lat ? " up" : " down") : "";
      L.marker([r.lat, r.lon], { keyboard: false, icon: L.divIcon({ className: `sh-pin${on ? " on" : ""}${side}`, html: `<i></i><span>${esc(r.name)}</span>`, iconSize: [0, 0] }) })
        .on("click", () => { shPick(d, r.id); const b = $("story").querySelector(`.sh-reg[data-id="${r.id}"]`); if (b) b.focus({ preventScroll: true }); }).addTo(sh.layer);
    }
  }
  // the building drawing: low-rise 2 floors, high-rise 8; drawn from its base, so a sway is a skew around the ground line
  function shBuilding() {
    const tall = sh.tall, w = tall ? 56 : 96, h = tall ? 138 : 56, fl = tall ? 8 : 2, cols = tall ? 3 : 4;
    let win = "";
    for (let f = 0; f < fl; f++) for (let c = 0; c < cols; c++)
      win += `<rect x="${-w / 2 + 8 + c * ((w - 16) / cols)}" y="${-h + 8 + f * ((h - 12) / fl)}" width="${(w - 16) / cols - 6}" height="${(h - 12) / fl - 7}" rx="1.5" class="sh-win"/>`;
    return { w, h, svg: `<rect x="${-w / 2}" y="${-h}" width="${w}" height="${h}" rx="3" class="sh-wall"/>${win}<rect x="${-w / 2 - 4}" y="${-h - 5}" width="${w + 8}" height="6" rx="2" class="sh-roof"/>` };
  }
  // how the drawing moves for the chosen building (illustrative: a taller and more flexible frame sways more and more slowly).
  // v80c: the motion is set in drawing units with a base amount, so the lowest level still moves visibly on a phone (the old
  // degree-only sway moved a low-rise roof under 1 px), and it grows with the file's level (1–9) — the level itself is unchanged.
  //   ground: 3 + 1.25 × level   (level 5 → 9.3, level 8 → 13 units; about 1 unit = 1 px at 390 px)
  //   roof offset from the base: (4 + 1.5 × level) × building factor (low-rise 0.55 / high-rise 1 × stiffer 0.75 / more flexible 1.3)
  const shMotion = (lv, h) => {
    const f = (sh.tall ? 1 : 0.55) * (sh.flexible ? 1.3 : 0.75), top = (4 + 1.5 * lv) * f;
    return { ground: 3 + 1.25 * lv, top, deg: (Math.atan(top / h) * 180) / Math.PI, freq: (sh.tall ? 1.1 : 3) * (sh.flexible ? 0.75 : 1.3) };
  };
  function shDraw(d) {
    shStop();
    const r = shRegion(d), svg = $("story").querySelector(".sh-svg"), b = shBuilding(), lv = r.animation_level, still = reducedMotion.matches;
    const mo = shMotion(lv, b.h), A = mo.ground, ghost = still
      ? [-1, 1].map((s) => `<g transform="translate(160 160) skewX(${(s * mo.deg).toFixed(2)})" class="sh-ghost">${b.svg}</g>`).join("") : "";
    // the ground has stripes and stones, so its sideways movement can be seen (a plain strip looks still when it moves)
    let marks = "";
    for (let x = -60; x <= 380; x += 22) marks += `<path d="M ${x} 166 l 8 0" class="sh-mark"/><circle cx="${x + 11}" cy="${177 + ((x / 22) % 2 ? 4 : -2)}" r="1.8" class="sh-stone"/>`;
    svg.innerHTML = `<g id="sh-ground"><rect x="-60" y="160" width="440" height="30" class="sh-ground"/>${marks}</g>` +
      `<line x1="0" y1="160" x2="320" y2="160" class="sh-groundline"/>` + ghost +
      `<g id="sh-bld" transform="translate(160 160)">${b.svg}</g>` +
      (still ? `<path d="M ${160 - A} 184 h ${2 * A}" class="sh-arrow"/><path d="M ${156 - A} 184 l 6 -4 v 8 z M ${164 + A} 184 l -6 -4 v 8 z" class="sh-arrowhead"/>` : "");
    const height = sh.tall ? t("High-rise") : t("Low-rise"), frame = sh.flexible ? t("More flexible") : t("Stiffer");
    $("story").querySelector(".sh-cap").textContent = (still
      ? t("Reduced motion is on: the dashed outlines show how far the top would sway.") + " "
      : "") + t("{place}: estimated shaking {cls} {mmi} · {height}, {frame}.", { place: r.name, cls: shClass(r), mmi: shMmi(r), height, frame }); // v91: same label as above; the internal animation level is not shown
    const btn = $("story").querySelector(".sh-play");
    btn.hidden = still;
    btn.disabled = false; // v80c: a choice made during the animation stops it; the new choice can be started at once
    btn.textContent = sh.done ? t("Try again") : t("Start the shaking");
  }
  function shStop() {
    if (sh.playing) { cancelAnimationFrame(sh.playing); sh.playing = 0; }
    clearTimeout(sh.timer);
  }
  function shPlay(d) {
    if (reducedMotion.matches) return;
    shStop();
    const r = shRegion(d), lv = r.animation_level, svg = $("story").querySelector(".sh-svg");
    const g = svg.querySelector("#sh-bld"), ground = svg.querySelector("#sh-ground"), btn = $("story").querySelector(".sh-play");
    if (!g || !ground || !btn) return;
    const mo = shMotion(lv, shBuilding().h), A = mo.ground, deg = mo.deg, DUR = 4.5, t0 = performance.now();
    btn.disabled = true;
    const env = (s) => (s < 0.35 ? s / 0.35 : s > 3.4 ? Math.max(0, 1 - (s - 3.4) / 1.1) : 1);
    const finish = () => {
      shStop();
      if (!g.isConnected) return; // the drawing was replaced (a new choice): shDraw has already reset the button
      g.setAttribute("transform", "translate(160 160)"); ground.setAttribute("transform", "");
      sh.done = true; btn.disabled = false; btn.textContent = t("Try again"); btn.focus({ preventScroll: true });
    };
    const step = (now) => {
      const s = (now - t0) / 1000;
      if (s >= DUR) return finish();
      const e = env(s), gx = A * e * Math.sin(2 * Math.PI * 2.2 * s), a = deg * e * Math.sin(2 * Math.PI * mo.freq * s - 0.6);
      ground.setAttribute("transform", `translate(${gx.toFixed(2)} 0)`);
      g.setAttribute("transform", `translate(${(160 + gx).toFixed(2)} 160) skewX(${a.toFixed(2)})`);
      sh.playing = requestAnimationFrame(step);
    };
    sh.playing = requestAnimationFrame(step);
    sh.timer = setTimeout(() => { if (sh.playing) finish(); }, DUR * 1000 + 600); // a background tab, where animation frames wait
  }

  // ---------------------------------------------------------------------------------------------------------------
  // v82: "Try how the fire spreads" — on the last picture of a story whose event is a wildfire (Palisades). An illustrative game
  // on a drawn, top-down forest (no real fuel, slope or weather data; not a forecast and not the Palisades fire).
  // Simulation: a 90 × 60 cell grid under the drawing (8 px per cell on a 720 × 480 canvas); the trees are drawn with jitter and
  // overlap, so no grid shows. One step = 250 ms on screen = 2 minutes of game time. A burning cell heats up step by step, so
  // a first flame grows slowly; spread to a neighbour depends on its heat, the plants, the wind (360° compass, low / medium /
  // high) and water. High wind: once the fire is large, small spot fires start ahead of it; at the start, a high wind blows out
  // the first small flame (a game rule, said on screen). Water tool: stays on until switched off; a circle of the chosen radius
  // follows the pointer (finger: drag, release to drop); drops fall, splash, and the cells inside the circle — the same circle
  // as drawn — lose their flames (the ground stays burned) and stay wet (blue) for a while. Burned cells keep ash and black
  // trunks. "Start over" brings back the same forest and starting point. The real Palisades images stay on the event map.
  const FI_W = 90, FI_H = 60, FI_C = 8, FI_PX = FI_W * FI_C, FI_PY = FI_H * FI_C;
  const FI_STEP = 250, FI_MIN = 2, FI_WET = 48, FI_SLOW = 16, FI_SPOT_MIN = 90, FI_BLOW = 8;
  const FI_POWER = { low: 0.35, mid: 0.7, high: 1.05 };
  const fi = { open: false, raf: 0, last: 0, acc: 0, running: false, started: false, over: false, state: null, heat: null, burnT: null,
    wet: null, burning: [], wetSet: null, start: null, angle: 250, power: "mid", tool: "start", radius: 3.5, slow: 0, steps: 0, rng: null,
    blow: 0, cursor: [45, 30], kb: false, aim: null, drag: false, slideT: 0, hint: null, base: null, drops: [], splashes: [], smoke: [],
    embers: [], pending: [], dirty: true, spr: null, sprKey: "" };
  function fiRng(seed) { // small seeded generator: the same forest every time, the same fire for the same choices
    let a = seed >>> 0;
    return () => { a = (a + 0x6d2b79f5) >>> 0; let q = a; q = Math.imul(q ^ (q >>> 15), q | 1); q ^= q + Math.imul(q ^ (q >>> 7), q | 61); return ((q ^ (q >>> 14)) >>> 0) / 4294967296; };
  }
  function fiNoise(r, step) { // smooth value noise over the cell grid
    const gw = Math.ceil(FI_W / step) + 2, gh = Math.ceil(FI_H / step) + 2, g = Array.from({ length: gw * gh }, r);
    return (x, y) => {
      const fx = x / step, fy = y / step, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), v = (i, j) => g[(iy + j) * gw + ix + i];
      return (v(0, 0) * (1 - sx) + v(1, 0) * sx) * (1 - sy) + (v(0, 1) * (1 - sx) + v(1, 1) * sx) * sy;
    };
  }
  // the land, made once: 0 bare ground, 1 shrubs, 2 forest, 3 dirt road (0 and 3 do not burn); one jittered tree per plant cell
  let fiLand = null;
  function fiTerrain() {
    if (fiLand) return fiLand;
    const r = fiRng(20250107), n = FI_W * FI_H, fuel = new Uint8Array(n), trees = new Array(n);
    const big = fiNoise(r, 16), small = fiNoise(r, 5), tone = fiNoise(r, 7);
    let veg = 0;
    for (let y = 0; y < FI_H; y++) for (let x = 0; x < FI_W; x++) {
      const i = y * FI_W + x, v = big(x, y) * 0.7 + small(x, y) * 0.3;
      const road = Math.abs(y - (46 + 5 * Math.sin(x / 11) + 1.6 * Math.sin(x / 4.3))) < 0.75;
      const f = road ? 3 : v < 0.33 ? 0 : v < 0.43 ? 1 : 2;
      fuel[i] = f; if (f === 1 || f === 2) veg++;
      trees[i] = { x: (x + 0.5) * FI_C + (r() - 0.5) * 5, y: (y + 0.5) * FI_C + (r() - 0.5) * 5,
        r: f === 2 ? 3.4 + r() * 2.8 : 1.6 + r() * 1.3, tone: Math.min(1, tone(x, y) * 0.8 + r() * 0.3), kind: r() < 0.33 ? 1 : 0, rot: r() * 6.283, k: r() };
    }
    return (fiLand = { fuel, trees, veg });
  }
  const fiBurnable = (i) => { const f = fiTerrain().fuel[i]; return f === 1 || f === 2; };
  const fiMix = (a, b, k) => `rgb(${a.map((v, j) => Math.round(v + (b[j] - v) * k)).join(",")})`;
  // the untouched forest, painted once (ground, clearings, road, then trees from top to bottom so crowns overlap naturally)
  let fiPristine = null;
  function fiPaintForest() {
    if (fiPristine) return fiPristine;
    const L = fiTerrain(), c = document.createElement("canvas"), g = c.getContext("2d"), r = fiRng(77);
    c.width = FI_PX; c.height = FI_PY;
    g.fillStyle = "#5f7a3a"; g.fillRect(0, 0, FI_PX, FI_PY);
    for (let k = 0; k < 700; k++) { g.fillStyle = ["rgba(150,135,80,.16)", "rgba(55,85,35,.2)", "rgba(110,120,60,.16)"][k % 3]; g.beginPath(); g.arc(r() * FI_PX, r() * FI_PY, 6 + r() * 20, 0, 7); g.fill(); }
    for (let i = 0; i < L.fuel.length; i++) { // soft ground patches under each cell (circles bigger than the cell: no edges)
      const f = L.fuel[i], t0 = L.trees[i], x = f === 3 ? ((i % FI_W) + 0.5) * FI_C : t0.x, y = f === 3 ? (((i / FI_W) | 0) + 0.5) * FI_C : t0.y;
      g.fillStyle = f === 0 ? fiMix([176, 156, 112], [198, 180, 134], t0.k) : f === 3 ? "#d8c99d" : f === 2 ? "#27451f" : fiMix([100, 128, 56], [120, 140, 66], t0.tone);
      g.beginPath(); g.arc(x, y, FI_C * (f === 3 ? 0.8 : 0.8 + 0.45 * t0.k), 0, 7); g.fill();
    }
    for (let i = 0; i < L.fuel.length; i++) { const f = L.fuel[i]; if (f === 1 || f === 2) fiTree(g, L.trees[i], f); }
    return (fiPristine = c);
  }
  function fiTree(g, t, f) {
    if (f === 1) { // shrubs: two or three small yellow-green bushes
      for (let k = 0; k < 3; k++) {
        const a = t.rot + k * 2.1, d = t.r * 0.9;
        g.fillStyle = fiMix([96, 130, 52], [140, 160, 70], (t.tone + k * 0.2) % 1);
        g.beginPath(); g.arc(t.x + Math.cos(a) * d, t.y + Math.sin(a) * d, t.r * (0.7 + 0.15 * k), 0, 7); g.fill();
      }
      return;
    }
    g.fillStyle = "rgba(10,25,8,.42)"; g.beginPath(); g.arc(t.x + 1.7, t.y + 1.9, t.r, 0, 7); g.fill(); // shadow (sun from the top left)
    if (t.kind === 1) { // conifer seen from above: a jagged star
      g.fillStyle = fiMix([22, 70, 44], [52, 112, 66], t.tone);
      g.beginPath();
      for (let k = 0; k < 16; k++) { const a = t.rot + (k * Math.PI) / 8, d = k % 2 ? t.r * 0.62 : t.r; g.lineTo(t.x + Math.cos(a) * d, t.y + Math.sin(a) * d); }
      g.closePath(); g.fill();
      g.fillStyle = fiMix([60, 120, 70], [100, 160, 90], t.tone); g.beginPath(); g.arc(t.x - t.r * 0.15, t.y - t.r * 0.15, t.r * 0.28, 0, 7); g.fill();
    } else { // broadleaf crown: round with a lit side
      g.fillStyle = fiMix([26, 78, 34], [78, 136, 54], t.tone); g.beginPath(); g.arc(t.x, t.y, t.r, 0, 7); g.fill();
      g.fillStyle = fiMix([70, 128, 58], [128, 178, 84], t.tone); g.globalAlpha = 0.65;
      g.beginPath(); g.arc(t.x - t.r * 0.32, t.y - t.r * 0.32, t.r * 0.48, 0, 7); g.fill(); g.globalAlpha = 1;
    }
  }
  function fiPaintBurned(g, i) { // ash-grey ground and a charred tree (black trunk and bare branches seen from above)
    const L = fiTerrain(), t = L.trees[i], cx = ((i % FI_W) + 0.5) * FI_C, cy = (((i / FI_W) | 0) + 0.5) * FI_C;
    g.fillStyle = fiMix([128, 124, 117], [158, 154, 146], t.k); g.beginPath(); g.arc(cx + (t.k - 0.5) * 2, cy + (t.tone - 0.5) * 2, FI_C * 0.98, 0, 7); g.fill();
    g.fillStyle = "rgba(70,66,60,.5)"; g.beginPath(); g.arc(cx + (t.tone - 0.5) * 5, cy + (t.k - 0.5) * 5, 1.4 + t.k * 1.5, 0, 7); g.fill();
    if (L.fuel[i] === 2) {
      g.strokeStyle = "#1a1714"; g.lineWidth = 1.1;
      g.beginPath(); for (let k = 0; k < 5; k++) { const a = t.rot + k * 1.26; g.moveTo(t.x, t.y); g.lineTo(t.x + Math.cos(a) * t.r * 0.9, t.y + Math.sin(a) * t.r * 0.9); } g.stroke();
      g.fillStyle = "#0e0d0c"; g.beginPath(); g.arc(t.x, t.y, 1.6 + t.r * 0.18, 0, 7); g.fill();
    } else { g.fillStyle = "#1e1b18"; g.fillRect(t.x - 1, t.y - 1, 2, 2); g.fillRect(t.x + 2, t.y + 1, 1.5, 1.5); }
  }
  function fiBuildBase() { // the current look of the ground: the untouched forest plus every burned cell
    if (!fi.base) { fi.base = document.createElement("canvas"); fi.base.width = FI_PX; fi.base.height = FI_PY; }
    const g = fi.base.getContext("2d");
    g.drawImage(fiPaintForest(), 0, 0);
    if (fi.state) for (let i = 0; i < fi.state.length; i++) if (fi.state[i] === 2) fiPaintBurned(g, i);
    fi.dirty = true;
  }
  const fiSprite = (w, h, draw) => { const c = document.createElement("canvas"); c.width = w; c.height = h; draw(c.getContext("2d")); return c; };
  const fiRadial = (s, stops) => fiSprite(s, s, (g) => { const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2); stops.forEach(([o, c]) => gr.addColorStop(o, c)); g.fillStyle = gr; g.fillRect(0, 0, s, s); });
  let fiFx = null;
  function fiSprites() {
    if (!fiFx) fiFx = {
      glow: fiRadial(40, [[0, "rgba(255,140,30,.75)"], [0.45, "rgba(255,80,10,.35)"], [1, "rgba(255,60,0,0)"]]),
      ember: fiRadial(16, [[0, "rgba(120,20,0,.95)"], [0.6, "rgba(90,15,0,.6)"], [1, "rgba(60,10,0,0)"]]),
      smoke: fiRadial(32, [[0, "rgba(70,70,72,.55)"], [1, "rgba(70,70,72,0)"]]),
      wet: fiRadial(24, [[0, "rgba(30,120,255,.85)"], [0.7, "rgba(30,120,255,.7)"], [1, "rgba(30,120,255,0)"]]),
      drop: fiSprite(6, 11, (g) => { g.fillStyle = "#58a8ff"; g.beginPath(); g.moveTo(3, 0); g.quadraticCurveTo(6, 7, 3, 11); g.quadraticCurveTo(0, 7, 3, 0); g.fill(); g.fillStyle = "#d6ecff"; g.fillRect(2, 5, 1.2, 3); }),
    };
    // flames lean and stretch downwind: three flicker shapes, made again when the wind changes (this is what makes the change show at once)
    const key = `${Math.round(fi.angle)}|${fi.power}`;
    if (fi.sprKey !== key) {
      fi.sprKey = key;
      const len = 10 + FI_POWER[fi.power] * 10;
      fi.spr = [0, 1, 2].map((v) => fiSprite(56, 56, (g) => {
        g.translate(28, 28); g.rotate((fi.angle * Math.PI) / 180);
        const L = len * (0.82 + v * 0.13), w = 5.6 - v * 0.7, grd = g.createLinearGradient(0, 3, 0, -L);
        grd.addColorStop(0, "#c62a00"); grd.addColorStop(0.35, "#ff6a00"); grd.addColorStop(1, "rgba(255,170,40,.2)");
        g.fillStyle = grd; g.beginPath(); g.moveTo(-w, 2); g.quadraticCurveTo(-w * 1.05, -L * 0.45, 0, -L); g.quadraticCurveTo(w * 1.05, -L * 0.45, w, 2);
        g.quadraticCurveTo(0, 5, -w, 2); g.fill();
        g.fillStyle = "#ffd23f"; g.beginPath(); g.moveTo(-w * 0.5, 1); g.quadraticCurveTo(-w * 0.45, -L * 0.3, 0, -L * 0.55); g.quadraticCurveTo(w * 0.45, -L * 0.3, w * 0.5, 1); g.fill();
      }));
    }
    return fiFx;
  }
  function fiReset() {
    const n = FI_W * FI_H;
    fi.running = false; fi.state = new Uint8Array(n); fi.heat = new Float32Array(n); fi.burnT = new Uint8Array(n); fi.wet = new Uint8Array(n);
    fi.burning = []; fi.wetSet = new Set(); fi.started = false; fi.over = false; fi.slow = 0; fi.steps = 0; fi.acc = 0; fi.blow = 0;
    fi.drops = []; fi.splashes = []; fi.smoke = []; fi.embers = []; fi.pending = []; fi.rng = fiRng(82);
    fiBuildBase();
  }
  function fiStop() { if (fi.raf) cancelAnimationFrame(fi.raf); fi.raf = 0; fi.running = false; }
  function fiKick() { if (!fi.raf && fi.open) { fi.last = 0; fi.raf = requestAnimationFrame(fiLoop); } }
  function fiRun() { if (!fi.started || fi.over) return; fi.running = true; fi.acc = 0; fiKick(); }
  function fiLoop(now) {
    fi.raf = 0;
    if (!fi.open || $("story").hidden) return;
    const dt = fi.last ? Math.min(0.1, (now - fi.last) / 1000) : 0; fi.last = now;
    if (fi.running) {
      fi.acc += dt * 1000;
      let stepped = false;
      while (fi.acc >= FI_STEP && fi.running) { fi.acc -= FI_STEP; fiStep(); stepped = true; }
      if (stepped) fiStat();
    }
    fiEffects(now, dt);
    if (fi.dirty || fi.running || fi.drops.length || fi.splashes.length || fi.smoke.length || fi.embers.length || fi.pending.length) fiRender(now);
    fi.raf = requestAnimationFrame(fiLoop);
  }
  const fiWindVec = () => { const a = (fi.angle * Math.PI) / 180; return [Math.sin(a), -Math.cos(a)]; };
  function fiIgnite(j, heat) { fi.state[j] = 1; fi.heat[j] = heat; fi.burnT[j] = fiTerrain().fuel[j] === 1 ? 12 : 24; fi.burning.push(j); }
  function fiStep() {
    const L = fiTerrain(), st = fi.state;
    fi.steps++;
    if (fi.blow > 0) { // game rule: a high wind at the start blows out the small first flame
      const i = fi.burning[0];
      if (i != null) fi.heat[i] = Math.max(0.03, fi.heat[i] - 0.012);
      if (--fi.blow === 0) {
        if (i != null) { st[i] = 0; fi.heat[i] = 0; fi.burnT[i] = 0; }
        fi.burning = []; fi.started = false; fi.running = false; fi.steps = 0;
        fiHint(() => t("The small first flame went out: in this game a high wind blows out a fire before it can grow, so start with a low or medium wind."));
        fiButtons(); fiClock();
      }
      return;
    }
    const s = FI_POWER[fi.power], [wx, wy] = fiWindVec(), slow = fi.slow > 0 ? 0.5 : 1, list = fi.burning, next = [];
    for (const i of list) {
      const x = i % FI_W, y = (i / FI_W) | 0, h = fi.heat[i];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= FI_W || Y >= FI_H) continue;
        const j = Y * FI_W + X;
        if (st[j] !== 0 || !fiBurnable(j)) continue;
        const len = Math.hypot(dx, dy), along = (dx * wx + dy * wy) / len;
        let p = (L.fuel[j] === 1 ? 0.13 : 0.09) * h * Math.exp(2.3 * s * along) * (len > 1 ? 0.7 : 1) * slow;
        if (fi.wet[j]) p *= 0.05;
        if (fi.rng() < p) { fiIgnite(j, 0.12); next.push(j); fi.burning.pop(); }
      }
    }
    // spot fires: with a high wind and a large fire, embers now and then light small fires ahead of the flames
    if (fi.power === "high" && list.length && list.length + fiBurnedCount() >= FI_SPOT_MIN && fi.rng() < 0.18) {
      // embers leave from the downwind edge of the fire (a few tries: a spot already burned, bare or wet is skipped)
      const front = list.slice().sort((p, q) => ((q % FI_W) * wx + ((q / FI_W) | 0) * wy) - ((p % FI_W) * wx + ((p / FI_W) | 0) * wy)).slice(0, 12);
      for (let k = 0; k < 3; k++) {
        const b = front[(fi.rng() * front.length) | 0], d = 4 + fi.rng() * 4, a = Math.atan2(wy, wx) + (fi.rng() - 0.5) * 0.8;
        const bx = b % FI_W, by = (b / FI_W) | 0, X = Math.round(bx + Math.cos(a) * d), Y = Math.round(by + Math.sin(a) * d);
        if (X < 0 || Y < 0 || X >= FI_W || Y >= FI_H) continue;
        const j = Y * FI_W + X;
        if (st[j] !== 0 || !fiBurnable(j) || fi.wet[j]) continue;
        fiIgnite(j, 0.08); next.push(j); fi.burning.pop();
        fi.embers.push({ x0: (bx + 0.5) * FI_C, y0: (by + 0.5) * FI_C, x1: (X + 0.5) * FI_C, y1: (Y + 0.5) * FI_C, t: 0 });
        break;
      }
    }
    const g = fi.base.getContext("2d"), keep = [];
    for (const i of list) {
      if (st[i] !== 1) continue; // put out by water during this step
      fi.heat[i] = Math.min(1, fi.heat[i] + 0.06);
      if (fi.burnT[i] > 0) fi.burnT[i]--;
      if (fi.burnT[i] === 0) { st[i] = 2; fiPaintBurned(g, i); } else keep.push(i);
    }
    fi.burning = keep.concat(next);
    for (const i of fi.wetSet) if (--fi.wet[i] === 0) fi.wetSet.delete(i);
    if (fi.slow > 0) fi.slow--;
    fi.dirty = true;
    if (!fi.burning.length) fiEnd();
  }
  function fiEnd() {
    fi.over = true; fi.running = false;
    fiHint(() => t("The fire went out after {time} of game time. {p}% of the forest burned.", { time: fiTime(), p: I.fmt.num(fiBurnedShare(), 0) }));
    fiButtons(); fiClock(); fiStat();
  }
  function fiBurnedCount() { let n = 0; for (let i = 0; i < fi.state.length; i++) if (fi.state[i] === 2) n++; return n; }
  function fiBurnedShare() { // only the game's own forest (shrubs and trees) counts
    let burned = 0;
    for (let i = 0; i < fi.state.length; i++) if (fi.state[i] !== 0 && fiBurnable(i)) burned++;
    return Math.round((burned / fiTerrain().veg) * 100);
  }
  const fiTime = () => { const m = fi.steps * FI_MIN; return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`; };
  // water: the same circle as the one drawn — every cell whose centre lies inside it
  function fiWater(cx, cy, R) {
    const g = fi.base.getContext("2d");
    for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(FI_H - 1, Math.ceil(cy + R)); y++)
      for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(FI_W - 1, Math.ceil(cx + R)); x++) {
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > R) continue;
        const i = y * FI_W + x;
        if (fi.state[i] === 1) { fi.state[i] = 2; fi.burnT[i] = 0; fiPaintBurned(g, i); } // flames out, the ground stays burned
        else if (fi.state[i] === 0 && fiBurnable(i)) { fi.wet[i] = FI_WET; fi.wetSet.add(i); }
      }
    fi.burning = fi.burning.filter((i) => fi.state[i] === 1);
    fi.slow = FI_SLOW; fi.dirty = true;
    if (fi.started && !fi.burning.length && !fi.blow) fiEnd();
  }
  function fiDropAt(cx, cy) {
    const R = fi.radius, now = performance.now();
    if (reducedMotion.matches) { fiWater(cx, cy, R); return; }
    const n = Math.round(8 + R * 4), r = Math.random;
    let last = 0;
    for (let k = 0; k < n; k++) {
      const a = r() * 6.283, d = Math.sqrt(r()) * R * FI_C, dur = 260 + r() * 220, t0 = now + r() * 120;
      fi.drops.push({ x: cx * FI_C + Math.cos(a) * d, y: cy * FI_C + Math.sin(a) * d, t0, dur });
      last = Math.max(last, t0 + dur);
    }
    fi.pending.push({ cx, cy, R, at: last });
  }
  function fiEffects(now, dt) {
    for (const p of fi.pending.slice()) if (now >= p.at) { fiWater(p.cx, p.cy, p.R); fi.pending.splice(fi.pending.indexOf(p), 1); }
    fi.drops = fi.drops.filter((d) => { if (now - d.t0 < d.dur) return true; fi.splashes.push({ x: d.x, y: d.y, t0: now }); return false; });
    fi.splashes = fi.splashes.filter((s) => now - s.t0 < 320);
    const still = reducedMotion.matches, s = FI_POWER[fi.power], [wx, wy] = fiWindVec();
    if (fi.running && !still && fi.burning.length && fi.smoke.length < 140)
      for (let k = 0; k < Math.min(3, fi.burning.length); k++) {
        const i = fi.burning[(Math.random() * fi.burning.length) | 0];
        fi.smoke.push({ x: ((i % FI_W) + 0.5) * FI_C, y: (((i / FI_W) | 0) + 0.5) * FI_C, life: 0, max: 1.6 + Math.random() * 1.4, sz: 10 + Math.random() * 8 });
      }
    const v = 10 + 26 * s; // smoke drifts with the wind at once
    fi.smoke = fi.smoke.filter((p) => { p.life += dt; p.x += (wx * v + (Math.random() - 0.5) * 6) * dt; p.y += (wy * v + (Math.random() - 0.5) * 6) * dt; p.sz += 9 * dt; return p.life < p.max; });
    fi.embers = fi.embers.filter((e) => (e.t += dt) < 0.6);
  }
  function fiRender(now) {
    const cv = $("story").querySelector(".fi-map");
    if (!cv || !fi.base) return;
    fi.dirty = false;
    const g = cv.getContext("2d"), S = fiSprites(), still = reducedMotion.matches;
    g.drawImage(fi.base, 0, 0);
    for (const i of fi.wetSet) { // wet plants: blue, fading as they dry
      g.globalAlpha = Math.min(1, (fi.wet[i] / FI_WET) * 1.5) * 0.85;
      g.drawImage(S.wet, ((i % FI_W) + 0.5) * FI_C - 12, (((i / FI_W) | 0) + 0.5) * FI_C - 12);
    }
    g.globalAlpha = 1;
    for (const i of fi.burning) { const x = ((i % FI_W) + 0.5) * FI_C, y = (((i / FI_W) | 0) + 0.5) * FI_C; g.drawImage(S.ember, x - 8, y - 8); }
    g.globalCompositeOperation = "lighter";
    for (const i of fi.burning) {
      const h = fi.heat[i], z = 18 + 22 * h, x = ((i % FI_W) + 0.5) * FI_C, y = (((i / FI_W) | 0) + 0.5) * FI_C;
      g.globalAlpha = 0.35 + 0.5 * h; g.drawImage(S.glow, x - z / 2, y - z / 2, z, z);
    }
    g.globalCompositeOperation = "source-over"; g.globalAlpha = 1;
    const tick = Math.floor(now / 90);
    for (const i of fi.burning) { // flames: size grows with heat, shrinks as the cell burns out
      const h = fi.heat[i], dying = Math.min(1, fi.burnT[i] / 6), z = 56 * (0.3 + 0.7 * h) * (0.45 + 0.55 * dying) * (fi.blow ? 0.7 : 1);
      const x = ((i % FI_W) + 0.5) * FI_C, y = (((i / FI_W) | 0) + 0.5) * FI_C;
      g.drawImage(fi.spr[still ? 0 : (i + tick) % 3], x - z / 2, y - z / 2, z, z);
    }
    for (const p of fi.smoke) { g.globalAlpha = 0.32 * (1 - p.life / p.max); g.drawImage(S.smoke, p.x - p.sz / 2, p.y - p.sz / 2, p.sz, p.sz); }
    g.globalAlpha = 1;
    for (const e of fi.embers) { const k = e.t / 0.6; g.fillStyle = "#ffb347"; g.beginPath(); g.arc(e.x0 + (e.x1 - e.x0) * k, e.y0 + (e.y1 - e.y0) * k - Math.sin(k * Math.PI) * 14, 2.2, 0, 7); g.fill(); }
    if (fi.start && !fi.started) { // the starting point: a white ring with a dark edge
      const cx = (fi.start[0] + 0.5) * FI_C, cy = (fi.start[1] + 0.5) * FI_C;
      g.lineWidth = 5; g.strokeStyle = "#111"; g.beginPath(); g.arc(cx, cy, 10, 0, 7); g.stroke();
      g.lineWidth = 2.5; g.strokeStyle = "#fff"; g.beginPath(); g.arc(cx, cy, 10, 0, 7); g.stroke();
    }
    for (const d of fi.drops) { // drops fall from above onto their spot
      const k = Math.max(0, (now - d.t0) / d.dur); if (k <= 0) continue;
      g.drawImage(S.drop, d.x - 3, d.y - 11 - (1 - k * k) * 70);
    }
    for (const s of fi.splashes) { // a short splash where a drop lands
      const k = (now - s.t0) / 320; g.strokeStyle = `rgba(190,225,255,${(1 - k).toFixed(2)})`; g.lineWidth = 1.3;
      g.beginPath(); g.arc(s.x, s.y, 2 + k * 6, 0, 7); g.stroke();
    }
    const aim = fi.aim || (now - fi.slideT < 1500 ? [FI_W / 2, FI_H / 2] : null);
    if (aim && (fi.tool === "water" || now - fi.slideT < 1500)) { // the water circle: exactly the area the water will reach
      const ax = aim[0] * FI_C, ay = aim[1] * FI_C, R = fi.radius * FI_C;
      g.lineWidth = 3; g.strokeStyle = "rgba(0,0,0,.45)"; g.beginPath(); g.arc(ax, ay, R, 0, 7); g.stroke();
      g.lineWidth = 1.6; g.strokeStyle = "#bfe3ff"; g.beginPath(); g.arc(ax, ay, R, 0, 7); g.stroke();
      if (now - fi.slideT < 1500) fi.dirty = true;
    } else if (aim && fi.kb) { // keyboard marker for the starting point
      const ax = aim[0] * FI_C, ay = aim[1] * FI_C;
      g.lineWidth = 2; g.strokeStyle = "#fff"; g.strokeRect(ax - 7, ay - 7, 14, 14);
    }
  }
  function fiHint(fn) { fi.hint = fn; const h = $("story").querySelector(".fi-hint"); if (h) h.textContent = fn ? fn() : ""; } // a function: re-translated after a language change
  function fiClock() { const el = $("story").querySelector(".fi-clock b"); if (el) el.textContent = fiTime(); }
  function fiStat() {
    fiClock();
    const el = $("story").querySelector(".fi-stat");
    if (el) el.textContent = fi.started || fi.over ? t("{p}% of the forest burned", { p: I.fmt.num(fiBurnedShare(), 0) }) : "";
  }
  const FI_DIRS = () => [t("North"), t("North-east"), t("East"), t("South-east"), t("South"), t("South-west"), t("West"), t("North-west")];
  const fiDirText = () => t("Wind blows toward: {dir} ({deg}°)", { dir: FI_DIRS()[Math.round(fi.angle / 45) % 8], deg: Math.round(fi.angle) });
  function fiButtons() {
    const box = $("story"), play = box.querySelector(".fi-play");
    if (!play) return;
    play.textContent = !fi.started || fi.over ? t("Start") : fi.running ? t("Pause") : t("Continue");
    play.disabled = fi.over || (!fi.started && !fi.start) || fi.blow > 0;
    const water = fi.tool === "water";
    box.querySelector(".fi-tool-start").setAttribute("aria-pressed", String(!water));
    box.querySelector(".fi-tool-water").setAttribute("aria-pressed", String(water));
    const chip = box.querySelector(".fi-chip");
    chip.classList.toggle("on", water);
    chip.textContent = water ? t("Water tool on: tap or drag on the map to drop water, as often as you like.") : t("Water tool off.");
    const cv = box.querySelector(".fi-map");
    cv.classList.toggle("water", water);
    box.querySelector(".fi-rule").hidden = !(fi.power === "high" && !fi.started);
    const cp = box.querySelector(".fi-compass");
    cp.querySelector(".fc-arrow").setAttribute("transform", `rotate(${fi.angle.toFixed(1)})`);
    cp.setAttribute("aria-valuenow", String(Math.round(fi.angle)));
    cp.setAttribute("aria-valuetext", fiDirText());
    fi.dirty = true;
  }
  function fiNearVeg(x, y) { // a tap just beside the plants still counts (fingers are wide)
    let best = null, bd = 9;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= FI_W || Y >= FI_H || !fiBurnable(Y * FI_W + X)) continue;
      const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = [X, Y]; }
    }
    return best;
  }
  function fiAct(cx, cy) { // a tap, a release after a drag, or Enter on the map
    if (fi.tool === "water") { fiDropAt(cx, cy); fiHint(() => t("Water dropped: the flames there went out and the spread slows for a while.")); } // the tool stays on
    else if (fi.started || fi.over) fiHint(() => t("The fire has started: drop water, change the wind or start over."));
    else {
      const p = fiNearVeg(Math.floor(cx), Math.floor(cy));
      if (p) { fi.start = p; fiHint(() => t("Starting point set. Press Start.")); } else fiHint(() => t("No vegetation here. Choose a green area."));
    }
    fiButtons();
  }
  function fiSetTool(tool) {
    fi.tool = tool;
    fiHint(tool === "water" ? () => t("Water tool on: tap or drag on the map to drop water, as often as you like.") : () => (fi.started ? t("The fire is spreading.") : t("Tap a green area to mark where the fire starts.")));
    fiButtons();
  }
  function fiSetWind(deg, say) {
    fi.angle = ((deg % 360) + 360) % 360;
    fiButtons();
    if (say) fiHint(fiDirText);
  }
  function openFire(restore) {
    if (!story || $("story").hidden) return;
    const box = $("story"), panel = box.querySelector(".sh-panel");
    if (!restore || !fi.state) { fi.start = null; fi.angle = 250; fi.power = "mid"; fi.tool = "start"; fi.radius = 3.5; fi.cursor = [45, 30]; fi.aim = null; fiReset(); fi.hint = () => t("Tap a green area to mark where the fire starts."); }
    else fiBuildBase();
    fi.open = true; fi.kb = false; fi.drag = false;
    box.classList.add("sh-on");
    for (const el of box.querySelectorAll(".sv-fig, .sv-try-row, .sv-nav")) el.hidden = true;
    const sw = (c, label) => `<li><span class="fi-sw fi-sw-${c}" aria-hidden="true"></span>${esc(label)}</li>`;
    const pw = [["low", t("Low")], ["mid", t("Medium")], ["high", t("High")]];
    panel.innerHTML = `<div class="sh-head"><h2 id="sh-h" tabindex="-1">${esc(t("Try how the fire spreads"))}</h2><span class="sv-badge sh-badge">${esc(t("Illustrative animation"))}</span></div>` +
      `<p class="sh-intro">${esc(t("Tap the forest to mark where the fire starts, set the wind on the compass and press Start. With the water tool you can drop water as often as you like."))}</p>` +
      `<div class="sh-step fi-stage">` +
        `<p class="fi-clock"><span>${esc(t("Elapsed time"))}</span> <b>00:00</b> <small>${esc(t("game time (hours:minutes), not real time"))}</small></p>` +
        `<div class="fi-mapbox"><canvas class="fi-map" width="${FI_PX}" height="${FI_PY}" tabindex="0" role="application" aria-describedby="fi-hint"` +
          ` aria-label="${esc(t("Illustrative forest map. Arrow keys move the marker; Enter marks the starting point or drops water."))}"></canvas>` +
          `<div class="fi-compass" role="slider" tabindex="0" aria-label="${esc(t("Wind direction: drag the arrow or use the arrow keys."))}" aria-valuemin="0" aria-valuemax="359">` +
            `<svg viewBox="-32 -32 64 64" aria-hidden="true"><circle r="29" class="fc-ring"/><text y="-18.5" class="fc-n">${esc(t("N"))}</text>` +
            `<g class="fc-arrow"><line x1="0" y1="13" x2="0" y2="-10" /><path d="M0 -21 L-7 -8 L7 -8 Z"/></g></svg></div></div>` +
        `<p class="fi-hint" id="fi-hint" aria-live="polite"></p><p class="fi-stat"></p>` +
        `<div class="fi-btns"><button type="button" class="btn fi-play"></button><button type="button" class="btn fi-reset">${esc(t("Start over"))}</button></div>` +
        `<div class="fi-tools" role="group" aria-label="${esc(t("Tools"))}">` +
          `<button type="button" class="btn fi-tool fi-tool-start" aria-pressed="true">${esc(t("Starting point"))}</button>` +
          `<button type="button" class="btn fi-tool fi-tool-water" aria-pressed="false">${esc(t("Drop water"))}</button></div>` +
        `<p class="fi-chip" aria-live="polite"></p>` +
        `<label class="fi-size"><span>${esc(t("Water circle size"))}</span><input type="range" class="fi-radius" min="1.5" max="7" step="0.05" value="${fi.radius}"></label>` +
        `<div class="fi-wind"><h3 id="fi-wind-h">${esc(t("Wind"))}</h3><p class="fi-wind-note">${esc(t("Turn the arrow on the compass: it shows where the wind blows."))}</p>` +
          `<div class="sh-seg fi-power" role="radiogroup" aria-label="${esc(t("Wind strength"))}">` + pw.map(([v, label]) =>
            `<button type="button" role="radio" class="sh-opt" data-v="${v}" aria-checked="${v === fi.power}">${esc(label)}</button>`).join("") + `</div>` +
          `<p class="fi-rule" hidden><b>${esc(t("Game rule:"))}</b> ${esc(t("with a high wind, the first small flame goes out before it can grow."))}</p></div>` +
        `<ul class="fi-legend">` + sw("forest", t("Forest")) + sw("shrub", t("Shrubs")) + sw("fire", t("Flames")) + sw("wet", t("Wet area")) +
          sw("burned", t("Burned area")) + sw("bare", t("Bare ground and road")) + `</ul></div>` +
      `<details class="sh-data"><summary>${esc(t("About this animation"))}</summary><ul class="sh-limits">` +
        `<li>${esc(t("An illustrative grid model, not a forecast and not a reconstruction of the Palisades fire."))}</li>` +
        `<li>${esc(t("Real fires also depend on how dry the plants are, on slopes, on embers carried far ahead by the wind and on firefighting."))}</li>` +
        `<li>${esc(t("The clock shows game time; the spot fires and the high-wind start rule are simplified rules of this game."))}</li>` +
        `<li>${esc(t("Here water wets a small area for a short time; burned ground stays burned."))}</li>` +
        `<li>${esc(t("The real satellite images and the mapped perimeter of the Palisades fire are on the event map."))}</li></ul></details>` +
      `<div class="sv-nav sh-nav"><button type="button" class="btn sh-back">${esc(t("← Back to the story"))}</button>` +
        `<button type="button" class="btn btn-primary sh-to-map">${esc(t("Explore on the map"))}</button></div>`;
    panel.hidden = false;
    const cv = panel.querySelector(".fi-map");
    const at = (e) => { const r = cv.getBoundingClientRect(); return [Math.min(FI_W, Math.max(0, ((e.clientX - r.left) / r.width) * FI_W)), Math.min(FI_H, Math.max(0, ((e.clientY - r.top) / r.height) * FI_H))]; };
    cv.addEventListener("pointerdown", (e) => { if (e.button > 0) return; fi.kb = false; fi.drag = true; fi.aim = at(e); try { cv.setPointerCapture(e.pointerId); } catch (_) {} fi.dirty = true; });
    cv.addEventListener("pointermove", (e) => { if (fi.drag || e.pointerType === "mouse") { fi.kb = false; fi.aim = at(e); fi.dirty = true; } });
    cv.addEventListener("pointerup", (e) => {
      if (!fi.drag) return;
      fi.drag = false; const p = at(e); fi.aim = e.pointerType === "mouse" ? p : null; fi.cursor = [p[0], p[1]];
      fiAct(p[0], p[1]);
    });
    cv.addEventListener("pointercancel", () => { fi.drag = false; fi.aim = null; fi.dirty = true; });
    cv.addEventListener("pointerleave", (e) => { if (!fi.drag && e.pointerType === "mouse") { fi.aim = null; fi.dirty = true; } });
    cv.addEventListener("focus", () => { if (cv.matches(":focus-visible")) { fi.kb = true; fi.aim = fi.cursor.slice(); fi.dirty = true; } });
    cv.addEventListener("blur", () => { if (fi.kb) { fi.kb = false; fi.aim = null; fi.dirty = true; } });
    cv.addEventListener("keydown", (e) => {
      const mv = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      const k = e.shiftKey ? 6 : 2;
      if (mv) { e.preventDefault(); e.stopPropagation(); fi.kb = true; fi.cursor = [Math.min(FI_W - 0.5, Math.max(0.5, fi.cursor[0] + mv[0] * k)), Math.min(FI_H - 0.5, Math.max(0.5, fi.cursor[1] + mv[1] * k))]; fi.aim = fi.cursor.slice(); fi.dirty = true; }
      else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); fi.kb = true; fi.aim = fi.cursor.slice(); fiAct(fi.cursor[0], fi.cursor[1]); }
      else if (e.key === "Escape" && fi.tool === "water") { e.preventDefault(); e.stopPropagation(); fiSetTool("start"); }
    });
    // compass: drag the arrow (mouse or finger) for any of 360°, or use the keys
    const cp = panel.querySelector(".fi-compass");
    const deg = (e) => { const r = cp.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2); return (Math.atan2(dx, -dy) * 180) / Math.PI; };
    let turning = false;
    cp.addEventListener("pointerdown", (e) => { turning = true; try { cp.setPointerCapture(e.pointerId); } catch (_) {} fiSetWind(deg(e), false); e.preventDefault(); });
    cp.addEventListener("pointermove", (e) => { if (turning) fiSetWind(deg(e), false); });
    const endTurn = () => { if (turning) { turning = false; fiSetWind(fi.angle, true); } };
    cp.addEventListener("pointerup", endTurn); cp.addEventListener("pointercancel", endTurn);
    cp.addEventListener("keydown", (e) => {
      const d = { ArrowRight: 15, ArrowUp: 15, ArrowLeft: -15, ArrowDown: -15, PageUp: 45, PageDown: -45 }[e.key];
      if (d != null) { e.preventDefault(); e.stopPropagation(); fiSetWind(Math.round((fi.angle + d) / 5) * 5, true); }
      else if (e.key === "Home") { e.preventDefault(); e.stopPropagation(); fiSetWind(0, true); }
      else if (e.key === "End") { e.preventDefault(); e.stopPropagation(); fiSetWind(270, true); }
    });
    panel.querySelector(".fi-play").addEventListener("click", () => {
      if (!fi.started) {
        if (!fi.start || fi.over) return;
        const i = fi.start[1] * FI_W + fi.start[0];
        fi.wet[i] = 0; fi.wetSet.delete(i);
        fiIgnite(i, 0.12); fi.started = true; fi.steps = 0;
        if (fi.power === "high") { fi.blow = FI_BLOW; fiHint(() => t("Game rule: with a high wind, the first small flame goes out before it can grow.")); }
        else fiHint(() => t("The fire is spreading."));
        fiRun();
      } else if (fi.running) { fi.running = false; fiHint(() => t("Paused.")); }
      else { fiRun(); fiHint(() => t("The fire is spreading.")); }
      fiButtons(); fiStat();
    });
    panel.querySelector(".fi-reset").addEventListener("click", () => { // same forest, same starting point; wind, strength and tool stay
      fiReset();
      fiHint(fi.start ? () => t("The map is back to the start. The starting point is kept: try another wind.") : () => t("Tap a green area to mark where the fire starts."));
      fiButtons(); fiStat();
    });
    panel.querySelector(".fi-tool-start").addEventListener("click", () => fiSetTool("start"));
    panel.querySelector(".fi-tool-water").addEventListener("click", () => fiSetTool(fi.tool === "water" ? "start" : "water"));
    const rad = panel.querySelector(".fi-radius");
    rad.addEventListener("input", () => { fi.radius = Number(rad.value); fi.slideT = performance.now(); fi.dirty = true; fiKick(); });
    const grp = panel.querySelector(".fi-power");
    grp.querySelectorAll(".sh-opt").forEach((b) => b.addEventListener("click", () => {
      fi.power = b.dataset.v; // flames and smoke follow at once, the spread from the next step
      grp.querySelectorAll(".sh-opt").forEach((o) => o.setAttribute("aria-checked", String(o === b)));
      fiButtons();
    }));
    grp.addEventListener("keydown", (e) => {
      if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
      e.preventDefault(); e.stopPropagation();
      const o = [...grp.querySelectorAll('[role="radio"]')], k = o.indexOf(document.activeElement), n2 = o[(k + (/Right|Down/.test(e.key) ? 1 : -1) + o.length) % o.length];
      n2.focus(); n2.click();
    });
    panel.querySelector(".sh-back").addEventListener("click", closeShaking);
    panel.querySelector(".sh-to-map").addEventListener("click", storyEnd);
    fiHint(fi.hint); fiButtons(); fiStat();
    fi.dirty = true; fiKick();
    if (!restore) panel.querySelector("#sh-h").focus({ preventScroll: false });
  }
  if (/[?&]fitest=1\b/.test(location.search)) window.__fire = { fi, land: fiTerrain, W: FI_W, H: FI_H, C: FI_C }; // local tests only
  // ---------------------------------------------------------------------------------------------------------------
  // v84: "Protect the village from the flood" — a game on the last picture of the river-flood story. Illustrative only: a drawn
  // valley, not Habiganj, and the water model is not a forecast of the real flood ("Explore on the map" opens the real event).
  // Land: a 160 × 120 cell grid (6 px per cell on a 960 × 720 canvas). Each cell has an unchangeable, undulating bedrock height,
  // a diggable soil layer on top (thin on the four northern ranges, thick in the valleys and on the plain) and the player's
  // levee material. Water: a "virtual pipes" shallow-water model — every small step each cell pushes water to its four
  // neighbours by the difference of land + water height, with damping; rain adds water, the south edge lets it leave. The river
  // is just this water (small springs feed it); digging and levees change where it goes. Tools: Rain (extra rain where tapped),
  // Dig (brush, stops at bedrock; houses whose foundation is dug away collapse, dug fields lose their crop) and Levee (sand /
  // soil / stone / concrete: cost and wear are game rules). Mission: preparation, automatic rain on the northern ranges, extra
  // time for the water to come down, then the result; "Try again with the same rain" replays the same land and rain, extra rain
  // included at the same time and place.
  const RG_W = 160, RG_H = 120, RG_PX = 6, RG_CW = RG_W * RG_PX;
  // v85: a slightly tilted view from the south: a row is RG_RY px deep and a metre of height lifts the ground RG_HZ px
  const RG_RY = 4.6, RG_HZ = 2.3;
  let RG_CH = 720, RG_OFF = 0; // canvas height and top offset, set from the land's heights
  const RG = { // game rules (illustrative)
    prep: 20, rain: 45, after: 60, goal: 8, budget: 250, sub: 24, K: 0.05, damp: 0.92, loss: 0.00004, spring: 0.06,
    rainRate: 0.001173, extraRate: 0.004, extraR: 9, extraDur: 15, freeR: 24,
    flood: 0.22, hold: 1.5, reach: 0.05, leveeH: 1.6, digStep: 0.22, collapse: 0.6, pour: 2.2, pourPer: 30, fall: 300,
  };
  const RG_MAT = [null, // 1 sand, 2 soil, 3 stone, 4 concrete: cost per cell, wear per game second while water flows over it
    { id: "sand", cost: 1, wear: 0.09, rep: 0.55, rgb: [226, 205, 140] }, // rep: the steepest step the material keeps between cells
    { id: "soil", cost: 2, wear: 0.03, rep: 0.8, rgb: [132, 90, 50] },
    { id: "stone", cost: 3, wear: 0.007, rep: 1.1, rgb: [150, 148, 140] },
    { id: "concrete", cost: 5, wear: 0, rep: 1.5, rgb: [205, 207, 210] }];
  // small hills (+) and hollows (−) on the plain, away from the river, the fields and the village: [x, y, radius, height in m]
  const RG_BUMPS = [[112, 68, 6, 1.3], [124, 86, 7, 1.6], [140, 102, 6, 1.1], [116, 106, 5, -0.9], [104, 58, 4, 0.9], [134, 64, 5, -0.7],
    [28, 66, 5, 1.1], [22, 90, 6, 1.4], [46, 112, 4, -0.8], [26, 110, 4, 1.0], [110, 92, 4, 0.8]];
  const RG_PATHS = [[[86, 96], [96, 88], [104, 80], [112, 66], [118, 50]], [[76, 96], [95, 97]], [[86, 82], [86, 110]]]; // village lanes and a track (drawing only)
  const RG_HOUSES = [[79, 85], [85, 84], [91, 86], [80, 92], [86, 93], [92, 94], [78, 99], [84, 100], [90, 101], [85, 107]];
  const RG_STREAMS = [ // valleys between the four ranges, the main river and an old western channel (polylines in cells)
    { w: 2.2, d: 1.8, pts: [[40, 0], [43, 24], [62, 40], [78, 46]] },
    { w: 2.2, d: 1.8, pts: [[80, 0], [78, 26], [78, 46]] },
    { w: 2.2, d: 1.8, pts: [[120, 0], [117, 24], [96, 40], [78, 46]] },
    { w: 3.0, d: 2.4, pts: [[78, 46], [77, 60], [71, 72], [65, 84], [68, 96], [62, 108], [66, 120]] },
    { w: 3.0, d: 2.2, old: true, pts: [[58, 74], [48, 84], [40, 96], [38, 120]] },
    { w: 2.4, d: 1.6, edge: true, pts: [[150, 0], [151, 40], [148, 80], [150, 120]] }, // streams along the valley sides take the outer slopes' water to the south edge
    { w: 2.4, d: 1.6, edge: true, pts: [[9, 0], [8, 40], [11, 80], [9, 120]] },
  ];
  let rgLand = null;
  function rgRiverX(y) { const p = RG_STREAMS[3].pts; for (let k = 0; k < p.length - 1; k++) if (y <= p[k + 1][1]) { const u = (y - p[k][1]) / Math.max(1e-6, p[k + 1][1] - p[k][1]); return p[k][0] + (p[k + 1][0] - p[k][0]) * Math.max(0, u); } return p[p.length - 1][0]; }
  const rgSS = (a, b, v) => { const k = Math.max(0, Math.min(1, (v - a) / (b - a))); return k * k * (3 - 2 * k); };
  function rgSegDist(px, py, pts) {
    let best = 1e9;
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
      best = Math.min(best, Math.hypot(px - ax - u * dx, py - ay - u * dy));
    }
    return best;
  }
  function rgTerrain() { // the untouched land, made once
    if (rgLand) return rgLand;
    const n = RG_W * RG_H, R = new Float32Array(n), S0 = new Float32Array(n), kind = new Uint8Array(n), tree = new Float32Array(n), wet0 = new Float32Array(n), tone = new Float32Array(n);
    const r = fiRng(840117), nz = (() => { const gw = 22, gh = 18, g = Array.from({ length: gw * gh }, r); return (x, y, s) => {
      const fx = x / s, fy = y / s, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const v = (i, j) => g[((iy + j) % gh) * gw + ((ix + i) % gw)];
      return (v(0, 0) * (1 - sx) + v(1, 0) * sx) * (1 - sy) + (v(0, 1) * (1 - sx) + v(1, 1) * sx) * sy; }; })();
    for (let y = 0; y < RG_H; y++) for (let x = 0; x < RG_W; x++) {
      const i = y * RG_W + x, ny = y / RG_H, ridge = 1 - rgSS(8, 56, y);
      let M = 0;
      for (const [cx, ph] of [[20, 0.3], [60, 1.9], [100, 3.1], [140, 4.4]]) { // broad shoulders, a sharp crest and separate summits along each range
        const dx = Math.abs(x - cx), crest = 0.62 * Math.exp(-((dx / 12) ** 2)) + 0.38 * Math.exp(-dx / 3.2);
        M += 28 * crest * ridge * (0.78 + 0.5 * Math.pow(Math.max(0, Math.sin(y / 5.2 + ph)), 3)) * (0.85 + 0.3 * nz(x, y, 7));
      }
      let bump = 0; for (const [bx, by, br, bh] of RG_BUMPS) bump += bh * Math.exp(-(((x - bx) ** 2 + (y - by) ** 2) / (br * br)));
      const wall = 7 * Math.max(0, 1 - Math.min(x, RG_W - 1 - x) / 6); // the valley's sides keep the water in
      let inc = 0, old = false, chan = 0, near = 1e9;
      const ds = RG_STREAMS.map((s) => rgSegDist(x + 0.5, y + 0.5, s.pts));
      for (const d of ds) near = Math.min(near, d);
      // the land rises gently away from the nearest valley or river, so rain runs together into them (a flat floodplain next to the river)
      const trough = Math.min(6, 0.03 * Math.max(0, near - 3) + 0.14 * Math.max(0, near - 18));
      // higher ground on the river's east side upstream of the village: an overflow there does not run into the village
      // a high terrace on the river's east bank upstream of the village (the upper river spills west, where nobody lives),
      // and the land tilts towards the river so overflow and side water return to it
      const east = x + 0.5 > rgRiverX(y + 0.5);
      const rise = ((east ? 1.7 : 0.4) * rgSS(3, 9, ds[3]) * (1 - rgSS(72, 80, y)) + (east ? 0.16 : 0.07) * Math.min(30, Math.max(0, ds[3] - 3)) * (1 - rgSS(76, 86, y))) * rgSS(36, 46, y);
      // a natural ridge between the river and the old western channel: only a dug canal opens that way
      const divide = !east ? 1.3 * rgSS(2.5, 5.5, Math.min(ds[3], ds[4])) * rgSS(60, 66, y) * (1 - rgSS(84, 90, y)) * (ds[3] < 16 ? 1 : 0) : 0;
      const land = 3 + 9 * Math.pow(1 - ny, 1.3) + M + wall + trough + rise + divide + bump + 0.3 * (nz(x, y, 4) - 0.5);
      // the river bed is narrower and shallower beside the village (a full, narrow bed spills over its banks there)
      const narrow = 1 - 0.55 * rgSS(76, 84, y) * (1 - rgSS(100, 108, y));
      for (let si = 0; si < RG_STREAMS.length; si++) {
        const s = RG_STREAMS[si], d = ds[si], sw = s.w, sd = si === 3 ? s.d * narrow : s.d; // beside the village the bed is shallower (lower banks), not narrower
        const v = sd * Math.max(0, 1 - (d / sw) ** 2) + 0.35 * sd * Math.max(0, 1 - (d / (sw * 3)) ** 2);
        if (v > inc) { inc = v; old = !!s.old; }
        if (d < sw) { chan = 1; if (si <= 3) wet0[y * RG_W + x] = Math.max(wet0[y * RG_W + x], 0.32 * (1 - (d / sw) ** 2)); } // the river and the valley streams start with water in their beds
      }
      // soil: thin on the high ranges, thick in valleys and on the plain; the bedrock surface undulates
      const soil = Math.max(0.15, Math.min(3.4, 3.3 - 0.14 * M)) + 0.45 * Math.sin(x / 9.3 + 1.7 * nz(x, y, 11)) * Math.cos(y / 7.1) + Math.max(0, bump); // hills are soil
      R[i] = land - Math.max(0.15, soil);
      const surf = Math.max(R[i], land - inc);
      S0[i] = surf - R[i];
      // what grows there (for drawing): 1 rock, 2 mountain scrub, 3 forest, 4 grass, 5 field, 6 channel bed, 7 flowers, 8 bare soil, 9 lane
      const nearStream = Math.min(ds[0], ds[1], ds[2], ds[3]), clump = nz(x, y, 5);
      kind[i] = chan ? 6 : S0[i] < 0.3 ? 1 : M > 13 ? 2
        : (M > 1.5 && clump > 0.38) || (y < 72 && clump > 0.6) || (nearStream > 3 && nearStream < 8 && y < 76 && clump > 0.5) || (bump > 0.5 && clump > 0.45) ? 3
        : nz(x + 40, y, 3) > 0.74 ? 7 : nz(x, y + 50, 4) > 0.8 ? 8 : 4;
      tree[i] = r(); tone[i] = nz(x + 7, y + 3, 6) * 0.75 + nz(x, y, 2.5) * 0.25; // smooth shade changes (no cell checkerboard)
    }
    // fields between the river and the houses (not on the bank, not under the houses)
    for (let y = 80; y < 112; y++) for (let x = 69; x < 76; x++) { const i = y * RG_W + x; if (kind[i] !== 6 && rgSegDist(x + 0.5, y + 0.5, RG_STREAMS[3].pts) > 4) kind[i] = 5; }
    for (const pts of RG_PATHS) for (let y = 40; y < RG_H; y++) for (let x = 60; x < 125; x++) { const i = y * RG_W + x; if ((kind[i] === 4 || kind[i] === 7 || kind[i] === 8) && rgSegDist(x + 0.5, y + 0.5, pts) < 0.6) kind[i] = 9; }
    const houses = RG_HOUSES.map(([cx, cy], k) => {
      const cells = []; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cells.push((cy + dy) * RG_W + cx + dx);
      for (const i of cells) kind[i] = 4;
      return { cx, cy, cells, look: k }; // look: roof colour and direction vary from house to house
    });
    // canvas size for the tilted view: room above the highest ground (plus levees) and below the front edge
    let top = 1e9, bot = -1e9;
    for (let y = 0; y < RG_H; y++) for (let x = 0; x < RG_W; x++) { const z = R[y * RG_W + x] + S0[y * RG_W + x]; top = Math.min(top, y * RG_RY - (z + 5) * RG_HZ); bot = Math.max(bot, (y + 1) * RG_RY - z * RG_HZ); }
    RG_OFF = Math.ceil(-top + 6); RG_CH = Math.ceil(bot + RG_OFF + 18);
    return (rgLand = { R, S0, kind, tree, houses, wet0, tone });
  }
  // ---- game state ----------------------------------------------------------------------------------------------
  const rg = { open: false, raf: 0, last: 0, acc: 0, g: null, view: { s: 1, x: 0, y: 0 }, tool: "levee", mat: 2, brush: 3, mode: "mission",
    scenario: null, prev: null, hint: null, dirty: true, pointers: new Map(), gest: null, pinch: null, aim: null, kb: false, cursor: [80, 70],
    terrainDirty: null, parts: [], drops: [], streaks: [], pour: null };
  let rgPrefill = null;
  function rgNewWater(L) { // water already in the river and the valley streams when the game starts; the springs keep it flowing
    if (rgPrefill) return rgPrefill;
    const n = RG_W * RG_H;
    return (rgPrefill = { h: L.wet0.slice(), fE: new Float32Array(n), fW: new Float32Array(n), fN: new Float32Array(n), fS: new Float32Array(n) });
  }
  function rgBuild(g, L, pre) {
    const n = RG_W * RG_H;
    g.T = new Float32Array(n); for (let i = 0; i < n; i++) g.T[i] = L.R[i] + g.S[i] + g.Lv[i];
    g.h = pre ? pre.h.slice() : new Float32Array(n);
    for (const k of ["fE", "fW", "fN", "fS"]) g[k] = pre ? pre[k].slice() : new Float32Array(n);
  }
  function rgRound(mode, scenario) { // a new round: the same land every time; the rain scenario repeats when given
    const L = rgTerrain(), pre = rgNewWater(L);
    const g = { S: L.S0.slice(), Lv: new Float32Array(RG_W * RG_H), M: new Uint8Array(RG_W * RG_H), crop: new Uint8Array(RG_W * RG_H) };
    for (let i = 0; i < g.crop.length; i++) g.crop[i] = L.kind[i] === 5 ? 1 : 0;
    rgBuild(g, L, pre);
    g.mode = mode; g.phase = "prep"; g.time = 0; g.rainT = 0; g.running = true; g.budget = RG.budget; g.steps = 0;
    g.scenario = scenario ? { center: scenario.center, extras: scenario.extras.map((e) => ({ ...e, played: false })) } : { center: null, extras: [] };
    g.ready = mode === "mission" || !!g.scenario.center; // free play waits for the player to choose where the rain starts
    g.houses = L.houses.map((hs) => ({ ...hs, wet: 0, lost: null, at: null, fall: 0 }));
    g.firstReach = null; g.pending = []; g.result = null;
    rg.g = g; rg.terrainDirty = [0, 0, RG_W - 1, RG_H - 1]; rg.parts = []; rg.drops = []; rg.dirty = true;
    rg.vil = rvInit(g); // v86: villagers back at home, the day starts again
    return g;
  }
  const rgIdx = (x, y) => y * RG_W + x;
  function rgSetT(g, i) { g.T[i] = rgTerrain().R[i] + g.S[i] + g.Lv[i]; }
  function rgMark(x0, y0, x1, y1) { const d = rg.terrainDirty; rg.terrainDirty = d ? [Math.min(d[0], x0), Math.min(d[1], y0), Math.max(d[2], x1), Math.max(d[3], y1)] : [x0, y0, x1, y1]; rg.dirty = true; }
  // rain now: the automatic mission rain on the northern ranges (or the free-play start), plus extra rain the player added
  function rgRainAt(g) {
    const zones = [];
    if (g.phase === "rain") {
      if (g.mode === "mission") zones.push({ band: 34, rate: RG.rainRate });
      else if (g.scenario.center) zones.push({ x: g.scenario.center[0], y: g.scenario.center[1], r: RG.freeR, rate: RG.rainRate * 3.2 });
    }
    if (g.phase === "rain" || g.phase === "after") for (const e of g.scenario.extras) if (g.rainT >= e.t && g.rainT < e.t + RG.extraDur) zones.push({ x: e.x, y: e.y, r: RG.extraR, rate: RG.extraRate });
    return zones;
  }
  function rgStep(g) { // one small step of the water model
    const W = RG_W, H = RG_H, T = g.T, h = g.h, fE = g.fE, fW = g.fW, fN = g.fN, fS = g.fS, K = RG.K, D = RG.damp;
    // springs at the valley heads keep the river flowing
    for (const s of [0, 1, 2]) { const [x, y] = RG_STREAMS[s].pts[0]; h[rgIdx(Math.round(x), y + 1)] += RG.spring; }
    for (const z of g.rain || []) {
      if (z.band) { for (let y = 0; y < z.band; y++) for (let x = 6; x < W - 6; x++) h[y * W + x] += z.rate; }
      else for (let y = Math.max(0, Math.floor(z.y - z.r)); y <= Math.min(H - 1, Math.ceil(z.y + z.r)); y++)
        for (let x = Math.max(0, Math.floor(z.x - z.r)); x <= Math.min(W - 1, Math.ceil(z.x + z.r)); x++) if (Math.hypot(x + 0.5 - z.x, y + 0.5 - z.y) <= z.r) h[y * W + x] += z.rate;
    }
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x, hi = h[i], Hi = T[i] + hi;
        let e = 0, w = 0, nn = 0, so = 0;
        if (hi > 0) {
          const Ka = K * (hi < 0.05 ? 0.05 : hi > 2 ? 2 : hi); // deeper water carries more (its cross-section)
          if (x < W - 1) { e = fE[i] * D + Ka * (Hi - T[i + 1] - h[i + 1]); if (e < 0) e = 0; }
          if (x > 0) { w = fW[i] * D + Ka * (Hi - T[i - 1] - h[i - 1]); if (w < 0) w = 0; }
          if (y > 0) { nn = fN[i] * D + Ka * (Hi - T[i - W] - h[i - W]); if (nn < 0) nn = 0; }
          so = y < H - 1 ? fS[i] * D + Ka * (Hi - T[i + W] - h[i + W]) : fS[i] * D + Ka * (hi + 0.3); // the south edge lets water leave
          if (so < 0) so = 0;
          const tot = e + w + nn + so;
          if (tot > hi) { const k = hi / tot; e *= k; w *= k; nn *= k; so *= k; }
        }
        fE[i] = e; fW[i] = w; fN[i] = nn; fS[i] = so;
      }
    }
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        const i = row + x;
        let v = h[i] - fE[i] - fW[i] - fN[i] - fS[i];
        if (x > 0) v += fE[i - 1];
        if (x < W - 1) v += fW[i + 1];
        if (y > 0) v += fS[i - W];
        if (y < H - 1) v += fN[i + W];
        v -= RG.loss; h[i] = v > 0 ? v : 0;
      }
    }
    // levees wear where water flows over them (the rule per material)
    if (g.leveeCells && g.leveeCells.size) for (const i of g.leveeCells) {
      const m = RG_MAT[g.M[i]]; if (!m || !m.wear || h[i] < 0.03) continue;
      const flow = fE[i] + fW[i] + fN[i] + fS[i], wear = (m.wear / RG.sub) * Math.min(1.5, h[i] * 3 + flow * 6);
      const take = Math.min(g.Lv[i], wear); if (take <= 0) continue;
      g.Lv[i] -= take; rgSetT(g, i);
      if (g.Lv[i] < 0.02) { g.Lv[i] = 0; g.M[i] = 0; g.leveeCells.delete(i); rgSetT(g, i); }
      rgMark(i % W, (i / W) | 0, i % W, (i / W) | 0);
    }
    g.steps++;
  }
  function rgHouses(g) { // a house is lost when water stays deep enough around it, or when its foundation is dug away
    const L = rgTerrain();
    for (const hs of g.houses) {
      if (hs.lost) continue;
      let depth = 0, dug = 0;
      for (const i of hs.cells) { depth += g.h[i]; dug += L.S0[i] - g.S[i]; }
      depth /= hs.cells.length; dug /= hs.cells.length;
      if (dug > RG.collapse) { hs.lost = "collapsed"; hs.at = g.rainT; hs.fall = performance.now(); rgEvent(g, hs); continue; }
      if (g.phase === "prep") continue;
      if (depth > RG.reach && g.firstReach == null) g.firstReach = g.rainT;
      hs.wet = depth > RG.flood ? hs.wet + 1 / RG.sub : Math.max(0, hs.wet - 0.5 / RG.sub);
      if (hs.wet >= RG.hold) { hs.lost = "flooded"; hs.at = g.rainT; rgEvent(g, hs); }
    }
  }
  function rgEvent(g, hs) { rg.dirty = true; if (hs.lost === "collapsed") rgHint(() => t("A house collapsed: its foundation was dug away.")); else rgHint(() => t("Water flooded a house.")); rgHud(); }
  function rgTick(g, dt) { // advance game time (seconds) through the phases
    if (!g.running || g.phase === "done" || !g.ready) return;
    g.time += dt;
    if (g.phase === "prep") { if (g.time >= RG.prep) rgStartRain(g); }
    else {
      g.rainT += dt;
      if (g.phase === "rain" && g.rainT >= RG.rain) { g.phase = "after"; rgHint(() => t("The rain has stopped. The water from the mountains is still on its way.")); }
      else if (g.phase === "after" && g.rainT >= RG.rain + RG.after) return rgEnd(g);
    }
    for (const e of g.scenario.extras) if (!e.played && g.rainT >= e.t && g.phase !== "prep") { e.played = true; rg.drops.push({ x: e.x, y: e.y, t0: performance.now(), r: RG.extraR }); }
    g.rain = rgRainAt(g);
    rg.acc += dt * RG.sub;
    while (rg.acc >= 1) { rg.acc -= 1; rgStep(g); if (g.steps % 4 === 0) rgHouses(g); }
  }
  function rgStartRain(g) { g.phase = "rain"; g.rainT = 0; rgHint(() => (g.mode === "mission" ? t("Rain is falling on the northern mountains.") : t("Rain is falling where you chose."))); rgHud(); }
  function rgEnd(g) {
    g.phase = "done"; g.running = false;
    const saved = g.houses.filter((hs) => !hs.lost).length, total = g.houses.length;
    g.result = { saved, total, win: saved >= RG.goal, firstReach: g.firstReach, collapsed: g.houses.filter((hs) => hs.lost === "collapsed").length };
    rgShowEnd(); rgHud();
  }
  // Turkish needs the locative suffix of the spoken number ("00:42'de", "00:30'da", "00:40'ta"); other languages use the time as it is
  function rgAt(clock) {
    if (I.lang !== "tr") return clock;
    const [m, s] = clock.split(":").map(Number), n = s || m, u = n % 10;
    const suf = u ? ["", "de", "de", "te", "te", "te", "da", "de", "de", "da"][u] : ({ 0: "da", 10: "da", 20: "de", 30: "da", 40: "ta", 50: "de" }[n] || "da");
    return `${clock}'${suf}`;
  }
  const rgClock = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  // ---- tools -----------------------------------------------------------------------------------------------------
  function rgDig(g, cx, cy, r) { // dig soil (and levee material) down to the bedrock, never into it
    const L = rgTerrain(); let any = false;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(RG_H - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(RG_W - 1, Math.ceil(cx + r)); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); if (d > r) continue;
        const i = y * RG_W + x; let take = RG.digStep * (1 - 0.6 * (d / r));
        if (g.Lv[i] > 0) { const a = Math.min(g.Lv[i], take); g.Lv[i] -= a; take -= a; if (g.Lv[i] <= 0.01) { g.Lv[i] = 0; g.M[i] = 0; g.leveeCells && g.leveeCells.delete(i); } }
        if (take > 0 && g.S[i] > 0) { const a = Math.min(g.S[i], take); g.S[i] -= a; any = true; }
        if (g.crop[i] && L.S0[i] - g.S[i] > 0.12) g.crop[i] = 0;
        rgSetT(g, i);
      }
    rgMark(Math.floor(cx - r) - 1, Math.floor(cy - r) - 1, Math.ceil(cx + r) + 1, Math.ceil(cy + r) + 1);
    rgHouses(g);
    if (any) rvDigEvent(g, cx, cy); // v86: a villager comes to show the work (the digging itself is already done)
    return any;
  }
  const rgFallen = (g) => g.houses.filter((hs) => hs.lost === "collapsed").length;
  function rgDigHint(g, dug, fell0) { // a collapse message stays; otherwise say whether the ground gave way or the bedrock stopped the digging
    if (rgFallen(g) > fell0) return rgHint(() => t("A house collapsed: its foundation was dug away."));
    rgHint(dug ? () => t("Dug. The water will use the new low ground.") : () => t("Bedrock: it cannot be dug here."));
  }
  function rgLeveeCells(g, pts) { // cells along the drawn line, and how much material each needs to reach the crest
    const L = rgTerrain(), cells = new Map();
    for (let k = 0; k < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[Math.min(k + 1, pts.length - 1)], len = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
      for (let s = 0; s <= len; s++) {
        const px = ax + ((bx - ax) * s) / len, py = ay + ((by - ay) * s) / len;
        for (let y = Math.floor(py - 0.9); y <= Math.ceil(py + 0.9); y++) for (let x = Math.floor(px - 0.9); x <= Math.ceil(px + 0.9); x++) {
          if (x < 0 || y < 0 || x >= RG_W || y >= RG_H || Math.hypot(x + 0.5 - px, y + 0.5 - py) > 0.95) continue;
          const i = y * RG_W + x; if (cells.has(i)) continue;
          const crest = L.R[i] + g.S[i] + RG.leveeH, add = Math.max(0, crest - g.T[i]);
          if (add > 0.02) cells.set(i, add);
        }
      }
    }
    return cells;
  }
  function rgPlaceLevee(g, pts, mat) {
    const cells = rgLeveeCells(g, pts), m = RG_MAT[mat];
    let cost = 0; const take = [];
    for (const [i, add] of cells) { const c = (add / RG.leveeH) * m.cost; if (cost + c > g.budget + 1e-6) break; cost += c; take.push([i, add]); }
    if (!take.length) { rgHint(() => t("Not enough budget for this levee.")); return 0; }
    g.budget -= cost;
    if (take.length < cells.size) rgHint(() => t("The budget ran out: only part of the levee was built."));
    const now = performance.now(), still = reducedMotion.matches;
    g.leveeCells = g.leveeCells || new Set();
    const job = { cells: take, mat, t0: now, dur: still ? 0 : 520, base: take.map(([i]) => g.Lv[i]) };
    for (const [i] of take) { g.M[i] = mat; g.leveeCells.add(i); }
    g.pending.push(job);
    if (!still) for (let k = 0; k < take.length; k += 2) { const i = take[k][0]; rg.parts.push({ x: (i % RG_W) + 0.5 + (Math.random() - 0.5) * 0.6, y: ((i / RG_W) | 0) + 0.5, t0: now + Math.random() * 160, mat, deco: true }); }
    rgPending(g, now);
    return take.length;
  }
  function rgPending(g, now) { // levee material falls and builds up
    g.pending = g.pending.filter((job) => {
      const k = job.dur ? Math.min(1, (now - job.t0) / job.dur) : 1, e = k * k;
      job.cells.forEach(([i, add], j) => { g.Lv[i] = job.base[j] + add * e; rgSetT(g, i); });
      const xs = job.cells.map(([i]) => i % RG_W), ys = job.cells.map(([i]) => (i / RG_W) | 0);
      rgMark(Math.min(...xs) - 1, Math.min(...ys) - 1, Math.max(...xs) + 1, Math.max(...ys) + 1);
      return k < 1;
    });
  }
  function rgAddRain(g, x, y) {
    if (g.mode === "free" && g.phase === "prep") { // free play: choose where the starting rain falls
      g.scenario.center = [x, y]; g.ready = true;
      rgHint(() => t("The rain will start here. Prepare, then wait or start the rain.")); rgHud(); rg.dirty = true; return;
    }
    if (g.phase === "prep") { rgHint(() => t("Extra rain can be added once the rain has started.")); return; }
    if (g.phase === "done") return;
    const e = { t: Math.round(g.rainT * 10) / 10, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, played: true };
    g.scenario.extras.push(e);
    rg.drops.push({ x: e.x, y: e.y, t0: performance.now(), r: RG.extraR });
    rgHint(() => t("Extra rain for {s} s at the chosen place.", { s: RG.extraDur }));
  }
  // ---- pouring levee material (v85) ------------------------------------------------------------------------------------
  // While the Levee tool is pressed, material falls on the marked spot; each grain lands after a short fall, adds height there,
  // costs budget, and slides to the neighbours when the step gets steeper than the material allows (so holding builds a mound,
  // dragging a line). The water model uses the new height at its next step.
  function rgDeposit(g, x, y, q, mat) {
    const cx = Math.floor(x), cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= RG_W || cy >= RG_H) return true;
    const m = RG_MAT[mat], cost = (q / RG.leveeH) * m.cost;
    if (g.budget < cost) return false;
    g.budget -= cost;
    g.leveeCells = g.leveeCells || new Set();
    const add = (i, v) => { g.Lv[i] += v; if (!g.M[i]) g.M[i] = mat; g.leveeCells.add(i); rgSetT(g, i); };
    const i0 = cy * RG_W + cx; g.M[i0] = mat; add(i0, q);
    const queue = [i0]; let n = 0, x0 = cx, y0 = cy, x1 = cx, y1 = cy;
    while (queue.length && n++ < 60) { // material slides down while the step is steeper than it keeps
      const i = queue.shift(), ix = i % RG_W, iy = (i / RG_W) | 0, rep = RG_MAT[g.M[i] || mat].rep;
      for (const j of [ix > 0 ? i - 1 : -1, ix < RG_W - 1 ? i + 1 : -1, iy > 0 ? i - RG_W : -1, iy < RG_H - 1 ? i + RG_W : -1]) {
        if (j < 0 || g.Lv[i] <= 0) continue;
        const diff = g.T[i] - g.T[j] - rep;
        if (diff > 0.01) { const mv = Math.min(g.Lv[i], diff / 2); g.Lv[i] -= mv; rgSetT(g, i); add(j, mv); queue.push(j);
          x0 = Math.min(x0, j % RG_W); x1 = Math.max(x1, j % RG_W); y0 = Math.min(y0, (j / RG_W) | 0); y1 = Math.max(y1, (j / RG_W) | 0); }
      }
    }
    rgMark(x0 - 1, y0 - 1, x1 + 1, y1 + 1);
    return true;
  }
  function rgPourStep(g, now, dt) { // the pour that is held now (pointer or keyboard), and the grains still in the air
    const P = rg.pour, still = reducedMotion.matches;
    if (P && P.until && now > P.until) rg.pour = null;
    if (rg.pour && g.phase !== "done") {
      rvPourEvent(g, P.x, P.y, P.mat, false);
      P.acc = (P.acc || 0) + dt * RG.pourPer;
      while (P.acc >= 1) {
        P.acc -= 1;
        const gx = P.x + (Math.random() - 0.5) * 0.7, gy = P.y + (Math.random() - 0.5) * 0.7, q = RG.pour / RG.pourPer;
        if (still) { if (!rgDeposit(g, gx, gy, q, P.mat)) { rgPourEmpty(); break; } }
        else rg.parts.push({ x: gx, y: gy, t0: now, q, mat: P.mat });
      }
    }
    rg.parts = rg.parts.filter((p) => {
      if (p.deco) return now - p.t0 < RG.fall;
      if (now - p.t0 < RG.fall) return true;
      if (!rgDeposit(g, p.x, p.y, p.q, p.mat)) { rgPourEmpty(); return false; }
      return false;
    });
  }
  function rgPourEmpty() { rg.pour = null; rg.parts = []; rgHint(() => t("The budget ran out: pouring stopped.")); rgHud(); }
  // ---- drawing: the tilted view ------------------------------------------------------------------------------------------
  let rgBase = null;
  const rgPY = (y, z) => RG_OFF + y * RG_RY - z * RG_HZ; // screen y of row y at height z
  function rgCorner(T, x, y) { // height of the corner (x, y) shared by up to four cells
    const xa = Math.max(0, x - 1), xb = Math.min(RG_W - 1, x), ya = Math.max(0, y - 1), yb = Math.min(RG_H - 1, y);
    return (T[ya * RG_W + xa] + T[ya * RG_W + xb] + T[yb * RG_W + xa] + T[yb * RG_W + xb]) / 4;
  }
  function rgHeight(T, fx, fy) { // the drawn ground height at a point (bilinear between the corners)
    const x = Math.max(0, Math.min(RG_W - 1e-6, fx)), y = Math.max(0, Math.min(RG_H - 1e-6, fy)), ix = Math.floor(x), iy = Math.floor(y), u = x - ix, v = y - iy;
    const a = rgCorner(T, ix, iy), b = rgCorner(T, ix + 1, iy), c = rgCorner(T, ix, iy + 1), d = rgCorner(T, ix + 1, iy + 1);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }
  const rgProj = (T, fx, fy, lift) => [fx * RG_PX, rgPY(fy, rgHeight(T, fx, fy) + (lift || 0))];
  // the ground point under a screen point: the front-most row whose drawn surface covers it (the same surface as drawn)
  function rgPick(T, sx, sy) {
    const fx = sx / RG_PX; if (fx < 0 || fx >= RG_W) return null;
    const ix = Math.floor(fx), u = fx - ix;
    for (let y = RG_H - 1; y >= 0; y--) {
      const ht = rgCorner(T, ix, y) * (1 - u) + rgCorner(T, ix + 1, y) * u, hb = rgCorner(T, ix, y + 1) * (1 - u) + rgCorner(T, ix + 1, y + 1) * u;
      const yt = rgPY(y, ht), yb = rgPY(y + 1, hb);
      if (yb > yt && sy >= yt && sy < yb) return [fx, y + (sy - yt) / (yb - yt)];
    }
    return null;
  }
  function rgColor(g, i, out) { // land colour of one cell
    const L = rgTerrain(), T = g.T;
    let c;
    if (g.Lv[i] > 0.05 && g.M[i]) c = RG_MAT[g.M[i]].rgb;
    else {
      const dug = L.S0[i] - g.S[i], k = L.kind[i], tr = L.tree[i];
      if (g.S[i] < 0.08 || (k === 1 && dug < 0.1)) { const e = Math.min(1, Math.max(0, (T[i] - 10) / 30)); c = [128 + 50 * e, 124 + 48 * e, 116 + 46 * e]; } // rock, paler on the summits
      else if (dug > 0.12) c = [Math.max(90, 150 - dug * 18), Math.max(60, 104 - dug * 14), Math.max(36, 64 - dug * 9)]; // dug soil
      else if (k === 5) c = g.crop[i] ? [198, 190, 88] : [150, 112, 70];                 // field / lost crop
      else if (k === 2) { const e = Math.min(1, (T[i] - 14) / 20); c = [104 + 46 * e, 114 + 32 * e, 80 + 44 * e]; } // high slopes
      else if (k === 3) c = [70, 118, 60];
      else if (k === 6) c = [122, 112, 92];
      else if (k === 9) c = [196, 176, 128];                                              // lane
      else { const e = L.tone[i]; c = [108 + 40 * e, 150 + 26 * e, 78 + 16 * e]; }       // grass (flowers and bare patches are drawn on it)
    }
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
  }
  function rgPaint(g, box) { // repaint the land in columns (all rows, back to front) so nearer ground always covers farther ground
    const L = rgTerrain(), T = g.T;
    if (!rgBase || rgBase.height !== RG_CH) { rgBase = document.createElement("canvas"); rgBase.width = RG_CW; rgBase.height = RG_CH; box = [0, 0, RG_W - 1, RG_H - 1]; }
    const full = box[0] <= 0 && box[2] >= RG_W - 1, xa = full ? 0 : Math.max(0, box[0] - 2), xb = full ? RG_W - 1 : Math.min(RG_W - 1, box[2] + 2);
    const b = rgBase.getContext("2d"), c = [0, 0, 0];
    b.save();
    if (!full) { b.beginPath(); b.rect(Math.max(0, box[0] - 1) * RG_PX, 0, (Math.min(RG_W, box[2] + 2) - Math.max(0, box[0] - 1)) * RG_PX, RG_CH); b.clip(); }
    const sky = b.createLinearGradient(0, 0, 0, RG_CH); sky.addColorStop(0, "#1b2a44"); sky.addColorStop(1, "#0b1020");
    b.fillStyle = sky; b.fillRect(xa * RG_PX, 0, (xb - xa + 1) * RG_PX, RG_CH);
    for (let y = 0; y < RG_H; y++) {
      for (let x = xa; x <= xb; x++) rgQuad(b, g, x, y, c);
      for (let x = xa; x <= xb; x++) rgDecor(b, g, L, x, y);
    }
    // the front edge of the land: a cut through soil and rock
    for (let x = xa; x <= xb; x++) {
      const i = (RG_H - 1) * RG_W + x, top = rgPY(RG_H, rgCorner(T, x, RG_H)), rock = rgPY(RG_H, L.R[i]);
      b.fillStyle = "#6b4f34"; b.fillRect(x * RG_PX - 0.3, top, RG_PX + 0.6, Math.max(0, rock - top));
      b.fillStyle = "#5c5a55"; b.fillRect(x * RG_PX - 0.3, Math.max(top, rock), RG_PX + 0.6, RG_CH - Math.max(top, rock));
    }
    b.restore();
  }
  function rgQuad(b, g, x, y, c) { // one cell's ground, from its four corner heights, shaded by the slope (light from the north-west, above)
    const T = g.T, i = y * RG_W + x, a = rgCorner(T, x, y), bb = rgCorner(T, x + 1, y), cc = rgCorner(T, x + 1, y + 1), d = rgCorner(T, x, y + 1);
    const dzx = ((bb + cc) - (a + d)) * 0.35, dzy = ((d + cc) - (a + bb)) * 0.35, nl = Math.hypot(dzx, dzy, 1);
    const sh = Math.max(0.42, Math.min(1.38, 0.5 + 0.95 * ((dzx * 0.55 + dzy * 0.62 + 0.56) / nl)));
    rgColor(g, i, c);
    b.fillStyle = `rgb(${Math.min(255, c[0] * sh) | 0},${Math.min(255, c[1] * sh) | 0},${Math.min(255, c[2] * sh) | 0})`;
    const X0 = x * RG_PX - 0.35, X1 = (x + 1) * RG_PX + 0.35;
    b.beginPath(); b.moveTo(X0, rgPY(y, a) - 0.3); b.lineTo(X1, rgPY(y, bb) - 0.3); b.lineTo(X1, rgPY(y + 1, cc) + 0.5); b.lineTo(X0, rgPY(y + 1, d) + 0.5); b.fill();
    if (g.Lv[i] > 0.3 && g.M[i]) { b.strokeStyle = "rgba(30,20,10,.55)"; b.lineWidth = 0.9; b.beginPath(); b.moveTo(X0, rgPY(y + 1, d) + 0.3); b.lineTo(X1, rgPY(y + 1, cc) + 0.3); b.stroke(); } // a levee's front edge
  }
  // dry ground standing in front of water (levees, banks) is drawn again over the water, back to front, so the view stays right
  function rgOverWater(c, g) {
    const L = rgTerrain(), h = g.h, col = [0, 0, 0];
    for (let y = 1; y < RG_H; y++) for (let x = 0; x < RG_W; x++) {
      const i = y * RG_W + x;
      if (h[i] >= 0.04) continue;
      const wetBehind = h[i - RG_W] >= 0.04 || (y > 1 && h[i - 2 * RG_W] >= 0.04 && g.Lv[i] > 0.3);
      if (!wetBehind || (g.Lv[i] <= 0.3 && g.T[i] < g.T[i - RG_W] + h[i - RG_W] - 0.05 && g.T[i] < g.T[i - RG_W] + 0.3)) continue;
      rgQuad(c, g, x, y, col); rgDecor(c, g, L, x, y);
    }
  }
  function rgDecor(b, g, L, x, y) { // trees, flowers, crops, stones and levee texture, standing on the ground
    const i = y * RG_W + x, k = L.kind[i], tr = L.tree[i], T = g.T;
    const cx = (x + 0.5) * RG_PX, gy = rgPY(y + 0.5, rgHeight(T, x + 0.5, y + 0.5));
    if (g.Lv[i] > 0.05 && g.M[i]) {
      if (g.M[i] === 3) { b.fillStyle = "rgba(70,68,62,.6)"; b.fillRect(cx - 2, gy - 1.5, 2, 1.6); b.fillRect(cx + 0.8, gy, 2, 1.6); }
      else if (g.M[i] === 4) { b.strokeStyle = "rgba(120,124,130,.75)"; b.lineWidth = 0.7; b.strokeRect(cx - 2.6, gy - 1.8, 5.2, 3.4); }
      else if (g.M[i] === 1) { b.fillStyle = "rgba(255,240,200,.45)"; b.fillRect(cx - 1 + tr * 2, gy - 1, 1, 1); }
      return;
    }
    const dug = L.S0[i] - g.S[i];
    if (dug > 0.12 || g.S[i] < 0.08) { if (k === 1 && tr > 0.55) { b.fillStyle = "#d9d6cf"; b.beginPath(); b.moveTo(cx - 2, gy + 1); b.lineTo(cx, gy - 2.4); b.lineTo(cx + 2, gy + 1); b.fill(); } return; }
    if (k === 3 && tr > 0.22) { // a small tree: shadow, trunk, round or pointed crown with a lit side
      const r = 1.9 + tr * 1.7, hgt = 3 + tr * 2.5, conifer = tr > 0.72;
      b.fillStyle = "rgba(10,25,8,.35)"; b.beginPath(); b.ellipse(cx + 1.6, gy + 0.6, r, r * 0.45, 0, 0, 7); b.fill();
      b.fillStyle = "#4a3422"; b.fillRect(cx - 0.4, gy - hgt * 0.45, 0.9, hgt * 0.45);
      if (conifer) { b.fillStyle = "#2d6a3c"; b.beginPath(); b.moveTo(cx - r * 0.85, gy - hgt * 0.35); b.lineTo(cx, gy - hgt - r * 0.8); b.lineTo(cx + r * 0.85, gy - hgt * 0.35); b.fill(); b.fillStyle = "rgba(140,200,120,.35)"; b.beginPath(); b.moveTo(cx - r * 0.6, gy - hgt * 0.45); b.lineTo(cx, gy - hgt - r * 0.6); b.lineTo(cx - r * 0.1, gy - hgt * 0.45); b.fill(); }
      else { b.fillStyle = tr > 0.5 ? "#3c7d36" : "#4b8f3b"; b.beginPath(); b.arc(cx, gy - hgt, r, 0, 7); b.fill(); b.fillStyle = "rgba(170,220,120,.45)"; b.beginPath(); b.arc(cx - r * 0.35, gy - hgt - r * 0.35, r * 0.45, 0, 7); b.fill(); }
    } else if (k === 8) { // a natural bare patch: a soft, irregular blob of soil
      b.fillStyle = "rgba(150,118,80,.75)"; b.beginPath(); b.ellipse(cx + (tr - 0.5) * 2, gy, 2.6 + tr * 1.6, 1.6 + tr, tr * 2, 0, 7); b.fill();
      b.fillStyle = "rgba(120,92,60,.5)"; b.beginPath(); b.ellipse(cx + 1, gy + 0.4, 1.2, 0.7, 0, 0, 7); b.fill();
    } else if (k === 7) { // a small clump of flowers
      const cols = ["#fff6d8", "#ffd84a", "#f49ac1", "#c8a6ff"];
      for (let j = 0; j < 3; j++) { b.fillStyle = cols[(j + Math.floor(tr * 4)) % 4]; b.fillRect(cx - 2 + j * 1.6 + tr, gy - 1 + ((j * 7) % 3) * 0.7, 1.1, 1.1); }
    } else if (k === 5 && g.crop[i]) { // crop rows
      b.strokeStyle = "rgba(118,128,44,.8)"; b.lineWidth = 0.9; b.beginPath();
      b.moveTo(x * RG_PX, gy - 1); b.lineTo((x + 1) * RG_PX, gy - 1); b.moveTo(x * RG_PX, gy + 1.2); b.lineTo((x + 1) * RG_PX, gy + 1.2); b.stroke();
    } else if (k === 2 && tr > 0.68) { b.fillStyle = "#4f6b3c"; b.beginPath(); b.arc(cx, gy - 1, 1.6, 0, 7); b.fill(); }
    else if (k === 1 && tr > 0.6) { b.fillStyle = "rgba(80,78,72,.7)"; b.fillRect(cx - 1, gy - 1, 2.2, 1.4); }
  }
  const RG_WATER = Array.from({ length: 10 }, (_, k) => { const e = k / 9; return `rgba(${Math.round(80 - 62 * e)},${Math.round(170 - 88 * e)},${Math.round(255 - 52 * e)},${(0.6 + 0.38 * Math.min(1, e * 1.6)).toFixed(2)})`; });
  function rgDrawWater(c, g) { // water drawn on its own surface height, grouped by depth (one fill per shade)
    const T = g.T, h = g.h, paths = RG_WATER.map(() => new Path2D());
    for (let y = 0; y < RG_H; y++) for (let x = 0; x < RG_W; x++) {
      const i = y * RG_W + x, v = h[i]; if (v < 0.04) continue;
      const W = T[i] + v, s = y < RG_H - 1 ? (h[i + RG_W] > 0.04 ? T[i + RG_W] + h[i + RG_W] : W) : W;
      const y0 = rgPY(y, W), y1 = Math.max(y0 + RG_RY, rgPY(y + 1, Math.min(W, s)));
      paths[Math.min(9, Math.floor(v / 0.16))].rect(x * RG_PX - 0.2, y0, RG_PX + 0.4, y1 - y0);
    }
    paths.forEach((p, k) => { c.fillStyle = RG_WATER[k]; c.fill(p); });
  }
  const RG_ROOF = ["#b5523b", "#9c3f2e", "#c46a3a", "#7d5a4a", "#6c7488", "#a8483a"];
  function rgHouse(c, g, hs, now) { // a small house: shadow, front wall with door and window, roof; flooded or fallen states
    const T = g.T, z = hs.cells.reduce((a, i) => a + T[i], 0) / hs.cells.length, x0 = (hs.cx - 1.5) * RG_PX, x1 = (hs.cx + 1.5) * RG_PX;
    const yb = rgPY(hs.cy + 1.5, z), yt = rgPY(hs.cy - 1.5, z), wall = 7, roofUp = 5, ew = hs.look % 3 !== 1;
    if (hs.lost === "collapsed") {
      const k = Math.min(1, (now - hs.fall) / 650);
      if (k < 1) { c.save(); c.translate((x0 + x1) / 2, yb); c.rotate(0.3 * k); c.scale(1 - 0.3 * k, 1 - 0.7 * k); c.fillStyle = "#e6d9bf"; c.fillRect(-9, -wall, 18, wall); c.fillStyle = RG_ROOF[hs.look % 6]; c.fillRect(-10, -wall - 6, 20, 6); c.restore(); rg.dirty = true; return; }
      c.fillStyle = "rgba(0,0,0,.3)"; c.beginPath(); c.ellipse((x0 + x1) / 2 + 2, yb, 11, 3.5, 0, 0, 7); c.fill();
      const cols = ["#8d7a66", "#6b5a4a", RG_ROOF[hs.look % 6], "#bfb29a"];
      for (let j = 0; j < 9; j++) { c.fillStyle = cols[j % 4]; c.beginPath(); const px = x0 + 2 + ((j * 7) % 15), py = yb - 1 - ((j * 3) % 5); c.moveTo(px, py); c.lineTo(px + 3, py - 2.5); c.lineTo(px + 4.5, py + 0.5); c.fill(); }
      return;
    }
    c.fillStyle = "rgba(0,0,0,.28)"; c.beginPath(); c.moveTo(x1, yb); c.lineTo(x1 + 5, yb + 1.5); c.lineTo(x1 + 5, yt + 1.5 - wall); c.lineTo(x1, yt - wall); c.fill(); // short shadow to the south-east
    c.fillStyle = "rgba(0,0,0,.22)"; c.fillRect(x0 + 2, yb, x1 - x0, 2);
    const wallC = ["#efe4cc", "#e6d6b8", "#f2ead8"][hs.look % 3];
    c.fillStyle = wallC; c.fillRect(x0, yb - wall, x1 - x0, wall);
    c.fillStyle = "#5a3b28"; c.fillRect(x0 + (hs.look % 2 ? 4 : 11), yb - 5, 3, 5);        // door
    c.fillStyle = "#7fb3d9"; c.fillRect(x0 + (hs.look % 2 ? 11 : 4), yb - 5.5, 3, 2.5);    // window
    const roof = RG_ROOF[hs.look % 6], top = yt - wall, front = yb - wall;
    if (ew) { // ridge east–west: the front slope faces us, the back slope shows as a strip
      const ridge = (top + front) / 2 - roofUp;
      c.fillStyle = roof; c.beginPath(); c.moveTo(x0 - 1.5, front + 1); c.lineTo(x1 + 1.5, front + 1); c.lineTo(x1, ridge); c.lineTo(x0, ridge); c.fill();
      c.fillStyle = "rgba(0,0,0,.25)"; c.beginPath(); c.moveTo(x0, ridge); c.lineTo(x1, ridge); c.lineTo(x1 - 1, top); c.lineTo(x0 + 1, top); c.fill();
      c.strokeStyle = "rgba(40,20,10,.55)"; c.lineWidth = 0.8; c.beginPath(); c.moveTo(x0, ridge); c.lineTo(x1, ridge); c.stroke();
    } else { // ridge north–south: a lit west slope and a shaded east slope
      const mid = (x0 + x1) / 2, rt = top - roofUp, rb = front - roofUp + 2;
      c.fillStyle = roof; c.beginPath(); c.moveTo(x0 - 1.5, front + 1); c.lineTo(x0 - 1, top); c.lineTo(mid, rt); c.lineTo(mid, rb); c.fill();
      c.fillStyle = "rgba(0,0,0,.25)"; c.beginPath(); c.moveTo(x1 + 1.5, front + 1); c.lineTo(x1 + 1, top); c.lineTo(mid, rt); c.lineTo(mid, rb); c.fill();
      c.fillStyle = roof; c.globalAlpha = 0.75; c.fill(); c.globalAlpha = 1;
      c.strokeStyle = "rgba(40,20,10,.55)"; c.lineWidth = 0.8; c.beginPath(); c.moveTo(mid, rt); c.lineTo(mid, rb); c.stroke();
    }
    if (hs.lost === "flooded") { // water up the walls, a blue ring
      c.fillStyle = "rgba(40,120,230,.78)"; c.fillRect(x0 - 2, yb - 4.5, x1 - x0 + 4, 6);
      c.strokeStyle = "#5fb0ff"; c.lineWidth = 2; c.strokeRect(x0 - 3, top - roofUp - 2, x1 - x0 + 6, yb - top + roofUp + 5);
    } else if (hs.wet > 0) { c.strokeStyle = "#ffd23f"; c.lineWidth = 2; c.strokeRect(x0 - 3, top - roofUp - 2, x1 - x0 + 6, yb - top + roofUp + 5); }
    else if (g.phase === "done") { c.strokeStyle = "#5fd36a"; c.lineWidth = 2; c.strokeRect(x0 - 3, top - roofUp - 2, x1 - x0 + 6, yb - top + roofUp + 5); }
  }
  function rgEllipse(c, T, fx, fy, r, col, dash) { // a ring lying on the ground (round on the ground, flattened by the view)
    const [px, py] = rgProj(T, fx, fy);
    c.setLineDash(dash || []);
    c.lineWidth = 3 / rg.view.s; c.strokeStyle = "rgba(0,0,0,.55)"; c.beginPath(); c.ellipse(px, py, r * RG_PX, r * RG_RY, 0, 0, 7); c.stroke();
    c.lineWidth = 1.6 / rg.view.s; c.strokeStyle = col; c.stroke();
    c.setLineDash([]);
  }
  function rgRender(now) {
    const box = $("story"), cv = box.querySelector(".rg-map"); if (!cv || !rg.g) return;
    const g = rg.g, c = cv.getContext("2d"), v = rg.view, still = reducedMotion.matches, T = g.T;
    if (rg.terrainDirty) { rgPaint(g, rg.terrainDirty); rg.terrainDirty = null; }
    c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = "#0b1020"; c.fillRect(0, 0, cv.width, cv.height);
    c.setTransform(v.s, 0, 0, v.s, -v.x * v.s, -v.y * v.s);
    c.drawImage(rgBase, 0, 0);
    rgDrawWater(c, g);
    rgOverWater(c, g);
    if (!still) { // flow streaks on the water show the way it goes
      if (rg.streaks.length < 260) for (let k = 0; k < 6; k++) { const i = (Math.random() * g.h.length) | 0; if (g.h[i] > 0.12) rg.streaks.push({ x: (i % RG_W) + Math.random(), y: ((i / RG_W) | 0) + Math.random(), life: 0 }); }
      c.strokeStyle = "rgba(230,244,255,.6)"; c.lineWidth = 1; c.beginPath();
      rg.streaks = rg.streaks.filter((p) => {
        const i = Math.floor(p.y) * RG_W + Math.floor(p.x); if (i < 0 || i >= g.h.length || g.h[i] < 0.05 || ++p.life > 90) return false;
        const hh = Math.max(0.15, g.h[i]), vx = (g.fE[i] - g.fW[i]) / hh, vy = (g.fS[i] - g.fN[i]) / hh, sp = Math.hypot(vx, vy);
        if (sp < 0.002) return p.life < 40;
        const k = Math.min(0.5, sp * 6) / sp, nx = p.x + vx * k, ny = p.y + vy * k, W = T[i] + g.h[i];
        c.moveTo(p.x * RG_PX, rgPY(p.y, W)); c.lineTo(nx * RG_PX, rgPY(ny, W)); p.x = nx; p.y = ny;
        return nx > 0 && ny > 0 && nx < RG_W && ny < RG_H;
      });
      c.stroke();
    }
    if (rg.vil && rg.vil.raft) rvDrawRaft(c, g, rg.vil.raft);
    // houses and villagers together, back to front, so a figure walks behind or in front of a house
    const items = g.houses.map((hs) => [hs.cy + 1.5, 0, hs]).concat(rg.vil ? rg.vil.list.filter((v) => !v.inside).map((v) => [v.y, 1, v]) : []);
    items.sort((a, b) => a[0] - b[0]);
    for (const [, k, o] of items) { if (k) rvDraw(c, g, o, now); else rgHouse(c, g, o, now); }
    if (rg.vil) { rvDrawParts(c, g); rvBubbles(c, g, v); }
    const zones = (g.phase === "rain" || g.phase === "after") ? rgRainAt(g) : [];
    if (zones.length && !still) { // rain falling onto the ground
      c.strokeStyle = "rgba(205,228,255,.55)"; c.lineWidth = 1.1; c.beginPath();
      for (const z of zones) for (let k = 0; k < (z.band ? 110 : 30); k++) {
        let x, y; if (z.band) { x = 6 + Math.random() * (RG_W - 12); y = Math.random() * z.band; } else { const a = Math.random() * 6.283, d = Math.sqrt(Math.random()) * z.r; x = z.x + Math.cos(a) * d; y = z.y + Math.sin(a) * d; }
        const [px, py] = rgProj(T, x, y, 6 + Math.random() * 10); c.moveTo(px, py); c.lineTo(px - 2.5, py + 8);
      }
      c.stroke();
    }
    if (g.mode === "free" && g.scenario.center) rgEllipse(c, T, g.scenario.center[0], g.scenario.center[1], RG.freeR, "rgba(160,205,255,.95)", [8, 6]);
    rg.drops = rg.drops.filter((d) => now - d.t0 < 900);
    for (const d of rg.drops) rgEllipse(c, T, d.x, d.y, d.r * (0.4 + 0.6 * (now - d.t0) / 900), "rgba(120,190,255,.8)");
    for (const p of rg.parts) { // levee material falling onto its spot
      const k = Math.min(1, (now - p.t0) / RG.fall), [px, py] = rgProj(T, p.x, p.y, (1 - k * k) * 14);
      c.fillStyle = `rgb(${RG_MAT[p.mat].rgb.join(",")})`; c.fillRect(px - 1.6, py - 1.6, 3.2, 3.2);
      c.fillStyle = "rgba(0,0,0,.25)"; c.fillRect(px - 1.6, py + 1.4, 3.2, 0.8);
    }
    const aim = rg.aim;
    if (aim) {
      const r = rg.tool === "dig" ? rg.brush : rg.tool === "rain" ? (g.mode === "free" && g.phase === "prep" ? RG.freeR : RG.extraR) : 0.6;
      rgEllipse(c, T, aim[0], aim[1], r, rg.tool === "dig" ? "#ffd23f" : rg.tool === "rain" ? "#9fd0ff" : rg.pour ? "#ffb347" : "#fff");
      if (rg.tool === "levee") { const [px, py] = rgProj(T, aim[0], aim[1]); c.fillStyle = "#fff"; c.fillRect(px - 0.8, py - 0.8, 1.6, 1.6); }
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
  }
  // ---- villagers and the chicken (v86) — drawing only: they never change the land, the water, the budget or the result ----
  // Each villager belongs to a house. Before the rain some walk to the fields (blue clothes, hoe) or to the trees near the
  // village (black and red, axe). When the player digs on land, one nearby villager comes with a small shovel, digs a few
  // times at the spot (along a long canal: at a few points of it) and goes home; when the player pours a levee, one comes with
  // a sack in the material's colour, puts it down, empties it and goes home. The tools themselves act at once; these figures
  // only show the work. Water close by: the work is dropped and the villager runs to dry, higher ground chosen from the water
  // and the land now. A lost house: whoever is inside comes out of the door; nobody goes back to it; the homeless gather on a
  // dry, high open place until the round ends. Now and then, where the current is strong, a chicken rides by on a plank.
  const RV_SKIN = ["#f1c8a0", "#d9a066", "#a8714a"], RV_HAIR = ["#3b2a20", "#7a4a2a", "#d8b46a", "#1e1e1e"];
  const RV_SACK = { 1: "#e8d9ae", 2: "#7a5230", 3: "#4a4a4a", 4: "#cfd2d6" }; // sand light beige, soil brown, stone dark grey, concrete light grey
  const RV_ROLES = ["field", "field", "field", "field", "tree", "tree", "tree", "home", "home", "home", "home", "home", "home", "home"];
  function rvDoor(hs) { const off = hs.look % 2 ? 4 : 11; return [((hs.cx - 1.5) * RG_PX + off + 1.5) / RG_PX, hs.cy + 1.65]; }
  function rvInit(g) {
    const r = fiRng(8601), L = rgTerrain(), fields = [], trees = [];
    for (let y = 60; y < 116; y++) for (let x = 60; x < 120; x++) {
      const i = y * RG_W + x;
      if (L.kind[i] === 5) fields.push([x + 0.5, y + 0.5]);
      else if (L.kind[i] === 3 && L.tree[i] > 0.3 && x > 72 && Math.hypot(x - 86, y - 95) < 30) trees.push([x + 0.5, y + 0.5]);
    }
    const list = RV_ROLES.map((role, k) => {
      const home = k % g.houses.length, [dx, dy] = rvDoor(g.houses[home]);
      return { id: k, home, role, x: dx, y: dy, inside: true, homeless: false, state: role === "home" ? "home" : "wait", wait: 0.6 + k * 0.8 + r() * 1.2,
        skin: RV_SKIN[(r() * 3) | 0], hair: RV_HAIR[(r() * 4) | 0], hat: r() < 0.55 ? (role === "field" ? "#e2c56a" : role === "tree" ? "#c8302e" : "#7a5a3a") : null,
        shirt: role === "field" ? ["#3d6fc4", "#5a8ed8", "#2f5596"][k % 3] : role === "tree" ? "#1f1f1f" : ["#8a6a3a", "#5b7a4a", "#9a4f3a", "#6a6a8a"][k % 4],
        pants: role === "field" ? "#24406e" : role === "tree" ? "#b02a28" : "#4a3a2a",
        speed: 1.4 + r() * 0.8, step: 5 + r() * 3, phase: r() * 6, face: 1, t: 0, job: null, then: null, target: null, chk: r() * 0.25 };
    });
    return { list, fields, trees, parts: [], raft: null, raftWait: 8 + r() * 6, meet: null, meetChk: 0 };
  }
  const rvCell = (x, y) => Math.max(0, Math.min(RG_H - 1, Math.floor(y))) * RG_W + Math.max(0, Math.min(RG_W - 1, Math.floor(x)));
  function rvWet(g, x, y, rad, lim, flood) { // water deeper than lim within rad cells (flood: only water outside the stream beds)
    const L = rgTerrain();
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const X = Math.floor(x) + dx, Y = Math.floor(y) + dy; if (X < 0 || Y < 0 || X >= RG_W || Y >= RG_H) continue;
      const i = Y * RG_W + X; if (flood && L.kind[i] === 6) continue; // the river in its bed is not a reason to run
      if (g.h[i] > (lim || 0.06)) return true;
    }
    return false;
  }
  function rvPathDry(g, ax, ay, bx, by) { const n = Math.ceil(Math.hypot(bx - ax, by - ay)); for (let k = 0; k <= n; k++) { const i = rvCell(ax + ((bx - ax) * k) / Math.max(1, n), ay + ((by - ay) * k) / Math.max(1, n)); if (g.h[i] > 0.25) return false; } return true; }
  function rvGo(v, x, y, then, run) { v.target = [x, y]; v.state = run ? "flee" : "walk"; v.then = then; }
  function rvOut(g, v) { if (v.inside) { v.inside = false; [v.x, v.y] = rvDoor(g.houses[v.home]); } }
  function rvHome(g, v) {
    if (v.homeless) return rvToMeet(g, v);
    const [dx, dy] = rvDoor(g.houses[v.home]);
    rvGo(v, dx, dy, () => { v.inside = true; v.state = "home"; });
  }
  function rvDaily(g, v) { // the day's work, round and round until something else happens
    const V = rg.vil;
    if (v.role === "field" && V.fields.length) { const [fx, fy] = V.fields[(Math.random() * V.fields.length) | 0]; rvGo(v, fx, fy, () => { v.state = "tend"; v.t = 3 + Math.random() * 3; v.then = () => rvDaily(g, v); }); }
    else if (v.role === "tree" && V.trees.length) { const [tx, ty] = V.trees[(Math.random() * V.trees.length) | 0]; rvGo(v, tx - 0.9, ty + 0.4, () => { v.state = "chop"; v.face = 1; v.t = 4 + Math.random() * 3; v.then = () => rvDaily(g, v); }); }
    else rvHome(g, v);
  }
  function rvMeetPoint(g) { // a dry, high, open place near the village for those without a home
    const V = rg.vil, L = rgTerrain();
    if (V.meet && !rvWet(g, V.meet[0], V.meet[1], 3, 0.02)) return V.meet;
    let best = null, bs = -1e9;
    for (let y = 60; y < 118; y += 2) for (let x = 70; x < 126; x += 2) {
      const i = y * RG_W + x, k = L.kind[i];
      if (!(k === 4 || k === 7 || k === 9) || g.Lv[i] > 0.05) continue;
      if (g.houses.some((hs) => Math.abs(hs.cx - x) < 4 && Math.abs(hs.cy - y) < 4)) continue;
      if (rvWet(g, x, y, 3, 0.02)) continue;
      const s = g.T[i] - 0.025 * Math.hypot(x - 86, y - 95);
      if (s > bs) { bs = s; best = [x + 0.5, y + 0.5]; }
    }
    return (V.meet = best);
  }
  function rvToMeet(g, v) {
    const m = rvMeetPoint(g); if (!m) return;
    const k = v.id, a = k * 2.4, rr = 0.9 + (k % 3) * 0.6;
    rvGo(v, m[0] + Math.cos(a) * rr, m[1] + Math.sin(a) * rr * 0.7, () => { v.state = "meet"; }, rvWet(g, v.x, v.y, 3));
  }
  function rvFlee(g, v) { // the driest, highest reachable ground nearby, away from the water now on the map
    let best = null, bs = -1e9;
    for (let k = 0; k < 24; k++) for (const d of [4, 7, 11, 15]) {
      const a = (k / 24) * 6.283, x = v.x + Math.cos(a) * d, y = v.y + Math.sin(a) * d;
      if (x < 1 || y < 1 || x >= RG_W - 1 || y >= RG_H - 1) continue;
      if (rvWet(g, x, y, 1, 0.02)) continue;
      let near = 0; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (g.h[rvCell(x + dx, y + dy)] > 0.04) near++;
      const s = g.T[rvCell(x, y)] + 0.12 * d - 0.6 * near;
      if (s > bs) { bs = s; best = [x, y]; }
    }
    v.job = null; v.chase = null;
    if (!best) return rvToMeet(g, v);
    rvGo(v, best[0], best[1], () => { v.state = "safe"; v.t = 4; }, true);
  }
  function rvPick(g, x, y) { // a free villager who can walk there on dry ground (people at home first)
    let best = null, bd = 1e9;
    for (const v of rg.vil.list) {
      if (v.homeless || v.job || v.state === "flee" || v.state === "safe" || v.state === "meet") continue;
      const [sx, sy] = v.inside ? rvDoor(g.houses[v.home]) : [v.x, v.y];
      if (!rvPathDry(g, sx, sy, x, y)) continue;
      const d = Math.hypot(sx - x, sy - y) + (v.role === "home" ? 0 : 12);
      if (d < bd && d < 60) { bd = d; best = v; }
    }
    return best;
  }
  function rvNextDig(g, v) {
    const J = v.job;
    if (!J || !J.pts.length) { v.job = null; return rvHome(g, v); }
    const [x, y] = J.pts.shift(); rvOut(g, v);
    rvGo(v, x - 0.6, y + 0.5, () => { v.state = "dig"; v.face = 1; v.t = 1.8; v.dx = x; v.dy = y; v.then = () => rvNextDig(g, v); });
  }
  function rvDigEvent(g, x, y) { // a dig on land: the same villager keeps working along a long canal
    const V = rg.vil; if (!V || g.h[rvCell(x, y)] > 0.08) return;
    const busy = V.list.find((v) => v.job && v.job.kind === "dig");
    if (busy) {
      const J = busy.job, last = J.last;
      if (Math.hypot(x - last[0], y - last[1]) > 5 && J.pts.length < 4) { J.pts.push([x, y]); J.last = [x, y]; }
      return;
    }
    const v = rvPick(g, x, y); if (!v) return;
    v.job = { kind: "dig", pts: [[x, y]], last: [x, y] };
    if (v.state !== "dig") rvNextDig(g, v);
  }
  function rvPourEvent(g, x, y, mat, start) { // pouring: one villager brings a sack of that material (a new one only when a pour starts)
    const V = rg.vil; if (!V) return;
    const c = V.list.find((v) => v.job && v.job.kind === "carry");
    if (c) { if (c.state === "walk" && c.job.going) { c.job.x = x; c.job.y = y; c.job.mat = mat; c.target = [x + 0.9, y + 0.4]; } return; }
    if (!start) return;
    const v = rvPick(g, x, y); if (!v) return;
    v.job = { kind: "carry", x, y, mat, going: true }; rvOut(g, v);
    rvGo(v, x + 0.9, y + 0.4, () => { v.job.going = false; v.state = "drop"; v.face = -1; v.t = 0.6; v.then = () => { v.state = "empty"; v.t = 1.4; v.then = () => { v.job = null; rvHome(g, v); }; }; });
  }
  function rvUpdate(g, dt) {
    const V = rg.vil; if (!V || !dt) return;
    rvRaft(g, dt);
    rvChase(g, dt);
    for (const v of V.list) {
      v.phase += dt * v.step;
      const hs = g.houses[v.home];
      if (hs.lost && !v.homeless) { // the house is lost: out of the door, and never back to it
        v.homeless = true;
        if (v.inside) { v.inside = false; [v.x, v.y] = rvDoor(hs); v.job = null; v.escape = 1.2; rvToMeet(g, v); }
        else if (!v.job && v.state !== "flee") rvToMeet(g, v);
      }
      if (!v.inside && v.state !== "flee" && v.state !== "meet" && (v.chk -= dt) <= 0) { v.chk = 0.25; if (rvWet(g, v.x, v.y, 2, 0.06, true)) rvFlee(g, v); }
      if (v.escape) v.escape = Math.max(0, v.escape - dt);
      if (v.state === "wait") { if ((v.wait -= dt) <= 0) { rvOut(g, v); rvDaily(g, v); } }
      else if (v.state === "walk" || v.state === "flee") {
        const [tx, ty] = v.target, dx = tx - v.x, dy = ty - v.y, d = Math.hypot(dx, dy), s = v.speed * dt * (v.state === "flee" ? 1.9 : 1);
        if (Math.abs(dx) > 0.05) v.face = dx > 0 ? 1 : -1;
        if (d <= s) { v.x = tx; v.y = ty; const f = v.then; v.then = null; v.state = "idle"; if (f) f(); }
        else { v.x += (dx / d) * s; v.y += (dy / d) * s; }
      } else if (v.state === "tend" || v.state === "chop" || v.state === "dig" || v.state === "drop" || v.state === "empty" || v.state === "safe") {
        if (v.state === "dig" && Math.random() < dt * 9) V.parts.push({ x: v.dx, y: v.dy, vx: (Math.random() - 0.3) * 6, vy: -4 - Math.random() * 4, t: 0, life: 0.5, col: "#7a5230" });
        if (v.state === "empty" && Math.random() < dt * 14) V.parts.push({ x: v.job.x, y: v.job.y, vx: (Math.random() - 0.5) * 4, vy: -2 - Math.random() * 3, t: 0, life: 0.45, col: RV_SACK[v.job.mat] });
        if ((v.t -= dt) <= 0) {
          if (v.state === "safe") { if (v.homeless) rvToMeet(g, v); else if (!rvWet(g, ...rvDoor(hs), 2, 0.06, true)) rvHome(g, v); else v.t = 2; }
          else { const f = v.then; v.then = null; v.state = "idle"; if (f) f(); }
        }
      }
    }
    V.parts = V.parts.filter((p) => (p.t += dt) < p.life);
  }
  // v87: someone nearby sees the chicken drift by and runs a short way along the dry bank, saying "Lo siento Wilson!"
  // (the same words in every language). Once per ride; stops where the dry ground ends, then goes back to safety. Drawing only.
  const RV_SAY = "Lo siento Wilson!";
  function rvBank(g, v, R) { // from the plank towards the villager: the first ground at least 2 cells away from flood water
    const dx = v.x - R.x, dy = v.y - R.y, d = Math.hypot(dx, dy); if (d < 0.01) return null;
    for (let s = 0.5; s <= d; s += 0.5) { const x = R.x + (dx / d) * s, y = R.y + (dy / d) * s; if (g.h[rvCell(x, y)] < 0.02 && !rvWet(g, x, y, 2, 0.06, true)) return [x, y]; }
    return null;
  }
  function rvChase(g, dt) {
    const V = rg.vil, R = V.raft;
    if (R && !R.seen) { // the nearest free villager outside notices the plank
      let best = null, bd = 16;
      for (const v of V.list) {
        if (v.inside || v.job || !["walk", "tend", "chop", "idle", "safe", "meet"].includes(v.state)) continue;
        const d = Math.hypot(v.x - R.x, v.y - R.y); if (d < bd && rvBank(g, v, R)) { bd = d; best = v; }
      }
      if (best) { R.seen = true; best.chase = { t: 0, max: 6, then: best.then }; best.then = null; best.state = "chase"; best.say = 3.5; }
    }
    for (const v of V.list) {
      if (v.say) v.say = Math.max(0, v.say - dt);
      if (v.state !== "chase") continue;
      const C = v.chase; C.t += dt;
      const bank = R ? rvBank(g, v, R) : null;
      const stop = () => { v.chase = null; v.state = "safe"; v.t = 0.8; }; // stand still a moment, then back to safety
      if (!bank || C.t > C.max) { stop(); continue; }
      const dx = bank[0] - v.x, dy = bank[1] - v.y, d = Math.hypot(dx, dy), st = Math.min(d, v.speed * 1.5 * dt);
      if (d < 0.05) continue;
      const nx = v.x + (dx / d) * st, ny = v.y + (dy / d) * st;
      if (g.h[rvCell(nx, ny)] >= 0.02 || rvWet(g, nx, ny, 2, 0.06, true)) { stop(); continue; } // the dry way ends here
      v.x = nx; v.y = ny; if (Math.abs(dx) > 0.05) v.face = dx > 0 ? 1 : -1;
    }
  }
  function rvBubbles(c, g, view) { // the speech bubble, drawn at a fixed screen size so it stays readable at any zoom
    const cw = c.canvas.width, css = c.canvas.getBoundingClientRect().width || cw, k = cw / css;
    for (const v of rg.vil.list) {
      if (!v.say || v.inside) continue;
      const [px, py] = rgProj(g.T, v.x, v.y), sx = (px - view.x) * view.s, sy = (py - 6.2 - view.y) * view.s;
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = Math.min(1, v.say / 0.4); // fades out at the end
      c.font = `700 ${Math.round(12.5 * k)}px system-ui, sans-serif`;
      const w = c.measureText(RV_SAY).width + 16 * k, h = 24 * k, x = Math.min(cw - w - 4, Math.max(4, sx - w / 2)), y = Math.max(4, sy - h - 9 * k);
      c.fillStyle = "#fffdf6"; c.strokeStyle = "#2b2b2b"; c.lineWidth = 1.6 * k;
      c.beginPath(); c.roundRect ? c.roundRect(x, y, w, h, 7 * k) : c.rect(x, y, w, h); c.fill(); c.stroke();
      const tx = Math.min(x + w - 10 * k, Math.max(x + 10 * k, sx));
      c.beginPath(); c.moveTo(tx - 5 * k, y + h - 1); c.lineTo(tx, y + h + 8 * k); c.lineTo(tx + 5 * k, y + h - 1); c.fill();
      c.beginPath(); c.moveTo(tx - 5 * k, y + h); c.lineTo(tx, y + h + 8 * k); c.lineTo(tx + 5 * k, y + h); c.stroke();
      c.fillStyle = "#1d1d1d"; c.textBaseline = "middle"; c.textAlign = "center"; c.fillText(RV_SAY, x + w / 2, y + h / 2 + 0.5);
      c.restore();
    }
  }
  // ---- the chicken on a plank ----
  function rvVel(g, i) { const hh = Math.max(0.15, g.h[i]), k = RG.sub; return [Math.max(-3, Math.min(3, ((g.fE[i] - g.fW[i]) / hh) * k)), Math.max(-3, Math.min(3, ((g.fS[i] - g.fN[i]) / hh) * k))]; }
  function rvRaft(g, dt) {
    const V = rg.vil, R = V.raft;
    if (!R) {
      if ((V.raftWait -= dt) > 0 || g.phase === "prep") return;
      V.raftWait = 14 + Math.random() * 14;
      let best = -1, bs = 0.5; // the fastest of some deep water below the mountains: only where the current is strong enough
      for (let k = 0; k < 200; k++) {
        const x = 8 + ((Math.random() * (RG_W - 16)) | 0), y = 38 + ((Math.random() * (RG_H - 50)) | 0), i = y * RG_W + x; if (g.h[i] < 0.3) continue;
        const [vx, vy] = rvVel(g, i), sp = Math.hypot(vx, vy); if (sp > bs) { bs = sp; best = i; }
      }
      if (best >= 0) { const [vx, vy] = rvVel(g, best); V.raft = { x: (best % RG_W) + 0.5, y: ((best / RG_W) | 0) + 0.5, ang: Math.atan2(vy, vx), t: 0, flap: 1.2 + Math.random() * 2, start: [(best % RG_W) + 0.5, ((best / RG_W) | 0) + 0.5] }; }
      return;
    }
    const i = rvCell(R.x, R.y);
    if (g.h[i] < 0.08 || R.t > 26 || R.x < 0.5 || R.y < 0.5 || R.x >= RG_W - 0.5 || R.y >= RG_H - 0.5) { V.raft = null; return; }
    const [vx, vy] = rvVel(g, i), sp = Math.hypot(vx, vy);
    R.x += vx * dt * 2.2; R.y += vy * dt * 2.2; R.t += dt; // drawn a little faster than the water so the ride is seen (no effect on the water)
    if (sp > 0.05) { let d = Math.atan2(vy, vx) - R.ang; d = Math.atan2(Math.sin(d), Math.cos(d)); R.ang += d * Math.min(1, dt * 1.4); }
    R.flap -= dt; if (R.flap < -0.5) R.flap = 2 + Math.random() * 3;
  }
  function rvDrawRaft(c, g, R) {
    const i = rvCell(R.x, R.y), W = g.T[i] + g.h[i], px = R.x * RG_PX, py = rgPY(R.y, W) - Math.sin(R.t * 4.2) * 0.35;
    const tilt = Math.atan(Math.tan(R.ang)); // a plank looks the same both ways: only its slant from the flow matters
    c.save(); c.translate(px, py); c.rotate(tilt * 0.35 + Math.sin(R.t * 2.6) * 0.18); // the plank turns with the current and rocks a little
    c.fillStyle = "#7a5634"; c.fillRect(-2.6, -0.8, 5.2, 1.6); c.fillStyle = "#5c3e24"; c.fillRect(-2.6, -0.1, 5.2, 0.35); c.fillRect(-0.9, -0.8, 0.3, 1.6);
    c.restore();
    const f = Math.cos(R.ang) >= 0 ? 1 : -1, u = 0.42, flap = R.flap < 0, up = flap && Math.floor(R.t * 14) % 2 === 0;
    const P = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(px + (f > 0 ? x : -x - w) * u, py + (y - 6) * u - Math.sin(R.t * 4.2) * 0.35, w * u, h * u); };
    P(-3, 3, 6, 3, "#fbfaf3"); P(-4, 2, 2, 2, "#fbfaf3"); P(1, 1, 3, 3, "#fbfaf3");          // body, tail, head
    P(1, 0, 2, 1, "#d8342c"); P(4, 2, 1, 1, "#f2b33a"); P(3, 4, 1, 1, "#d8342c"); P(2, 2, 1, 1, "#222");  // comb, beak, wattle, eye
    P(-1, 6, 1, 1, "#f2b33a"); P(1, 6, 1, 1, "#f2b33a");                                       // feet
    if (flap) { P(-2, up ? 0 : 3, 2, up ? 3 : 2, "#ecebe2"); P(1, up ? -1 : 4, 2, up ? 3 : 2, "#e2e1d6"); } else P(-1, 3, 3, 2, "#e8e6da"); // wings open for balance, folded otherwise
  }
  // ---- drawing a villager: a tiny pixel figure (about as tall as a door) ----
  function rvDraw(c, g, v, now) {
    if (v.inside) return;
    const [px, py] = rgProj(g.T, v.x, v.y), u = 0.55, f = v.face, moving = v.state === "walk" || v.state === "flee" || v.state === "chase";
    const step = Math.floor(v.phase) % 2, bob = moving ? step * 0.28 : 0, bend = v.state === "tend" || v.state === "dig" || v.state === "empty" ? 1 : 0;
    const P = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(px + (f > 0 ? x : -x - w) * u, py + (y - 9) * u - bob, w * u, h * u); };
    c.fillStyle = "rgba(0,0,0,.28)"; c.beginPath(); c.ellipse(px, py, 1.7, 0.6, 0, 0, 7); c.fill();
    // sack on the back while carrying
    if (v.job && v.job.kind === "carry" && v.job.going) { // a full sack on the back, in the material's colour, with a dark outline
      const s = RV_SACK[v.job.mat]; P(-5, 2, 4, 6, "#3a2c1e"); P(-4.6, 2.4, 3.2, 5.2, s); P(-4.6, 2.4, 3.2, 1, "rgba(255,255,255,.25)"); P(-3.4, 1.4, 1, 1.2, "#3a2c1e"); }
    const hy = bend; // head and body lean forward when working low
    if (v.hat) { P(-2, 0 + hy, 4, 1, v.hat); P(-3, 1 + hy, 6, 1, v.hat); } else { P(-2, 0 + hy, 4, 1, v.hair); P(-2, 1 + hy, 4, 1, v.hair); }
    P(-2, 2 + hy, 1, 1, v.hair); P(-1, 2 + hy, 2, 2, v.skin); P(1, 2 + hy, 1, 1, v.hair); P(0, 2 + hy, 1, 1, v.skin);
    P(-2, 4, 4, 3, v.shirt);
    if (v.role === "tree") { P(-1, 4, 1, 1, "#c8302e"); P(1, 5, 1, 1, "#c8302e"); P(-2, 6, 1, 1, "#c8302e"); } // black and red check
    const arm = v.state === "flee" ? -1 : 0; P(-3, 4 + arm, 1, 2, v.shirt); P(2, 4 + arm, 1, 2, v.shirt); P(-3, 6 + arm, 1, 1, v.skin); P(2, 6 + arm, 1, 1, v.skin);
    P(-2, 7, 4, 1, v.pants);
    if (moving) { if (step) { P(-2, 8, 1, 1, v.pants); P(1, 8, 1, 1, "#2b1d14"); } else { P(-1, 8, 1, 1, "#2b1d14"); P(0, 8, 1, 1, v.pants); } }
    else { P(-2, 8, 1, 1, "#2b1d14"); P(1, 8, 1, 1, "#2b1d14"); }
    // tools
    const sw = Math.sin(v.phase * 2.2);
    const line = (x0, y0, x1, y1, col) => { const n = 4; for (let k = 0; k <= n; k++) P(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n, 1, 1, col); };
    if (v.state === "tend" || (v.role === "field" && moving && !v.job)) { const ty = v.state === "tend" ? 2 + sw * 2 : 1; line(2, 6, 4, ty, "#8a6a3a"); P(4, ty + (v.state === "tend" ? 1 : 0), 2, 1, "#8f8f8f"); }
    else if (v.state === "chop" || (v.role === "tree" && moving && !v.job)) { const ty = v.state === "chop" ? 1 + sw * 2.5 : 2; line(2, 6, 4, ty, "#6b4a2a"); P(4, ty - 1, 1, 2, "#9a9a9a"); }
    else if (v.state === "dig" || (v.job && v.job.kind === "dig")) { const ty = v.state === "dig" ? 4 + sw * 2 : 3; line(2, 6, 3, ty - 2, "#8a6a3a"); P(3, ty - 1, 2, 2, "#a7a7a7"); }
    if (v.state === "drop" || v.state === "empty") { const s = RV_SACK[v.job.mat]; P(3, 4.6, 4, 4.4, "#3a2c1e"); P(3.4, 5, 3.2, 3.6, s); if (v.state === "empty") P(6, 6.4, 1.2, 1.6, s); }
    if (v.state === "flee" || v.escape) { c.fillStyle = "#ffd23f"; c.fillRect(px - 0.3, py - 9 * u - 2.6 - bob, 0.6, 1.4); c.fillRect(px - 0.3, py - 9 * u - 0.9 - bob, 0.6, 0.5); } // "!"
  }
  function rvDrawParts(c, g) {
    for (const p of rg.vil.parts) { const [px, py] = rgProj(g.T, p.x, p.y); c.fillStyle = p.col; c.fillRect(px + p.vx * p.t, py - 2 + p.vy * p.t + 9 * p.t * p.t, 0.7, 0.7); }
  }
  // ---- loop and panel ----------------------------------------------------------------------------------------------
  function rgStop() { if (rg.raf) cancelAnimationFrame(rg.raf); rg.raf = 0; rg.pour = null; rg.parts = []; rg.pointers.clear(); rg.gest = null; rg.pinch = null; rg.pan = null; } // a pressed pointer never outlives the panel
  function rgKick() { if (!rg.raf && rg.open) { rg.last = 0; rg.raf = requestAnimationFrame(rgLoop); } }
  function rgLoop(now) {
    rg.raf = 0;
    if (!rg.open || $("story").hidden || !rg.g) return;
    const dt = rg.last ? Math.min(0.1, (now - rg.last) / 1000) : 0; rg.last = now;
    const g = rg.g;
    rgPending(g, now);
    rgPourStep(g, now, dt);
    const before = g.phase;
    rgTick(g, dt);
    if ((g.running && g.ready) || g.phase === "done") rvUpdate(g, dt); // v86: villagers and the chicken stop when the game is paused
    if (g.phase !== before || dt) rgHud();
    rgRender(now);
    rg.raf = requestAnimationFrame(rgLoop);
  }
  function rgHint(fn) { rg.hint = fn; const el = $("story").querySelector(".rg-hint"); if (el) el.textContent = fn ? fn() : ""; }
  let rgHudLast = "";
  function rgHud() {
    const box = $("story"), g = rg.g; if (!g || !box.querySelector(".rg-hud")) return;
    const saved = g.houses.filter((hs) => !hs.lost).length;
    const phase = !g.ready ? t("Choose where the rain starts") : g.phase === "prep" ? t("Preparation") : g.phase === "rain" ? t("Rain") : g.phase === "after" ? t("Water coming down") : t("Finished");
    const time = g.phase === "prep" ? rgClock(Math.max(0, RG.prep - g.time)) : rgClock(g.rainT);
    const key = `${phase}|${time}|${saved}|${Math.round(g.budget)}|${g.running}|${g.phase}|${I.lang}`;
    if (key === rgHudLast) return; rgHudLast = key;
    box.querySelector(".rg-phase").textContent = phase;
    box.querySelector(".rg-time").textContent = time;
    box.querySelector(".rg-houses").textContent = t("{n}/{total} houses safe", { n: saved, total: g.houses.length });
    box.querySelector(".rg-budget").textContent = t("Budget {n}", { n: Math.round(g.budget) });
    const run = box.querySelector(".rg-run");
    run.textContent = g.phase === "prep" ? t("Start the rain") : g.running ? t("Pause") : t("Continue");
    run.disabled = g.phase === "done" || !g.ready;
    box.querySelector(".rg-run").setAttribute("aria-pressed", String(g.phase !== "prep" && !g.running));
  }
  function rgTools() {
    const box = $("story");
    box.querySelectorAll(".rg-tool").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === rg.tool)));
    box.querySelectorAll(".rg-opt").forEach((el) => { el.hidden = el.dataset.for !== rg.tool; });
    box.querySelectorAll(".rg-mat .sh-opt").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.v) === rg.mat)));
    box.querySelectorAll(".rg-mode .sh-opt").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === rg.mode)));
    const cv = box.querySelector(".rg-map"); if (cv) cv.dataset.tool = rg.tool;
  }
  function rgShowEnd() {
    const box = $("story"), el = box.querySelector(".rg-end"), g = rg.g; if (!el || !g || !g.result) { if (el) el.hidden = true; return; }
    const r = g.result, lines = [t("{n}/{total} houses protected", { n: r.saved, total: r.total })];
    if (r.firstReach != null) lines.push(t("The water first reached a house at {time}.", { time: rgAt(rgClock(r.firstReach)) })); else lines.push(t("The water never reached a house."));
    if (r.collapsed) lines.push(t("{n} houses collapsed because their foundation was dug away.", { n: r.collapsed }));
    if (rg.prev != null && g.replay) { const d = r.saved - rg.prev; lines.push(d > 0 ? t("This time {n} more houses were protected.", { n: d }) : d < 0 ? t("This time {n} fewer houses were protected.", { n: -d }) : t("The same number of houses as last time.")); }
    el.innerHTML = `<h3>${esc(r.win ? t("The village is safe!") : t("The village was flooded."))}</h3>` +
      `<p class="rg-goalline">${esc(t("Goal: protect at least {n} houses.", { n: RG.goal }))}</p><ul>${lines.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` +
      `<div class="rg-end-btns"><button type="button" class="btn btn-primary rg-again">${esc(t("Try again with the same rain"))}</button>` +
      `<button type="button" class="btn rg-new">${esc(t("New mission"))}</button><button type="button" class="btn rg-free">${esc(t("Free play"))}</button></div>`;
    el.hidden = false; el.classList.toggle("win", r.win);
    el.querySelector(".rg-again").addEventListener("click", () => rgRestart(true));
    el.querySelector(".rg-new").addEventListener("click", () => { rg.mode = "mission"; rgRestart(false); });
    el.querySelector(".rg-free").addEventListener("click", () => { rg.mode = "free"; rgRestart(false); });
    el.querySelector(".rg-again").focus({ preventScroll: true });
  }
  function rgRestart(same) {
    const g = rg.g, prevSaved = g && g.result ? g.result.saved : null, scen = same && g ? { center: g.scenario.center, extras: g.scenario.extras } : null;
    const ng = rgRound(same && g ? g.mode : rg.mode, scen);
    ng.replay = !!same; rg.prev = same ? prevSaved : null;
    if (ng.mode === "free" && !ng.ready) rg.tool = "rain";
    $("story").querySelector(".rg-end").hidden = true; rgTools();
    rgHint(ng.ready ? () => t("Prepare: build levees or dig a channel before the rain starts.") : () => t("Free play: tap the map with the Rain tool to choose where the rain starts."));
    rgHud(); rg.dirty = true; rgKick();
  }
  // view: zoom and pan (two fingers, mouse wheel, right-drag, buttons, keys) never dig or build
  function rgClampView() { const v = rg.view; if (!isFinite(v.s) || !isFinite(v.x) || !isFinite(v.y)) { v.s = 1; v.x = 0; v.y = 0; } v.s = Math.max(1, Math.min(5, v.s)); v.x = Math.max(0, Math.min(RG_CW - RG_CW / v.s, v.x)); v.y = Math.max(0, Math.min(RG_CH - RG_CH / v.s, v.y)); rg.dirty = true; }
  function rgZoom(f, px, py) { const v = rg.view, wx = v.x + px / v.s, wy = v.y + py / v.s; v.s *= f; rgClampView(); v.x = wx - px / v.s; v.y = wy - py / v.s; rgClampView(); }
  function rgAct(kind, x, y) {
    const g = rg.g; if (!g) return;
    if (g.phase === "done") return rgHint(() => t("The round is over. Try again with the same rain or start a new mission."));
    if (kind === "rain") rgAddRain(g, x, y);
  }
  async function openRiver(restore) {
    if (!story || $("story").hidden) return;
    const box = $("story"), panel = box.querySelector(".sh-panel");
    rg.open = true;
    box.classList.add("sh-on");
    for (const el of box.querySelectorAll(".sv-fig, .sv-try-row, .sv-nav")) el.hidden = true;
    panel.hidden = false;
    if (!restore || !rg.g) { rg.view = { s: 1, x: 0, y: 0 }; rg.tool = "levee"; rg.mode = "mission"; rg.prev = null; rgRound("mission", null); rg.hint = () => t("Prepare: build levees or dig a channel before the rain starts."); }
    else rg.terrainDirty = [0, 0, RG_W - 1, RG_H - 1];
    const mats = [1, 2, 3, 4].map((m) => [m, { sand: t("Sand"), soil: t("Soil"), stone: t("Stone"), concrete: t("Concrete") }[RG_MAT[m].id]]);
    panel.innerHTML = `<div class="sh-head"><h2 id="sh-h" tabindex="-1">${esc(t("Protect the village from the flood"))}</h2><span class="sv-badge sh-badge">${esc(t("Illustrative animation"))}</span></div>` +
      `<p class="rg-task"><b>${esc(t("Build a levee, open a new way for the water and protect the village."))}</b> ${esc(t("Goal: protect at least {n} houses.", { n: RG.goal }))}</p>` +
      `<div class="rg-hud" role="group" aria-label="${esc(t("Game status"))}"><span class="rg-phase"></span> <b class="rg-time">00:00</b> <span class="rg-houses"></span> <span class="rg-budget"></span>` +
        `<button type="button" class="btn btn-small rg-run" aria-pressed="false"></button></div>` +
      `<div class="rg-mapbox"><canvas class="rg-map" width="${RG_CW}" height="${RG_CH}" style="aspect-ratio:${RG_CW}/${RG_CH}" tabindex="0" role="application" aria-describedby="rg-hint"` +
        ` aria-label="${esc(t("Game map of an illustrative valley, seen slightly from the south. Arrow keys move the marker, Shift + arrow keys move the map, + and − zoom, Enter uses the tool (the levee pours while Enter is held)."))}"></canvas>` +
        `<div class="rg-zoom"><button type="button" class="btn btn-small rg-zin" aria-label="${esc(t("Zoom in"))}">+</button><button type="button" class="btn btn-small rg-zout" aria-label="${esc(t("Zoom out"))}">−</button>` +
        `<button type="button" class="btn btn-small rg-zfit" aria-label="${esc(t("Show the whole valley"))}">⤢</button></div>` +
        `<div class="rg-end" hidden role="dialog" aria-live="polite"></div></div>` +
      `<p class="rg-hint" id="rg-hint" aria-live="polite"></p>` +
      `<div class="sh-seg rg-tools" role="radiogroup" aria-label="${esc(t("Tools"))}">` + [["rain", t("Rain")], ["dig", t("Dig")], ["levee", t("Levee")]].map(([v, l]) =>
        `<button type="button" role="radio" class="sh-opt rg-tool" data-v="${v}" aria-checked="false">${esc(l)}</button>`).join("") + `</div>` +
      `<div class="rg-opt" data-for="rain"><p>${esc(t("Tap the map: extra rain falls there for {s} s. In free play, choose first where the rain starts.", { s: RG.extraDur }))}</p></div>` +
      `<div class="rg-opt" data-for="dig"><label class="rg-size"><span>${esc(t("Brush size"))}</span><input type="range" class="rg-brush" min="1.5" max="6" step="0.1" value="${rg.brush}"></label>` +
        `<p>${esc(t("Drag to dig. Digging stops at the bedrock; a house whose foundation is dug away collapses."))}</p></div>` +
      `<div class="rg-opt" data-for="levee"><div class="sh-seg rg-mat" role="radiogroup" aria-label="${esc(t("Levee material"))}">` + mats.map(([m, l]) =>
        `<button type="button" role="radio" class="sh-opt" data-v="${m}" aria-checked="false">${esc(l)}<small>${esc(t("cost {n}", { n: RG_MAT[m].cost }))}</small></button>`).join("") + `</div>` +
        `<p>${esc(t("Press to pour, hold to build higher, drag to draw a levee. Pouring stops when you let go."))}</p></div>` +
      `<div class="sh-seg rg-mode" role="radiogroup" aria-label="${esc(t("Game mode"))}"><button type="button" role="radio" class="sh-opt" data-v="mission" aria-checked="true">${esc(t("Mission"))}</button>` +
        `<button type="button" role="radio" class="sh-opt" data-v="free" aria-checked="false">${esc(t("Free play"))}</button></div>` +
      `<details class="sh-data"><summary>${esc(t("How the game works"))}</summary><ul class="sh-limits">` +
        `<li>${esc(t("An illustrative valley and water model, not a forecast or a picture of the real Habiganj flood."))}</li>` +
        `<li>${esc(t("Water flows from higher to lower ground and from deeper to shallower water, in small steps; rain adds water and the south edge lets it leave."))}</li>` +
        `<li>${esc(t("Under the soil lies bedrock that cannot be dug: thin soil on the mountains, thick soil in the valleys and on the plain."))}</li>` +
        `<li>${esc(t("Game rules for levee materials, per cell: sand costs 1 and washes away fast, soil costs 2 and wears slowly, stone costs 3 and wears very slowly, concrete costs 5 and does not wear."))}</li>` +
        `<li>${esc(t("A house counts as lost when water around it stays deeper than the game threshold for a moment, or when its foundation is dug away."))}</li>` +
        `<li>${esc(t("Zoom with two fingers, the mouse wheel or the buttons; move the map with two fingers or the right mouse button. One finger uses the tool."))}</li></ul></details>` +
      `<div class="sv-nav sh-nav"><button type="button" class="btn sh-back">${esc(t("← Back to the story"))}</button>` +
        `<button type="button" class="btn btn-primary sh-to-map">${esc(t("Explore on the map"))}</button></div>`;
    const cv = panel.querySelector(".rg-map");
    // pointers: one finger / left button uses the tool, two fingers / wheel / right button move and zoom the map
    // a screen point → the ground point drawn there (through zoom, pan and the tilted view); null off the land
    const toWorld = (e) => { const r = cv.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * RG_CW, py = ((e.clientY - r.top) / r.height) * RG_CH;
      const p = rgPick(rg.g.T, rg.view.x + px / rg.view.s, rg.view.y + py / rg.view.s); return p ? [p[0], p[1], px, py] : [null, null, px, py]; };
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    cv.addEventListener("wheel", (e) => { e.preventDefault(); const [, , px, py] = toWorld(e); rgZoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, px, py); }, { passive: false });
    cv.addEventListener("pointerdown", (e) => {
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      rg.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      rg.kb = false;
      if (e.button === 1 || e.button === 2) { rg.pan = { x: e.clientX, y: e.clientY }; return; }
      if (rg.pointers.size >= 2) { // a second finger: zoom / pan, the tool stroke is dropped and pouring stops
        if (rg.pour) rgHint(() => t("Two fingers move the map; pouring stopped."));
        rg.gest = null; rg.aim = null; rg.pour = null;
        const [a, b] = [...rg.pointers.values()];
        rg.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, view: { ...rg.view } };
        rg.dirty = true; return;
      }
      const [x, y] = toWorld(e);
      if (x == null) return;
      rg.aim = [x, y];
      rg.gest = { kind: rg.tool, pts: [[x, y]], t0: performance.now(), touch: e.pointerType !== "mouse", live: e.pointerType === "mouse", x0: e.clientX, y0: e.clientY, dug: false, fell: rgFallen(rg.g) };
      if (rg.gest.live && rg.tool === "dig") { rg.gest.dug = rgDig(rg.g, x, y, rg.brush); }
      if (rg.tool === "levee" && rg.g.phase !== "done") { // pouring starts at once, mouse or finger
        if (rg.g.budget <= 0.01) rgHint(() => t("Not enough budget for this levee."));
        else { rg.pour = { x, y, mat: rg.mat, acc: 1, id: e.pointerId }; rvPourEvent(rg.g, x, y, rg.mat, true); rgHint(() => t("Pouring… hold to build higher, drag to draw a levee.")); }
      }
      rg.dirty = true;
    });
    cv.addEventListener("pointermove", (e) => {
      const p = rg.pointers.get(e.pointerId); if (p) { p.x = e.clientX; p.y = e.clientY; }
      if (rg.pan) { const r = cv.getBoundingClientRect(), k = RG_CW / r.width / rg.view.s; rg.view.x -= (e.clientX - rg.pan.x) * k; rg.view.y -= (e.clientY - rg.pan.y) * k; rg.pan = { x: e.clientX, y: e.clientY }; rgClampView(); return; }
      if (rg.pinch && rg.pointers.size >= 2) {
        const [a, b] = [...rg.pointers.values()], r = cv.getBoundingClientRect(), k = RG_CW / r.width, P = rg.pinch;
        const s = Math.max(1, Math.min(5, P.view.s * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(10, P.d)));
        const cx = ((a.x + b.x) / 2 - r.left) * k, cy = ((a.y + b.y) / 2 - r.top) * k, c0x = (P.cx - r.left) * k, c0y = (P.cy - r.top) * k;
        rg.view.s = s; rg.view.x = P.view.x + c0x / P.view.s - cx / s; rg.view.y = P.view.y + c0y / P.view.s - cy / s; rgClampView(); return;
      }
      const [x, y] = toWorld(e);
      if (x == null) return;
      if (!rg.gest) { if (e.pointerType === "mouse") { rg.aim = [x, y]; rg.dirty = true; } return; }
      rg.aim = [x, y];
      if (rg.pour && rg.pour.id === e.pointerId) { rg.pour.x = x; rg.pour.y = y; }
      const G = rg.gest;
      if (!G.live && (Math.hypot(e.clientX - G.x0, e.clientY - G.y0) > 8 || performance.now() - G.t0 > 140)) G.live = true; // a finger: wait a moment for a second finger
      if (G.kind === "dig" && G.live) {
        const [lx, ly] = G.pts[G.pts.length - 1], dist = Math.hypot(x - lx, y - ly), n = Math.max(1, Math.ceil(dist / (rg.brush * 0.4)));
        for (let k = 1; k <= n; k++) G.dug = rgDig(rg.g, lx + ((x - lx) * k) / n, ly + ((y - ly) * k) / n, rg.brush) || G.dug;
        G.pts.push([x, y]);
      }
      rg.dirty = true;
    });
    const end = (e, cancel) => {
      rg.pointers.delete(e.pointerId);
      if (rg.pour && rg.pour.id === e.pointerId) { rg.pour = null; if (!cancel) rgHint(() => t("Poured. Hold longer for a higher levee; the water already flows around it.")); rgHud(); } // letting go stops new material at once
      if (rg.pan && rg.pointers.size === 0) { rg.pan = null; return; }
      if (rg.pinch) { if (rg.pointers.size < 2) rg.pinch = null; return; }
      const G = rg.gest; rg.gest = null;
      if (e.pointerType !== "mouse") rg.aim = null;
      if (!G || cancel) { rg.dirty = true; return; }
      let [x, y] = toWorld(e); const g = rg.g;
      if (x == null) { [x, y] = G.pts[G.pts.length - 1]; }
      if (g.phase === "done") { rgAct("done", x, y); return; }
      if (G.kind === "rain") rgAct("rain", x, y);
      else if (G.kind === "dig") { if (!G.live) G.dug = rgDig(g, x, y, rg.brush) || G.dug; rgDigHint(g, G.dug, G.fell); }
      rg.dirty = true;
    };
    cv.addEventListener("pointerup", (e) => end(e, false));
    cv.addEventListener("pointercancel", (e) => end(e, true));
    cv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !rg.gest) { rg.aim = null; rg.dirty = true; } });
    // keyboard: arrows move the marker, Shift + arrows move the map, + / − zoom, Enter uses the tool (levee: Enter twice)
    cv.addEventListener("focus", () => { if (cv.matches(":focus-visible")) { rg.kb = true; rg.aim = rg.cursor.slice(); rg.dirty = true; } });
    cv.addEventListener("blur", () => { if (rg.kb) { rg.aim = null; rg.gest = null; if (rg.pour && rg.pour.kb) rg.pour = null; rg.dirty = true; } });
    cv.addEventListener("keydown", (e) => {
      const mv = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (mv && e.shiftKey) { e.preventDefault(); e.stopPropagation(); rg.view.x += mv[0] * 60 / rg.view.s; rg.view.y += mv[1] * 60 / rg.view.s; rgClampView(); return; }
      if (mv) { e.preventDefault(); e.stopPropagation(); rg.kb = true; rg.cursor = [Math.max(0.5, Math.min(RG_W - 0.5, rg.cursor[0] + mv[0] * (e.altKey ? 0.5 : 2))), Math.max(0.5, Math.min(RG_H - 0.5, rg.cursor[1] + mv[1] * (e.altKey ? 0.5 : 2)))]; rg.aim = rg.cursor.slice();
        if (rg.pour && rg.pour.kb) { rg.pour.x = rg.cursor[0]; rg.pour.y = rg.cursor[1]; } rg.dirty = true; return; }
      if (e.key === "+" || e.key === "=") { e.preventDefault(); e.stopPropagation(); rgZoom(1.25, RG_CW / 2, RG_CH / 2); return; }
      if (e.key === "-" || e.key === "_") { e.preventDefault(); e.stopPropagation(); rgZoom(0.8, RG_CW / 2, RG_CH / 2); return; }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); e.stopPropagation(); const [x, y] = rg.cursor, g = rg.g;
        if (g.phase === "done") return rgAct("done", x, y);
        if (rg.tool === "rain") rgAct("rain", x, y);
        else if (rg.tool === "dig") { const f0 = rgFallen(g); rgDigHint(g, rgDig(g, x, y, rg.brush), f0); }
        else if (g.budget > 0.01) { const until = performance.now() + 350; if (!(rg.pour && rg.pour.kb)) rvPourEvent(g, x, y, rg.mat, true); rg.pour = rg.pour && rg.pour.kb ? Object.assign(rg.pour, { x, y, until }) : { x, y, mat: rg.mat, acc: 1, kb: true, until }; rgHint(() => t("Pouring… hold Enter to build higher, move the marker to draw a levee.")); }
        else rgHint(() => t("Not enough budget for this levee."));
        rg.dirty = true;
      } else if (e.key === "Escape" && rg.pour) { e.preventDefault(); e.stopPropagation(); rg.pour = null; rg.dirty = true; }
    });
    panel.querySelector(".rg-zin").addEventListener("click", () => rgZoom(1.4, RG_CW / 2, RG_CH / 2));
    panel.querySelector(".rg-zout").addEventListener("click", () => rgZoom(1 / 1.4, RG_CW / 2, RG_CH / 2));
    panel.querySelector(".rg-zfit").addEventListener("click", () => { rg.view = { s: 1, x: 0, y: 0 }; rg.dirty = true; });
    panel.querySelector(".rg-run").addEventListener("click", () => {
      const g = rg.g; if (!g || g.phase === "done" || !g.ready) return;
      if (g.phase === "prep") { g.running = true; rgStartRain(g); }
      else { g.running = !g.running; rgHint(g.running ? () => t("The game continues.") : () => t("Paused: the clock and the water stop.")); }
      rgHud();
    });
    for (const grp of panel.querySelectorAll(".rg-tools, .rg-mat, .rg-mode")) {
      grp.querySelectorAll(".sh-opt").forEach((b) => b.addEventListener("click", () => {
        if (grp.classList.contains("rg-tools")) { rg.tool = b.dataset.v; rg.gest = null; rg.pour = null; }
        else if (grp.classList.contains("rg-mat")) rg.mat = Number(b.dataset.v);
        else if (b.dataset.v !== rg.mode) { rg.mode = b.dataset.v; rg.prev = null; rgRestart(false); }
        rgTools(); rg.dirty = true;
      }));
      grp.addEventListener("keydown", (e) => {
        if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        const o = [...grp.querySelectorAll('[role="radio"]')], k = o.indexOf(document.activeElement), n2 = o[(k + (/Right|Down/.test(e.key) ? 1 : -1) + o.length) % o.length];
        n2.focus(); n2.click();
      });
    }
    const br = panel.querySelector(".rg-brush");
    br.addEventListener("input", () => { rg.brush = Number(br.value); if (!rg.aim) rg.aim = rgPick(rg.g.T, rg.view.x + RG_CW / rg.view.s / 2, rg.view.y + RG_CH / rg.view.s / 2); rg.dirty = true; });
    panel.querySelector(".sh-back").addEventListener("click", closeShaking);
    panel.querySelector(".sh-to-map").addEventListener("click", storyEnd);
    rgHudLast = ""; rgTools(); rgHud(); rgHint(rg.hint); rgShowEnd(); rg.dirty = true; rgKick();
    if (!restore) panel.querySelector("#sh-h").focus({ preventScroll: false });
  }
  const riverStory = (s) => !!(s && s.hazard === "flood" && api && (api.events.find((e) => e.id === s.event_id) || {}).hazard === "flood");
  if (/[?&]fitest=1\b/.test(location.search)) window.__river = { rg, RG, terrain: rgTerrain, round: rgRound, step: rgStep, tick: rgTick, dig: rgDig, levee: rgPlaceLevee, pending: rgPending, rain: rgAddRain,
    pick: rgPick, proj: rgProj, deposit: rgDeposit, pourStep: rgPourStep, vil: () => rg.vil, vupdate: rvUpdate, bank: rvBank, door: rvDoor, vdraw: rvDraw, vraft: rvDrawRaft, house: rgHouse, dims: () => ({ CH: RG_CH, OFF: RG_OFF, RY: RG_RY, HZ: RG_HZ, PX: RG_PX }) }; // local tests only
  const pfSS = (a, b, v) => { const k = Math.max(0, Math.min(1, (v - a) / (b - a))); return k * k * (3 - 2 * k); };
  function pfSegDist(px, py, pts) {
    let best = 1e9;
    for (let k = 0; k < pts.length - 1; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1], dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const u = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L2));
      best = Math.min(best, Math.hypot(px - ax - u * dx, py - ay - u * dy));
    }
    return best;
  }
  // ---------------------------------------------------------------------------------------------------------------
  // v87: "Protect the village from the snow flow" — a game on the last picture of the ice-and-rock story. Illustrative only:
  // a drawn mountain valley (not Gyirong–Rasuwa); times, sizes and damage belong to this game. "Explore on the map" opens the event.
  // Land: 120 × 96 cells, tilted view from the south. Bedrock (never changes) under soil; one large snow mass on the highest
  // ground; two valley branches below it join above the village. The player builds dams (snow wall / stone / concrete, with an
  // optional reinforcing wall), then draws a cut across the snow: the snow on the downhill side breaks away and flows with the
  // "virtual pipes" rule (heavy friction), small pieces keep falling from the cut edge for a few seconds, and snow can be added
  // with the Add snow tool. Dams hold the flow back, can be passed round an open end or over the top, crack and break when their
  // strength is used up; broken dam pieces travel with the flow and make it more damaging. The round ends when everything has
  // stopped; the result is what happened to the village in this round.
  const AV_W = 120, AV_H = 96, AV_PX = 8, AV_CW = AV_W * AV_PX, AV_RY = 6.2, AV_HZ = 1.55;
  let AV_CH = 760, AV_OFF = 0;
  const AV = { sub: 24, K: 0.12, damp: 0.92, dep: 0.006, slow: 0.03, thin: 0.04, trail: 4, trailRate: 0.012, add: 2.4, budget: 100,
    house: 0.3, loadK: 0.02, crack: 0.5, scale: 6, minCut: 12 };
  const AV_DAM = [null, // game types: cost per cell, strength, height (m)
    { id: "snow", cost: 1, hp: 30, h: 3, rgb: [232, 242, 252] },
    { id: "stone", cost: 3, hp: 110, h: 4.5, rgb: [138, 134, 126] },
    { id: "concrete", cost: 6, hp: 260, h: 6, rgb: [196, 198, 202] }];
  const AV_BRANCH = { w: [[50, 17], [44, 30], [40, 46], [46, 60], [58, 72]], e: [[70, 17], [78, 30], [82, 46], [74, 60], [62, 72]], main: [[60, 72], [60, 82], [58, 96]] };
  const AV_HOUSES = [[49, 84], [54, 88], [48, 91], [67, 84], [71, 88], [65, 92], [53, 94], [72, 93]];
  let avLand = null;
  function avTerrain() { // the valley, made once
    if (avLand) return avLand;
    const n = AV_W * AV_H, rk = new Float32Array(n), dvA = new Float32Array(n), soilA = new Float32Array(n), R = new Float32Array(n), S0 = new Float32Array(n), Sn0 = new Float32Array(n), kind = new Uint8Array(n), rnd = new Float32Array(n);
    const r = fiRng(870311), nz = (() => { const gw = 18, gh = 15, g = Array.from({ length: gw * gh }, r); return (x, y, s) => {
      const fx = x / s, fy = y / s, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const v = (i, j) => g[((iy + j) % gh) * gw + ((ix + i) % gw)];
      return (v(0, 0) * (1 - sx) + v(1, 0) * sx) * (1 - sy) + (v(0, 1) * (1 - sx) + v(1, 1) * sx) * sy; }; })();
    for (let y = 0; y < AV_H; y++) for (let x = 0; x < AV_W; x++) {
      const i = y * AV_W + x;
      const base = 4 + 26 * Math.pow(1 - y / AV_H, 1.6);
      const massif = 30 * Math.exp(-(((x - 60) / 28) ** 2) - (((y - 6) / 13) ** 2));
      const peaks = 14 * Math.pow(Math.max(0, Math.sin(x / 5.5 + 0.7)), 4) * pfSS(32, 3, y) * (Math.abs(x - 60) > 18 ? 1 : 0.35);
      const walls = 22 * (pfSS(16, 2, x) + pfSS(104, 118, x)) * (0.85 + 0.3 * nz(x, y, 6));
      const dw = pfSegDist(x + 0.5, y + 0.5, AV_BRANCH.w), de = pfSegDist(x + 0.5, y + 0.5, AV_BRANCH.e), dm = pfSegDist(x + 0.5, y + 0.5, AV_BRANCH.main), dv = Math.min(dw, de, dm);
      const spur = 5 * Math.exp(-(((x - 60) / 5) ** 2)) * pfSS(16, 24, y) * (1 - pfSS(58, 70, y));  // the ridge between the two branches
      const mount = base + massif + peaks + walls + spur + 7 * pfSS(18, 36, y) * (1 - pfSS(82, 94, y)) * (0.8 + 0.4 * nz(x + 9, y, 7)); // hills between the valleys
      // valley floors fall steadily from below the snow to the village fan; the floor wins inside the valleys and on the fan
      const floor = 1 + 21 * Math.pow(1 - y / AV_H, 1.3) + 0.45 * dv;
      const wv = Math.max(0, 1 - (dv / 8) ** 2) * pfSS(12, 22, y), fan = pfSS(76, 86, y) * Math.max(0, 1 - ((x - 60) / 24) ** 2);
      const w = Math.min(1, Math.max(wv, fan) * 1.25);
      const chan = ((dm < 1.8 && y < 80) || ((dw < 1.6 || de < 1.6) && y > 50)) ? 0.8 * (1 - (Math.min(dm, dw, de) / 1.8) ** 2) : 0;
      const land = mount * (1 - w) + Math.min(mount, floor) * w - chan + 0.5 * (nz(x, y, 3) - 0.5);
      const high = land - base;
      const soil = Math.max(0.15, Math.min(3, 3 - 0.12 * high - (y < 26 ? 1.2 : 0))) + 0.3 * Math.sin(x / 8 + y / 11);
      R[i] = land - Math.max(0.15, soil); S0[i] = land - R[i];
      // one large snow mass on the highest ground
      const sd = 1 - (((x - 60) / 30) ** 2) - (((y - 9) / 11) ** 2);
      Sn0[i] = sd > 0 && y < 24 ? Math.min(3.2, 0.6 + 3.4 * sd) * (0.85 + 0.3 * nz(x + 5, y, 4)) : 0;
      rnd[i] = r();
      kind[i] = (dm < 1.4 && y > 70 && y < 94) || ((dw < 1.2 || de < 1.2) && y > 52) ? 6 : 4; dvA[i] = dv;
    }
    for (let y = 0; y < AV_H; y++) for (let x = 0; x < AV_W; x++) { // rock on steep and high ground, grass and soil below, sparse trees
      const i = y * AV_W + x; if (kind[i] === 6) continue; const z = R[i] + S0[i]; let sl = 0;
      for (const j of [x > 0 ? i - 1 : i, x < AV_W - 1 ? i + 1 : i, y > 0 ? i - AV_W : i, y < AV_H - 1 ? i + AV_W : i]) sl = Math.max(sl, Math.abs(z - R[j] - S0[j]));
      rk[i] = Math.min(1, Math.max(0, (z - 15) / 12) * 0.8 + Math.max(0, (sl - 0.8) / 1.4));
      soilA[i] = Math.max(0, 1 - dvA[i] / 4) * pfSS(46, 60, y);
      kind[i] = rk[i] > 0.6 ? 1 : rk[i] < 0.25 && y > 30 && dvA[i] > 2.5 && nz(x, y + 7, 4) > 0.6 ? 3 : 4;
    }
    for (let y = 70; y < AV_H; y++) for (let x = 40; x < 80; x++) { const i = y * AV_W + x; if (kind[i] === 4 && Math.abs(pfSegDist(x + 0.5, y + 0.5, [[60, 74], [62, 96]]) - 10) < 0.6) kind[i] = 9; } // a lane
    for (const [x0, y0, x1, y1] of [[36, 83, 46, 91], [74, 81, 84, 89]]) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * AV_W + x; if (kind[i] === 4 || kind[i] === 3) kind[i] = 5; } // v88: fields
    const houses = AV_HOUSES.map(([cx, cy], k) => ({ cx, cy, cells: [cy * AV_W + cx, cy * AV_W + cx + 1, (cy + 1) * AV_W + cx, (cy + 1) * AV_W + cx + 1], look: k }));
    for (const h of houses) for (const i of h.cells) kind[i] = 4;
    let top = 1e9, bot = -1e9;
    for (let y = 0; y < AV_H; y++) for (let x = 0; x < AV_W; x++) { const z = R[y * AV_W + x] + S0[y * AV_W + x] + Sn0[y * AV_W + x]; top = Math.min(top, y * AV_RY - (z + 4) * AV_HZ); bot = Math.max(bot, (y + 1) * AV_RY - z * AV_HZ); }
    AV_OFF = Math.ceil(-top + 6); AV_CH = Math.ceil(bot + AV_OFF + 16);
    return (avLand = { R, S0, Sn0, kind, rnd, houses, rk, soilA, dvA });
  }
  // ---- state of a round ----------------------------------------------------------------------------------------------
  const pf = { open: false, raf: 0, last: 0, acc: 0, g: null, tool: "dam", dtype: 2, sel: null, view: { s: 1, x: 0, y: 0 }, pointers: new Map(), gest: null, pinch: null, pan: null,
    aim: null, base: null, baseDirty: true, prevHouses: null, lastCut: null };
  function avNew(cut) {
    const L = avTerrain(), n = AV_W * AV_H;
    const g = { Sn: L.Sn0.slice(), Dp: new Float32Array(n), Dm: new Float32Array(n), damId: new Int16Array(n).fill(-1), plan: new Int16Array(n).fill(-1), tasks: [], f: new Float32Array(n),
      fE: new Float32Array(n), fW: new Float32Array(n), fN: new Float32Array(n), fS: new Float32Array(n), T: new Float32Array(n),
      dams: [], budget: AV.budget, phase: "build", running: true, time: 0, steps: 0, trailT: 0, edge: [], cut: null, quiet: 0,
      houses: L.houses.map((h) => ({ ...h, hit: false, at: null })), chunks: [], debris: [], result: null, replayCut: cut || null };
    for (let i = 0; i < n; i++) g.T[i] = L.R[i] + L.S0[i] + g.Sn[i];
    g.vil = svInit(g); // v88: villagers back at home, the day starts again
    pf.g = g; pf.sel = null; pf.baseDirty = true;
    return g;
  }
  const avSetT = (g, i) => { const L = avTerrain(); g.T[i] = L.R[i] + L.S0[i] + g.Dm[i] + g.Sn[i] + g.Dp[i]; };
  // ---- the cut: the snow on the downhill side of a drawn line ---------------------------------------------------------
  function avCutRegion(g, pts) {
    if (!pts || pts.length < 2) return null;
    const line = new Set();
    for (let k = 0; k < pts.length - 1; k++) { const [ax, ay] = pts[k], [bx, by] = pts[k + 1], s = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 2));
      for (let j = 0; j <= s; j++) { const x = Math.floor(ax + ((bx - ax) * j) / s), y = Math.floor(ay + ((by - ay) * j) / s); if (x >= 0 && y >= 0 && x < AV_W && y < AV_H) line.add(y * AV_W + x); } }
    const xs = pts.map((p) => p[0]), xmin = Math.min(...xs), xmax = Math.max(...xs);
    if (xmax - xmin < 5) return null;
    // the line as a function of x: for each column, the line's y; the piece is the snow below (south of) it in that span
    const ly = new Map(); for (const i of line) { const x = i % AV_W, y = (i / AV_W) | 0; ly.set(x, Math.max(ly.has(x) ? ly.get(x) : -1, y)); }
    const side = (below) => { const cells = []; let zs = 0;
      for (const [x, yl] of ly) for (let y = below ? yl + 1 : yl - 1; below ? y < AV_H : y >= 0; y += below ? 1 : -1) { const i = y * AV_W + x; if (g.Sn[i] < 0.15) break; cells.push(i); zs += g.T[i]; }
      return { cells, z: cells.length ? zs / cells.length : 1e9 }; };
    const a = side(true), b = side(false), piece = a.z <= b.z ? a : b; // the downhill side breaks away
    if (piece.cells.length < AV.minCut) return { line: [...line], cells: piece.cells, valid: false };
    return { line: [...line], cells: piece.cells, valid: true };
  }
  function avApplyCut(g, cut) {
    if (!cut || !cut.valid) return false;
    const set = new Set(cut.cells); let vol = 0;
    for (const i of cut.cells) { vol += g.Sn[i]; g.f[i] += g.Sn[i]; g.Sn[i] = 0; avSetT(g, i); }
    g.edge = []; // the cut edge: snow left beside the piece keeps shedding small pieces for a while
    for (const i of cut.cells) for (const j of [i - 1, i + 1, i - AV_W, i + AV_W]) if (j >= 0 && j < g.Sn.length && !set.has(j) && g.Sn[j] > 0.15) g.edge.push(j);
    g.cut = { cells: cut.cells.slice(), line: cut.line.slice(), vol, share: vol / avTerrain().Sn0.reduce((a, b) => a + b, 0) };
    pf.lastCut = { cells: cut.cells.slice(), line: cut.line.slice(), valid: true };
    g.phase = "flow"; g.time = 0; g.trailT = AV.trail; g.running = true;
    const rr = fiRng(cut.cells.length * 7 + 1); // chunks of snow riding the flow (for the eye)
    for (let k = 0; k < Math.min(90, 20 + cut.cells.length / 3); k++) { const i = cut.cells[(rr() * cut.cells.length) | 0]; g.chunks.push({ x: (i % AV_W) + rr(), y: ((i / AV_W) | 0) + rr(), s: 0.6 + rr() * 0.9, life: 0 }); }
    return true;
  }
  // ---- dams ----------------------------------------------------------------------------------------------------------
  function avDamCells(g, pts) { // cells along the drawn line (one cell wide, no gaps)
    const cells = new Set();
    for (let k = 0; k < pts.length - 1; k++) { const [ax, ay] = pts[k], [bx, by] = pts[k + 1], s = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 3));
      let px = null, py = null;
      for (let j = 0; j <= s; j++) { const x = Math.floor(ax + ((bx - ax) * j) / s), y = Math.floor(ay + ((by - ay) * j) / s);
        if (x < 0 || y < 0 || x >= AV_W || y >= AV_H) continue;
        if (px != null && x !== px && y !== py) cells.add(py * AV_W + x); // close diagonal gaps
        cells.add(y * AV_W + x); px = x; py = y; } }
    return [...cells].filter((i) => g.Sn[i] < 0.15 && g.plan[i] < 0);
  }
  function avBuildDam(g, pts, type, instant) { // v88: the line is a plan at once; villagers build it cell by cell
    const cells = avDamCells(g, pts), m = AV_DAM[type], cost = cells.length * m.cost;
    if (cells.length < 2) return { ok: false, why: "short" };
    if (cost > g.budget + 1e-6) return { ok: false, why: "budget", cost };
    g.budget -= cost;
    const dam = { id: g.dams.length, type, cells, built: new Set(), prog: new Map(), wallBuilt: new Set(), wallProg: new Map(), hp: 0, max: 0, per: m.hp / cells.length, wall: false, state: "ok", cost };
    for (const i of cells) g.plan[i] = dam.id;
    g.dams.push(dam);
    if (instant) for (const i of cells) avCellDone(g, dam, i, false);
    else for (let k = 0; k < cells.length; k += 4) g.tasks.push({ d: dam, kind: "dam", cells: cells.slice(k, k + 4), next: 0, worker: null, cur: null });
    pf.baseDirty = true;
    return { ok: true, dam, cost };
  }
  function avCellDone(g, d, i, wall) { // a finished cell: only now does it stand in the way of the snow and add to the strength
    if (d.state === "broken") return;
    if (wall) { if (d.wallBuilt.has(i)) return; d.wallBuilt.add(i); d.wallProg.delete(i); g.Dm[i] += 1.5; d.max += d.per * 0.8; d.hp += d.per * 0.8; }
    else { if (d.built.has(i)) return; d.built.add(i); d.prog.delete(i); g.Dm[i] += AV_DAM[d.type].h; g.damId[i] = d.id; d.max += d.per; d.hp += d.per; }
    avSetT(g, i); pf.baseDirty = true;
  }
  const avWallCost = (d) => Math.ceil(d.cost * 0.5);
  const avDone = (d) => d.built.size / d.cells.length; // the share of the line that is finished
  function avReinforce(g, d, instant) {
    if (!d || d.wall || d.state === "broken") return false;
    const c = avWallCost(d); if (c > g.budget + 1e-6) return false;
    g.budget -= c; d.wall = true;
    if (instant) for (const i of d.cells) avCellDone(g, d, i, true);
    else for (let k = 0; k < d.cells.length; k += 4) g.tasks.push({ d, kind: "wall", cells: d.cells.slice(k, k + 4), next: 0, worker: null, cur: null });
    pf.baseDirty = true; return true;
  }
  function avBreak(g, d) { // the dam gives way: its pieces join the flow
    d.state = "broken"; d.hp = 0;
    const rr = fiRng(d.id * 31 + 7);
    for (const i of d.cells) {
      g.plan[i] = -1; if (!d.built.has(i)) continue;
      g.f[i] += g.Dm[i] * 0.35; g.Dm[i] = 0; g.damId[i] = -1; avSetT(g, i);
      if (rr() < 0.6) g.debris.push({ x: (i % AV_W) + rr(), y: ((i / AV_W) | 0) + rr(), s: 0.7 + rr() * 0.8, rot: rr() * 6, type: d.type, life: 0 });
    }
    d.prog.clear(); d.wallProg.clear();
    if (g.vil) svBroke(g, d);
    pf.baseDirty = true;
  }
  // ---- adding snow (works while running and while paused) --------------------------------------------------------------
  function avAddSnow(g, fx, fy, amount) {
    const r = 1.8; let changed = false;
    for (let y = Math.floor(fy - r); y <= Math.ceil(fy + r); y++) for (let x = Math.floor(fx - r); x <= Math.ceil(fx + r); x++) {
      if (x < 0 || y < 0 || x >= AV_W || y >= AV_H) continue; const d = Math.hypot(x + 0.5 - fx, y + 0.5 - fy); if (d > r) continue;
      const i = y * AV_W + x, q = amount * (1 - d / r) * 0.5; g.Sn[i] += q; avSetT(g, i); changed = true;
    }
    return changed;
  }
  // ---- one small step of the flow -----------------------------------------------------------------------------------
  function avStep(g) {
    const W = AV_W, H = AV_H, T = g.T, f = g.f, K = AV.K, D = AV.damp, fE = g.fE, fW = g.fW, fN = g.fN, fS = g.fS;
    g.steps++; g.time = g.steps / AV.sub;
    if (g.trailT > 0) { // small pieces keep falling from the cut edge, then it stops
      g.trailT -= 1 / AV.sub;
      for (const i of g.edge) if (g.Sn[i] > 0.05) { const q = Math.min(g.Sn[i], AV.trailRate); g.Sn[i] -= q; f[i] += q; avSetT(g, i); }
      if (g.steps % 8 === 0 && g.edge.length) { const i = g.edge[(g.steps / 8) % g.edge.length | 0]; g.chunks.push({ x: (i % W) + 0.5, y: ((i / W) | 0) + 0.5, s: 0.4, life: 0 }); }
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, hi = f[i]; let e = 0, w = 0, nn = 0, so = 0;
      if (hi > 0) {
        const Hi = T[i] + hi, Ka = K * Math.min(1.6, hi);
        if (x < W - 1) { e = fE[i] * D + Ka * (Hi - T[i + 1] - f[i + 1]); if (e < 0) e = 0; }
        if (x > 0) { w = fW[i] * D + Ka * (Hi - T[i - 1] - f[i - 1]); if (w < 0) w = 0; }
        if (y > 0) { nn = fN[i] * D + Ka * (Hi - T[i - W] - f[i - W]); if (nn < 0) nn = 0; }
        so = y < H - 1 ? fS[i] * D + Ka * (Hi - T[i + W] - f[i + W]) : 0; if (so < 0) so = 0;
        const tot = e + w + nn + so; if (tot > hi) { const k = hi / tot; e *= k; w *= k; nn *= k; so *= k; }
      }
      fE[i] = e; fW[i] = w; fN[i] = nn; fS[i] = so;
    }
    let moving = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, out = fE[i] + fW[i] + fN[i] + fS[i];
      let v = f[i] - out; if (x > 0) v += fE[i - 1]; if (x < W - 1) v += fW[i + 1]; if (y > 0) v += fS[i - W]; if (y < H - 1) v += fN[i + W];
      f[i] = v > 0 ? v : 0; moving += out;
      if (f[i] > 0) { // slow or thin snow settles as a deposit
        const sp = out / Math.max(0.05, f[i]);
        if (sp < AV.slow || f[i] < AV.thin) { const d = Math.min(f[i], sp < AV.slow ? AV.dep + f[i] * 0.02 : f[i] * 0.05); f[i] -= d; g.Dp[i] += d; T[i] += d; }
      }
    }
    // dams carry the load of the snow pressing on them and flowing over them
    for (const d of g.dams) {
      if (d.state === "broken" || !d.built.size) continue;
      let load = 0;
      for (const c of d.built) {
        const cx = c % W, cy = (c / W) | 0;
        if (cx > 0 && g.damId[c - 1] !== d.id) load += f[c - 1] * (1 + 6 * fE[c - 1]);
        if (cx < W - 1 && g.damId[c + 1] !== d.id) load += f[c + 1] * (1 + 6 * fW[c + 1]);
        if (cy > 0 && g.damId[c - W] !== d.id) load += f[c - W] * (1 + 6 * fS[c - W]);
        if (cy < H - 1 && g.damId[c + W] !== d.id) load += f[c + W] * (1 + 6 * fN[c + W]);
        load += f[c] * 3; // flowing over the top
      }
      d.hp -= load * AV.loadK;
      if (d.state === "ok" && d.hp < d.max * AV.crack) { d.state = "cracked"; pf.baseDirty = true; }
      if (d.hp <= 0) avBreak(g, d);
    }
    // the chunks and the broken dam pieces ride the flow
    const ride = (p) => { const i = Math.floor(p.y) * W + Math.floor(p.x); if (i < 0 || i >= f.length) return false; const hh = Math.max(0.1, f[i]);
      const vx = (fE[i] - fW[i]) / hh, vy = (fS[i] - fN[i]) / hh, sp = Math.hypot(vx, vy); if (sp > 0.001) { const k = Math.min(0.35, sp * 4) / sp; p.x += vx * k; p.y += vy * k; } p.life++; return f[i] > 0.03 || p.life < 20; };
    g.chunks = g.chunks.filter((p) => ride(p) && p.life < 900);
    g.debris = g.debris.filter((p) => { const keep = ride(p); p.rot += 0.05; return keep || p.life < 60; });
    // the village: a house is hit when the flow around it is deep enough (less with dam pieces in it)
    for (const h of g.houses) {
      if (h.hit) continue;
      let depth = 0; for (const i of h.cells) depth = Math.max(depth, f[i] + Math.max(0, g.Dp[i] - 0.4));
      const near = g.debris.some((p) => Math.hypot(p.x - h.cx - 1, p.y - h.cy - 1) < 2.5);
      if (depth > AV.house * (near ? 0.55 : 1)) { h.hit = true; h.at = g.time; h.byDebris = near; }
    }
    g.quiet = g.trailT <= 0 && moving < 0.03 ? g.quiet + 1 : 0;
    if (g.quiet > AV.sub * 1.5 || g.time > 120) avEnd(g);
  }
  function avEnd(g) {
    for (let i = 0; i < g.f.length; i++) if (g.f[i] > 0) { g.Dp[i] += g.f[i]; g.f[i] = 0; avSetT(g, i); }
    g.phase = "done"; g.running = false;
    const hit = g.houses.filter((h) => h.hit).length, stood = g.dams, held = stood.filter((d) => d.state !== "broken" && d.built.size).length; // a dam never built did not hold
    g.result = { hit, held, dams: stood.length, share: g.cut ? g.cut.share : 0, time: g.time, debris: g.houses.some((h) => h.hit && h.byDebris) };
    pf.baseDirty = true;
    avShowEnd(); avHud(); avHint("");
  }
  // ---- drawing: the same tilted view as the flood game ----------------------------------------------------------------
  const avPY = (y, z) => AV_OFF + y * AV_RY - z * AV_HZ;
  function avCorner(T, x, y) { const xa = Math.max(0, x - 1), xb = Math.min(AV_W - 1, x), ya = Math.max(0, y - 1), yb = Math.min(AV_H - 1, y); return (T[ya * AV_W + xa] + T[ya * AV_W + xb] + T[yb * AV_W + xa] + T[yb * AV_W + xb]) / 4; }
  function avHeight(T, fx, fy) { const x = Math.max(0, Math.min(AV_W - 1e-6, fx)), y = Math.max(0, Math.min(AV_H - 1e-6, fy)), ix = Math.floor(x), iy = Math.floor(y), u = x - ix, v = y - iy;
    return (avCorner(T, ix, iy) * (1 - u) + avCorner(T, ix + 1, iy) * u) * (1 - v) + (avCorner(T, ix, iy + 1) * (1 - u) + avCorner(T, ix + 1, iy + 1) * u) * v; }
  const avProj = (T, fx, fy, lift) => [fx * AV_PX, avPY(fy, avHeight(T, fx, fy) + (lift || 0))];
  function avPick(T, sx, sy) { // the ground point under a screen point (front-most row whose drawn surface covers it)
    const fx = sx / AV_PX; if (fx < 0 || fx >= AV_W) return null;
    const ix = Math.floor(fx), u = fx - ix;
    for (let y = AV_H - 1; y >= 0; y--) {
      const ht = avCorner(T, ix, y) * (1 - u) + avCorner(T, ix + 1, y) * u, hb = avCorner(T, ix, y + 1) * (1 - u) + avCorner(T, ix + 1, y + 1) * u;
      const yt = avPY(y, ht), yb = avPY(y + 1, hb);
      if (yb > yt && sy >= yt && sy < yb) return [fx, y + (sy - yt) / (yb - yt)];
    }
    return null;
  }
  const AV_COL = { 1: [124, 120, 113], 2: [126, 128, 98], 3: [72, 104, 62], 4: [124, 150, 92], 6: [58, 120, 190], 9: [184, 166, 124] };
  function avShade(T, x, y) { const a = avCorner(T, x, y), b = avCorner(T, x + 1, y), c = avCorner(T, x + 1, y + 1), d = avCorner(T, x, y + 1);
    const dzx = ((b + c) - (a + d)) * 0.45, dzy = ((d + c) - (a + b)) * 0.45, nl = Math.hypot(dzx, dzy, 1);
    return [Math.max(0.42, Math.min(1.4, 0.5 + 0.95 * ((dzx * 0.55 + dzy * 0.62 + 0.56) / nl))), a, b, c, d]; }
  function avQuad(b, x, y, col, T, sh) { const [k, a, bb, c, d] = sh || avShade(T, x, y); b.fillStyle = `rgb(${Math.min(255, col[0] * k) | 0},${Math.min(255, col[1] * k) | 0},${Math.min(255, col[2] * k) | 0})`;
    const X0 = x * AV_PX - 0.4, X1 = (x + 1) * AV_PX + 0.4; b.beginPath(); b.moveTo(X0, avPY(y, a) - 0.3); b.lineTo(X1, avPY(y, bb) - 0.3); b.lineTo(X1, avPY(y + 1, c) + 0.6); b.lineTo(X0, avPY(y + 1, d) + 0.6); b.fill(); }
  function avPaint(g) { // the ground and the dams (snow, deposits and the flow are drawn each frame on top)
    const L = avTerrain(), Tg = new Float32Array(AV_W * AV_H);
    for (let i = 0; i < Tg.length; i++) Tg[i] = L.R[i] + L.S0[i] + g.Dm[i];
    if (!pf.base || pf.base.height !== AV_CH) { pf.base = document.createElement("canvas"); pf.base.width = AV_CW; pf.base.height = AV_CH; }
    const b = pf.base.getContext("2d");
    const sky = b.createLinearGradient(0, 0, 0, AV_CH); sky.addColorStop(0, "#1d2c47"); sky.addColorStop(1, "#0b1020"); b.fillStyle = sky; b.fillRect(0, 0, AV_CW, AV_CH);
    for (let y = 0; y < AV_H; y++) {
      for (let x = 0; x < AV_W; x++) {
        const i = y * AV_W + x, di = g.damId[i];
        let col = AV_COL[L.kind[i]] || AV_COL[4];
        if (L.kind[i] === 5) col = (y + (x >> 3)) % 2 ? [176, 158, 86] : [128, 152, 74]; // v88: field rows
        else if (L.kind[i] !== 6 && L.kind[i] !== 9) { // grass → soil on the valley floors → rock (lighter higher up)
          const r = L.rk[i], e = Math.min(1, Math.max(0, (Tg[i] - 25) / 30)), so = L.soilA[i] * 0.55, gr = L.kind[i] === 3 ? [86, 120, 70] : [118, 150, 86];
          const rock = [118 + 40 * e, 114 + 40 * e, 108 + 44 * e], v = 0.92 + 0.16 * L.rnd[i];
          col = [0, 1, 2].map((c) => ((gr[c] * (1 - so) + [150, 124, 90][c] * so) * (1 - r) + rock[c] * r) * v); }
        if (di >= 0) col = AV_DAM[g.dams[di].type].rgb;
        avQuad(b, x, y, col, Tg, L.kind[i] === 6 && di < 0 ? [1, avCorner(Tg, x, y), avCorner(Tg, x + 1, y), avCorner(Tg, x + 1, y + 1), avCorner(Tg, x, y + 1)] : null);
      }
      for (let x = 0; x < AV_W; x++) { // decorations standing on the ground
        const i = y * AV_W + x, k = L.kind[i], tr = L.rnd[i], cx = (x + 0.5) * AV_PX, gy = avPY(y + 0.5, avHeight(Tg, x + 0.5, y + 0.5)), di = g.damId[i];
        if (di >= 0) { const d = g.dams[di];
          if (d.type === 2) { b.fillStyle = "rgba(60,58,54,.55)"; b.fillRect(cx - 3, gy - 2, 2.5, 2); b.fillRect(cx + 0.5, gy - 0.5, 2.5, 2); }
          if (d.type === 3) { b.strokeStyle = "rgba(110,114,120,.8)"; b.lineWidth = 0.8; b.strokeRect(cx - 3.4, gy - 2.2, 6.8, 4); }
          if (d.wallBuilt.has(i)) { b.fillStyle = "#4c4a46"; b.fillRect(x * AV_PX - 0.4, gy + 1.2, AV_PX + 0.8, 2.6); } // the reinforcing wall on the valley side
          if (d.state === "cracked") { b.strokeStyle = "#1a1714"; b.lineWidth = 1.1; b.beginPath(); b.moveTo(cx - 3, gy - 2.5); b.lineTo(cx - 0.5, gy); b.lineTo(cx - 2, gy + 1.5); b.lineTo(cx + 2.5, gy + 3); b.stroke(); }
          continue; }
        if (k === 3 && tr > 0.45) { const rr = 2.2 + tr * 1.6, hh = 3.5 + tr * 3; b.fillStyle = "rgba(10,25,8,.35)"; b.beginPath(); b.ellipse(cx + 1.8, gy + 0.6, rr, rr * 0.45, 0, 0, 7); b.fill();
          b.fillStyle = tr > 0.75 ? "#2d6a3c" : "#3d7f38"; b.beginPath(); b.moveTo(cx - rr, gy - 1); b.lineTo(cx, gy - hh - rr); b.lineTo(cx + rr, gy - 1); b.fill(); }
        else if (k === 1 && tr > 0.86) { b.fillStyle = "rgba(68,66,60,.6)"; b.fillRect(cx - 1.5, gy - 1, 3, 1.6); }
        else if (k === 6 && tr > 0.72) { b.strokeStyle = "rgba(220,240,255,.5)"; b.lineWidth = 0.8; b.beginPath(); b.moveTo(cx - 2, gy); b.lineTo(cx + 2, gy); b.stroke(); }
      }
    }
    for (let x = 0; x < AV_W; x++) { const top = avPY(AV_H, avCorner(Tg, x, AV_H)), rock = avPY(AV_H, L.R[(AV_H - 1) * AV_W + x]);
      b.fillStyle = "#6b4f34"; b.fillRect(x * AV_PX - 0.3, top, AV_PX + 0.6, Math.max(0, rock - top)); b.fillStyle = "#55534e"; b.fillRect(x * AV_PX - 0.3, Math.max(top, rock), AV_PX + 0.6, AV_CH - Math.max(top, rock)); } // the bedrock shows at the front edge
    pf.baseDirty = false;
  }
  function avHouse(c, g, h) { const T = g.T, z = avHeight(T, h.cx + 1, h.cy + 1), x0 = h.cx * AV_PX - 2, x1 = x0 + 20, yb = avPY(h.cy + 2, z), yt = avPY(h.cy, z);
    c.fillStyle = "rgba(0,0,0,.28)"; c.fillRect(x0 + 3, yb, x1 - x0, 2.5);
    c.fillStyle = ["#efe4cc", "#e6d6b8", "#f2ead8"][h.look % 3]; c.fillRect(x0, yb - 7, x1 - x0, 7);
    c.fillStyle = "#5a3b28"; c.fillRect(x0 + (h.look % 2 ? 4 : 13), yb - 5, 3, 5); c.fillStyle = "#7fb3d9"; c.fillRect(x0 + (h.look % 2 ? 12 : 4), yb - 5.5, 3, 2.5);
    c.fillStyle = ["#b5523b", "#9c3f2e", "#6c7488", "#c46a3a"][h.look % 4]; c.beginPath(); c.moveTo(x0 - 1.5, yb - 6); c.lineTo(x1 + 1.5, yb - 6); c.lineTo(x1, yt - 9); c.lineTo(x0, yt - 9); c.fill();
    c.fillStyle = "rgba(0,0,0,.22)"; c.fillRect(x0, yt - 9, x1 - x0, 2.5);
    if (h.hit) { c.fillStyle = "rgba(225,232,240,.85)"; c.fillRect(x0 - 2, yb - 5, x1 - x0 + 4, 6); c.strokeStyle = "#ff6b4a"; c.lineWidth = 2.5; c.strokeRect(x0 - 3, yt - 12, x1 - x0 + 6, yb - yt + 15); }
    else if (g.phase === "done") { c.strokeStyle = "#5fd36a"; c.lineWidth = 2; c.strokeRect(x0 - 3, yt - 12, x1 - x0 + 6, yb - yt + 15); } }
  function avRender(now) {
    const cv = $("story").querySelector(".av-map"); if (!cv || !pf.g) return;
    const g = pf.g, c = cv.getContext("2d"), T = g.T, v = pf.view, still = reducedMotion.matches;
    if (pf.baseDirty || !pf.base) avPaint(g);
    c.setTransform(1, 0, 0, 1, 0, 0); c.fillStyle = "#0b1020"; c.fillRect(0, 0, cv.width, cv.height);
    c.setTransform(v.s, 0, 0, v.s, -v.x * v.s, -v.y * v.s);
    c.drawImage(pf.base, 0, 0);
    // snow, deposits and the flow, each on its own surface (back to front)
    const prev = pf.gest && pf.gest.kind === "cut" ? new Set(pf.gest.cut ? pf.gest.cut.cells : []) : null;
    for (let y = 0; y < AV_H; y++) for (let x = 0; x < AV_W; x++) {
      const i = y * AV_W + x, sn = g.Sn[i], dp = g.Dp[i], fl = g.f[i];
      if (sn < 0.06 && dp < 0.06 && fl < 0.04) continue;
      const sh = avShade(T, x, y); sh[0] = 0.55 + 0.45 * sh[0]; // snow is bright even where it faces away from the light
      let col;
      if (fl >= 0.04) col = fl > 0.6 ? [214, 226, 240] : [226, 234, 244];                       // moving snow
      else if (sn >= 0.06) col = prev && prev.has(i) ? [255, 168, 92] : [246, 250, 255];          // the snow mass (orange: the piece that will break away)
      else col = [196, 200, 206];                                                                  // settled snow and debris
      avQuad(c, x, y, col, T, sh);
      if (fl >= 0.04 && !still && L_rnd(i) > 0.7) { c.fillStyle = "rgba(120,140,170,.35)"; c.fillRect(x * AV_PX + 1, avPY(y + 0.5, T[i] + fl), 3, 1); }
    }
    // the dams stand above the snow: a wall in the type's colour, a darker reinforcing wall in front, cracks when weakened.
    // v88: a planned cell is a dashed outline; a cell being built rises; the reinforcing wall rises as its own row in front.
    for (const d of g.dams) { if (d.state === "broken") continue; const rgb = AV_DAM[d.type].rgb, full = AV_DAM[d.type].h * AV_HZ;
      for (const i of d.cells.slice().sort((p, q) => p - q)) { const x = i % AV_W, y = (i / AV_W) | 0, X = x * AV_PX - 0.6, Wd = AV_PX + 1.2;
        if (!d.built.has(i)) { const bot = avPY(y + 1, T[i]) + 1, p = d.prog.get(i) || 0;
          c.setLineDash([2, 2]); c.lineWidth = 1 / v.s; c.strokeStyle = `rgba(${rgb.join(",")},.95)`; c.strokeRect(X + 0.5, bot - full - 2.5, Wd - 1, full + 2.5); c.setLineDash([]);
          c.fillStyle = `rgba(${rgb.join(",")},.18)`; c.fillRect(X + 0.5, bot - full - 2.5, Wd - 1, full + 2.5);
          if (p > 0) { const hh = (full + 2.5) * p; c.fillStyle = `rgb(${rgb.map((q) => q * 0.8 | 0).join(",")})`; c.fillRect(X, bot - hh, Wd, hh); c.fillStyle = `rgb(${rgb.join(",")})`; c.fillRect(X, bot - hh, Wd, 1.5); }
          continue; }
        const top = avPY(y + 0.5, T[i] + Math.max(0, g.f[i] - 0.3)), bot = avPY(y + 1, T[i] - g.Dm[i] - g.Dp[i]) + 1;
        c.fillStyle = "#16130f"; c.fillRect(X - 0.6, top - 3.3, Wd + 1.2, Math.max(3, bot - top) + 4.1); // a dark outline so the dam stands out on rock and snow
        c.fillStyle = `rgb(${rgb.map((q) => q * 0.86 | 0).join(",")})`; c.fillRect(X, top, Wd, Math.max(3, bot - top));
        c.fillStyle = `rgb(${rgb.map((q) => Math.min(255, q * 1.12) | 0).join(",")})`; c.fillRect(X, top - 2.5, Wd, 3);
        if (d.type === 2) { c.fillStyle = "rgba(50,48,44,.55)"; c.fillRect(X + 1, top + 2, 3, 2); c.fillRect(X + 4.5, top + 5, 3, 2); }
        if (d.type === 3) { c.strokeStyle = "rgba(90,94,100,.9)"; c.lineWidth = 0.7; c.strokeRect(X + 0.6, top + 0.6, Wd - 1.2, Math.max(2, bot - top - 1.2)); }
        const wp = d.wallBuilt.has(i) ? 1 : d.wallProg.get(i) || 0, wy = bot + 6, wh = 7; // the wall: its own row in front of the dam, rising as it is built
        if (wp > 0) { const hh = wh * wp; c.fillStyle = "#16130f"; c.fillRect(X - 0.5, wy - hh - 0.6, Wd + 1, hh + 1.2); c.fillStyle = "#8a7a63"; c.fillRect(X, wy - hh, Wd, hh); c.fillStyle = "#b3a184"; c.fillRect(X, wy - hh, Wd, 1.4);
          c.fillStyle = "rgba(40,32,24,.55)"; if (hh > 3.5) { c.fillRect(X, wy - hh + 3.4, Wd, 0.6); c.fillRect(X + (y % 2 ? 2 : 5.5), wy - hh + 1.4, 0.6, 2); } c.fillRect(X + (y % 2 ? 5.5 : 2), wy - Math.min(hh, 3.2), 0.6, Math.min(hh, 3.2)); }
        else if (d.wall) { c.setLineDash([2, 2]); c.lineWidth = 1 / v.s; c.strokeStyle = "rgba(240,226,200,.95)"; c.strokeRect(X + 0.5, wy - wh, Wd - 1, wh); c.setLineDash([]); }
        if (d.state === "cracked") { c.strokeStyle = "#140f0c"; c.lineWidth = 1.2; c.beginPath(); c.moveTo(X + 1.5, top - 2); c.lineTo(X + 4, top + 2); c.lineTo(X + 2.5, top + 4.5); c.lineTo(X + 6.5, bot - 1); c.stroke(); } } }
    // chunks of snow and broken dam pieces riding the flow
    for (const p of g.chunks) { const [px, py] = avProj(T, p.x, p.y, 0.8); c.fillStyle = "#fbfdff"; c.strokeStyle = "rgba(90,110,140,.6)"; c.lineWidth = 0.7; c.fillRect(px - p.s * 2, py - p.s * 2, p.s * 4, p.s * 3.2); c.strokeRect(px - p.s * 2, py - p.s * 2, p.s * 4, p.s * 3.2); }
    for (const p of g.debris) { const [px, py] = avProj(T, p.x, p.y, 0.8); c.save(); c.translate(px, py); c.rotate(p.rot); c.fillStyle = `rgb(${AV_DAM[p.type].rgb.join(",")})`; c.fillRect(-p.s * 3.6, -p.s * 2.4, p.s * 7.2, p.s * 4.8); c.strokeStyle = "#1b1814"; c.lineWidth = 1.3; c.strokeRect(-p.s * 3.6, -p.s * 2.4, p.s * 7.2, p.s * 4.8); c.restore(); }
    const fig = g.houses.map((h) => [h.cy + 1.9, () => avHouse(c, g, h)]).concat(g.vil ? g.vil.list.filter((p) => !p.inside).map((p) => [p.y, () => svDraw(c, g, p)]) : []); // v88: houses and villagers, back to front
    for (const [, draw] of fig.sort((a, b) => a[0] - b[0])) draw();
    if (g.vil) svDrawParts(c, g);
    // the selected dam
    if (pf.sel != null && g.dams[pf.sel] && g.dams[pf.sel].state !== "broken") { c.strokeStyle = "#ffd23f"; c.lineWidth = 2.5 / v.s; for (const i of g.dams[pf.sel].cells) { const [px, py] = avProj(T, (i % AV_W) + 0.5, ((i / AV_W) | 0) + 0.5, 0.2); c.beginPath(); c.ellipse(px, py, 5, 3.6, 0, 0, 7); c.stroke(); } }
    // previews: the cut line, the dam line, the snow circle
    const G = pf.gest;
    if (G && (G.kind === "cut" || G.kind === "dam") && G.pts.length > 1) {
      c.setLineDash(G.kind === "cut" ? [7, 5] : []); c.lineWidth = (G.kind === "cut" ? 3 : 5) / v.s; c.strokeStyle = G.kind === "cut" ? "#ff4d4d" : `rgb(${AV_DAM[pf.dtype].rgb.join(",")})`;
      c.beginPath(); G.pts.forEach(([x, y], k) => { const [px, py] = avProj(T, x, y, 0.3); if (k) c.lineTo(px, py); else c.moveTo(px, py); }); c.stroke(); c.setLineDash([]);
      if (G.kind === "dam") { c.lineWidth = 1.2 / v.s; c.strokeStyle = "rgba(0,0,0,.7)"; c.stroke(); }
    }
    if (g.cut && g.phase !== "done") { c.setLineDash([4, 4]); c.lineWidth = 2 / v.s; c.strokeStyle = "rgba(255,77,77,.8)"; c.beginPath(); for (const i of g.cut.line) { const [px, py] = avProj(T, (i % AV_W) + 0.5, ((i / AV_W) | 0) + 0.5, 0.2); c.moveTo(px - 3, py); c.lineTo(px + 3, py); } c.stroke(); c.setLineDash([]); }
    if (pf.aim && pf.tool === "snow") { const [px, py] = avProj(T, pf.aim[0], pf.aim[1]); c.beginPath(); c.ellipse(px, py, 1.8 * AV_PX, 1.8 * AV_RY, 0, 0, 7); c.fillStyle = pf.adding && pf.adding.live ? "rgba(220,240,255,.45)" : "rgba(191,227,255,.22)"; c.fill();
      c.lineWidth = 5 / v.s; c.strokeStyle = "rgba(0,0,0,.6)"; c.stroke(); c.lineWidth = 2.6 / v.s; c.strokeStyle = "#d6eeff"; c.stroke(); }
    c.setTransform(1, 0, 0, 1, 0, 0);
  }
  const L_rnd = (i) => avTerrain().rnd[i];
  // ---- villagers (v88) — they build the dams; otherwise drawing only: they never change the snow, the flow or the result ------
  // Each villager belongs to a house. Before the flow some work in the fields (blue clothes, hoe) or on the trees near the
  // village (black and red, axe). A drawn dam or reinforcing wall is only a plan at first: free villagers come with a sack in
  // the material's colour, empty it at their part of the line and build it cell by cell; a cell holds the snow only when it is
  // finished. Flow or snow pieces close by: the work is dropped and the villager runs to dry, higher ground chosen from the
  // flow now on the map; the part they left waits for the next free worker once it is safe. A hit house: whoever is inside
  // comes out; nobody goes back to it; they gather on a safe, high open place. A dam that breaks sends nearby workers away.
  const SV_SKIN = ["#f1c8a0", "#d9a066", "#a8714a"], SV_HAIR = ["#3b2a20", "#7a4a2a", "#d8b46a", "#1e1e1e"];
  const SV_ROLES = ["field", "field", "field", "field", "tree", "tree", "tree", "home", "home", "home", "home", "home", "home", "home"];
  const svSack = (m) => (m === "wall" ? "#4f4b45" : `rgb(${AV_DAM[m].rgb.join(",")})`);
  function svDoor(h) { const off = h.look % 2 ? 4 : 13; return [(h.cx * AV_PX - 2 + off + 1.5) / AV_PX, h.cy + 1.95]; }
  function svInit(g) {
    const r = fiRng(8801), L = avTerrain(), fields = [], trees = [];
    for (let y = 60; y < AV_H; y++) for (let x = 20; x < 100; x++) {
      const i = y * AV_W + x;
      if (L.kind[i] === 5) fields.push([x + 0.5, y + 0.5]);
      else if (L.kind[i] === 3 && L.rnd[i] > 0.45 && Math.hypot(x - 60, y - 88) < 26) trees.push([x + 0.5, y + 0.5]);
    }
    const list = SV_ROLES.map((role, k) => {
      const home = k % g.houses.length, [dx, dy] = svDoor(g.houses[home]);
      return { id: k, home, role, x: dx, y: dy, inside: true, homeless: false, state: role === "home" ? "home" : "wait", wait: 0.4 + k * 0.5 + r() * 0.8,
        skin: SV_SKIN[(r() * 3) | 0], hair: SV_HAIR[(r() * 4) | 0], hat: r() < 0.55 ? (role === "field" ? "#e2c56a" : role === "tree" ? "#c8302e" : "#7a5a3a") : null,
        shirt: role === "field" ? ["#3d6fc4", "#5a8ed8", "#2f5596"][k % 3] : role === "tree" ? "#1f1f1f" : ["#8a6a3a", "#5b7a4a", "#9a4f3a", "#6a6a8a"][k % 4],
        pants: role === "field" ? "#24406e" : role === "tree" ? "#b02a28" : "#4a3a2a",
        speed: 2.4 + r() * 0.9, step: 6 + r() * 3, phase: r() * 6, face: 1, t: 0, job: null, then: null, target: null, chk: r() * 0.25 };
    });
    return { list, fields, trees, parts: [], meet: null, disp: 0 };
  }
  const svCell = (x, y) => Math.max(0, Math.min(AV_H - 1, Math.floor(y))) * AV_W + Math.max(0, Math.min(AV_W - 1, Math.floor(x)));
  function svWet(g, x, y, rad, lim) { // moving snow deeper than lim, or snow pieces / dam pieces, within rad cells
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      const X = Math.floor(x) + dx, Y = Math.floor(y) + dy; if (X < 0 || Y < 0 || X >= AV_W || Y >= AV_H) continue;
      if (g.f[Y * AV_W + X] > (lim || 0.03)) return true;
    }
    const near = (p) => Math.abs(p.x - x) < rad && Math.abs(p.y - y) < rad;
    return g.chunks.some(near) || g.debris.some(near);
  }
  function svPathOk(g, ax, ay, bx, by) { const n = Math.ceil(Math.hypot(bx - ax, by - ay)); for (let k = 0; k <= n; k++) { const t2 = k / Math.max(1, n), i = svCell(ax + (bx - ax) * t2, ay + (by - ay) * t2); if (g.f[i] > 0.05 || g.Sn[i] > 0.4) return false; } return true; }
  function svClear(g, ax, ay, bx, by, skip) { const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 2); for (let k = 0; k <= n; k++) { const t2 = k / Math.max(1, n); if (t2 * Math.hypot(bx - ax, by - ay) < (skip || 0)) continue; const i = svCell(ax + (bx - ax) * t2, ay + (by - ay) * t2); if (g.f[i] > 0.04 || g.Sn[i] > 0.4) return false; } return true; }
  function svGo(v, x, y, then, run) { v.target = [x, y]; v.state = run ? "flee" : "walk"; v.then = then; }
  function svOut(g, v) { if (v.inside) { v.inside = false; [v.x, v.y] = svDoor(g.houses[v.home]); } }
  function svHome(g, v) {
    if (v.homeless) return svToMeet(g, v);
    const [dx, dy] = svDoor(g.houses[v.home]);
    svGo(v, dx, dy, () => { v.inside = true; v.state = "home"; });
  }
  function svDaily(g, v) { // the day's work, round and round until something else happens
    const V = g.vil;
    if (g.phase !== "build") return svHome(g, v); // once the snow is moving, nobody starts field work
    if (v.role === "field" && V.fields.length) { const [fx, fy] = V.fields[(Math.random() * V.fields.length) | 0]; svGo(v, fx, fy, () => { v.state = "tend"; v.t = 3 + Math.random() * 3; v.then = () => svDaily(g, v); }); }
    else if (v.role === "tree" && V.trees.length) { const [tx, ty] = V.trees[(Math.random() * V.trees.length) | 0]; svGo(v, tx - 0.8, ty + 0.5, () => { v.state = "chop"; v.face = 1; v.t = 4 + Math.random() * 3; v.then = () => svDaily(g, v); }); }
    else svHome(g, v);
  }
  function svMeetPoint(g, v) { // a safe, high, open place near the village for those without a home, on their side of the valley
    const V = g.vil, L = avTerrain(), side = v.x < 60 ? "w" : "e"; V.meet = V.meet || {};
    const m0 = V.meet[side]; if (m0 && !svWet(g, m0[0], m0[1], 4, 0.02) && svClear(g, v.x, v.y, m0[0], m0[1], 1.5)) return m0;
    let best = null, bs = -1e9;
    for (let y = 66; y < AV_H - 2; y += 2) for (let x = side === "w" ? 26 : 62; x < (side === "w" ? 58 : 94); x += 2) {
      const i = y * AV_W + x, k = L.kind[i];
      if (!(k === 4 || k === 5 || k === 9) || g.plan[i] >= 0 || L.dvA[i] < 3) continue;
      if (g.houses.some((h) => Math.abs(h.cx - x) < 3 && Math.abs(h.cy - y) < 3)) continue;
      if (svWet(g, x, y, 4, 0.02) || !svClear(g, v.x, v.y, x + 0.5, y + 0.5, 1.5)) continue;
      const s2 = g.T[i] - 0.06 * Math.hypot(x - v.x, y - v.y);
      if (s2 > bs) { bs = s2; best = [x + 0.5, y + 0.5]; }
    }
    if (best) V.meet[side] = best;
    return best;
  }
  function svToMeet(g, v) {
    const m = svMeetPoint(g, v); if (!m) return svFleeOnly(g, v);
    const k = v.id, a = k * 2.4, rr = 0.8 + (k % 3) * 0.55;
    svGo(v, m[0] + Math.cos(a) * rr, m[1] + Math.sin(a) * rr * 0.7, () => { v.state = "meet"; }, svWet(g, v.x, v.y, 5));
  }
  function svDrop(g, v) { // the villager leaves a job: the part not finished waits for the next worker
    const J = v.job; v.job = null; if (!J || !J.task) return;
    const T = J.task; T.worker = null; if (T.cur != null) { (T.kind === "wall" ? T.d.wallProg : T.d.prog).delete(T.cur); T.cur = null; }
  }
  function svFlee(g, v) { // the driest, highest reachable ground nearby, away from the moving snow now on the map
    const L = avTerrain(); let best = null, bs = -1e9;
    for (let k = 0; k < 24; k++) for (const d of [4, 7, 11, 15]) {
      const a = (k / 24) * 6.283, x = v.x + Math.cos(a) * d, y = v.y + Math.sin(a) * d;
      if (x < 1 || y < 1 || x >= AV_W - 1 || y >= AV_H - 1) continue;
      const i = svCell(x, y); if (g.Sn[i] > 0.15 || svWet(g, x, y, 2, 0.02) || !svClear(g, v.x, v.y, x, y, 1.5)) continue; // never across the moving snow
      let near = 0; for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (g.f[svCell(x + dx, y + dy)] > 0.02) near++;
      const s = 0.25 * g.T[i] + 0.12 * d - 0.6 * near + 0.5 * Math.min(8, L.dvA[i]);
      if (s > bs) { bs = s; best = [x, y]; }
    }
    svDrop(g, v);
    if (!best) return svToMeet(g, v);
    svGo(v, best[0], best[1], () => { v.state = "safe"; v.t = 3; }, true);
  }
  function svFleeOnly(g, v) { if (v.state !== "flee") { v.state = "safe"; v.t = 1; } } // nowhere better to go now: stay and look again shortly
  function svFree(v) { return !v.homeless && !v.job && v.state !== "flee" && v.state !== "safe" && v.state !== "meet"; }
  function svDispatch(g) { // free villagers take the parts of planned dams and walls that are safe to reach
    const V = g.vil;
    for (const T of g.tasks) {
      if (T.worker || T.next >= T.cells.length || T.d.state === "broken") continue;
      const rest = T.cells.slice(T.next);
      if (T.kind === "wall" && rest.some((i) => !T.d.built.has(i))) continue; // the wall goes up where the dam is finished
      const [x0, y0] = [(rest[0] % AV_W) + 0.5, ((rest[0] / AV_W) | 0) + 1.3];
      if (rest.some((i) => svWet(g, (i % AV_W) + 0.5, ((i / AV_W) | 0) + 0.5, 5, 0.02))) continue;
      let best = null, bd = 1e9;
      for (const v of V.list) {
        if (!svFree(v)) continue;
        const [sx, sy] = v.inside ? svDoor(g.houses[v.home]) : [v.x, v.y];
        if (!svPathOk(g, sx, sy, x0, y0)) continue;
        const dd = Math.hypot(sx - x0, sy - y0) + (v.role === "home" ? 0 : 6);
        if (dd < bd) { bd = dd; best = v; }
      }
      if (!best) continue;
      const v = best; T.worker = v.id; v.job = { kind: "carry", task: T, mat: T.kind === "wall" ? "wall" : T.d.type, going: true }; svOut(g, v);
      svGo(v, x0, y0, () => { v.job.going = false; v.state = "drop"; v.face = -1; v.t = 0.4; v.then = () => { v.state = "empty"; v.t = 0.9; v.then = () => svNextCell(g, v); }; });
    }
  }
  function svNextCell(g, v) { // build the next cell of this part, walking along the line
    const J = v.job, T = J && J.task;
    if (!T || T.d.state === "broken") { svDrop(g, v); return svHome(g, v); }
    if (T.next >= T.cells.length) { T.worker = null; v.job = null; return svWet(g, v.x, v.y, 6) ? svFlee(g, v) : svHome(g, v); }
    const i = T.cells[T.next], x = (i % AV_W) + 0.5, y = ((i / AV_W) | 0) + 1.3;
    svGo(v, x, y, () => { T.cur = i; v.state = "build"; v.face = 1; v.t = 0.65; v.then = () => { avCellDone(g, T.d, i, T.kind === "wall"); T.cur = null; T.next++; svNextCell(g, v); }; });
  }
  function svBroke(g, d) { // a dam broke: workers near it run
    const near = (v) => d.cells.some((i) => Math.hypot((i % AV_W) + 0.5 - v.x, ((i / AV_W) | 0) + 0.5 - v.y) < 8);
    for (const v of g.vil.list) if (!v.inside && v.state !== "flee" && (near(v) || (v.job && v.job.task && v.job.task.d === d))) { svFlee(g, v); v.escape = 1.2; }
  }
  function svUpdate(g, dt) {
    const V = g.vil; if (!V || !dt) return;
    if ((V.disp -= dt) <= 0) { V.disp = 0.3; svDispatch(g); }
    for (const v of V.list) {
      v.phase += dt * v.step;
      const hs = g.houses[v.home];
      if (hs.hit && !v.homeless) { // the house is hit: out of the door, and never back to it
        v.homeless = true;
        if (v.inside) { v.inside = false; [v.x, v.y] = svDoor(hs); svDrop(g, v); v.escape = 1.2; svToMeet(g, v); }
        else if (!v.job && v.state !== "flee") svToMeet(g, v);
      }
      if (!v.inside && v.state !== "flee" && (v.chk -= dt) <= 0) { v.chk = 0.2; if (svWet(g, v.x, v.y, 5, 0.03)) { svFlee(g, v); v.escape = 1.2; } }
      if (v.escape) v.escape = Math.max(0, v.escape - dt);
      if (v.state === "wait") { if ((v.wait -= dt) <= 0) { svOut(g, v); svDaily(g, v); } }
      else if (v.state === "walk" || v.state === "flee") {
        const [tx, ty] = v.target, dx = tx - v.x, dy = ty - v.y, d = Math.hypot(dx, dy), s = v.speed * dt * (v.state === "flee" ? 1.9 : 1);
        if (Math.abs(dx) > 0.05) v.face = dx > 0 ? 1 : -1;
        if (d <= s) { v.x = tx; v.y = ty; const f = v.then; v.then = null; v.state = "idle"; if (f) f(); }
        else { v.x += (dx / d) * s; v.y += (dy / d) * s; }
      } else if (v.state === "tend" || v.state === "chop" || v.state === "drop" || v.state === "empty" || v.state === "build" || v.state === "safe") {
        if (v.state === "build" && v.job) { const T = v.job.task, pm = T.kind === "wall" ? T.d.wallProg : T.d.prog; if (T.cur != null) pm.set(T.cur, Math.min(1, (pm.get(T.cur) || 0) + dt / 0.65)); }
        if ((v.state === "empty" || v.state === "build") && v.job && Math.random() < dt * 12) V.parts.push({ x: v.x + 0.2, y: v.y - 0.7, vx: (Math.random() - 0.5) * 5, vy: -2 - Math.random() * 3, t: 0, life: 0.45, col: svSack(v.job.mat) });
        if ((v.t -= dt) <= 0) {
          if (v.state === "safe") { if (v.homeless) svToMeet(g, v); else if (!svWet(g, ...svDoor(hs), 4, 0.03)) svHome(g, v); else v.t = 2; }
          else { const f = v.then; v.then = null; v.state = "idle"; if (f) f(); }
        }
      } else if (v.state === "idle" && !v.job) { if (v.homeless) svToMeet(g, v); else svHome(g, v); }
    }
    V.parts = V.parts.filter((p) => (p.t += dt) < p.life);
  }
  // ---- drawing a villager: a tiny pixel figure (about as tall as a door), as in the flood game ----
  function svDraw(c, g, v) {
    if (v.inside) return;
    const [px, py] = avProj(g.T, v.x, v.y), u = 0.6, f = v.face, moving = v.state === "walk" || v.state === "flee";
    const step = Math.floor(v.phase) % 2, bob = moving ? step * 0.3 : 0, bend = v.state === "tend" || v.state === "empty" || v.state === "build" ? 1 : 0;
    const P = (x, y, w, h, col) => { c.fillStyle = col; c.fillRect(px + (f > 0 ? x : -x - w) * u, py + (y - 9) * u - bob, w * u, h * u); };
    c.fillStyle = "rgba(0,0,0,.3)"; c.beginPath(); c.ellipse(px, py, 1.9, 0.7, 0, 0, 7); c.fill();
    if (v.job && v.job.going) { const s = svSack(v.job.mat); P(-5, 2, 4, 6, "#2a2018"); P(-4.6, 2.4, 3.2, 5.2, s); P(-4.6, 2.4, 3.2, 1, "rgba(255,255,255,.25)"); P(-3.4, 1.4, 1, 1.2, "#2a2018"); } // a full sack on the back
    const hy = bend;
    if (v.hat) { P(-2, 0 + hy, 4, 1, v.hat); P(-3, 1 + hy, 6, 1, v.hat); } else { P(-2, 0 + hy, 4, 1, v.hair); P(-2, 1 + hy, 4, 1, v.hair); }
    P(-2, 2 + hy, 1, 1, v.hair); P(-1, 2 + hy, 2, 2, v.skin); P(1, 2 + hy, 1, 1, v.hair); P(0, 2 + hy, 1, 1, v.skin);
    P(-2, 4, 4, 3, v.shirt);
    if (v.role === "tree") { P(-1, 4, 1, 1, "#c8302e"); P(1, 5, 1, 1, "#c8302e"); P(-2, 6, 1, 1, "#c8302e"); } // black and red check
    const arm = v.state === "flee" ? -1 : 0; P(-3, 4 + arm, 1, 2, v.shirt); P(2, 4 + arm, 1, 2, v.shirt); P(-3, 6 + arm, 1, 1, v.skin); P(2, 6 + arm, 1, 1, v.skin);
    P(-2, 7, 4, 1, v.pants);
    if (moving) { if (step) { P(-2, 8, 1, 1, v.pants); P(1, 8, 1, 1, "#2b1d14"); } else { P(-1, 8, 1, 1, "#2b1d14"); P(0, 8, 1, 1, v.pants); } }
    else { P(-2, 8, 1, 1, "#2b1d14"); P(1, 8, 1, 1, "#2b1d14"); }
    const sw = Math.sin(v.phase * 2.2), line = (x0, y0, x1, y1, col) => { for (let k = 0; k <= 4; k++) P(x0 + ((x1 - x0) * k) / 4, y0 + ((y1 - y0) * k) / 4, 1, 1, col); };
    if (v.state === "tend" || (v.role === "field" && moving && !v.job && v.state !== "flee")) { const ty = v.state === "tend" ? 2 + sw * 2 : 1; line(2, 6, 4, ty, "#8a6a3a"); P(4, ty + (v.state === "tend" ? 1 : 0), 2, 1, "#8f8f8f"); }
    else if (v.state === "chop" || (v.role === "tree" && moving && !v.job && v.state !== "flee")) { const ty = v.state === "chop" ? 1 + sw * 2.5 : 2; line(2, 6, 4, ty, "#6b4a2a"); P(4, ty - 1, 1, 2, "#9a9a9a"); }
    else if (v.state === "build") { const ty = 3 + sw * 2; line(2, 6, 3, ty, "#6b4a2a"); P(3, ty - 1, 2, 1.5, "#7a7a7a"); } // a small mallet
    if ((v.state === "drop" || v.state === "empty") && v.job) { const s = svSack(v.job.mat); P(3, 4.6, 4, 4.4, "#2a2018"); P(3.4, 5, 3.2, 3.6, s); if (v.state === "empty") P(6, 6.4, 1.2, 1.6, s); }
    if (v.state === "flee" || v.escape) { c.fillStyle = "#ffd23f"; c.fillRect(px - 0.3, py - 9 * u - 2.8 - bob, 0.6, 1.5); c.fillRect(px - 0.3, py - 9 * u - 1 - bob, 0.6, 0.5); } // "!"
  }
  function svDrawParts(c, g) { for (const p of g.vil.parts) { const [px, py] = avProj(g.T, p.x, p.y); c.fillStyle = p.col; c.fillRect(px + p.vx * p.t, py - 3 + p.vy * p.t + 9 * p.t * p.t, 0.9, 0.9); } }
  // ---- loop, HUD, panel ------------------------------------------------------------------------------------------------
  function pfStop() { if (pf.raf) cancelAnimationFrame(pf.raf); pf.raf = 0; pf.pointers.clear(); pf.gest = null; pf.pinch = null; pf.pan = null; pf.adding = null; }
  function avKick() { if (!pf.raf && pf.open) { pf.last = 0; pf.raf = requestAnimationFrame(avLoop); } }
  function avLoop(now) {
    pf.raf = 0;
    if (!pf.open || $("story").hidden || !pf.g) return;
    const dt = pf.last ? Math.min(0.1, (now - pf.last) / 1000) : 0; pf.last = now;
    const g = pf.g;
    if (pf.adding && pf.adding.live && g.phase !== "done") { if (avAddSnow(g, pf.adding.x, pf.adding.y, AV.add * dt)) pf.added = (pf.added || 0) + AV.add * dt; } // adding snow works while paused too
    if (g.running || g.phase === "done") svUpdate(g, dt); // v88: villagers and building stop while paused
    if (g.phase === "flow" && g.running) { pf.acc += dt * AV.sub; while (pf.acc >= 1 && g.phase === "flow") { pf.acc -= 1; avStep(g); } }
    avHud(); avRender(now);
    pf.raf = requestAnimationFrame(avLoop);
  }
  const avClock = (s) => { const v = Math.round(s * AV.scale); return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`; };
  let avHudLast = "";
  function avHud() {
    const box = $("story"), g = pf.g; if (!g || !box.querySelector(".av-hud")) return;
    const hit = g.houses.filter((h) => h.hit).length, phase = g.phase === "build" ? (g.running ? t("Build dams, then cut the snow") : t("Paused")) : g.phase === "flow" ? (g.running ? t("The snow is flowing") : t("Paused")) : t("Finished");
    const live = g.dams.filter((d) => d.state !== "broken"), want = live.reduce((a, d) => a + d.cells.length * (d.wall ? 2 : 1), 0), have = live.reduce((a, d) => a + d.built.size + d.wallBuilt.size, 0);
    const bp = want && have < want ? Math.floor((have / want) * 100) : null, sd = pf.sel != null ? g.dams[pf.sel] : null;
    const key = [phase, avClock(g.time), hit, Math.round(g.budget), g.running, g.phase, pf.sel, I.lang, bp, sd && Math.round(sd.hp), sd && sd.built.size + sd.wallBuilt.size].join("|"); if (key === avHudLast) return; avHudLast = key;
    box.querySelector(".av-phase").textContent = phase; box.querySelector(".av-time").textContent = avClock(g.time);
    box.querySelector(".av-houses").textContent = t("{n}/{total} houses safe", { n: g.houses.length - hit, total: g.houses.length });
    box.querySelector(".av-budget").textContent = t("Budget {n}", { n: Math.round(g.budget) });
    const run = box.querySelector(".av-run"); run.hidden = g.phase === "done"; run.textContent = g.running ? t("Pause") : t("Continue");
    const bl = box.querySelector(".av-build"); bl.hidden = bp == null; if (bp != null) bl.textContent = t("Building {p}%", { p: bp });
    const again = box.querySelector(".av-cutagain"); again.hidden = !(g.phase === "build" && g.replayCut);
    const sel = box.querySelector(".av-sel"), d = pf.sel != null ? g.dams[pf.sel] : null;
    sel.hidden = !(d && pf.tool === "dam" && d.state !== "broken" && g.phase !== "done");
    if (!sel.hidden) {
      sel.querySelector(".av-sel-info").textContent = t("Selected dam: {type} · strength {p}%{wall}", { type: avDamName(d.type), p: d.max > 0 ? Math.max(0, Math.round((d.hp / d.max) * 100)) : 0,
        wall: (d.wall ? " · " + t("reinforced") : "") + (avDone(d) < 1 || (d.wall && d.wallBuilt.size < d.cells.length) ? " · " + t("built {p}%", { p: Math.floor(((d.built.size + d.wallBuilt.size) / (d.cells.length * (d.wall ? 2 : 1))) * 100) }) : "") });
      const b = sel.querySelector(".av-wall"); b.textContent = t("Add a reinforcing wall (cost {n})", { n: avWallCost(d) }); b.disabled = d.wall || avWallCost(d) > g.budget;
    }
  }
  const avDamName = (k) => (k === 1 ? t("Snow wall") : k === 2 ? t("Stone dam") : t("Concrete dam"));
  function avHint(text) { const el = $("story").querySelector(".av-hint"); if (el) el.textContent = text; }
  function avTools() {
    const box = $("story");
    box.querySelectorAll(".av-tool").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.v === pf.tool)));
    box.querySelectorAll(".av-opt").forEach((el) => { el.hidden = el.dataset.for !== pf.tool; });
    box.querySelectorAll(".av-type").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.v) === pf.dtype)));
    avHudLast = ""; avHud();
  }
  function avShowEnd() {
    const box = $("story"), el = box.querySelector(".av-end"), g = pf.g; if (!el) return;
    if (!g || !g.result) { el.hidden = true; return; }
    const r = g.result, ok = r.hit === 0, size = r.share < 0.12 ? t("small") : r.share < 0.3 ? t("medium") : t("large");
    const lines = [t("Piece cut: {size} ({p}% of the snow mass)", { size, p: I.fmt.num(Math.round(r.share * 100), 0) }),
      t("Dams that held: {n} of {total}", { n: r.held, total: r.dams }),
      t("Houses hit: {n} of {total}", { n: r.hit, total: g.houses.length })];
    if (r.debris) lines.push(t("Pieces of a broken dam travelled with the flow and made it more damaging."));
    if (pf.prevHouses != null && g.replayCut) { const dd = pf.prevHouses - r.hit; lines.push(dd > 0 ? t("This time {n} fewer houses were hit.", { n: dd }) : dd < 0 ? t("This time {n} more houses were hit.", { n: -dd }) : t("The same number of houses were hit as last time.")); }
    el.innerHTML = `<h3>${esc(ok ? t("You protected the village!") : t("The flow reached the village"))}</h3><ul>${lines.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` +
      `<div class="av-end-btns"><button type="button" class="btn btn-primary av-again">${esc(t("Try again with the same piece"))}</button><button type="button" class="btn av-new">${esc(t("New round"))}</button></div>`;
    el.hidden = false; el.classList.toggle("ok", ok);
    el.querySelector(".av-again").addEventListener("click", () => { pf.prevHouses = r.hit; avNew(pf.lastCut); el.hidden = true; pf.tool = "dam"; avTools(); avHint(t("Same land, same piece: change the dams, then press “Cut the same piece”.")); });
    el.querySelector(".av-new").addEventListener("click", () => { pf.prevHouses = null; pf.lastCut = null; avNew(null); el.hidden = true; pf.tool = "dam"; avTools(); avHint(t("Build dams in the valleys, cut a piece of snow and protect the village.")); });
  }
  function avClampView() { const v = pf.view; if (!isFinite(v.s) || !isFinite(v.x) || !isFinite(v.y)) { v.s = 1; v.x = 0; v.y = 0; } v.s = Math.max(1, Math.min(5, v.s)); v.x = Math.max(0, Math.min(AV_CW - AV_CW / v.s, v.x)); v.y = Math.max(0, Math.min(AV_CH - AV_CH / v.s, v.y)); }
  function avZoom(f, px, py) { const v = pf.view, wx = v.x + px / v.s, wy = v.y + py / v.s; v.s *= f; avClampView(); v.x = wx - px / v.s; v.y = wy - py / v.s; avClampView(); }
  function openFlow(restore) {
    if (!story || $("story").hidden) return;
    const box = $("story"), panel = box.querySelector(".sh-panel");
    avTerrain();
    if (!restore || !pf.g) { pf.view = { s: 1, x: 0, y: 0 }; pf.tool = "dam"; pf.dtype = 2; pf.prevHouses = null; pf.lastCut = null; avNew(null); }
    pf.open = true; pf.baseDirty = true;
    box.classList.add("sh-on");
    for (const el of box.querySelectorAll(".sv-fig, .sv-try-row, .sv-nav")) el.hidden = true;
    panel.hidden = false;
    const bars = (k) => "■".repeat(k) + "□".repeat(3 - k);
    panel.innerHTML = `<div class="sh-head"><h2 id="sh-h" tabindex="-1">${esc(t("Protect the village from the snow flow"))}</h2><span class="sv-badge sh-badge">${esc(t("Illustrative animation"))}</span></div>` +
      `<p class="av-task"><b>${esc(t("Build a dam in the valley, cut a piece of snow and protect the village."))}</b></p>` +
      `<div class="av-hud" role="group" aria-label="${esc(t("Game status"))}"><span class="av-phase"></span> <b class="av-time">00:00</b> <span class="av-houses"></span> <span class="av-budget"></span> <span class="av-build" hidden></span>` +
        `<button type="button" class="btn btn-small av-run" hidden></button><button type="button" class="btn btn-small btn-primary av-cutagain" hidden>${esc(t("Cut the same piece"))}</button></div>` +
      `<div class="av-mapbox"><canvas class="av-map" width="${AV_CW}" height="${AV_CH}" style="aspect-ratio:${AV_CW}/${AV_CH}" tabindex="0" role="application" aria-describedby="av-hint"` +
        ` aria-label="${esc(t("Game map: a mountain valley seen slightly from the south, with a large snow mass at the top, two valley branches and the village below."))}"></canvas>` +
        `<div class="rg-zoom av-zoom"><button type="button" class="btn btn-small av-zin" aria-label="${esc(t("Zoom in"))}">+</button><button type="button" class="btn btn-small av-zout" aria-label="${esc(t("Zoom out"))}">−</button>` +
        `<button type="button" class="btn btn-small av-zfit" aria-label="${esc(t("Show the whole valley"))}">⤢</button></div></div>` +
      `<div class="av-end" hidden role="status" aria-live="polite"></div>` +
      `<p class="av-hint" id="av-hint" aria-live="polite"></p>` +
      `<div class="sh-seg av-tools" role="radiogroup" aria-label="${esc(t("Tools"))}">` + [["dam", t("Build a dam")], ["cut", t("Cut the snow")], ["snow", t("Add snow")]].map(([v, l]) =>
        `<button type="button" role="radio" class="sh-opt av-tool" data-v="${v}" aria-checked="false">${esc(l)}</button>`).join("") + `</div>` +
      `<div class="av-opt" data-for="dam"><div class="sh-seg av-types" role="radiogroup" aria-label="${esc(t("Dam type"))}">` + [1, 2, 3].map((k) =>
        `<button type="button" role="radio" class="sh-opt av-type" data-v="${k}" aria-checked="false">${esc(avDamName(k))}<small>${esc(t("cost {n}/cell", { n: AV_DAM[k].cost }))} · ${esc(t("strength"))} ${bars(k)}</small></button>`).join("") + `</div>` +
        `<p>${esc(t("Draw a line across a valley. Tap a dam to select it."))}</p>` +
        `<div class="av-sel" hidden><span class="av-sel-info"></span><button type="button" class="btn btn-small av-wall"></button></div></div>` +
      `<div class="av-opt" data-for="cut"><p>${esc(t("Draw a line across the snow: the snow below the line (orange) breaks away when you let go."))}</p></div>` +
      `<div class="av-opt" data-for="snow"><p>${esc(t("Hold and drag: snow builds up inside the circle, also while the game is paused."))}</p></div>` +
      `<details class="sh-data"><summary>${esc(t("How the game works"))}</summary><ul class="sh-limits">` +
        `<li>${esc(t("An illustrative valley, not Gyirong–Rasuwa; times, sizes and damage belong to this game."))}</li>` +
        `<li>${esc(t("The snow flows downhill in small steps and settles where it slows; bedrock under the soil never changes."))}</li>` +
        `<li>${esc(t("Game dam types: a snow wall is cheap and holds small pieces, a stone dam costs more and lasts longer, a concrete dam costs most and lasts longest. A reinforcing wall makes a dam higher and stronger."))}</li>` +
        `<li>${esc(t("Villagers build the dams: a dam or wall only holds where it is finished. When the snow comes close they drop the work and run to high ground."))}</li>` +
        `<li>${esc(t("A dam cracks when half of its strength is used and breaks when it is gone; its pieces travel with the flow and make it more damaging."))}</li>` +
        `<li>${esc(t("Zoom with two fingers, the mouse wheel or the buttons; move the map with two fingers or the right mouse button. One finger uses the tool."))}</li></ul></details>` +
      `<div class="sv-nav sh-nav"><button type="button" class="btn sh-back">${esc(t("← Back to the story"))}</button>` +
        `<button type="button" class="btn btn-primary sh-to-map">${esc(t("Explore on the map"))}</button></div>`;
    const cv = panel.querySelector(".av-map");
    const toWorld = (e) => { const r = cv.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * AV_CW, py = ((e.clientY - r.top) / r.height) * AV_CH;
      const p = avPick(pf.g.T, pf.view.x + px / pf.view.s, pf.view.y + py / pf.view.s); return p ? [p[0], p[1], px, py] : [null, null, px, py]; };
    cv.addEventListener("contextmenu", (e) => e.preventDefault());
    cv.addEventListener("wheel", (e) => { e.preventDefault(); const [, , px, py] = toWorld(e); avZoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, px, py); }, { passive: false });
    cv.addEventListener("pointerdown", (e) => {
      try { cv.setPointerCapture(e.pointerId); } catch (_) {}
      pf.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (e.button === 1 || e.button === 2) { pf.pan = { x: e.clientX, y: e.clientY }; return; }
      if (pf.pointers.size >= 2) { // two fingers: zoom and pan only; any drawing or adding is dropped
        if (pf.gest) avHint(t("Two fingers move the map; nothing was changed."));
        pf.gest = null; pf.adding = null; pf.aim = null;
        const [a, b] = [...pf.pointers.values()]; pf.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, view: { ...pf.view } }; return;
      }
      const [x, y] = toWorld(e); if (x == null) return;
      const g = pf.g; pf.aim = [x, y];
      if (g.phase === "done") return;
      pf.gest = { kind: pf.tool, pts: [[x, y]], t0: performance.now(), x0: e.clientX, y0: e.clientY, mouse: e.pointerType === "mouse", id: e.pointerId };
      if (pf.tool === "snow") pf.adding = { x, y, live: e.pointerType === "mouse", id: e.pointerId }; // a finger waits a moment (a second finger means zoom)
    });
    cv.addEventListener("pointermove", (e) => {
      const p = pf.pointers.get(e.pointerId); if (p) { p.x = e.clientX; p.y = e.clientY; }
      if (pf.pan) { const r = cv.getBoundingClientRect(), k = AV_CW / r.width / pf.view.s; pf.view.x -= (e.clientX - pf.pan.x) * k; pf.view.y -= (e.clientY - pf.pan.y) * k; pf.pan = { x: e.clientX, y: e.clientY }; avClampView(); return; }
      if (pf.pinch && pf.pointers.size >= 2) { const [a, b] = [...pf.pointers.values()], r = cv.getBoundingClientRect(), k = AV_CW / r.width, P = pf.pinch;
        const s = Math.max(1, Math.min(5, P.view.s * Math.hypot(a.x - b.x, a.y - b.y) / Math.max(10, P.d))), cx = ((a.x + b.x) / 2 - r.left) * k, cy = ((a.y + b.y) / 2 - r.top) * k, c0x = (P.cx - r.left) * k, c0y = (P.cy - r.top) * k;
        pf.view.s = s; pf.view.x = P.view.x + c0x / P.view.s - cx / s; pf.view.y = P.view.y + c0y / P.view.s - cy / s; avClampView(); return; }
      const [x, y] = toWorld(e); if (x == null) return;
      if (!pf.gest) { if (e.pointerType === "mouse") pf.aim = [x, y]; return; }
      pf.aim = [x, y];
      const G = pf.gest, [lx, ly] = G.pts[G.pts.length - 1];
      if (Math.hypot(x - lx, y - ly) > 0.5) G.pts.push([x, y]);
      if (G.kind === "cut") G.cut = avCutRegion(pf.g, G.pts); // the preview: the line and the snow that would break away
      if (pf.adding) { pf.adding.x = x; pf.adding.y = y; if (!pf.adding.live && (performance.now() - G.t0 > 140 || Math.hypot(e.clientX - G.x0, e.clientY - G.y0) > 8)) pf.adding.live = true; }
    });
    const end = (e, cancel) => {
      pf.pointers.delete(e.pointerId);
      if (pf.pan && pf.pointers.size === 0) { pf.pan = null; return; }
      if (pf.pinch) { if (pf.pointers.size < 2) pf.pinch = null; return; }
      const G = pf.gest; pf.gest = null; if (pf.adding && pf.adding.id === e.pointerId) pf.adding = null;
      if (e.pointerType !== "mouse") pf.aim = null;
      if (!G || cancel) return;
      const g = pf.g, moved = G.pts.length > 2 || Math.hypot(e.clientX - G.x0, e.clientY - G.y0) > 8;
      if (G.kind === "dam") {
        if (!moved) { // a tap selects a dam
          const [x, y] = G.pts[0]; let best = null, bd = 2.2;
          g.dams.forEach((d, k) => { if (d.state === "broken") return; for (const i of d.cells) { const dd = Math.hypot((i % AV_W) + 0.5 - x, ((i / AV_W) | 0) + 0.5 - y); if (dd < bd) { bd = dd; best = k; } } });
          pf.sel = best; avHint(best != null ? t("Dam selected. You can add a reinforcing wall.") : t("Draw a line across a valley to build a dam.")); avHudLast = ""; avHud(); return;
        }
        const r = avBuildDam(g, G.pts, pf.dtype);
        if (r.ok) { pf.sel = r.dam.id; avHint(t("{type} drawn: {n} cells, cost {c}. Workers from the village are building it.", { type: avDamName(pf.dtype), n: r.dam.cells.length, c: r.cost })); }
        else avHint(r.why === "budget" ? t("Not enough budget for this dam (cost {c}).", { c: r.cost }) : t("Draw a longer line across the valley."));
        avHudLast = ""; avHud();
      } else if (G.kind === "cut") {
        if (g.phase !== "build") { avHint(t("The snow has already been cut in this round.")); return; }
        const cut = avCutRegion(g, G.pts);
        if (!cut || !cut.valid) { avHint(t("No piece was cut: draw a longer line across the snow mass.")); return; }
        avApplyCut(g, cut); avHint(t("A piece of snow broke away. Watch the dams and the village."));
      } else if (G.kind === "snow" && !moved && pf.g.phase !== "done") { avAddSnow(g, G.pts[0][0], G.pts[0][1], 0.4); }
    };
    cv.addEventListener("pointerup", (e) => end(e, false));
    cv.addEventListener("pointercancel", (e) => end(e, true));
    cv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !pf.gest) pf.aim = null; });
    panel.querySelector(".av-zin").addEventListener("click", () => avZoom(1.4, AV_CW / 2, AV_CH / 2));
    panel.querySelector(".av-zout").addEventListener("click", () => avZoom(1 / 1.4, AV_CW / 2, AV_CH / 2));
    panel.querySelector(".av-zfit").addEventListener("click", () => { pf.view = { s: 1, x: 0, y: 0 }; });
    panel.querySelector(".av-run").addEventListener("click", () => { const g = pf.g; if (g.phase === "done") return; g.running = !g.running; avHint(g.running ? t("The game continues.") : t("Paused: the clock and the flow stop; you can still add snow.")); avHudLast = ""; avHud(); });
    panel.querySelector(".av-cutagain").addEventListener("click", () => { const g = pf.g; if (g.phase === "build" && g.replayCut) { avApplyCut(g, g.replayCut); avHint(t("The same piece broke away. Watch the dams and the village.")); avHudLast = ""; avHud(); } });
    panel.querySelector(".av-wall").addEventListener("click", () => { const g = pf.g, d = pf.sel != null ? g.dams[pf.sel] : null; if (avReinforce(g, d)) avHint(t("Reinforcing wall ordered: workers build it as its own row in front of the dam.")); avHudLast = ""; avHud(); });
    for (const grp of panel.querySelectorAll(".av-tools, .av-types")) {
      grp.querySelectorAll(".sh-opt").forEach((b) => b.addEventListener("click", () => { if (grp.classList.contains("av-tools")) { pf.tool = b.dataset.v; pf.gest = null; pf.adding = null; } else pf.dtype = Number(b.dataset.v); avTools(); }));
      grp.addEventListener("keydown", (e) => { if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return; e.preventDefault(); e.stopPropagation();
        const o = [...grp.querySelectorAll('[role="radio"]')], k = o.indexOf(document.activeElement), n2 = o[(k + (/Right|Down/.test(e.key) ? 1 : -1) + o.length) % o.length]; n2.focus(); n2.click(); });
    }
    panel.querySelector(".sh-back").addEventListener("click", closeShaking);
    panel.querySelector(".sh-to-map").addEventListener("click", storyEnd);
    avTools(); avShowEnd();
    avHint(pf.g.phase === "build" ? (pf.g.replayCut ? t("Same land, same piece: change the dams, then press “Cut the same piece”.") : t("Build dams in the valleys, cut a piece of snow and protect the village.")) : "");
    avKick();
    if (!restore) panel.querySelector("#sh-h").focus({ preventScroll: false });
  }
  const flowStory = (s) => !!(s && s.hazard === "icerock");
  if (/[?&]fitest=1\b/.test(location.search)) window.__snow = { pf, AV, AV_DAM, terrain: avTerrain, newRound: avNew, cutRegion: avCutRegion, cut: avApplyCut, dam: (g, p, k, slow) => avBuildDam(g, p, k, !slow), reinforce: (g, d, slow) => avReinforce(g, d, !slow), update: svUpdate, render: avRender, paint: avPaint, kick: () => { if (pf.raf) cancelAnimationFrame(pf.raf); pf.raf = 0; avKick(); }, step: avStep, addSnow: avAddSnow, proj: avProj, pick: avPick, dims: () => ({ CH: AV_CH, OFF: AV_OFF }) }; // local tests only
  const fireStory = (s) => !!(s && api && (api.events.find((e) => e.id === s.event_id) || {}).hazard === "wildfire");

  window.NFEIntro = { init, show, travel, route, home: showHome };
})();
