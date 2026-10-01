import { useMemo, useState } from 'react'
import './App.css'

type Track = {
  title: string
  artist: string
  duration: string
}

type VideoCandidate = {
  id: string
  title: string
  uploader: string
  duration: string
  url: string
  thumbnail?: string
}

type Match = {
  track: Track
  candidates: VideoCandidate[]
  selectedUrl: string
}

type DownloadResult = {
  success: boolean
  playlistFolderPath: string
  downloaded: number
  failures: { track: string; error: string }[]
}

type BurnInspection = {
  playlistFolderPath: string
  files: { name: string; path: string; durationSeconds: number }[]
  totalSeconds: number
  capacitySeconds: number
  fitsAudioCd: boolean
  driveDetected: boolean
  driveDescriptions: string[]
  mediaStatus: string
  discReady: boolean
}

function App() {
  const [outputFolder, setOutputFolder] = useState('')
  const [message, setMessage] = useState('Paste a Spotify playlist to begin.')
  const [spotifyLink, setSpotifyLink] = useState('')
  const [playlistName, setPlaylistName] = useState('')
  const [tracks, setTracks] = useState<Track[]>([])
  const [matches, setMatches] = useState<Match[]>([])
  const [busy, setBusy] = useState(false)
  const [rightsConfirmed, setRightsConfirmed] = useState(false)
  const [exportedFolder, setExportedFolder] = useState('')
  const [burnInspection, setBurnInspection] = useState<BurnInspection | null>(null)
  const [burnSpeed, setBurnSpeed] = useState('8')
  const [gapSeconds, setGapSeconds] = useState('2')
  const [ejectAfter, setEjectAfter] = useState(true)
  const [burnConfirmed, setBurnConfirmed] = useState(false)
  const [discFlipped, setDiscFlipped] = useState(false)

  const approvedCount = useMemo(
    () => matches.filter((match) => match.selectedUrl).length,
    [matches],
  )

  function getPlaylistId(value: string) {
    const uriMatch = value.match(/^spotify:playlist:([\w-]+)/)
    if (uriMatch) return uriMatch[1]

    const urlMatch = value.match(/playlist\/([^?/#]+)/)
    return urlMatch?.[1] ?? ''
  }

  async function handleSpotifyLogin() {
    setBusy(true)
    setMessage('Opening Spotify login…')
    try {
      await window.ipcRenderer.invoke('login-with-spotify')
      setMessage('Spotify connected. You can scan your playlist now.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Spotify login failed.')
    } finally {
      setBusy(false)
    }
  }

  async function handleScanPlaylist() {
    const playlistId = getPlaylistId(spotifyLink.trim())
    if (!playlistId) {
      setMessage('That does not look like a Spotify playlist link.')
      return
    }

    setBusy(true)
    setMatches([])
    setMessage('Fetching playlist from Spotify…')
    try {
      const playlistData = await window.ipcRenderer.invoke('get-spotify-playlist', playlistId)
      setPlaylistName(playlistData.name)
      setTracks(playlistData.tracks)
      setMessage(`Loaded ${playlistData.tracks.length} tracks from “${playlistData.name}”.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not fetch that playlist.')
    } finally {
      setBusy(false)
    }
  }

  async function handleFindMatches() {
    if (!tracks.length) return
    setBusy(true)
    setMessage(`Searching YouTube for ${tracks.length} tracks… this can take a minute.`)
    try {
      const found: Match[] = await window.ipcRenderer.invoke('find-youtube-matches', tracks)
      setMatches(found)
      setMessage('Matches ready. Review each selection before downloading.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'YouTube matching failed.')
    } finally {
      setBusy(false)
    }
  }

  async function handlePickFolder() {
    const folder = await window.ipcRenderer.invoke('pick-output-folder')
    if (folder) setOutputFolder(folder)
  }

  function selectCandidate(trackIndex: number, url: string) {
    setMatches((current) => current.map((match, index) => (
      index === trackIndex ? { ...match, selectedUrl: url } : match
    )))
  }

  async function handleDownload() {
    if (!outputFolder) {
      setMessage('Choose an output folder first.')
      return
    }
    if (!rightsConfirmed) {
      setMessage('Please confirm you have permission to download this audio.')
      return
    }
    setBusy(true)
    setMessage(`Downloading and converting ${approvedCount} tracks… keep the app open.`)
    try {
      const result: DownloadResult = await window.ipcRenderer.invoke('download-approved-tracks', {
        outputFolder,
        playlistName,
        matches,
      })
      setExportedFolder(result.playlistFolderPath)
      setBurnConfirmed(false)
      const inspection = await window.ipcRenderer.invoke('inspect-burn-folder', result.playlistFolderPath)
      setBurnInspection(inspection)
      const suffix = result.failures.length
        ? ` ${result.failures.length} failed; see download-errors.txt in the folder.`
        : ''
      setMessage(`Finished ${result.downloaded} tracks in ${result.playlistFolderPath}.${suffix}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Download failed.')
    } finally {
      setBusy(false)
    }
  }

  function formatDuration(seconds: number) {
    const rounded = Math.ceil(seconds)
    const hours = Math.floor(rounded / 3600)
    const minutes = Math.floor((rounded % 3600) / 60)
    const remainingSeconds = rounded % 60
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainingSeconds).padStart(2, '0')}`
      : `${minutes}:${String(remainingSeconds).padStart(2, '0')}`
  }

  async function handleRefreshBurnStatus() {
    if (!exportedFolder) return
    setBusy(true)
    setMessage('Checking MP3 files, burner, and inserted disc…')
    try {
      const inspection = await window.ipcRenderer.invoke('inspect-burn-folder', exportedFolder)
      setBurnInspection(inspection)
      setMessage(inspection.driveDetected
        ? 'Burner detected. Review the settings and disc status.'
        : 'Your MP3 folder is ready. Connect a compatible CD burner to continue.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not inspect the burn folder.')
    } finally {
      setBusy(false)
    }
  }

  async function handlePickBurnFolder() {
    const folder = await window.ipcRenderer.invoke('pick-burn-folder')
    if (!folder) return
    setExportedFolder(folder)
    setBurnConfirmed(false)
    setBusy(true)
    setMessage('Inspecting the selected MP3 folder…')
    try {
      const inspection = await window.ipcRenderer.invoke('inspect-burn-folder', folder)
      setBurnInspection(inspection)
      setMessage(inspection.files.length
        ? `Found ${inspection.files.length} MP3 tracks ready for burn review.`
        : 'No MP3 files were found in that folder.')
    } catch (error) {
      setBurnInspection(null)
      setMessage(error instanceof Error ? error.message : 'Could not inspect that folder.')
    } finally {
      setBusy(false)
    }
  }

  async function handleBurnDisc() {
    if (!burnInspection || !burnConfirmed) return
    const accepted = window.confirm(
      `Burn ${burnInspection.files.length} tracks as an Audio CD? Once writing starts, a CD-R cannot be reused.`,
    )
    if (!accepted) return

    setBusy(true)
    setMessage('Burning the Audio CD… do not disconnect the drive.')
    try {
      await window.ipcRenderer.invoke('burn-audio-cd', {
        playlistFolderPath: burnInspection.playlistFolderPath,
        speed: burnSpeed,
        gapSeconds,
        ejectAfter,
        confirmed: true,
      })
      setMessage('Disc burn completed successfully.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Disc burning failed.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="app">
      <section className="card">
        <header className="masthead">
          <div className="title-block">
            <p className="eyebrow">JENNY'S LITTLE DISC FACTORY // MACOS</p>
            <h1>Burn Book</h1>
            <p className="subtitle">Turn a playlist into something you can hold.</p>
            <div className="utility-strip" aria-label="Workflow summary">
              <span>01 IMPORT</span><span>02 CHECK</span><span>03 EXPORT</span><span>04 BURN</span>
            </div>
          </div>
          <button
            type="button"
            className="disc-shell"
            aria-label={`Flip disc to side ${discFlipped ? 'A' : 'B'}`}
            aria-pressed={discFlipped}
            onClick={() => setDiscFlipped((current) => !current)}
          >
            <span className={`disc-spinner ${busy ? 'working' : ''}`}>
              <span className={`disc-card ${discFlipped ? 'flipped' : ''}`}>
                <span className="disc-face disc-front">
                  <svg className="disc-lettering" viewBox="0 0 174 174" aria-hidden="true">
                    <defs>
                      <path id="side-a-top" d="M 20 92 A 67 67 0 0 1 154 92" />
                      <path id="side-a-bottom" d="M 42 108 A 50 50 0 0 0 132 108" />
                    </defs>
                    <text className="disc-title"><textPath href="#side-a-top" startOffset="50%">BURN BOOK</textPath></text>
                    <text className="disc-detail"><textPath href="#side-a-bottom" startOffset="50%">SIDE A • MIX IT YOURSELF</textPath></text>
                  </svg>
                  <span className="disc-hole" />
                </span>
                <span className="disc-face disc-back">
                  <svg className="disc-lettering" viewBox="0 0 174 174" aria-hidden="true">
                    <defs>
                      <path id="side-b-top" d="M 20 92 A 67 67 0 0 1 154 92" />
                      <path id="side-b-bottom" d="M 41 110 A 52 52 0 0 0 133 110" />
                    </defs>
                    <text className="disc-title disc-title-small"><textPath href="#side-b-top" startOffset="50%">JENNY'S DISC FACTORY</textPath></text>
                    <text className="disc-detail"><textPath href="#side-b-bottom" startOffset="50%">SIDE B • 80 MIN • 2026</textPath></text>
                  </svg>
                  <span className="disc-hole" />
                </span>
              </span>
            </span>
          </button>
        </header>

        {(busy || message !== 'Paste a Spotify playlist to begin.') && (
          <p className="status" role="status">{busy && <span className="spinner" />} {message}</p>
        )}

        <div className="step">
          <div className="step-heading"><span>01</span><h2>Load playlist</h2><small>SPOTIFY → TRACK LIST</small></div>
          <label htmlFor="playlist">Spotify playlist link</label>
          <input
            id="playlist"
            type="text"
            placeholder="https://open.spotify.com/playlist/…"
            value={spotifyLink}
            onChange={(event) => setSpotifyLink(event.target.value)}
          />
          <div className="button-row">
            <button className="secondary" onClick={handleSpotifyLogin} disabled={busy}>Connect Spotify</button>
            <button onClick={handleScanPlaylist} disabled={busy || !spotifyLink}>Scan playlist</button>
          </div>
          {tracks.length > 0 && (
            <p className="summary"><strong>{playlistName}</strong> · {tracks.length} tracks</p>
          )}
        </div>

        <div className="step">
          <div className="step-heading"><span>02</span><h2>Review matches</h2><small>YOU PICK THE RIGHT ONE</small></div>
          <button onClick={handleFindMatches} disabled={busy || !tracks.length}>
            {matches.length ? 'Search again' : 'Find YouTube matches'}
          </button>

          {matches.length > 0 && (
            <div className="matches">
              {matches.map((match, trackIndex) => (
                <article className="match" key={`${match.track.title}-${trackIndex}`}>
                  <h3>{trackIndex + 1}. {match.track.title}</h3>
                  <p>{match.track.artist} · {match.track.duration}</p>
                  <div className="candidates">
                    {match.candidates.map((candidate) => (
                      <label className={`candidate ${match.selectedUrl === candidate.url ? 'selected' : ''}`} key={candidate.id}>
                        <input
                          type="radio"
                          name={`track-${trackIndex}`}
                          checked={match.selectedUrl === candidate.url}
                          onChange={() => selectCandidate(trackIndex, candidate.url)}
                        />
                        {candidate.thumbnail && <img src={candidate.thumbnail} alt="" />}
                        <span>
                          <strong>{candidate.title}</strong>
                          <small>{candidate.uploader} · {candidate.duration}</small>
                        </span>
                        <button type="button" className="link-button" onClick={(event) => {
                          event.preventDefault()
                          window.ipcRenderer.invoke('open-external', candidate.url)
                        }}>Preview</button>
                      </label>
                    ))}
                    <label className={`candidate skip ${match.selectedUrl === '' ? 'selected' : ''}`}>
                      <input
                        type="radio"
                        name={`track-${trackIndex}`}
                        checked={match.selectedUrl === ''}
                        onChange={() => selectCandidate(trackIndex, '')}
                      />
                      <span><strong>Skip this track</strong></span>
                    </label>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>

        <div className="step">
          <div className="step-heading"><span>03</span><h2>Export MP3 folder</h2><small>NEATLY NUMBERED + TAGGED</small></div>
          <button className="secondary" onClick={handlePickFolder} disabled={busy}>Choose output folder</button>
          {outputFolder && <p className="path">{outputFolder}</p>}
          <label className="confirmation">
            <input
              type="checkbox"
              checked={rightsConfirmed}
              onChange={(event) => setRightsConfirmed(event.target.checked)}
            />
            <span>I own this audio or have permission to download it.</span>
          </label>
          <button onClick={handleDownload} disabled={busy || !matches.length || !outputFolder || !rightsConfirmed}>
        Download {approvedCount || ''} approved MP3{approvedCount === 1 ? '' : 's'}
          </button>
        </div>

        <div className="step">
          <div className="step-heading"><span>04</span><h2>Burn Audio CD</h2><small>THE FINAL BOSS</small></div>
          <button className="secondary" onClick={handlePickBurnFolder} disabled={busy}>
            Choose existing MP3 folder
          </button>
          {!exportedFolder ? (
            <p className="muted">Export a complete MP3 folder above, or choose one you already created.</p>
          ) : (
            <>
              <div className="button-row">
                <button className="secondary" onClick={handleRefreshBurnStatus} disabled={busy}>
                  Refresh burner status
                </button>
              </div>

              {burnInspection && (
                <div className="burn-panel">
                  <div className="capacity-header">
                    <strong>{burnInspection.files.length} tracks</strong>
                    <span>{formatDuration(burnInspection.totalSeconds)} / 80:00</span>
                  </div>
                  <div className="capacity-bar" aria-label="Audio CD capacity">
                    <span
                      className={burnInspection.fitsAudioCd ? '' : 'over'}
                      style={{ width: `${Math.min(100, (burnInspection.totalSeconds / burnInspection.capacitySeconds) * 100)}%` }}
                    />
                  </div>
                  <p className={`readiness ${burnInspection.fitsAudioCd ? 'ready' : 'blocked'}`}>
                    {burnInspection.fitsAudioCd ? '✓ Playlist fits on an 80-minute Audio CD' : 'Playlist is too long for one Audio CD'}
                  </p>

                  <ol className="burn-tracks">
                    {burnInspection.files.map((file) => (
                      <li key={file.path}>
                        <span>{file.name.replace(/\.mp3$/i, '')}</span>
                        <small>{formatDuration(file.durationSeconds)}</small>
                      </li>
                    ))}
                  </ol>

                  <div className="drive-status">
                    <strong>{burnInspection.driveDetected ? '✓ Burner detected' : '○ No burner detected'}</strong>
                    {burnInspection.driveDescriptions.map((drive) => <small key={drive}>{drive}</small>)}
                    {burnInspection.driveDetected && (
                      <strong>{burnInspection.discReady ? '✓ Writable disc detected' : '○ Insert a blank writable disc'}</strong>
                    )}
                    {burnInspection.mediaStatus && <pre>{burnInspection.mediaStatus}</pre>}
                  </div>

                  <div className="burn-settings">
                    <label>
                      Burn speed
                      <select value={burnSpeed} onChange={(event) => setBurnSpeed(event.target.value)}>
                        <option value="4">4×</option>
                        <option value="8">8×</option>
                        <option value="16">16×</option>
                        <option value="MAX">Maximum</option>
                      </select>
                    </label>
                    <label>
                      Pause between tracks
                      <select value={gapSeconds} onChange={(event) => setGapSeconds(event.target.value)}>
                        <option value="0">No pause</option>
                        <option value="1">1 second</option>
                        <option value="2">2 seconds</option>
                        <option value="3">3 seconds</option>
                        <option value="5">5 seconds</option>
                      </select>
                    </label>
                  </div>

                  <label className="confirmation">
                    <input type="checkbox" checked={ejectAfter} onChange={(event) => setEjectAfter(event.target.checked)} />
                    <span>Eject the disc after burning</span>
                  </label>
                  <label className="confirmation warning-confirmation">
                    <input type="checkbox" checked={burnConfirmed} onChange={(event) => setBurnConfirmed(event.target.checked)} />
                    <span>I reviewed the track order and understand a CD-R cannot be reused after writing begins.</span>
                  </label>
                  <button
                    className="burn-button"
                    onClick={handleBurnDisc}
                    disabled={busy || !burnInspection.driveDetected || !burnInspection.discReady || !burnInspection.fitsAudioCd || !burnInspection.files.length || !burnConfirmed}
                  >
                    Burn Audio CD
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </main>
  )
}

export default App
