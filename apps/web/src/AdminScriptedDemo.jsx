import { avatarFetch } from './api'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowLeft, Bug, Camera, CheckCircle2, CircleStop, Clock3, Download,
  FastForward, Filter, LoaderCircle, PauseCircle, Play, PlayCircle, Radio,
  RefreshCw, RotateCcw, Save, Send, ShieldCheck, Trash2, Volume2, X,
} from 'lucide-react'
import ParticleField from './ParticleField'
import script from './data/adminInterviewScript.json'
import { api } from './api'
import useAcknowledgment, { AcknowledgmentVideo } from './useAcknowledgment'
import { afterAcknowledgment } from './acknowledgmentPolicy'
import useOpeningVideo, { OpeningVideo } from './useOpeningVideo'
import { openingPolicyMatches } from './openingPolicy'
import useAdminStartupDiagnostics from './useAdminStartupDiagnostics'
import OpeningRulesNotice from './OpeningRulesNotice'
import { createAvatarActionCoordinator } from './avatarActionCoordinator'
import useSmileAction, { SmileVideo } from './useSmileAction'

const LIVETALKING_BASE = new URL(
  import.meta.env.VITE_LIVETALKING_URL
    || (['127.0.0.1', 'localhost', '::1'].includes(window.location.hostname) ? 'http://127.0.0.1:8010' : '/avatar'),
  window.location.origin,
).toString().replace(/\/+$/, '')
const CHECKPOINT_KEY = 'ai-interview.admin-preview.checkpoint.v1'
const LOG_KEY = 'ai-interview.admin-preview.logs.v1'
// Intent of each incoming scripted question, manually reviewed (no LLM cost).
const SCRIPT_REPLY_INTENTS = ['neutral', 'acknowledge', 'acknowledge', 'acknowledge', 'acknowledge', 'acknowledge', 'challenge', 'acknowledge']
const MAX_LOGS = 300
const DEFAULT_POLICY = { threshold: 3, window_seconds: 86400, cooldown_seconds: 1800, pause_max_seconds: 600, max_invalid_answers: 3 }
const sleep = delay => new Promise(resolve => window.setTimeout(resolve, delay))
const formatDuration = total => `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
const safeRead = (key, fallback) => {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || 'null')
    return value ?? fallback
  } catch { return fallback }
}
const formatLogTime = value => new Date(value).toLocaleTimeString('zh-CN', { hour12: false })

export default function AdminScriptedDemo({ onExit }) {
  const avatarVideoRef = useRef(null)
  const avatarAudioRef = useRef(null)
  const [actionCoordinator] = useState(createAvatarActionCoordinator)
  const smileScopeRef = useRef(safeRead(CHECKPOINT_KEY, null)?.smileScope || `admin:${Date.now()}`)
  const candidateVideoRef = useRef(null)
  const cameraStreamRef = useRef(null)
  const peerRef = useRef(null)
  const connectTaskRef = useRef(null)
  const connectionEpochRef = useRef(0)
  const sessionRef = useRef('')
  const runRef = useRef(0)
  const pauseTimerRef = useRef(null)
  const previousPhaseRef = useRef('idle')
  const [status, setStatus] = useState('正在连接真人数字人')
  const [cameraStatus, setCameraStatus] = useState('正在连接管理员镜头')
  const [phase, setPhase] = useState('idle')
  const [turnIndex, setTurnIndex] = useState(0)
  const [messages, setMessages] = useState([])
  const [displayQuestion, setDisplayQuestion] = useState('')
  const [error, setError] = useState('')
  const [pauseCount, setPauseCount] = useState(0)
  const [pauseDeadlineMs, setPauseDeadlineMs] = useState(0)
  const [pauseRemaining, setPauseRemaining] = useState(0)
  const [pauseNotice, setPauseNotice] = useState('')
  const [checkpoint, setCheckpoint] = useState(() => safeRead(CHECKPOINT_KEY, null))
  const [lastCheckpointAt, setLastCheckpointAt] = useState(() => safeRead(CHECKPOINT_KEY, null)?.savedAt || 0)
  const [logs, setLogs] = useState(() => {
    const stored = safeRead(LOG_KEY, [])
    return Array.isArray(stored) ? stored.slice(-MAX_LOGS) : []
  })
  const [debugOpen, setDebugOpen] = useState(false)
  const [logLevel, setLogLevel] = useState('all')
  const [logCategory, setLogCategory] = useState('all')
  const [logQuery, setLogQuery] = useState('')
  const [policy, setPolicy] = useState(DEFAULT_POLICY)
  const [ackTestIntent, setAckTestIntent] = useState('script')
  const sendingRef = useRef(false)
  const adminPauseSeconds = Math.max(60, Number(policy.pause_max_seconds || 600))
  const policyBriefing = useMemo(() => {
    const threshold = Math.max(2, Number(policy.threshold || 3))
    const windowHours = Math.max(1, Math.ceil(Number(policy.window_seconds || 86400) / 3600))
    const cooldownMinutes = Math.max(1, Math.ceil(Number(policy.cooldown_seconds || 1800) / 60))
    const pauseMinutes = Math.max(1, Math.ceil(adminPauseSeconds / 60))
    return `开始前规则说明：学生临时有事时，应优先使用页面右上角的暂停功能，最长保留${pauseMinutes}分钟。请尽量不要直接关闭网页或中途强制退出，因为这可能导致回答或录像无法完整保存。${windowHours}小时内，前${threshold - 1}次强制退出只提醒，第${threshold}次会进入${cooldownMinutes}分钟冷却；偶发断网或设备断开不计入。管理员测试可以反复暂停，不触发学生冷却。规则说明完毕，现在我们开始。`
  }, [adminPauseSeconds, policy])

  const appendLog = useCallback((level, category, event, message, details = {}) => {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      timestamp: new Date().toISOString(), level, category, event, message, details,
    }
    setLogs(items => {
      const next = [...items, entry].slice(-MAX_LOGS)
      try { window.localStorage.setItem(LOG_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
      return next
    })
  }, [])
  const diagnostics = useAdminStartupDiagnostics(appendLog)
  const markChain = diagnostics.mark
  const beginAvatarLoading = diagnostics.beginLoad
  const smile = useSmileAction({ coordinator: actionCoordinator,
    onEvent: (event, details) => appendLog('info', 'avatar-action', `smile.${event}`, `短微笑：${event}`, details),
  })
  const { state: actionState, stop: stopExpressionAction, play: playSmile, configure: configureSmile } = smile
  useEffect(() => configureSmile(smileScopeRef.current), [configureSmile])

  const { videoRef: acknowledgmentRef, state: acknowledgmentState, play: playAcknowledgment,
    stop: stopAcknowledgment, busy: acknowledgmentBusy } = useAcknowledgment({
    avatarAudioRef, avatarVideoRef, coordinator: actionCoordinator,
    onEvent: (event, details) => appendLog(
      ['requested', 'started', 'completed', 'cancelled'].includes(event) ? 'info' : 'warn',
      'avatar-action', `acknowledgment.${event}`, `两秒承接动作：${event}`, details,
    ),
  })
  const opening = useOpeningVideo({ avatarAudioRef, avatarVideoRef, coordinator: actionCoordinator,
    onEvent: (event, details) => appendLog('info', 'avatar-action', `opening.${event}`, `入场规则视频：${event}`, details),
    onProgress: details => appendLog('info', 'startup', 'opening.progress', `入场播放 ${details.positionSeconds.toFixed(1)} 秒`, details),
  })
  const stopOpening = opening.stop

  const disconnectAvatar = useCallback(() => {
    actionCoordinator.cancelAll()
    connectionEpochRef.current += 1
    connectTaskRef.current = null
    stopOpening()
    stopAcknowledgment()
    window.speechSynthesis?.cancel()
    const avatarSessionId = sessionRef.current
    if (avatarSessionId) {
      avatarFetch(`${LIVETALKING_BASE}/api/session/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionid: avatarSessionId }),
        keepalive: true,
      }).catch(() => {})
    }
    peerRef.current?.close()
    peerRef.current = null
    sessionRef.current = ''
    for (const element of [avatarVideoRef.current, avatarAudioRef.current]) {
      if (element) { element.pause(); element.srcObject = null }
    }
    for (const key of ['session', 'rtc', 'video', 'audio', 'tts']) markChain(key, 'idle', '连接已释放；重连后重新验证')
  }, [markChain, stopAcknowledgment, stopOpening, actionCoordinator])

  const playExpressionAction = (reason = 'manual') => {
    const runId = runRef.current
    if (phase !== 'ready' || pauseDeadlineMs) return
    if (reason === 'silence' && ['challenge', 'clarify'].includes(ackTestIntent === 'script' ? SCRIPT_REPLY_INTENTS[turnIndex] : ackTestIntent)) {
      appendLog('info', 'avatar-action', 'smile.skipped', '质疑或澄清场景不触发安抚微笑')
      return
    }
    return playSmile({ reason, questionKey: String(turnIndex), progress: messages.filter(m => m.speaker === 'candidate').length,
      guard: () => runRef.current === runId })
  }

  const connect = useCallback(() => {
    if (connectTaskRef.current) return connectTaskRef.current
    if (sessionRef.current && ['connected', 'connecting', 'new'].includes(peerRef.current?.connectionState)) return Promise.resolve(sessionRef.current)
    beginAvatarLoading()
    const epoch = ++connectionEpochRef.current
    const task = (async () => {
    const current = () => connectionEpochRef.current === epoch
    for (const key of ['session', 'rtc', 'video', 'audio']) markChain(key, 'pending', '正在连接，等待实际事件确认')
    const pc = new RTCPeerConnection({ sdpSemantics: 'unified-plan' })
    let allocatedSessionId = ''
    peerRef.current = pc
    pc.addTransceiver('video', { direction: 'recvonly' })
    pc.addTransceiver('audio', { direction: 'recvonly' })
    pc.addEventListener('track', event => {
      if (!current()) return
      const element = event.track.kind === 'video' ? avatarVideoRef.current : avatarAudioRef.current
      if (element) {
        element.srcObject = new MediaStream([event.track])
        element.play().catch(() => { if (current()) markChain(event.track.kind, 'degraded', '浏览器阻止自动播放；请点击启用音视频') })
      }
      event.track.addEventListener('ended', () => { if (current()) markChain(event.track.kind, 'error', '媒体轨道已结束') })
    })
    pc.addEventListener('connectionstatechange', () => {
      if (!current()) return
      if (pc.connectionState === 'connected') {
        markChain('rtc', 'ready', 'ICE / DTLS 已连接；画面与声音独立验证')
        setStatus('固定剧本数字人在线')
        appendLog('info', 'avatar', 'connection.connected', '数字人 WebRTC 已连接')
      }
      if (['failed', 'disconnected'].includes(pc.connectionState)) {
        for (const key of ['rtc', 'video', 'audio', 'tts']) markChain(key, 'error', `连接${pc.connectionState === 'failed' ? '失败' : '中断'}，当前链路未就绪`)
        setStatus('数字人连接中断')
        appendLog('warn', 'avatar', 'connection.interrupted', '数字人连接中断', { state: pc.connectionState })
      }
    })
    try {
      const offer = await pc.createOffer()
      if (!current()) throw new Error('连接操作已取消')
      await pc.setLocalDescription(offer)
      if (pc.iceGatheringState !== 'complete') {
        await new Promise((resolve, reject) => {
          const timeout = window.setTimeout(() => { pc.removeEventListener('icegatheringstatechange', listener); reject(new Error('数字人连接准备超时')) }, 8000)
          const listener = () => {
            if (pc.iceGatheringState !== 'complete') return
            window.clearTimeout(timeout)
            pc.removeEventListener('icegatheringstatechange', listener)
            resolve()
          }
          pc.addEventListener('icegatheringstatechange', listener)
        })
      }
      if (!current()) throw new Error('连接操作已取消')
      const response = await avatarFetch(`${LIVETALKING_BASE}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp: pc.localDescription.sdp, type: pc.localDescription.type }),
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error('数字人视频连接失败')
      const answer = await response.json()
      allocatedSessionId = String(answer.sessionid || '')
      if (!current()) {
        throw new Error('连接操作已取消')
      }
      sessionRef.current = allocatedSessionId
      if (!sessionRef.current) throw new Error('数字人未返回有效会话')
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
      if (!current()) throw new Error('连接操作已取消')
      markChain('session', 'ready', '服务已返回会话；尚不代表画面或声音就绪')
      if (pc.connectionState === 'connected') markChain('rtc', 'ready', 'ICE / DTLS 已连接；画面与声音独立验证')
      appendLog('info', 'avatar', 'session.created', '数字人会话已创建', { sessionId: sessionRef.current })
      return sessionRef.current
    } catch (reason) {
      pc.close()
      if (allocatedSessionId) avatarFetch(`${LIVETALKING_BASE}/api/session/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionid: allocatedSessionId }), keepalive: true }).catch(() => {})
      if (peerRef.current === pc) peerRef.current = null
      if (current()) {
        sessionRef.current = ''
        markChain('session', 'error', reason.message)
        appendLog('error', 'avatar', 'connection.failed', '数字人连接失败', { reason: reason.message })
      }
      throw reason
    }
    })()
    connectTaskRef.current = task
    const release = () => { if (connectTaskRef.current === task) connectTaskRef.current = null }
    task.then(release, release)
    return task
  }, [appendLog, beginAvatarLoading, markChain])

  const isSpeaking = useCallback(async () => {
    const response = await avatarFetch(`${LIVETALKING_BASE}/is_speaking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionid: sessionRef.current }),
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) throw new Error('无法读取数字人播报状态')
    return (await response.json()).data === true
  }, [])

  const browserSpeak = useCallback((text, runId) => new Promise((resolve, reject) => {
    if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      reject(new Error('数字人与浏览器语音均不可用'))
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    utterance.rate = 0.96
    utterance.onend = () => resolve()
    utterance.onerror = () => reject(new Error('浏览器备用语音播报失败'))
    if (runRef.current !== runId) return resolve()
    window.speechSynthesis.cancel()
    window.speechSynthesis.speak(utterance)
  }), [])

  const speak = useCallback(async (text, runId, nextPhase = 'ready') => {
    stopAcknowledgment()
    actionCoordinator.cancelAll()
    const speechLease = actionCoordinator.acquire({ owner: 'speech', priority: 100, cancel: () => {} })
    setPhase(nextPhase === 'paused' ? 'pause-speaking' : 'speaking')
    markChain('tts', 'pending', '正在准备实时语音，尚未开始播报')
    try {
      const sessionid = await connect()
      if (runRef.current !== runId) return
      const response = await avatarFetch(`${LIVETALKING_BASE}/human`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, type: 'echo', interrupt: true, sessionid }),
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) throw new Error('固定问题播报失败')
      const startDeadline = Date.now() + 25000
      let started = false
      while (Date.now() < startDeadline && runRef.current === runId) {
        if (await isSpeaking()) { started = true; break }
        await sleep(250)
      }
      if (runRef.current !== runId) return
      if (!started) throw new Error('数字人没有开始播报')
      markChain('tts', 'ready', '服务已确认开始播报；不代表耳机实际音量')
      let quietSince = null
      const endDeadline = Date.now() + Math.max(45000, text.length * 600)
      while (Date.now() < endDeadline && runRef.current === runId) {
        if (await isSpeaking()) quietSince = null
        else {
          quietSince ||= Date.now()
          if (Date.now() - quietSince >= 1200) break
        }
        await sleep(250)
      }
    } catch (reason) {
      if (runRef.current !== runId) return
      setStatus('使用浏览器备用语音')
      markChain('tts', 'degraded', `实时链路未就绪，改用浏览器语音：${reason.message}`)
      appendLog('warn', 'speech', 'fallback.enabled', '已切换浏览器备用语音', { reason: reason.message })
      await browserSpeak(text, runId)
    } finally { speechLease?.release() }
    if (runRef.current === runId) setPhase(nextPhase)
  }, [appendLog, browserSpeak, connect, isSpeaking, markChain, stopAcknowledgment, actionCoordinator])

  const askTurn = useCallback(async (index, runId, includeBriefing = false, acknowledged = false) => {
    const turn = script.turns[index]
    const spokenQuestion = `${includeBriefing ? policyBriefing : ''}${turn.question}`
    setTurnIndex(index)
    setDisplayQuestion(spokenQuestion)
    setMessages(items => [...items, { speaker: 'interviewer', content: spokenQuestion }])
    appendLog('info', 'script', 'question.started', `开始问题 ${index + 1}`, { turnIndex: index, question: turn.question })
    setError('')
    try {
      await speak(acknowledged ? afterAcknowledgment(spokenQuestion) : spokenQuestion, runId)
    } catch (reason) {
      if (runRef.current !== runId) return
      setError(reason.message)
      appendLog('error', 'script', 'question.failed', `问题 ${index + 1} 播报失败`, { reason: reason.message })
      setPhase('ready')
    }
  }, [appendLog, policyBriefing, speak])

  useEffect(() => {
    api('/account/interruption-status')
      .then(value => { setPolicy(value); markChain('policy', 'ready', '本地接口可达，规则读取成功') })
      .catch(reason => {
        markChain('policy', 'degraded', '规则读取失败，使用本地默认值')
        appendLog('warn', 'policy', 'policy.fallback', '冷却规则读取失败，管理员预览使用默认值', { reason: reason.message })
      })
  }, [appendLog, markChain])

  useEffect(() => {
    let active = true
    navigator.mediaDevices?.getUserMedia({ video: true, audio: true })
      .then(stream => {
        if (!active) return stream.getTracks().forEach(track => track.stop())
        cameraStreamRef.current = stream
        if (candidateVideoRef.current) candidateVideoRef.current.srcObject = stream
        setCameraStatus('管理员镜头已连接')
        appendLog('info', 'device', 'camera.connected', '管理员摄像头和麦克风已连接')
      })
      .catch(reason => {
        setCameraStatus('镜头未授权，可继续测试控制流程')
        appendLog('warn', 'device', 'camera.denied', '摄像头或麦克风未授权', { reason: reason.message })
      })
    appendLog('info', 'system', 'preview.mounted', '管理员固定剧本预览已打开')
    const timer = window.setTimeout(() => connect().catch(() => setStatus('数字人暂未连接')), 80)
    return () => {
      active = false
      window.clearTimeout(timer)
      window.clearInterval(pauseTimerRef.current)
      runRef.current += 1
      stopExpressionAction()
      disconnectAvatar()
      cameraStreamRef.current?.getTracks().forEach(track => track.stop())
    }
  }, [appendLog, connect, disconnectAvatar, stopExpressionAction])

  useEffect(() => {
    if (previousPhaseRef.current !== phase) {
      appendLog('info', 'state', 'phase.changed', `${previousPhaseRef.current} → ${phase}`, {
        from: previousPhaseRef.current, to: phase, turnIndex,
      })
      previousPhaseRef.current = phase
    }
  }, [appendLog, phase, turnIndex])

  useEffect(() => {
    if (phase === 'idle') return
    const snapshot = {
      version: 1,
      smileScope: smileScopeRef.current,
      savedAt: Date.now(),
      phase,
      turnIndex,
      messages,
      displayQuestion,
      pauseCount,
      pauseDeadlineMs,
      pauseNotice,
    }
    try {
      window.localStorage.setItem(CHECKPOINT_KEY, JSON.stringify(snapshot))
      setCheckpoint(snapshot)
      setLastCheckpointAt(snapshot.savedAt)
    } catch (reason) {
      appendLog('error', 'checkpoint', 'checkpoint.save_failed', '自动断点保存失败', { reason: reason.message })
    }
  }, [appendLog, displayQuestion, messages, pauseCount, pauseDeadlineMs, pauseNotice, phase, turnIndex])

  useEffect(() => {
    window.clearInterval(pauseTimerRef.current)
    if (!pauseDeadlineMs) return undefined
    const update = () => {
      const remaining = Math.max(0, Math.ceil((pauseDeadlineMs - Date.now()) / 1000))
      setPauseRemaining(remaining)
      if (remaining <= 0) {
        window.clearInterval(pauseTimerRef.current)
        pauseTimerRef.current = null
        runRef.current += 1
        disconnectAvatar()
        setPauseDeadlineMs(0)
        setPhase('completed')
        setError('暂停倒计时已结束，本次管理员预览已自动结束。')
        appendLog('warn', 'pause', 'pause.expired', '管理员暂停倒计时结束，预览自动结束', { pauseCount })
      }
    }
    update()
    pauseTimerRef.current = window.setInterval(update, 250)
    return () => window.clearInterval(pauseTimerRef.current)
  }, [appendLog, disconnectAvatar, pauseCount, pauseDeadlineMs])

  const start = async () => {
    if (phase !== 'idle') return
    stopOpening()
    stopExpressionAction()
    const runId = runRef.current + 1
    runRef.current = runId
    setMessages([])
    smileScopeRef.current = `admin:${Date.now()}:${runId}`
    configureSmile(smileScopeRef.current)
    setDisplayQuestion('')
    setTurnIndex(0)
    setPauseCount(0)
    setPauseDeadlineMs(0)
    setPauseRemaining(0)
    setError('')
    setPhase('starting')
    appendLog('info', 'session', 'preview.started', '固定剧本测试已开始', { turnCount: script.turns.length })
    const outcome = openingPolicyMatches(policy)
      ? await opening.play({ key: `admin-opening:${runId}`, guard: () => runRef.current === runId }) : 'skipped'
    if (runRef.current !== runId) return
    if (outcome === 'completed') await playSmile({ reason: 'welcome', guard: () => runRef.current === runId })
    if (runRef.current !== runId) return
    await askTurn(0, runId, !['completed', 'manual-skipped'].includes(outcome))
  }

  const sendPresetAnswer = async () => {
    if (phase !== 'ready' || pauseDeadlineMs || sendingRef.current || acknowledgmentBusy) return
    sendingRef.current = true
    const runId = runRef.current
    try {
      stopExpressionAction()
      const answer = script.turns[turnIndex].answer
      setMessages(items => [...items, { speaker: 'candidate', content: answer }])
      appendLog('info', 'script', 'answer.sent', `已发送问题 ${turnIndex + 1} 的预设回答`, { turnIndex, characters: answer.length })
      setPhase('sending')
      await sleep(450)
      if (runRef.current !== runId) return
      if (turnIndex >= script.turns.length - 1) return setPhase('completed')
      const nextIndex = turnIndex + 1
      // Explicit test override affects only this local preview, never students.
      const intent = ackTestIntent === 'script' ? SCRIPT_REPLY_INTENTS[nextIndex] : ackTestIntent
      appendLog('info', 'avatar-action', 'acknowledgment.decision', intent === 'acknowledge' ? '正常承接：准备播放好的' : '澄清或质疑：跳过肯定动作', { intent, source: ackTestIntent, nextIndex })
      // Save the *next* question before the interruptible transition, so a
      // pause/refresh cannot return to the question that was just answered.
      setTurnIndex(nextIndex)
      setDisplayQuestion(script.turns[nextIndex].question)
      let outcome = 'skipped'
      if (intent === 'acknowledge') {
        setPhase('acknowledging')
        window.speechSynthesis?.cancel()
        outcome = await playAcknowledgment({ key: `${runId}:${nextIndex}`, guard: () => runRef.current === runId })
      }
      if (runRef.current !== runId) return
      await askTurn(nextIndex, runId, false, outcome === 'completed')
    } finally { sendingRef.current = false }
  }

  const requestPause = async () => {
    if (['idle', 'completed', 'pause-speaking', 'paused'].includes(phase)) return
    const runId = runRef.current + 1
    runRef.current = runId
    disconnectAvatar()
    const nextPauseCount = pauseCount + 1
    const notice = `管理员暂停测试第${nextPauseCount}次。本次界面最长保留十分钟，倒计时会持续显示；请在归零前点击“继续面试”，超时后本次预览会自动结束。管理员模式恢复后仍可再次暂停。暂停期间我不会继续提问。`
    setPauseCount(nextPauseCount)
    setPauseRemaining(adminPauseSeconds)
    setPauseDeadlineMs(Date.now() + adminPauseSeconds * 1000)
    setPauseNotice(notice)
    setError('')
    appendLog('info', 'pause', 'pause.started', `第 ${nextPauseCount} 次暂停已开始`, { turnIndex, phaseBeforePause: phase, durationSeconds: adminPauseSeconds })
    try {
      await speak(notice, runId, 'paused')
    } catch (reason) {
      if (runRef.current === runId) {
        setError(reason.message)
        appendLog('error', 'pause', 'pause.briefing_failed', '暂停规则播报失败', { reason: reason.message })
        setPhase('paused')
      }
    }
  }

  const requestResume = async () => {
    if (!pauseDeadlineMs || phase !== 'paused') return
    const runId = runRef.current + 1
    runRef.current = runId
    const lastAnswer = [...messages].reverse().find(item => item.speaker === 'candidate')
    const answeredTurn = lastAnswer ? script.turns.find(item => item.answer === lastAnswer.content) : null
    const transition = answeredTurn
      ? `你回来了，欢迎继续。刚才你主要说明了${answeredTurn.answer_summary}。接下来我们继续：${script.turns[turnIndex].question}`
      : `你回来了，欢迎继续。我们继续刚才的问题：${script.turns[turnIndex].question}`
    setPauseDeadlineMs(0)
    setPauseRemaining(0)
    setMessages(items => [...items, { speaker: 'interviewer', content: transition }])
    setDisplayQuestion(transition)
    setError('')
    appendLog('info', 'pause', 'pause.resumed', `从第 ${pauseCount} 次暂停恢复`, { turnIndex, remainingSeconds: pauseRemaining })
    try {
      setPhase('resuming')
      await playSmile({ reason: 'resume', guard: () => runRef.current === runId })
      if (runRef.current !== runId) return
      await speak(transition, runId)
    } catch (reason) {
      if (runRef.current === runId) { setError(reason.message); setPhase('ready') }
    }
  }

  const skipSpeaking = () => {
    if (phase !== 'speaking' || opening.busy) return
    runRef.current += 1
    disconnectAvatar()
    setPhase('ready')
    appendLog('warn', 'intervention', 'speech.skipped', '管理员跳过了当前播报', { turnIndex })
  }

  const completePreview = () => {
    runRef.current += 1
    disconnectAvatar()
    setPauseDeadlineMs(0)
    setPhase('completed')
    appendLog('warn', 'intervention', 'preview.completed_manually', '管理员手动结束了预览', { turnIndex })
  }

  const restart = () => {
    runRef.current += 1
    disconnectAvatar()
    stopExpressionAction()
    setTurnIndex(0)
    setMessages([])
    setDisplayQuestion('')
    setError('')
    setPauseCount(0)
    setPauseDeadlineMs(0)
    setPauseRemaining(0)
    setPauseNotice('')
    setPhase('idle')
    try { window.localStorage.removeItem(CHECKPOINT_KEY) } catch { /* storage unavailable */ }
    setCheckpoint(null)
    setLastCheckpointAt(0)
    appendLog('info', 'session', 'preview.reset', '剧本与运行断点已重置')
  }

  const restoreCheckpoint = () => {
    const saved = safeRead(CHECKPOINT_KEY, null)
    if (!saved || saved.version !== 1) {
      setError('没有可恢复的管理员预览断点。')
      return
    }
    runRef.current += 1
    disconnectAvatar()
    const safeTurn = Math.min(Math.max(Number(saved.turnIndex) || 0, 0), script.turns.length - 1)
    smileScopeRef.current = saved.smileScope || smileScopeRef.current
    configureSmile(smileScopeRef.current)
    const activePause = Number(saved.pauseDeadlineMs) > Date.now()
    const restoredPhase = saved.phase === 'completed' ? 'completed' : activePause ? 'paused' : 'ready'
    setTurnIndex(safeTurn)
    setMessages(Array.isArray(saved.messages) ? saved.messages : [])
    setDisplayQuestion(saved.displayQuestion || script.turns[safeTurn].question)
    setPauseCount(Math.max(0, Number(saved.pauseCount) || 0))
    setPauseDeadlineMs(activePause ? Number(saved.pauseDeadlineMs) : 0)
    setPauseRemaining(activePause ? Math.ceil((Number(saved.pauseDeadlineMs) - Date.now()) / 1000) : 0)
    setPauseNotice(activePause ? saved.pauseNotice || '管理员预览已从暂停断点恢复。' : '')
    setError('')
    setPhase(restoredPhase)
    appendLog('info', 'checkpoint', 'checkpoint.restored', '已恢复管理员预览断点', {
      savedAt: saved.savedAt, turnIndex: safeTurn, restoredPhase,
    })
  }

  const clearCheckpoint = () => {
    try { window.localStorage.removeItem(CHECKPOINT_KEY) } catch { /* storage unavailable */ }
    setCheckpoint(null)
    setLastCheckpointAt(0)
    appendLog('warn', 'checkpoint', 'checkpoint.cleared', '管理员手动删除了运行断点')
  }

  const forceReady = () => {
    if (phase === 'idle' || phase === 'completed') return
    runRef.current += 1
    disconnectAvatar()
    setPauseDeadlineMs(0)
    setPauseRemaining(0)
    setPauseNotice('')
    setError('')
    setPhase('ready')
    appendLog('warn', 'intervention', 'state.forced_ready', '管理员强制将状态切换为可回答', { turnIndex })
  }

  const replayQuestion = () => {
    if (phase === 'idle' || phase === 'completed') return
    const runId = runRef.current + 1
    runRef.current = runId
    disconnectAvatar()
    setPauseDeadlineMs(0)
    setPauseRemaining(0)
    appendLog('warn', 'intervention', 'question.replayed', `管理员重新播报问题 ${turnIndex + 1}`, { turnIndex })
    askTurn(turnIndex, runId)
  }

  const jumpToTurn = value => {
    const index = Math.min(Math.max(Number(value) || 0, 0), script.turns.length - 1)
    runRef.current += 1
    disconnectAvatar()
    setPauseDeadlineMs(0)
    setPauseRemaining(0)
    setTurnIndex(index)
    setDisplayQuestion(script.turns[index].question)
    setError('')
    setPhase('ready')
    appendLog('warn', 'intervention', 'turn.jumped', `管理员跳转到问题 ${index + 1}`, { turnIndex: index })
  }

  const reconnectAvatar = async () => {
    stopExpressionAction()
    disconnectAvatar()
    setStatus('正在重新连接真人数字人')
    appendLog('info', 'intervention', 'avatar.reconnect_requested', '管理员请求重连数字人')
    try { await connect() } catch (reason) { setError(`数字人重连失败：${reason.message}`) }
  }

  const clearLogs = () => {
    setLogs([])
    try { window.localStorage.removeItem(LOG_KEY) } catch { /* storage unavailable */ }
  }

  const exportLogs = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      runtime: { phase, turnIndex, pauseCount, status, cameraStatus, sessionId: sessionRef.current || null, chain: diagnostics.stages, avatarLoading: { attempt: diagnostics.avatarLoad.attempt, status: diagnostics.avatarLoad.status, durationSeconds: diagnostics.avatarSeconds }, opening: { positionSeconds: opening.position, durationSeconds: opening.duration, outcome: opening.outcome } },
      logs,
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }))
    const anchor = window.document.createElement('a')
    anchor.href = url
    anchor.download = `管理员面试调试日志-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    appendLog('info', 'system', 'logs.exported', '已导出结构化调试日志', { count: logs.length })
  }

  const logCategories = useMemo(() => [...new Set(logs.map(item => item.category))], [logs])
  const filteredLogs = useMemo(() => logs.filter(item => {
    if (logLevel !== 'all' && item.level !== logLevel) return false
    if (logCategory !== 'all' && item.category !== logCategory) return false
    if (logQuery && !`${item.event} ${item.message} ${JSON.stringify(item.details)}`.toLowerCase().includes(logQuery.toLowerCase())) return false
    return true
  }).reverse(), [logCategory, logLevel, logQuery, logs])

  const current = script.turns[turnIndex]
  const progress = Math.round(((turnIndex + (phase === 'completed' ? 1 : 0)) / script.turns.length) * 100)
  const busy = ['starting', 'speaking', 'sending', 'acknowledging', 'pause-speaking', 'resuming'].includes(phase)
  const actionBusy = ['preloading', 'loading', 'playing'].includes(actionState)
  const actionStatus = {
    idle: '短微笑就绪 · 2.4 秒',
    preloading: '正在预载本地表情素材',
    loading: '正在准备播放表情动作',
    ready: '动作素材已就绪',
    playing: '正在播放：轻微微笑与自然眨眼',
    failed: '加载失败，已自动回退稳定数字人',
  }[actionState]

  return <section className="interview-room admin-preview-room">
    <ParticleField />
    <header className="room-header">
      <button className="back-link" onClick={onExit}><ArrowLeft />返回管理台</button>
      <div className="room-title"><span className="live-dot" /><b>管理员 · 固定剧本面试预览</b><small>{script.target_role}</small></div>
      <div className="room-header-actions">
        {phase !== 'idle' && <button
          className={`pause-trigger ${pauseDeadlineMs ? 'active' : ''}`}
          disabled={phase === 'pause-speaking' || phase === 'completed'}
          onClick={pauseDeadlineMs ? requestResume : requestPause}
        >
          {pauseDeadlineMs ? <PlayCircle /> : <PauseCircle />}
          {pauseDeadlineMs ? '继续面试' : pauseCount ? `再次暂停 · 已测试 ${pauseCount} 次` : '暂停测试'}
        </button>}
        <button className={`debug-trigger ${debugOpen ? 'active' : ''}`} onClick={() => setDebugOpen(value => !value)}><Bug />调试控制台{logs.some(item => item.level === 'error') && <i />}</button>
        <div className="room-clock"><Clock3 />{turnIndex + 1}/{script.turns.length}</div>
      </div>
    </header>

    <div className="room-stage">
      <div className="avatar-stage admin-avatar-stage">
        <video ref={avatarVideoRef} className="avatar-video-stream" autoPlay muted playsInline
          onPlaying={() => { if (avatarVideoRef.current?.srcObject && avatarVideoRef.current.videoWidth > 0) markChain('video', 'ready', '浏览器已解码并开始播放画面') }}
          onWaiting={() => { if (sessionRef.current) markChain('video', 'pending', '画面缓冲中') }}
          onError={() => markChain('video', 'error', '视频播放失败')} />
        <SmileVideo smile={smile} />
        <audio ref={avatarAudioRef} autoPlay
          onPlaying={() => { if (avatarAudioRef.current?.srcObject) markChain('audio', 'ready', '音频通道开始播放；耳机音量仍需人工确认') }}
          onWaiting={() => { if (sessionRef.current) markChain('audio', 'pending', '音频缓冲中') }}
          onError={() => markChain('audio', 'error', '音频通道播放失败')} />
        <AcknowledgmentVideo videoRef={acknowledgmentRef} state={acknowledgmentState} />
        <OpeningVideo videoRef={opening.videoRef} state={opening.state} />
        <OpeningRulesNotice opening={opening} policy={policy} admin visible={phase !== 'idle'} />
        <div className="stage-label"><span><Radio />林老师 · AI 面试官</span><b>{status}</b></div>
        {phase === 'idle' && <div className="setup-card admin-preview-welcome">
          <p className="eyebrow">零大模型费用 · 真实界面预览</p>
          <h1>{script.title}</h1>
          <p>页面结构与学生面试室保持一致，额外提供预设答案、跳过播报、快速结束和脚本进度工具。</p>
          <div className="interview-policy"><ShieldCheck /><div><b>管理员可反复暂停</b><span>每次暂停都有独立的 {Math.ceil(adminPauseSeconds / 60)} 分钟倒计时；学生正式面试仍保持一次机会，不受这里影响。</span></div></div>
          {!!checkpoint && <div className="checkpoint-resume-card"><Save /><div><b>检测到可恢复断点</b><span>{new Date(checkpoint.savedAt).toLocaleString('zh-CN')} · 问题 {(checkpoint.turnIndex || 0) + 1} · {checkpoint.phase}</span></div><button className="ghost action" onClick={restoreCheckpoint}>恢复断点</button></div>}
          <button className="primary wide" onClick={start}><Play />开始固定剧本测试</button>
        </div>}
        {phase !== 'idle' && !pauseDeadlineMs && !opening.busy && <div className="question-card">
          <>
            <span><Volume2 />固定问题 {turnIndex + 1} / {script.turns.length}</span>
            <p>{acknowledgmentBusy ? '好的。' : displayQuestion || current.question}</p>
          </>
        </div>}
        {!!pauseDeadlineMs && <div className="pause-card" role="status" aria-live="polite">
          <p className="eyebrow"><PauseCircle />管理员预览已暂停 · 第 {pauseCount} 次测试</p>
          <div className="pause-countdown"><Clock3 /><b>{formatDuration(pauseRemaining)}</b><span>界面最长保留时间</span></div>
          <p>{pauseNotice}</p>
          <button className="primary wide" disabled={phase !== 'paused'} onClick={requestResume}><PlayCircle />{phase === 'paused' ? '我回来了，继续面试' : '正在说明暂停规则…'}</button>
        </div>}
      </div>

      <aside className="candidate-panel admin-preview-tools">
        <section className={`admin-avatar-loading-summary state-${diagnostics.avatarLoad.status}`} aria-label="数字人加载计时" data-testid="avatar-load-summary" data-load-state={diagnostics.avatarLoad.status}>
          <div className="avatar-loading-heading" role="status" aria-live="polite">
            {diagnostics.avatarLoad.status === 'ready' ? <CheckCircle2 /> : ['loading', 'buffering'].includes(diagnostics.avatarLoad.status) ? <LoaderCircle className="spin" /> : <Activity />}
            <b>{({ idle: '等待连接数字人', loading: '数字人加载中', ready: '数字人加载完毕', buffering: '数字人缓冲中', failed: '数字人加载未完成', cancelled: '数字人加载已取消', disconnected: '数字人连接已中断' })[diagnostics.avatarLoad.status]}</b>
          </div>
          <div className="avatar-loading-duration"><span>{diagnostics.avatarLoad.completedAt !== null ? '用时' : ['failed', 'cancelled'].includes(diagnostics.avatarLoad.status) ? '已等待' : '已用'}</span><strong data-testid="avatar-load-seconds">{diagnostics.avatarSeconds.toFixed(diagnostics.avatarLoad.completedAt !== null ? 2 : 1)}</strong><span>秒</span></div>
          <small>{diagnostics.avatarLoad.completedAt !== null ? '本次首次加载完成耗时已固定保留' : '从本次连接开始实时计时' }{diagnostics.avatarLoad.attempt > 1 ? ` · 第 ${diagnostics.avatarLoad.attempt} 次连接` : ''}</small>
          <p>画面、音频通道及 WebRTC 就绪即完成；不等入场视频或第一题播报结束。</p>
        </section>
        <section className="admin-startup-card" aria-label="入场与链路实时监控">
          <header><b><Activity />入场与链路分段详情</b></header>
          <div className="admin-opening-clock"><span>入场视频</span><strong data-testid="opening-position">{opening.position.toFixed(1)} / {opening.duration.toFixed(2)} 秒</strong></div>
          <small data-testid="opening-outcome">{opening.busy ? '正在播放，按媒体实际进度读秒' : ({'not-started':'尚未播放',completed:'已完整播放','manual-skipped':'管理员已跳过',cancelled:'已取消'}[opening.outcome] || '未完整播放，已使用回退流程')}</small>
          {opening.busy && <button className="primary wide" type="button" onClick={opening.skip}><FastForward />跳过入场，继续第一题</button>}
          <p className={`admin-chain-summary ${diagnostics.hasError ? 'has-error' : diagnostics.ready ? 'is-ready' : ''}`} role="status" data-testid="chain-summary">
            {diagnostics.hasError ? '链路存在异常或降级，请查看下方' : diagnostics.ready ? '链路加载完成，实时播报已验证' : diagnostics.connected ? '音视频连接已就绪，实时播报待验证' : '链路尚未加载完成'}</p>
          <ul>{Object.entries(diagnostics.stages).map(([key, item]) => <li key={key} data-stage={key} data-state={item.status}>
            <span className={`chain-indicator is-${item.status}`} aria-hidden="true" /><div><b>{item.label}<em>{item.status === 'ready' ? '已就绪' : item.status === 'pending' ? '加载中' : item.status === 'idle' ? '待验证' : '异常 / 降级'}</em></b><small>{item.detail}{item.seconds != null ? ` · ${item.seconds.toFixed(1)}s` : ''}</small></div>
          </li>)}</ul>
          <small>监控范围为数字人播报链路；固定剧本不调用 DeepSeek，不包含 ASR、录制和报告生成。读秒及状态变化写入日志，可在调试控制台导出。</small>
          <button className="ghost action wide" type="button" onClick={() => {
            for (const element of [avatarVideoRef.current, avatarAudioRef.current]) {
              if (element?.srcObject) element.play().catch(reason => appendLog('warn', 'device', 'media.play_blocked', '启用音视频失败', { reason: reason.message }))
            }
          }}><Volume2 />启用音视频播放</button>
        </section>
        <div className="candidate-video">
          <video ref={candidateVideoRef} autoPlay muted playsInline />
          <span><Camera />{cameraStatus}</span>
        </div>
        <div className={`voice-state ${phase}`}>
          {busy ? <LoaderCircle className="spin" /> : phase === 'completed' ? <CheckCircle2 /> : <ShieldCheck />}
          <div><b>{phase === 'idle' ? '等待开始管理员预览' : phase === 'paused' ? `固定剧本第 ${pauseCount} 次暂停` : phase === 'completed' ? '本次预览已结束' : phase === 'ready' ? '可以发送预设回答' : '正在执行测试流程'}</b><span>状态自动保存；刷新或离开页面后可恢复断点</span></div>
        </div>

        <div className="admin-progress-card"><div><b>脚本进度</b><span>{progress}%</span></div><i><em style={{ width: `${progress}%` }} /></i><small>{script.candidate} · {script.target_role}</small></div>
        <div className={`admin-action-test-card state-${actionState}`}>
          <div className="admin-action-test-status">
            <span><PlayCircle />面试官表情测试</span>
            <small>{actionStatus}</small>
          </div>
          <button
            className="ghost action wide admin-expression-test-button"
            type="button"
            disabled={actionBusy || phase !== 'ready' || acknowledgmentBusy || Boolean(pauseDeadlineMs)}
            onClick={() => playExpressionAction('manual')}
            title="播放 2.4 秒短微笑；遵守 30 秒跨场景间隔"
          >
            {actionBusy ? <LoaderCircle className="spin" /> : <Play />}
            {actionState === 'playing' ? '正在播放短微笑' : '播放短微笑 · 2.4 秒'}
          </button>
          <button className="ghost action wide" disabled={actionBusy || phase !== 'ready' || Boolean(pauseDeadlineMs)} onClick={() => playExpressionAction('silence')}>模拟停顿安抚（静音＋字幕）</button>
          <p>短微笑不打断用户录音；正式播报、点头、暂停、退出及跳题会取消它。素材失败直接跳过，不等待补播。</p>
          <div className="smile-diagnostics" aria-label="微笑触发状态">
            <span>跨场景冷却：<b>{smile.diagnostics.globalRemaining} 秒</b></span>
            <span>停顿安抚冷却：<b>{smile.diagnostics.silenceRemaining} 秒</b></span>
            <span>本场安抚：<b>{smile.diagnostics.count} / 2 次</b> · 每题最多一次</span>
            <span>最近状态：<b>{smile.diagnostics.outcome}</b></span>
          </div>
          <div className="acknowledgment-test-controls">
            <label>回答后承接测试
              <select aria-label="回答后承接测试" value={ackTestIntent} disabled={busy || Boolean(pauseDeadlineMs)} onChange={event => setAckTestIntent(event.target.value)}>
                <option value="script">按剧本语境自动选择</option>
                <option value="acknowledge">模拟正常承接：播放好的</option>
                <option value="clarify">模拟含糊回答：不播放</option>
                <option value="challenge">模拟 Agent 质疑：不播放</option>
              </select>
            </label>
            <small>仅控制管理员固定剧本测试。正式学生面试由后端 Agent 意图与保护规则决定。</small>
          </div>
        </div>
        {phase !== 'idle' && phase !== 'completed' && <div className="preset-answer-card">
          <div><span>管理员预设学生回答</span><small>{current.answer.length} 字</small></div>
          <p>{current.answer}</p>
        </div>}
        {error && <p className="form-error" role="alert">{error}</p>}

        <div className="admin-script-actions admin-preview-actions">
          {phase === 'ready' && <button className="primary wide start-answer-button" onClick={sendPresetAnswer}><Send />发送这段预设回答</button>}
          {phase === 'speaking' && !opening.busy && <button className="ghost action wide" onClick={skipSpeaking}><FastForward />跳过当前播报</button>}
          {phase === 'paused' && <button className="primary wide" onClick={requestResume}><PlayCircle />我回来了，继续面试</button>}
          {!['idle', 'completed'].includes(phase) && <button className="end-interview" onClick={completePreview}><CircleStop />快速结束本次预览</button>}
          {phase === 'completed' && <div className="script-completed"><CheckCircle2 /><b>管理员预览已结束</b><span>可重置剧本，再次测试完整流程。</span></div>}
          {phase === 'completed' && <button className="ghost action wide" onClick={restart}><RotateCcw />重置剧本与运行断点</button>}
        </div>

        {!!messages.length && <details className="admin-script-transcript"><summary>查看最近对话与测试记录</summary>{messages.slice(-5).map((item, index) => <p key={`${item.speaker}-${index}`}><span>{item.speaker === 'interviewer' ? '面试官' : '学生'}</span>{item.content}</p>)}</details>}
      </aside>
    </div>
    {debugOpen && <div className="admin-debug-backdrop" onMouseDown={event => event.target === event.currentTarget && setDebugOpen(false)}>
      <aside className="admin-debug-drawer" aria-label="管理员调试控制台">
        <header><div><p className="eyebrow"><Activity />运行监控</p><h2>管理员调试控制台</h2><span>只记录运行事件，不混入产品修改说明和面试对话。</span></div><button className="icon-button" onClick={() => setDebugOpen(false)} aria-label="关闭调试控制台"><X /></button></header>

        <section className="debug-runtime-grid">
          <article><span>状态</span><b data-phase={phase}>{phase}</b></article>
          <article><span>当前问题</span><b>{turnIndex + 1} / {script.turns.length}</b></article>
          <article><span>暂停次数</span><b>{pauseCount}</b></article>
          <article><span>数字人</span><b>{sessionRef.current ? '已建立会话' : '未连接'}</b></article>
          <article><span>断点时间</span><b>{lastCheckpointAt ? formatLogTime(lastCheckpointAt) : '暂无'}</b></article>
          <article><span>错误数</span><b>{logs.filter(item => item.level === 'error').length}</b></article>
        </section>

        <section className="debug-section">
          <div className="debug-section-title"><div><Save /><span><b>状态与断点</b><small>自动保存题号、阶段、对话和暂停倒计时</small></span></div>{checkpoint && <button onClick={clearCheckpoint}><Trash2 />删除断点</button>}</div>
          <div className="checkpoint-status"><i className={checkpoint ? 'ok' : ''} /><span>{checkpoint ? `已保存：${new Date(checkpoint.savedAt).toLocaleString('zh-CN')}` : '暂无可恢复断点'}</span>{checkpoint && <button onClick={restoreCheckpoint}>恢复</button>}</div>
        </section>

        <section className="debug-section">
          <div className="debug-section-title"><div><ShieldCheck /><span><b>人工干预</b><small>操作会写入 intervention 类日志</small></span></div></div>
          <label className="debug-turn-select"><span>跳转问题</span><select value={turnIndex} disabled={phase === 'idle'} onChange={event => jumpToTurn(event.target.value)}>{script.turns.map((turn, index) => <option value={index} key={turn.id || index}>问题 {index + 1} · {turn.question.slice(0, 18)}</option>)}</select></label>
          <div className="debug-interventions">
            <button disabled={phase === 'idle' || phase === 'completed'} onClick={forceReady}><CheckCircle2 />强制可回答</button>
            <button disabled={phase === 'idle' || phase === 'completed'} onClick={replayQuestion}><Volume2 />重播当前问题</button>
            <button onClick={reconnectAvatar}><RefreshCw />重连数字人</button>
            <button disabled={!error} onClick={() => { setError(''); appendLog('info', 'intervention', 'error.cleared', '管理员清除了界面错误') }}><X />清除错误</button>
          </div>
        </section>

        <section className="debug-section debug-log-section">
          <div className="debug-section-title"><div><Bug /><span><b>结构化运行日志</b><small>{filteredLogs.length} / {logs.length} 条，最多保留 {MAX_LOGS} 条</small></span></div><div><button onClick={exportLogs} disabled={!logs.length}><Download />导出</button><button onClick={clearLogs} disabled={!logs.length}><Trash2 />清空</button></div></div>
          <div className="debug-log-filters">
            <label><Filter /><select value={logLevel} onChange={event => setLogLevel(event.target.value)}><option value="all">全部级别</option><option value="info">信息</option><option value="warn">警告</option><option value="error">错误</option></select></label>
            <select value={logCategory} onChange={event => setLogCategory(event.target.value)}><option value="all">全部模块</option>{logCategories.map(category => <option value={category} key={category}>{category}</option>)}</select>
            <input value={logQuery} onChange={event => setLogQuery(event.target.value)} placeholder="搜索事件、说明或详情" />
          </div>
          <div className="debug-log-list">
            {!filteredLogs.length && <p className="debug-empty">当前筛选条件下没有日志。</p>}
            {filteredLogs.map(item => <article className={`log-${item.level}`} key={item.id}>
              <div><time>{formatLogTime(item.timestamp)}</time><b>{item.level.toUpperCase()}</b><span>{item.category}</span><code>{item.event}</code></div>
              <p>{item.message}</p>
              {!!Object.keys(item.details || {}).length && <details><summary>事件详情</summary><pre>{JSON.stringify(item.details, null, 2)}</pre></details>}
            </article>)}
          </div>
        </section>
      </aside>
    </div>}
    <div className="room-footnote">管理员预览使用本地固定脚本；支持多次暂停、状态断点和结构化监控，但不会生成学生面试记录。</div>
  </section>
}
