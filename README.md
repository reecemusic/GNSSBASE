# NovAtel GNSSBASE Monitor

Connects to a NovAtel PwrPak over USB serial (COM11 @ 9600 by default), falling back to TCP
when serial does not connect, decodes the core logs used by the `GNSSBASE`
profile and displays them live in a browser. No npm dependencies — Node 18+ only.

## Run

```bash
npm start                       # tries COM11 @ 9600, then 20.20.20.50:3001; UI at http://127.0.0.1:8080
```

## What is displayed

The connection box is green when the receiver port is open, amber while connecting,
retrying or processing a connection command, and red when disconnected or the monitor
server is unreachable. Its label explains the current state, active serial/TCP target,
automatic TCP fallback and retry countdown. **Disconnect** stops automatic retries;
**Connect** starts them again. Editing connection settings shows **Apply & reconnect**;
changes only take effect when that button is pressed.

| Tab | Logs |
| --- | --- |
| Overview | Per-log counters, format, last-seen time, CRC result |
| Position | BESTPOS, BESTGNSSPOS (solution status, lat/lon/height, σ, SVs, ages, station ID) plus a live map |
| Satellites | Skyplot merging SATVIS2 (geometry), BESTSATS (solution usage) and RANGE (tracking, C/No), with per-constellation toggles and a satellite status table; plus the raw RANGE table |
| Ephemeris and Iono | Per-constellation sub-tabs with one row per PRN and ephemeris/iono parameter columns across the table |
| Interference | ITDETECTSTATUS (signal, detection count, center freq, bandwidth, power, history); linked power and GNSS frequency plots with signal visibility controls |
| Receiver health | RXSTATUS error/status words with decoded flags, VERSION component table |
| Raw stream | Every framed log, filterable by name, pause/clear |

Both ASCII (`#...*crc`) and binary (`0xAA 0x44 0x12`) framings are decoded, and the two
may be interleaved on the same port. CRC is verified on every log.

The Position map uses Leaflet and OpenStreetMap tiles loaded from a CDN (pinned with
subresource integrity). It is the only part of the UI that needs internet access; without
it the tab falls back to printing the coordinates and everything else keeps working.

## History

Skyplot traces and the interference timeline are backed by a time-bounded store in
[src/history.js](src/history.js). The **History** selector in the page header (5 min to
24 h) controls how far back both views reach; the choice is remembered per browser, and
options longer than the server's retention are disabled automatically.

History is written to `data/history.json` periodically and on shutdown, then restored at
startup, so traces and interference records survive a restart. Both memory and file size
are bounded by `HISTORY_RETENTION_MIN`, `TRACK_SAMPLE_SEC` and `MAX_IT_SAMPLES`.

For long-running sessions, the browser retains at most 10,000 interference samples,
1,081 points per satellite track, 300 raw rows and 50 recent interference events.
At high input rates, older browser samples are dropped even within the selected window;
the server retains its independently configured history. Timeline markers are combined
per screen pixel, preserving the strongest detection, to bound chart size.
Only the active tab is rendered, with live updates batched at most four times per second.
Hidden browser pages close their live stream; receiver collection and server history
continue. Returning to the page reloads current state and retained history automatically.
Slow browser connections are disconnected before their server-side output buffers grow
unchecked, then reconnect automatically.

## Interference Display

The Interference tab includes a full-screen display button for a shared monitoring
screen. It keeps the live alert, active bands, history selector and timeline visible.
Escape exits full screen.

The power timeline uses a line chart with a fixed -130 to -70 dBm scale for each
band. Higher points mean stronger detected power, with equal vertical spacing for
equal dB changes. Values outside that range are clipped to the axis limits; hovering
a marker shows its reported power. Each band has a numeric power plot and one
horizontal status bar on the same time axis; the power trace and status bar use
the same colour for each report. Status colours encode severity:
> -95 dBm, -110 to -95 dBm, <= -110 dBm, Clear and Power unknown. The middle
category covers power greater than -110 up to and including -95 dBm. Clear reports
do not imply a measured power of -130 dBm. The power trace contains measured dBm
only. Both displays share the same time axis, pan and zoom controls. The
strongest detection per horizontal pixel is retained for L1, L2 and L5.
Lines break at clear reports, unknown power and
reporting gaps longer than 15 seconds, so separate interference events are not
joined across missing data. The chart resizes with the browser and when switching
tabs.

The GNSS frequency overlays below the band cards use the same visible time
window and time axis as **Power over time**, including its pan and zoom. Drag
**any** plot to pan, or scroll over it to zoom around the pointer. The shared
**Earlier / Later**, **Zoom in / Zoom out** and **Reset / Live** buttons work
for all four plots. All plot labels and hover times use the selected time zone.
The vertical axis is frequency in MHz. Each signal has its own high-contrast
colour within its group and a matching, keyboard-accessible toggle button.
Signal visibility is remembered per browser. Overlapping allocations are split
into alternating coloured stripes so no signal covers another; hover a stripe
for the signal's full allocation bounds. Toggling an allocation never hides
detected energy or changes the power chart. Dashed horizontal lines mark each
visible signal allocation's centre frequency; coincident centres alternate
signal colours along the line. Hover a guide for its signal name and frequency.
For frequency-range allocations (GLONASS and BeiDou B3), the guide marks the
midpoint of the displayed range, not individual GLONASS FDMA channels.
Narrow red vertical markers show each
interference detection's center frequency and bandwidth at its report time
(hover for details). The grouped plots are titled **L1 / E1 / B1 / G1**,
**L2 / G2 / B3**, and **L5 / E5 / B2**.

Drag the power plot or use **Earlier / Later** to pan. Use **Zoom in / Zoom out**
or the mouse wheel to zoom (down to a 10-second window). Navigation is bounded by
the selected History window. Panning or zooming holds a historical view; **Reset /
Live** restores the full window and follows incoming reports. Hover a power or
status marker to inspect its band, timestamp and reported power. Clear and
unknown-power reports are identified without inventing a power value. Stored
timestamps and receiver data are unchanged.

The header's **Time zone** selector defaults to **United Arab Emirates
(Asia/Dubai, UTC+04:00)**. Choose UTC or another named time zone; the choice is
remembered per browser and immediately updates chart labels, hover details,
recent status changes, raw stream times and other displayed log timestamps.
Hover details include the date, milliseconds and UTC offset; daylight-saving
changes are handled according to the selected zone.

**Current band status** sits directly below **Power over time**. Cards for
**L1 / E1 / B1 / G1**, **L2 / G2**, **L5 / E5 / B2**, **L6 / E6 / B3**,
**SBAS**, **S-Band**, **L-Band** and **Unclassified** remain visible even when
there are no detections, keeping the band order consistent as status changes.
Each card shows its frequency range and related signals. All-band clear reports
contribute to the history statistics for every card, not just L1 and L2.

Disconnected streams or status reports older than 60 seconds show an unavailable
warning rather than a live clear indication.

Every connection requests `LOG ITDETECTSTATUSA ONTIME 1`, including when the other
logs are managed by the receiver profile. Each report updates the timeline,
last-report time and message counter even when the detection status is unchanged.
Recent Status Changes omits clear rows except for the first valid clear report after
detections; repeated clear reports do not add rows. Detection reports remain
visible. Initial clear reports are omitted, and CRC-failed clear reports do not
change the last valid detection state. This filtering affects only the message
list, not report counters, live status or chart history.

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `NOVATEL_TRANSPORT` | `auto` | `auto` tries USB serial first and falls back to TCP if the port cannot be opened or yields no NovAtel log; each reconnect cycle tries serial again first. Use `serial` or `tcp` to force one transport. |
| `NOVATEL_SERIAL_PATH` / `NOVATEL_SERIAL_BAUD` | `COM11` / `9600` | USB serial port and baud rate |
| `NOVATEL_SERIAL_PROBE_MS` | `5000` | In `auto` mode, how long an open serial port may go without a decodable log before falling back to TCP |
| `NOVATEL_HOST` / `NOVATEL_PORT` | `20.20.20.50` / `3001` | Receiver ICOM endpoint (TCP) |
| `NOVATEL_SEND_LOG_CMD` | `false` | When `true`, sends `UNLOGALL THISPORT` plus its own `LOG ...A` requests on connect. Leave `false` when the receiver is running [profiles/GNSSBASE.txt](profiles/GNSSBASE.txt), which already pushes these logs to ICOM1 — `UNLOGALL THISPORT` would remove them. |
| `NOVATEL_RECONNECT_MS` | `3000` | Reconnect delay |
| `NOVATEL_IDLE_MS` | `30000` | Recycle the socket if no data arrives for this long |
| `WEB_HOST` / `WEB_PORT` | `127.0.0.1` / `8080` | Web UI bind address. Localhost by default; the UI has no authentication. |
| `HISTORY_SIZE` / `RAW_LOG_SIZE` | `50` / `200` | Replay buffers sent to a newly opened browser |
| `HISTORY_RETENTION_MIN` | `360` | How far back skyplot traces and the interference timeline are kept. This is the longest window a browser can select. |
| `TRACK_SAMPLE_SEC` | `20` | Minimum spacing between skyplot trace samples per satellite |
| `MAX_IT_SAMPLES` | `50000` | Hard cap on stored interference samples |
| `HISTORY_FILE` | `data/history.json` | Where history is persisted. Set to an empty string for memory-only. |
| `HISTORY_SAVE_SEC` | `60` | How often history is written to disk |

The requested logs are listed in [src/config.js](src/config.js). They are requested in
ASCII on this tool's own port only — the profile's binary `LOG FILE ...` recording is
untouched, and `UNLOGALL THISPORT` only affects the port the tool is connected on.

## Receiver configuration

[profiles/GNSSBASE.txt](profiles/GNSSBASE.txt) is the receiver profile this viewer expects.
It keeps the original binary `LOG FILE ...` recording unchanged and adds an ICOM1 TCP
listener on port 3001 that carries the ASCII logs shown in the UI. Load it over any
existing connection (NovAtel Application Suite terminal, or a TCP session), then reboot
or `PROFILE ACTIVATE GNSSBASE`.

## Testing without hardware

Run `npm test` for the memory-bound and update-batching regression checks.

```bash
npm run sim                                                   # terminal 1
NOVATEL_HOST=127.0.0.1 NOVATEL_PORT=3001 npm start            # terminal 2
```

The simulator emits VERSION, BESTPOS (binary), BESTGNSSPOS, RANGE, RXSTATUS,
ITDETECTSTATUS and all seven ephemeris logs.

## Layout

- [src/novatel.js](src/novatel.js) — ASCII and binary framing, CRC32, GPS-time conversion, message-ID table
- [src/messages.js](src/messages.js) — per-log decoders and receiver-status bit names
- [src/receiver.js](src/receiver.js) — TCP client, stream framing, auto-reconnect
- [src/server.js](src/server.js) — state store, Server-Sent Events, `/api/snapshot`
- [public/](public/) — browser UI

## Notes on decoding

- `ITDETECTSTATUS` detection block size varies by OEM7 firmware, so it is derived at
  runtime and values are classified heuristically; raw fields are always shown.
- Binary logs have dedicated decoders for BESTPOS, BESTGNSSPOS, RANGE and RXSTATUS.
  Other binary logs are framed, named and CRC-checked but their bodies are not expanded —
  request the ASCII form (the default) for full field detail.
