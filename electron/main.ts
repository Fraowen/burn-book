/* eslint-disable @typescript-eslint/no-explicit-any */
import 'dotenv/config'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import http from 'node:http'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const YT_DLP_LOCATIONS = ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp', 'yt-dlp']
const FFPROBE_LOCATIONS = ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', 'ffprobe']
let spotifyAccessToken = ''

process.env.APP_ROOT = path.join(__dirname, '..')
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')
process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

let win: BrowserWindow | null

function createWindow() {
  win = new BrowserWindow({
    width: 1040,
    height: 820,
    minWidth: 720,
    minHeight: 640,
    icon: path.join(process.env.VITE_PUBLIC, 'electron-vite.svg'),
    webPreferences: { preload: path.join(__dirname, 'preload.mjs') },
  })

  if (VITE_DEV_SERVER_URL) win.loadURL(VITE_DEV_SERVER_URL)
  else win.loadFile(path.join(RENDERER_DIST, 'index.html'))
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

function msToMinutes(ms: number) {
  const totalSeconds = Math.floor(ms / 1000)
  return `${Math.floor(totalSeconds / 60)}:${(totalSeconds % 60).toString().padStart(2, '0')}`
}

function secondsToTime(seconds?: number) {
  if (!seconds) return 'Unknown length'
  return `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60).toString().padStart(2, '0')}`
}

function safeName(value: string) {
  // Filesystem-invalid characters, including ASCII control characters.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim() || 'Untitled Playlist'
}

async function runYtDlp(args: string[], options: { maxBuffer?: number } = {}) {
  let lastError: unknown
  for (const executable of YT_DLP_LOCATIONS) {
    try {
      return await execFileAsync(executable, args, {
        maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` },
      })
    } catch (error: any) {
      lastError = error
      if (error?.code !== 'ENOENT') throw error
    }
  }
  throw lastError ?? new Error('yt-dlp is not installed.')
}

async function runFirstAvailable(executables: string[], args: string[]) {
  let lastError: unknown
  for (const executable of executables) {
    try {
      return await execFileAsync(executable, args, {
        maxBuffer: 10 * 1024 * 1024,
        env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ''}` },
      })
    } catch (error: any) {
      lastError = error
      if (error?.code !== 'ENOENT') throw error
    }
  }
  throw lastError ?? new Error(`Required command not found: ${executables.at(-1)}`)
}

async function removeIfPresent(filePath: string) {
  try {
    await fs.unlink(filePath)
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error
  }
}

ipcMain.handle('pick-output-folder', async () => {
  const result = await dialog.showOpenDialog(win!, {
    title: 'Choose where to save your CD folder',
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? '' : result.filePaths[0]
})

ipcMain.handle('pick-burn-folder', async () => {
  const result = await dialog.showOpenDialog(win!, {
    title: 'Choose a playlist folder containing MP3 files',
    properties: ['openDirectory'],
  })
  return result.canceled ? '' : result.filePaths[0]
})

ipcMain.handle('open-external', async (_event, url: string) => {
  if (!/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) return false
  await shell.openExternal(url)
  return true
})

ipcMain.handle('find-youtube-matches', async (_event, tracks: any[]) => {
  const results = []
  for (const track of tracks) {
    const query = `${track.title} ${track.artist} official audio`
    const { stdout } = await runYtDlp([
      '--dump-single-json', '--flat-playlist', '--no-warnings', `ytsearch3:${query}`,
    ])
    const data = JSON.parse(stdout)
    const candidates = (data.entries ?? []).map((entry: any) => ({
      id: entry.id,
      title: entry.title ?? 'Untitled video',
      uploader: entry.channel ?? entry.uploader ?? 'Unknown channel',
      duration: secondsToTime(entry.duration),
      url: entry.url?.startsWith('http') ? entry.url : `https://www.youtube.com/watch?v=${entry.id}`,
      thumbnail: entry.thumbnails?.at(-1)?.url,
    }))
    results.push({ track, candidates, selectedUrl: candidates[0]?.url ?? '' })
  }
  return results
})

ipcMain.handle('download-approved-tracks', async (_event, payload: any) => {
  const libraryFolder = path.basename(payload.outputFolder) === 'CD-Playlists'
    ? payload.outputFolder
    : path.join(payload.outputFolder, 'CD-Playlists')
  const playlistFolderPath = path.join(libraryFolder, safeName(payload.playlistName))
  await fs.mkdir(playlistFolderPath, { recursive: true })

  const approved = payload.matches.filter((match: any) => match.selectedUrl)
  const failures: { track: string; error: string }[] = []
  let downloaded = 0

  for (let index = 0; index < approved.length; index += 1) {
    const match = approved[index]
    const trackNumber = String(index + 1).padStart(2, '0')
    const outputStem = `${trackNumber} - ${safeName(match.track.artist)} - ${safeName(match.track.title)}`
    const outputTemplate = path.join(playlistFolderPath, `${outputStem}.%(ext)s`)
    try {
      await runYtDlp([
        '--no-playlist', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0',
        '--embed-thumbnail', '--convert-thumbnails', 'jpg', '--embed-metadata',
        '--parse-metadata', `${match.track.title}:%(title)s`,
        '--parse-metadata', `${match.track.artist}:%(artist)s`,
        '--output', outputTemplate, match.selectedUrl,
      ], { maxBuffer: 20 * 1024 * 1024 })
      downloaded += 1
    } catch (error: any) {
      for (const extension of ['jpg', 'jpeg', 'png', 'webp', 'part', 'ytdl']) {
        await removeIfPresent(path.join(playlistFolderPath, `${outputStem}.${extension}`))
      }
      failures.push({
        track: `${match.track.title} — ${match.track.artist}`,
        error: error?.stderr?.trim() || error?.message || 'Unknown download error',
      })
    }
  }

  const playlistInfo = [
    `Playlist: ${payload.playlistName}`,
    `Exported: ${new Date().toLocaleString()}`,
    `Tracks downloaded: ${downloaded}`,
    '',
    ...approved.map((match: any, index: number) => (
      `${index + 1}. ${match.track.title}\nArtist: ${match.track.artist}\nSource: ${match.selectedUrl}`
    )),
  ].join('\n\n')
  await fs.writeFile(path.join(playlistFolderPath, 'playlist-info.txt'), playlistInfo, 'utf-8')

  if (failures.length) {
    await fs.writeFile(
      path.join(playlistFolderPath, 'download-errors.txt'),
      failures.map((failure) => `${failure.track}\n${failure.error}`).join('\n\n'),
      'utf-8',
    )
  } else {
    await removeIfPresent(path.join(playlistFolderPath, 'download-errors.txt'))
  }

  await shell.openPath(playlistFolderPath)
  return { success: failures.length === 0, playlistFolderPath, downloaded, failures }
})

ipcMain.handle('inspect-burn-folder', async (_event, playlistFolderPath: string) => {
  const entries = await fs.readdir(playlistFolderPath, { withFileTypes: true })
  const fileNames = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.mp3'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  const files = []
  let totalSeconds = 0
  for (const name of fileNames) {
    const filePath = path.join(playlistFolderPath, name)
    const { stdout } = await runFirstAvailable(FFPROBE_LOCATIONS, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath,
    ])
    const durationSeconds = Number.parseFloat(stdout.trim()) || 0
    totalSeconds += durationSeconds
    files.push({ name, path: filePath, durationSeconds })
  }

  const { stdout: driveOutput } = await execFileAsync('/usr/bin/drutil', ['list'])
  const driveLines = driveOutput.split('\n').map((line) => line.trim()).filter(Boolean)
  const driveDescriptions = driveLines.slice(1)
  let mediaStatus = ''
  if (driveDescriptions.length) {
    try {
      const status = await execFileAsync('/usr/bin/drutil', ['status'])
      mediaStatus = status.stdout.trim()
    } catch (error: any) {
      mediaStatus = error?.stdout?.trim() || error?.stderr?.trim() || 'Drive found; insert a blank disc.'
    }
  }

  return {
    playlistFolderPath,
    files,
    totalSeconds,
    capacitySeconds: 80 * 60,
    fitsAudioCd: totalSeconds <= 80 * 60,
    driveDetected: driveDescriptions.length > 0,
    driveDescriptions,
    mediaStatus,
    discReady: /\b(blank|writable|appendable)\b/i.test(mediaStatus),
  }
})

ipcMain.handle('burn-audio-cd', async (_event, payload: any) => {
  if (!payload.confirmed) throw new Error('Burn confirmation is required.')

  const { stdout: driveOutput } = await execFileAsync('/usr/bin/drutil', ['list'])
  if (driveOutput.split('\n').map((line) => line.trim()).filter(Boolean).length <= 1) {
    throw new Error('No compatible CD burner is connected.')
  }
  const { stdout: mediaStatus } = await execFileAsync('/usr/bin/drutil', ['status'])
  if (!/\b(blank|writable|appendable)\b/i.test(mediaStatus)) {
    throw new Error('A writable blank disc was not detected.')
  }
  const entries = await fs.readdir(payload.playlistFolderPath)
  const mp3Count = entries.filter((name) => name.toLowerCase().endsWith('.mp3')).length
  if (!mp3Count) throw new Error('No MP3 files were found in this folder.')

  const args = ['burn', '-audio', '-speed', String(payload.speed), '-pregap', String(payload.gapSeconds)]
  if (payload.ejectAfter) args.push('-eject')
  args.push(payload.playlistFolderPath)

  const discRecordingLog = path.join(app.getPath('home'), 'Library', 'Logs', 'DiscRecording.log')
  let logBefore = ''
  try {
    logBefore = await fs.readFile(discRecordingLog, 'utf-8')
  } catch {
    // The log is created by macOS after the first DiscRecording operation.
  }

  const { stdout, stderr } = await execFileAsync('/usr/bin/drutil', args, {
    maxBuffer: 10 * 1024 * 1024,
  })
  const commandOutput = `${stdout}\n${stderr}`.trim()

  let newLog = ''
  try {
    const logAfter = await fs.readFile(discRecordingLog, 'utf-8')
    newLog = logAfter.startsWith(logBefore) ? logAfter.slice(logBefore.length) : logAfter
  } catch {
    // Fall back to drutil output when the system log cannot be read.
  }

  const burnEvidence = `${commandOutput}\n${newLog}`
  if (/Burn failed|Burn error|DeviceNotPresent|drive is unavailable/i.test(burnEvidence)) {
    const helpfulLine = burnEvidence
      .split('\n')
      .find((line) => /Burn error|drive is unavailable|DeviceNotPresent/i.test(line))
    throw new Error(helpfulLine?.trim() || 'macOS reported that the disc burn failed.')
  }
  if (newLog && !/Burn finished/i.test(newLog)) {
    throw new Error('The burn command ended without macOS confirming that the disc was finished.')
  }

  return { success: true, output: burnEvidence.trim() }
})

ipcMain.handle('get-spotify-playlist', async (_event, playlistID: string) => {
  if (!spotifyAccessToken) throw new Error('Connect Spotify first.')

  const playlistResponse = await fetch(`https://api.spotify.com/v1/playlists/${playlistID}`, {
    headers: { Authorization: `Bearer ${spotifyAccessToken}` },
  })
  const playlistData: any = await playlistResponse.json()
  if (!playlistResponse.ok) throw new Error(playlistData?.error?.message ?? 'Spotify playlist request failed.')

  const collection = playlistData.tracks ?? playlistData.items
  let items = collection?.items ?? []
  let next = collection?.next

  while (next) {
    const response = await fetch(next, { headers: { Authorization: `Bearer ${spotifyAccessToken}` } })
    const page: any = await response.json()
    if (!response.ok) throw new Error(page?.error?.message ?? 'Could not load the full playlist.')
    items = [...items, ...(page.items ?? [])]
    next = page.next
  }

  const tracks = items
    .map((item: any) => item.track ?? item.item)
    .filter((track: any) => track?.name && track?.artists)
    .map((track: any) => ({
      title: track.name,
      artist: track.artists.map((artist: any) => artist.name).join(', '),
      duration: msToMinutes(track.duration_ms),
    }))

  return { name: playlistData.name, totalTracks: tracks.length, tracks }
})

function waitForSpotifyCode(): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (!req.url) return
      const url = new URL(req.url, 'http://127.0.0.1:8888')
      const code = url.searchParams.get('code')
      const spotifyError = url.searchParams.get('error')

      if (spotifyError) {
        res.writeHead(400, { 'Content-Type': 'text/html' })
        res.end(`<h1>Spotify login failed</h1><p>${spotifyError}</p>`)
        server.close()
        reject(new Error(`Spotify login failed: ${spotifyError}`))
      } else if (code) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end('<h1>Spotify login successful!</h1><p>You can close this window.</p>')
        server.close()
        resolve(code)
      }
    })
    server.listen(8888, '127.0.0.1')
    server.on('error', reject)
  })
}

ipcMain.handle('login-with-spotify', async () => {
  const clientId = process.env.SPOTIFY_CLIENT_ID
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
  if (!clientId || !clientSecret) throw new Error('Spotify credentials are missing from .env.')

  const redirectUri = 'http://127.0.0.1:8888/callback'
  const codePromise = waitForSpotifyCode()
  const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: clientId,
    scope: 'playlist-read-private playlist-read-collaborative', redirect_uri: redirectUri,
  }).toString()
  await shell.openExternal(authUrl)
  const code = await codePromise

  const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }).toString(),
  })
  const tokenData: any = await tokenResponse.json()
  if (!tokenResponse.ok) throw new Error(tokenData?.error_description ?? 'Spotify login failed.')
  spotifyAccessToken = tokenData.access_token
  return { success: true }
})

app.whenReady().then(createWindow)
