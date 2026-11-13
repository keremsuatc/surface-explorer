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
  let globe = null;        // the single MapLibre map (created once, reused)
  let libPromise = null;   // the library is requested once
  let globeState = "idle"; // idle | loading | ready | failed  ("ready" = map created; its style and imagery may still be loading)
  let travelling = false;  // a start-screen → analysis or event → event transition owns the globe camera
  const SELECT_Z = 3.2;    // globe zoom when an event is chosen on the start screen
  let globeImagery = "pending"; // pending | ok | failed: first Blue Marble tiles shown (needed for a visible flight)
  const markers = {};

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
        el.querySelector(".gm-label").textContent = it.text.event.place;
      }
    };
    globeAria();

    // Markers: the element is only the dot, centred exactly on the study-area centre; the label sits beside it (CSS)
    for (const it of items) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "globe-marker";
      el.setAttribute("aria-label", t("{place}: open this event", { place: it.text.event.place }));
      el.innerHTML = `<span class="gm-label" aria-hidden="true">${esc(it.text.event.place)}</span>`;
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
        const covered = occluded(m);
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
    const ob = $("intro-open");
    if (ob) { ob.disabled = !!id; ob.textContent = id ? t("Opening…") : t("Open map"); if (id) ob.setAttribute("aria-busy", "true"); else ob.removeAttribute("aria-busy"); }
  }
  function renderPreview() {
    const box = $("intro-card");
    const it = items.find((x) => x.id === selected);
    if (!it) { box.hidden = true; box.innerHTML = ""; document.body.classList.remove("preview-open"); return; }
    const ev = it.text.event;
    box.hidden = false;
    document.body.classList.add("preview-open");
    box.innerHTML = `<button type="button" class="ic-close" aria-label="${esc(t("Close preview"))}">×</button>` +
      `<p class="ic-place" id="intro-card-title">${esc(ev.place.replace(" · ", ", "))}</p>` +
      `<p class="ic-dates">${esc(it.eventDate ? I.fmt.day(it.eventDate) : cap(I.fmt.month(it.lastDate)))}</p>` + // v65: a one-day event shows its day
      `<p class="ic-lede">${esc(ev.lede)}</p>` +
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
    $("intro").hidden = false;
    setCardsBusy(null);
    selected = null; syncPressed(); renderPreview();
    setAppInert(true);
    history.replaceState(null, "", location.pathname + location.search); // the start screen has no event in the address
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
  function renderList() {
    const list = $("intro-list");
    list.innerHTML = "";
    for (const it of items) {
      const li = document.createElement("li");
      // v57 card: place, dates, product label; choosing it opens the preview (the map opens from the preview's button)
      li.innerHTML = `<button type="button" class="intro-item" data-id="${esc(it.id)}" aria-pressed="${it.id === selected}" aria-controls="intro-card">` +
        `<span class="ii-place">${esc(it.text.event.place)}</span><span class="ii-dates">${esc(it.text.event.dates)}</span></button>`; // v64: no product label by the event name
      li.querySelector("button").addEventListener("click", () => select(it.id));
      list.appendChild(li);
    }
    renderPreview();
  }
  async function init(a) {
    api = a;
    items = (await Promise.all(api.events.map(async (entry) => {
      if (!api.texts[entry.id]) return null;
      try {
        const lay = await api.getLayers(entry.id);
        const [[s, w], [n, e]] = lay.bounds_latlon; // registered study area
        // text: the event text in the current language (read again after every language change)
        return { id: entry.id, entry, get text() { return api.text(entry.id); }, lastDate: lay.dates.length ? lay.dates[lay.dates.length - 1].label : lay.event_date, eventDate: lay.event_date || null, center: [(w + e) / 2, (s + n) / 2] };
      } catch (err) { return null; }
    }))).filter(Boolean);
    renderList();
    I.onChange(() => {
      if (failReason) $("globe-fallback").textContent = t("The 3D globe is not available here ({reason}). Use the list to choose an event.", { reason: t(failReason) });
      renderList(); globeHint(); globeAria(); if (!$("intro").hidden) document.title = t("Surface Explorer — NISAR flood observations"); });
    $("to-globe").addEventListener("click", show);
    $("travel-skip").addEventListener("click", skip);
  }

  window.NFEIntro = { init, show, travel };
})();
