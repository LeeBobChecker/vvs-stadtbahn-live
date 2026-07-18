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
   * @param {Object} network  Inhalt von data/network.json
   * @param {Object} schedule Inhalt von data/schedule.json
   */
  constructor(network, schedule) {
    this.network = network;
    this.services = schedule.services;
    this.trips = schedule.trips;
    this._activeCache = { key: null, trips: [] };
    this._serviceCache = new Map(); // "YYYYMMDD" -> Set<serviceIdx>
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
   * Fahrten, die zum Zeitpunkt `timeMs` unterwegs sind, jeweils mit den
   * Sekunden relativ zum zugehoerigen Betriebstag.
   * GTFS-Zeiten koennen > 24 h laufen, daher werden der heutige und der
   * gestrige Betriebstag geprueft.
   */
  _activeTrips(timeMs) {
    const cacheKey = Math.floor(timeMs / 30000); // 30-s-Raster
    if (this._activeCache.key === cacheKey) return this._activeCache.trips;

    const now = new Date(timeMs);
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const secToday = (timeMs - midnight.getTime()) / 1000;
    const yesterday = new Date(midnight.getTime() - 86400000);

    const days = [
      { services: this._activeServices(midnight), sec: secToday },
      { services: this._activeServices(yesterday), sec: secToday + 86400 },
    ];

    const result = [];
    for (const trip of this.trips) {
      const first = trip.st[0];
      const last = trip.st[trip.st.length - 1];
      for (const day of days) {
        if (!day.services.has(trip.sv)) continue;
        if (day.sec >= first[2] && day.sec <= last[1]) {
          result.push({ trip, sec: day.sec });
        }
      }
    }
    this._activeCache = { key: cacheKey, trips: result };
    return result;
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

  /* ---- Hauptschnittstelle ----------------------------------------- */

  /** @returns {Array} Fahrzeugliste im oben beschriebenen Format */
  getVehicles(timeMs) {
    const vehicles = [];
    for (const { trip, sec } of this._activeTrips(timeMs)) {
      const st = trip.st; // [stationIdx, arr, dep, dist]
      // Segment suchen, in dem `sec` liegt
      let i = 0;
      while (i < st.length - 1 && sec > st[i + 1][1]) i++;
      const cur = st[i];
      const next = st[Math.min(i + 1, st.length - 1)];

      let dist;
      if (sec <= cur[2]) {
        dist = cur[3]; // Standzeit an der Station
      } else {
        const span = next[1] - cur[2];
        const f = span > 0 ? (sec - cur[2]) / span : 1;
        dist = cur[3] + (next[3] - cur[3]) * Math.min(f, 1);
      }

      const shape = this.network.shapes[trip.sh];
      const [lat, lon, bearing] = this._pointAt(shape, dist);
      const total = st[st.length - 1][3] - st[0][3] || 1;

      // naechste Station (bei Standzeit: die aktuelle, solange nicht abgefahren)
      const nextIdx = sec <= cur[2] ? i : Math.min(i + 1, st.length - 1);
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
