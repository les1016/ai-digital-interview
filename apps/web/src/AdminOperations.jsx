import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Activity, AlertTriangle, ArrowLeft, CheckCircle2, ChevronLeft, ChevronRight,
  CircleStop, Clock3, Database, Filter, HardDrive, LoaderCircle, PlayCircle,
  RefreshCw, RotateCcw, Search, Server, ShieldAlert, SquareTerminal, Wifi,
} from 'lucide-react'
import { api } from './api'
import ParticleField from './ParticleField'

const EVENT_PAGE_SIZE = 15
const statusNames = {
  active: '进行中', paused: '已暂停', ready_to_finish: '等待报告', pause_expired: '暂停超时',
  completed: '已完成', admin_closed: '管理员关闭',
}
const actionNames = {
  resume: '从暂停断点恢复', force_active: '强制恢复为进行中',
  ready_to_finish: '转入报告生成状态', close_without_report: '关闭本场面试',
}

const formatTime = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
const formatDuration = total => total == null ? '—' : `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`

export default function AdminOperations({ onExit }) {
  const [runtime, setRuntime] = useState(null)
  const [events, setEvents] = useState({ items: [], total: 0, pages: 1, categories: [] })
  const [selectedId, setSelectedId] = useState(null)
  const [eventPage, setEventPage] = useState(1)
  const [level, setLevel] = useState('')
  const [category, setCategory] = useState('')
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [reason, setReason] = useState('')
  const [busyAction, setBusyAction] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const loadRuntime = useCallback(async () => {
    try {
      const value = await api('/admin/runtime', { timeout: 15000 })
      setRuntime(value)
      setSelectedId(current => current && value.interviews.some(item => item.id === current) ? current : value.interviews[0]?.id || null)
    } catch (failure) { setError(failure.message) }
  }, [])

  const loadEvents = useCallback(async () => {
    const params = new URLSearchParams({ page: String(eventPage), page_size: String(EVENT_PAGE_SIZE) })
    if (level) params.set('level', level)
    if (category) params.set('category', category)
    if (selectedId) params.set('interview_id', String(selectedId))
    if (appliedQuery) params.set('query', appliedQuery)
    try { setEvents(await api(`/admin/events?${params}`, { timeout: 15000 })) }
    catch (failure) { setError(failure.message) }
  }, [appliedQuery, category, eventPage, level, selectedId])

  const refreshAll = useCallback(async () => {
    setError('')
    setLoading(true)
    await Promise.all([loadRuntime(), loadEvents()])
    setLoading(false)
  }, [loadEvents, loadRuntime])

  useEffect(() => { refreshAll() }, [refreshAll])
  useEffect(() => {
    if (!autoRefresh) return undefined
    const timer = window.setInterval(() => { loadRuntime(); loadEvents() }, 5000)
    return () => window.clearInterval(timer)
  }, [autoRefresh, loadEvents, loadRuntime])

  const selected = useMemo(() => runtime?.interviews.find(item => item.id === selectedId) || null, [runtime, selectedId])
  const statusEntries = Object.entries(runtime?.status_counts || {})

  const intervene = async action => {
    if (!selected || reason.trim().length < 3) {
      setError('人工干预前必须填写至少 3 个字的原因，便于以后追查。')
      return
    }
    if (action === 'close_without_report' && !window.confirm('确定关闭这场面试吗？该操作会写入审计日志。')) return
    setBusyAction(action)
    setError('')
    try {
      await api(`/admin/interviews/${selected.id}/control`, {
        method: 'POST', body: JSON.stringify({ action, reason: reason.trim() }), timeout: 20000,
      })
      setReason('')
      await Promise.all([loadRuntime(), loadEvents()])
    } catch (failure) { setError(failure.message) }
    finally { setBusyAction('') }
  }

  const applySearch = event => {
    event.preventDefault()
    setEventPage(1)
    setAppliedQuery(query.trim())
  }

  return <div className="workspace admin-operations-page">
    <ParticleField />
    <header className="workspace-nav operations-nav">
      <button className="back-link" onClick={onExit}><ArrowLeft />返回管理台</button>
      <div><Activity /><span><b>运维调试中心</b><small>真实面试状态、断点、日志与人工干预</small></span></div>
      <div className="operations-refresh"><label><input type="checkbox" checked={autoRefresh} onChange={event => setAutoRefresh(event.target.checked)} />每 5 秒自动刷新</label><button className="ghost action" onClick={refreshAll}><RefreshCw className={loading ? 'spin' : ''} />立即刷新</button></div>
    </header>

    <main className="operations-main">
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className="operations-service-grid">
        <article><Server /><span>API 服务<b>{runtime?.services.api === 'ok' ? '正常' : '异常'}</b></span></article>
        <article><Database /><span>SQLite 数据库<b>{runtime?.services.database === 'ok' ? '正常' : '异常'}</b></span></article>
        <article><Wifi /><span>DeepSeek 配置<b>{runtime?.services.deepseek_configured ? '已配置' : '缺少密钥'}</b></span></article>
        <article><HardDrive /><span>录像磁盘剩余<b>{runtime ? `${runtime.services.recording_free_mb} MB` : '—'}</b></span></article>
        <article><Clock3 /><span>服务器时间<b>{formatTime(runtime?.server_time)}</b></span></article>
        <article><ShieldAlert /><span>执行中的互斥操作<b>{runtime?.locked_operations.length || 0}</b></span></article>
      </section>

      <section className="operations-status-strip">
        <div><p className="eyebrow">状态管理</p><h1>真实面试运行状态</h1><span>只展示尚需关注的面试；已完成记录仍保留在管理台历史列表。</span></div>
        <div>{statusEntries.map(([name, count]) => <span key={name}><b>{count}</b>{statusNames[name] || name}</span>)}</div>
      </section>

      <div className="operations-grid">
        <section className="operations-runtime-panel">
          <header><div><Activity /><span><b>运行实例</b><small>{runtime?.interviews.length || 0} 场需要关注</small></span></div></header>
          <div className="runtime-instance-list">
            {!runtime?.interviews.length && <div className="operations-empty"><CheckCircle2 />当前没有进行中或异常中断的面试</div>}
            {runtime?.interviews.map(item => <button className={selectedId === item.id ? 'active' : ''} onClick={() => { setSelectedId(item.id); setEventPage(1) }} key={item.id}>
              <span className={`runtime-status ${item.status}`} />
              <div><b>#{item.id} · {item.candidate}</b><small>{item.target_role || '综合岗位探索'} · {formatTime(item.started_at)}</small></div>
              <em>{statusNames[item.status] || item.status}</em>
            </button>)}
          </div>
        </section>

        <section className="operations-checkpoint-panel">
          {!selected && <div className="operations-empty"><SquareTerminal />选择左侧面试后查看状态断点</div>}
          {selected && <>
            <header><div><RotateCcw /><span><b>面试 #{selected.id} 状态断点</b><small>最后持久化：{formatTime(selected.checkpoint.saved_at)}</small></span></div><strong className={`checkpoint-state ${selected.status}`}>{statusNames[selected.status] || selected.status}</strong></header>
            <div className="checkpoint-metrics">
              <span>问题数<b>{selected.question_count}</b></span><span>回答数<b>{selected.answer_count}</b></span><span>消息数<b>{selected.message_count}</b></span><span>暂停剩余<b>{formatDuration(selected.pause_remaining_seconds)}</b></span>
            </div>
            <article className="checkpoint-message"><span>最后事件 · {selected.checkpoint.last_speaker || '暂无'} / {selected.checkpoint.last_kind || '暂无'}</span><p>{selected.checkpoint.last_message || '尚未生成面试消息。'}</p></article>
            <div className="checkpoint-recovery"><CheckCircle2 /><span><b>{selected.checkpoint.recoverable ? '该断点可以恢复' : '该状态不可继续'}</b><small>数据库已保存状态、题号依据、消息链和暂停截止时间。</small></span></div>
            <label className="intervention-reason"><span>人工干预原因（必填，会永久写入审计日志）</span><textarea value={reason} onChange={event => setReason(event.target.value)} maxLength="500" placeholder="例如：学生浏览器崩溃，确认录像已保存后协助恢复。" /></label>
            <div className="intervention-actions">
              <button disabled={selected.status !== 'paused' || busyAction} onClick={() => intervene('resume')}><PlayCircle />从暂停恢复</button>
              <button disabled={selected.status === 'completed' || busyAction} onClick={() => intervene('force_active')}><RotateCcw />强制恢复进行中</button>
              <button disabled={!selected.answer_count || busyAction} onClick={() => intervene('ready_to_finish')}><CheckCircle2 />允许生成报告</button>
              <button className="danger" disabled={busyAction} onClick={() => intervene('close_without_report')}><CircleStop />关闭面试</button>
            </div>
            {!!busyAction && <p className="intervention-busy"><LoaderCircle className="spin" />正在执行：{actionNames[busyAction]}</p>}
          </>}
        </section>
      </div>

      <section className="operations-log-panel">
        <header><div><SquareTerminal /><span><b>结构化持久日志</b><small>状态变化与日志同事务写入 SQLite；当前筛选共 {events.total} 条</small></span></div></header>
        <form className="operations-log-filters" onSubmit={applySearch}>
          <label><Filter /><select value={level} onChange={event => { setLevel(event.target.value); setEventPage(1) }}><option value="">全部级别</option><option value="info">INFO</option><option value="warn">WARN</option><option value="error">ERROR</option></select></label>
          <select value={category} onChange={event => { setCategory(event.target.value); setEventPage(1) }}><option value="">全部模块</option>{events.categories.map(item => <option value={item} key={item}>{item}</option>)}</select>
          <label className="log-search"><Search /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索事件、说明或 JSON 详情" /></label>
          <button>查询</button>
          {selectedId && <button type="button" className="clear-interview-filter" onClick={() => { setSelectedId(null); setEventPage(1) }}>取消面试筛选 #{selectedId}</button>}
        </form>
        <div className="operations-log-table">
          <div className="operations-log-head"><span>时间 / 级别</span><span>模块 / 事件</span><span>面试</span><span>说明与详情</span></div>
          {!events.items.length && <div className="operations-empty"><AlertTriangle />当前筛选下没有日志</div>}
          {events.items.map(item => <article key={item.id} className={`level-${item.level}`}>
            <span><time>{formatTime(item.timestamp)}</time><b>{item.level.toUpperCase()}</b></span>
            <span><em>{item.category}</em><code>{item.event}</code></span>
            <span>{item.interview_id ? `#${item.interview_id}` : '系统'}</span>
            <span><p>{item.message}</p>{Object.keys(item.details || {}).length > 0 && <details><summary>查看 JSON 详情</summary><pre>{JSON.stringify(item.details, null, 2)}</pre></details>}</span>
          </article>)}
        </div>
        <nav className="operations-log-pagination"><span>第 {eventPage} / {events.pages || 1} 页</span><div><button disabled={eventPage <= 1} onClick={() => setEventPage(value => value - 1)}><ChevronLeft />上一页</button><button disabled={eventPage >= (events.pages || 1)} onClick={() => setEventPage(value => value + 1)}>下一页<ChevronRight /></button></div></nav>
      </section>
    </main>
  </div>
}
