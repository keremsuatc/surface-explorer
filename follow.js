/* Follow the Water: one illustrative 3D player for every event that has data/<event>/follow_water.json
   (Habiganj: Khowai River; Chókwè: Limpopo River). The event comes from the address: follow.html?event=<id> (the older
   follow.html#event=<id> still works; changing only the #part reloads the page, so one event's scene can never stay on screen
   under another event's address).
   Data: follow_water.json (built by pipeline/export/build_follow_water.py, then build_follow_flood.py), the event's own
   layers.json and text.en.json (the satellite map's files), follow_flood.png (order in which the illustrative front reaches each cell).
   Everything drawn, including the camera, is a function of one number t (0..1) from the timeline: dragging back gives the same
   picture, and nothing can queue up. The timeline (stages and moments) is per event, in follow_water.json "timeline".
   The illustrative spread and the satellite layer are never shown together; the satellite layer is never used for the animation. */
(() => {
  "use strict";
  const I = window.I18N;
  const tr = (k, v) => I.t(k, v); // (t is the slider value in this file)
  const LIB = "https://cdnjs.cloudflare.com/ajax/libs/maplibre-gl/5.6.0/"; // same version as the start-screen globe
  const fromQuery = new URLSearchParams(location.search).get("event");
  const fromHash = (/event=([\w-]+)/.exec(location.hash) || [])[1];
  const EVENT = String(fromQuery || fromHash || "bgd-flood-2026-07").replace(/[^\w-]/g, "");
  // back to the event map, in the same language (the language also travels in the address, for browsers without storage)
  const back = () => `./?lang=${I.lang}#event=${EVENT}`;
  // Same document, new #event=…: the browser does not reload by itself, so do it (the old scene must not stay under a new address).
  window.addEventListener("hashchange", () => {
    const h = (/event=([\w-]+)/.exec(location.hash) || [])[1];
    if (!fromQuery && h && h !== EVENT) location.reload();
  });
  const LOAD_TIMEOUT_MS = 20000;
  const SAT_URL = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg"; // same background as the app's fallback
  let raw = null; // follow_water.json as loaded (English); data = the same with its texts in the chosen language
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const ease = (k) => { k = clamp(k); return k * k * (3 - 2 * k); };
  const mix = (a, b, k) => a + (b - a) * k;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const slider = $("fw-time");
  let map = null, data = null, TL = null, ready = false, failed = false, t = 0, anim = 0, pending = 0;
  let cams = null, lastCam = "", obs = null, obsOpacity = 0, CAND_OPACITY = 0.8, EXAG = 12, lastExag = -1;
  let vals = null, bankOf = null, cellsIdx = null, spreadCv = null, spreadImg = null, lastSpread = "", spreadP = -1, spreadAlpha = 0, bankP = [];
  let stageBtns = [], seeds = [];
  const paint = new Map();
  const fixedLabels = [];

  const setBack = () => { for (const id of ["fw-back", "fw-fallback-link"]) $(id).setAttribute("href", back()); };

  function fail(why, title) {
    if (failed) return;
    failed = true; ready = false;
    cancelAnimationFrame(anim); cancelAnimationFrame(pending);
    if (title) $("fw-fallback-title").textContent = title;
    $("fw-fallback-why").textContent = why;
    $("fw-fallback").hidden = false;
    $("fw-loading").hidden = true;
    $("fw-controls").setAttribute("aria-disabled", "true");
    slider.disabled = true; stageBtns.forEach((b) => { b.disabled = true; });
    $("fw-badge").hidden = true;                      // nothing is animated or observed here
    if (!data) { $("fw-controls").hidden = true; document.querySelector(".fw-more").hidden = true; }
    try { map && map.remove(); } catch (e) { /* already gone */ }
    map = null;
  }
  function webglOk() {
    try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch (e) { return false; }
  }
  function loadLib() {
    return new Promise((resolve, reject) => {
      const css = document.createElement("link"); css.rel = "stylesheet"; css.href = LIB + "maplibre-gl.css"; document.head.appendChild(css);
      const js = document.createElement("script"); js.src = LIB + "maplibre-gl.js";
      js.onload = () => (window.maplibregl ? resolve(window.maplibregl) : reject(new Error("library missing")));
      js.onerror = () => reject(new Error("library not loaded"));
      document.head.appendChild(js);
    });
  }
  const getJson = (url) => fetch(url).then((r) => { if (!r.ok) throw Object.assign(new Error(url + " " + r.status), { status: r.status }); return r.json(); });
  const line = (coords, props) => ({ type: "Feature", properties: props || {}, geometry: { type: "LineString", coordinates: coords } });

  // ---- timeline ----
  const has = (k) => TL && Array.isArray(TL[k]);
  const seg = (k, v) => (has(k) ? clamp((v - TL[k][0]) / Math.max(1e-6, TL[k][1] - TL[k][0])) : 0);
  // The bright stretch in the river: from where the runoff joins (or the top of the river) to each entry, reached in time order
  let pulseKeys = [[0, 0]];
  function buildPulse() {
    const j0 = data.flow_lines_shown && data.flow_lines.lines.length ? data.flow_lines.lines[0].joins_river_at : 0;
    const banks = data.flood.banks.map((b, i) => ({ ra: b.river_at, w: TL.bank_windows[i] }));
    pulseKeys = [[TL.pulse[0], j0]];
    if (TL.spread_mode === "in_turn") banks.sort((a, b) => a.w[0] - b.w[0]).forEach((b) => pulseKeys.push([b.w[0], Math.max(pulseKeys[pulseKeys.length - 1][1], b.ra)]));
    else pulseKeys.push([TL.pulse[1], Math.max(...banks.map((b) => b.ra))]);
  }
  function pulseAt(v) {
    if (v <= pulseKeys[0][0]) return pulseKeys[0][1];
    for (let k = 0; k + 1 < pulseKeys.length; k++) {
      const [ta, ra] = pulseKeys[k], [tb, rb] = pulseKeys[k + 1];
      if (v < tb) return ra + (rb - ra) * clamp((v - ta) / (tb - ta));
    }
    return pulseKeys[pulseKeys.length - 1][1];
  }
  function stageOf(v) { let s = 0; TL.stages.forEach((st, i) => { if (v >= st[1] - 1e-9) s = i; }); return s; }
  function stageEnd(i) { return i + 1 < TL.stages.length ? TL.stages[i + 1][1] : 1; }

  function setP(id, prop, val) { // setPaintProperty only when the value really changes
    const k = id + "|" + prop, s = typeof val === "number" ? val.toFixed(4) : JSON.stringify(val);
    if (paint.get(k) === s) return false;
    paint.set(k, s);
    map.setPaintProperty(id, prop, val);
    return true;
  }
  function headGradient(p, dim, bright) {
    if (p <= 0.001) return ["interpolate", ["linear"], ["line-progress"], 0, "rgba(0,0,0,0)", 1, "rgba(0,0,0,0)"];
    if (p >= 0.999) return ["interpolate", ["linear"], ["line-progress"], 0, dim, 1, dim];
    const a = Math.max(0, p - 0.12), b = Math.min(1, p + 0.004);
    const stops = [0, dim];
    if (a > 0) stops.push(a, dim);
    stops.push(Math.max(a + 0.0005, p - 0.0005), bright, Math.max(a + 0.001, b), "rgba(0,0,0,0)");
    if (b < 1) stops.push(1, "rgba(0,0,0,0)");
    return ["interpolate", ["linear"], ["line-progress"], ...stops];
  }

  function draw() {
    if (!ready) return;
    const v = t;
    let drape = false;
    // Rain and Runoff (only where verified hill lines exist: Habiganj)
    if (data.flow_lines_shown) {
      const rain = seg("rain", v), runoff = seg("runoff", v);
      setP("fw-seeds", "circle-opacity", 0.15 + 0.75 * rain);
      setP("fw-seeds", "circle-radius", 3 + 5 * rain);
      setP("fw-flows", "line-gradient", headGradient(runoff, "rgba(155,231,255,0.85)", "#ffffff"));
      drawRain(rain * (1 - runoff));
    }
    // The river rises (Chókwè): the channel line widens and brightens a little, the same for every slider value
    const rise = seg("rise", v);
    const fin = ease(seg("final_cam", v));
    setP("fw-river", "line-width", 3 + 3 * rise - 1.5 * fin);
    setP("fw-river", "line-opacity", 1 - 0.65 * fin);   // the satellite map draws no river line: keep it faint over the satellite layer
    setP("fw-river-case", "line-opacity", 0.7 * (1 - fin));
    setP("fw-river-pulse", "line-opacity", 1 - fin);
    setP("fw-river-glow", "line-opacity", 0.55 * rise * (1 - seg("off", v)));
    // A brighter stretch moves down the mapped channel to the entry points and stays there
    const front = pulseAt(v), j0 = pulseKeys[0][1];
    setP("fw-river-pulse", "line-gradient", v < TL.pulse[0] + 1e-4
      ? ["interpolate", ["linear"], ["line-progress"], 0, "rgba(0,0,0,0)", 1, "rgba(0,0,0,0)"]
      : ["interpolate", ["linear"], ["line-progress"], 0, "rgba(0,0,0,0)", Math.max(0.0001, j0 - 0.002), "rgba(0,0,0,0)", Math.max(0.0002, j0), "rgba(190,235,255,0.95)",
        Math.max(j0 + 0.0005, front - 0.0005), "#ffffff", Math.min(0.9999, Math.max(j0 + 0.001, front + 0.003)), "rgba(0,0,0,0)", 1, "rgba(0,0,0,0)"]);
    // Illustrative spread: nothing before the front leaves the river; it then grows cell by cell; later it is switched off completely
    bankP = TL.bank_windows.map((w) => (v < w[0] ? -1 : clamp((v - w[0]) / (w[1] - w[0]))));
    spreadP = Math.max(...bankP);
    spreadAlpha = 1 - ease(seg("off", v));
    drape = drawSpread(bankP, spreadAlpha) || drape;
    // Satellite layer: only after the illustrative layer is gone; only its opacity changes
    obsOpacity = CAND_OPACITY * ease(seg("obs", v));
    drape = setP("fw-nisar", "raster-opacity", obsOpacity) || drape;
    const obsShare = obsOpacity / CAND_OPACITY;
    $("fw-key-obs").style.opacity = obsShare.toFixed(3);
    $("fw-key-spread").style.opacity = (spreadP < 0 ? 0 : 0.35 + 0.65 * spreadAlpha).toFixed(3);
    const handover = seg("off", v) > 0 && obsShare < 0.02;
    const banner = obsShare > 0.02 ? obs.title : tr("Animation off · next: satellite observation");
    if ($("fw-obs").textContent !== banner) $("fw-obs").textContent = banner;
    $("fw-obs").style.opacity = (handover ? 1 : obsShare).toFixed(3);
    // per bank: "water leaves the river here" while its front starts, "path uncertain" once its front has stopped
    for (const L of data.bankEls || []) {
      const w = TL.bank_windows[L.i];
      L.entry.style.opacity = (ease((v - w[0] + 0.01) / 0.03) * (1 - ease((v - w[0] - 0.1) / 0.04))).toFixed(3);
      L.end.style.opacity = (ease((v - (w[1] - 0.01)) / 0.03) * spreadAlpha).toFixed(3);
    }
    if (data.areaEl) data.areaEl.style.opacity = (1 - ease(seg("final_cam", v))).toFixed(3);
    drape = setCamera(v) || drape;
    if (drape) refreshDrape(); else map.triggerRepaint();
    // Caption: one short sentence for the moment, with what it is (animation or satellite observation)
    const s = stageOf(v);
    stageBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(i === s)));
    const isObs = v >= TL.obs[0];
    let text = "";
    if (isObs) text = obs.caption + (v >= 0.985 ? ` <a class="fw-end" href="${back()}">${esc(data.final_layer.link)}</a>` : "");
    else for (const c of data.ui.captions) if (v >= c[0] - 1e-9) text = esc(c[1]);
    const mode = isObs ? tr("Satellite observation") : tr("Animation");
    if ($("fw-caption-text").innerHTML !== text) $("fw-caption-text").innerHTML = text;
    const modeEl = document.querySelector(".fw-mode");
    if (modeEl.textContent !== mode) { modeEl.textContent = mode; modeEl.classList.toggle("obs", isObs); }
    // badge: what is on screen. On phones only the first part shows (the key below names the layer), so its height never changes
    const badge = isObs ? tr("Satellite observation") : spreadP >= 0 ? tr("Animation · Illustrative flood spread") : tr("Animation · Illustrative flow");
    if ($("fw-badge").dataset.text !== badge) {
      $("fw-badge").dataset.text = badge;
      const [head, ...rest] = badge.split(" · ");
      $("fw-badge").innerHTML = `<span>${esc(head)}</span>${rest.length ? `<span class="fw-badge-more"> · ${esc(rest.join(" · "))}</span>` : ""}`;
    }
    $("fw-badge").classList.toggle("obs", isObs);
    document.body.classList.toggle("fw-late", v >= TL.spread[0] - 0.02);
    slider.setAttribute("aria-valuetext", `${tr(TL.stages[s][0])}: ${text.replace(/<[^>]+>/g, "")}`);
  }

  // Illustrative spread on a small canvas, one pixel per elevation cell (about 35 m). A cell appears once the front has passed it;
  // cells just behind the front are lighter, so the moving edge can be followed. Semi-transparent: the ground stays readable.
  function drawSpread(pb, alpha) {
    if (!vals || !spreadCv) return false;
    const key = pb.map((x) => x.toFixed(4)).join() + "|" + alpha.toFixed(3);
    if (key === lastSpread) return false;
    lastSpread = key;
    const d = spreadImg.data;
    d.fill(0);
    if (alpha > 0.001) {
      const edge = 0.07;
      for (let n = 0; n < cellsIdx.length; n++) {
        const i = cellsIdx[n], p = pb[bankOf[i]], behind = p - vals[i], moving = p < 0.999;
        if (p < 0 || behind < 0) continue;
        const a = clamp(behind / 0.015 + 0.25), f = moving ? clamp(1 - behind / edge) : 0; // f = 1 right at the front
        d[i * 4] = 70 + 170 * f; d[i * 4 + 1] = 200 + 55 * f; d[i * 4 + 2] = 245 + 10 * f;
        d[i * 4 + 3] = 255 * alpha * a * (0.72 + 0.25 * f);
      }
    }
    spreadCv.getContext("2d").putImageData(spreadImg, 0, 0);
    const src = map.getSource("spread");
    if (src) { src.play(); src.pause(); } // pause() uploads the canvas once
    return true;
  }

  // With terrain, MapLibre keeps the draped layers in a cache and does not always notice a new canvas image or opacity.
  // Clearing that cache after such a change makes the picture depend on the slider value only (MapLibre 5.6.0 internals).
  function refreshDrape() {
    try { const sc = map.terrain && map.terrain.sourceCache; if (sc && sc.freeRtt) sc.freeRtt(); } catch (e) { /* other library version: skip */ }
    map.triggerRepaint();
  }

  // ---- camera: from the slider value only (jumpTo, never flyTo) ----
  function lerpCam(a, b, k) {
    let db = ((b.bearing - a.bearing) % 360 + 540) % 360 - 180; // the short way round
    return { center: [mix(a.center[0], b.center[0], k), mix(a.center[1], b.center[1], k)], zoom: mix(a.zoom, b.zoom, k), pitch: mix(a.pitch, b.pitch, k), bearing: a.bearing + db * k };
  }
  // Camera keyframes from follow_water.json timeline.camera: [[t, frame], ...]; between two different frames the view eases
  // from one to the other, between equal frames it holds still. Reduced motion: the framing changes directly, no movement.
  function camAt(v) {
    const K = TL.camera;
    let k = 0;
    while (k + 1 < K.length && v >= K[k + 1][0]) k++;
    if (k + 1 >= K.length) return cams[K[K.length - 1][1]];
    const a = cams[K[k][1]], b = cams[K[k + 1][1]];
    if (K[k][1] === K[k + 1][1]) return a;
    const f = (v - K[k][0]) / (K[k + 1][0] - K[k][0]);
    if (reduced.matches) return f < 0.5 ? a : b;
    return lerpCam(a, b, ease(f));
  }
  function setExaggeration(x) {
    if (Math.abs(x - lastExag) < 1e-3) return;
    lastExag = x;
    try { if (map.terrain) { map.terrain.exaggeration = x; if (map.terrain.options) map.terrain.options.exaggeration = x; } } catch (e) { /* skip */ }
  }
  function setCamera(v) {
    if (!cams) return false;
    const c = camAt(v);
    // Terrain flattens on the way to the final view, so the satellite layer sits exactly where the satellite map draws it
    setExaggeration(EXAG * (reduced.matches ? (v >= (TL.final_cam[0] + TL.final_cam[1]) / 2 ? 0 : 1) : 1 - ease(seg("final_cam", v))));
    const closeness = clamp((c.zoom - cams.wide.zoom) / Math.max(0.01, cams.study.zoom - cams.wide.zoom));
    let drape = false;
    for (const id of ["fw-oldch", "fw-emb"]) if (map.getLayer(id)) drape = setP(id, "line-opacity", (0.25 + 0.65 * Math.min(1, closeness * 1.5)) * (1 - seg("off", v))) || drape;
    const lab = Math.min(1, closeness * 1.5) * (1 - ease(seg("final_cam", v)));
    if (data.townEl) data.townEl.style.opacity = lab.toFixed(3);
    if (map.getLayer("fw-sat")) drape = setP("fw-sat", "raster-opacity", 0.8 * Math.min(1, closeness * 1.5)) || drape; // real ground texture only near the study area
    const key = [c.center[0].toFixed(6), c.center[1].toFixed(6), c.zoom.toFixed(4), c.pitch.toFixed(2), c.bearing.toFixed(2), lastExag.toFixed(3)].join();
    if (key === lastCam) return drape;
    lastCam = key;
    map.jumpTo(c);
    return drape;
  }

  // Rain streaks over the hill cells where the sample lines start. Positions are a hash of the streak number and t only.
  function drawRain(strength) {
    const cv = $("fw-rain"), box = cv.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(box.width * dpr) || cv.height !== Math.round(box.height * dpr)) { cv.width = Math.round(box.width * dpr); cv.height = Math.round(box.height * dpr); }
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, box.width, box.height);
    if (strength <= 0.01) return;
    seeds = data.flow_lines.lines.map((f) => map.project(f.coords[0]));
    if (!seeds.length) return;
    const fall = Math.max(40, box.height * 0.16), len = Math.max(7, box.height * 0.022);
    g.lineWidth = 1.4; g.lineCap = "round";
    for (let i = 0; i < 150; i++) {
      const h1 = (Math.sin(i * 127.1) * 43758.5453) % 1, h2 = (Math.sin(i * 311.7) * 24634.6345) % 1, h3 = (Math.sin(i * 74.7) * 9182.331) % 1;
      const s = seeds[i % seeds.length];
      const phase = (Math.abs(h3) + t * 6 * (2 + (i % 3))) % 1; // moves with the timeline, not with the clock
      const x = s.x + h1 * box.width * 0.07 - phase * fall * 0.18, y = s.y - fall + Math.abs(h2) * fall * 0.35 + phase * fall * 0.85;
      g.strokeStyle = `rgba(200,225,255,${(0.75 * strength * Math.sin(Math.PI * phase)).toFixed(3)})`;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x - len * 0.2, y + len); g.stroke();
    }
  }

  function setT(v, fromSlider) {
    t = clamp(v);
    if (!fromSlider) slider.value = String(Math.round(t * 1000));
    draw();
  }
  // Slider events can come several times per frame: draw once per frame, always for the latest value
  slider.addEventListener("input", () => {
    cancelAnimationFrame(anim);
    t = clamp(Number(slider.value) / 1000);
    if (!pending) pending = requestAnimationFrame(() => { pending = 0; draw(); });
  });
  function play(i) {
    cancelAnimationFrame(anim);
    const from = TL.stages[i][1], to = stageEnd(i) - (i + 1 < TL.stages.length ? 0.0005 : 0);
    if (reduced.matches) { setT(to); return; }
    const t0 = performance.now(), dur = Math.max(1800, 10000 * (to - from));
    const step = (now) => {
      const k = clamp((now - t0) / dur);
      setT(from + (to - from) * k);
      if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  function bboxOf(pts, m) {
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    return [[Math.min(...xs) - m, Math.min(...ys) - m], [Math.max(...xs) + m, Math.max(...ys) + m]];
  }
  // The satellite map's framing (Leaflet fitBounds with 12 px padding, zoom snapped down to 0.25) for a box this size.
  // MapLibre zoom = Leaflet zoom - 1 (512 px vs 256 px world at zoom 0). Same centre, straight down, north up.
  function leafletFrame(w, s, e, n, size) {
    const X = (lon) => (lon + 180) / 360 * 256;
    const Y = (lat) => { const k = Math.sin(lat * Math.PI / 180); return (0.5 - Math.log((1 + k) / (1 - k)) / (4 * Math.PI)) * 256; };
    const bw = X(e) - X(w), bh = Y(s) - Y(n);
    let z = Math.log2(Math.min((size.w - 24) / bw, (size.h - 24) / bh));
    z = Math.round(z / 0.0025) * 0.0025;
    z = Math.floor(z / 0.25) * 0.25;
    const cy = (Y(s) + Y(n)) / 2 / 256, lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * cy))) * 180 / Math.PI;
    return { center: [(w + e) / 2, lat], zoom: z - 1, pitch: 0, bearing: 0, leafletZoom: z };
  }
  // Last view: the satellite map's zoom for the study area when the map passed it (?mz=, Leaflet zoom), otherwise the same rule for this view's size
  function finalFrame(sa, box) {
    const own = leafletFrame(sa[0], sa[1], sa[2], sa[3], { w: box.clientWidth, h: box.clientHeight });
    const mz = Number(new URLSearchParams(location.search).get("mz"));
    if (Number.isFinite(mz) && mz > 0 && Math.abs(mz - own.leafletZoom) <= 1.5) return { ...own, zoom: mz - 1, leafletZoom: mz, fromMap: true };
    return own;
  }
  function frame() {
    const box = map.getContainer(), narrow = box.clientWidth < 600, P = data.display.pitch;
    const cam = (bounds, pitch, padding, brg) => { const c = map.cameraForBounds(bounds, { bearing: brg, padding }); return { center: [c.center.lng, c.center.lat], zoom: c.zoom, pitch, bearing: brg }; };
    const keyH = $("fw-stage").querySelector(".fw-key").offsetHeight || 40;
    const pad = narrow ? { top: 10, bottom: keyH + 34, left: 6, right: 6 } : { top: 20, bottom: keyH + 10, left: 30, right: 30 };
    const closePad = narrow ? { top: 40, bottom: keyH + 70, left: 22, right: 22 } : { top: 60, bottom: keyH + 40, left: 80, right: 80 };
    const fl = data.flood, sa = data.study_area.bbox;
    const entries = fl.banks.map((b) => b.entry_lonlat), ends = fl.banks.filter((b) => b.supported_km2 >= 0.5).map((b) => b.end_lonlat);
    const early = fl.front_bbox_every_5pct[7] || fl.front_bbox_every_5pct.find(Boolean);
    const lastBox = fl.front_bbox_every_5pct[fl.front_bbox_every_5pct.length - 1];
    const town = data.settlement && data.settlement.lonlat;
    const closePitch = narrow ? P.close_narrow : P.close;
    // close: the entries, the first part of the spread and the town (Habiganj)
    const closePts = [...entries, [early[0], early[1]], [early[2], early[3]]];
    if (town && entries.some((e) => Math.hypot(e[0] - town[0], e[1] - town[1]) < 0.03)) closePts.push(town);
    // open: the study area and the plain around it (25 % more on every side), everything reached, and where the path becomes uncertain
    const ex = data.display.open_expand || 0.25, dx = (sa[2] - sa[0]) * ex, dy = (sa[3] - sa[1]) * ex;
    const openPts = [[sa[0] - dx, sa[1] - dy], [sa[2] + dx, sa[3] + dy], [lastBox[0], lastBox[1]], [lastBox[2], lastBox[3]], ...ends];
    cams = {
      wide: cam(data.camera.wide_bounds, narrow ? P.wide_narrow : P.wide, pad, data.camera.bearing),
      close: cam(bboxOf(closePts, 0.004), closePitch, closePad, 0),
      // study: the river, the whole study area and the low ground the water can enter, in one view
      study: cam(bboxOf([[sa[0], sa[1]], [sa[2], sa[3]], ...entries], 0.002), closePitch, closePad, 0),
      open: cam(bboxOf(openPts, 0.003), closePitch, closePad, 0),
      final: finalFrame(sa, box),
    };
    // bank:i: one bank's entry, all of its front and the point where its path becomes uncertain (Chókwè, banks in turn)
    fl.banks.forEach((b, i) => {
      const fb = b.front_bbox_every_5pct[b.front_bbox_every_5pct.length - 1] || [b.entry_lonlat[0], b.entry_lonlat[1], b.entry_lonlat[0], b.entry_lonlat[1]];
      cams["bank:" + i] = cam(bboxOf([b.entry_lonlat, b.end_lonlat, [fb[0], fb[1]], [fb[2], fb[3]]], 0.009), closePitch, closePad, 0);
      cams["bank:" + i].zoom = Math.min(cams["bank:" + i].zoom, 14.2);
    });
    cams.close.zoom = Math.min(cams.close.zoom, 14.2);
    cams.open.zoom = Math.min(cams.open.zoom, cams.study.zoom);
    lastCam = "";
    setCamera(t);
  }

  function start(maplibregl) {
    const fl = data.flood;
    spreadCv = document.createElement("canvas");
    spreadCv.width = fl.image_size[0]; spreadCv.height = fl.image_size[1];
    spreadImg = spreadCv.getContext("2d").createImageData(spreadCv.width, spreadCv.height);
    const dem = { type: "raster-dem", tiles: [data.elevation.tile_url], encoding: "terrarium", tileSize: 256, maxzoom: 12 };
    const study = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [data.study_area.ring] } };
    const mf = data.mapped_features || {};
    const layers = [
      { id: "bg", type: "background", paint: { "background-color": "#16232e" } },
      { id: "relief", type: "color-relief", source: "shade", paint: { "color-relief-color": data.display.relief || ["interpolate", ["linear"], ["elevation"],
        0, "#1d3a3a", 12, "#254a3f", 30, "#3f6a45", 60, "#7f9a57", 120, "#b9ac6e", 250, "#d8c9a0", 450, "#f1ece0"] } },
      { id: "shade", type: "hillshade", source: "shade", paint: { "hillshade-exaggeration": 0.55, "hillshade-shadow-color": "#0b141b", "hillshade-highlight-color": "#ffffff", "hillshade-accent-color": "#0b141b" } },
      { id: "fw-nisar", type: "raster", source: "nisar", paint: { "raster-opacity": 0, "raster-fade-duration": 0, "raster-resampling": "nearest" } }, // nearest = the map's "pixelated" drawing; colours untouched
      { id: "fw-spread", type: "raster", source: "spread", paint: { "raster-opacity": 1, "raster-fade-duration": 0, "raster-resampling": "linear" } },
      { id: "fw-study-fill", type: "fill", source: "study", paint: { "fill-color": "#ffffff", "fill-opacity": 0.05 } },
      { id: "fw-study-line", type: "line", source: "study", paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [2, 2] } },
      { id: "fw-river-glow", type: "line", source: "river", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#8fd0ff", "line-width": 16, "line-blur": 8, "line-opacity": 0 } },
      { id: "fw-river-case", type: "line", source: "river", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0b2a4a", "line-width": 6, "line-opacity": 0.7 } },
      { id: "fw-river", type: "line", source: "river", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#4da3ff", "line-width": 3 } },
      { id: "fw-river-pulse", type: "line", source: "river", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 5, "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, "rgba(0,0,0,0)", 1, "rgba(0,0,0,0)"] } },
    ];
    const sources = {
      terrain: dem, shade: dem,
      river: { type: "geojson", lineMetrics: true, data: line(data.river.coords) },
      study: { type: "geojson", data: study },
      nisar: { type: "image", url: obs.url, coordinates: obs.coordinates }, // the map's own file at the map's own image extent
      spread: { type: "canvas", canvas: spreadCv, animate: false, coordinates: fl.corners_lonlat },
    };
    if (data.flow_lines_shown) {
      sources.flows = { type: "geojson", lineMetrics: true, data: { type: "FeatureCollection", features: data.flow_lines.lines.map((f) => line(f.coords)) } };
      sources.seeds = { type: "geojson", data: { type: "FeatureCollection", features: data.flow_lines.lines.map((f) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: f.coords[0] } })) } };
      layers.push({ id: "fw-flows", type: "line", source: "flows", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 2.5, "line-gradient": ["interpolate", ["linear"], ["line-progress"], 0, "rgba(0,0,0,0)", 1, "rgba(0,0,0,0)"] } },
        { id: "fw-seeds", type: "circle", source: "seeds", paint: { "circle-color": "#9be7ff", "circle-radius": 3, "circle-opacity": 0.15, "circle-blur": 0.6 } });
    }
    if ((mf.old_channel || []).length && data.ui.oldch_key) {
      sources.oldch = { type: "geojson", data: { type: "FeatureCollection", features: mf.old_channel.map((o) => line(o.coords)) } };
      layers.splice(5, 0, { id: "fw-oldch", type: "line", source: "oldch", paint: { "line-color": "#8fd3ff", "line-width": 1.6, "line-dasharray": [2, 2], "line-opacity": 0.25 } });
    }
    if ((mf.embankment_roads || []).length && data.ui.emb_key) {
      sources.emb = { type: "geojson", data: { type: "FeatureCollection", features: mf.embankment_roads.map((o) => line(o.coords)) } };
      layers.splice(5, 0, { id: "fw-emb", type: "line", source: "emb", paint: { "line-color": "#ffb866", "line-width": 1.6, "line-opacity": 0.25 } });
    }
    map = new maplibregl.Map({
      container: "fw-map", interactive: false, attributionControl: false, maxPitch: 70, fadeDuration: 0,
      style: {
        version: 8,
        transition: { duration: 0, delay: 0 }, // no timed fades: the picture must depend on the slider value only
        sources,
        terrain: { source: "terrain", exaggeration: EXAG },
        sky: { "sky-color": "#0e1820", "horizon-color": "#1c2b38", "fog-color": "#16232e", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.2 },
        layers,
      },
    });
    lastExag = EXAG;
    const timer = setTimeout(() => { if (!ready) fail(tr("The terrain took too long to load. Check the internet connection and try again.")); }, LOAD_TIMEOUT_MS);
    let demErrors = 0;
    map.on("error", (e) => {
      if (ready) return;
      if (e && e.sourceId === "sat") return; // the close-view background is optional
      if (e && e.sourceId === "nisar") { clearTimeout(timer); fail(tr("The satellite layer could not be loaded.")); return; }
      if (e && e.sourceId && (e.sourceId === "terrain" || e.sourceId === "shade")) { if (++demErrors >= 3) { clearTimeout(timer); fail(tr("The elevation data could not be loaded. Check the internet connection and try again.")); } }
      else if (e && e.error && /style|layer|source/i.test(String(e.error.message || ""))) { clearTimeout(timer); fail(tr("This browser could not draw the terrain view.")); }
    });
    map.on("load", () => {
      frame();
      map.once("idle", () => {
        clearTimeout(timer);
        if (failed) return;
        const mk = (text, lngLat, cls, anchor) => { const el = document.createElement("div"); el.className = "fw-label " + (cls || ""); el.textContent = text; new maplibregl.Marker({ element: el, anchor: anchor || "bottom" }).setLngLat(lngLat).addTo(map); return el; };
        const r = data.river.coords;
        labelTexts.push({ el: mk(data.ui.river_label, r[Math.round(r.length * 0.3)], "", "left"), text: () => data.ui.river_label });
        if (data.flow_lines_shown && data.ui.hills_label && data.flow_lines.lines.length) {
          const top = data.flow_lines.lines.reduce((a, b) => (b.start_m > a.start_m ? b : a));
          labelTexts.push({ el: mk(data.ui.hills_label, top.coords[0], "soft", "bottom"), text: () => data.ui.hills_label });
        }
        // Labels placed from the camera alone (ground height ignored): the same pixel for the same slider value
        const scr = (q) => { try { return map.transform.locationToScreenPoint(q); } catch (e) { return map.project(q); } };
        const al = document.createElement("div"); al.className = "fw-label fw-fixed-label"; al.textContent = data.ui.area_label; $("fw-stage").appendChild(al);
        labelTexts.push({ el: al, text: () => data.ui.area_label });
        const [bw_, bs_, be_, bn_] = data.study_area.bbox;
        const corners = [[bw_, bs_], [be_, bs_], [be_, bn_], [bw_, bn_]].map((q) => new maplibregl.LngLat(q[0], q[1]));
        const fixed = (text, lonlat, cls, shift) => { const el = document.createElement("div"); el.className = "fw-label fw-fixed-label " + cls; el.textContent = text; $("fw-stage").appendChild(el);
          fixedLabels.push({ el, ll: new maplibregl.LngLat(lonlat[0], lonlat[1]), shift }); el.style.opacity = "0"; return el; };
        const townText = () => tr("{name} (town centre, mapped)", { name: data.settlement.name });
        if (data.settlement && data.settlement.lonlat) { data.townEl = fixed(townText(), data.settlement.lonlat, "town", "translate(-50%, -150%)"); labelTexts.push({ el: data.townEl, text: townText }); }
        data.areaEl = al;
        data.bankEls = data.flood.banks.map((b, i) => (b.supported_km2 >= 0.5 ? {
          i, entry: fixed(tr("Water leaves the river here (point chosen by rule)"), b.entry_lonlat, "entry", "translate(-50%, -160%)"),
          end: fixed(data.ui.end_label, b.end_lonlat, "uncertain", "translate(-50%, 60%)") } : null)).filter(Boolean);
        for (const L of data.bankEls) {
          labelTexts.push({ el: L.entry, text: () => tr("Water leaves the river here (point chosen by rule)") }, { el: L.end, text: () => data.ui.end_label });
        }
        const place = () => {
          const pts = corners.map(scr);
          const x = pts.reduce((a, q) => a + q.x, 0) / 4, y = Math.min(...pts.map((q) => q.y));
          al.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -125%)`;
          for (const f of fixedLabels) { const q = scr(f.ll); f.el.style.transform = `translate(${Math.round(q.x)}px, ${Math.round(q.y)}px) ${f.shift}`; }
        };
        map.on("render", place); place();
        // Optional close-view background, added only now so a failure of this source can never hold up the scene
        try {
          map.addSource("sat", { type: "raster", tiles: [SAT_URL], tileSize: 256, minzoom: 9, maxzoom: 14 });
          map.addLayer({ id: "fw-sat", type: "raster", source: "sat", paint: { "raster-opacity": 0, "raster-fade-duration": 0, "raster-saturation": -0.25 } }, "fw-nisar");
        } catch (e) { /* scene works without it */ }
        ready = true;
        $("fw-loading").hidden = true;
        draw();
        map.on("idle", () => { if (ready && data.flow_lines_shown) drawRain(seg("rain", t) * (1 - seg("runoff", t))); }); // later terrain detail can shift screen positions slightly
      });
    });
    let rz = 0;
    window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (!map) return; map.resize(); frame(); draw(); }, 120); });
    window.ftw = { get map() { return map; }, get t() { return t; }, get ready() { return ready; }, get cams() { return cams; }, get obsOpacity() { return obsOpacity; },
      get spreadP() { return spreadP; }, get bankP() { return bankP; }, get spreadAlpha() { return spreadAlpha; }, get obs() { return obs; }, get exaggeration() { return lastExag; }, setT, data, EVENT };
  }

  // ---- page furniture built from the data: stage buttons, key, event images, sources & method ----
  function buildControls() {
    const box = $("fw-stages"), ticks = $("fw-ticks");
    box.style.gridTemplateColumns = `repeat(${TL.stages.length}, 1fr)`;
    box.innerHTML = TL.stages.map((s, i) => `<button type="button" class="fw-btn fw-stage-btn" data-stage="${i}" aria-pressed="${i === stageOf(t)}">${esc(tr(s[0]))}</button>`).join("");
    stageBtns = [...box.querySelectorAll(".fw-stage-btn")];
    stageBtns.forEach((b) => b.addEventListener("click", () => { if (ready) play(Number(b.dataset.stage)); }));
    ticks.style.gridTemplateColumns = TL.stages.map((s, i) => `${((stageEnd(i) - s[1]) * 100).toFixed(2)}fr`).join(" ");
    ticks.innerHTML = TL.stages.map((s) => `<span>${esc(tr(s[0]))}</span>`).join("");
  }
  function buildMedia() {
    const m = data.media;
    if (!m || (!m.items.length && !m.links.length)) return;
    $("fw-media-list").innerHTML = m.items.map((it) => `<figure class="fw-fig">
        <img src="data/${EVENT}/${esc(it.file)}" width="${it.width}" height="${it.height}" alt="${esc(it.alt)}" loading="lazy" decoding="async">
        <figcaption><b>${esc(it.title)}</b> · ${esc(it.place)} · ${esc(fmtDates(it.date))}<br>${esc(it.what_it_shows)}<br>
        ${tr("Source: {source}.", { source: it.source_url ? `<a href="${esc(it.source_url)}" rel="noopener">${esc(it.source)}</a>` : esc(it.source) })} ${esc(it.rights)}</figcaption></figure>`).join("");
    $("fw-media-links").innerHTML = m.links.map((l) => `<li><a href="${esc(l.url)}" rel="noopener">${esc(l.text)}</a> <span>${esc(l.note)}</span></li>`).join("");
    $("fw-media").hidden = false;
  }
  // "2026-06-30 and 2026-07-12" / "2026-01-17" → dates in the chosen language
  const fmtDates = (s) => String(s).replace(/\d{4}-\d{2}-\d{2}/g, (iso) => I.fmt.day(iso)).replace(" and ", ` ${tr("and")} `);
  let lastLay = null;
  function buildSources(lay) {
    lastLay = lay;
    const fl = data.flood, d = data, f = d.final_layer, n = (x, k = 1) => I.fmt.num(x, k);
    const banks = fl.banks.map((b, i) => `<li>${esc(tr("Bank {n}: water leaves the river at {lat}, {lon} (ground {ground} m, river level beside it {river} m). Drawn: {area} km². Ends: {why}.", {
      n: i + 1, lat: n(b.entry_lonlat[1], 4), lon: n(b.entry_lonlat[0], 4), ground: n(b.entry_ground_m), river: n(b.river_level_beside_m), area: n(b.supported_km2, 2),
      why: raw.flood.banks[i].ends_because === "uncertain" ? tr("the noise runs stop agreeing on the direction") : b.ends_because }))}</li>`).join("");
    const br = fl.branches ? `<h3>${esc(tr("Small streams, canals and drains"))}</h3><p>${esc(fl.branches.result)} ${esc(fl.branches.flow_direction_rule)}</p>` : "";
    const cn = fl.canals ? `<h3>${esc(tr("Canals and drains"))}</h3><p>${esc(fl.canals.result)}</p>` : "";
    const kal = fl.kaliganj ? `<p>${esc(tr("Kaliganj: not labelled. {why}", { why: fl.kaliganj.why }))}</p>` : "";
    const tl = fl.terrain_derived_lines ? `<p>${esc(tr("Drainage lines derived from the elevation ({n} near the study area) are recorded separately from the mapped waterways and are not drawn.", { n: fl.terrain_derived_lines.count }))}</p>` : "";
    const ext = lay.bounds_latlon.map((q) => q.map((x) => n(x, 4)).join(", ")).join(" – ");
    const satP = obs.classKey
      ? tr("{title}, file {file}, class “{class}” (the class the satellite map shows first), placed at the satellite map's image extent ({extent}). Data status: {maturity}.",
        { title: obs.title, file: obs.file, class: obs.classKey, extent: ext, maturity: lay.maturity })
      : tr("{title}, file {file}, placed at the satellite map's image extent ({extent}). Data status: {maturity}.", { title: obs.title, file: obs.file, extent: ext, maturity: lay.maturity });
    $("fw-sources-body").innerHTML = `
      <h3>${esc(tr("What moves in this scene"))}</h3>
      <p>${esc(fl.method)}</p><p>${esc(fl.support_rule)}</p><ul>${banks}</ul>
      <p>${esc(tr("Not in the data: {text}", { text: fl.not_supported }))}</p>
      ${d.flow_lines_shown ? `<p>${esc(tr("Rain and runoff: {method}.", { method: d.flow_lines.method }))}</p>` : ""}
      ${br}${cn}${tl}${kal}
      <h3>${esc(tr("The satellite layer at the end"))}</h3>
      <p>${esc(satP)} ${esc(f.text)} ${esc(tr("It was not used to build the animation. The last view uses the satellite map's own framing of the study area."))}</p>
      <h3>${esc(tr("Data"))}</h3>
      <p>${esc(tr("Elevation: {source}, about {size} m cells. River: {river}. Study area: {study}.", { source: fl.elevation.source, size: Math.round(fl.elevation.cell_size_m), river: d.river.source, study: d.study_area.source }))}
      ${esc(tr("Heights in the 3D view are stretched ×{x} so the land is visible; they flatten at the end.", { x: EXAG }))}</p>
      <p class="fw-attrib" lang="en">Elevation: <a href="https://registry.opendata.aws/terrain-tiles/" rel="noopener">Terrain Tiles</a> (Mapzen/Tilezen on AWS Open Data); SRTM terrain data courtesy of the U.S. Geological Survey.
      River and mapped features: © <a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a> contributors.
      Close-view background: EOxCloudless <a href="https://cloudless.eox.at" rel="noopener">https://cloudless.eox.at</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025), not from the flood date.
      Study area and satellite layer: this project (NISAR GCOV). Drawn with MapLibre GL JS.</p>`;
  }

  // Texts of follow_water.json in the chosen language (ids, numbers and coordinates stay as they are)
  function localize() {
    data.ui = I.tx(raw.ui);
    data.final_layer = I.tx(raw.final_layer);
    data.media = I.tx(raw.media);
    data.flood = I.tx(raw.flood);
    data.river = { ...raw.river, source: I.tx(raw.river.source) };
    data.study_area = { ...raw.study_area, source: I.tx(raw.study_area.source) };
    data.flow_lines = { ...raw.flow_lines, method: I.tx(raw.flow_lines.method) };
  }
  // Everything written on the page for the current language (the slider value, the camera and the layers are not touched)
  function writeTexts() {
    const d = data;
    $("fw-sub").textContent = d.ui.sub;
    $("fw-key-river").lastElementChild.textContent = d.ui.river_key;
    const oc = document.querySelector(".fw-key .k-oldch"), em = document.querySelector(".fw-key .k-emb");
    if (oc) oc.nextElementSibling.textContent = d.ui.oldch_key;
    if (em) em.nextElementSibling.textContent = d.ui.emb_key;
    document.title = tr("Follow the Water — {place} — Surface Explorer", { place: d.ui.area_label.split("·").pop().trim() });
    $("fw-map").setAttribute("aria-label", tr("3D terrain view: {sub}. An illustrative flood spread grows from the river bank; at the end the satellite layer of the same study area is shown instead.", { sub: d.ui.sub }));
    setBack();
    buildMedia();
    if (obs) {
      const fl = d.final_layer, c = obs.period;
      const title = tr("{title} · {from}–{to}", { title: fl.title, from: I.fmt.short(c[0]), to: I.fmt.short(c[1], true) });
      obs.title = `${title} · ${obs.maturity}`;
      obs.caption = esc(fl.kind === "support"
        ? tr("{title}. Possible water, not confirmed flooding. Data status: {maturity}.", { title, maturity: obs.maturity })
        : tr("{title}. A change in the radar signal, not mapped floodwater. Data status: {maturity}.", { title, maturity: obs.maturity }));
      $("fw-key-obs").lastElementChild.textContent = tr("{title} {suffix} · satellite observation", { title, suffix: fl.key_suffix });
      if (lastLay) buildSources(lastLay);
    }
    for (const L of labelTexts) L.el.textContent = L.text();
    if (TL) buildControls();
    if (ready) draw();
  }
  const labelTexts = []; // map labels and the text they show (written again after a language change)
  I.onChange(() => { if (!raw) return; localize(); writeTexts(); });

  // v67: scenes that follow a route down a valley (follow_water.json "kind": "route") are drawn by follow-route.js, built from the event record
  function startRoute(d) {
    return new Promise((resolve, reject) => {
      const js = document.createElement("script"); js.src = "follow-route.js?v=68";
      js.onload = () => (window.FollowRoute ? resolve() : reject(new Error("route player missing")));
      js.onerror = () => reject(new Error("route player not loaded"));
      document.head.appendChild(js);
    }).then(() => window.FollowRoute({ raw: d, I, $, esc, back, setBack, loadLib, webglOk, EVENT }));
  }
  const notAvailable = () => fail(tr("There is no Follow the Water scene for “{event}”. The satellite map for this event still works.", { event: EVENT }), tr("Follow the Water is not available for this event"));
  I.ready().then(() => { I.picker($("fw-lang")); setBack(); return getJson(`data/${EVENT}/follow_water.json`); }).then((d) => {
    if (d.event_id === EVENT && d.kind === "route") return startRoute(d); // v67: route scene (Gyirong–Rasuwa), its own player file
    if (d.event_id !== EVENT || !d.flood || !d.timeline) { notAvailable(); return null; }
    raw = JSON.parse(JSON.stringify(d));
    data = d; TL = d.timeline;
    localize();
    EXAG = d.display.exaggeration;
    buildControls();
    buildPulse();
    if (!d.flow_lines_shown) $("fw-key-flow").remove();
    // mapped reference lines drawn in the scene (Habiganj): in the key too, with what they are not
    const mf = d.mapped_features || {}, spreadLi = $("fw-key-spread");
    if ((mf.old_channel || []).length && d.ui.oldch_key) spreadLi.insertAdjacentHTML("beforebegin", `<li><i class="k-oldch"></i><span></span></li>`);
    if ((mf.embankment_roads || []).length && d.ui.emb_key) spreadLi.insertAdjacentHTML("beforebegin", `<li><i class="k-emb"></i><span></span></li>`);
    $("fw-caption-text").textContent = d.ui.captions[0][1];
    $("fw-credit").textContent = "Elevation: Terrain Tiles (SRTM, USGS) · River: © OpenStreetMap contributors · Background: EOxCloudless 2025 · MapLibre";
    writeTexts();
    if (!webglOk()) { fail(tr("This browser has no WebGL, which the 3D terrain needs.")); return null; }
    // The satellite layer exactly as the event map defines it: same layers.json entry, same file, same image extent, same class
    return Promise.all([getJson(`data/${EVENT}/layers.json`), getJson(`data/${EVENT}/text.en.json`).catch(() => null)]).then(([lay, txt]) => {
      const fl = d.final_layer;
      let c, classKey = null;
      if (fl.kind === "support") c = lay.support.find((x) => x.id === fl.id);
      else {
        classKey = (txt && txt.simple && txt.simple.default_class) || fl.key; // the class the event map shows first
        const sc = lay.signal_classes.classes[classKey];
        c = { file: sc.file, period: lay.signal_classes.pair, classes: { 1: { color: sc.color } } };
      }
      const [[bs, bw], [bn, be]] = lay.bounds_latlon; // the image overlay extent used by app.js (L.imageOverlay(file, meta.bounds_latlon))
      CAND_OPACITY = fl.opacity;
      obs = { url: `data/${c.file}`, file: c.file, period: c.period, coordinates: [[bw, bn], [be, bn], [be, bs], [bw, bs]], maturity: lay.maturity, classKey,
        title: "", caption: "", color: (c.classes && c.classes["1"] && c.classes["1"].color) || "" };
      if (obs.color) document.querySelector(".k-nisar").style.background = obs.color;
      lastLay = lay;
      writeTexts();
      const loadVals = new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => {
          const cv = document.createElement("canvas"); cv.width = im.width; cv.height = im.height;
          const g = cv.getContext("2d", { willReadFrequently: true });
          g.drawImage(im, 0, 0);
          const px = g.getImageData(0, 0, im.width, im.height).data, n = im.width * im.height, idx = [];
          vals = new Float32Array(n); bankOf = new Uint8Array(n);
          for (let i = 0; i < n; i++) {
            const u = px[i * 4] * 256 + px[i * 4 + 1];
            vals[i] = u >= 65535 ? 2 : u / 60000; bankOf[i] = Math.round(px[i * 4 + 2] / 40);
            if (u < 65535) idx.push(i);
          }
          cellsIdx = Int32Array.from(idx);
          resolve();
        };
        im.onerror = () => reject(new Error("spread image"));
        im.src = `data/${EVENT}/${d.flood.image}`;
      });
      return Promise.all([loadLib(), loadVals]).then(([lib]) => start(lib));
    });
  }).catch((e) => (e && e.status === 404 && !data ? notAvailable()
    : fail(data ? tr("The files for the {place} scene could not be loaded. Check the internet connection and try again.", { place: data.ui.area_label.split("·").pop().trim() })
      : tr("The scene files could not be loaded. Check the internet connection and try again."))));
})();
