# gifa-mod

Personal modifications to **原神跟跑助手 / GI-Follow-Assist (GIFA) v0.2.5** by FinalLawer
(upstream: <https://github.com/FinalLawer/GIFA>, release commit `bc89ba0dfb5d41531bafc9e9606a7d6196205909`).
Licensed GPL-3.0-only like upstream — see `LICENSE` and `NOTICE`.

The first commit is the untouched v0.2.5 app source (as shipped in the release's `app.asar`);
everything after it is a modification, so `git diff <first commit>` shows exactly what changed.

## What this mod adds

| Feature | Where | Hotkey |
|---|---|---|
| **In-game subtitles** — the video's CC / AI subtitles in a separate transparent, click-through, always-on-top window; drag / resize / wheel-zoom in adjust mode; position, size, font and background remembered | Launcher → 浮窗 → 游戏内字幕 | Alt+C show/hide · Alt+V adjust/lock |
| **Subtitle sources** — tracks are captured inside the logged-in Bilibili page (player's own `player/v2` responses, the newer protobuf `x/v2/subtitle/web/view` endpoint, or an active request with page cookies); main-process WBI-signed API as fallback; **live mode** mirrors the player's own on-screen CC line when no downloadable track exists | `src/webview-preload.js`, `src/subtitle-source.js` | |
| **Auto-pause on 「过完剧情」** — when a subtitle line containing a keyword finishes, the video pauses; configurable keywords (`*` = up to 6 chars in between, punctuation ignored) | Launcher → 浮窗 → 游戏内字幕 | resume with 播放/暂停 (Alt+Space) |
| **Full-screen danmaku** — Bilibili-style scrolling / top / bottom comments over the whole primary screen, synced to the video clock, collision-free lanes, click-through; **skips the minimap area** (follows the 方位标定 ring position) | Launcher → 浮窗 → 全屏弹幕 | Alt+D |

| **Uploader position dot** — matches the video's minimap against *your* in-game minimap and draws a gold dot (with a dashed line from you) where the uploader stands; only appears while you're near their route | Launcher → 方位标定 → 显示博主的位置点 (needs the direction arrow on and the red ring placed on your minimap) | |

### How the position dot works

The video's minimap and your minimap are both north-up, so they differ only by zoom and shift.
- **Video side** (`src/webview-preload.js`): ~4×/s, a 128×128 grayscale patch of the video minimap (the region the
  direction tracker confirmed), with icon-like pixels (saturated colours, pure white) flagged.
- **Game side** (`src/screen-grab.js`, `src/overlay/*`): the main process captures a small square around your minimap
  (where the red ring sits) with GDI `BitBlt` via a long-running PowerShell helper (~20 ms per 500×500 grab).
  Chromium's own capture (`getDisplayMedia` / desktop `getUserMedia`) failed with `NotReadableError` on a hybrid-GPU
  laptop running elevated, GDI doesn't depend on that path. While this is on, all GIFA windows are marked
  *excluded from capture* (Windows `WDA_EXCLUDEFROMCAPTURE`), so the ring / danmaku / subtitles never pollute it —
  side effect: they also don't appear in your own screenshots or recordings.
- **Matching** (`src/overlay/locate-core.js`, in a Web Worker): Sobel edge images, ring window with the player-arrow
  centre and icons removed, then **masked normalized cross-correlation** (Padfield, FFT-based) over all shifts.
  The zoom ratio is unknown (uploaders often show an enlarged map overlay), so it's searched coarse-to-fine over
  0.6×–1.65×; a frame is trusted only if NCC ≥ 0.50, the peak beats any other candidate ≥ 0.25 radius away by
  ≥ 0.20, and ≥4 of 5 neighbouring ratios agree on the on-screen position (calibrated on real screenshots: real
  true matches score only ~0.55 NCC — compression, the uploader's map style and the semi-transparent in-game
  minimap — so uniqueness and cross-ratio agreement carry the decision, not raw NCC). The ratio is locked only
  after 5 consistent trusted frames, then saved per video.
- Tested on a synthetic map (`tests/test-locate.js`): 0 dots in the wrong place, 0 false dots off-route; with a saved
  ratio the dot shows on ~84% of on-route frames. Weak spots: featureless terrain (sea, desert, plain grass) → no dot.

New files: `src/subtitle-source.js`, `src/subtitle/*`, `src/danmaku/*`, `src/overlay/locate-core.js`, `src/overlay/locate-worker.js`.
Modified: `src/main.js`, `src/preload.js`, `src/webview-preload.js`, `src/renderer/app.js`, `src/console/*`, `src/overlay/*`.

## Install into an existing GIFA (zip / portable build)

GIFA ships as Electron with the app in `resources\app.asar`. This repo is patched into that archive
(Electron's asar-integrity fuse is off in GIFA 0.2.5, so a patched archive loads normally).

1. Quit GIFA completely (close the launcher).
2. Run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File tools\install.ps1 -Gifa "C:\path\to\GIFA"
   ```
   The first run backs up the original as `resources\app.asar.bak`; every build starts from that backup.
3. Undo any time: copy `resources\app.asar.bak` over `resources\app.asar`.

No Node.js install is needed: the scripts run on GIFA.exe's bundled Node (`ELECTRON_RUN_AS_NODE=1`).

## Tests

```powershell
$env:ELECTRON_RUN_AS_NODE='1'; $env:__COMPAT_LAYER='RunAsInvoker'
& "C:\path\to\GIFA\GIFA.exe" tests\test-subtitle.js
& "C:\path\to\GIFA\GIFA.exe" tests\test-locate.js
```

Covers: syntax of every source file, subtitle cue lookup / track choice, WBI signing (official test vector),
protobuf track extraction, auto-pause keyword matching and "line just finished" detection,
danmaku XML parsing, and a headless simulation of the danmaku renderer (lanes, pause, seek, map mask).

## Never commit

`data\` in a GIFA folder holds Bilibili login cookies and watch history — `.gitignore` excludes it,
along with binaries and `.asar` files.
