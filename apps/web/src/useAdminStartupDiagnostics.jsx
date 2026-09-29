import { useCallback, useEffect, useRef, useState } from 'react'
import { AVATAR_LOAD_STAGES, INITIAL_AVATAR_LOAD, beginAvatarLoad, updateAvatarLoad, avatarLoadSeconds } from './adminAvatarLoad'

const INITIAL = {
  policy: { label: '本地 API / 规则', status: 'pending', detail: '正在读取规则' },
  session: { label: '数字人会话', status: 'pending', detail: '尚未创建' },
  rtc: { label: 'WebRTC 连接', status: 'pending', detail: '等待协商' },
  video: { label: '首帧画面', status: 'pending', detail: '等待实际解码画面' },
  audio: { label: '音频通道', status: 'pending', detail: '等待媒体开始播放' },
  tts: { label: '实时语音播报', status: 'idle', detail: '规则片结束或跳过后验证' },
}
export default function useAdminStartupDiagnostics(appendLog) {
  const origin = useRef(performance.now()), ref = useRef(INITIAL), logRef = useRef(appendLog)
  const [stages, setStages] = useState(INITIAL), [elapsed, setElapsed] = useState(0)
  const loadRef = useRef(INITIAL_AVATAR_LOAD)
  const [avatarLoad, setAvatarLoad] = useState(INITIAL_AVATAR_LOAD)
  logRef.current = appendLog
  const beginLoad = useCallback(() => {
    const now = performance.now()
    loadRef.current = beginAvatarLoad(loadRef.current, now)
    setAvatarLoad(loadRef.current)
    // Clear all four together so a new connection cannot inherit old green states.
    ref.current = { ...ref.current }
    for (const key of AVATAR_LOAD_STAGES) ref.current[key] = { ...INITIAL[key], status: 'pending', detail: '正在连接，等待实际事件确认' }
    setStages(ref.current)
    logRef.current('info', 'startup', 'avatar.load.started', '数字人开始加载，独立计时已归零', { attempt: loadRef.current.attempt })
  }, [])
  const mark = useCallback((key, status, detail) => {
    const old = ref.current[key]
    if (!old || (old.status === status && old.detail === detail)) return
    const seconds = Number(((performance.now() - origin.current) / 1000).toFixed(2))
    const item = { ...old, status, detail, seconds }
    ref.current = { ...ref.current, [key]: item }
    setStages(ref.current)
    logRef.current(status === 'error' ? 'error' : status === 'degraded' ? 'warn' : 'info', 'startup', `chain.${key}.${status}`, `${old.label}：${detail}`, { seconds, stage: key, status })
    if (AVATAR_LOAD_STAGES.includes(key)) {
      const previous = loadRef.current
      loadRef.current = updateAvatarLoad(previous, ref.current, performance.now())
      setAvatarLoad(loadRef.current)
      if (previous.completedAt === null && loadRef.current.completedAt !== null) {
        logRef.current('info', 'startup', 'avatar.load.completed', '数字人加载完毕', {
          attempt: loadRef.current.attempt,
          durationSeconds: Number(avatarLoadSeconds(loadRef.current, performance.now()).toFixed(3)),
          readyStages: AVATAR_LOAD_STAGES,
        })
      }
    }
  }, [])
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed((performance.now() - origin.current) / 1000), 250)
    return () => window.clearInterval(timer)
  }, [])
  const connected = ['session', 'rtc', 'video', 'audio'].every(key => stages[key].status === 'ready')
  const ready = connected && stages.policy.status === 'ready' && stages.tts.status === 'ready'
  const hasError = Object.values(stages).some(item => ['error', 'degraded'].includes(item.status))
  return { stages, mark, beginLoad, elapsed, ready, connected, hasError, avatarLoad,
    avatarSeconds: avatarLoadSeconds(avatarLoad, performance.now()) }
}
