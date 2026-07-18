/**
 * Stuttgart Stadtbahn Live — Kartenoberflaeche.
 * Zeichnet Liniennetz + Stationen und animiert die Fahrzeuge, die von der
 * aktiven Datenquelle (Simulation oder spaeter Echtzeit) geliefert werden.
 */

"use strict";

(async function main() {
  /* ---- Daten laden ------------------------------------------------ */
  const [network, schedule] = await Promise.all([
    fetch("data/network.json").then((r) => r.json()),
    fetch("data/schedule.json").then((r) => r.json()),
  ]);

  const simulator = new ScheduleSimulator(network, schedule);
  const realtime = new RealtimeSource(null /* Feed-URL folgt */, simulator);

  /* ---- Theme (hell/dunkel) ---------------------------------------- */
  const THEME_KEY = "stadtbahn-theme";
  let theme =
    localStorage.getItem(THEME_KEY) ||
    (window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark");
  document.body.classList.toggle("light", theme === "light");

  /* ---- Karte ------------------------------------------------------ */
  const map = L.map("map", {
    center: [48.7784, 9.18], // Stuttgart Hauptbahnhof
    zoom: 13,
    zoomControl: false,
    preferCanvas: true,
  });
  L.control.zoom({ position: "bottomright" }).addTo(map);

  const tileOpts = {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 19,
  };
  const baseLayers = {
    dark: L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      tileOpts
    ),
    light: L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      tileOpts
    ),
  };
  baseLayers[theme].addTo(map);

  // Stations-Kreise passen sich dem Theme an
  const stationCircleStyle = () =>
    theme === "light"
      ? { color: "#3a4149", fillColor: "#ffffff" }
      : { color: "#ffffff", fillColor: "#0d1117" };

  /* ---- Liniennetz zeichnen ---------------------------------------- */
  // Pro Linie den laengsten Shape je Richtung zeichnen (deckt Varianten
  // gut ab, ohne 266 Polylinien uebereinander zu legen).
  const shapesByRoute = new Map(); // routeIdx -> Set<shapeIdx>
  for (const trip of schedule.trips) {
    if (!shapesByRoute.has(trip.r)) shapesByRoute.set(trip.r, new Set());
    shapesByRoute.get(trip.r).add(trip.sh);
  }

  const lineLayers = new Map(); // routeIdx -> L.LayerGroup
  shapesByRoute.forEach((shapeIdxSet, routeIdx) => {
    const color = network.routes[routeIdx].color;
    const group = L.layerGroup();
    shapeIdxSet.forEach((si) => {
      L.polyline(network.shapes[si].pts, {
        color,
        weight: 2.5,
        opacity: 0.55,
        interactive: false,
      }).addTo(group);
    });
    group.addTo(map);
    lineLayers.set(routeIdx, group);
  });

  /* ---- Stationen & Favoriten --------------------------------------- */
  const FAV_KEY = "stadtbahn-favorites";
  const favNames = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || "[]"));

  // Welche Linien halten an welcher Station (fuer das Popup)?
  const stationRoutes = network.stations.map(() => new Set());
  for (const trip of schedule.trips) {
    for (const s of trip.st) stationRoutes[s[0]].add(trip.r);
  }

  const stationLayer = L.layerGroup().addTo(map); // normale Halte (zoomabhaengig)
  const favLayer = L.layerGroup().addTo(map);     // Favoriten (immer sichtbar)
  const stationMarkers = new Array(network.stations.length).fill(null);

  function stationPopup(i) {
    const name = network.stations[i][0];
    const el = document.createElement("div");
    const lines = [...stationRoutes[i]]
      .sort((a, b) => a - b)
      .map((r) => {
        const route = network.routes[r];
        return (
          '<span class="sp-line" style="background:' + route.color +
          ";color:" + route.textColor + '">' + route.name + "</span>"
        );
      })
      .join("");
    el.innerHTML =
      '<div class="sp-name">' + name + "</div>" +
      '<div class="sp-lines">' + lines + "</div>";
    const btn = document.createElement("button");
    btn.className = "sp-fav-btn";
    btn.textContent = favNames.has(name)
      ? "★ Favorit entfernen"
      : "☆ Als Favorit merken";
    btn.addEventListener("click", () => {
      toggleFavorite(i);
      map.closePopup();
    });
    el.appendChild(btn);
    return el;
  }

  function makeStationMarker(i) {
    const [name, lat, lon] = network.stations[i];
    let marker;
    if (favNames.has(name)) {
      const icon = L.divIcon({
        className: "fav-icon",
        html: "★",
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      marker = L.marker([lat, lon], { icon, zIndexOffset: 400, keyboard: false });
      marker.addTo(favLayer);
    } else {
      marker = L.circleMarker([lat, lon], {
        radius: 3.5,
        weight: 1.2,
        fillOpacity: 1,
        opacity: 0.85,
        ...stationCircleStyle(),
      }).addTo(stationLayer);
    }
    marker
      .bindTooltip(name, { className: "station-tip", direction: "top", offset: [0, -8] })
      .bindPopup(() => stationPopup(i), {
        closeButton: false,
        autoPanPaddingTopLeft: L.point(24, 110),
        autoPanPaddingBottomRight: L.point(24, 40),
      });
    stationMarkers[i] = marker;
  }

  function toggleFavorite(i) {
    const name = network.stations[i][0];
    if (favNames.has(name)) favNames.delete(name);
    else favNames.add(name);
    localStorage.setItem(FAV_KEY, JSON.stringify([...favNames]));
    const old = stationMarkers[i];
    stationLayer.removeLayer(old);
    favLayer.removeLayer(old);
    makeStationMarker(i);
    renderFavList();
    renderDepartures();
  }

  function renderFavList() {
    const listEl = document.getElementById("fav-list");
    listEl.innerHTML = "";
    const favs = [];
    network.stations.forEach((s, i) => {
      if (favNames.has(s[0])) favs.push(i);
    });
    if (!favs.length) {
      listEl.innerHTML =
        '<p class="hint">Noch keine Favoriten &mdash; einfach eine Haltestelle auf der Karte anklicken.</p>';
      return;
    }
    favs.sort((a, b) =>
      network.stations[a][0].localeCompare(network.stations[b][0], "de")
    );
    for (const i of favs) {
      const [name, lat, lon] = network.stations[i];
      const item = document.createElement("div");
      item.className = "fav-item";
      item.innerHTML =
        '<span class="fav-star">★</span><span class="fav-name">' +
        name + "</span>";
      const rm = document.createElement("button");
      rm.className = "fav-remove";
      rm.textContent = "×";
      rm.title = "Favorit entfernen";
      rm.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite(i);
      });
      item.appendChild(rm);
      item.addEventListener("click", () =>
        map.flyTo([lat, lon], Math.max(map.getZoom(), 15))
      );
      listEl.appendChild(item);
    }
  }

  /* ---- Abfahrtstafel (fuer Favoriten) ------------------------------- */
  function renderDepartures() {
    const section = document.getElementById("departures-section");
    const board = document.getElementById("dep-board");
    const favs = [...favNames].sort((a, b) => a.localeCompare(b, "de"));
    if (!favs.length) {
      section.hidden = true;
      return;
    }
    section.hidden = false;

    const now = appTime();
    const d = new Date(now);
    const secNow =
      (now - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      1000;
    const clock = (sec) => {
      const s = ((sec % 86400) + 86400) % 86400;
      return (
        String(Math.floor(s / 3600)).padStart(2, "0") +
        ":" +
        String(Math.floor((s % 3600) / 60)).padStart(2, "0")
      );
    };

    board.innerHTML = "";
    for (const name of favs) {
      // gleichnamige Teilstationen zusammenfassen
      const indices = [];
      network.stations.forEach((s, i) => {
        if (s[0] === name) indices.push(i);
      });
      const deps = simulator.getDepartures(indices, now, 4);

      const block = document.createElement("div");
      let html =
        '<div class="dep-station"><span class="fav-star">★</span>' +
        name +
        "</div>";
      if (!deps.length) {
        html +=
          '<div class="dep-empty">Keine Abfahrten in den n&auml;chsten 2&nbsp;Stunden.</div>';
      } else {
        for (const dep of deps) {
          const route = network.routes[dep.route];
          const diffMin = Math.floor((dep.sec - secNow) / 60);
          let timeStr;
          let cls = "dep-time";
          if (diffMin <= 0) {
            timeStr = "jetzt";
            cls += " now";
          } else if (diffMin < 60) {
            timeStr = diffMin + " min";
          } else {
            timeStr = clock(dep.sec);
          }
          html +=
            '<div class="dep-row"><span class="dep-line" style="background:' +
            route.color +
            ";color:" +
            route.textColor +
            '">' +
            route.name +
            '</span><span class="dep-dest">' +
            dep.headsign +
            '</span><span class="' +
            cls +
            '">' +
            timeStr +
            "</span></div>";
        }
      }
      block.innerHTML = html;
      board.appendChild(block);
    }
  }

  /* ---- Haltestellen-Suche ------------------------------------------ */
  // gleichnamige Teilstationen zu einem Sucheintrag zusammenfassen
  const stationGroups = (() => {
    const byName = new Map();
    network.stations.forEach(([name, lat, lon], i) => {
      let g = byName.get(name);
      if (!g) {
        g = { name, lat, lon, firstIdx: i, routes: new Set() };
        byName.set(name, g);
      }
      stationRoutes[i].forEach((r) => g.routes.add(r));
    });
    return [...byName.values()];
  })();

  const searchInput = document.getElementById("station-search");
  const searchResultsEl = document.getElementById("search-results");
  const favListEl = document.getElementById("fav-list");

  function renderSearch() {
    const q = searchInput.value.trim().toLowerCase();
    searchResultsEl.innerHTML = "";
    favListEl.style.display = q ? "none" : "";
    if (!q) return;

    const matches = stationGroups
      .filter((g) => g.name.toLowerCase().includes(q))
      .sort((a, b) => {
        const aw = a.name.toLowerCase().startsWith(q) ? 0 : 1;
        const bw = b.name.toLowerCase().startsWith(q) ? 0 : 1;
        return aw - bw || a.name.localeCompare(b.name, "de");
      })
      .slice(0, 8);

    if (!matches.length) {
      searchResultsEl.innerHTML =
        '<div class="search-empty">Keine Haltestelle gefunden.</div>';
      return;
    }

    for (const g of matches) {
      const item = document.createElement("div");
      item.className = "search-item";

      const star = document.createElement("button");
      const isFav = favNames.has(g.name);
      star.className = "search-star" + (isFav ? " active" : "");
      star.textContent = isFav ? "★" : "☆";
      star.title = isFav ? "Favorit entfernen" : "Als Favorit merken";
      star.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleFavorite(g.firstIdx);
        renderSearch(); // Sterne in der Trefferliste auffrischen
      });
      item.appendChild(star);

      const name = document.createElement("span");
      name.className = "search-name";
      name.textContent = g.name;
      item.appendChild(name);

      const lines = document.createElement("span");
      lines.className = "search-lines";
      const routeIdxs = [...g.routes].sort((a, b) => a - b);
      routeIdxs.slice(0, 3).forEach((r) => {
        const route = network.routes[r];
        const b = document.createElement("span");
        b.className = "search-line";
        b.style.background = route.color;
        b.style.color = route.textColor;
        b.textContent = route.name;
        lines.appendChild(b);
      });
      if (routeIdxs.length > 3) {
        const more = document.createElement("span");
        more.className = "search-more";
        more.textContent = "+" + (routeIdxs.length - 3);
        lines.appendChild(more);
      }
      item.appendChild(lines);

      item.addEventListener("click", () =>
        map.flyTo([g.lat, g.lon], Math.max(map.getZoom(), 15))
      );
      searchResultsEl.appendChild(item);
    }
  }

  searchInput.addEventListener("input", renderSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      renderSearch();
      searchInput.blur();
    }
  });

  network.stations.forEach((_, i) => makeStationMarker(i));
  renderFavList();

  const updateStationVisibility = () => {
    if (map.getZoom() >= 13) {
      if (!map.hasLayer(stationLayer)) map.addLayer(stationLayer);
    } else if (map.hasLayer(stationLayer)) {
      map.removeLayer(stationLayer);
    }
  };
  map.on("zoomend", updateStationVisibility);
  updateStationVisibility();

  /* ---- Theme-Umschalter ------------------------------------------- */
  const themeBtn = document.getElementById("btn-theme");

  function refreshThemeBtn() {
    themeBtn.innerHTML = theme === "light" ? "&#9790;" : "&#9728;";
    themeBtn.title = theme === "light" ? "Dunkler Modus" : "Heller Modus";
  }

  function setTheme(mode) {
    theme = mode;
    localStorage.setItem(THEME_KEY, mode);
    document.body.classList.toggle("light", mode === "light");
    map.removeLayer(baseLayers[mode === "light" ? "dark" : "light"]);
    baseLayers[mode].addTo(map);
    const style = stationCircleStyle();
    stationMarkers.forEach((m) => {
      if (m instanceof L.CircleMarker) m.setStyle(style);
    });
    refreshThemeBtn();
  }

  themeBtn.addEventListener("click", () =>
    setTheme(theme === "light" ? "dark" : "light")
  );
  refreshThemeBtn();

  /* ---- UI: Linien-Filter ------------------------------------------ */
  const enabledRoutes = new Set(network.routes.map((_, i) => i));
  const chipsEl = document.getElementById("line-chips");
  network.routes.forEach((r, i) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.textContent = r.name;
    chip.title = r.longName;
    chip.style.setProperty("--chip-color", r.color);
    chip.style.setProperty("--chip-text", r.textColor);
    chip.addEventListener("click", () => {
      if (enabledRoutes.has(i)) {
        enabledRoutes.delete(i);
        chip.classList.add("off");
        map.removeLayer(lineLayers.get(i));
      } else {
        enabledRoutes.add(i);
        chip.classList.remove("off");
        map.addLayer(lineLayers.get(i));
      }
    });
    chipsEl.appendChild(chip);
  });
  document.getElementById("btn-all-lines").addEventListener("click", () => {
    const allOn = enabledRoutes.size === network.routes.length;
    network.routes.forEach((_, i) => {
      const chip = chipsEl.children[i];
      if (allOn) {
        enabledRoutes.delete(i);
        chip.classList.add("off");
        map.removeLayer(lineLayers.get(i));
      } else if (!enabledRoutes.has(i)) {
        enabledRoutes.add(i);
        chip.classList.remove("off");
        map.addLayer(lineLayers.get(i));
      }
    });
  });

  /* ---- UI: Zeitsteuerung ------------------------------------------ */
  let timeOffsetMs = 0;
  const clockEl = document.getElementById("clock");
  const clockLabel = document.getElementById("clock-label");
  const appTime = () => Date.now() + timeOffsetMs;

  document.querySelectorAll(".time-btn[data-shift]").forEach((btn) => {
    btn.addEventListener("click", () => {
      timeOffsetMs += Number(btn.dataset.shift) * 1000;
      refreshClockLabel();
      renderDepartures();
    });
  });
  document.getElementById("btn-now").addEventListener("click", () => {
    timeOffsetMs = 0;
    refreshClockLabel();
    renderDepartures();
  });
  function refreshClockLabel() {
    if (timeOffsetMs === 0) {
      clockLabel.textContent = "Uhrzeit";
      clockLabel.classList.remove("shifted");
    } else {
      const min = Math.round(timeOffsetMs / 60000);
      clockLabel.textContent = (min > 0 ? "+" : "") + min + " min";
      clockLabel.classList.add("shifted");
    }
  }

  /* ---- Fahrzeug-Marker --------------------------------------------- */
  const vehCountEl = document.getElementById("veh-count");
  const markers = new Map(); // vehicle.id -> {marker, arrowEl}
  const fmtTime = (sec) => {
    const s = ((sec % 86400) + 86400) % 86400;
    return (
      String(Math.floor(s / 3600)).padStart(2, "0") +
      ":" +
      String(Math.floor((s % 3600) / 60)).padStart(2, "0")
    );
  };

  // Stadtbahn von oben, Spitze zeigt nach Norden; wird per CSS in
  // Fahrtrichtung gedreht. Helle Frontscheibe markiert die Zugspitze.
  const TRAIN_SVG =
    '<svg viewBox="0 0 18 40" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M4 10 C4 5.2 6 3 9 3 C12 3 14 5.2 14 10 L14 33.5 ' +
    'C14 35.6 12.8 37 10.8 37 L7.2 37 C5.2 37 4 35.6 4 33.5 Z" ' +
    'fill="var(--c)" stroke="rgba(255,255,255,0.9)" stroke-width="1.4"/>' +
    '<path d="M5.7 6 C6.6 4.9 7.6 4.4 9 4.4 C10.4 4.4 11.4 4.9 12.3 6 ' +
    'L12.3 8.4 L5.7 8.4 Z" fill="rgba(255,255,255,0.85)"/>' +
    '<line x1="4.7" y1="21" x2="13.3" y2="21" stroke="rgba(0,0,0,0.35)" stroke-width="1"/>' +
    "</svg>";

  function makeMarker(v) {
    const route = network.routes[v.route];
    const el = document.createElement("div");
    el.className = "veh";
    el.style.setProperty("--c", route.color);
    el.style.setProperty("--tc", route.textColor);
    el.innerHTML =
      '<div class="veh-train">' + TRAIN_SVG + "</div>" +
      '<div class="veh-label">' + route.name + "</div>";
    const icon = L.divIcon({
      className: "veh-icon",
      html: el,
      iconSize: [40, 40],
      iconAnchor: [20, 20],
      popupAnchor: [0, -18],
    });
    const marker = L.marker([v.lat, v.lon], {
      icon,
      keyboard: false,
      zIndexOffset: 500,
    });
    marker.bindPopup(() => popupHtml(marker._veh), {
      closeButton: false,
      autoPanPaddingTopLeft: L.point(24, 110),
      autoPanPaddingBottomRight: L.point(24, 40),
    });
    marker.addTo(map);
    return { marker, trainEl: el.querySelector(".veh-train") };
  }

  function popupHtml(v) {
    const route = network.routes[v.route];
    return (
      '<span class="pp-line" style="background:' +
      route.color +
      ";color:" +
      route.textColor +
      '">' +
      route.name +
      "</span>" +
      '<span class="pp-dest">' +
      v.headsign +
      "</span>" +
      '<div class="pp-row">N&auml;chster Halt: <b>' +
      v.nextStop +
      "</b> &middot; " +
      fmtTime(v.nextStopTime) +
      " Uhr</div>" +
      '<div class="pp-src">' +
      (v.realtime ? "Echtzeitdaten" : "Fahrplan-Simulation &mdash; Echtzeit-API folgt") +
      "</div>"
    );
  }

  /* ---- Datenquelle: Simulation <-> Live (API) ----------------------- */
  let sourceMode = "sim";
  const badgeEl = document.getElementById("source-badge");
  const sourceHintEl = document.getElementById("source-hint");

  function refreshSourceInfo() {
    if (sourceMode === "live") {
      if (realtime.available()) {
        badgeEl.textContent = "Live";
        badgeEl.className = "badge badge-live";
        badgeEl.title = "Echtzeitpositionen aus der VVS-API.";
        sourceHintEl.textContent = "Echtzeitpositionen aus der VVS-API.";
      } else {
        badgeEl.textContent = "Live — offline";
        badgeEl.className = "badge badge-offline";
        badgeEl.title = "Die Echtzeit-API ist noch nicht verbunden.";
        sourceHintEl.textContent =
          "Echtzeit-API noch nicht verbunden — sobald der VVS-Zugang freigeschaltet ist, erscheinen hier die echten Positionen.";
      }
    } else {
      badgeEl.textContent = "Fahrplan-Simulation";
      badgeEl.className = "badge badge-sim";
      badgeEl.title =
        "Positionen werden aus dem GTFS-Fahrplan berechnet. Sobald die Echtzeit-API freigeschaltet ist, liefert der Live-Modus echte Daten.";
      sourceHintEl.textContent =
        "Positionen werden aus dem GTFS-Fahrplan berechnet.";
    }
  }

  document.querySelectorAll("#source-toggle .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      sourceMode = btn.dataset.mode;
      document
        .querySelectorAll("#source-toggle .seg-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      refreshSourceInfo();
      tick();
    });
  });
  refreshSourceInfo();

  /* ---- Animationsschleife ------------------------------------------ */
  function tick() {
    const now = appTime();

    const source = sourceMode === "live" ? realtime : simulator;
    const vehicles = source.getVehicles(now).filter((v) => enabledRoutes.has(v.route));

    const seen = new Set();
    for (const v of vehicles) {
      seen.add(v.id);
      let entry = markers.get(v.id);
      if (!entry) {
        entry = makeMarker(v);
        markers.set(v.id, entry);
      }
      entry.marker._veh = v;
      entry.marker.setLatLng([v.lat, v.lon]);
      entry.trainEl.style.transform = "rotate(" + v.bearing.toFixed(1) + "deg)";
      if (entry.marker.isPopupOpen()) {
        // Popup nur bei inhaltlicher Aenderung neu rendern (10-Hz-Takt)
        const html = popupHtml(v);
        if (html !== entry.lastPopup) {
          entry.lastPopup = html;
          entry.marker.setPopupContent(html);
        }
      }
    }
    // verschwundene Fahrzeuge entfernen
    markers.forEach((entry, id) => {
      if (!seen.has(id)) {
        map.removeLayer(entry.marker);
        markers.delete(id);
      }
    });

    vehCountEl.textContent = String(vehicles.length);
    clockEl.textContent = new Date(now).toLocaleTimeString("de-DE");
  }

  // 10 Hz fuer fluessige, konstante Bewegung entlang der Strecke
  setInterval(tick, 100);
  tick();

  // Abfahrtstafel: initial + alle 10 s auffrischen (Countdown)
  renderDepartures();
  setInterval(renderDepartures, 10000);

  // Fuer Debugging und die spaetere API-Anbindung
  window.stadtbahn = { simulator, realtime };

  document.getElementById("loading").classList.add("hidden");
})().catch((err) => {
  console.error(err);
  const loading = document.getElementById("loading");
  if (loading) {
    loading.innerHTML =
      "<p style='color:#f85149'>Fehler beim Laden: " + err.message + "</p>";
  }
});
