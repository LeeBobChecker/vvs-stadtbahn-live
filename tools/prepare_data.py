#!/usr/bin/env python3
"""Filtert den VVS-GTFS-Feed auf die Stuttgarter Stadtbahn (U-Linien)
und exportiert kompakte JSON-Dateien fuer die Web-App.

Eingabe:  ~/Downloads/gtfs_realtime/  (kompletter VVS-Feed)
Ausgabe:  web/data/network.json   (Linien, Stationen, Streckengeometrien)
          web/data/schedule.json  (Fahrten mit Zeit/Distanz-Stuetzpunkten)
"""

import csv
import json
import os
import sys
from collections import defaultdict

GTFS_DIR = os.environ.get("GTFS_DIR", os.path.expanduser("~/Downloads/gtfs_realtime"))
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "data")

STADTBAHN_ROUTE_TYPE = "402"  # Urban Railway (Stadtbahn)


def read_csv(name):
    path = os.path.join(GTFS_DIR, name)
    with open(path, newline="", encoding="utf-8-sig") as f:
        yield from csv.DictReader(f)


def hms_to_sec(hms):
    h, m, s = hms.split(":")
    return int(h) * 3600 + int(m) * 60 + int(s)


def station_key(stop_id):
    """'de:08111:6118:2:102' -> 'de:08111:6118' (IFOPT-Station ohne Steig)."""
    parts = stop_id.split(":")
    return ":".join(parts[:3]) if len(parts) >= 3 else stop_id


def main():
    # --- Linien ---------------------------------------------------------
    routes = {}
    for r in read_csv("routes.txt"):
        if r["route_type"] == STADTBAHN_ROUTE_TYPE and r["route_short_name"].startswith("U"):
            routes[r["route_id"]] = {
                "name": r["route_short_name"],
                "longName": r["route_long_name"],
                "color": "#" + (r["route_color"] or "888888"),
                "textColor": "#" + (r["route_text_color"] or "FFFFFF"),
            }
    print(f"Linien: {len(routes)}", file=sys.stderr)

    route_ids = sorted(routes, key=lambda rid: (len(routes[rid]["name"]), routes[rid]["name"]))
    route_idx = {rid: i for i, rid in enumerate(route_ids)}

    # --- Fahrten --------------------------------------------------------
    trips = {}
    service_ids = set()
    shape_ids = set()
    for t in read_csv("trips.txt"):
        if t["route_id"] in routes:
            trips[t["trip_id"]] = {
                "route": route_idx[t["route_id"]],
                "service": t["service_id"],
                "shape": t["shape_id"],
                "headsign": t["trip_headsign"],
                "dir": int(t["direction_id"] or 0),
            }
            service_ids.add(t["service_id"])
            shape_ids.add(t["shape_id"])
    print(f"Fahrten: {len(trips)}, Shapes: {len(shape_ids)}", file=sys.stderr)

    # --- Verkehrstage ---------------------------------------------------
    services = {}
    for c in read_csv("calendar.txt"):
        if c["service_id"] in service_ids:
            services[c["service_id"]] = {
                "days": [int(c[d]) for d in ("monday", "tuesday", "wednesday",
                                             "thursday", "friday", "saturday", "sunday")],
                "start": c["start_date"],
                "end": c["end_date"],
                "add": [],
                "del": [],
            }
    for cd in read_csv("calendar_dates.txt"):
        sid = cd["service_id"]
        if sid not in service_ids:
            continue
        if sid not in services:
            services[sid] = {"days": [0] * 7, "start": "19700101", "end": "20991231",
                             "add": [], "del": []}
        key = "add" if cd["exception_type"] == "1" else "del"
        services[sid][key].append(cd["date"])

    # --- Haltezeiten (232 MB, streamen) ---------------------------------
    stop_times = defaultdict(list)
    used_stop_ids = set()
    for st in read_csv("stop_times.txt"):
        tid = st["trip_id"]
        if tid in trips:
            stop_times[tid].append((
                int(st["stop_sequence"]),
                st["stop_id"],
                hms_to_sec(st["arrival_time"]),
                hms_to_sec(st["departure_time"]),
                float(st["shape_dist_traveled"] or 0),
            ))
            used_stop_ids.add(st["stop_id"])
    print(f"Fahrten mit Haltezeiten: {len(stop_times)}", file=sys.stderr)

    # --- Stationen (Steige -> Station zusammenfassen) -------------------
    stations = {}          # station_key -> {name, lats, lons}
    stopid_to_station = {}
    for s in read_csv("stops.txt"):
        if s["stop_id"] in used_stop_ids:
            key = station_key(s["stop_id"])
            stopid_to_station[s["stop_id"]] = key
            st = stations.setdefault(key, {"name": s["stop_name"], "lats": [], "lons": []})
            st["lats"].append(float(s["stop_lat"]))
            st["lons"].append(float(s["stop_lon"]))

    station_keys = sorted(stations)
    station_idx = {k: i for i, k in enumerate(station_keys)}
    stations_out = []
    for k in station_keys:
        st = stations[k]
        stations_out.append([
            st["name"],
            round(sum(st["lats"]) / len(st["lats"]), 6),
            round(sum(st["lons"]) / len(st["lons"]), 6),
        ])
    print(f"Stationen: {len(stations_out)}", file=sys.stderr)

    # --- Streckengeometrien (349 MB, streamen) --------------------------
    shapes_raw = defaultdict(list)
    for sp in read_csv("shapes.txt"):
        sid = sp["shape_id"]
        if sid in shape_ids:
            shapes_raw[sid].append((
                int(sp["shape_pt_sequence"]),
                round(float(sp["shape_pt_lat"]), 6),
                round(float(sp["shape_pt_lon"]), 6),
                round(float(sp["shape_dist_traveled"] or 0), 1),
            ))
    shape_keys = sorted(shapes_raw)
    shape_idx = {k: i for i, k in enumerate(shape_keys)}
    shapes_out = []
    for k in shape_keys:
        pts = sorted(shapes_raw[k])
        shapes_out.append({
            "pts": [[round(p[1], 5), round(p[2], 5)] for p in pts],
            "dist": [int(round(p[3])) for p in pts],
        })
    print(f"Shapes geladen: {len(shapes_out)}", file=sys.stderr)

    # --- Fahrten serialisieren (kompaktes Format v2) --------------------
    # Fahrten mit identischem Haltemuster (Route, Shape, Ziel, relative
    # Zeiten, Distanzen) teilen sich ein "Pattern"; je Fahrt bleiben nur
    # Pattern-Index, Startzeit und Verkehrstag. Der Browser expandiert
    # das beim Laden wieder (ScheduleSimulator.decodeSchedule).
    service_keys = sorted(services)
    service_idx = {k: i for i, k in enumerate(service_keys)}
    headsign_idx = {}
    headsigns = []
    pattern_idx = {}
    patterns = []
    trips_out = []
    trip_ids = []
    skipped = 0
    for tid, t in trips.items():
        sts = stop_times.get(tid)
        if not sts or t["shape"] not in shape_idx:
            skipped += 1
            continue
        sts.sort()
        start = sts[0][3]  # Abfahrt am ersten Halt
        rel = tuple(
            (station_idx[stopid_to_station[sid]], arr - start, dep - start,
             int(round(dist)))
            for _, sid, arr, dep, dist in sts
        )
        hs = t["headsign"]
        if hs not in headsign_idx:
            headsign_idx[hs] = len(headsigns)
            headsigns.append(hs)
        key = (t["route"], shape_idx[t["shape"]], headsign_idx[hs], t["dir"], rel)
        if key not in pattern_idx:
            pattern_idx[key] = len(patterns)
            patterns.append({
                "r": t["route"],
                "sh": shape_idx[t["shape"]],
                "hs": headsign_idx[hs],
                "d": t["dir"],
                "st": [list(x) for x in rel],
            })
        trips_out.append([pattern_idx[key], start, service_idx[t["service"]]])
        trip_ids.append(tid)
    if skipped:
        print(f"Uebersprungen (ohne Zeiten/Shape): {skipped}", file=sys.stderr)
    print(f"Exportierte Fahrten: {len(trips_out)}, Patterns: {len(patterns)}",
          file=sys.stderr)

    # --- Schreiben ------------------------------------------------------
    os.makedirs(OUT_DIR, exist_ok=True)
    network = {
        "generated": True,
        "routes": [routes[rid] for rid in route_ids],
        "stations": stations_out,
        "shapes": shapes_out,
    }
    schedule = {
        "version": 2,
        "services": [services[k] for k in service_keys],
        "headsigns": headsigns,
        "patterns": patterns,
        "trips": trips_out,
        "ids": trip_ids,
    }
    with open(os.path.join(OUT_DIR, "network.json"), "w", encoding="utf-8") as f:
        json.dump(network, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(OUT_DIR, "schedule.json"), "w", encoding="utf-8") as f:
        json.dump(schedule, f, ensure_ascii=False, separators=(",", ":"))

    for name in ("network.json", "schedule.json"):
        size = os.path.getsize(os.path.join(OUT_DIR, name)) / 1e6
        print(f"{name}: {size:.1f} MB", file=sys.stderr)


if __name__ == "__main__":
    main()
