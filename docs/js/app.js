/**
 * Stuttgart Stadtbahn Live — Kartenoberflaeche.
 * Zeichnet Liniennetz + Stationen und animiert die Fahrzeuge, die von der
 * aktiven Datenquelle (Simulation oder spaeter Echtzeit) geliefert werden.
 */

"use strict";

(async function main() {
  /* ---- Daten laden ------------------------------------------------ */
  const [network, scheduleRaw] = await Promise.all([
    fetch("data/network.json").then((r) => r.json()),
    fetch("data/schedule.json").then((r) => r.json()),
  ]);
  const schedule = ScheduleSimulator.decodeSchedule(scheduleRaw);

  const simulator = new ScheduleSimulator(network, schedule);
  const realtime = new EfaRealtime(network, simulator);

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

  // Linienname -> Linie (fuer Live-Abfahrten, deren Zeilen nur den Namen tragen)
  const routesByName = new Map(network.routes.map((r) => [r.name, r]));
  let openStationIdx = null; // Station mit offenem Popup (fuer Live-Abfragen)

  /** Einheitliche Abfahrts-Zeile fuer Tafel und Stations-Popup.
   *  row: {sec, linie, ziel, trip|null, delayMin|null} */
  function depRowHtml(row, secNow) {
    const route = routesByName.get(row.linie);
    const color = route ? route.color : "#888888";
    const textColor = route ? route.textColor : "#ffffff";
    const diffMin = Math.floor((row.sec - secNow) / 60);
    let timeStr;
    let cls = "dep-time";
    if (diffMin <= 0) {
      timeStr = "jetzt";
      cls += " now";
    } else if (diffMin < 60) {
      timeStr = diffMin + " min";
    } else {
      const s = ((row.sec % 86400) + 86400) % 86400;
      timeStr =
        String(Math.floor(s / 3600)).padStart(2, "0") +
        ":" +
        String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    }
    const delay =
      row.delayMin != null && row.delayMin > 0
        ? '<span class="dep-delay">+' + row.delayMin + "</span>"
        : "";
    return (
      '<div class="dep-row"' +
      (row.trip
        ? ' data-trip="' + row.trip.id + '" title="Bahn auf der Karte zeigen"'
        : "") +
      '><span class="dep-line" style="background:' +
      color +
      ";color:" +
      textColor +
      '">' +
      row.linie +
      '</span><span class="dep-dest">' +
      row.ziel +
      "</span>" +
      delay +
      '<span class="' +
      cls +
      '">' +
      timeStr +
      "</span></div>"
    );
  }

  /** Abfahrten fuer Stations-Indizes: live (falls Modus + Daten), sonst Fahrplan. */
  function departureRows(indices, now, limit) {
    if (sourceMode === "live") {
      const live = realtime.getLiveDepartures(indices, now, limit);
      if (live) return live;
      indices.forEach((ix) => realtime.refreshStation(ix, now));
    }
    return simulator.getDepartures(indices, now, limit).map((dep) => ({
      sec: dep.sec,
      linie: network.routes[dep.trip.r].name,
      ziel: dep.trip.hs,
      trip: dep.trip,
      delayMin: null,
    }));
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

    // naechste Abfahrten (gleichnamige Teilstationen zusammen)
    const indices = [];
    network.stations.forEach((s, k) => {
      if (s[0] === name) indices.push(k);
    });
    const now = appTime();
    const d = new Date(now);
    const secNow =
      (now - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      1000;
    const depHtml = departureRows(indices, now, 3)
      .map((row) => depRowHtml(row, secNow))
      .join("");

    // Im Live-Modus: sobald die EFA-Daten da sind, Zeilen ersetzen
    if (sourceMode === "live") {
      Promise.all(indices.map((ix) => realtime.refreshStation(ix, now))).then(
        () => {
          const live = realtime.getLiveDepartures(indices, appTime(), 3);
          const depsEl = el.querySelector(".sp-deps");
          if (live && live.length && depsEl) {
            depsEl.innerHTML = live
              .map((row) => depRowHtml(row, secNow))
              .join("");
          }
        }
      );
    }

    el.innerHTML =
      '<div class="sp-name">' + name + "</div>" +
      '<div class="sp-lines">' + lines + "</div>" +
      (depHtml ? '<div class="sp-deps">' + depHtml + "</div>" : "");
    el.addEventListener("click", (e) => {
      const row = e.target.closest(".dep-row[data-trip]");
      if (row) {
        map.closePopup();
        followTrip(row.dataset.trip);
      }
    });
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
    // offene Station merken (wird im Live-Modus mitabgefragt)
    marker.on("popupopen", () => {
      openStationIdx = i;
    });
    marker.on("popupclose", () => {
      if (openStationIdx === i) openStationIdx = null;
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

    board.innerHTML = "";
    for (const name of favs) {
      // gleichnamige Teilstationen zusammenfassen
      const indices = [];
      network.stations.forEach((s, i) => {
        if (s[0] === name) indices.push(i);
      });
      const rows = departureRows(indices, now, 4);

      const block = document.createElement("div");
      let html =
        '<div class="dep-station"><span class="fav-star">★</span>' +
        name +
        "</div>";
      if (!rows.length) {
        html +=
          '<div class="dep-empty">Keine Abfahrten in den n&auml;chsten 2&nbsp;Stunden.</div>';
      } else {
        html += rows.map((row) => depRowHtml(row, secNow)).join("");
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

  // Klick auf eine Abfahrt: zugehoerige Bahn auf der Karte verfolgen
  document.getElementById("dep-board").addEventListener("click", (e) => {
    const row = e.target.closest(".dep-row[data-trip]");
    if (row) followTrip(row.dataset.trip);
  });

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

  /* ---- Bedienfeld ein-/ausklappen ----------------------------------- */
  const PANEL_KEY = "stadtbahn-panel";
  const panelBtn = document.getElementById("btn-panel");

  function setPanelCollapsed(collapsed, save = true) {
    document.body.classList.toggle("panel-collapsed", collapsed);
    panelBtn.classList.toggle("panel-hidden", collapsed);
    panelBtn.title = collapsed ? "Bedienfeld einblenden" : "Bedienfeld ausblenden";
    if (save) localStorage.setItem(PANEL_KEY, collapsed ? "zu" : "auf");
  }

  panelBtn.addEventListener("click", () =>
    setPanelCollapsed(!document.body.classList.contains("panel-collapsed"))
  );
  setPanelCollapsed(localStorage.getItem(PANEL_KEY) === "zu", false);

  /* ---- UI: Linien-Filter ------------------------------------------ */
  const enabledRoutes = new Set(network.routes.map((_, i) => i));
  const chipsEl = document.getElementById("line-chips");

  function setRouteEnabled(i, on) {
    const chip = chipsEl.children[i];
    if (on && !enabledRoutes.has(i)) {
      enabledRoutes.add(i);
      chip.classList.remove("off");
      map.addLayer(lineLayers.get(i));
    } else if (!on && enabledRoutes.has(i)) {
      enabledRoutes.delete(i);
      chip.classList.add("off");
      map.removeLayer(lineLayers.get(i));
    }
  }

  network.routes.forEach((r, i) => {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.textContent = r.name;
    chip.title = r.longName + " — Doppelklick: nur diese Linie";
    chip.style.setProperty("--chip-color", r.color);
    chip.style.setProperty("--chip-text", r.textColor);
    chip.addEventListener("click", () => setRouteEnabled(i, !enabledRoutes.has(i)));
    // Doppelklick isoliert die Linie; erneuter Doppelklick zeigt wieder alle
    chip.addEventListener("dblclick", () => {
      const isolated = enabledRoutes.size === 1 && enabledRoutes.has(i);
      network.routes.forEach((_, k) => setRouteEnabled(k, isolated || k === i));
    });
    chipsEl.appendChild(chip);
  });
  document.getElementById("btn-all-lines").addEventListener("click", () => {
    const allOn = enabledRoutes.size === network.routes.length;
    network.routes.forEach((_, i) => setRouteEnabled(i, !allOn));
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
    return { marker, trainEl: el.querySelector(".veh-train"), el };
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
      " Uhr" +
      (v.delaySec >= 60
        ? ' <span class="dep-delay">+' + Math.round(v.delaySec / 60) + "</span>"
        : "") +
      "</div>" +
      '<button class="pp-follow" data-trip="' +
      v.id +
      '">' +
      (followId === v.id ? "Nicht mehr folgen" : "Dieser Bahn folgen") +
      "</button>" +
      '<div class="pp-src">' +
      (v.realtime
        ? "Echtzeitdaten (VVS)"
        : "Fahrplan" + (sourceMode === "live" ? " &mdash; keine Echtzeit fuer diese Fahrt" : "-Simulation")) +
      "</div>"
    );
  }

  /* ---- Bahn verfolgen ----------------------------------------------- */
  let followId = null;
  const followChip = document.getElementById("follow-chip");
  const followLabel = document.getElementById("follow-label");

  function followTrip(tripId) {
    const source = sourceMode === "live" ? realtime : simulator;
    const v = source.getVehicles(appTime()).find((x) => x.id === tripId);
    if (!v) {
      toast("Diese Bahn ist noch nicht unterwegs — sie erscheint zur Abfahrt.");
      return;
    }
    followId = tripId;
    const route = network.routes[v.route];
    followLabel.textContent = route.name + " → " + v.headsign;
    followChip.hidden = false;
    map.setView([v.lat, v.lon], Math.max(map.getZoom(), 15));
    tick();
  }

  function stopFollow() {
    if (!followId) return;
    followId = null;
    followChip.hidden = true;
    const el = document.querySelector(".veh.followed");
    if (el) el.classList.remove("followed");
  }

  map.on("dragstart", stopFollow);
  document.getElementById("follow-stop").addEventListener("click", stopFollow);
  // "Folgen"-Button im Fahrzeug-Popup (Inhalt wird dynamisch ersetzt)
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".pp-follow");
    if (!btn) return;
    if (followId === btn.dataset.trip) stopFollow();
    else followTrip(btn.dataset.trip);
  });

  /* ---- Hinweis-Toast ------------------------------------------------ */
  function toast(msg) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add("show"));
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 400);
    }, 3000);
  }

  /* ---- Mein Standort ------------------------------------------------ */
  let userMarker = null;
  let userCircle = null;
  let geoWatchId = null;
  const locateControl = L.control({ position: "bottomright" });
  locateControl.onAdd = () => {
    const div = L.DomUtil.create("div", "leaflet-bar");
    div.innerHTML =
      '<a href="#" id="btn-locate" title="Mein Standort &amp; n&auml;chste Haltestelle">&#9678;</a>';
    L.DomEvent.on(div, "click", (e) => {
      L.DomEvent.stop(e);
      locateMe();
    });
    return div;
  };
  locateControl.addTo(map);

  function showUserPosition(lat, lon, accuracy) {
    if (!userMarker) {
      userMarker = L.marker([lat, lon], {
        icon: L.divIcon({ className: "user-dot", iconSize: [18, 18], iconAnchor: [9, 9] }),
        interactive: false,
        zIndexOffset: 700,
      }).addTo(map);
      userCircle = L.circle([lat, lon], {
        radius: accuracy || 0,
        color: "#1a73e8",
        weight: 1,
        opacity: 0.4,
        fillColor: "#1a73e8",
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(map);
    } else {
      userMarker.setLatLng([lat, lon]);
      userCircle.setLatLng([lat, lon]).setRadius(accuracy || 0);
    }
  }

  function locateMe() {
    if (!navigator.geolocation) {
      toast("Standortabfrage wird von diesem Browser nicht unterstützt.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude;
        const lon = pos.coords.longitude;
        showUserPosition(lat, lon, pos.coords.accuracy);
        // Position ab jetzt laufend nachfuehren
        if (geoWatchId === null && navigator.geolocation.watchPosition) {
          geoWatchId = navigator.geolocation.watchPosition(
            (p) =>
              showUserPosition(
                p.coords.latitude,
                p.coords.longitude,
                p.coords.accuracy
              ),
            () => {},
            { enableHighAccuracy: true }
          );
        }
        // naechstgelegene Haltestelle suchen und ihr Popup (mit Abfahrten) oeffnen
        let best = -1;
        let bestDist = Infinity;
        network.stations.forEach(([, slat, slon], i) => {
          const d2 = Math.hypot(slat - lat, (slon - lon) * 0.66);
          if (d2 < bestDist) {
            bestDist = d2;
            best = i;
          }
        });
        map.flyTo([lat, lon], Math.max(map.getZoom(), 15));
        if (best >= 0) {
          const meters = Math.round(bestDist * 111000);
          toast(
            "Nächste Haltestelle: " + network.stations[best][0] + " (~" + meters + " m)"
          );
          map.once("moveend", () => stationMarkers[best].openPopup());
        }
      },
      (err) => {
        toast(
          err.code === 1
            ? "Standortfreigabe wurde abgelehnt — bitte in den Browser-Einstellungen erlauben."
            : "Standort nicht verfügbar."
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  }

  /* ---- Datenquelle: Simulation <-> Live (API) ----------------------- */
  let sourceMode = "sim";
  const badgeEl = document.getElementById("source-badge");
  const sourceHintEl = document.getElementById("source-hint");

  function refreshSourceInfo() {
    if (sourceMode === "live") {
      const broken =
        realtime.lastError &&
        Date.now() - realtime.lastSuccess > 3 * 60 * 1000;
      if (broken) {
        badgeEl.textContent = "Live — Störung";
        badgeEl.className = "badge badge-offline";
        badgeEl.title = "Die VVS-Echtzeitschnittstelle antwortet gerade nicht.";
        sourceHintEl.textContent =
          "Echtzeitdaten derzeit nicht erreichbar — Anzeige nach Fahrplan.";
      } else {
        badgeEl.textContent = "Live";
        badgeEl.className = "badge badge-live";
        badgeEl.title =
          "Echtzeit-Abfahrten und Verspätungen über die VVS-Schnittstelle.";
        sourceHintEl.textContent =
          "Echtzeit (VVS) für Favoriten und geöffnete Stationen — Verspätungen verschieben die Bahnen auf der Karte. Übrige Fahrten nach Fahrplan.";
      }
    } else {
      badgeEl.textContent = "Fahrplan-Simulation";
      badgeEl.className = "badge badge-sim";
      badgeEl.title =
        "Positionen werden aus dem GTFS-Fahrplan berechnet — ohne Echtzeit-Verspätungen.";
      sourceHintEl.textContent =
        "Positionen werden aus dem GTFS-Fahrplan berechnet.";
    }
  }

  /* Live-Modus: Favoriten + geoeffnete Station regelmaessig abfragen */
  function watchedStationIndices() {
    const set = new Set();
    network.stations.forEach((s, i) => {
      if (favNames.has(s[0])) set.add(i);
    });
    if (openStationIdx !== null) {
      const name = network.stations[openStationIdx][0];
      network.stations.forEach((s, i) => {
        if (s[0] === name) set.add(i);
      });
    }
    return [...set];
  }

  function liveRefresh() {
    if (sourceMode !== "live") return;
    watchedStationIndices().forEach((i) => realtime.refreshStation(i, appTime()));
  }
  setInterval(liveRefresh, 60000);

  realtime.onUpdate = () => {
    renderDepartures();
    refreshSourceInfo();
  };

  document.querySelectorAll("#source-toggle .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      sourceMode = btn.dataset.mode;
      document
        .querySelectorAll("#source-toggle .seg-btn")
        .forEach((b) => b.classList.toggle("active", b === btn));
      refreshSourceInfo();
      renderDepartures();
      if (sourceMode === "live") liveRefresh();
      tick();
    });
  });
  refreshSourceInfo();

  /* ---- Animationsschleife ------------------------------------------ */
  // Tab im Hintergrund: nicht stoppen, sondern auf 1 Tick / 5 s drosseln.
  // (Manche eingebettete Webviews melden dauerhaft "hidden" — ein hartes
  // Stoppen wuerde die App dort komplett einfrieren.)
  let lastHiddenTick = 0;
  function tick() {
    if (document.hidden) {
      const nowMs = Date.now();
      if (nowMs - lastHiddenTick < 5000) return;
      lastHiddenTick = nowMs;
    }
    const now = appTime();

    const source = sourceMode === "live" ? realtime : simulator;
    const vehicles = source.getVehicles(now).filter((v) => enabledRoutes.has(v.route));

    // nur Bahnen im (grosszuegig erweiterten) Kartenausschnitt rendern;
    // verfolgte Bahnen und offene Popups bleiben immer erhalten.
    // Bei 0-Groesse (Karte noch nicht ausgelegt, z. B. verstecktes
    // iframe) ist die Bounds-Pruefung wertlos — dann alle rendern.
    const mapSize = map.getSize();
    const bounds =
      mapSize.x > 0 && mapSize.y > 0 ? map.getBounds().pad(0.2) : null;
    const seen = new Set();
    for (const v of vehicles) {
      const existing = markers.get(v.id);
      const visible =
        !bounds ||
        v.id === followId ||
        bounds.contains([v.lat, v.lon]) ||
        (existing && existing.marker.isPopupOpen());
      if (!visible) continue;
      seen.add(v.id);
      let entry = existing;
      if (!entry) {
        entry = makeMarker(v);
        markers.set(v.id, entry);
      }
      entry.marker._veh = v;
      entry.marker.setLatLng([v.lat, v.lon]);
      entry.trainEl.style.transform = "rotate(" + v.bearing.toFixed(1) + "deg)";
      entry.el.classList.toggle("followed", v.id === followId);
      if (entry.marker.isPopupOpen()) {
        // Popup nur bei inhaltlicher Aenderung neu rendern (10-Hz-Takt)
        const html = popupHtml(v);
        if (html !== entry.lastPopup) {
          entry.lastPopup = html;
          entry.marker.setPopupContent(html);
        }
      }
    }
    // verschwundene / ausgeblendete Fahrzeuge entfernen
    markers.forEach((entry, id) => {
      if (!seen.has(id)) {
        map.removeLayer(entry.marker);
        markers.delete(id);
      }
    });

    // Folgen-Modus: Karte auf der Bahn halten
    if (followId) {
      const f = markers.get(followId);
      if (f) map.setView(f.marker.getLatLng(), map.getZoom(), { animate: false });
      else stopFollow(); // Fahrt beendet
    }

    vehCountEl.textContent = String(vehicles.length);
    clockEl.textContent = new Date(now).toLocaleTimeString("de-DE");
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      map.invalidateSize({ pan: false });
      tick();
      renderDepartures();
    }
  });
  // Eingebettete Ansichten (z. B. Dashboard-iframes) melden Groessen-
  // aenderungen nicht immer zuverlaessig — regelmaessig nachpruefen
  // (no-op, solange sich die Groesse nicht geaendert hat).
  setInterval(() => map.invalidateSize({ pan: false }), 10000);

  // 10 Hz fuer fluessige, konstante Bewegung entlang der Strecke
  setInterval(tick, 100);
  tick();

  // Abfahrtstafel: initial + alle 10 s auffrischen (Countdown)
  renderDepartures();
  setInterval(renderDepartures, 10000);

  // Fuer Debugging und die spaetere API-Anbindung
  window.stadtbahn = { simulator, realtime, map, stationMarkers };

  // PWA: Service Worker fuer Offline-Cache und schnelle Wiederbesuche.
  // Uebernimmt eine neue Version die Kontrolle, wird einmal neu geladen,
  // damit Updates sofort sichtbar sind (nicht erst beim uebernaechsten Besuch).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (hadController && !reloaded) {
        reloaded = true;
        location.reload();
      }
    });
  }

  document.getElementById("loading").classList.add("hidden");
})().catch((err) => {
  console.error(err);
  const loading = document.getElementById("loading");
  if (loading) {
    loading.innerHTML =
      "<p style='color:#f85149'>Fehler beim Laden: " + err.message + "</p>";
  }
});
