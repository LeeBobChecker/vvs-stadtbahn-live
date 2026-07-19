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
        if (sec >= first[2] - 15 && sec <= last[1] + 15) {
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

  /** @returns {Array} Fahrzeugliste im oben beschriebenen Format */
  getVehicles(timeMs) {
    const d = new Date(timeMs);
    const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const secBase = (timeMs - midnight) / 1000;

    const vehicles = [];
    for (const { trip, off } of this._activeTrips(timeMs)) {
      const sec = secBase + off;
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
        nextStopTime: st[nextIdx][1],
        progress: (dist - st[0][3]) / total,
        realtime: false,
      });
    }
    return vehicles;
  }
}

/* ================================================================== */
/*  Echtzeit-Adapter (vorbereitet)                                    */
/* ================================================================== */

/**
 * Adapter fuer die VVS-Echtzeitdaten — wird aktiviert, sobald der
 * API-Zugang vorliegt.
 *
 * Erwartete Varianten (je nachdem, was der VVS freischaltet):
 *
 * 1. GTFS-Realtime "VehiclePositions" (Protobuf):
 *    - Feed-URL pollen (alle ~15 s), mit gtfs-realtime-bindings dekodieren.
 *    - entity.vehicle.trip.tripId auf unsere trip_ids mappen,
 *      entity.vehicle.position.{latitude,longitude,bearing} uebernehmen.
 *    - Browser-CORS erfordert i.d.R. einen kleinen lokalen Proxy
 *      (siehe tools/, kann bei API-Erhalt ergaenzt werden).
 *
 * 2. GTFS-Realtime "TripUpdates" (nur Verspaetungen, keine Positionen):
 *    - Verspaetung je trip_id extrahieren und an den ScheduleSimulator
 *      durchreichen: Position = Fahrplanposition zu (jetzt - delay).
 *
 * 3. EFA-/TRIAS-Schnittstelle (JSON/XML Abfahrtsmonitor):
 *    - Wie (2) ueber Verspaetungen je Fahrt.
 *
 * Die App nutzt automatisch diese Quelle statt der Simulation, sobald
 * `available()` true liefert (siehe app.js).
 */
class RealtimeSource {
  /**
   * @param {string} feedUrl  URL des Echtzeit-Feeds (kommt vom VVS)
   * @param {ScheduleSimulator} fallback  Simulator fuer Fahrplan-Fallback
   */
  constructor(feedUrl, fallback) {
    this.feedUrl = feedUrl;
    this.fallback = fallback;
    this.lastFetch = 0;
    this.vehicles = [];
  }

  /** true, sobald ein Feed konfiguriert ist. */
  available() {
    return Boolean(this.feedUrl);
  }

  async poll() {
    if (!this.available()) return;
    // TODO (sobald API-Zugang da ist):
    //   const res = await fetch(this.feedUrl);
    //   const buf = await res.arrayBuffer();
    //   const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    //     new Uint8Array(buf));
    //   this.vehicles = feed.entity.map(...);
    throw new Error("Echtzeit-API noch nicht konfiguriert");
  }

  getVehicles(timeMs) {
    // Bis zur Anbindung: leere Liste (app.js nutzt dann die Simulation).
    return this.vehicles;
  }
}

window.ScheduleSimulator = ScheduleSimulator;
window.RealtimeSource = RealtimeSource;
