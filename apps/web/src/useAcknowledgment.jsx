import { useCallback, useEffect, useRef, useState } from 'react'
import { createAcknowledgmentPlayer } from './acknowledgmentPlayer'

export const ACKNOWLEDGMENT_URL = `${import.meta.env.BASE_URL}media/interviewer-actions/acknowledge-ok-v1.mp4`

export default function useAcknowledgment({ avatarAudioRef, avatarVideoRef, onEvent, coordinator }) {
  const videoRef = useRef(null)
  const playerRef = useRef(null)
  const eventRef = useRef(onEvent)
  const [state, setState] = useState('idle')
  eventRef.current = onEvent
  const stop = useCallback(() => playerRef.current?.stop(), [])
  useEffect(() => {
    const player = createAcknowledgmentPlayer({
      video: videoRef.current,
      coordinator,
      getCompetingMedia: () => [avatarAudioRef.current, avatarVideoRef.current],
      nowHidden: () => document.hidden,
      onState: setState,
      onEvent: (event, details) => eventRef.current?.(event, details),
    })
    playerRef.current = player
    const onHidden = () => { if (document.hidden) player.stop() }
    document.addEventListener('visibilitychange', onHidden)
    return () => { document.removeEventListener('visibilitychange', onHidden); player.stop(); playerRef.current = null }
  }, [avatarAudioRef, avatarVideoRef, coordinator])
  const play = useCallback(options => playerRef.current?.play(options) || Promise.resolve('skipped'), [])
  return { videoRef, state, play, stop, busy: state !== 'idle' }
}

export function AcknowledgmentVideo({ videoRef, state }) {
  return <video ref={videoRef} className={`avatar-acknowledgment ${state === 'playing' ? 'visible' : ''}`}
    src={ACKNOWLEDGMENT_URL} playsInline preload="auto" aria-hidden="true" data-ack-state={state} />
}
