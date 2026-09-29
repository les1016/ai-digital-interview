import { useCallback, useEffect, useRef, useState } from 'react'
import { createAcknowledgmentPlayer } from './acknowledgmentPlayer'
import { createSmilePolicy, REASSURANCE_CAPTION, SMILE_SECONDS } from './smilePolicy'

const STORAGE_PREFIX = 'ai-interview.smile.v1:'
const ENABLED = import.meta.env.VITE_SMILE_ACTIONS_ENABLED !== 'false'
const OUTCOME_LABELS = {
  requested: '正在准备', started: '正在播放', completed: '播放完成', cancelled: '已被新流程取消',
  'stale-context': '场景已变化，跳过', 'stage-busy': '其他播报占用画面',
  'media-not-ready': '素材未就绪，已跳过', 'missing-session': '尚未开始面试',
  'global-cooldown': '跨场景微笑冷却中', 'silence-cooldown': '停顿安抚冷却中',
  'question-limit': '本题已经安抚过', 'interview-limit': '本场安抚次数已用尽',
  'awaiting-effective-answer': '等待新的有效回答', 'start-timeout': '加载超时，已跳过',
  'playback-timeout': '播放超时，已回退', 'play-blocked': '浏览器阻止播放，已跳过',
  'invalid-media': '素材不匹配，已跳过', 'media-error': '素材读取失败',
  disabled: '短微笑功能已关闭', skipped: '已跳过',
}
export default function useSmileAction({ coordinator, onEvent }) {
  const videoRef = useRef(null), playerRef = useRef(null), callbackRef = useRef(onEvent)
  const policyRef = useRef(null), scopeRef = useRef(''), requestRef = useRef(null)
  const [state, setState] = useState('idle'), [reason, setReason] = useState('')
  const [diagnostics, setDiagnostics] = useState({ count: 0, globalRemaining: 0, silenceRemaining: 0, outcome: '未触发' })
  callbackRef.current = onEvent
  const configure = useCallback(scope => {
    if (scopeRef.current === scope && policyRef.current) return
    playerRef.current?.stop()
    scopeRef.current = scope
    let initial = {}
    try { initial = JSON.parse(localStorage.getItem(STORAGE_PREFIX + scope) || '{}') || {} } catch { /* unavailable */ }
    policyRef.current = createSmilePolicy({ initial, save: snapshot => {
      try { localStorage.setItem(STORAGE_PREFIX + scope, JSON.stringify(snapshot)) } catch { /* optional local cache */ }
    } })
    setDiagnostics({ ...policyRef.current.snapshot(), outcome: '就绪' })
  }, [])
  const stop = useCallback(() => playerRef.current?.stop(), [])
  useEffect(() => {
    const player = createAcknowledgmentPlayer({ video: videoRef.current,
      expectedDuration: SMILE_SECONDS, startTimeoutMs: 700, playbackTimeoutMs: 3000,
      coordinator, owner: 'smile', priority: 10, silent: true,
      // Silence reassurance must not pause/mute the candidate microphone or ASR.
      nowHidden: () => document.hidden, onState: setState,
      onEvent: (event, details) => {
        setDiagnostics(d => ({ ...d, ...policyRef.current?.snapshot(), outcome: event }))
        callbackRef.current?.(event, { ...details, reason: requestRef.current?.reason })
      },
    })
    playerRef.current = player
    const hidden = () => { if (document.hidden) player.stop() }
    document.addEventListener('visibilitychange', hidden)
    const interval = window.setInterval(() => {
      if (policyRef.current) setDiagnostics(d => ({ ...d, ...policyRef.current.snapshot() }))
    }, 1000)
    return () => {
      clearInterval(interval); document.removeEventListener('visibilitychange', hidden)
      player.stop(); playerRef.current = null
    }
  }, [coordinator])
  const play = useCallback(({ reason, questionKey, progress = 0, guard = () => true }) => {
    const player = playerRef.current, video = videoRef.current
    const request = { reason, questionKey, progress }
    const blocked = !ENABLED ? 'disabled' : !guard() || document.hidden ? 'stale-context'
      : coordinator.owner ? 'stage-busy'
        : !player || player.busy || !video || video.error || video.readyState < 2 ? 'media-not-ready'
          : !policyRef.current ? 'missing-session' : policyRef.current.check(request)
    if (blocked) {
      setDiagnostics(d => ({ ...d, outcome: blocked }))
      callbackRef.current?.('skipped', { reason, blocked })
      return Promise.resolve('skipped')
    }
    policyRef.current.reserve(request)
    requestRef.current = request
    setReason(reason)
    return player.play({ key: `${scopeRef.current}:${reason}:${Date.now()}`, guard })
  }, [coordinator])
  return { videoRef, state, busy: state !== 'idle', play, stop, configure,
    diagnostics: { ...diagnostics, outcome: OUTCOME_LABELS[diagnostics.outcome] || diagnostics.outcome }, reason,
    get busyNow() { return Boolean(playerRef.current?.busy) } }
}

export function SmileVideo({ smile }) {
  return <>
    <video ref={smile.videoRef} className={`avatar-smile ${smile.state === 'playing' ? 'visible' : ''}`}
      src={`${import.meta.env.BASE_URL}media/interviewer-actions/smile-short-v1.mp4`}
      muted playsInline preload="auto" aria-hidden="true" data-smile-state={smile.state} data-smile-reason={smile.reason} />
    {smile.state === 'playing' && smile.reason === 'silence' && <div className="avatar-reassurance-caption" role="status">{REASSURANCE_CAPTION}</div>}
  </>
}
