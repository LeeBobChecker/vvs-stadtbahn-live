/**
 * Datenquellen fuer Fahrzeugpositionen.
 *
 * Beide Quellen liefern ueber getVehicles(timeMs) ein einheitliches Format:
 *   {
 *     id:       string,   // Fahrt-ID (GTFS trip_id)
 *     route:    number,   // Index in network.routes
 *     lat, lon: number,
 *     bearing:  number,   // Fahrtrichtung in Grad (0 = Nord)
 *     headsign: string,   // Fahrtziel
 *     nextStop: string,   // Name der naechsten Station
 *     nextStopTime: number, // Ankunft dort (Sekunden ab Betriebstag-Mitternacht)
 *     progress: number,   // 0..1 entlang der Fahrt
 *     realtime: boolean
 *   }
 *
 * ScheduleSimulator : interpoliert Positionen aus dem GTFS-Fahrplan (aktiv).
 * RealtimeSource    : Adapter fuer die VVS-Echtzeit-API (Stub, bis der
 *                     API-Zugang freigeschaltet ist).
 */

"use strict";

/* ================================================================== */
/*  Fahrplan-Simulation                                               */
/* ================================================================== */

class ScheduleSimulator {
  /**
   * Expandiert das kompakte schedule.json (v2: Patterns + Startzeiten)
   * in das Laufzeitformat mit absoluten Zeiten je Fahrt.
   */
  static decodeSchedule(raw) {
    if (!raw.version) return raw; // altes, unkomprimiertes Format
    const trips = raw.trips.map((t, i) => {
      const p = raw.patterns[t[0]];
      const start = t[1];
      return {
        id: raw.ids[i],
        r: p.r,
        sh: p.sh,
        sv: t[2],
        hs: raw.headsigns[p.hs],
        d: p.d,
        st: p.st.map((s) => [s[0], start + s[1], start + s[2], s[3]]),
      };
    });
    return { services: raw.services, trips };
  }

  /**
   * Ziel-Standzeit an jeder Station in Sekunden. Die VVS-Zeiten sind
   * minutengenau; oft ist Ankunft == Abfahrt und bei kurzen Stations-
   * abstaenden sogar Abfahrt A == Ankunft B (0 s Fahrzeit). Deshalb wird
   * je Fahrt eine stetige Zeit/Distanz-Kurve gebaut: Standfenster werden
   * um die Planzeit zentriert und auf max. 30 % des Abstands zum
   * Nachbarhalt gekappt — so bleibt immer Fahrzeit uebrig und die Bahn
   * bewegt sich konstant ohne Spruenge.
   */
  static DWELL = 20;

  /**
   * @param {Object} network  Inhalt von data/network.json
   * @param {Object} schedule Inhalt von data/schedule.json
   */
  constructor(network, schedule) {
    this.network = network;
    this.services = schedule.services;
    this.trips = schedule.trips;
    this._activeCache = { key: null, trips: [] };
    this._serviceCache = new Map(); // "YYYYMMDD" -> Set<serviceIdx>
    this._depCache = new Map(); // "YYYYMMDD:stationIdx" -> [[depSec, route, headsign]]
  }

  /* ---- Verkehrstage ---------------------------------------------- */

  static _dateKey(d) {
    return (
      d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
    ).toString();
  }

  /** Menge der Service-Indizes, die am Kalendertag `date` verkehren. */
  _activeServices(date) {
    const key = ScheduleSimulator._dateKey(date);
    if (this._serviceCache.has(key)) return this._serviceCache.get(key);

    const weekday = (date.getDay() + 6) % 7; // 0 = Montag
    const active = new Set();
    this.services.forEach((sv, idx) => {
      let on =
        sv.days[weekday] === 1 && key >= sv.start && key <= sv.end;
      if (sv.add.includes(key)) on = true;
      if (sv.del.includes(key)) on = false;
      if (on) active.add(idx);
    });
    this._serviceCache.set(key, active);
    return active;
  }

  /* ---- aktive Fahrten -------------------------------------------- */

  /**
   * Fahrten, die zum Zeitpunkt `timeMs` (etwa) unterwegs sind, mit dem
   * Sekunden-Offset ihres Betriebstags (GTFS-Zeiten laufen > 24 h, daher
   * werden heutiger und gestriger Betriebstag geprueft).
   *
   * Wichtig: gecacht wird nur die Kandidatenliste (10-s-Raster, mit
   * Randpuffer) — die konkrete Sekunde rechnet getVehicles() bei jedem
   * Aufruf frisch, damit sich die Bahnen kontinuierlich bewegen.
   */
  _activeTrips(timeMs) {
    const cacheKey = Math.floor(timeMs / 10000);
    if (this._activeCache.key === cacheKey) return this._activeCache.trips;

    const now = new Date(timeMs);
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const secToday = (timeMs - midnight.getTime()) / 1000;
    const yesterday = new Date(midnight.getTime() - 86400000);

    const days = [
      { services: this._activeServices(midnight), off: 0 },
      { services: this._activeServices(yesterday), off: 86400 },
    ];

    const result = [];
    for (const trip of this.trips) {
      const first = trip.st[0];
      const last = trip.st[trip.st.length - 1];
      for (const day of days) {
        if (!day.services.has(trip.sv)) continue;
        const sec = secToday + day.off;
        // grosszuegiger Nachlauf: verspaetete Fahrten laufen nach dem
        // planmaessigen Ende weiter (exakte Pruefung in getVehicles)
        if (sec >= first[2] - 15 && sec <= last[1] + 1215) {
          result.push({ trip, off: day.off });
        }
      }
    }
    this._activeCache = { key: cacheKey, trips: result };
    return result;
  }

  /* ---- Zeit/Distanz-Kurve je Fahrt --------------------------------- */

  /**
   * Baut (einmalig, gecacht) eine monotone Folge von Knoten
   * (Zeit, Distanz): je Halt ein Stand-Fenster [Start, Ende] mit
   * konstanter Distanz, dazwischen lineare Fahrt. Die Fenster sind um
   * die Fahrplanzeit zentriert und pro Seite auf 30 % des Abstands zum
   * Nachbarhalt begrenzt — dadurch existiert auch bei 0-Sekunden-
   * Segmenten des Fahrplans immer ein Fahrfenster.
   */
  _timeline(trip) {
    if (trip._tl) return trip._tl;
    const half = ScheduleSimulator.DWELL / 2;
    const st = trip.st;
    const n = st.length;
    const center = st.map((s) => (s[1] + s[2]) / 2);
    const times = new Float64Array(n * 2);
    const dists = new Float64Array(n * 2);
    for (let k = 0; k < n; k++) {
      const sched = (st[k][2] - st[k][1]) / 2; // halbe Plan-Standzeit
      const capPrev = k > 0 ? 0.3 * (center[k] - center[k - 1]) : Infinity;
      const capNext = k < n - 1 ? 0.3 * (center[k + 1] - center[k]) : Infinity;
      const hBefore = Math.min(sched + half, capPrev);
      const hAfter = Math.min(sched + half, capNext);
      times[k * 2] = center[k] - hBefore;
      times[k * 2 + 1] = center[k] + hAfter;
      dists[k * 2] = st[k][3];
      dists[k * 2 + 1] = st[k][3];
    }
    trip._tl = { t: times, d: dists };
    return trip._tl;
  }

  /* ---- Geometrie -------------------------------------------------- */

  /** Distanz (m) entlang des Shapes -> [lat, lon, bearing]. */
  _pointAt(shape, dist) {
    const d = shape.dist;
    let lo = 0;
    let hi = d.length - 1;
    if (dist <= d[0]) return this._segPoint(shape, 0, 0);
    if (dist >= d[hi]) return this._segPoint(shape, hi - 1, 1);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (d[mid] <= dist) lo = mid;
      else hi = mid;
    }
    const span = d[hi] - d[lo];
    const f = span > 0 ? (dist - d[lo]) / span : 0;
    return this._segPoint(shape, lo, f);
  }

  _segPoint(shape, i, f) {
    const [lat1, lon1] = shape.pts[i];
    const [lat2, lon2] = shape.pts[Math.min(i + 1, shape.pts.length - 1)];
    const lat = lat1 + (lat2 - lat1) * f;
    const lon = lon1 + (lon2 - lon1) * f;
    const dLon = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
    const bearing = (Math.atan2(dLon, lat2 - lat1) * 180) / Math.PI;
    return [lat, lon, (bearing + 360) % 360];
  }

  /* ---- Abfahrtstafel ----------------------------------------------- */

  /**
   * Naechste Abfahrten an einer Station.
   * `stationIdxList`: Stations-Indizes (gleichnamige Teilstationen werden
   * gemeinsam abgefragt). Liefert [{sec, trip}], `sec` relativ zur
   * Mitternacht des Kalendertags von `timeMs`; `trip` ist die zugehoerige
   * Fahrt (fuer Linie, Ziel und Karten-Verknuepfung). Endhalte einer
   * Fahrt zaehlen nicht als Abfahrt. Basis sind Fahrplanzeiten —
   * Verspaetungen kommen spaeter aus der Echtzeitquelle dazu.
   */
  getDepartures(stationIdxList, timeMs, limit = 4, horizonSec = 7200) {
    const d = new Date(timeMs);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const secBase = (timeMs - midnight.getTime()) / 1000;
    const days = [
      { date: midnight, off: 0 },
      { date: new Date(midnight.getTime() - 86400000), off: 86400 },
    ];

    const out = [];
    for (const day of days) {
      const dateKey = ScheduleSimulator._dateKey(day.date);
      const services = this._activeServices(day.date);
      for (const idx of stationIdxList) {
        const cacheKey = dateKey + ":" + idx;
        let list = this._depCache.get(cacheKey);
        if (!list) {
          list = [];
          for (const trip of this.trips) {
            if (!services.has(trip.sv)) continue;
            const st = trip.st;
            for (let k = 0; k < st.length - 1; k++) {
              if (st[k][0] === idx) list.push([st[k][2], trip]);
            }
          }
          list.sort((a, b) => a[0] - b[0]);
          this._depCache.set(cacheKey, list);
        }
        for (const [dep, trip] of list) {
          const wall = dep - day.off;
          if (wall >= secBase && wall <= secBase + horizonSec) {
            out.push({ sec: wall, trip });
          }
        }
      }
    }
    out.sort((a, b) => a.sec - b.sec);
    return out.slice(0, limit);
  }

  /* ---- Hauptschnittstelle ----------------------------------------- */

  /**
   * @param {number} timeMs  Zeitpunkt
   * @param {Map<string,number>|null} delays  optionale Verspaetungen je
   *        Fahrt-ID in Sekunden (aus der Echtzeitquelle): die Position wird
   *        auf der Fahrplan-Kurve zu (jetzt - Verspaetung) ausgewertet.
   * @returns {Array} Fahrzeugliste im oben beschriebenen Format
   */
  getVehicles(timeMs, delays = null) {
    const d = new Date(timeMs);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const secBase = (timeMs - midnight) / 1000;

    const vehicles = [];
    for (const { trip, off } of this._activeTrips(timeMs)) {
      const delay = delays ? delays.get(trip.id) || 0 : 0;
      const hasLive = delays ? delays.has(trip.id) : false;
      const sec = secBase + off - delay;
      const st = trip.st; // [stationIdx, arr, dep, dist]
      // exakte Aktivitaetspruefung (Kandidatenliste hat Randpuffer)
      if (sec < st[0][2] || sec > st[st.length - 1][1]) continue;
      const tl = this._timeline(trip);
      const times = tl.t;
      const nNodes = times.length;

      // ersten Knoten > sec suchen (binaere Suche)
      let lo = 0;
      let hi = nNodes;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= sec) lo = mid + 1;
        else hi = mid;
      }
      const j = lo;

      let dist;
      if (j === 0) {
        dist = tl.d[0];
      } else if (j >= nNodes) {
        dist = tl.d[nNodes - 1];
      } else {
        const span = times[j] - times[j - 1];
        const f = span > 0 ? (sec - times[j - 1]) / span : 1;
        dist = tl.d[j - 1] + (tl.d[j] - tl.d[j - 1]) * f;
      }

      const shape = this.network.shapes[trip.sh];
      const [lat, lon, bearing] = this._pointAt(shape, dist);
      const total = st[st.length - 1][3] - st[0][3] || 1;

      // naechste Station: Knoten 2k/2k+1 gehoeren zu Halt k
      // (waehrend der Standzeit bleibt der aktuelle Halt "naechster Halt")
      const nextIdx = Math.min(j >> 1, st.length - 1);
      vehicles.push({
        id: trip.id,
        route: trip.r,
        lat,
        lon,
        bearing,
        headsign: trip.hs,
        nextStop: this.network.stations[st[nextIdx][0]][0],
        nextStopTime: st[nextIdx][1] + delay,
        progress: (dist - st[0][3]) / total,
        delaySec: delay,
        realtime: hasLive,
        sdSec: sec, // Betriebstag-Sekunde (verspaetungsbereinigt)
      });
    }
    return vehicles;
  }
}

/* ================================================================== */
/*  Echtzeit ueber die oeffentliche VVS-EFA-Schnittstelle             */
/* ================================================================== */

/**
 * Live-Quelle: fragt den Abfahrtsmonitor der VVS-EFA-API ab (CORS ist
 * offen, kein Schluessel noetig) und liefert
 *  - Live-Abfahrten je Station (inkl. Verspaetung) und
 *  - eine Verspaetungs-Karte je Fahrt-ID, mit der der Simulator die
 *    Bahnen auf der Karte verschiebt (Position zu "jetzt - delay").
 * EFA-Ereignisse werden ueber Linie + geplante Abfahrtsminute auf die
 * GTFS-Fahrten gematcht.
 */
class EfaRealtime {
  static ENDPOINT = "https://www3.vvs.de/mngvvs/XML_DM_REQUEST";
  static REFRESH_MS = 45000; // je Station hoechstens alle 45 s abfragen
  static MAX_AGE_MS = 180000; // Daten verfallen nach 3 min
  static FRESH_MS = 90000; // juenger als das gilt als "abgedeckt"
  static COVER_BUDGET = 14; // max. zusaetzliche Stationsabfragen je Zyklus
  static LOOKAHEAD_SEC = 900; // kommende Halte einer Bahn: naechste 15 min

  /**
   * @param {Object} network  Inhalt von data/network.json
   * @param {ScheduleSimulator} simulator
   */
  constructor(network, simulator) {
    this.network = network;
    this.simulator = simulator;
    this._stations = new Map(); // stationIdx -> {time, rows}
    this._delays = new Map(); // tripId -> {delaySec, time}
    this._pending = new Map(); // stationIdx -> Promise
    this.onUpdate = null; // Callback bei neuen Daten
    this.lastSuccess = 0;
    this.lastError = null;
  }

  available() {
    return true;
  }

  /** Aktuelle Verspaetungen (Sekunden) je Fahrt-ID. */
  delays() {
    const now = Date.now();
    const m = new Map();
    this._delays.forEach((v, k) => {
      if (now - v.time < EfaRealtime.MAX_AGE_MS) m.set(k, v.delaySec);
    });
    return m;
  }

  /** Fahrzeuge = Fahrplan-Kurve, um bekannte Verspaetungen verschoben. */
  getVehicles(timeMs) {
    return this.simulator.getVehicles(timeMs, this.delays());
  }

  /**
   * Live-Abfahrten fuer Stations-Indizes aus dem Cache — oder null,
   * wenn (noch) keine frischen Daten vorliegen.
   * Zeilen: {sec, planSec, delayMin, linie, ziel, trip|null}
   */
  getLiveDepartures(indices, timeMs, limit = 4) {
    const now = Date.now();
    const rows = [];
    let any = false;
    for (const idx of indices) {
      const c = this._stations.get(idx);
      if (c && now - c.time < EfaRealtime.MAX_AGE_MS) {
        any = true;
        rows.push(...c.rows);
      }
    }
    if (!any) return null;
    const d = new Date(timeMs);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const secNow = (timeMs - midnight) / 1000;
    return rows
      .filter((r) => r.sec >= secNow - 30)
      .sort((a, b) => a.sec - b.sec)
      .slice(0, limit);
  }

  /**
   * Volle Abdeckung: sorgt dafuer, dass JEDE aktive Bahn eine frische
   * Echtzeit-Korrektur bekommt. Jede Bahn nennt ihre Halte der naechsten
   * 15 Minuten; per Greedy-Set-Cover wird die kleinste Stationsmenge
   * gewaehlt, die alle noch unabgedeckten Bahnen erfasst (Knotenpunkte
   * decken viele Linien auf einmal ab). `pinnedIndices` (Favoriten,
   * geoeffnete Station) werden immer abgefragt.
   */
  coverageRefresh(timeMs, pinnedIndices = []) {
    if (!this._tripById) {
      this._tripById = new Map(this.simulator.trips.map((t) => [t.id, t]));
    }
    const now = Date.now();
    const vehicles = this.simulator.getVehicles(timeMs, this.delays());

    // Bahnen ohne frische Daten + ihre kommenden Halte
    const uncovered = new Set();
    const covers = new Map(); // stationIdx -> Set<tripId>
    for (const v of vehicles) {
      const entry = this._delays.get(v.id);
      if (entry && now - entry.time < EfaRealtime.FRESH_MS) continue;
      const trip = this._tripById.get(v.id);
      if (!trip) continue;
      const st = trip.st;
      let hasCandidate = false;
      for (let k = 0; k < st.length - 1; k++) {
        const dep = st[k][2];
        if (dep < v.sdSec) continue;
        if (dep > v.sdSec + EfaRealtime.LOOKAHEAD_SEC) break;
        let set = covers.get(st[k][0]);
        if (!set) {
          set = new Set();
          covers.set(st[k][0], set);
        }
        set.add(v.id);
        hasCandidate = true;
      }
      if (hasCandidate) uncovered.add(v.id);
    }

    // Feste Stationen zuerst (Tafeln) — sie decken ggf. schon Bahnen ab
    const chosen = new Set(pinnedIndices);
    chosen.forEach((idx) => {
      const set = covers.get(idx);
      if (set) set.forEach((id) => uncovered.delete(id));
    });

    // Greedy: Station mit den meisten unabgedeckten Bahnen zuerst
    let budget = EfaRealtime.COVER_BUDGET;
    while (uncovered.size && budget > 0) {
      let bestIdx = -1;
      let bestCount = 0;
      covers.forEach((set, idx) => {
        if (chosen.has(idx)) return;
        let count = 0;
        set.forEach((id) => {
          if (uncovered.has(id)) count++;
        });
        if (count > bestCount) {
          bestCount = count;
          bestIdx = idx;
        }
      });
      if (bestIdx < 0) break;
      chosen.add(bestIdx);
      covers.get(bestIdx).forEach((id) => uncovered.delete(id));
      budget--;
    }

    // leicht gestaffelt abfragen (refreshStation drosselt je Station)
    [...chosen].forEach((idx, i) => {
      setTimeout(() => this.refreshStation(idx, timeMs), i * 250);
    });
    return chosen.size;
  }

  /** Station abfragen (gedrosselt); loest onUpdate aus. */
  refreshStation(idx, timeMs) {
    const cached = this._stations.get(idx);
    if (cached && Date.now() - cached.time < EfaRealtime.REFRESH_MS) {
      return Promise.resolve();
    }
    if (this._pending.has(idx)) return this._pending.get(idx);
    const p = this._fetchStation(idx, timeMs)
      .then(() => {
        this.lastSuccess = Date.now();
        this.lastError = null;
        if (this.onUpdate) this.onUpdate();
      })
      .catch((err) => {
        this.lastError = err;
        if (this.onUpdate) this.onUpdate();
      })
      .finally(() => {
        this._pending.delete(idx);
      });
    this._pending.set(idx, p);
    return p;
  }

  async _fetchStation(idx, timeMs) {
    const stationId = this.network.stations[idx][3];
    if (!stationId) throw new Error("Station ohne ID");
    const params = new URLSearchParams({
      SpEncId: "0",
      coordOutputFormat: "EPSG:4326",
      // hoeheres Limit = mehr Ereignisse je Abfrage, dadurch werden an
      // Knotenpunkten mehr Fahrten in einem Rutsch gematcht
      limit: "25",
      mode: "direct",
      name_dm: stationId,
      outputFormat: "rapidJSON",
      type_dm: "any",
      useRealtime: "1",
      version: "10.2.10",
    });
    const res = await fetch(EfaRealtime.ENDPOINT + "?" + params.toString());
    if (!res.ok) throw new Error("EFA-Antwort " + res.status);
    const data = await res.json();

    const d = new Date(timeMs);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    // Fahrplan-Abfahrten der Station, um Fahrt-IDs zuzuordnen
    const sched = this.simulator.getDepartures([idx], timeMs, 40, 3 * 3600);

    const rows = [];
    for (const ev of data.stopEvents || []) {
      const tr = ev.transportation || {};
      const linie = tr.number || "?";
      if (!linie.startsWith("U")) continue; // nur Stadtbahn
      const planIso = ev.departureTimePlanned;
      const estIso = ev.departureTimeEstimated || planIso;
      if (!planIso) continue;
      const planSec = (new Date(planIso).getTime() - midnight) / 1000;
      const estSec = (new Date(estIso).getTime() - midnight) / 1000;

      const match = sched.find(
        (s) =>
          Math.abs(s.sec - planSec) < 30 &&
          this.network.routes[s.trip.r].name === linie
      );
      const delaySec = Math.round(estSec - planSec);
      if (match) {
        this._delays.set(match.trip.id, { delaySec, time: Date.now() });
      }
      rows.push({
        sec: estSec,
        planSec,
        delayMin: Math.round(delaySec / 60),
        linie,
        ziel: (tr.destination || {}).name || "",
        trip: match ? match.trip : null,
      });
    }
    this._stations.set(idx, { time: Date.now(), rows });
  }
}

window.ScheduleSimulator = ScheduleSimulator;
window.EfaRealtime = EfaRealtime;
