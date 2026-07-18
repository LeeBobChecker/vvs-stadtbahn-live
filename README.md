# Stuttgart Stadtbahn Live

Live-Karte der Stuttgarter Stadtbahn (U-Linien). Solange die VVS-Echtzeit-API
noch nicht freigeschaltet ist, werden die Fahrzeugpositionen aus dem
GTFS-Fahrplan berechnet — die Bahnen bewegen sich also fahrplanbasiert in
Echtzeit über die Karte.

## Starten

```bash
python3 -m http.server 8173 --directory docs
# dann http://localhost:8173 öffnen
```

(In Claude Code startet der Server automatisch über `.claude/launch.json`.)

## Funktionen

- **Live-Positionen** aller 15 U-Linien, entlang der echten Gleisgeometrie
  interpoliert (inkl. Standzeiten an Stationen)
- **Stadtbahn-Icons**: Zug von oben in Linienfarbe, in Fahrtrichtung gedreht —
  die helle Frontscheibe zeigt, wohin der Zug fährt; die Liniennummer bleibt
  immer lesbar
- **Popup** je Bahn: Linie, Ziel, nächster Halt mit Ankunftszeit
- **Favoriten**: Haltestelle anklicken → „Als Favorit merken" → goldener
  Stern auf der Karte (immer sichtbar) + Eintrag in der Favoritenliste im
  Panel (Klick fliegt zur Station). Gespeichert im Browser (localStorage).
- **Stations-Popup** mit allen Linien, die dort halten
- **Hell-/Dunkelmodus**: Umschalter oben rechts (☀/☾), wechselt Karte und
  Oberfläche. Startet passend zur Systemeinstellung, die Wahl wird gespeichert.
- **Linienfilter** mit offiziellen VVS-Linienfarben
- **Zeitreise** (±10 min / ±1 h), um den Betrieb zu anderen Uhrzeiten zu sehen
- 203 Stationen mit Tooltip (ab Zoomstufe 13; Favoriten immer sichtbar)

## Projektstruktur

```
tools/prepare_data.py   GTFS-Aufbereitung (Filter auf route_type 402 = Stadtbahn)
docs/index.html          Oberfläche (Leaflet, dunkles Design)
docs/js/datasource.js    Datenquellen: ScheduleSimulator + RealtimeSource (Stub)
docs/js/app.js           Karte, Marker-Animation, UI
docs/data/network.json   Linien, Stationen, Streckengeometrien (generiert)
docs/data/schedule.json  Fahrten mit Zeit/Distanz-Stützpunkten (generiert)
```

## Daten aktualisieren

Neuen GTFS-Feed nach `~/Downloads/gtfs_realtime/` legen und ausführen:

```bash
python3 tools/prepare_data.py
```

Der aktuelle Feed gilt vom 17.07.2026 bis 17.10.2026.

## Echtzeit-API anbinden (sobald der Zugang da ist)

Die App ist darauf vorbereitet: In `docs/js/datasource.js` steckt der Adapter
`RealtimeSource`. Sobald dort eine Feed-URL konfiguriert ist
(`new RealtimeSource("https://…", simulator)` in `app.js`), nutzt die App
automatisch die Echtzeitdaten statt der Simulation und das Badge wechselt
auf „Live".

Je nach Art des VVS-Zugangs:

1. **GTFS-RT VehiclePositions** (Protobuf): Feed pollen, `trip_id` auf die
   vorhandenen Fahrten mappen, Positionen direkt übernehmen. Für CORS und
   Protobuf-Dekodierung ist ein kleiner lokaler Proxy sinnvoll (kann in
   `tools/` ergänzt werden).
2. **GTFS-RT TripUpdates** (nur Verspätungen): Verspätung je Fahrt an den
   `ScheduleSimulator` durchreichen (Position = Fahrplanposition zu
   `jetzt − Verspätung`).
3. **EFA/TRIAS** (JSON/XML): wie Variante 2 über Verspätungen.

## Hinweis zu den Shapefiles

Die Shapefiles (`Liniennetz`, `Haltestellen`) aus dem Download wurden nicht
benötigt — der GTFS-Feed enthält Geometrien (`shapes.txt`) und Halte bereits
in höherer Qualität inklusive Distanzangaben für die Interpolation.
