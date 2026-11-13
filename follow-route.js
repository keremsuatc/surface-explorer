/* v67: Follow the Water — route scene (data/<event>/follow_water.json with "kind": "route"; first used for Gyirong–Rasuwa).
   Built from the event's catalog record (catalog/events/<event>.json, web.follow) by pipeline/export/build_event_web.py <event> follow:
   the route is a chain of mapped river channels (OpenStreetMap), the stops, places, camera framing and texts are in the record,
   and the observation layers are the UNOSAT files already used by the event map. follow.js loads this file when it finds a route scene;
   the Habiganj and Chókwè scenes (kind "spread") do not use it.
   Like the spread player, everything on screen is a function of one slider value t (0..1) and of the UNOSAT switch:
   the same slider value gives the same picture whether it is reached forwards or backwards.
   What moves is illustrative (a front along the mapped river, and pieces of UNOSAT's affected area uncovered in river order);
   no water depth, speed or arrival time is shown. The UNOSAT switch replaces the illustrative layers with the observation in the same view. */
window.FollowRoute = function (ctx) {
  "use strict";
  const { raw, I, $, esc, back, setBack, loadLib, EVENT } = ctx;
  const tr = (k, v) => I.t(k, v);
  const clamp = (v) => Math.max(0, Math.min(1, v));
  const ease = (k) => { k = clamp(k); return k * k * (3 - 2 * k); };
  const mix = (a, b, k) => a + (b - a) * k;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const slider = $("fw-time");
  const LOAD_TIMEOUT_MS = 25000;
  // v68: three things that must never be confused: ice and rock (white / dark pieces), the water-mud flow (brown line, light head) and areas
  // (illustrative: brown stripes; UNOSAT: solid orange with an outline)
  const C = { river: "#4da3ff", trail: "#6b3f1d", head: "#f2c48a", obs: "#ff8c1a", zone: "#ff3b30", lake: "#1e90ff", ice: "#f4fbff", iceLine: "#0d2236", rock: "#3a2c22", rockLine: "#efe2cc" };
  let data = null, map = null, ready = false, failed = false, t = 0, anim = 0, pending = 0, showObs = false;
  let cams = null, camDesc = null, lastCam = "", lastFk = null, lastVis = "", lastIce = "", stageBtns = [], labels = [], focus = {};
  const paint = new Map();

  // ---- the route: distances along it (km, from the builder) and the same in map units, for the line gradient ----
  const R = raw.route, P = R.coords, KM = R.km, L = R.length_km, S = raw.stops, W = S.map((s) => s.t);
  // v68: a stop with "descent": the first part of the travel after it shows ice and rock falling to the valley floor; the flow starts after that
  const DS = S.findIndex((s) => s.descent), DESC = DS >= 0 ? S[DS].descent : null;
  const GR = raw.route_ground_m, groundAt = (d) => { const x = Math.max(0, Math.min(L, d)) / GR.step_km, i = Math.min(GR.values.length - 2, Math.floor(x)); return mix(GR.values[i], GR.values[i + 1], x - i); };
  const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  const MP = [0];
  for (let i = 1; i < P.length; i++) MP.push(MP[i - 1] + Math.hypot((P[i][0] - P[i - 1][0]) * Math.PI / 180, mercY(P[i][1]) - mercY(P[i - 1][1])));
  const idxAt = (d) => { let lo = 1, hi = KM.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (KM[m] < d) lo = m + 1; else hi = m; } return lo; };
  function at(d) { // [lon, lat] at d km along the route
    d = Math.max(0, Math.min(L, d));
    const i = idxAt(d), k = (d - KM[i - 1]) / Math.max(1e-9, KM[i] - KM[i - 1]);
    return [mix(P[i - 1][0], P[i][0], k), mix(P[i - 1][1], P[i][1], k)];
  }
  const progress = (d) => { if (d <= 0) return 0; if (d >= L) return 1; const i = idxAt(d), k = (d - KM[i - 1]) / Math.max(1e-9, KM[i] - KM[i - 1]); return mix(MP[i - 1], MP[i], k) / MP[MP.length - 1]; };
  function smooth(d) { // route position averaged over ±1.2 km: a calm path for the camera in the winding gorge
    let x = 0, y = 0;
    for (let j = -6; j <= 6; j++) { const q = at(d + j * 0.2); x += q[0]; y += q[1]; }
    return [x / 13, y / 13];
  }
  const bearingOf = (a, b) => (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + 360) % 360;

  // ---- where the slider is: holding at a stop, or travelling between two stops ----
  function phase(v) {
    for (let i = 0; i < S.length; i++) {
      if (v <= W[i][1] + 1e-9) return v >= W[i][0] - 1e-9 ? { hold: true, i } : { hold: false, i: i - 1, k: (v - W[i - 1][1]) / Math.max(1e-9, W[i][0] - W[i - 1][1]) };
    }
    return { hold: true, i: S.length - 1 };
  }
  // travel progress of the flow (0..1) after the descent part, if this travel has one; null while ice and rock are still falling
  function flowK(ph) { if (ph.i !== DS) return ph.k; return ph.k < DESC.share ? null : (ph.k - DESC.share) / (1 - DESC.share); }
  function frontKm(v) { // -1: nothing has moved yet (first stop, and while ice and rock fall)
    const ph = phase(v);
    if (ph.hold) return ph.i === 0 ? -1 : S[ph.i].km;
    const k = flowK(ph);
    if (k === null) return -1;
    return mix(ph.i === 0 ? 0 : S[ph.i].km, S[ph.i + 1].km, ease(k));
  }
  // ice and rock: u = 0..1 while they fall, then they fade as the flow starts (gone after 30 % of the flow part)
  function descentAt(v) {
    if (!DESC) return null;
    const ph = phase(v);
    if (ph.hold || ph.i !== DS) return null;
    if (ph.k < DESC.share) return { u: ph.k / DESC.share, fade: 1 };
    const k2 = (ph.k - DESC.share) / (1 - DESC.share);
    return k2 < 0.3 ? { u: 1, fade: 1 - k2 / 0.3 } : null;
  }
  const dateAt = (v) => { const ph = phase(v); return ph.hold ? S[ph.i].date : S[ph.k < 0.5 ? ph.i : ph.i + 1].date; };

  // ---- camera: from the slider value only (jumpTo) ----
  function lerpCam(a, b, k) {
    const db = ((b.bearing - a.bearing) % 360 + 540) % 360 - 180;
    return { center: [mix(a.center[0], b.center[0], k), mix(a.center[1], b.center[1], k)], zoom: mix(a.zoom, b.zoom, k), pitch: mix(a.pitch, b.pitch, k), bearing: (a.bearing + db * k + 360) % 360 };
  }
  function followCam(fk) { // just ahead of the front, looking down the valley
    const c = smooth(fk + 1.0), brg = bearingOf(smooth(fk - 2), smooth(fk + 2.5));
    const box = map.getContainer(), span = 9000; // metres across the view
    const z = Math.log2(box.clientWidth * 40075016 * Math.cos(c[1] * Math.PI / 180) / (512 * span));
    return { center: c, zoom: Math.min(13.2, z), pitch: box.clientWidth < 600 ? 48 : 52, bearing: brg };
  }
  function camAt(v) {
    const ph = phase(v);
    if (ph.hold) return cams[ph.i];
    const a = cams[ph.i], b = cams[ph.i + 1], k = ph.k;
    if (reduced.matches) return k < 0.5 ? a : b;
    if (Math.abs(S[ph.i + 1].km - S[ph.i].km) < 0.01) { // same front (back up the valley to the lakes): rise, move, come down
      const c = lerpCam(a, b, ease(k));
      c.zoom -= 2.2 * Math.sin(Math.PI * k);
      c.pitch = Math.max(0, c.pitch - 20 * Math.sin(Math.PI * k));
      return c;
    }
    let a2 = a, k2 = k;
    if (ph.i === DS && camDesc) { // first the detachment point, then the slope and the valley floor as ice and rock come down
      if (k < DESC.share) return lerpCam(a, camDesc, ease(Math.min(1, (k / DESC.share) / 0.4)));
      a2 = camDesc; k2 = (k - DESC.share) / (1 - DESC.share);
    }
    const f = followCam(frontKm(v)), E = 0.22;
    if (k2 < E) return lerpCam(a2, f, ease(k2 / E));
    if (k2 > 1 - E) return lerpCam(f, b, ease((k2 - (1 - E)) / E));
    return f;
  }
  function frame() {
    const box = map.getContainer(), narrow = box.clientWidth < 600;
    // fixed margins (top: the date panel; bottom: part of the key): the framing must not depend on the language of the key
    const h = box.clientHeight, padOf = (s) => (narrow ? { top: Math.round(h * 0.2), bottom: Math.round(h * (s.narrow_pad_bottom || 0.22)), left: 14, right: 14 } : { top: 84, bottom: 70, left: 60, right: 60 });
    cams = S.map((s) => {
      const c = map.cameraForBounds(s.fit_bounds, { bearing: s.bearing, padding: padOf(s) });
      // a tilted view shows more ground at the top: come a little closer than the flat fit
      return { center: [c.center.lng, c.center.lat], zoom: Math.min(14, c.zoom + (s.pitch > 30 ? 0.15 : 0)), pitch: narrow ? s.pitch - 4 : s.pitch, bearing: s.bearing };
    });
    if (DESC) {
      const c = map.cameraForBounds(DESC.fit_bounds, { bearing: DESC.bearing, padding: padOf(S[DS]) });
      camDesc = { center: [c.center.lng, c.center.lat], zoom: Math.min(14, c.zoom + 0.15), pitch: narrow ? DESC.pitch - 4 : DESC.pitch, bearing: DESC.bearing };
    }
    lastCam = "";
  }
  function setCamera(v) {
    const c = camAt(v);
    const key = [c.center[0].toFixed(6), c.center[1].toFixed(6), c.zoom.toFixed(4), c.pitch.toFixed(2), c.bearing.toFixed(2)].join();
    if (key === lastCam) return;
    lastCam = key;
    map.jumpTo(c);
  }

  function setP(id, prop, val) {
    const k = id + "|" + prop, s = typeof val === "number" ? val.toFixed(4) : JSON.stringify(val);
    if (paint.get(k) === s) return false;
    paint.set(k, s);
    map.setPaintProperty(id, prop, val);
    return true;
  }
  // window of a stop on the slider, widened a little, as a 0..1 visibility (labels and stop layers fade in and out with the slider)
  const near = (v, w, m = 0.03) => clamp(Math.min((v - (w[0] - m)) / m, ((w[1] + m) - v) / m));
  const shownAt = (v, ids) => Math.max(0, ...S.map((s, i) => (ids.includes(s.id) ? near(v, W[i]) : 0)));

  function draw() {
    if (!ready) return;
    const v = t, ph = phase(v), fk = frontKm(v);
    let changed = false;
    // illustrative front and uncovered pieces (hidden while the UNOSAT layer is on)
    const fq = fk < 0 ? -1 : Math.round(fk * 20) / 20; // 50 m steps: the filter changes only when the front has really moved
    if (fq !== lastFk) {
      lastFk = fq;
      map.setFilter("fr-pieces", ["<=", ["get", "d"], fq]);
      const p = progress(fk);
      map.setPaintProperty("fr-front", "line-gradient", fk < 0 ? ["interpolate", ["linear"], ["line-progress"], 0, "rgba(0,0,0,0)", 1, "rgba(0,0,0,0)"]
        : ["interpolate", ["linear"], ["line-progress"], 0, C.trail, Math.max(0.0001, p - 0.004), C.trail, Math.max(0.0002, p - 0.0005), C.head,
          Math.min(0.9999, Math.max(0.0003, p + 0.0015)), "rgba(0,0,0,0)", 1, "rgba(0,0,0,0)"]);
      changed = true;
    }
    const illu = showObs ? 0 : 1;
    changed = setP("fr-pieces", "fill-opacity", 0.9 * illu) || changed;
    // ice and rock pieces (illustrative): positions from the slider value only
    const dsc = descentAt(v), iceKey = dsc ? `${dsc.u.toFixed(3)}|${dsc.fade.toFixed(3)}` : "";
    let iceMid = null;
    if (iceKey !== lastIce) {
      lastIce = iceKey;
      const feats = [];
      if (dsc) for (const q of DESC.particles) {
        const p = clamp((dsc.u - q[5]) / 0.65), e = p * p * (3 - 2 * p), w = q[6] * 0.0005 * Math.sin(Math.PI * p);
        const dx = q[2] - q[0], dy = q[3] - q[1], n = Math.hypot(dx, dy) || 1;
        const o = clamp((dsc.u - q[5]) / 0.04) * dsc.fade;
        if (o > 0.001) feats.push({ type: "Feature", properties: { ice: q[4], o: +o.toFixed(3) }, geometry: { type: "Point", coordinates: [q[0] + dx * e - dy / n * w, q[1] + dy * e + dx / n * w] } });
      }
      map.getSource("ice").setData({ type: "FeatureCollection", features: feats });
      changed = true;
    }
    if (dsc) { // where the cloud of pieces is (for its label): mean position and height
      let x = 0, y = 0, pm = 0;
      for (const q of DESC.particles) { const p = clamp((dsc.u - q[5]) / 0.65), e = p * p * (3 - 2 * p); x += q[0] + (q[2] - q[0]) * e; y += q[1] + (q[3] - q[1]) * e; pm += e; }
      const nn = DESC.particles.length;
      iceMid = { ll: [x / nn, y / nn], h: mix(DESC.start_ground_m, DESC.end_ground_m, pm / nn), o: clamp(dsc.u / 0.12) * dsc.fade * (dsc.u > 0.97 ? clamp((1 - dsc.u) / 0.03 + 0.4) : 1) };
    }
    changed = setP("fr-front", "line-opacity", illu) || changed;
    changed = setP("fr-obs-fill", "fill-opacity", showObs ? 0.3 : 0) || changed;
    changed = setP("fr-obs-line", "line-opacity", showObs ? 1 : 0) || changed;
    // UNOSAT detachment zone and lakes: only at the stops that name them (the lakes were mapped on 28 August)
    const zone = shownAt(v, S.filter((s) => s.show.includes("source_zone")).map((s) => s.id)), lake = shownAt(v, S.filter((s) => s.show.includes("lakes")).map((s) => s.id));
    changed = setP("fr-zone-line", "line-opacity", zone) || changed;
    changed = setP("fr-zone-fill", "fill-opacity", 0.18 * zone) || changed;
    changed = setP("fr-lakes-line", "line-opacity", lake) || changed;
    changed = setP("fr-lakes-fill", "fill-opacity", 0.5 * lake) || changed;
    setCamera(v);
    if (changed) refreshDrape(); else map.triggerRepaint();
    // labels: at their stops, and (for places along the river) while the front passes them
    for (const L_ of labels) {
      let o = shownAt(v, L_.p.stops);
      if (L_.p.near && !ph.hold && fk >= 0) o = Math.max(o, clamp(1 - (Math.abs(fk - L_.p.km) - 2.5) / 1.5));
      if (dsc && L_.p.stops.includes(S[DS].id)) o *= clamp(1 - dsc.u / 0.12); // while ice and rock fall, only their label is shown
      if (L_.p.kind === "focus") { const tx = showObs ? L_.nameObs : L_.name; if (L_.el.textContent !== tx) L_.el.textContent = tx; L_.el.classList.toggle("obs", showObs); }
      const s = o.toFixed(3);
      if (L_.el.style.opacity !== s) L_.el.style.opacity = s;
    }
    // v68: one label on what is happening now: the falling ice and rock, or the head of the water-mud flow (never both)
    if (focus.ice) { // a hidden moving label goes back to the start of the route, so its place also depends on the slider value only
      if (iceMid) { focus.ice.ll.lng = iceMid.ll[0]; focus.ice.ll.lat = iceMid.ll[1]; focus.ice.h = iceMid.h * raw.exaggeration; }
      else { focus.ice.ll.lng = P[0][0]; focus.ice.ll.lat = P[0][1]; focus.ice.h = GR.values[0] * raw.exaggeration; }
      focus.ice.el.style.opacity = (iceMid && !showObs ? iceMid.o : 0).toFixed(3);
    }
    if (focus.flow) {
      const moving = !ph.hold && fk >= 0 && Math.abs(S[ph.i + 1].km - S[ph.i].km) > 0.01, atStop = ph.hold && fk >= 0 && fk < L - 0.01;
      const o = showObs || dsc ? 0 : moving ? 1 : atStop ? 1 : 0;
      const q = at(Math.max(0, fk)); focus.flow.ll.lng = q[0]; focus.flow.ll.lat = q[1]; focus.flow.h = groundAt(Math.max(0, fk)) * raw.exaggeration;
      focus.flow.el.style.opacity = o.toFixed(3);
    }
    // key: only what is on screen
    const vis = [!showObs && fk >= 0, !showObs && fk >= 0, showObs, zone > 0.02, lake > 0.02, !!dsc && !showObs, !!dsc && !showObs].map(Number).join("");
    if (vis !== lastVis) { lastVis = vis; [...$("fw-stage").querySelectorAll(".fw-key li[data-k]")].forEach((li, j) => { li.hidden = vis[j] !== "1"; }); }
    // texts: date (and how long after the flow), place and one sentence
    const date = dateAt(v), flow = data.texts.flow_date, days = Math.round((Date.parse(date) - Date.parse(flow)) / 864e5);
    const gap = days > 0 ? tr("{days} days after the {date} flow", { days, date: I.fmt.day(flow, false) }) : "";
    // where the view is, first; then the date (and how long after the flow)
    const placeNow = ph.hold ? data.stops[ph.i].place : dsc && dsc.fade === 1 ? data.stops[ph.i].place : `${data.stops[ph.i].place} → ${data.stops[ph.i + 1].place}`;
    const dateHtml = `<b>${esc(placeNow)}</b><span class="frd-date">${esc(I.fmt.day(date))}</span>${gap ? `<span class="frd-gap">${esc(gap)}</span>` : ""}`;
    if ($("fr-date").innerHTML !== dateHtml) $("fr-date").innerHTML = dateHtml;
    $("fr-date").classList.toggle("later", days > 0);
    let text;
    if (ph.hold) { const s = data.stops[ph.i]; text = `<b>${esc(s.place)}</b> · ${esc(I.fmt.short(s.date))}<br>${esc(s.sentence)}`; } // the gap in days is on the map (date panel)
    else text = esc(dsc && dsc.fade === 1 ? data.texts.descent : data.texts.travel);
    if ($("fw-caption-text").innerHTML !== text) $("fw-caption-text").innerHTML = text;
    const cur = ph.hold ? ph.i : (ph.k < 0.5 ? ph.i : ph.i + 1);
    stageBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(i === cur)));
    const badge = showObs ? `${tr("Illustrative animation")} · ${tr("UNOSAT layer on")}` : tr("Illustrative animation");
    if ($("fw-badge").dataset.text !== badge) {
      $("fw-badge").dataset.text = badge;
      const [head, ...rest] = badge.split(" · ");
      $("fw-badge").innerHTML = `<span>${esc(head)}</span>${rest.length ? `<span class="fw-badge-more"> · ${esc(rest.join(" · "))}</span>` : ""}`;
    }
    slider.setAttribute("aria-valuetext", `${data.stops[cur].chip}: ${$("fw-caption-text").textContent}`);
  }
  // With terrain, MapLibre keeps draped layers in a cache that does not always notice a filter or opacity change (MapLibre 5.6.0 internals)
  function refreshDrape() {
    try { const sc = map.terrain && map.terrain.sourceCache; if (sc && sc.freeRtt) sc.freeRtt(); } catch (e) { /* other version: skip */ }
    map.triggerRepaint();
  }

  function setT(v, fromSlider) {
    t = clamp(v);
    if (!fromSlider) slider.value = String(Math.round(t * 1000));
    draw();
  }
  slider.addEventListener("input", () => {
    cancelAnimationFrame(anim);
    t = clamp(Number(slider.value) / 1000);
    if (!pending) pending = requestAnimationFrame(() => { pending = 0; draw(); });
  });
  const target = (i) => (i === 0 ? 0 : i === S.length - 1 ? 1 : (W[i][0] + W[i][1]) / 2);
  function goTo(i) { // a stop button moves the slider to that stop (forwards or backwards), through everything in between
    cancelAnimationFrame(anim);
    const from = t, to = target(i);
    if (reduced.matches || Math.abs(to - from) < 1e-4) { setT(to); return; }
    const t0 = performance.now(), dur = Math.min(9000, Math.max(1200, 9000 * Math.abs(to - from)));
    const step = (now) => { const k = clamp((now - t0) / dur); setT(from + (to - from) * k); if (k < 1) anim = requestAnimationFrame(step); };
    anim = requestAnimationFrame(step);
  }
  function setObs(on) { showObs = !!on; const b = $("fr-obs-btn"); b.setAttribute("aria-pressed", String(showObs)); b.textContent = showObs ? tr("Hide UNOSAT layer") : tr("Show UNOSAT layer"); draw(); }

  // ---- page furniture ----
  function buildControls() {
    const box = $("fw-stages"), ticks = $("fw-ticks");
    box.style.gridTemplateColumns = `repeat(${S.length}, minmax(0, 1fr))`;
    box.innerHTML = data.stops.map((s, i) => `<button type="button" class="fw-btn fw-stage-btn" data-stage="${i}" aria-pressed="false">${esc(s.chip)}</button>`).join("");
    stageBtns = [...box.querySelectorAll(".fw-stage-btn")];
    stageBtns.forEach((b) => b.addEventListener("click", () => { if (ready) goTo(Number(b.dataset.stage)); }));
    // ticks: each stop's name where its stretch of the slider starts
    ticks.style.gridTemplateColumns = S.map((s, i) => `${(((i + 1 < S.length ? W[i + 1][0] : 1) - W[i][0]) * 100).toFixed(2)}fr`).join(" ");
    ticks.innerHTML = data.stops.map((s) => `<span>${esc(s.chip)}</span>`).join("");
    if (!$("fr-obs-btn")) box.insertAdjacentHTML("afterend", `<button type="button" id="fr-obs-btn" class="fw-btn fr-obs-btn" aria-pressed="false"></button>`);
    if (!$("fr-credit")) $("fw-controls").insertAdjacentHTML("beforeend", `<p id="fr-credit" class="fr-credit" lang="en">Elevation: Terrain Tiles (SRTM, USGS) · Rivers: © OpenStreetMap contributors · UNOSAT (CC BY-SA) · Background: EOxCloudless 2025 · MapLibre</p>`);
    $("fr-obs-btn").textContent = showObs ? tr("Hide UNOSAT layer") : tr("Show UNOSAT layer");
    $("fr-obs-btn").onclick = () => setObs(!showObs);
  }
  function buildKey() {
    const o = data.observed, d = (iso) => I.fmt.day(iso);
    const paren = (txt) => { const k = txt.indexOf(" ("); return k < 0 ? esc(txt) : `${esc(txt.slice(0, k))}<span class="k-more">${esc(txt.slice(k))}</span>`; }; // the part in brackets: hidden on phones
    const two = (txt) => { const k = txt.lastIndexOf(" · "); return k < 0 ? esc(txt) : `${esc(txt.slice(0, k))}<span class="k-more"> · ${esc(txt.slice(k + 3))}</span>`; };
    $("fw-stage").querySelector(".fw-key").innerHTML =
      `<li><i class="k-river"></i><span>${esc(tr("River (OpenStreetMap)"))}</span></li>` +
      `<li data-k="pieces"><i class="fr-k fr-k-piece"></i><span>${paren(tr("Illustrative affected area (cut from UNOSAT's area)"))}</span></li>` +
      `<li data-k="front"><i class="fr-k fr-k-front"></i><span>${esc(data.texts.flow_label)}</span></li>` +
      `<li data-k="obs"><i class="fr-k fr-k-obs"></i><span>${two(tr(o.extent.what, { date: d(o.extent.date) }))}</span></li>` +
      `<li data-k="zone"><i class="fr-k fr-k-zone"></i><span>${two(tr(o.source_zone.what, { date: d(o.source_zone.date) }))}</span></li>` +
      `<li data-k="lakes"><i class="fr-k fr-k-lake"></i><span>${two(tr(o.lakes.what, { date: d(o.lakes.date) }))}</span></li>` +
      `<li data-k="ice"><i class="fr-k fr-k-ice"></i><span>${esc(tr("Ice (illustrative)"))}</span></li>` +
      `<li data-k="rock"><i class="fr-k fr-k-rock"></i><span>${esc(tr("Rock debris (illustrative)"))}</span></li>` +
      `<li id="fw-credit" class="fw-credit" lang="en">Elevation: Terrain Tiles (SRTM, USGS) · Rivers: © OpenStreetMap contributors · UNOSAT (CC BY-SA) · Background: EOxCloudless 2025 · MapLibre</li>`;
    lastVis = "";
  }
  function buildSources() {
    const mv = raw.method_values, n = (x, k = 1) => I.fmt.num(x, k);
    const vals = { m: n(mv.m, 0), km: n(mv.km, 0), share: I.fmt.pct(mv.share, 1), rule: data.route.rule, names: data.route.names };
    const meth = data.method.map(([h, p]) => `<h3>${esc(h)}</h3><p>${esc(String(p).replace(/\{(\w+)\}/g, (m, k) => (k in vals ? vals[k] : m)))}</p>`).join("");
    const stops = data.stops.map((s) => `<li><b>${esc(s.place)}</b> · ${esc(I.fmt.day(s.date))}: ${esc(s.sentence)} ` +
      s.sources.map((q) => `<a href="${esc(q.url)}" rel="noopener">${esc(q.label)}</a>`).join(" · ") + `</li>`).join("");
    const o = data.observed;
    const src = data.sources.map((q) => `<li><a href="${esc(q.url)}" rel="noopener">${esc(q.publisher)}</a>: ${esc(q.what)}</li>`).join("");
    $("fw-sources-body").innerHTML = `${meth}
      <h3>${esc(tr("Stops and sources"))}</h3><ul>${stops}</ul>
      <h3>${esc(tr("Observation layers"))}</h3>
      <p>${esc(tr(o.extent.what, { date: I.fmt.day(o.extent.date) }))}. ${esc(tr(o.source_zone.what, { date: I.fmt.day(o.source_zone.date) }))}. ${esc(tr(o.lakes.what, { date: I.fmt.day(o.lakes.date) }))}. ${esc(o.status)}
        <a href="${esc(o.data_url)}" rel="noopener">${esc(tr("UNOSAT data on HDX"))}</a></p>
      <h3>${esc(tr("Data"))}</h3>
      <p>${esc(tr("Elevation: {source}. Heights are not stretched.", { source: raw.elevation.source }))} ${esc(data.background.note)}</p>
      <ul>${src}</ul>
      <p class="fw-attrib" lang="en">Elevation: <a href="https://registry.opendata.aws/terrain-tiles/" rel="noopener">Terrain Tiles</a> (Mapzen/Tilezen on AWS Open Data); SRTM terrain data courtesy of the U.S. Geological Survey.
      Rivers and places: © <a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a> contributors.
      Affected area, detachment zone and lakes: UNOSAT (CC BY-SA), FL20260826NPL, data of 2 September 2026.
      Background: EOxCloudless <a href="https://cloudless.eox.at" rel="noopener">https://cloudless.eox.at</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025), not from the flood date. Drawn with MapLibre GL JS.</p>`;
  }
  function localize() {
    data = { stops: I.tx(raw.stops), texts: I.tx(raw.texts), method: I.tx(raw.method), sources: I.tx(raw.sources), observed: raw.observed,
      route: { rule: I.tx(raw.route.rule), names: I.tx(raw.route.names) }, background: I.tx(raw.background), places: I.tx(raw.places) };
    data.observed = { ...raw.observed, status: I.tx(raw.observed.status) };
  }
  function writeTexts() {
    $("fw-sub").textContent = data.texts.sub;
    document.title = tr("Follow the Water — {place} — Surface Explorer", { place: data.texts.place_title });
    $("fw-map").setAttribute("aria-label", tr("3D terrain view: {sub}. An illustrative flow moves along the river; the UNOSAT layer can be switched on for comparison.", { sub: data.texts.sub }));
    document.querySelector(".fw-mode").textContent = tr("Animation");
    setBack();
    buildControls();
    buildKey();
    buildSources();
    labels.forEach((L_, i) => { L_.name = data.places[i].name; L_.nameObs = data.places[i].name_obs; L_.el.textContent = showObs && L_.p.kind === "focus" ? L_.nameObs : L_.name; });
    if (focus.ice) focus.ice.el.textContent = data.texts.ice_label;
    if (focus.flow) focus.flow.el.textContent = data.texts.flow_label;
    if (ready) draw();
  }
  I.onChange(() => { localize(); writeTexts(); });

  function fail(why) {
    if (failed) return;
    failed = true; ready = false;
    cancelAnimationFrame(anim); cancelAnimationFrame(pending);
    $("fw-fallback-why").textContent = why;
    $("fw-fallback").hidden = false;
    $("fw-loading").hidden = true;
    $("fw-controls").setAttribute("aria-disabled", "true");
    slider.disabled = true; stageBtns.forEach((b) => { b.disabled = true; });
    if ($("fr-obs-btn")) $("fr-obs-btn").disabled = true;
    $("fw-badge").hidden = true;
    try { map && map.remove(); } catch (e) { /* gone */ }
    map = null;
  }

  function start(maplibregl) {
    const ob = raw.observed, url = (f) => `data/${EVENT}/${f}`;
    const dem = { type: "raster-dem", tiles: [raw.elevation.tile_url], encoding: "terrarium", tileSize: 256, maxzoom: raw.elevation.maxzoom };
    const line = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: P } };
    const NONE = ["interpolate", ["linear"], ["line-progress"], 0, "rgba(0,0,0,0)", 1, "rgba(0,0,0,0)"];
    map = new maplibregl.Map({
      container: "fw-map", interactive: false, attributionControl: false, maxPitch: 70, fadeDuration: 0, pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      style: {
        version: 8, transition: { duration: 0, delay: 0 },
        sources: {
          terrain: dem, shade: dem,
          sat: { type: "raster", tiles: [raw.background.url], tileSize: 256, maxzoom: raw.background.maxzoom },
          route: { type: "geojson", lineMetrics: true, data: line },
          pieces: { type: "geojson", data: url(raw.pieces.file) },
          obs: { type: "geojson", data: url(ob.extent.file) },
          zone: { type: "geojson", data: url(ob.source_zone.file) },
          lakes: { type: "geojson", data: url(ob.lakes.file) },
          ice: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
        },
        terrain: { source: "terrain", exaggeration: raw.exaggeration },
        sky: { "sky-color": "#0e1820", "horizon-color": "#1c2b38", "fog-color": "#16232e", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.5, "fog-ground-blend": 0.35 },
        layers: [
          { id: "bg", type: "background", paint: { "background-color": "#16232e" } },
          { id: "fr-sat", type: "raster", source: "sat", paint: { "raster-opacity": 1, "raster-fade-duration": 0, "raster-saturation": -0.2 } },
          { id: "fr-shade", type: "hillshade", source: "shade", paint: { "hillshade-exaggeration": 0.3, "hillshade-shadow-color": "rgba(0,0,0,0.5)", "hillshade-highlight-color": "rgba(255,255,255,0.15)" } },
          { id: "fr-pieces", type: "fill", source: "pieces", filter: ["<=", ["get", "d"], -1], paint: { "fill-pattern": "fr-mud", "fill-opacity": 0.9, "fill-antialias": false } },
          { id: "fr-obs-fill", type: "fill", source: "obs", paint: { "fill-color": C.obs, "fill-opacity": 0 } },
          { id: "fr-obs-line", type: "line", source: "obs", paint: { "line-color": C.obs, "line-width": 2.4, "line-opacity": 0 } },
          { id: "fr-zone-fill", type: "fill", source: "zone", paint: { "fill-color": C.zone, "fill-opacity": 0 } },
          { id: "fr-zone-line", type: "line", source: "zone", paint: { "line-color": C.zone, "line-width": 2.2, "line-dasharray": [2, 1.5], "line-opacity": 0 } },
          { id: "fr-lakes-fill", type: "fill", source: "lakes", paint: { "fill-color": C.lake, "fill-opacity": 0 } },
          { id: "fr-lakes-line", type: "line", source: "lakes", paint: { "line-color": C.lake, "line-width": 2.5, "line-opacity": 0 } },
          { id: "fr-river-case", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#0b2a4a", "line-width": 4, "line-opacity": 0.6 } },
          { id: "fr-river", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": C.river, "line-width": 2 } },
          { id: "fr-front", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-width": 6, "line-gradient": NONE } },
          { id: "fr-ice", type: "circle", source: "ice", paint: { "circle-color": ["case", ["==", ["get", "ice"], 1], C.ice, C.rock], "circle-opacity": ["get", "o"],
            "circle-stroke-color": ["case", ["==", ["get", "ice"], 1], C.iceLine, C.rockLine], "circle-stroke-opacity": ["get", "o"], "circle-stroke-width": ["case", ["==", ["get", "ice"], 1], 1.6, 1],
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, ["case", ["==", ["get", "ice"], 1], 3.4, 3.2], 14, ["case", ["==", ["get", "ice"], 1], 7, 6.5]], "circle-pitch-alignment": "map" } },
        ],
      },
    });
    // brown stripes for the illustrative area (a texture, so it is never mistaken for UNOSAT's solid orange)
    map.on("styleimagemissing", (e) => {
      if (e.id !== "fr-mud" || map.hasImage("fr-mud")) return;
      const n = 16, cv = document.createElement("canvas"); cv.width = cv.height = n;
      const g = cv.getContext("2d");
      g.fillStyle = "rgba(107,63,29,0.55)"; g.fillRect(0, 0, n, n);
      g.strokeStyle = "rgba(226,168,104,0.95)"; g.lineWidth = 3;
      for (const o of [-n, 0, n]) { g.beginPath(); g.moveTo(o, n); g.lineTo(o + n, 0); g.stroke(); }
      map.addImage("fr-mud", g.getImageData(0, 0, n, n), { pixelRatio: 2 });
    });
    const timer = setTimeout(() => { if (!ready) fail(tr("The terrain took too long to load. Check the internet connection and try again.")); }, LOAD_TIMEOUT_MS);
    let demErrors = 0;
    map.on("error", (e) => {
      if (ready) return;
      if (e && e.sourceId === "sat") return; // background is optional
      if (e && ["pieces", "obs", "zone", "lakes"].includes(e.sourceId)) { clearTimeout(timer); fail(tr("The satellite layer could not be loaded.")); return; }
      if (e && (e.sourceId === "terrain" || e.sourceId === "shade")) { if (++demErrors >= 3) { clearTimeout(timer); fail(tr("The elevation data could not be loaded. Check the internet connection and try again.")); } }
      else if (e && e.error && /style|layer|source/i.test(String(e.error.message || ""))) { clearTimeout(timer); fail(tr("This browser could not draw the terrain view.")); }
    });
    map.on("load", () => {
      // MapLibre 5.6.0 with terrain: a raster tile found only in the tile cache can be kept as a fallback without being in the active tiles,
      // and the next update throws ("clearFadeHold" of undefined) while the camera moves to new ground. Such a tile is put back first.
      try {
        for (const sc of Object.values(map.style.sourceCaches || {})) {
          if (!sc || typeof sc._getLoadedTile !== "function" || typeof sc._addTile !== "function") continue;
          const get = sc._getLoadedTile.bind(sc);
          sc._getLoadedTile = (id) => { const tile = get(id); if (tile && !sc._tiles[tile.tileID.key]) { sc._addTile(tile.tileID); return sc._tiles[tile.tileID.key] || null; } return tile; };
        }
      } catch (e) { /* other library version: nothing to patch */ }
      frame();
      setCamera(t);
      // place labels at the ground height measured by the builder (not the terrain tiles loaded at that moment): the same slider value
      // always puts a label on the same pixel. Their opacity follows the slider.
      const stage = $("fw-stage"), shift = { bottom: "translate(-50%, -100%) translateY(-4px)", top: "translate(-50%, 4px)", left: "translate(6px, -50%)", right: "translate(-100%, -50%) translateX(-6px)" };
      labels = raw.places.map((p, i) => {
        const el = document.createElement("div");
        el.className = "fw-label fw-fixed-label fr-label fr-" + p.kind; el.textContent = data.places[i].name; el.style.opacity = "0";
        stage.appendChild(el);
        const ll = new maplibregl.LngLat(p.lonlat[0], p.lonlat[1]), h = (p.ground_m || 0) * raw.exaggeration;
        return { el, p, ll, h, shift: shift[p.anchor || "bottom"], name: data.places[i].name, nameObs: data.places[i].name_obs };
      });
      // labels that move with what is happening (illustrative ice and rock; the head of the flow): placed like the others, at a height from the builder
      const mkFocus = (cls, text) => { const el = document.createElement("div"); el.className = "fw-label fw-fixed-label fr-label " + cls; el.textContent = text; el.style.opacity = "0"; stage.appendChild(el);
        const L_ = { el, ll: new maplibregl.LngLat(P[0][0], P[0][1]), h: 0, shift: shift.bottom, dyn: true }; return L_; };
      focus = { ice: DESC ? mkFocus("fr-icel", data.texts.ice_label) : null, flow: mkFocus("fr-flowl", data.texts.flow_label) };
      const place = () => {
        for (const L_ of [...labels, ...Object.values(focus).filter(Boolean)]) {
          let q;
          try { q = map.transform.locationToScreenPoint(L_.ll, { getElevationForLngLatZoom: () => L_.h }); } catch (e) { q = map.project(L_.ll); }
          const tf = `translate(${Math.round(q.x)}px, ${Math.round(q.y)}px) ${L_.shift}`;
          if (L_.el.style.transform !== tf) L_.el.style.transform = tf;
        }
      };
      map.on("render", place);
      // short loading notice while terrain or imagery tiles are still coming (does not change the scene)
      let lw = 0;
      const loadingNote = () => { if (lw) return; lw = requestAnimationFrame(() => { lw = 0; if (map && ready) $("fr-loading").hidden = map.areTilesLoaded(); }); };
      map.on("render", loadingNote); map.on("idle", () => { if (ready) $("fr-loading").hidden = true; });
      map.once("idle", () => {
        clearTimeout(timer);
        if (failed) return;
        ready = true;
        $("fw-loading").hidden = true;
        lastFk = null;
        draw();
      });
    });
    let rz = 0;
    window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (!map) return; map.resize(); frame(); draw(); }, 120); });
    window.ftw = { get map() { return map; }, get t() { return t; }, get ready() { return ready; }, get cams() { return cams; }, get showObs() { return showObs; },
      get front() { return frontKm(t); }, phase: () => phase(t), get descent() { return descentAt(t); }, setT, setObs, goTo, data: raw, EVENT, kind: "route" };
  }

  // ---- start ----
  document.body.classList.add("fr-route");
  $("fw-stage").insertAdjacentHTML("beforeend", `<p id="fr-date" class="fr-date" aria-hidden="true"></p><p id="fr-loading" class="fr-loading" role="status" hidden></p>`);
  $("fr-loading").textContent = tr("Loading the terrain…");
  $("fw-media").hidden = true;
  localize();
  writeTexts();
  $("fw-caption-text").textContent = data.texts.travel;
  if (!ctx.webglOk()) { fail(tr("This browser has no WebGL, which the 3D terrain needs.")); return; }
  loadLib().then(start).catch(() => fail(tr("The scene files could not be loaded. Check the internet connection and try again.")));
};
