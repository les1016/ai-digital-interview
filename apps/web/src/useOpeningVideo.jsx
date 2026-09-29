import { useCallback, useEffect, useRef, useState } from 'react'
import { createAcknowledgmentPlayer } from './acknowledgmentPlayer'
import { openingManifest } from './openingPolicy'

export default function useOpeningVideo({ avatarAudioRef, avatarVideoRef, onEvent, onProgress, coordinator }) {
  const videoRef = useRef(null), playerRef = useRef(null), callbackRef = useRef(onEvent), progressRef = useRef(onProgress)
  const progressSecondRef = useRef(-1)
  const [state, setState] = useState('idle'), [position, setPosition] = useState(0)
  const [outcome, setOutcome] = useState('not-started')
  callbackRef.current = onEvent
  progressRef.current = onProgress
  useEffect(() => {
    const video = videoRef.current
    const player = createAcknowledgmentPlayer({
      video, expectedDuration: openingManifest.duration, startTimeoutMs: 2500,
      coordinator, owner: 'opening', priority: 80,
      playbackTimeoutMs: (openingManifest.duration + 5) * 1000,
      getCompetingMedia: () => [avatarAudioRef.current, avatarVideoRef.current],
      nowHidden: () => document.hidden, onState: setState,
      onEvent: (event, details) => {
        if (event === 'requested') {
          progressSecondRef.current = -1; setPosition(0); setOutcome('loading')
        } else if (event === 'started') setOutcome('playing')
        else { setOutcome(event); setPosition(details.positionSeconds ?? 0) }
        callbackRef.current?.(event, details)
      },
    })
    playerRef.current = player
    const update = () => {
      // finish() resets the media element; retain the last real position for diagnostics.
      if (!player.busy) return
      setPosition(video.currentTime)
      const second = Math.floor(video.currentTime)
      if (second !== progressSecondRef.current) {
        progressSecondRef.current = second
        progressRef.current?.({ positionSeconds: Number(video.currentTime.toFixed(2)), durationSeconds: openingManifest.duration })
      }
    }
    const hidden = () => { if (document.hidden) player.stop() }
    video.addEventListener('timeupdate', update)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      video.removeEventListener('timeupdate', update)
      document.removeEventListener('visibilitychange', hidden)
      player.stop(); playerRef.current = null
    }
  }, [avatarAudioRef, avatarVideoRef, coordinator])
  const play = useCallback(options => playerRef.current?.play(options) || Promise.resolve('skipped'), [])
  const stop = useCallback(() => playerRef.current?.stop(), [])
  const skip = useCallback(() => playerRef.current?.skip(), [])
  const caption = openingManifest.captions.find(item => position >= item.start && position <= item.end)
    || [...openingManifest.captions].reverse().find(item => position >= item.start) || openingManifest.captions[0]
  return { videoRef, state, busy: state !== 'idle', position, caption, play, stop, skip, outcome, duration: openingManifest.duration }
}

export function OpeningVideo({ videoRef, state }) {
  return <video ref={videoRef} src={`${import.meta.env.BASE_URL}media/interviewer-actions/${openingManifest.file}`}
    className={`avatar-opening-video ${state === 'playing' ? 'visible' : ''}`} data-opening-state={state}
    preload="auto" playsInline aria-hidden="true" />
}

export function OpeningCaption({ caption, position }) {
  return <div className="opening-caption">
    <div className="opening-caption-heading"><span>入场介绍 · {caption.title}</span><small>{Math.min(Math.ceil(openingManifest.duration), Math.floor(position))} / {Math.ceil(openingManifest.duration)} 秒</small></div>
    <p aria-live="polite" aria-atomic="true">{caption.text}</p>
    <div className="opening-progress" aria-hidden="true"><i style={{width:`${Math.min(100,position/openingManifest.duration*100)}%`}} /></div>
  </div>
}
