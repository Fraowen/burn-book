# CD Maker architecture

This document is a map for reading and explaining the application. Follow one user action from the interface to the operating system rather than trying to memorize every line.

## Process boundary

Electron runs two important processes:

- The **renderer** (`src/App.tsx`) draws the React interface and stores temporary UI state.
- The **main process** (`electron/main.ts`) is allowed to access files, launch trusted commands, open native dialogs, and call Spotify.
- The **preload bridge** (`electron/preload.ts`) exposes Electron IPC to the renderer. IPC means inter-process communication.

The renderer does not run shell commands directly. A button calls `window.ipcRenderer.invoke(channel, payload)`. The main process owns a matching `ipcMain.handle(channel, handler)` and returns a result.

## End-to-end data flow

1. `login-with-spotify` opens Spotify OAuth and stores the short-lived access token in memory.
2. `get-spotify-playlist` requests playlist metadata and follows pagination until all tracks are loaded.
3. `find-youtube-matches` asks `yt-dlp` for three search results per track.
4. The user previews and selects a result. This human review prevents an automatic fuzzy match from silently choosing the wrong recording.
5. `download-approved-tracks` asks `yt-dlp` to download audio and `ffmpeg` to create MP3 files with metadata and cover art.
6. `inspect-burn-folder` reads the actual exported MP3 files. `ffprobe` measures their real durations, while macOS `drutil` reports burner and disc status.
7. `burn-audio-cd` rechecks the irreversible-operation preconditions and then asks `drutil` to create a Red Book Audio CD.

## Important safety boundaries

- User-controlled URLs are previewed only if they point to YouTube.
- Commands use `execFile` with argument arrays, not a shell command string. This prevents filenames from being interpreted as shell code.
- Filenames are sanitized before being joined to an output directory.
- A failed download removes temporary artwork and writes a readable error report.
- A successful retry removes the stale error report.
- Burning requires a detected drive, writable media, a playlist under 80 minutes, a confirmation checkbox, and a final native confirmation dialog.
- `drutil` can exit without a failing process code even when the drive disconnects mid-burn. The app therefore reads the new section of macOS's `DiscRecording.log` and requires `Burn finished` rather than trusting the exit code alone.

## Good code-reading exercises

1. Trace `handleDownload` in `App.tsx` to `download-approved-tracks` in `main.ts`.
2. Change the default gap from two seconds to one second and explain which state value changes.
3. Find the two separate checks for a connected burner and explain why the main process checks again.
4. Explain why burn capacity uses `ffprobe` results instead of Spotify durations.
5. Restart the app, choose an existing folder in step 4, and explain why this path does not require Spotify or YouTube.
