import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, BriefcaseBusiness, Camera, Clock3, FilePlus2, FileText, History, LogOut, Mic, ShieldCheck, Sparkles, Trash2, Upload } from 'lucide-react'
import { api, setToken } from './api'
import InterviewRoom, { ReportView } from './InterviewRoom'
import AdminDashboard from './AdminDashboard'
import AppointmentPanel from './AppointmentPanel'
import { appointmentStage } from './appointmentPolicy'
import ParticleField from './ParticleField'

function SavedReport({ interviewId, onBack }) {
  const [record, setRecord] = useState(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api(`/interviews/${interviewId}`).then(setRecord).catch(reason => setError(reason.message))
  }, [interviewId])
  if (error) return <section className="panel empty-state"><p className="form-error">{error}</p><button className="primary" onClick={onBack}>返回工作台</button></section>
  if (!record) return <section className="panel empty-state"><Sparkles className="spin" /><h2>正在读取面试记录</h2></section>
  if (!record.report) return <section className="panel empty-state"><History /><h2>已保存的面试问答</h2>
    {record.messages?.length ? <ol className="appointment-history-messages">{record.messages.map((item, index) => <li key={item.id || index}><b>{item.speaker === 'candidate' ? '你的回答' : '面试官'}</b><p>{item.content}</p></li>)}</ol> : <p>这场面试没有可查看的问答。</p>}
    <button className="primary" onClick={onBack}>返回工作台</button></section>
  return <ReportView report={record.report} messages={record.messages} interviewId={interviewId} onExit={onBack} />
}

function QuickResume({ onSaved, onCancel }) {
  const [form, setForm] = useState({ title: '我的求职简历', school: '', major: '', degree: '本科', graduation_year: '', skills: '', experiences: '', target_role: '', self_intro: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async e => {
    e.preventDefault()
    if (busy) return
    setError('')
    setBusy(true)
    try { onSaved(await api('/resumes/quick', { method: 'POST', body: JSON.stringify(form) })) }
    catch (reason) { setError(reason.message) }
    finally { setBusy(false) }
  }
  return <section className="panel editor-panel">
    <button className="back-link" onClick={onCancel}><ArrowLeft />返回</button>
    <div className="panel-title"><p className="eyebrow">没有简历也没关系</p><h2>用几分钟，整理你的第一份简历</h2><p>所有内容都可在面试前修改。目标岗位不是必填项。</p></div>
    <form className="resume-form" onSubmit={submit}>
      <label>简历名称<input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} /></label>
      <div className="form-row"><label>学校<input required value={form.school} onChange={e => setForm({ ...form, school: e.target.value })} /></label><label>专业<input required value={form.major} onChange={e => setForm({ ...form, major: e.target.value })} /></label></div>
      <div className="form-row"><label>学历<select value={form.degree} onChange={e => setForm({ ...form, degree: e.target.value })}><option>专科</option><option>本科</option><option>硕士</option><option>博士</option></select></label><label>毕业年份<input required value={form.graduation_year} onChange={e => setForm({ ...form, graduation_year: e.target.value })} placeholder="例如 2027" /></label></div>
      <label>专业技能<textarea required value={form.skills} onChange={e => setForm({ ...form, skills: e.target.value })} placeholder="课程、软件、编程语言、证书或其他能力" /></label>
      <label>项目 / 实习 / 校园经历<textarea required value={form.experiences} onChange={e => setForm({ ...form, experiences: e.target.value })} placeholder="写清你做了什么、如何完成、取得什么结果" /></label>
      <label>目标岗位（选填）<input value={form.target_role} onChange={e => setForm({ ...form, target_role: e.target.value })} /></label>
      <label>自我介绍（选填）<textarea value={form.self_intro} onChange={e => setForm({ ...form, self_intro: e.target.value })} /></label>
      {error && <p className="form-error">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? '正在保存…' : '保存并选择这份简历'} <ArrowRight /></button>
    </form>
  </section>
}

function DeviceCheck({ resume, onBack, onReady, authorize, appointment, appointmentNow }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const transferredRef = useRef(false)
  const mountedRef = useRef(false)
  const authorizingRef = useRef(false)
  const [status, setStatus] = useState({ camera: 'checking', mic: 'checking' })
  const [consented, setConsented] = useState(false)
  const [error, setError] = useState('')
  const [authorizing, setAuthorizing] = useState(false)
  const stage = appointmentStage(appointment, appointmentNow)
  useEffect(() => {
    mountedRef.current = true
    let cancelled = false
    const prepare = async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setStatus({ camera: 'failed', mic: 'failed' })
        setError('当前浏览器环境无法使用摄像头和麦克风，请通过本机地址打开并使用最新版浏览器。')
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 24, max: 30 },
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        })
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        stream.getVideoTracks().forEach(track => {
          track.onended = () => {
            if (!cancelled) {
              setStatus(current => ({ ...current, camera: 'failed' }))
              setError('摄像头连接已中断，请检查设备后重新进入检测。')
            }
          }
        })
        stream.getAudioTracks().forEach(track => {
          track.onended = () => {
            if (!cancelled) {
              setStatus(current => ({ ...current, mic: 'failed' }))
              setError('麦克风连接已中断，请检查设备后重新进入检测。')
            }
          }
        })
        setStatus({
          camera: stream.getVideoTracks().length ? 'ok' : 'failed',
          mic: stream.getAudioTracks().length ? 'ok' : 'failed',
        })
      } catch {
        if (!cancelled) {
          setStatus({ camera: 'failed', mic: 'failed' })
          setError('无法打开摄像头或麦克风，请检查浏览器权限以及设备是否被其他程序占用。')
        }
      }
    }
    prepare()
    return () => {
      cancelled = true
      mountedRef.current = false
      if (!transferredRef.current) streamRef.current?.getTracks().forEach(track => track.stop())
    }
  }, [])
  const confirmDevices = async () => {
    const live = () => streamRef.current?.getVideoTracks().some(track => track.readyState === 'live')
      && streamRef.current?.getAudioTracks().some(track => track.readyState === 'live')
    if (authorizingRef.current || !['sign-in', 'checked-in'].includes(stage) || !consented || !live()) return
    authorizingRef.current = true
    setAuthorizing(true)
    setError('')
    try {
      const admitted = await authorize(appointment.id)
      if (!mountedRef.current) return
      if (!live()) throw new Error('设备已断开，请重新检查设备后进入刚签到的时段。')
      transferredRef.current = true
      onReady({ resume, stream: streamRef.current, appointment: admitted })
    } catch (reason) {
      if (mountedRef.current) setError(reason.message)
    } finally {
      authorizingRef.current = false
      if (mountedRef.current) setAuthorizing(false)
    }
  }
  return <section className="device-page">
    <button className="back-link" onClick={onBack} disabled={authorizing}><ArrowLeft />返回选择简历</button>
    <div className="device-grid">
      <div className="camera-preview"><video ref={videoRef} autoPlay muted playsInline /><span>镜头预览</span></div>
      <div className="device-copy">
        <p className="eyebrow">面试前的安静一分钟</p>
        <h2>确认你已准备好</h2>
        <p>坐在光线均匀的位置，让脸部完整出现在画面中。面试将保存摄像头录像、问答记录与分析结果。</p>
        <div className={`check-row ${status.camera}`}><Camera />摄像头 <b>{status.camera === 'ok' ? '正常' : status.camera === 'failed' ? '未授权' : '检测中'}</b></div>
        <div className={`check-row ${status.mic}`}><Mic />麦克风 <b>{status.mic === 'ok' ? '正常' : status.mic === 'failed' ? '未授权' : '检测中'}</b></div>
        <label className="recording-consent">
          <input type="checkbox" checked={consented} onChange={event => setConsented(event.target.checked)} />
          <span>我已知晓并同意本次练习保存录像、语音转写、问答记录与分析结果；可在历史记录中删除。</span>
        </label>
        {stage === 'upcoming' && <p role="status">可以提前完成设备检测，预约时段开始后才能签到。</p>}
        {['elapsed', 'none'].includes(stage) && <p role="status">此预约已不可签到，请返回预约区刷新并选择新时段。</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button
          className="primary wide"
          disabled={status.camera !== 'ok' || status.mic !== 'ok' || !consented || authorizing || !['sign-in', 'checked-in'].includes(stage)}
          onClick={confirmDevices}
        >
          {authorizing ? '正在确认预约…' : stage === 'sign-in' ? '设备正常，立即签到' : '设备正常，进入面试'} <ArrowRight />
        </button>
      </div>
    </div>
  </section>
}

export default function Workspace({ user, onLogout }) {
  const [view, setView] = useState('dashboard')
  const [resumes, setResumes] = useState([])
  const [interviews, setInterviews] = useState([])
  const [selected, setSelected] = useState(null)
  const [roomMedia, setRoomMedia] = useState(null)
  const [roomAppointment, setRoomAppointment] = useState(null)
  const [deviceAppointmentId, setDeviceAppointmentId] = useState(null)
  const [resumeInterview, setResumeInterview] = useState(null)
  const [historyId, setHistoryId] = useState(null)
  const [error, setError] = useState('')
  const [dragActive, setDragActive] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [interruptionStatus, setInterruptionStatus] = useState(null)
  const [cooldownDeadlineMs, setCooldownDeadlineMs] = useState(0)
  const [schedule, setSchedule] = useState(null)
  const [appointmentError, setAppointmentError] = useState('')
  const [appointmentBusy, setAppointmentBusy] = useState(false)
  const [clockTick, setClockTick] = useState(() => performance.now())
  const appointmentClock = useRef(null)
  const appointmentGeneration = useRef(0)
  const appointmentMutation = useRef(false)
  const loadGenerationRef = useRef(0)
  const serverTime = useCallback((at = performance.now()) => appointmentClock.current
    ? appointmentClock.current.ms + Math.max(0, at - appointmentClock.current.receivedAt)
    : Date.now(), [])
  const appointmentNow = serverTime(clockTick)
  const activeAppointment = schedule?.active || null
  const stage = appointmentStage(activeAppointment, appointmentNow)
  const appointmentInterview = stage === 'checked-in' && activeAppointment?.interview_id
    ? interviews.find(item => item.id === activeAppointment.interview_id)
    : null
  const recoverableInterview = appointmentInterview || interviews.find(item => item.status === 'ready_to_finish')
  const cooldownRemaining = Number(interruptionStatus?.cooldown_remaining_seconds || 0)
  const policyThreshold = Number(interruptionStatus?.threshold || 3)
  const policyWarningCount = Math.max(1, policyThreshold - 1)
  const policyWindowHours = Math.max(1, Math.ceil(Number(interruptionStatus?.window_seconds || 86400) / 3600))
  const policyCooldownMinutes = Math.max(1, Math.ceil(Number(interruptionStatus?.cooldown_seconds || 1800) / 60))
  const policyPauseMinutes = Math.max(1, Math.ceil(Number(interruptionStatus?.pause_max_seconds || 600) / 60))

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [view])

  const refreshAppointments = useCallback(async (reportError = true) => {
    const generation = ++appointmentGeneration.current
    try {
      const result = await api('/appointments')
      if (appointmentGeneration.current !== generation) return result
      const ms = Date.parse(result.now)
      const receivedAt = performance.now()
      if (Number.isFinite(ms)) {
        appointmentClock.current = { ms, receivedAt }
        setClockTick(receivedAt)
      }
      setSchedule(result)
      if (reportError) setAppointmentError('')
      return result
    } catch (reason) {
      if (reportError && appointmentGeneration.current === generation) setAppointmentError(reason.message)
      return null
    }
  }, [])

  useEffect(() => {
    if (user.role === 'admin' || !['dashboard', 'device'].includes(view)) return undefined
    void refreshAppointments()
    const clock = window.setInterval(() => setClockTick(performance.now()), 1000)
    const refresh = window.setInterval(() => { if (!appointmentMutation.current) void refreshAppointments(false) }, 15000)
    return () => {
      window.clearInterval(clock)
      window.clearInterval(refresh)
      appointmentGeneration.current += 1
    }
  }, [refreshAppointments, user.role, view])

  const changeAppointment = async (path, body) => {
    if (appointmentMutation.current) return
    appointmentMutation.current = true
    appointmentGeneration.current += 1
    setAppointmentBusy(true)
    setAppointmentError('')
    try {
      const result = await api(path, { method: 'POST', body: body && JSON.stringify(body) })
      setSchedule(current => current && { ...current, active: path.endsWith('/cancel') ? null : result })
      await refreshAppointments(false)
    } catch (reason) {
      setAppointmentError(reason.message)
      await refreshAppointments(false)
    } finally {
      appointmentMutation.current = false
      setAppointmentBusy(false)
    }
  }

  const authorizeAppointment = async id => {
    const active = activeAppointment?.id === id ? activeAppointment : null
    const currentStage = appointmentStage(active, serverTime())
    if (currentStage === 'checked-in') return active
    if (currentStage !== 'sign-in') throw new Error('当前不在签到时间内，请返回预约区刷新。')
    appointmentMutation.current = true
    appointmentGeneration.current += 1
    try {
      const result = await api(`/appointments/${id}/check-in`, { method: 'POST' })
      setSchedule(current => current && { ...current, active: result })
      return result
    } catch (reason) {
      await refreshAppointments(false)
      throw reason
    } finally {
      appointmentMutation.current = false
    }
  }

  const load = () => {
    const generation = loadGenerationRef.current + 1
    loadGenerationRef.current = generation
    const interruptionRequest = api('/account/interruption-status').catch(() => ({
      forced_exit_count: 0,
      cooldown_remaining_seconds: 0,
      threshold: 3,
      window_seconds: 86400,
      cooldown_seconds: 1800,
      pause_max_seconds: 600,
      unavailable: true,
    }))
    return Promise.all([api('/resumes'), api('/interviews'), interruptionRequest])
    .then(([r, i, interruption]) => {
      if (loadGenerationRef.current === generation) {
        setResumes(r)
        setInterviews(i)
        setInterruptionStatus(interruption)
        const serverDeadline = Date.parse(interruption.cooldown_until || '')
        setCooldownDeadlineMs(interruption.cooldown_remaining_seconds ? (Number.isFinite(serverDeadline) ? serverDeadline : Date.now() + Number(interruption.cooldown_remaining_seconds) * 1000) : 0)
        setError(interruption.unavailable ? '冷却状态暂时无法读取；简历和历史记录仍可使用，开始面试时服务器会再次校验。' : '')
      }
      return { resumes: r, interviews: i, interruption }
    })
    .catch(reason => {
      if (loadGenerationRef.current === generation) setError(reason.message)
      throw reason
    })
  }
  useEffect(() => {
    load().catch(() => {})
    return () => { loadGenerationRef.current += 1 }
  }, [])
  useEffect(() => {
    if (!cooldownDeadlineMs) return undefined
    const update = () => {
      const remaining = Math.max(0, Math.ceil((cooldownDeadlineMs - Date.now()) / 1000))
      setInterruptionStatus(current => current ? { ...current, cooldown_remaining_seconds: remaining } : current)
      if (!remaining) setCooldownDeadlineMs(0)
    }
    update()
    const timer = window.setInterval(() => {
      update()
    }, 250)
    return () => window.clearInterval(timer)
  }, [cooldownDeadlineMs])
  const uploadFile = async file => {
    if (!file || uploading) return
    const extension = file.name.split('.').pop()?.toLowerCase()
    if (!['pdf', 'txt'].includes(extension)) {
      setError('简历仅支持 PDF 或 TXT 格式。')
      return
    }
    if (file.size > 15 * 1024 * 1024) {
      setError('简历文件不能超过 15MB。')
      return
    }
    setError('')
    setUploading(true)
    const body = new FormData(); body.append('file', file)
    try {
      const created = await api('/resumes/upload', { method: 'POST', body })
      await load()
      setSelected(created)
    } catch (reason) {
      setError(reason.message)
    } finally {
      setUploading(false)
    }
  }
  const upload = event => {
    const file = event.target.files?.[0]
    event.target.value = ''
    uploadFile(file)
  }
  const dropResume = event => {
    event.preventDefault()
    setDragActive(false)
    uploadFile(event.dataTransfer.files?.[0])
  }
  const logout = () => { setToken(''); onLogout() }
  const continueInterview = item => {
    if (cooldownRemaining && item.status !== 'ready_to_finish') {
      setError(`由于近期多次强制终止面试，账号仍需冷却 ${Math.ceil(cooldownRemaining / 60)} 分钟。历史记录和报告仍可正常查看。`)
      return
    }
    const sourceResume = resumes.find(resume => resume.id === item.resume_id)
    if (!sourceResume && item.status !== 'ready_to_finish') {
      setError('这场未完成面试对应的简历已经不存在，暂时无法继续。你可以删除这条记录后重新开始。')
      return
    }
    if (item.status !== 'ready_to_finish' && (stage !== 'checked-in' || activeAppointment.interview_id !== item.id)) {
      setError('此记录不属于当前已签到的预约，不能继续作答。请刷新预约或查看历史。')
      return
    }
    setError('')
    setSelected(sourceResume)
    setResumeInterview(item)
    if (item.status === 'ready_to_finish') {
      setRoomMedia(null)
      setRoomAppointment(stage === 'checked-in' && activeAppointment.interview_id === item.id ? activeAppointment : null)
      setView('interview')
    } else {
      setDeviceAppointmentId(activeAppointment.id)
      setView('device')
    }
  }
  const prepareAppointment = async () => {
    if (cooldownRemaining || !activeAppointment || !['upcoming', 'sign-in', 'checked-in'].includes(stage)) return
    if (activeAppointment.interview_id) {
      const item = appointmentInterview || (await load().catch(() => null))?.interviews.find(row => row.id === activeAppointment.interview_id)
      if (item) return continueInterview(item)
      setAppointmentError('暂时无法读取本场记录，请刷新后重试。')
      return
    }
    if (!selected) return
    setError('')
    setResumeInterview(null)
    setDeviceAppointmentId(activeAppointment.id)
    setView('device')
  }
  const deleteHistory = async item => {
    if (deletingId || !window.confirm(`确认删除这场“${item.target_role || '综合岗位探索'}”面试吗？问答、报告、行为数据和录像都将永久删除。`)) return
    setDeletingId(item.id)
    setError('')
    try {
      await api(`/interviews/${item.id}`, { method: 'DELETE' })
      if (historyId === item.id) setHistoryId(null)
      await load()
    } catch (reason) {
      setError(reason.message)
    } finally {
      setDeletingId(null)
    }
  }
  if (user.role === 'admin') return <AdminDashboard user={user} onLogout={onLogout} />
  if (view === 'quick') return <div className="workspace"><ParticleField /><QuickResume onCancel={() => setView('dashboard')} onSaved={created => { setSelected(created); load().catch(() => {}); setView('dashboard') }} /></div>
  if (view === 'history') return <div className="workspace"><ParticleField /><SavedReport interviewId={historyId} onBack={() => { load().catch(() => {}); setView('dashboard') }} /></div>
  if (view === 'device') return <div className="workspace"><ParticleField /><DeviceCheck resume={selected}
    appointment={activeAppointment?.id === deviceAppointmentId ? activeAppointment : null} appointmentNow={appointmentNow}
    authorize={authorizeAppointment} onBack={() => { setResumeInterview(null); setDeviceAppointmentId(null); setView('dashboard') }}
    onReady={({ stream, appointment }) => { setRoomMedia(stream); setRoomAppointment(appointment); setView('interview') }} /></div>
  if (view === 'interview') return <div className="workspace"><InterviewRoom resume={selected} existingInterview={resumeInterview}
    mediaStream={roomMedia} policy={interruptionStatus} appointment={roomAppointment} appointmentNow={serverTime}
    onExit={() => { setRoomMedia(null); setRoomAppointment(null); setResumeInterview(null); setDeviceAppointmentId(null); load().catch(() => {}); setView('dashboard') }} /></div>

  return <div className="workspace">
    <ParticleField />
    <header className="workspace-nav"><div className="brand"><span className="brand-mark">A</span><span>AI数字人面试</span></div><div><span className="hello">你好，{user.name}</span><button className="icon-button" onClick={logout}><LogOut />退出</button></div></header>
    <section className="workspace-hero"><div><p className="eyebrow">今天也向前一步</p><h1>{resumes.length ? '准备好下一场练习了吗？' : '先从认识自己的经历开始。'}</h1><p>预约一个时段，选好简历并检查设备，到点签到后进入面试。</p></div><div className="mini-stat"><History /><span>历史面试<b>{interviews.length}</b></span></div></section>
    {error && <p className="form-error notice" role="alert">{error}</p>}
    {!!cooldownRemaining && <section className="cooldown-center" aria-label="账号冷却提醒" aria-live="polite">
      <div className="cooldown-copy"><p className="eyebrow"><ShieldCheck />面试进度保护</p><h2>账号正在冷却，但你仍可以继续准备</h2><p>系统检测到该账号在 {policyWindowHours} 小时内已发生 {interruptionStatus?.forced_exit_count || policyThreshold} 次强制退出。为避免回答、录像与报告反复中断，本次限制重新进入面试 {policyCooldownMinutes} 分钟。</p>
        <div className="cooldown-rules"><b>规则重新提示</b><span>前 {policyWarningCount} 次强制退出只提醒，第 {policyThreshold} 次进入 {policyCooldownMinutes} 分钟冷却。</span><span>偶发断网或摄像头、麦克风设备断开不会计入。</span><span>临时有事请优先使用面试页右上角“有急事，暂停一次”，最长保留 {policyPauseMinutes} 分钟，但不会延长预约时限。</span></div>
        <div className="cooldown-actions"><button className="ghost action" onClick={() => document.getElementById('interview-history')?.scrollIntoView({ behavior: 'smooth' })}><History />查看历史与报告</button><button className="ghost action" onClick={() => setView('quick')}><FilePlus2 />整理一份练习简历</button></div>
      </div>
      <div className="cooldown-clock"><Clock3 /><small>距离恢复面试还有</small><b>{String(Math.floor(cooldownRemaining / 60)).padStart(2, '0')}:{String(cooldownRemaining % 60).padStart(2, '0')}</b><span>倒计时结束后按钮会自动恢复</span></div>
    </section>}
    <AppointmentPanel schedule={schedule} now={appointmentNow} error={appointmentError} busy={appointmentBusy}
      onReload={() => refreshAppointments()} onReserve={start_at => changeAppointment('/appointments', { start_at })}
      onCancel={id => { if (window.confirm('取消后会释放这个时段，其他用户可以预约。确认取消？')) void changeAppointment(`/appointments/${id}/cancel`) }}
      onReady={prepareAppointment} hasResume={Boolean(selected || (appointmentInterview && resumes.some(r => r.id === appointmentInterview.resume_id)) || appointmentInterview?.status === 'ready_to_finish')}
      canEnter={!cooldownRemaining || appointmentInterview?.status === 'ready_to_finish'} />
    {recoverableInterview && recoverableInterview !== appointmentInterview && <section className="resume-interview-banner" aria-label="未完成面试提醒">
      <div><History /><span><b>你有一场未完成的面试</b><small>{recoverableInterview.target_role || '综合岗位探索'} · {recoverableInterview.status === 'paused' ? '暂停中' : recoverableInterview.status === 'ready_to_finish' ? '待生成报告' : '回答进度已保存'}</small></span></div>
      <button className="primary" disabled={cooldownRemaining && recoverableInterview.status !== 'ready_to_finish'} onClick={() => continueInterview(recoverableInterview)}>{cooldownRemaining && recoverableInterview.status !== 'ready_to_finish' ? '冷却结束后继续' : recoverableInterview.status === 'ready_to_finish' ? '继续生成报告' : '从断点继续'}<ArrowRight /></button>
    </section>}
    <section className="workspace-section"><div className="list-heading"><div><p className="eyebrow">我的资料</p><h2>选择面试简历</h2></div><div className="compact-actions"><button className="ghost action" onClick={() => setView('quick')}><FilePlus2 />快速建简历</button></div></div>
      <label
        className={`resume-dropzone ${dragActive ? 'dragging' : ''} ${uploading ? 'uploading' : ''}`}
        onDragEnter={event => { event.preventDefault(); setDragActive(true) }}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragActive(true) }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false) }}
        onDrop={dropResume}
      >
        <Upload />
        <div>
          <b className="resume-upload-desktop">{uploading ? '正在解析并保存简历…' : '把桌面的简历拖到这里'}</b>
          <b className="resume-upload-mobile">{uploading ? '正在解析并保存简历…' : '点击选择手机中的简历'}</b>
          <span>支持 PDF / TXT，也可以从文件应用中选择</span>
        </div>
        <input type="file" accept=".pdf,.txt" disabled={uploading} onChange={upload} />
      </label>
      <div className="resume-grid">{resumes.map(resume => <article className={`resume-item ${selected?.id === resume.id ? 'selected' : ''}`} key={resume.id} role="button" tabIndex={0} aria-pressed={selected?.id === resume.id} onClick={() => setSelected(resume)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(resume) } }}><FileText /><div><h3>{resume.title}</h3><p>{resume.source === 'upload' ? '上传简历' : '在线创建'} · {new Date(resume.created_at).toLocaleDateString('zh-CN')}</p></div>{selected?.id === resume.id && <span className="selected-dot">已选择</span>}</article>)}{!resumes.length && <button className="add-resume" onClick={() => setView('quick')}><FilePlus2 /><b>创建第一份简历</b><span>整理好简历即可预约签到</span></button>}</div>
      <div className="start-bar"><div><BriefcaseBusiness /><span>{selected ? `已选：${selected.title}。目标岗位为可选项。` : '选一份简历，再到预约区开始设备检测。'}</span></div><button className="primary" onClick={() => document.getElementById('interview-appointments')?.scrollIntoView({ behavior: 'smooth' })}>返回预约区 <ArrowRight /></button></div>
    </section>
    {!!interviews.length && <section className="workspace-section history-section" id="interview-history">
      <div className="list-heading"><div><p className="eyebrow">成长档案</p><h2>历史面试与报告</h2></div></div>
      <div className="history-list">{interviews.slice(0, 6).map(item => <article key={item.id}>
        <div><b>{item.target_role || '综合岗位探索'}</b><span>{new Date(item.started_at).toLocaleString('zh-CN')} · {item.status === 'completed' ? '已完成' : item.status === 'ready_to_finish' ? '待生成报告' : item.status === 'paused' ? '暂停中' : item.status === 'pause_expired' ? '暂停超时，记录已保存' : item.status === 'expired' ? '预约时限已结束' : item.status === 'invalid_ended' ? '无有效回答，练习已结束' : '未完成'}</span></div>
        <div className="history-actions">
          {item.status !== 'completed' && <button className="ghost" onClick={() => { setHistoryId(item.id); setView('history') }}>查看问答</button>}
          <button className="ghost" disabled={['pause_expired', 'invalid_ended', 'expired'].includes(item.status) || (['active', 'paused'].includes(item.status) && appointmentInterview?.id !== item.id)} onClick={() => {
            if (item.status === 'completed') {
              setHistoryId(item.id)
              setView('history')
              return
            }
            continueInterview(item)
          }}>{item.status === 'completed' ? '查看报告' : item.status === 'ready_to_finish' ? '生成报告' : item.status === 'paused' ? '返回暂停界面' : ['pause_expired', 'expired'].includes(item.status) ? '已超时' : item.status === 'invalid_ended' ? '已结束' : '继续面试'}</button>
          <button className="history-delete" disabled={deletingId === item.id} aria-label={`删除 ${item.target_role || '综合岗位探索'} 面试`} onClick={() => deleteHistory(item)}>
            <Trash2 />{deletingId === item.id ? '删除中' : '删除'}
          </button>
        </div>
      </article>)}</div>
    </section>}
  </div>
}
