# NovAtel GNSSBASE Monitor

Connects to a NovAtel PwrPak over USB serial (COM11 @ 9600 by default), falling back to TCP
when serial does not connect, decodes the core logs used by the `GNSSBASE`
profile and displays them live in a browser. Node 22 or newer (current LTS). The only npm dependency is `serialport`, used for the USB/RS-232 port.

## Run

```bash
npm start                       # tries COM11 @ 9600, then 20.20.20.50:3001; UI listens on all interfaces, still at http://127.0.0.1:8080
```

`npm start` runs `node src/start.js`, which sets `UV_THREADPOOL_SIZE` to 16 when the variable is not already set, then loads the server. Set the variable in the service environment if you want a different pool size. It has to be set before the process uses the filesystem; changing it later does nothing.

Other devices on the same network can open `http://<PC IP>:8080`. Windows Firewall will prompt to allow Node on private networks. The page is readable from the LAN. Connect, disconnect, and apply are accepted only from this PC (`127.0.0.1` / `::1`) unless `ALLOW_REMOTE_CONTROL=true`. Set `WEB_HOST=127.0.0.1` to keep the page on this PC as well.

## Running always-on

The monitor is meant to stay up on the PC beside the receiver. A browser reload cannot re-enter the Fullscreen API without a click, and the page does not shift pixels (that would change the picture). Use the display's own pixel-shift, and start Chrome in kiosk mode so a heap reload stays full screen.

- Run Node as a Windows service with [NSSM](https://nssm.cc/) or [WinSW](https://github.com/winsw/winsw). Set the service to restart on failure, and rotate its stdout/stderr logs.
- Set `UV_THREADPOOL_SIZE=16` on the service if you do not start through `src/start.js`. A stuck NAS read holds one libuv worker; the default pool of 4 can then stall history saves and the web UI.
- Turn off sleep, hibernate, and USB selective suspend so COM11 and the PC stay awake.
- Put the PC on a UPS. A power cut during a history write is recovered from `data/history.json.bak` when that backup is intact, but the UPS is what keeps the receiver and the PC up.
- At logon, start Chrome with `chrome --kiosk --app=http://127.0.0.1:8080/?wall=1`. Kiosk fullscreen is the browser window, not the Fullscreen API, so it survives the heap reload.
- In Chrome, add `127.0.0.1` to Memory Saver's always-active list so the wall tab is not discarded.
- Exclude `data\` from Microsoft Defender real-time scanning so history and archive-cache writes are not locked.
- Use the display's pixel-shift or orbit feature. This app does not move the picture.

`data/history.json` is not tracked in git. A `git pull` on the PC will not replace the live history file. Keep the PC's copy; do not commit it.

History is written at most every `HISTORY_SAVE_SEC` seconds (default 5 minutes), and only when something changed. A service stop (SIGINT/SIGTERM) still flushes. The process force-exits after 5 seconds if that flush does not finish.

## What is displayed

The connection box is green once receiver logs arrive, amber while connecting,
retrying or processing a connection command, and red when disconnected or the monitor
server is unreachable. Its label explains the current state, active serial/TCP target,
automatic TCP fallback and retry countdown. **Disconnect** stops automatic retries;
**Connect** starts them again. Editing connection settings shows **Apply & reconnect**;
changes only take effect when that button is pressed.
An open port alone does not count as connected. If valid periodic ITDETECTSTATUS logs stop for
`NOVATEL_IDLE_MS` (30 seconds by default), the monitor closes the stale serial or TCP
connection and reconnects automatically, requesting the live logs again. In auto
mode a silent serial connection falls back to TCP; subsequent retry cycles try
serial first again. This also recovers when a receiver power cycle leaves its USB
serial port open without emitting a disconnect event, or resumes other profile
logs without restoring the monitor's periodic interference-log request.

| Tab | Logs |
| --- | --- |
| Overview | Per-log counters, format, last-seen time, CRC result |
| Position | BESTPOS, BESTGNSSPOS (solution status, lat/lon/height, σ, SVs, ages, station ID) plus a live map |
| Satellites | Skyplot merging SATVIS2 (geometry), BESTSATS (solution usage), RANGE (tracking, C/No) and TRACKSTAT (assigned channels), with per-constellation toggles and a satellite status table; plus the raw RANGE table |
| Ephemeris and Iono | Per-constellation sub-tabs with one row per PRN and ephemeris/iono parameter columns across the table |
| Interference | ITDETECTSTATUS (signal, detection count, center freq, bandwidth, power, history); linked power and GNSS frequency plots with signal visibility controls |
| Receiver health | RXSTATUS error/status words with decoded flags, VERSION component table |
| Raw stream | Every framed log, filterable by name, pause/clear |

Both ASCII (`#...*crc`) and binary (`0xAA 0x44 0x12`) framings are decoded, and the two
may be interleaved on the same port. CRC is verified on every log.
Malformed checksums are marked failed, rather than treated as unchecked. Reports
without a checksum stay unchecked. Only CRC-valid reports update the live position,
health and sky displays, or enter live/saved interference, position or sky-track
history. CRC-failed and unchecked reports remain visible in the raw log for diagnosis.
Abbreviated archive logs without a checksum are still decoded. SATVIS2 with invalid
visibility does not create tracks.
Incomplete RANGE, SATVIS2 and ITDETECTSTATUS payloads are rejected explicitly instead
of becoming partial counts or false clear interference reports. Archive scans count
malformed reports in their error counter and continue with subsequent valid records.

Satellite **tracked** counts on both tabs are unique constellation/PRN pairs in
the latest RANGE report, including satellites used in the solution. Multiple
signals do not count as multiple satellites. **In view** counts come only from
valid SATVIS2 positions above the horizon, not the combined RANGE/BESTSATS list.
BESTSATS supplies solution/exclusion status independently of tracking; an excluded
satellite may still be tracked. GLONASS slot IDs (including signed frequency-channel
suffixes) are matched across logs. Invalid IDs and CRC-failed reports are excluded.
Tracked totals therefore overlap with the used, missing and unhealthy status counts;
those cards are not additive. Used-signal counts deduplicate each satellite per band.
Used bands come from BESTSATS signal masks, not every RANGE signal on a used
satellite. Malformed BESTSATSA counts, incomplete entries and conflicting duplicate
satellites are rejected with an explicit receiver-processing error; identical
duplicates are counted once. A valid zero-entry report still means zero.
The Satellites tab warns when BESTSATS is at least five seconds old and when
same-epoch BESTPOS and BESTSATS used counts disagree; counts are not silently adjusted.
Skyplot constellation filters affect the plot and detail table, not the summary
counts. Counts show the latest reports, not a guarantee of current reception when
the receiver is disconnected.
Every connection explicitly requests `LOG BESTSATSA ONTIME 1`, even with
profile-managed logging: the profile may configure ICOM1 while the monitor uses
USB serial. Without a decoded, CRC-valid BESTSATS report, per-satellite usage,
and used signals are shown as unavailable rather than zero or
"not used". BESTPOS still supplies the overall used total when available.
`LOG TRACKSTATA ONTIME 5` supplies assigned tracking channels. Assigned satellites
with valid visible positions at or above the reported tracking cutoff, but without
RANGE observations, are classified as missing, including satellites that
BESTSATS does not list. Idle channels, below-cutoff search candidates and candidates
without valid sky geometry are excluded; multiple channels for one
satellite are deduplicated. Missing counts are unavailable without TRACKSTAT.
This is an explicit assigned-channel definition; the manufacturer's internal
missing-satellite selection/retention policy is not documented and may differ.
The constellation legend separates used, not used and missing counts for comparison
with the manufacturer's Satellite View. Its "in view" value is a separate almanac
prediction and is not equivalent to the manufacturer's tracked-plus-missing total.

The Position map uses Leaflet and OpenStreetMap tiles loaded from a CDN (pinned with
subresource integrity). It is the only part of the UI that needs internet access; without
it the tab falls back to printing the coordinates and everything else keeps working.

## History

Skyplot traces and the interference timeline are backed by a time-bounded store in
[src/history.js](src/history.js). The **History** selector in the page header (5 min to
24 h) controls how far back both views reach; the choice is remembered per browser, and
options longer than the server's retention are disabled automatically.

History is written to `data/history.json` periodically and on shutdown, then restored at
startup, so traces and interference records survive a restart. Samples use the receiver's
GPS time only when that time is after 2020 and within five minutes of the computer clock;
otherwise they use the time the report was received, so a receiver that has not set GPS
week yet still appears on the live chart. A history file that is too large or cannot be
parsed is left in place and is not overwritten. Both memory and file size
are bounded by `HISTORY_RETENTION_MIN` (24 h by default), `TRACK_SAMPLE_SEC` and `MAX_IT_SAMPLES`.
When a window holds more samples than the browser asks for, the newest half is sent as
recorded and older samples are merged into time buckets (strongest report per band;
latest solution and satellites-tracked sample), so a 24 h window always reaches back 24 h.
The wall **Satellites tracked** plot is stored in the same file: per-constellation
tracked counts from RANGE and in-view counts from SATVIS2, thinned to a change or
one sample every 10 seconds.

For long-running sessions, the browser retains at most 40,000 interference samples (and
re-requests long windows every 30 minutes),
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

Two further rows under the L1, L2 and L5 power rows share the same time axis, pan
and zoom:

- **Satellites** is a stepped trace of the number of satellites used in the
  BESTPOS solution, auto-scaled to the visible maximum. Hover it for the count of
  satellites used and tracked.
- **Fix type** has one lane per solution quality tier: **No fix**, **Single**,
  **Differential**, **Float** and **Fixed**. These are the same tiers as the
  Position tab's quality badge. A solution status other than `SOL_COMPUTED`
  counts as No fix. On this plot and its live readout, **No fix is red** and
  **all other fix types are green**; the separate lanes still distinguish quality.
  Hover a bar for the exact solution status and position type
  (for example `SOL_COMPUTED / FIXEDPOS`).

Both rows come from live BESTPOS logs and are saved with the local history. The
server stores a sample when the solution changes, or at least every 10 seconds
while it is unchanged. A row breaks when no BESTPOS has been received for 35
seconds. Historic archive loading also parses ASCII BESTPOSA and binary BESTPOS
(message ID 42), using their receiver timestamps for these same rows. Local/live
history takes precedence where it overlaps archive data; archived values never
replace the current live readouts. Logs without BESTPOS leave gaps in the fix-type row.
For older logs, ASCII BESTSATSA and binary BESTSATS (message ID 1194) supply a
satellite-count fallback: the number of entries marked `GOOD`, not the total list
length (which also includes excluded satellites). BESTPOS takes precedence wherever
its reporting overlaps BESTSATS, regardless of file or message order. BESTSATS does
not contain fix type or solution status, so fix type is shown as unavailable rather
than inferred; it also does not supply a tracked-satellite count. `SUPPLEMENTARY`
entries are not counted as `GOOD` satellites.

The left-hand side of each row shows the current values: the number of satellites
used (with the number tracked) and the current fix type, coloured by its tier. Both
roll to the new value when it changes and show "—" once BESTPOS is more than 35
seconds old. Y-axis labels are repeated on the right-hand side of the power,
satellite, fix-type and frequency plots.
The GNSS frequency overlays below the band cards use the same visible time
window and time axis as **Power over time**, including its pan and zoom. Drag
**any** plot to pan, or scroll over it to zoom around the pointer. The shared
**View** dropdown, ◀ / ▶ (earlier / later), − / + (zoom) and **⟳ Live** controls work
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
Opaque bright-red vertical markers with white outlines show each
interference detection's center frequency and bandwidth at its report time
(hover for details). All detections in the visible time window are represented,
without a latest-only cutoff. Matching signal, frequency and bandwidth detections
within the same horizontal pixel share a marker; its tooltip includes the count,
time range and strongest detection. Zooming in separates these markers.
The grouped plots are titled **L1 / E1 / B1 / G1**,
**L2 / G2 / B3**, and **L5 / E5 / B2**.

The **View** dropdown jumps straight to a time range that follows live time: the
History window (**Live**), the last 15 min, 1 h, 6 h, 24 h, 3 or 7 days (ranges longer
than the available data are disabled), or the **Whole archive** when one is loaded. It
shows **Custom** after you pan or zoom. Drag the power plot or use ◀ / ▶ to pan. Use − / +
or the mouse wheel to zoom (down to a 10-second window). Navigation is bounded by
the selected History window. Panning or zooming holds a historical view; **⟳
Live** restores the full window and follows incoming reports. Hover a power or
status marker to inspect its band, timestamp and reported power. Clear and
unknown-power reports are identified without inventing a power value. Stored
timestamps and receiver data are unchanged. Usage notes are folded under **How to
use these plots** to keep the plots near the top of the page.

To pick out a data point, select **↖ Select point**. While it is on (highlighted
violet), the cursor is an arrow, dragging no longer pans, and clicking any plot pins the
nearest data point (power, status, satellites, fix type or frequency marker, within
about 14 px): a ring marks it, a dashed violet time cursor is drawn across all linked
plots, and its details are shown above the plot. Clicking empty space or **Clear**
removes the selection. Press **Esc** or the button again to return to panning; the
pinned selection stays until cleared. Mouse-wheel zoom works in both modes.

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
Spectrum detections are assigned by measured centre frequency and bandwidth, not
solely by the receiver's RF-path label. For example, an `L2`-labelled detection
near 1207 MHz affects **L5 / E5 / B2**, including BeiDou B2I/B2b. A detection
spanning a band boundary appears in every affected band. Cards, power timelines
and live-history statistics use these same rules; detections without a measured
frequency fall back to their signal label. Stored receiver labels are unchanged.
The cards show the latest live report, whereas the frequency plots can also show
earlier or archived detections; a later clear report does not erase those past hits.

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

### Wall display (large screens)

**⛶ Wall display** (top right) turns the Interference tab into a single, full-screen view
for a large TV, readable from across a room. It shows the overall interference banner, the
live L1/L2/L5 power-over-time plot, and the L1/L2/L5 band summaries stacked beside their
plot rows. Other bands (L6, SBAS, …) appear only while they have detections.

- To open it directly on the TV browser, bookmark `http://<server>:8080/?wall=1`
  (press F11 for full screen when opening from a bookmark). The button removes the
  parameter and returns to the normal page; Esc does not exit wall mode.
- Text scales with spare width and is capped by screen height, so a 1080-tall wall stays about 22 px at 1920 and about 24 px at 2560 or 3840 rather than growing to 40 px and pushing the plots off the screen. The satellite table and band pills stay at 1.1 rem. History and Exit wall display stay hidden until the mouse moves. The antenna warning is one line in the banner, and the main-view status pills are not repeated on the wall.
- The plot opens on the live view (the same as **View → Live**), following current time
  over the history window, including any loaded archive.
- The banner shows seconds since the last status update and the status-message counter,
  even when every report is clear. Freshness is checked every second on every tab.
  After more than 5 seconds without a fresh valid ITDETECTSTATUS report, the green
  verdict is replaced by a device error and the band cards stop claiming to be clear.
  A detection is held red for `INTERFERENCE_HOLD_SEC` (default 30 s) so a clear report
  between bursts does not flip the banner. After the hold, hits in the last 5 minutes
  show as intermittent. A manual Disconnect says monitoring was stopped, which is
  separate from a receiver fault. A known receiver or live-server disconnection still
  shows an error. Fresh reports restore the live verdict.
- The wall banner includes one position tile (RTK fixed, degraded, or stale). The big
  satellites-used and fix-type plot rows stay hidden, as do the frequency plots,
  connection settings, archive panel, navigation controls and the recent changes list.
- **Satellites tracked** (under the power plot) is per constellation, plus a total tracked
  line and a dashed total in view. It is filled from `data/history.json`, not only from
  reports since the page opened, including after a heap reload or a stream reconnect.
  Where that series has a gap, archived BESTPOS draws the total tracked line. BESTPOS
  does not say which constellation, so those lines stay blank across the gap.
- The mouse pointer hides after 4 s without movement. The browser is asked to keep the
  screen awake; this needs HTTPS or `localhost`, so over plain HTTP on the LAN also turn
  off the TV/PC sleep timer.

## Historic Archive

The **Historic archive** panel at the top of the Interference tab loads ITDETECTSTATUS and BESTPOS history
from the receiver's recorded `.LOG` files on the network store and draws it on the same
power and frequency plots as live data. The default folder is
`\\20.20.20.1\novatel\pwrpak1`; change it in the panel (it is remembered on the server)
or set `NOVATEL_ARCHIVE_ROOT`. **Default folder** restores the configured default.

The panel is collapsed to a single line by default so the plots stay near the top: it
shows the status badge, the loaded time range, auto-refresh and progress while loading,
and a **Show on plots** tickbox. Select the line (or **Settings**) to expand the folder,
days and load controls; the browser remembers whether it was left open.

Expected layout: `<folder>\YYYY\DDD\*.LOG`, where `DDD` is the day of year, for example
`\\20.20.20.1\novatel\pwrpak1\2026\275\NMUT23450006R_2026-10-02_00-43-27.LOG`. Both
recording formats are read: binary `ITDETECTSTATUSB` (message 2065) and `BESTPOSB`
(message 42), binary BESTSATS (message 1194), plus ASCII `#ITDETECTSTATUSA`,
`#BESTPOSA` and `#BESTSATSA` lines and abbreviated ASCII `<BESTSATS` / `<BESTPOS` /
`<ITDETECTSTATUS` blocks (as produced by `LOG BESTSATS ONTIME 1`) mixed with binary
logs. Only the primary antenna is used
(`ITDETECTSTATUS_1`, `BESTPOS_1` and `BESTSATS_1` are ignored), times come from each report's GPS header (file and
folder names are only used to choose which files to open), and CRC failures are skipped.

Choose how many days to load (1 to `ARCHIVE_MAX_DAYS`) and select **Load history**.

### Always 24 hours: live + archive combined

Tick **Keep loaded (rolling, auto-refresh)** (on by default, `ARCHIVE_AUTO`) and the server
loads the selected days (default the last 24 h) at start-up and reloads them every
`ARCHIVE_REFRESH_MIN` minutes, so the archive window rolls forward. Hourly NAS files reach
the archive hours late; the newest hours come from live history, which the server keeps for
24 h (`HISTORY_RETENTION_MIN`). Select **History: 24 hours** in the header to see the whole
day: archive data underneath, live data on top.

- A refresh runs in the background: the plots keep showing the previous data until the new
  load completes, then switch over. Only new or changed files are read; the rest come from cache.
- Refreshes never overlap and never interrupt a load you started; they wait for it.
- NAS calls that do not answer within `ARCHIVE_TIMEOUT_SEC` (and file reads that stall for
  six times that, with a minimum of 60 seconds) are abandoned, without waiting for Windows
  to close a stuck network handle. A failed refresh keeps the previous data, shows the reason
  in the panel and retries at the next interval. Network failures during listing or reading
  fail the refresh rather than replacing the previous archive with an incomplete result.
  Neither automatic nor manual retries start new NAS work while an abandoned call or
  closing read is outstanding; cancelling a directory search also stops subsequent work.
  Archive failures are logged separately and do not stop live receiver data or the web server.
- **Unload** also turns automatic loading off. The choice is remembered across restarts.

Safeguards keep the NAS, server and browser responsive:

- Files are streamed one at a time in 1 MB chunks; only ITDETECTSTATUS, BESTPOS and BESTSATS frames are
  decoded and other logs (RANGE, ephemerides, …) are skipped by length.
- Each file is reduced to a compact summary — coverage runs for clear reporting and the
  strongest detection per band per second, plus runs of unchanged BESTPOS solutions —
  cached in `data/archive-cache/`. Older caches are rebuilt on the first reload (for
  example to pick up abbreviated-ASCII BESTSATS). The NAS is
  read once per file (about 40 s and 475 MB per day the first time); reloading or
  extending the range only reads new or changed files, and a cached day reloads in well
  under a second.
- At most `ARCHIVE_MAX_SAMPLES` detection seconds are kept in memory; beyond that, older
  detail is merged into wider time buckets, keeping the strongest report.
- BESTPOS and BESTSATS storage are each capped at `ARCHIVE_MAX_SAMPLES` intervals, including
  during each file scan. At that limit, intervals are reduced into wider buckets,
  showing the latest solution per bucket over continuous reporting only. Query
  responses also keep at most one solution interval per bucket. Short-lived changes
  can be omitted at coarse resolution; zoom in for finer detail where retained.
  No BESTPOS for 35 seconds ends an interval, leaving a gap rather than inventing a fix.
- The browser only requests the visible range at about one point per pixel (at most 4,000
  buckets), so a 30-day view returns tens of kilobytes rather than millions of reports.
- Progress, cache hits, an estimated time remaining and any unreadable files are shown in
  the panel. **Cancel** stops reading and keeps what was already loaded; **Unload** frees it.

Archive data appears as faint green status bars where reports were received (clear unless
marked), hollow power markers joined by dashed lines, and bright-red frequency markers with dashed white outlines.
Live data is drawn on top in the usual style. After loading, the plots show the whole
range while following live time (**View: Whole archive**); zoom and pan work as usual, and **⟳ Live** returns
to the live window. Untick **Show on plots** to hide it without unloading.
Band cards and statistics remain live-only.

## Configuration (environment variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `NOVATEL_TRANSPORT` | `auto` | `auto` tries USB serial first and falls back to TCP if the port cannot be opened or yields no NovAtel log; each reconnect cycle tries serial again first. Use `serial` or `tcp` to force one transport. |
| `NOVATEL_SERIAL_PATH` / `NOVATEL_SERIAL_BAUD` | `COM11` / `9600` | USB serial port and baud rate |
| `NOVATEL_SERIAL_PROBE_MS` | `5000` | In `auto` mode, how long an open serial port may go without a decodable log before falling back to TCP |
| `NOVATEL_HOST` / `NOVATEL_PORT` | `20.20.20.50` / `3001` | Receiver ICOM endpoint (TCP) |
| `CONNECTION_SETTINGS_FILE` | `data/connection-settings.json` | **Apply & reconnect** writes here. On the next start this file overrides the transport variables above, and the server logs which file it used. Set to an empty string to ignore it. |
| `NOVATEL_SEND_LOG_CMD` | `false` | When `true`, sends `UNLOGALL THISPORT` plus its own `LOG ...A` requests on connect. Leave `false` when the receiver is running [profiles/GNSSBASE.txt](profiles/GNSSBASE.txt), which already pushes these logs to ICOM1 — `UNLOGALL THISPORT` would remove them. |
| `NOVATEL_RECONNECT_MS` | `3000` | Reconnect delay |
| `NOVATEL_IDLE_MS` | `30000` | Reconnect serial or TCP if no valid ITDETECTSTATUS logs arrive for this long; TCP also times out when no bytes arrive |
| `WEB_HOST` / `WEB_PORT` | `0.0.0.0` / `8080` | Web UI bind address. `0.0.0.0` accepts connections from other devices. The page has no login. Connect, disconnect, and apply are limited to this PC unless `ALLOW_REMOTE_CONTROL=true`. Set `WEB_HOST=127.0.0.1` to listen on localhost only. |
| `ALLOW_REMOTE_CONTROL` | off | Set to `true` to let a LAN browser change the connection. Default: only `127.0.0.1` and `::1`. |
| `INTERFERENCE_HOLD_SEC` | `30` | Seconds the interference banner stays red after the last detection. `0` follows the latest report only. |
| `MONITOR_RESUME_MIN` | `0` | After Disconnect, start monitoring again after this many minutes. `0` leaves it stopped. |
| `HISTORY_SIZE` / `RAW_LOG_SIZE` | `50` / `200` | Replay buffers sent to a newly opened browser |
| `HISTORY_RETENTION_MIN` | `1440` | How far back skyplot traces and the interference timeline are kept. This is the longest window a browser can select. |
| `TRACK_SAMPLE_SEC` | `20` | Minimum spacing between skyplot trace samples per satellite |
| `MAX_IT_SAMPLES` | `100000` | Hard cap on stored interference samples (about 24 h at typical report rates) |
| `HISTORY_FILE` | `data/history.json` | Where history is persisted. Set to an empty string for memory-only. |
| `HISTORY_SAVE_SEC` | `300` | How often a changed history is written. Unchanged history is not rewritten. Shutdown still flushes. |
| `BESTSATS_LOG_SEC` | `1` | `LOG BESTSATSA ONTIME` period sent on connect. Does not change baud or the receiver's saved configuration. |
| `TRACKSTAT_LOG_SEC` | `5` | `LOG TRACKSTATA ONTIME` period sent on connect. Same constraint as `BESTSATS_LOG_SEC`. |
| `NOVATEL_LEAP_SECONDS` | `18` | GPS-UTC offset used when converting GPS time. No log this app already decodes carries the offset. |
| `UV_THREADPOOL_SIZE` | `16` via `src/start.js` | Libuv worker threads. Set before the process starts if you launch `src/server.js` directly. |
| `NOVATEL_ARCHIVE_ROOT` | `\\20.20.20.1\novatel\pwrpak1` | Default historic archive folder (`YYYY\DDD\*.LOG`). The folder chosen in the UI is saved in `data/archive-settings.json` and takes precedence. |
| `ARCHIVE_DAYS` / `ARCHIVE_MAX_DAYS` | `1` / `31` | Default and maximum number of days the UI may load |
| `ARCHIVE_MAX_SAMPLES` | `300000` | Separate memory caps for detection seconds, BESTPOS intervals and BESTSATS count intervals before their resolution is coarsened |
| `ARCHIVE_CACHE_DIR` | `data/archive-cache` | Per-file summary cache. Set to an empty string to re-read the NAS every time. |
| `ARCHIVE_SETTINGS_FILE` | `data/archive-settings.json` | Where the chosen folder, days and Keep-loaded choice are remembered. Empty string disables saving. |
| `ARCHIVE_AUTO` | `true` | Default for **Keep loaded** when no choice has been saved; `false` disables automatic loading |
| `ARCHIVE_REFRESH_MIN` | `15` | Minutes between automatic background refreshes |
| `ARCHIVE_TIMEOUT_SEC` | `20` | NAS calls slower than this are abandoned (stalled reads after 6×, minimum 60 s). A handle that never closes is released after three times the 10 minute reset so a later scan can start. The stuck read itself is not cancelled. |

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

Run `npm test` for the memory-bound, update-batching, archive-outage and live-status
freshness regression checks.

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
- [src/start.js](src/start.js) — sets `UV_THREADPOOL_SIZE`, then loads the server
- [src/server.js](src/server.js) — state store, Server-Sent Events, `/api/snapshot`, `/api/archive/*`
- [src/loglimit.js](src/loglimit.js) — first line, then a once-per-minute count for repeated logs
- [src/archive.js](src/archive.js) — historic `.LOG` scanner, per-file cache and archive queries
- [public/](public/) — browser UI

## Notes on decoding

- `ITDETECTSTATUS` detection block size varies by OEM7 firmware, so it is derived at
  runtime and values are classified heuristically; raw fields are always shown.
- Binary `ITDETECTSTATUSB` (message 2065) is decoded into the same shape: RF path
  (2 = L1, 3 = L2, 5 = L5), detection type, and for spectrum analysis the centre
  frequency, bandwidth and power.
- Binary logs have dedicated decoders for BESTPOS, BESTGNSSPOS, RANGE, RXSTATUS and ITDETECTSTATUS.
  Other binary logs are framed, named and CRC-checked but their bodies are not expanded —
  request the ASCII form (the default) for full field detail.
