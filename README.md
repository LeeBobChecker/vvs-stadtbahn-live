# Stuttgart Stadtbahn Live

Live-Karte der Stuttgarter Stadtbahn (U-Linien). Solange die VVS-Echtzeit-API
noch nicht freigeschaltet ist, werden die Fahrzeugpositionen aus dem
GTFS-Fahrplan berechnet — die Bahnen bewegen sich also fahrplanbasiert in
Echtzeit über die Karte.

**➜ Live: https://leebobchecker.github.io/vvs-stadtbahn-live/**

(auch mobil — einfach die URL auf dem Handy öffnen und ggf. über
„Zum Home-Bildschirm hinzufügen" als App ablegen)

## Lokal starten

```bash
python3 -m http.server 8173 --directory docs
# dann http://localhost:8173 öffnen
```

(In Claude Code startet der Server automatisch über `.claude/launch.json`.)

## Funktionen

- **Live-Positionen** aller 15 U-Linien, entlang der echten Gleisgeometrie
  interpoliert: konstante Fahrt zwischen den Halten, kurze Standzeit
  (~20 s) an jeder Station. Da die VVS-Zeiten minutengenau sind, wird je
  Fahrt eine stetige Zeit/Distanz-Kurve berechnet — auch bei
  0-Sekunden-Segmenten im Fahrplan gibt es keine Positionssprünge.
- **Datenquellen-Schalter** Simulation ↔ Live: Der Live-Modus nutzt die
  öffentliche VVS-EFA-Schnittstelle (CORS offen, kein Schlüssel nötig):
  Abfahrtstafeln (Favoriten + Stations-Popups) zeigen Echtzeit inklusive
  Verspätung (roter „+X"-Chip), und gematchte Verspätungen verschieben die
  Bahnen auf der Karte (Position = Fahrplan zu „jetzt − Verspätung").
  Abgefragt werden Favoriten und die geöffnete Station (alle 60 s,
  gedrosselt); übrige Fahrten laufen nach Fahrplan. EFA-Ereignisse werden
  über Linie + geplante Abfahrtsminute den GTFS-Fahrten zugeordnet.
- **Stadtbahn-Icons**: Zug von oben in Linienfarbe, in Fahrtrichtung gedreht —
  die helle Frontscheibe zeigt, wohin der Zug fährt; die Liniennummer bleibt
  immer lesbar
- **Popup** je Bahn: Linie, Ziel, nächster Halt mit Ankunftszeit
- **Favoriten**: Haltestelle anklicken → „Als Favorit merken" → goldener
  Stern auf der Karte (immer sichtbar) + Eintrag in der Favoritenliste im
  Panel (Klick fliegt zur Station). Gespeichert im Browser (localStorage).
- **Haltestellen-Suche**: Suchfeld im Favoriten-Abschnitt — tippen,
  Treffer zeigen die dort haltenden Linien, per Stern direkt als Favorit
  merken, Klick auf den Namen fliegt zur Station.
- **Abfahrtstafel**: Für jede Favoriten-Station zeigt das Panel die
  nächsten 4 Abfahrten (Linie, Ziel, Countdown bzw. Uhrzeit), aktualisiert
  alle 10 s und an die Zeitreise gekoppelt. Endhalte zählen nicht als
  Abfahrt; gleichnamige Teilstationen werden zusammengefasst.
- **Stations-Popup** mit allen Linien, die dort halten
- **Hell-/Dunkelmodus**: Umschalter oben rechts (☀/☾), wechselt Karte und
  Oberfläche. Startet passend zur Systemeinstellung, die Wahl wird gespeichert.
- **Mein Standort** (◎ unten rechts): blauer Punkt mit Puls-Ring und
  Genauigkeitskreis, wird laufend nachgeführt; findet die nächstgelegene
  Haltestelle und öffnet deren Popup mit Abfahrten.
- **Bedienfeld einklappbar** (☰ oben rechts): blendet das Panel aus, damit
  die Karte den ganzen Bildschirm nutzt; Zustand wird gespeichert.
- **Bahn verfolgen**: Klick auf eine Abfahrt (Tafel oder Stations-Popup) oder
  auf „Dieser Bahn folgen" im Fahrzeug-Popup — die Karte bleibt an der Bahn,
  Chip oben zeigt Linie/Ziel, Beenden per ✕ oder Karte ziehen.
- **Linie isolieren**: Doppelklick auf einen Linien-Chip zeigt nur diese
  Linie; erneuter Doppelklick bringt alle zurück.
- **PWA**: installierbar („Zum Home-Bildschirm"), App-Icon, Offline-Cache
  über Service Worker — beim zweiten Öffnen lädt die App aus dem Cache.
- **Akkuschonend**: Animation pausiert bei Tab im Hintergrund; gerendert
  werden nur Bahnen im sichtbaren Kartenausschnitt.
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

**Automatisch:** Eine GitHub Action
([.github/workflows/update-data.yml](.github/workflows/update-data.yml))
lädt jeden Montag den offiziellen VVS-GTFS-Feed
(https://download.vvs.de/gtfs_realtime.zip, Lizenz CC BY 4.0 via
MobiData BW), bereitet ihn auf und committet die Änderungen — GitHub Pages
deployt dann automatisch. Manuell auslösbar über den „Run workflow"-Button.

**Manuell:** Feed nach `~/Downloads/gtfs_realtime/` entpacken (oder
`GTFS_DIR` setzen) und ausführen:

```bash
python3 tools/prepare_data.py
```

`schedule.json` nutzt ein kompaktes Format (v2): identische Haltemuster
werden als „Patterns" dedupliziert (≈1 MB statt 12 MB); der Browser
expandiert sie beim Laden (`ScheduleSimulator.decodeSchedule`).

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
