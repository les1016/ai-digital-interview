import { avatarFetch, avatarSocket } from './api'
import { useCallback, useEffect, useRef, useState } from 'react'
import './answerCorrections.css'
import {
  ArrowLeft, BarChart3, BriefcaseBusiness, Camera, CheckCircle2, CircleStop, Clock3, LoaderCircle,
  Download, FileText, FileType2, Hourglass, MessageSquareText, Mic, MicOff, PauseCircle, PhoneOff, PlayCircle, Printer, Radio, ShieldCheck, Sparkles, Target, Volume2,
} from 'lucide-react'
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { api, apiBlob, apiKeepalive } from './api'
import useAcknowledgment, { AcknowledgmentVideo } from './useAcknowledgment'
import { afterAcknowledgment, shouldAcknowledge } from './acknowledgmentPolicy'
import useOpeningVideo, { OpeningVideo } from './useOpeningVideo'
import OpeningRulesNotice from './OpeningRulesNotice'
import { openingPolicyMatches, openingQuestionAfterVideo } from './openingPolicy'
import { createAvatarActionCoordinator } from './avatarActionCoordinator'
import useSmileAction, { SmileVideo } from './useSmileAction'

const LIVETALKING_BASE = new URL(
  import.meta.env.VITE_LIVETALKING_URL
    || (['127.0.0.1', 'localhost', '::1'].includes(window.location.hostname) ? 'http://127.0.0.1:8010' : '/avatar'),
  window.location.origin,
).toString().replace(/\/+$/, '')
const sleep = delay => new Promise(resolve => window.setTimeout(resolve, delay))
const createRequestId = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
const ANSWER_INITIAL_GRACE_MS = Number(import.meta.env.VITE_ANSWER_INITIAL_GRACE_MS || 10000)
const ANSWER_IDLE_GRACE_MS = Number(import.meta.env.VITE_ANSWER_IDLE_GRACE_MS || 12000)
const ANSWER_END_COUNTDOWN_SECONDS = 5

const formatDuration = totalSeconds => {
  const safe = Math.max(0, Math.ceil(totalSeconds || 0))
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`
}

async function postControlWithRetry(path, body, attempts = 10) {
  let lastReason = null
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await api(path, { method: 'POST', body: JSON.stringify(body) })
    } catch (reason) {
      lastReason = reason
      if (reason.status !== 409 || attempt === attempts) throw reason
      await sleep(350 * attempt)
    }
  }
  throw lastReason
}

function downsampleTo16k(input, inputRate) {
  if (inputRate === 16000) return input
  const ratio = inputRate / 16000
  const length = Math.round(input.length / ratio)
  const output = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j += 1) sum += input[j]
    output[i] = sum / Math.max(1, end - start)
  }
  return output
}

function toPcm16(float32) {
  const pcm = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]))
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return pcm.buffer
}

export function ReportView({ report, messages = [], interviewId = null, onExit }) {
  const dimensions = Object.entries(report.dimensions || {})
  const recommendedRoles = report.recommended_roles || []
  const targetMatch = report.target_match
  const conversation = report.conversation_summary || {}
  const [exportFormat, setExportFormat] = useState('pdf')
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const [generatedDocument, setGeneratedDocument] = useState(null)

  const generateDocument = async () => {
    if (!interviewId || exporting) return
    setExporting(true)
    setExportError('')
    try {
      const document = await api(`/interviews/${interviewId}/documents`, {
        method: 'POST',
        body: JSON.stringify({ format: exportFormat }),
        timeout: 120000,
      })
      const blob = await apiBlob(document.download_path, { timeout: 120000 })
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = `AI数字人面试-成长报告与对话摘要.${exportFormat}`
      window.document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setGeneratedDocument(document)
    } catch (reason) {
      setExportError(reason.message)
    } finally {
      setExporting(false)
    }
  }

  return <section className="interview-report">
    <div className="report-summary">
      <div>
        <p className="eyebrow"><Sparkles />本次练习已完成</p>
        <h1>你的面试成长报告</h1>
        <p>{report.summary}</p>
      </div>
      <div className="report-score"><b>{report.overall_score ?? 0}</b><span>综合表现 / 100</span></div>
    </div>
    {targetMatch && <article className="target-match-card">
      <div className="target-match-score"><span>目标岗位匹配度</span><b>{targetMatch.score ?? 0}<small>%</small></b><em>{targetMatch.target}</em></div>
      <div className="target-match-detail">
        <p>{targetMatch.evidence}</p>
        <div><section><b>已经匹配的要求</b><ul>{(targetMatch.matched_requirements || []).map(item => <li key={item}><CheckCircle2 />{item}</li>)}</ul></section>
        <section><b>仍需补齐的差距</b><ul>{(targetMatch.gaps || []).map(item => <li key={item}><Target />{item}</li>)}</ul></section></div>
      </div>
    </article>}
    <div className="report-grid">
      <article className="report-panel dimensions">
        <h2><BarChart3 />能力维度</h2>
        {dimensions.map(([name, item]) => <div className="dimension-row" key={name}>
          <div><span>{name}</span><b>{item.score}</b></div>
          <i><em style={{ width: `${Math.max(0, Math.min(100, item.score || 0))}%` }} /></i>
          <p>{item.evidence}</p>
        </div>)}
      </article>
      <article className="report-panel">
        <h2>做得好的地方</h2>
        <ul>{(report.highlights || []).map(item => <li key={item}><CheckCircle2 />{item}</li>)}</ul>
        <h2>下一步提升</h2>
        <p className="growth-reassurance">你已经完成了最难的一步：真实表达。下面这些不是否定，而是让下一次回答更有说服力的训练方向。</p>
        <ul className="improvement-list">{(report.improvements || []).map(item => <li key={item}><Target />{item}</li>)}</ul>
      </article>
      <article className="report-panel">
        <h2>情绪与状态调节建议</h2>
        <ul>{(report.emotion_guidance || []).map(item => <li key={item}>{item}</li>)}</ul>
      </article>
      <article className="report-panel">
        <h2>行动计划</h2>
        <ol>{(report.action_plan || []).map(item => <li key={item}>{String(item).replace(/^\s*\d+(?:\.\d+)*[.、：:)]?\s*/, '')}</li>)}</ol>
      </article>
      <article className="report-panel report-wide">
        <h2><BriefcaseBusiness />推荐探索岗位</h2>
        <div className="role-recommendations">
          {recommendedRoles.length
            ? recommendedRoles.map(item => <div className="role-card" key={item.role}>
              <div><b>{item.role}</b><span>匹配参考 {item.fit ?? '—'}%</span></div>
              <p>{item.reason}</p>
            </div>)
            : <p className="muted">本次报告暂未生成岗位推荐。</p>}
        </div>
      </article>
      {conversation.overview && <article className="report-panel report-wide conversation-summary-panel">
        <div className="summary-heading">
          <div><p className="eyebrow"><MessageSquareText />独家复盘</p><h2>面试对话记录摘要</h2></div>
          <span>{conversation.dialogue_digest?.length || 0} 轮有效问答</span>
        </div>
        <p className="conversation-overview">{conversation.overview}</p>
        {!!conversation.key_topics?.length && <div className="topic-cloud">{conversation.key_topics.map(item => <span key={item}>{item}</span>)}</div>}
        <div className="digest-list">
          {(conversation.dialogue_digest || []).map((item, index) => <article key={`${item.question}-${index}`}>
            <span className="digest-index">{String(index + 1).padStart(2, '0')}</span>
            <div><b>{item.question}</b><p>{item.answer_summary}</p><em>训练建议：{item.coaching_note}</em></div>
          </article>)}
        </div>
        {conversation.communication_pattern && <div className="communication-note"><b>表达节奏观察</b><p>{conversation.communication_pattern}</p></div>}
      </article>}
      {interviewId && <article className="report-panel report-wide export-studio">
        <div className="export-studio-copy">
          <p className="eyebrow"><FileText />带走你的完整复盘</p>
          <h2>一键生成合并文档</h2>
          <p>文档已按阅读顺序排好：先看面试结果，再看专属对话摘要。选择一种常用格式即可下载。</p>
          <div className="document-order"><span><b>01</b> 面试结果</span><i /><span><b>02</b> 对话摘要</span></div>
        </div>
        <div className="export-controls">
          <div className="format-choices" role="radiogroup" aria-label="导出格式">
            <button className={exportFormat === 'pdf' ? 'selected' : ''} onClick={() => setExportFormat('pdf')} role="radio" aria-checked={exportFormat === 'pdf'}>
              <FileText /><span><b>PDF</b><small>版式固定，适合提交与打印</small></span>
            </button>
            <button className={exportFormat === 'docx' ? 'selected' : ''} onClick={() => setExportFormat('docx')} role="radio" aria-checked={exportFormat === 'docx'}>
              <FileType2 /><span><b>Word</b><small>可继续编辑，适合个人复盘</small></span>
            </button>
          </div>
          <button className="primary export-button" onClick={generateDocument} disabled={exporting}>
            {exporting ? <LoaderCircle className="spin" /> : <Download />}{exporting ? '正在排版生成…' : `生成并下载 ${exportFormat === 'pdf' ? 'PDF' : 'Word'}`}
          </button>
          {generatedDocument && <p className="export-success"><CheckCircle2 />已生成 {generatedDocument.format_label}，管理员平台也可查看此版本。</p>}
          {exportError && <p className="form-error">{exportError}</p>}
        </div>
      </article>}
      {messages.length > 0 && <article className="report-panel report-wide transcript-panel">
        <h2>完整面试问答</h2>
        <p className="muted">保留原始问答，便于对照能力维度中的证据与改进建议。</p>
        <div className="report-transcript">
          {messages.map((item, index) => <div className={`transcript-item ${item.speaker}`} key={`${item.speaker}-${index}`}>
            <b>{item.speaker === 'interviewer' ? 'AI 面试官' : '我'}</b>
            <p>{item.content}</p>
            {item.corrected && <p className="correction-audit"><b>已更正 · 当前依据</b>{item.effective_content}</p>}
            {item.kind?.startsWith('correction_') && <small className="muted">更正确认记录，不作为独立答题评分</small>}
          </div>)}
        </div>
      </article>}
    </div>
    {report.generation_notice && <p className="form-error notice" role="status">{report.generation_notice}</p>}
    {report._local_warning && <p className="form-error notice">{report._local_warning}</p>}
    <p className="report-disclaimer">{report.disclaimer}</p>
    <div className="report-actions">
      <button className="ghost action" onClick={() => window.print()}><Printer />打印当前页面</button>
      {onExit && <button className="primary" onClick={onExit}>保存记录并返回工作台</button>}
    </div>
  </section>
}

export default function InterviewRoom({ resume, existingInterview = null, mediaStream, policy = null, onExit }) {
  const candidateVideoRef = useRef(null)
  const candidateMobileVideoRef = useRef(null)
  const avatarVideoRef = useRef(null)
  const avatarAudioRef = useRef(null)
  const [actionCoordinator] = useState(createAvatarActionCoordinator)
  const replyIntentRef = useRef('neutral')
  const smile = useSmileAction({ coordinator: actionCoordinator })
  const { play: playSmile, stop: stopSmile, configure: configureSmile } = smile
  const peerRef = useRef(null)
  const sessionRef = useRef('')
  const audioContextRef = useRef(null)
  const audioSourceRef = useRef(null)
  const processorRef = useRef(null)
  const asrSocketRef = useRef(null)
  const asrTimeoutRef = useRef(null)
  const asrMaxDurationRef = useRef(null)
  const silenceMonitorRef = useRef(null)
  const openingClockRef = useRef(null)
  const answerActivityRef = useRef(null)
  const finishingSpeechRef = useRef(false)
  const speechTurnRef = useRef(0)
  const recorderRef = useRef(null)
  const recordingUploadedRef = useRef(false)
  const recordingUploadIdRef = useRef('')
  const recordingChunkIndexRef = useRef(0)
  const recordingPendingChunksRef = useRef(new Map())
  const recordingUploadChainRef = useRef(Promise.resolve())
  const recordingEnqueueRef = useRef(null)
  const recordingStoppingRef = useRef(false)
  const recordingFinalQueuedRef = useRef(false)
  const transcriptHandlerRef = useRef(null)
  const noInputHandlerRef = useRef(null)
  const pendingAnswerRef = useRef(null)
  const interruptionSessionIdRef = useRef('')
  const interruptionSessionTokenRef = useRef('')
  const timerRef = useRef(null)
  const pauseTimerRef = useRef(null)
  const pauseActiveRef = useRef(false)
  const pauseRequestPendingRef = useRef(false)
  const resumeRequestPendingRef = useRef(false)
  const resumeHandlerRef = useRef(null)
  const behaviorTimerRef = useRef(null)
  const behaviorRunRef = useRef(0)
  const faceLandmarkerRef = useRef(null)
  const startRequestIdRef = useRef(createRequestId())
  const startingRef = useRef(false)
  const submittingRef = useRef(false)
  const finishingRef = useRef(false)
  const exitingRef = useRef(false)
  const operationGenerationRef = useRef(0)
  const behaviorMetricsRef = useRef({
    samples: 0, faceFrames: 0, centeredFrames: 0, headAwayFrames: 0,
    highMovementFrames: 0, blinkCount: 0, blinkActive: false, previousNose: null,
  })

  const [phase, setPhase] = useState('setup')
  const [targetRole, setTargetRole] = useState(existingInterview?.job_description || existingInterview?.target_role || '')
  const [interview, setInterview] = useState(null)
  const [messages, setMessages] = useState([])
  const [correction, setCorrection] = useState(null)
  const [question, setQuestion] = useState('')
  const [transcript, setTranscript] = useState('')
  const [questionCount, setQuestionCount] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [avatarStatus, setAvatarStatus] = useState('连接中')
  const [interviewerPresent, setInterviewerPresent] = useState(false)
  const [error, setError] = useState('')
  const [report, setReport] = useState(null)
  const [behaviorStatus, setBehaviorStatus] = useState('待开始')
  const [silenceCountdown, setSilenceCountdown] = useState(null)
  const [pauseUsed, setPauseUsed] = useState(Boolean(existingInterview?.pause_used))
  const [pauseRemaining, setPauseRemaining] = useState(existingInterview?.pause_remaining_seconds || 0)
  const policyThreshold = Number(policy?.threshold || 3)
  const policyWarningCount = Math.max(1, policyThreshold - 1)
  const policyWindowHours = Math.max(1, Math.ceil(Number(policy?.window_seconds || 86400) / 3600))
  const policyCooldownMinutes = Math.max(1, Math.ceil(Number(policy?.cooldown_seconds || 1800) / 60))
  const policyPauseMinutes = Math.max(1, Math.ceil(Number(policy?.pause_max_seconds || 600) / 60))
  const [pauseDeadlineMs, setPauseDeadlineMs] = useState(0)
  const [pauseNotice, setPauseNotice] = useState('')
  const [openingWait, setOpeningWait] = useState(0)
  const opening = useOpeningVideo({ avatarAudioRef, avatarVideoRef, coordinator: actionCoordinator,
    onEvent: event => { if (event === 'started') setInterviewerPresent(true) },
  })
  const stopOpening = opening.stop
  const { videoRef: acknowledgmentRef, state: acknowledgmentState,
    play: playAcknowledgment, stop: stopAcknowledgment, busy: acknowledgmentBusy } = useAcknowledgment({ avatarAudioRef, avatarVideoRef, coordinator: actionCoordinator })

  const cancelInteractiveWork = useCallback(() => {
    actionCoordinator.cancelAll()
    window.clearInterval(openingClockRef.current)
    stopOpening()
    stopAcknowledgment()
    clearTimeout(asrTimeoutRef.current)
    clearTimeout(asrMaxDurationRef.current)
    clearInterval(silenceMonitorRef.current)
    asrTimeoutRef.current = null
    asrMaxDurationRef.current = null
    silenceMonitorRef.current = null
    answerActivityRef.current = null
    setSilenceCountdown(null)
    finishingSpeechRef.current = false
    const socket = asrSocketRef.current
    asrSocketRef.current = null
    socket?.close()
    if (processorRef.current) processorRef.current.onaudioprocess = null
    processorRef.current?.disconnect()
    audioSourceRef.current?.disconnect()
    processorRef.current = null
    audioSourceRef.current = null
    audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
    speechTurnRef.current += 1
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
  }, [stopAcknowledgment, stopOpening, actionCoordinator])

  const releaseRealtimeResources = useCallback(() => {
    cancelInteractiveWork()
    mediaStream?.getTracks().forEach(track => track.stop())
    if (candidateVideoRef.current) candidateVideoRef.current.srcObject = null
    if (candidateMobileVideoRef.current) candidateMobileVideoRef.current.srcObject = null
  }, [cancelInteractiveWork, mediaStream])

  useEffect(() => {
    if (candidateVideoRef.current && mediaStream) candidateVideoRef.current.srcObject = mediaStream
    if (candidateMobileVideoRef.current && mediaStream) candidateMobileVideoRef.current.srcObject = mediaStream
    const handleTrackEnded = () => {
      setError('摄像头或麦克风连接已中断，请保存当前录像并返回设备检测。')
      setPhase(current => ['report', 'reporting'].includes(current) ? current : 'device-lost')
      cancelInteractiveWork()
    }
    mediaStream?.getTracks().forEach(track => track.addEventListener('ended', handleTrackEnded))
    return () => {
      operationGenerationRef.current += 1
      clearInterval(timerRef.current)
      clearInterval(pauseTimerRef.current)
      clearInterval(silenceMonitorRef.current)
      clearInterval(behaviorTimerRef.current)
      faceLandmarkerRef.current?.close()
      behaviorRunRef.current += 1
      cancelInteractiveWork()
      const recorder = recorderRef.current
      if (recorder?.state === 'recording') {
        recordingStoppingRef.current = true
        recorder.stop()
      }
      mediaStream?.getTracks().forEach(track => track.removeEventListener('ended', handleTrackEnded))
      mediaStream?.getTracks().forEach(track => track.stop())
    }
  }, [cancelInteractiveWork, mediaStream])

  useEffect(() => {
    if (!interview || report) return undefined
    const warnBeforeUnload = event => {
      const avatarSessionId = sessionRef.current
      if (avatarSessionId) {
        avatarFetch(`${LIVETALKING_BASE}/api/session/close`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionid: avatarSessionId }),
          keepalive: true,
        }).catch(() => {})
      }
      if (interruptionSessionIdRef.current && interruptionSessionTokenRef.current && !['paused', 'can-finish', 'reporting', 'report-failed', 'pause-expired', 'invalid-ended'].includes(phase)) {
        apiKeepalive(`/interviews/${interview.id}/interruptions`, {
          session_id: interruptionSessionIdRef.current,
          session_token: interruptionSessionTokenRef.current,
          reason: phase === 'device-lost' ? 'device_lost' : 'page_unload',
        })
      }
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [interview, phase, report])

  const startBehaviorTracking = useCallback(async () => {
    const runId = behaviorRunRef.current + 1
    behaviorRunRef.current = runId
    try {
      setBehaviorStatus('模型加载中')
      const vision = await FilesetResolver.forVisionTasks('/mediapipe-wasm')
      const landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/models/face_landmarker.task' },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.5,
        minFacePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
        outputFaceBlendshapes: true,
      })
      if (behaviorRunRef.current !== runId) {
        landmarker.close()
        return
      }
      faceLandmarkerRef.current = landmarker
      behaviorMetricsRef.current = {
        samples: 0, faceFrames: 0, centeredFrames: 0, headAwayFrames: 0,
        highMovementFrames: 0, blinkCount: 0, blinkActive: false, previousNose: null,
      }
      setBehaviorStatus('采集中')
      behaviorTimerRef.current = window.setInterval(() => {
        if (pauseActiveRef.current) return
        const video = candidateVideoRef.current
        if (!video || video.readyState < 2) return
        try {
          const metrics = behaviorMetricsRef.current
          metrics.samples += 1
          const result = landmarker.detectForVideo(video, performance.now())
          const points = result.faceLandmarks?.[0]
          if (!points?.length) return
          metrics.faceFrames += 1
          const xs = points.map(point => point.x)
          const ys = points.map(point => point.y)
          const centerX = (Math.min(...xs) + Math.max(...xs)) / 2
          const centerY = (Math.min(...ys) + Math.max(...ys)) / 2
          if (Math.abs(centerX - 0.5) < 0.16 && Math.abs(centerY - 0.48) < 0.2) metrics.centeredFrames += 1

          const nose = points[1]
          const leftEye = points[33]
          const rightEye = points[263]
          const eyeDistance = Math.max(0.001, Math.abs(rightEye.x - leftEye.x))
          const yawProxy = (nose.x - (leftEye.x + rightEye.x) / 2) / eyeDistance
          if (Math.abs(yawProxy) > 0.3) metrics.headAwayFrames += 1
          if (metrics.previousNose && Math.hypot(nose.x - metrics.previousNose.x, nose.y - metrics.previousNose.y) > 0.035) {
            metrics.highMovementFrames += 1
          }
          metrics.previousNose = { x: nose.x, y: nose.y }

          const shapes = Object.fromEntries((result.faceBlendshapes?.[0]?.categories || []).map(item => [item.categoryName, item.score]))
          const blinking = ((shapes.eyeBlinkLeft || 0) + (shapes.eyeBlinkRight || 0)) / 2 > 0.55
          if (blinking && !metrics.blinkActive) metrics.blinkCount += 1
          metrics.blinkActive = blinking
        } catch {
          // 单帧识别异常不应中断整场面试。
        }
      }, 500)
    } catch {
      if (behaviorRunRef.current === runId) setBehaviorStatus('暂不可用')
    }
  }, [])

  const stopBehaviorTrackingAndUpload = useCallback(async interviewId => {
    behaviorRunRef.current += 1
    clearInterval(behaviorTimerRef.current)
    behaviorTimerRef.current = null
    faceLandmarkerRef.current?.close()
    faceLandmarkerRef.current = null
    const metrics = behaviorMetricsRef.current
    if (!metrics.samples) {
      setBehaviorStatus('未采集')
      return
    }
    const faceDenominator = Math.max(1, metrics.faceFrames)
    const sampleDenominator = Math.max(1, metrics.samples)
    const payload = {
      sample_count: metrics.samples,
      face_presence_ratio: metrics.faceFrames / sampleDenominator,
      centered_ratio: metrics.centeredFrames / faceDenominator,
      head_away_ratio: metrics.headAwayFrames / faceDenominator,
      high_movement_ratio: metrics.highMovementFrames / faceDenominator,
      blink_count: metrics.blinkCount,
    }
    await api(`/interviews/${interviewId}/behavior`, { method: 'POST', body: JSON.stringify(payload) })
    setBehaviorStatus('已保存')
  }, [])

  const connectAvatar = useCallback(async () => {
    if (sessionRef.current && peerRef.current && peerRef.current.connectionState !== 'closed') return
    setAvatarStatus('连接中')
    const pc = new RTCPeerConnection({ sdpSemantics: 'unified-plan' })
    peerRef.current = pc
    try {
      pc.addTransceiver('video', { direction: 'recvonly' })
      pc.addTransceiver('audio', { direction: 'recvonly' })
      pc.addEventListener('track', event => {
        if (event.track.kind === 'video' && avatarVideoRef.current) avatarVideoRef.current.srcObject = event.streams[0]
        if (event.track.kind === 'audio' && avatarAudioRef.current) avatarAudioRef.current.srcObject = event.streams[0]
      })
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected') setAvatarStatus('在线')
        if (['failed', 'disconnected'].includes(pc.connectionState)) setAvatarStatus('连接中断')
      })
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      if (pc.iceGatheringState !== 'complete') {
        await new Promise((resolve, reject) => {
          const timeout = window.setTimeout(() => {
            pc.removeEventListener('icegatheringstatechange', listener)
            reject(new Error('数字人连接准备超时'))
          }, 7000)
          const listener = () => {
            if (pc.iceGatheringState === 'complete') {
              window.clearTimeout(timeout)
              pc.removeEventListener('icegatheringstatechange', listener)
              resolve()
            }
          }
          pc.addEventListener('icegatheringstatechange', listener)
        })
      }
      const response = await avatarFetch(`${LIVETALKING_BASE}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sdp: pc.localDescription.sdp,
          type: pc.localDescription.type,
        }),
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error('数字人视频连接失败')
      const answer = await response.json()
      if (!answer.sdp) throw new Error(answer.msg || '数字人视频连接失败')
      sessionRef.current = String(answer.sessionid || '')
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    } catch (reason) {
      pc.close()
      if (peerRef.current === pc) peerRef.current = null
      sessionRef.current = ''
      throw reason
    }
  }, [])

  useEffect(() => {
    let active = true
    connectAvatar().catch(() => {
      if (active) setAvatarStatus('真人数字人暂未连接')
    })
    return () => { active = false }
  }, [connectAvatar])

  const avatarIsSpeaking = useCallback(async () => {
    const response = await avatarFetch(`${LIVETALKING_BASE}/is_speaking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionid: sessionRef.current }),
      signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) throw new Error('无法读取数字人播报状态')
    const result = await response.json()
    return result.data === true
  }, [])

  const waitForAvatarSpeechEnd = useCallback(async (text, turnId) => {
    const startDeadline = Date.now() + 20000
    let started = false
    try {
      while (Date.now() < startDeadline && speechTurnRef.current === turnId) {
        if (await avatarIsSpeaking()) {
          started = true
          setInterviewerPresent(true)
          break
        }
        await sleep(250)
      }

      if (speechTurnRef.current !== turnId) return
      if (!started) throw new Error('数字人未输出语音')

      const finishDeadline = Date.now() + Math.max(180000, text.length * 1000)
      let quietSince = 0
      while (Date.now() < finishDeadline && speechTurnRef.current === turnId) {
        const speaking = await avatarIsSpeaking()
        if (speaking) {
          quietSince = 0
        } else if (!quietSince) {
          quietSince = Date.now()
        } else if (Date.now() - quietSince >= 1400) {
          return
        }
        await sleep(250)
      }
    } catch {
      // 状态接口异常时采用保守回退，避免界面永久锁死。
      await sleep(Math.max(3200, text.length * 190))
    }
  }, [avatarIsSpeaking])

  const speakWithBrowser = useCallback((text, turnId) => new Promise(resolve => {
    const fallbackDuration = Math.max(3200, Math.min(30000, text.length * 210))
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      window.setTimeout(resolve, fallbackDuration)
      return
    }
    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    utterance.rate = 0.94
    utterance.pitch = 1
    const voices = window.speechSynthesis.getVoices()
    utterance.voice = voices.find(voice => /^zh(-|_)?CN/i.test(voice.lang))
      || voices.find(voice => /^zh/i.test(voice.lang))
      || null
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    const timer = window.setTimeout(finish, fallbackDuration + 5000)
    utterance.onend = () => {
      window.clearTimeout(timer)
      finish()
    }
    utterance.onerror = () => {
      window.clearTimeout(timer)
      finish()
    }
    if (speechTurnRef.current !== turnId) {
      window.clearTimeout(timer)
      finish()
      return
    }
    setInterviewerPresent(true)
    window.speechSynthesis.speak(utterance)
  }), [])

  const speak = useCallback(async (text, nextPhase = 'ready', spokenText = text) => {
    stopAcknowledgment()
    actionCoordinator.cancelAll()
    const speechLease = actionCoordinator.acquire({ owner: 'speech', priority: 100, cancel: () => {} })
    const turnId = speechTurnRef.current + 1
    speechTurnRef.current = turnId
    setPhase('speaking')
    setQuestion(text)
    try {
      if (!sessionRef.current) await connectAvatar()
      if (speechTurnRef.current !== turnId) return
      const response = await avatarFetch(`${LIVETALKING_BASE}/human`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: spokenText, type: 'echo', interrupt: true, sessionid: sessionRef.current }),
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) throw new Error('数字人播报请求失败')
      await waitForAvatarSpeechEnd(spokenText, turnId)
    } catch {
      if (speechTurnRef.current !== turnId) return
      setAvatarStatus('本地语音模式')
      setInterviewerPresent(true)
      await speakWithBrowser(spokenText, turnId)
    } finally { speechLease?.release() }
    if (speechTurnRef.current === turnId) {
      setPhase(current => current === 'speaking' ? nextPhase : current)
    }
  }, [connectAvatar, speakWithBrowser, stopAcknowledgment, waitForAvatarSpeechEnd, actionCoordinator])

  const startElapsedClock = useCallback(() => {
    clearInterval(timerRef.current)
    timerRef.current = window.setInterval(() => setElapsed(value => value + 1), 1000)
  }, [])

  const uploadRecordingChunk = useCallback(async (interviewId, index, blob, final) => {
    const maxAttempts = final ? 4 : 3
    let lastReason = null
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const form = new FormData()
        form.append('file', blob, `interview-${interviewId}-part-${index}.webm`)
        const params = new URLSearchParams({
          upload_id: recordingUploadIdRef.current,
          index: String(index),
          final: String(final),
        })
        await api(`/interviews/${interviewId}/recording/chunks?${params}`, {
          method: 'POST',
          body: form,
          timeout: 120000,
        })
        return
      } catch (reason) {
        lastReason = reason
        const retryable = reason?.retryable || reason?.code === 'network_error' || reason?.code === 'timeout' || reason?.status === 409
        if (!retryable || attempt === maxAttempts) throw reason
        await sleep(700 * attempt)
      }
    }
    throw lastReason
  }, [])

  const startRecording = useCallback(interviewId => {
    if (!mediaStream || !window.MediaRecorder) {
      recorderRef.current = null
      recordingEnqueueRef.current = null
      recordingUploadedRef.current = true
      setError('当前浏览器不支持面试录像，但问答和报告仍可正常完成。')
      return
    }
    try {
      const candidates = [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm',
      ]
      const mimeType = candidates.find(type => MediaRecorder.isTypeSupported?.(type))
      if (!mimeType) throw new Error('WebM recording is unavailable')
      const recorder = new MediaRecorder(mediaStream, { mimeType })
      recordingUploadedRef.current = false
      recordingUploadIdRef.current = createRequestId()
      recordingChunkIndexRef.current = 0
      recordingPendingChunksRef.current = new Map()
      recordingUploadChainRef.current = Promise.resolve()
      recordingStoppingRef.current = false
      recordingFinalQueuedRef.current = false

      const enqueue = (blob, final) => {
        const index = recordingChunkIndexRef.current
        recordingChunkIndexRef.current += 1
        recordingPendingChunksRef.current.set(index, { blob, final })
        if (final) recordingFinalQueuedRef.current = true
        const upload = async () => {
          const pending = recordingPendingChunksRef.current.get(index)
          if (!pending) return
          await uploadRecordingChunk(interviewId, index, pending.blob, pending.final)
          recordingPendingChunksRef.current.delete(index)
        }
        recordingUploadChainRef.current = recordingUploadChainRef.current
          .then(upload, upload)
          .catch(() => {})
      }
      recordingEnqueueRef.current = enqueue
      recorder.ondataavailable = event => {
        if (event.data.size) enqueue(event.data, false)
      }
      recorder.onstop = () => {
        if (!recordingFinalQueuedRef.current) {
          enqueue(new Blob([], { type: 'video/webm' }), true)
        }
      }
      recorder.onerror = () => setError('本次录像暂不可用，但问答和报告仍可正常完成。')
      recorder.start(30000)
      recorderRef.current = recorder
    } catch {
      recorderRef.current = null
      recordingEnqueueRef.current = null
      recordingUploadedRef.current = true
      setError('当前浏览器不支持面试录像，但问答和报告仍可正常完成。')
    }
  }, [mediaStream, uploadRecordingChunk])

  const stopRecordingAndUpload = useCallback(async interviewId => {
    if (recordingUploadedRef.current) return
    const recorder = recorderRef.current
    recordingStoppingRef.current = true
    if (!recorder) {
      recordingUploadedRef.current = true
      return
    }
    if (recorder.state !== 'inactive') {
      await new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error('浏览器停止录像超时')), 10000)
        recorder.addEventListener('stop', () => {
          window.clearTimeout(timeout)
          resolve()
        }, { once: true })
        try {
          recorder.stop()
        } catch (reason) {
          window.clearTimeout(timeout)
          reject(reason)
        }
      })
    }
    if (!recordingEnqueueRef.current) return
    if (!recordingFinalQueuedRef.current) {
      recordingEnqueueRef.current(new Blob([], { type: recorder?.mimeType || 'video/webm' }), true)
    }
    await recordingUploadChainRef.current

    const pending = [...recordingPendingChunksRef.current.entries()].sort(([left], [right]) => left - right)
    for (const [index, item] of pending) {
      await uploadRecordingChunk(interviewId, index, item.blob, item.final)
      recordingPendingChunksRef.current.delete(index)
    }
    recordingUploadedRef.current = true
  }, [uploadRecordingChunk])

  const startInterview = async () => {
    if (startingRef.current) return
    const operationGeneration = operationGenerationRef.current
    startingRef.current = true
    setError('')
    setPhase('starting')
    const openingStarted = performance.now()
    setOpeningWait(0)
    const openingClock = window.setInterval(() => setOpeningWait(Math.floor((performance.now() - openingStarted) / 1000)), 1000)
    openingClockRef.current = openingClock
    // Play within the click gesture for iOS, while API and preconnected WebRTC
    // progress in parallel. No rules replay when restoring an old interview.
    const openingResult = !existingInterview?.id && openingPolicyMatches(policy)
      ? opening.play({ key: `opening:${startRequestIdRef.current}:${openingStarted}`, guard: () => operationGenerationRef.current === operationGeneration })
      : Promise.resolve('skipped')
    let created = null
    try {
      if (existingInterview?.id) {
        const sessionState = await api(`/interviews/${existingInterview.id}/session/open`, {
          method: 'POST',
          body: JSON.stringify({ request_id: createRequestId() }),
        })
        interruptionSessionIdRef.current = sessionState.interruption_session_id
        interruptionSessionTokenRef.current = sessionState.interruption_session_token
        const record = await api(`/interviews/${existingInterview.id}`)
        if (operationGenerationRef.current !== operationGeneration) return
        if (record.report || record.status === 'completed') {
          if (record.report) {
            setMessages(record.messages || [])
            releaseRealtimeResources()
            setReport(record.report)
            setPhase('report')
            return
          }
          throw new Error('这场面试已经完成，但报告暂不可用')
        }
        if (!['active', 'paused', 'ready_to_finish', 'pause_expired'].includes(record.status)) {
          throw new Error('这场面试已经无法继续')
        }
        const lastQuestion = [...(record.messages || [])].reverse().find(item => item.speaker === 'interviewer' && (item.kind || 'question') === 'question')
        if (!lastQuestion) throw new Error('未找到可继续的面试问题')
        created = { ...record, question: sessionState.question_override || lastQuestion.content }
        setTargetRole(record.job_description || record.target_role || '')
        setMessages(record.messages || [])
        setQuestionCount((record.messages || []).filter(item => item.speaker === 'interviewer' && (item.kind || 'question') === 'question').length)
      } else {
        const normalizedTarget = targetRole.trim()
        const firstTargetLine = normalizedTarget.split(/\r?\n/).find(line => line.trim())?.trim() || ''
        const body = JSON.stringify({
          resume_id: resume.id,
          target_role: (normalizedTarget.length <= 120 && !normalizedTarget.includes('\n') ? normalizedTarget : firstTargetLine).slice(0, 120),
          job_description: normalizedTarget,
          request_id: startRequestIdRef.current,
        })
        try {
          created = await api('/interviews', { method: 'POST', body })
        } catch (reason) {
          if (!reason.retryable) throw reason
          await sleep(500)
          created = await api('/interviews', { method: 'POST', body })
        }
        if (operationGenerationRef.current !== operationGeneration) return
        interruptionSessionIdRef.current = created.interruption_session_id
        interruptionSessionTokenRef.current = created.interruption_session_token
        setQuestionCount(1)
        setMessages([{ speaker: 'interviewer', content: created.question }])
      }
      if (operationGenerationRef.current !== operationGeneration) return
      setInterview(created)
      setCorrection(created.pending_correction || null)
      configureSmile(`interview:${created.id}`)
      // A restored turn may have been a challenge. Until a new server decision
      // arrives, fail closed for silence reassurance instead of guessing intent.
      replyIntentRef.current = existingInterview ? 'clarify' : 'neutral'
      setPauseUsed(Boolean(created.pause_used))
      if (created.status === 'paused') {
        const remaining = Math.max(0, Number(created.pause_remaining_seconds || 0))
        const notice = [...(created.messages || [])].reverse().find(item => item.kind === 'pause_notice')?.content
          || '面试当前处于暂停状态。请在倒计时结束前点击继续面试。'
        pauseActiveRef.current = true
        setPauseRemaining(remaining)
        setPauseDeadlineMs(Date.now() + remaining * 1000)
        setPauseNotice(notice)
        setQuestion(notice)
        setPhase('paused')
        return
      }
      if (created.status === 'pause_expired') {
        setQuestion('本次暂停已经超时结束。由于尚无有效回答，请返回后重新开始一场练习。')
        setPhase('pause-expired')
        return
      }
      if (created.status === 'ready_to_finish') {
        setQuestion('本场面试问题已经完成，可以直接生成成长报告。')
        setPhase('can-finish')
        releaseRealtimeResources()
        return
      }
      const openingOutcome = await openingResult
      if (operationGenerationRef.current !== operationGeneration) return
      if (!existingInterview && openingOutcome === 'completed') {
        await playSmile({ reason: 'welcome', guard: () => operationGenerationRef.current === operationGeneration && !pauseActiveRef.current })
        if (operationGenerationRef.current !== operationGeneration) return
      }
      startRecording(created.id)
      startBehaviorTracking()
      startElapsedClock()
      // The full recorded question keeps the rules for audit/recovery. After
      // a completed intro, both the visible prompt and spoken question omit
      // that already-presented prefix, so it does not cover the interviewer's face.
      await speak(openingQuestionAfterVideo(created, openingOutcome))
    } catch (reason) {
      if (operationGenerationRef.current !== operationGeneration) return
      stopOpening()
      setError(`面试启动失败：${reason.message}`)
      setPhase(created ? 'ready' : 'setup')
    } finally {
      window.clearInterval(openingClock)
      startingRef.current = false
    }
  }

  useEffect(() => {
    if (phase !== 'starting') return
    const frame = window.requestAnimationFrame(() => window.scrollTo(0, 0))
    return () => window.cancelAnimationFrame(frame)
  }, [phase])

  const stopAudioCapture = useCallback(() => {
    processorRef.current?.disconnect()
    audioSourceRef.current?.disconnect()
    processorRef.current = null
    audioSourceRef.current = null
    audioContextRef.current?.close().catch(() => {})
    audioContextRef.current = null
  }, [])

  const finishSpeech = useCallback(() => {
    const socket = asrSocketRef.current
    if (finishingSpeechRef.current || !socket) return
    stopSmile()
    clearTimeout(asrMaxDurationRef.current)
    clearInterval(silenceMonitorRef.current)
    asrMaxDurationRef.current = null
    silenceMonitorRef.current = null
    answerActivityRef.current = null
    setSilenceCountdown(null)
    if (socket.readyState !== WebSocket.OPEN) {
      socket.close()
      asrSocketRef.current = null
      stopAudioCapture()
      setError('语音识别尚未连接成功，请重新开始回答。')
      setPhase('ready')
      return
    }
    finishingSpeechRef.current = true
    stopAudioCapture()
    setPhase('transcribing')
    try {
      socket.send(JSON.stringify({ is_speaking: false }))
      clearTimeout(asrTimeoutRef.current)
      asrTimeoutRef.current = window.setTimeout(() => {
        if (asrSocketRef.current !== socket) return
        socket.close()
        asrSocketRef.current = null
        finishingSpeechRef.current = false
        setError('语音识别等待超时，请重新回答。')
        setPhase('ready')
      }, 30000)
    } catch {
      socket.close()
      asrSocketRef.current = null
      finishingSpeechRef.current = false
      setError('语音提交失败，请重新回答。')
      setPhase('ready')
    }
  }, [stopAudioCapture, stopSmile])

  const submitTranscript = useCallback(async text => {
    if (submittingRef.current) return
    const operationGeneration = operationGenerationRef.current
    submittingRef.current = true
    setTranscript(text)
    setPhase('thinking')
    const existingPending = pendingAnswerRef.current
    const pending = (
      existingPending
      && existingPending.interviewId === interview.id
      && existingPending.text === text
    ) ? existingPending : {
      interviewId: interview.id,
      text,
      requestId: createRequestId(),
      candidateCountBefore: messages.filter(item => item.speaker === 'candidate').length,
    }
    pendingAnswerRef.current = pending
    const body = JSON.stringify({ transcript: text, request_id: pending.requestId })
    try {
      let next = null
      let requestError = null
      try {
        next = await api(`/interviews/${interview.id}/answers`, { method: 'POST', body })
      } catch (reason) {
        requestError = reason
        if (['network_error', 'timeout'].includes(reason.code)) {
          await sleep(500)
          try {
            next = await api(`/interviews/${interview.id}/answers`, { method: 'POST', body })
            requestError = null
          } catch (retryReason) {
            requestError = retryReason
          }
        }
      }

      if (!next && requestError) {
        try {
          const record = await api(`/interviews/${interview.id}`)
          const persistedMessages = record.messages || []
          const candidates = persistedMessages.filter(item => item.speaker === 'candidate')
          const lastCandidate = [...persistedMessages].reverse().find(item => item.speaker === 'candidate')
          const interviewerMessages = persistedMessages.filter(item => item.speaker === 'interviewer' && (item.kind || 'question') === 'question')
          if (
            candidates.length > pending.candidateCountBefore
            && lastCandidate?.content === text
          ) {
            if (record.status === 'ready_to_finish') {
              next = {
                should_finish: true,
                question: '谢谢你的认真回答。面试问题已经完成，现在可以生成成长报告了。',
                question_count: interviewerMessages.length,
                recovered_messages: persistedMessages,
              }
            } else if (persistedMessages.at(-1)?.speaker === 'interviewer') {
              next = {
                should_finish: false,
                question: persistedMessages.at(-1).content,
                question_count: interviewerMessages.length,
                recovered_messages: persistedMessages,
              }
            }
            if (next && (record.pending_correction || lastCandidate?.kind?.startsWith('correction_'))) {
              next.correction_handled = true
              next.correction = record.pending_correction || record.corrections?.at(-1)
              next.agent_decision = { response_intent: 'clarify' }
            }
          }
        } catch {
          // 网络仍不可用时保留相同请求编号，交给用户显式重试。
        }
      }
      if (!next) throw requestError
      if (operationGenerationRef.current !== operationGeneration) return
      pendingAnswerRef.current = null
      if (next.correction_handled) {
        replyIntentRef.current = 'clarify'
        stopSmile()
        setCorrection(next.correction)
        setMessages(items => next.recovered_messages || [...items,
          { speaker: 'candidate', kind: next.candidate_kind || 'correction_reply', content: text },
          { speaker: 'interviewer', kind: 'correction_prompt', content: next.question }])
        setQuestionCount(current => next.question_count ?? current)
        // No acknowledgment or reassurance: clarification is not approval.
        await speak(next.question, next.should_finish ? (next.can_generate_report === false ? 'invalid-ended' : 'can-finish') : 'ready')
        return
      }
      if (next.invalid_answer) {
        replyIntentRef.current = 'clarify'
        setTranscript('')
        setMessages(items => [...items, { speaker: 'interviewer', kind: 'clarification', content: next.question }])
        const finishPhase = next.can_generate_report ? 'can-finish' : 'invalid-ended'
        await speak(next.question, next.should_finish ? finishPhase : 'ready')
        if (next.should_finish) setPhase(finishPhase)
        return
      }
      setMessages(items => next.recovered_messages
        ? [
            ...next.recovered_messages,
            ...(next.should_finish ? [{ speaker: 'interviewer', content: next.question }] : []),
          ]
        : [
            ...items,
            { speaker: 'candidate', kind: 'answer', content: text },
            { speaker: 'interviewer', kind: next.should_finish ? 'closing' : 'question', content: next.question },
          ])
      let acknowledgment = 'skipped'
      replyIntentRef.current = next.agent_decision?.response_intent || 'neutral'
      if (shouldAcknowledge(next)) {
        setPhase('acknowledging')
        setQuestion('好的。')
        window.speechSynthesis?.cancel()
        acknowledgment = await playAcknowledgment({
          key: `${interview.id}:${pending.requestId}`,
          guard: () => operationGenerationRef.current === operationGeneration && !pauseActiveRef.current,
        })
      }
      if (operationGenerationRef.current !== operationGeneration) return
      setQuestionCount(current => next.question_count || current + 1)
      await speak(next.question, 'ready', acknowledgment === 'completed' ? afterAcknowledgment(next.question) : next.question)
      if (operationGenerationRef.current !== operationGeneration) return
      if (next.should_finish) {
        setPhase('can-finish')
        // Decorative only: report controls remain available and may cancel it.
        void playSmile({ reason: 'closing', guard: () => operationGenerationRef.current === operationGeneration && !pauseActiveRef.current })
      }
    } catch (reason) {
      if (operationGenerationRef.current !== operationGeneration) return
      setError(reason.message)
      if (['network_error', 'timeout'].includes(reason.code) || reason.status === 409) {
        setPhase('answer-retry')
      } else {
        pendingAnswerRef.current = null
        setPhase('ready')
      }
    } finally {
      submittingRef.current = false
    }
  }, [interview, messages, playAcknowledgment, speak, playSmile, stopSmile])

  const requestNoEffectiveInput = useCallback(async () => {
    if (!interview || submittingRef.current) return
    const operationGeneration = operationGenerationRef.current
    submittingRef.current = true
    setTranscript('')
    setError('')
    setPhase('thinking')
    const body = { request_id: createRequestId() }
    try {
      let next
      try {
        next = await postControlWithRetry(`/interviews/${interview.id}/no-input`, body, 4)
      } catch (reason) {
        if (!['network_error', 'timeout'].includes(reason.code)) throw reason
        await sleep(500)
        next = await postControlWithRetry(`/interviews/${interview.id}/no-input`, body, 4)
      }
      if (operationGenerationRef.current !== operationGeneration) return
      replyIntentRef.current = 'clarify'
      setMessages(items => [...items, { speaker: 'interviewer', kind: 'clarification', content: next.question }])
      const finishPhase = next.can_generate_report ? 'can-finish' : 'invalid-ended'
      await speak(next.question, next.should_finish ? finishPhase : 'ready')
      if (next.should_finish) setPhase(finishPhase)
    } catch (reason) {
      if (operationGenerationRef.current !== operationGeneration) return
      setError(reason.message)
      setPhase('ready')
    } finally {
      submittingRef.current = false
    }
  }, [interview, speak])

  useEffect(() => { transcriptHandlerRef.current = submitTranscript }, [submitTranscript])
  useEffect(() => { noInputHandlerRef.current = requestNoEffectiveInput }, [requestNoEffectiveInput])

  const beginListening = useCallback(async () => {
    if (!mediaStream || phase !== 'ready') return
    stopSmile()
    const operationGeneration = operationGenerationRef.current
    setError('')
    setTranscript('')
    setPhase('connecting-asr')
    finishingSpeechRef.current = false

    const socketUrl = new URL(`${LIVETALKING_BASE}/api/asr`)
    socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket
    try {
      socket = await avatarSocket(socketUrl)
    } catch (reason) {
      setError(reason.message)
      setPhase('ready')
      return
    }
    if (operationGenerationRef.current !== operationGeneration) { socket.close(); return }
    socket.binaryType = 'arraybuffer'
    asrSocketRef.current = socket

    const fail = message => {
      if (
        asrSocketRef.current !== socket
        || operationGenerationRef.current !== operationGeneration
      ) return
      stopSmile()
      clearTimeout(asrTimeoutRef.current)
      clearTimeout(asrMaxDurationRef.current)
      clearInterval(silenceMonitorRef.current)
      asrMaxDurationRef.current = null
      silenceMonitorRef.current = null
      answerActivityRef.current = null
      setSilenceCountdown(null)
      stopAudioCapture()
      socket.close()
      asrSocketRef.current = null
      finishingSpeechRef.current = false
      setError(message)
      setPhase('ready')
    }

    try {
      await new Promise((resolve, reject) => {
        const connectionTimer = window.setTimeout(() => reject(new Error('语音识别连接超时')), 8000)
        const opened = () => {
          window.clearTimeout(connectionTimer)
          socket.removeEventListener('error', failed)
          socket.removeEventListener('close', closed)
          resolve()
        }
        const failed = () => {
          window.clearTimeout(connectionTimer)
          reject(new Error('本地语音识别连接失败'))
        }
        const closed = () => {
          window.clearTimeout(connectionTimer)
          reject(new Error('本地语音识别连接已关闭'))
        }
        socket.addEventListener('open', opened, { once: true })
        socket.addEventListener('error', failed, { once: true })
        socket.addEventListener('close', closed, { once: true })
      })
      if (asrSocketRef.current !== socket) return

      socket.onmessage = event => {
        if (asrSocketRef.current !== socket || operationGenerationRef.current !== operationGeneration) return
        stopSmile()
        clearTimeout(asrTimeoutRef.current)
        clearTimeout(asrMaxDurationRef.current)
        clearInterval(silenceMonitorRef.current)
        asrMaxDurationRef.current = null
        silenceMonitorRef.current = null
        answerActivityRef.current = null
        setSilenceCountdown(null)
        stopAudioCapture()
        asrSocketRef.current = null
        finishingSpeechRef.current = false
        socket.close()
        try {
      const result = JSON.parse(event.data)
          if (result.error) {
            setError(result.message || '语音识别服务繁忙，请稍后重新回答。')
            setPhase('ready')
          } else if (result.text?.trim()) transcriptHandlerRef.current?.(result.text.trim())
          else noInputHandlerRef.current?.()
        } catch {
          setError('语音识别返回内容异常，请重新回答。')
          setPhase('ready')
        }
      }
      socket.onerror = () => fail('本地语音识别连接中断，请确认 LiveTalking 服务已启动。')
      socket.onclose = () => {
        if (asrSocketRef.current === socket) fail('本地语音识别连接意外关闭，请重新回答。')
      }
      socket.send(JSON.stringify({
        chunk_size: [5, 10, 5], wav_name: 'browser-interview',
        is_speaking: true, mode: '2pass', itn: true,
      }))

      const AudioContextClass = window.AudioContext || window.webkitAudioContext
      if (!AudioContextClass) throw new Error('当前浏览器不支持音频采集')
      const context = new AudioContextClass()
      const source = context.createMediaStreamSource(mediaStream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      audioContextRef.current = context
      audioSourceRef.current = source
      processorRef.current = processor
      answerActivityRef.current = {
        startedAt: Date.now(),
        lastEffectiveAt: Date.now(),
        validSpeechSeen: false,
        noiseFloor: 0.006,
        voicedFrames: [],
        countdownActive: false,
        reassuranceAttempted: false,
        reassurancePending: false,
        reassuranceDelayMs: 0,
      }
      processor.onaudioprocess = event => {
        if (asrSocketRef.current !== socket || socket.readyState !== WebSocket.OPEN) return
        const input = event.inputBuffer.getChannelData(0)
        const activity = answerActivityRef.current
        if (activity) {
          let energy = 0
          let crossings = 0
          for (let index = 0; index < input.length; index += 1) {
            energy += input[index] * input[index]
            if (index && (input[index] >= 0) !== (input[index - 1] >= 0)) crossings += 1
          }
          const rms = Math.sqrt(energy / Math.max(1, input.length))
          const zeroCrossingRate = crossings / Math.max(1, input.length - 1)
          if (rms < Math.max(0.018, activity.noiseFloor * 2)) {
            activity.noiseFloor = activity.noiseFloor * 0.94 + rms * 0.06
          }
          const threshold = Math.max(0.016, activity.noiseFloor * 3.2)
          const speechLike = rms >= threshold && zeroCrossingRate >= 0.008 && zeroCrossingRate <= 0.36
          const now = Date.now()
          const frameDuration = input.length / context.sampleRate * 1000
          activity.voicedFrames = activity.voicedFrames.filter(frame => now - frame.at <= 1400)
          if (speechLike) activity.voicedFrames.push({ at: now, duration: frameDuration })
          const voicedDuration = activity.voicedFrames.reduce((total, frame) => total + frame.duration, 0)
          if (voicedDuration >= 450) {
            activity.validSpeechSeen = true
            activity.lastEffectiveAt = now
            activity.reassuranceDelayMs = 0
            if (activity.countdownActive) {
              activity.countdownActive = false
              setSilenceCountdown(null)
            }
          }
        }
        socket.send(toPcm16(downsampleTo16k(input, context.sampleRate)))
      }
      source.connect(processor)
      processor.connect(context.destination)
      setPhase('listening')
      silenceMonitorRef.current = window.setInterval(() => {
        const activity = answerActivityRef.current
        if (!activity || finishingSpeechRef.current) return
        const now = Date.now()
        const idleFrom = activity.validSpeechSeen ? activity.lastEffectiveAt : activity.startedAt
        const grace = activity.validSpeechSeen ? ANSWER_IDLE_GRACE_MS : ANSWER_INITIAL_GRACE_MS
        if (now - idleFrom >= grace && !activity.reassuranceAttempted) {
          activity.reassuranceAttempted = true
          if (!['challenge', 'clarify'].includes(replyIntentRef.current)) {
            const requestedAt = now
            const result = playSmile({ reason: 'silence', questionKey: String(questionCount),
              progress: messages.filter(item => item.speaker === 'candidate' && (item.kind || 'answer') === 'answer').length,
              guard: () => answerActivityRef.current === activity && asrSocketRef.current === socket
                && socket.readyState === WebSocket.OPEN && !pauseActiveRef.current && !finishingSpeechRef.current,
            })
            activity.reassurancePending = actionCoordinator.owner === 'smile'
            if (activity.reassurancePending) {
              void result.then(() => {
                if (answerActivityRef.current !== activity) return
                activity.reassurancePending = false
                if (activity.lastEffectiveAt <= requestedAt) {
                  activity.reassuranceDelayMs = Math.min(3700, Math.max(0, Date.now() - requestedAt))
                }
              })
            }
          }
        }
        if (activity.reassurancePending) return
        const countdownElapsed = now - idleFrom - grace - activity.reassuranceDelayMs
        if (countdownElapsed < 0) {
          if (activity.countdownActive) {
            activity.countdownActive = false
            setSilenceCountdown(null)
          }
          return
        }
        const remaining = ANSWER_END_COUNTDOWN_SECONDS - Math.floor(countdownElapsed / 1000)
        if (remaining <= 0) {
          clearInterval(silenceMonitorRef.current)
          silenceMonitorRef.current = null
          activity.countdownActive = false
          setSilenceCountdown(null)
          setError('长时间没有检测到持续有效表达，系统正在结束本次回答。')
          finishSpeech()
          return
        }
        activity.countdownActive = true
        setSilenceCountdown(remaining)
      }, 250)
      asrMaxDurationRef.current = window.setTimeout(() => {
        setError('单次回答已达到 5 分钟，系统正在自动结束并提交本次语音。')
        finishSpeech()
      }, 5 * 60 * 1000)
    } catch (reason) {
      fail(`${reason.message}，请确认 LiveTalking 服务已启动。`)
    }
  }, [finishSpeech, mediaStream, phase, stopAudioCapture, playSmile, stopSmile, actionCoordinator, questionCount, messages])

  const requestPause = useCallback(async () => {
    if (!interview || pauseUsed || pauseRequestPendingRef.current || resumeRequestPendingRef.current) return
    pauseRequestPendingRef.current = true
    operationGenerationRef.current += 1
    pauseActiveRef.current = true
    clearInterval(timerRef.current)
    timerRef.current = null
    clearInterval(silenceMonitorRef.current)
    silenceMonitorRef.current = null
    setSilenceCountdown(null)
    cancelInteractiveWork()
    try {
      if (recorderRef.current?.state === 'recording') recorderRef.current.pause()
    } catch {
      // 浏览器不支持暂停录像时保持现有分段机制，最终仍会安全封口。
    }
    setError('')
    setPhase('pausing')
    const body = { request_id: createRequestId() }
    try {
      const result = await postControlWithRetry(`/interviews/${interview.id}/pause`, body)
      const remaining = Math.max(0, Number(result.pause_remaining_seconds || result.pause_max_seconds || 0))
      setPauseUsed(true)
      setPauseRemaining(remaining)
      setPauseDeadlineMs(Date.now() + remaining * 1000)
      setPauseNotice(result.notice)
      try {
        const record = await api(`/interviews/${interview.id}`)
        setMessages(record.messages || [])
        setCorrection(record.pending_correction || record.corrections?.at(-1) || null)
        setQuestionCount((record.messages || []).filter(item => item.speaker === 'interviewer' && (item.kind || 'question') === 'question').length)
      } catch {
        setMessages(items => [...items, { speaker: 'interviewer', kind: 'pause_notice', content: result.notice }])
      }
      await speak(result.notice, 'paused')
    } catch (reason) {
      pauseActiveRef.current = false
      try {
        if (recorderRef.current?.state === 'paused') recorderRef.current.resume()
      } catch {
        // 录像恢复失败会在最终保存时给出明确提示。
      }
      startElapsedClock()
      setError(`暂停失败：${reason.message}`)
      setPhase('ready')
    } finally {
      pauseRequestPendingRef.current = false
    }
  }, [cancelInteractiveWork, interview, pauseUsed, speak, startElapsedClock])

  const requestResume = useCallback(async (automaticExpiry = false) => {
    if (!interview || resumeRequestPendingRef.current) return
    resumeRequestPendingRef.current = true
    const operationGeneration = operationGenerationRef.current
    setError('')
    setPhase(automaticExpiry ? 'pause-expiring' : 'resuming')
    const body = { request_id: createRequestId() }
    try {
      const result = await postControlWithRetry(`/interviews/${interview.id}/resume`, body, 5)
      if (operationGenerationRef.current !== operationGeneration) return
      pauseActiveRef.current = false
      clearInterval(pauseTimerRef.current)
      pauseTimerRef.current = null
      setPauseRemaining(0)
      setPauseDeadlineMs(0)
      setPauseNotice(result.transition)

      let record = null
      try {
        record = await api(`/interviews/${interview.id}`)
        setMessages(record.messages || [])
        setCorrection(record.pending_correction || record.corrections?.at(-1) || null)
        setQuestionCount((record.messages || []).filter(item => item.speaker === 'interviewer' && (item.kind || 'question') === 'question').length)
      } catch {
        setMessages(items => [...items, { speaker: 'interviewer', kind: result.expired ? 'closing' : 'transition', content: result.transition }])
      }
      setQuestion(result.transition)

      if (result.expired) {
        await Promise.allSettled([
          stopRecordingAndUpload(interview.id),
          stopBehaviorTrackingAndUpload(interview.id),
        ])
        releaseRealtimeResources()
        setPhase(result.can_generate_report ? 'can-finish' : 'pause-expired')
        return
      }

      try {
        if (recorderRef.current?.state === 'paused') recorderRef.current.resume()
        else if (!recorderRef.current || recorderRef.current.state === 'inactive') startRecording(interview.id)
      } catch {
        startRecording(interview.id)
      }
      if (!behaviorTimerRef.current) startBehaviorTracking()
      startElapsedClock()
      if (!record?.pending_correction) await playSmile({ reason: 'resume', guard: () => operationGenerationRef.current === operationGeneration && !pauseActiveRef.current })
      if (operationGenerationRef.current !== operationGeneration) return
      await speak(result.transition, 'ready')
    } catch (reason) {
      setError(`继续面试失败：${reason.message}`)
      setPhase('paused')
      if (automaticExpiry) {
        window.setTimeout(() => resumeHandlerRef.current?.(true), 2000)
      }
    } finally {
      resumeRequestPendingRef.current = false
    }
  }, [interview, releaseRealtimeResources, speak, startBehaviorTracking, startElapsedClock, startRecording, stopBehaviorTrackingAndUpload, stopRecordingAndUpload, playSmile])

  useEffect(() => { resumeHandlerRef.current = requestResume }, [requestResume])
  useEffect(() => {
    clearInterval(pauseTimerRef.current)
    if (!pauseActiveRef.current || !pauseDeadlineMs) return undefined
    const update = () => {
      const remaining = Math.max(0, Math.ceil((pauseDeadlineMs - Date.now()) / 1000))
      setPauseRemaining(remaining)
      if (remaining <= 0) {
        clearInterval(pauseTimerRef.current)
        pauseTimerRef.current = null
        resumeHandlerRef.current?.(true)
      }
    }
    update()
    pauseTimerRef.current = window.setInterval(update, 250)
    return () => clearInterval(pauseTimerRef.current)
  }, [pauseDeadlineMs])

  const finishInterview = async () => {
    if (!interview || finishingRef.current) return
    if (correction?.status === 'pending') {
      setError('请先确认这处更正，或选择保留原回答，再生成报告。')
      return
    }
    if (!['ready', 'can-finish', 'report-failed'].includes(phase)) {
      setError('请等待当前提问或回答处理完成后再生成报告。')
      return
    }
    finishingRef.current = true
    stopSmile()
    setPhase('reporting')
    setError('')
    clearInterval(timerRef.current)
    timerRef.current = null
    let recordingTask = Promise.resolve(null)
    try {
      recordingTask = stopRecordingAndUpload(interview.id).then(() => null, reason => reason)
      const behaviorError = await stopBehaviorTrackingAndUpload(interview.id).then(() => null, reason => reason)
      const result = await api(`/interviews/${interview.id}/finish`, { method: 'POST' })
      try {
        const record = await api(`/interviews/${interview.id}`)
        setMessages(record.messages || [])
      } catch { /* Report is saved; raw record annotations can be loaded later. */ }
      const recordingError = await recordingTask
      releaseRealtimeResources()
      const saveFailures = [
        recordingError && '录像',
        behaviorError && '行为统计',
      ].filter(Boolean)
      if (saveFailures.length) {
        result._local_warning = `${saveFailures.join('和')}保存失败，但问答与报告已安全保存。返回工作台后仍可查看报告。`
      }
      setReport(result)
      setPhase('report')
    } catch (reason) {
      await recordingTask
      releaseRealtimeResources()
      setError(reason.message)
      setPhase('report-failed')
    } finally {
      finishingRef.current = false
    }
  }

  if (report) return <ReportView report={report} messages={messages} interviewId={interview?.id} onExit={onExit} />

  const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const seconds = String(elapsed % 60).padStart(2, '0')
  const busy = ['starting', 'speaking', 'acknowledging', 'connecting-asr', 'transcribing', 'thinking', 'reporting', 'exiting', 'pausing', 'resuming', 'pause-expiring'].includes(phase)
  const canFinish = Boolean(interview) && correction?.status !== 'pending' && ['ready', 'can-finish', 'report-failed'].includes(phase)
  const requestExit = async () => {
    if (exitingRef.current || finishingRef.current) return
    if (!interview || report) {
      onExit()
      return
    }
    if (phase !== 'exit-save-failed' && !window.confirm('退出前会先保存已录制内容；未提交的当前回答仍会丢失。确认退出吗？')) return

    operationGenerationRef.current += 1
    exitingRef.current = true
    pauseActiveRef.current = false
    clearInterval(pauseTimerRef.current)
    cancelInteractiveWork()
    setError('')
    setPhase('exiting')
    clearInterval(timerRef.current)
    timerRef.current = null
    try {
      await stopRecordingAndUpload(interview.id)
      if (interruptionSessionIdRef.current && interruptionSessionTokenRef.current && !['paused', 'can-finish', 'reporting', 'report-failed', 'pause-expired', 'invalid-ended'].includes(phase)) {
        try {
          await api(`/interviews/${interview.id}/interruptions`, {
            method: 'POST',
            body: JSON.stringify({
              session_id: interruptionSessionIdRef.current,
              session_token: interruptionSessionTokenRef.current,
              reason: phase === 'device-lost' ? 'device_lost' : 'explicit_exit',
            }),
            timeout: 8000,
          })
        } catch {
          // 断网退出不能阻止用户离开；服务恢复后仍可从已保存断点继续。
        }
      }
      releaseRealtimeResources()
      onExit()
    } catch (reason) {
      releaseRealtimeResources()
      setError(`退出前保存录像失败：${reason.message}。请检查后再次点击“退出面试室”重试。`)
      setPhase('exit-save-failed')
    } finally {
      exitingRef.current = false
    }
  }

  return <section className="interview-room">
    <header className="room-header">
      <button className="back-link" onClick={requestExit}><ArrowLeft />{phase === 'exit-save-failed' ? '重试保存并退出' : '退出面试室'}</button>
      <div className="room-title"><span className="live-dot" /><b>AI 数字人模拟面试</b><small>{targetRole || '综合岗位探索'}</small></div>
      <div className="room-header-actions">
        {interview && <button
          className={`pause-trigger ${pauseUsed ? 'used' : ''} ${pauseDeadlineMs ? 'active' : ''}`}
          disabled={pauseUsed && !pauseDeadlineMs || ['pausing', 'resuming', 'pause-expiring', 'can-finish', 'invalid-ended', 'pause-expired', 'reporting', 'exiting'].includes(phase)}
          onClick={pauseDeadlineMs ? () => requestResume(false) : requestPause}
        >
          {pauseDeadlineMs ? <PlayCircle /> : <PauseCircle />}
          {pauseDeadlineMs ? '继续面试' : pauseUsed ? '已用尽暂停次数，请专心面试' : '有急事，暂停一次'}
        </button>}
        <div className="room-clock"><Clock3 />{minutes}:{seconds}</div>
      </div>
    </header>

    <div className="room-stage">
      <div className="avatar-stage">
        <video
          ref={avatarVideoRef}
          className="avatar-video-stream"
          autoPlay
          playsInline
          onPlaying={() => setAvatarStatus('真人数字人在线')}
        />
        <audio ref={avatarAudioRef} autoPlay />
        <AcknowledgmentVideo videoRef={acknowledgmentRef} state={acknowledgmentState} />
        <SmileVideo smile={smile} />
        <OpeningVideo videoRef={opening.videoRef} state={opening.state} />
        <OpeningRulesNotice opening={opening} policy={policy} visible={phase !== 'setup'} />
        {!interviewerPresent && !opening.busy && ['starting', 'speaking'].includes(phase) && <div className="interviewer-arrival" role="status" aria-live="polite">
          <div className="interviewer-arrival-card">
            <span className="interviewer-arrival-icon" aria-hidden="true"><BriefcaseBusiness /></span>
            <p>正在准备面试连接，请稍作等待</p>
            <span className="interviewer-arrival-dots" aria-hidden="true"><i /><i /><i /></span>
          </div>
        </div>}
        <div className="stage-label"><span><Radio />林老师 · AI 面试官</span><b>{avatarStatus}</b></div>
        <div className="candidate-video candidate-video-mobile">
          <video ref={candidateMobileVideoRef} autoPlay muted playsInline />
          <span><Camera />你的镜头</span>
        </div>
        {phase === 'setup' && <div className="setup-card">
          <p className="eyebrow">最后一项设置</p>
          <h1>想练习哪个岗位？</h1>
          <p>可以输入岗位名称，也可以直接粘贴完整岗位 JD。面试官会按职责和任职要求定向追问，报告中给出岗位匹配度；留空则结合简历探索方向。</p>
          <textarea className="job-target-input" rows={7} maxLength={12000} value={targetRole} onChange={event => setTargetRole(event.target.value)} placeholder={'例如：产品经理\n\n或直接粘贴岗位 JD：\n岗位职责：负责用户调研、需求分析……\n任职要求：熟悉数据分析，具备项目协作经验……（选填）'} />
          <div className="interview-policy"><ShieldCheck /><div><b>开始前请了解</b><span>回答时若长时间没有持续有效表达，系统会显示 5 秒倒计时并自动结束本轮；短促咳嗽或环境声不会延长等待。</span><span><strong className="pause-location">位置：进入面试后页面右上角</strong>临时有事请优先使用“有急事，暂停一次”，每场一次，最长保留 {policyPauseMinutes} 分钟。</span><span>请勿直接关闭网页或反复强制退出。{policyWindowHours} 小时内前 {policyWarningCount} 次只提醒，第 {policyThreshold} 次将冷却 {policyCooldownMinutes} 分钟；偶发断网或设备断开不计入。</span><span>点击开始后，面试官会先口头说明以上规则，再提出第一题。</span></div></div>
          <button className="primary wide" disabled={phase === 'starting'} onClick={startInterview}><Sparkles />{existingInterview ? '继续这场面试' : '开始模拟面试'}</button>
        </div>}
        {phase !== 'setup' && !pauseDeadlineMs && !opening.busy && <div className="question-card">
          <>
            <span><Volume2 />{phase === 'starting' ? '面试准备中' : acknowledgmentBusy ? '承接回应' : `第 ${questionCount || 1} 题`}</span>
            <p>{phase === 'starting' ? `正在为你准备面试问题，已等待 ${openingWait} 秒。连接较慢时需要多一点时间，请不要关闭页面。` : question || '面试官正在准备问题…'}</p>
          </>
        </div>}
        {!!pauseDeadlineMs && <div className="pause-card" role="status" aria-live="polite">
          <p className="eyebrow"><PauseCircle />面试已暂停 · 本场唯一一次机会</p>
          <div className="pause-countdown"><Hourglass /><b>{formatDuration(pauseRemaining)}</b><span>界面最长保留时间</span></div>
          <p>{pauseNotice || '暂停期间不会继续提问。请在倒计时结束前返回。'}</p>
          <button className="primary wide" disabled={phase !== 'paused'} onClick={() => requestResume(false)}><PlayCircle />{phase === 'paused' ? '我回来了，继续面试' : '正在说明暂停规则…'}</button>
        </div>}
      </div>

      <aside className="candidate-panel">
        <div className="candidate-video candidate-video-desktop">
          <video ref={candidateVideoRef} autoPlay muted playsInline />
          <span><Camera />你的镜头 · 行为统计{behaviorStatus}</span>
        </div>
        <div className={`voice-state ${phase}`} role="status" aria-live="polite">
          {phase === 'listening' ? <Mic /> : ['ready', 'can-finish', 'answer-retry', 'report-failed', 'device-lost', 'exit-save-failed', 'paused', 'pause-expired', 'invalid-ended'].includes(phase) ? <MicOff /> : <LoaderCircle className={busy ? 'spin' : ''} />}
          <div>
            <b>{phase === 'starting' ? (opening.busy ? '面试官正在介绍规则' : '正在准备面试连接与问题') : phase === 'listening' ? '正在聆听你的回答' : phase === 'connecting-asr' ? '正在连接本地语音识别' : phase === 'speaking' ? pauseDeadlineMs ? '面试官正在说明暂停规则' : '请听面试官提问' : phase === 'acknowledging' ? '面试官正在承接你的回答' : phase === 'transcribing' ? '正在本地识别语音' : phase === 'thinking' ? '受控面试 Agent 正在判断追问策略' : phase === 'reporting' ? '正在生成成长报告' : phase === 'report-failed' ? '采集已结束，请重试生成报告' : phase === 'answer-retry' ? '上次回答结果待确认' : phase === 'device-lost' ? '设备连接已中断' : phase === 'exiting' ? '正在保存录像后退出' : phase === 'exit-save-failed' ? '录像尚未保存，请重试退出' : phase === 'paused' ? '面试已暂停' : phase === 'pausing' ? '正在启用本场唯一一次暂停' : phase === 'resuming' ? '正在承接上次对话' : phase === 'pause-expiring' ? '暂停时间已到，正在保存记录' : phase === 'pause-expired' ? '本场面试已因暂停超时结束' : phase === 'invalid-ended' ? '连续多次没有收到有效回答' : phase === 'can-finish' ? '面试题目已完成' : '可以开始回答'}</b>
            <span>{phase === 'listening' ? '可以自然停顿；长时间没有持续表达时会出现 5 秒自动结束倒计时' : ['speaking', 'acknowledging'].includes(phase) ? '面试官说完后，开始回答按钮才会出现' : phase === 'paused' ? `剩余 ${formatDuration(pauseRemaining)}；已有回答时会先简要总结，刚开场暂停则直接继续问题` : '尽量使用 STAR 结构，清楚说明行动和结果'}</span>
          </div>
        </div>
        {correction && <section className={`answer-correction ${correction.status}`} aria-label="回答更正" aria-live="polite">
          <b>{correction.status === 'pending' ? '我们先确认这处更正' : correction.status === 'confirmed' ? '更正已确认' : '已保留原回答'}</b>
          {correction.status === 'pending' ? <>
            <p>只修改你确认的部分，不会作废其他经历，也不增加正式题数。</p>
            {correction.can_confirm ? <dl>
              <dt>{correction.scope === 'whole_answer' ? '替换范围' : '原说法'}</dt><dd>{correction.scope === 'whole_answer' ? `第 ${correction.target_answer_id} 号回答（整段）` : correction.original_text}</dd>
              <dt>更正为</dt><dd>{correction.replacement_text}</dd>
            </dl> : <p>请点击“开始回答”，说明哪一句需要修改，以及准确的说法。</p>}
            <div className="correction-controls">
              {correction.can_confirm && <button className="primary" disabled={!['ready', 'can-finish', 'pause-expired', 'invalid-ended'].includes(phase)} onClick={() => submitTranscript('确认更正')}>确认更正</button>}
              <button disabled={!['ready', 'can-finish', 'pause-expired', 'invalid-ended'].includes(phase)} onClick={() => submitTranscript('保留原回答')}>保留原回答</button>
            </div>
            <small>也可以语音确认或继续修改；面试官说完后可操作。</small>
          </> : <p>{correction.status === 'confirmed' ? '后续追问、摘要和报告将使用更正后的内容；原话留在记录中供核对。' : '本次更正已取消，你之前的说法保持不变。'}</p>}
        </section>}
        {transcript && <div className="latest-transcript"><small>刚才的回答</small><p>{transcript}</p></div>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {phase === 'listening' && silenceCountdown !== null && <div className="silence-countdown" role="alert"><Hourglass /><div><b>暂未检测到持续有效表达</b><span>将在 {silenceCountdown} 秒后自动结束本轮回答；继续完整表达即可取消。</span></div><strong>{silenceCountdown}</strong></div>}
        <div className="room-actions">
          {phase === 'listening' && <button className="stop-answer wide answer-button" onClick={finishSpeech}>
            <CircleStop />结束并提交回答
          </button>}
          {phase === 'ready' && <button className="primary wide answer-button start-answer-button" onClick={beginListening}>
            <Mic />开始回答
          </button>}
          {phase === 'answer-retry' && <button className="primary wide answer-button" onClick={() => pendingAnswerRef.current && submitTranscript(pendingAnswerRef.current.text)}>
            <Sparkles />使用相同请求编号核对并重试
          </button>}
          {phase === 'device-lost' && <button className="primary wide answer-button" onClick={requestExit}>
            <ArrowLeft />保存并返回设备检测
          </button>}
          {phase === 'paused' && <button className="primary wide answer-button" onClick={() => requestResume(false)}><PlayCircle />我回来了，继续面试</button>}
          {phase === 'pause-expired' && <button className="primary wide answer-button" onClick={requestExit}><ArrowLeft />保存记录并返回工作台</button>}
          {phase === 'invalid-ended' && <button className="primary wide answer-button" onClick={requestExit}><ArrowLeft />保存记录并返回工作台</button>}
          {phase === 'can-finish' && <div className="answer-waiting"><CheckCircle2 />所有题目已完成，请生成报告</div>}
          {phase === 'report-failed' && <div className="answer-waiting">问答与录像已封口，请重试生成报告</div>}
          {!['setup', 'listening', 'ready', 'can-finish', 'answer-retry', 'report-failed', 'device-lost', 'exit-save-failed', 'paused', 'pause-expired', 'invalid-ended'].includes(phase) && <div className="answer-waiting">
            {phase === 'speaking' ? <><Volume2 />请先听完面试官提问</> : phase === 'acknowledging' ? <><Volume2 />请听完承接回应</> : <><LoaderCircle className="spin" />正在准备下一轮</>}
          </div>}
          <button className="end-interview" disabled={!canFinish} onClick={finishInterview}><PhoneOff />{phase === 'report-failed' ? '重试生成报告' : '结束面试并生成报告'}</button>
        </div>
      </aside>
    </div>

    <div className="room-footnote">摄像头录像与完整问答会保存到本地；面部反馈只描述可观察行为，不判断真实心理状态。</div>
  </section>
}
