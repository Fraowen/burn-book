# Design decisions

## Require human review of YouTube matches

Search ranking is not proof that a result is the desired studio recording. The app presents three candidates and makes the user responsible for the final match.

## Separate downloading from burning

A Spotify playlist describes intent; an exported folder contains the real media. Burning operates on the exported MP3s so it can validate exactly what will be written to the disc.

## Use native command-line tools behind Electron

`yt-dlp`, `ffmpeg`, `ffprobe`, and macOS `drutil` already solve specialized media tasks. Electron coordinates them and provides a friendly interface instead of reimplementing codecs, network extractors, or optical-disc drivers.

## Number output filenames

`drutil` burns directory audio files in alphabetical order. A two-digit numeric prefix makes the playlist order explicit and stable in Finder and on the disc.

## Recheck before irreversible actions

The renderer disables unsafe actions for usability, but renderer state can become stale. The main process therefore checks the drive, disc, and folder again immediately before burning.

The first hardware test revealed that `drutil` may return without a failing exit status even though DiscRecording reports a disconnected drive. Success is now based on the macOS burn log's final state, not merely the child process exit code.

## Keep the first burn implementation conservative

The first version supports Audio CD, speed, pregap, and ejection. Volume normalization and CD Text are separate features because they require audio preprocessing or lower-level DiscRecording APIs and deserve independent testing.
