import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ArrowLeft, BarChart3, CheckCircle2, ChevronLeft, ChevronRight, Download, Eye,
  FileStack, FileText, History, LoaderCircle, LogOut, MessageSquareText, PlayCircle,
  RefreshCw, ShieldCheck, Target, Users,
} from 'lucide-react'
import { api, apiBlob, setToken } from './api'
import AdminScriptedDemo from './AdminScriptedDemo'
import AdminOperations from './AdminOperations'
import ParticleField from './ParticleField'
import './answerCorrections.css'

function AdminInterviewDetail({ record, onBack }) {
  const [tab, setTab] = useState('result')
  const [selectedPreviewKey, setSelectedPreviewKey] = useState(
    record.documents?.[0]?.id ? `formal-${record.documents[0].id}` : 'draft-pdf',
  )
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [previewError, setPreviewError] = useState('')
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const [error, setError] = useState('')
  const previewCache = useRef(new Map())
  const report = record.report || {}
  const summary = report.conversation_summary || {}
  const documents = record.documents || []
  const previewOptions = useMemo(
    () => ['pdf', 'docx'].map(format => {
      const document = documents.find(item => item.format === format)
      if (document) return { ...document, key: `formal-${document.id}`, state: 'formal' }
      return {
        key: `draft-${format}`,
        format,
        format_label: format === 'pdf' ? 'PDF 文档' : 'Word 文档（.docx）',
        preview_path: `/admin/interviews/${record.id}/document-preview?format=${format}`,
        state: 'draft',
      }
    }),
    [documents, record.id],
  )
  const selectedPreview = useMemo(
    () => previewOptions.find(item => item.key === selectedPreviewKey) || previewOptions[0],
    [previewOptions, selectedPreviewKey],
  )

  useEffect(() => {
    if (tab !== 'document' || !selectedPreview) return undefined
    const cachedUrl = previewCache.current.get(selectedPreview.key)
    if (cachedUrl) {
      setPreviewUrl(cachedUrl)
      setPreviewing(false)
      setPreviewError('')
      return () => setPreviewUrl('')
    }
    let active = true
    const controller = new AbortController()
    setPreviewing(true)
    setPreviewError('')
    setPreviewUrl('')
    apiBlob(selectedPreview.preview_path, { timeout: 120000, signal: controller.signal }).then(blob => {
      if (!active) return
      const objectUrl = URL.createObjectURL(blob)
      previewCache.current.set(selectedPreview.key, objectUrl)
      setPreviewUrl(objectUrl)
    }).catch(reason => {
      if (active && reason.code !== 'aborted') setPreviewError(reason.message)
    }).finally(() => active && setPreviewing(false))
    return () => {
      active = false
      controller.abort()
      setPreviewUrl('')
    }
  }, [tab, selectedPreview, previewAttempt])

  useEffect(() => {
    if (tab === 'document') return
    for (const url of previewCache.current.values()) URL.revokeObjectURL(url)
    previewCache.current.clear()
  }, [tab])

  useEffect(() => () => {
    for (const url of previewCache.current.values()) URL.revokeObjectURL(url)
    previewCache.current.clear()
  }, [])

  const retryPreview = () => {
    if (!selectedPreview) return
    const cachedUrl = previewCache.current.get(selectedPreview.key)
    if (cachedUrl) URL.revokeObjectURL(cachedUrl)
    previewCache.current.delete(selectedPreview.key)
    setPreviewError('')
    setPreviewAttempt(value => value + 1)
  }

  const download = async () => {
    if (!selectedPreview || selectedPreview.state !== 'formal') return
    try {
      const blob = await apiBlob(selectedPreview.download_path, { timeout: 120000 })
      const url = URL.createObjectURL(blob)
      const anchor = window.document.createElement('a')
      anchor.href = url
      anchor.download = `AI数字人面试-用户文档.${selectedPreview.format}`
      window.document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (reason) {
      setError(reason.message)
    }
  }

  return <div className="workspace admin-workspace">
    <ParticleField />
    <main className="admin-main admin-detail-main">
      <button className="ghost action admin-back" onClick={onBack}><ArrowLeft />返回总览</button>
      <section className="admin-detail-hero">
        <div><p className="eyebrow">面试记录 #{record.id}</p><h1>{record.candidate || '面试者'} · {record.target_role || '综合岗位探索'}</h1><p>{new Date(record.started_at).toLocaleString('zh-CN')} · {record.status === 'completed' ? '已完成并生成报告' : '面试进行中'}</p></div>
        <div className="admin-detail-score"><b>{report.overall_score ?? '—'}</b><span>综合分</span></div>
      </section>
      <nav className="admin-detail-tabs" aria-label="面试详情视图">
        <button className={tab === 'result' ? 'active' : ''} onClick={() => setTab('result')}><BarChart3 />面试结果</button>
        <button className={tab === 'summary' ? 'active' : ''} onClick={() => setTab('summary')}><MessageSquareText />面试摘要</button>
        <button className={tab === 'document' ? 'active' : ''} onClick={() => setTab('document')}><FileStack />用户文档<span>{documents.length ? `${documents.length}/2` : '预览'}</span></button>
      </nav>
      {error && <p className="form-error">{error}</p>}

      {tab === 'result' && <section className="admin-detail-view">
        <div className="admin-result-lead"><div><p className="eyebrow">综合结论</p><h2>面试表现与岗位准备度</h2><p>{report.summary}</p></div><span>{Object.keys(report.dimensions || {}).length} 项能力维度</span></div>
        <div className="admin-result-grid">
          {report.target_match && <article className="admin-detail-card admin-target-match"><h3>目标岗位匹配度</h3><div className="admin-match-score"><b>{report.target_match.score}%</b><span>{report.target_match.target}</span></div><p>{report.target_match.evidence}</p><h4>已匹配要求</h4><ul>{(report.target_match.matched_requirements || []).map(item => <li key={item}>{item}</li>)}</ul><h4>待补齐差距</h4><ul>{(report.target_match.gaps || []).map(item => <li key={item}>{item}</li>)}</ul></article>}
          <article className="admin-detail-card admin-dimensions"><h3>能力评分与证据</h3>{Object.entries(report.dimensions || {}).map(([name, item]) => <div key={name}><span><b>{name}</b><strong>{item.score}</strong></span><i><em style={{ width: `${item.score}%` }} /></i><p>{item.evidence}</p></div>)}</article>
          <article className="admin-detail-card"><h3><CheckCircle2 />优势证据</h3><ul>{(report.highlights || []).map(item => <li key={item}>{item}</li>)}</ul></article>
          <article className="admin-detail-card admin-improvement-card"><h3><Target />改进与风险点</h3><ul>{(report.improvements || []).map(item => <li key={item}>{item}</li>)}</ul></article>
          <article className="admin-detail-card"><h3>情绪与镜头状态建议</h3><ul>{(report.emotion_guidance || []).map(item => <li key={item}>{item}</li>)}</ul></article>
          <article className="admin-detail-card"><h3>行动计划</h3><ol>{(report.action_plan || []).map(item => <li key={item}>{String(item).replace(/^\s*\d+(?:\.\d+)*[.、：:)]?\s*/, '')}</li>)}</ol></article>
          <article className="admin-detail-card admin-role-card"><h3>岗位推荐明细</h3>{(report.recommended_roles || []).map(item => <div key={item.role}><b>{item.role}<span>{item.fit}%</span></b><p>{item.reason}</p></div>)}</article>
        </div>
      </section>}

      {tab === 'summary' && <section className="admin-detail-view">
        {!!record.corrections?.length && <article className="admin-detail-card">
          <h3>回答更正记录</h3><p>原始记录保留；已确认的更正用于后续提问与报告，不将确认过程算作独立答题。</p>
          {record.corrections.map(item => <details className={`answer-correction ${item.status}`} key={item.id}>
            <summary>更正 #{item.id} · {({pending:'待确认', confirmed:'已确认', cancelled:'已取消'})[item.status]} · {item.target_answer_id ? `回答记录 #${item.target_answer_id}` : '范围待澄清'}</summary>
            <p>原说法：{item.original_text || (item.scope === 'whole_answer' ? '整段回答' : '尚未确定')}</p>
            <p>新说法：{item.replacement_text || '尚未确定'}</p>
            <p>确认追问：{item.prompt}</p>
          </details>)}
        </article>}
        <div className="admin-result-lead"><div><p className="eyebrow">独家对话摘要</p><h2>问答结构、证据密度与训练提示</h2><p>{summary.overview || '此记录暂无对话摘要。'}</p></div><span>{summary.dialogue_digest?.length || 0} 轮问答</span></div>
        {!!summary.key_topics?.length && <div className="admin-topic-strip">{summary.key_topics.map(item => <span key={item}>{item}</span>)}</div>}
        <div className="admin-summary-list">{(summary.dialogue_digest || []).map((item, index) => <article key={`${item.question}-${index}`}><span>{String(index + 1).padStart(2, '0')}</span><div><h3>{item.question}</h3><p><b>回答摘要</b>{item.answer_summary}</p><em><b>教练提示</b>{item.coaching_note}</em></div></article>)}</div>
        <div className="admin-summary-bottom">
          <article className="admin-detail-card"><h3>沟通模式观察</h3><p>{summary.communication_pattern || '暂无数据'}</p></article>
          <article className="admin-detail-card"><h3>后续复盘重点</h3><ul>{(summary.follow_up_focus || []).map(item => <li key={item}>{item}</li>)}</ul></article>
        </div>
      </section>}

      {tab === 'document' && <section className="admin-detail-view admin-document-view">
        <div className="admin-result-lead"><div><p className="eyebrow">用户交付文件与预生成效果</p><h2>合并文档预览</h2><p>未导出时按需生成预览，不写入数据库或文档目录；用户正式导出后，这里自动切换为其真实文件。Word 使用同版式 PDF 预览。</p></div><span>{documents.length} 份正式文档</span></div>
        <div className="admin-preview-notice"><Eye /><div><b>{documents.length ? '已生成格式优先展示用户正式文档' : '用户尚未生成文档，当前展示预生成效果'}</b><span>预览只在打开时临时生成，关闭详情或切换页面后浏览器立即释放；只有用户主动导出的文件会长期保存。</span></div></div>
        <div className="admin-document-toolbar">
          <div>{previewOptions.map(item => <button className={selectedPreview?.key === item.key ? 'active' : ''} onClick={() => setSelectedPreviewKey(item.key)} key={item.key}><FileText /><span><b>{item.format_label}</b><small className={item.state === 'formal' ? 'formal' : 'draft'}>{item.state === 'formal' ? `用户正式文档 · ${new Date(item.updated_at).toLocaleString('zh-CN')}` : '预生成效果 · 不保存'}</small></span></button>)}</div>
          {selectedPreview?.state === 'formal'
            ? <button className="primary" onClick={download}><Download />下载用户原文件</button>
            : <span className="admin-draft-label">仅预览 · 无持久文件</span>}
        </div>
        <div className="admin-document-frame">
          {previewing && <div className="document-loading"><LoaderCircle className="spin" />正在按需生成{selectedPreview?.format_label}预览…</div>}
          {!previewing && previewError && <div className="admin-preview-error"><Eye /><h3>预览暂时没有加载成功</h3><p>{previewError}</p><button className="ghost action" onClick={retryPreview}><RefreshCw />重新加载预览</button></div>}
          {!previewing && previewUrl && <iframe src={previewUrl} title={`${selectedPreview?.format_label}预览`} />}
        </div>
      </section>}
    </main>
  </div>
}

const ADMIN_PAGE_SIZE = 6

function AdminPager({ page, total, pageSize = ADMIN_PAGE_SIZE, onChange, label }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  return <nav className="admin-pagination" aria-label={`${label}分页`}>
    <span>共 {total} 条</span>
    <div>
      <button disabled={page <= 1} onClick={() => onChange(page - 1)} aria-label={`上一页${label}`}><ChevronLeft /></button>
      <b>第 {page} / {pageCount} 页</b>
      <button disabled={page >= pageCount} onClick={() => onChange(page + 1)} aria-label={`下一页${label}`}><ChevronRight /></button>
    </div>
  </nav>
}

export default function AdminDashboard({ user, onLogout }) {
  const [overview, setOverview] = useState(null)
  const [apiCosts, setApiCosts] = useState(null)
  const [users, setUsers] = useState([])
  const [interviews, setInterviews] = useState([])
  const [selectedRecord, setSelectedRecord] = useState(null)
  const [scriptedDemo, setScriptedDemo] = useState(false)
  const [operationsOpen, setOperationsOpen] = useState(false)
  const [loadingRecordId, setLoadingRecordId] = useState(null)
  const [error, setError] = useState('')
  const [userPage, setUserPage] = useState(1)
  const [interviewPage, setInterviewPage] = useState(1)
  const [userTotal, setUserTotal] = useState(0)
  const [interviewTotal, setInterviewTotal] = useState(0)

  const userPageCount = Math.max(1, Math.ceil(userTotal / ADMIN_PAGE_SIZE))
  const interviewPageCount = Math.max(1, Math.ceil(interviewTotal / ADMIN_PAGE_SIZE))

  const load = () => {
    setError('')
    Promise.all([
      api('/admin/overview'),
      api(`/admin/users?page=${userPage}&page_size=${ADMIN_PAGE_SIZE}`),
      api(`/admin/interviews?page=${interviewPage}&page_size=${ADMIN_PAGE_SIZE}`),
      api('/admin/api-costs?days=30').catch(() => null),
    ])
      .then(([summary, userPayload, interviewPayload, costPayload]) => {
        const userRows = Array.isArray(userPayload)
          ? userPayload.slice((userPage - 1) * ADMIN_PAGE_SIZE, userPage * ADMIN_PAGE_SIZE)
          : userPayload.items || []
        const interviewRows = Array.isArray(interviewPayload)
          ? interviewPayload.slice((interviewPage - 1) * ADMIN_PAGE_SIZE, interviewPage * ADMIN_PAGE_SIZE)
          : interviewPayload.items || []
        setOverview(summary)
        setApiCosts(costPayload)
        setUsers(userRows)
        setInterviews(interviewRows)
        setUserTotal(Array.isArray(userPayload) ? userRows.length : userPayload.total || 0)
        setInterviewTotal(Array.isArray(interviewPayload) ? interviewRows.length : interviewPayload.total || 0)
      })
      .catch(reason => setError(reason.message))
  }
  useEffect(load, [userPage, interviewPage])
  useEffect(() => { if (userPage > userPageCount) setUserPage(userPageCount) }, [userPage, userPageCount])
  useEffect(() => { if (interviewPage > interviewPageCount) setInterviewPage(interviewPageCount) }, [interviewPage, interviewPageCount])

  const viewDetails = async item => {
    setLoadingRecordId(item.id)
    setError('')
    try {
      const record = await api(`/interviews/${item.id}`)
      if (!record.report) throw new Error('这场面试尚未生成报告')
      setSelectedRecord({ ...record, candidate: item.candidate, started_at: item.started_at })
    } catch (reason) {
      setError(reason.message)
    } finally {
      setLoadingRecordId(null)
    }
  }
  const logout = () => { setToken(''); onLogout() }

  if (selectedRecord) return <AdminInterviewDetail record={selectedRecord} onBack={() => { setSelectedRecord(null); load() }} />
  if (scriptedDemo) return <AdminScriptedDemo onExit={() => setScriptedDemo(false)} />
  if (operationsOpen) return <AdminOperations onExit={() => { setOperationsOpen(false); load() }} />

  return <div className="workspace admin-workspace">
    <ParticleField />
    <header className="workspace-nav">
      <div className="brand"><span className="brand-mark">A</span><span>AI数字人面试 · 管理台</span></div>
      <div><span className="hello">管理员，{user.name}</span><button className="icon-button" onClick={logout}><LogOut />退出</button></div>
    </header>
    <main className="admin-main">
      <div className="admin-heading"><div><p className="eyebrow">本地运行概览</p><h1>系统管理台</h1><p>集中查看账号、面试结果、独家摘要和用户导出文档。</p></div><button className="ghost action" onClick={load}><RefreshCw />刷新数据</button></div>
      {error && <p className="form-error">{error}</p>}
      <section className="admin-stats admin-stats-five">
        <article><Users /><span>账号总数<b>{overview?.users ?? '—'}</b></span></article>
        <article><FileText /><span>简历总数<b>{overview?.resumes ?? '—'}</b></span></article>
        <article><History /><span>面试总数<b>{overview?.interviews ?? '—'}</b></span></article>
        <article><BarChart3 /><span>报告总数<b>{overview?.reports ?? '—'}</b></span></article>
        <article><FileStack /><span>用户文档<b>{overview?.documents ?? '—'}</b></span></article>
      </section>
      <section className="admin-api-control">
        <header><div><p className="eyebrow">DeepSeek API 成本控制</p><h2>预算、Token 与调用台账</h2><p>硬上限由服务器环境变量控制；请求会先预占额度，成功后按实际缓存命中、未命中与输出 Token 结算。</p></div><span>近 30 天</span></header>
        <div className="admin-stats admin-api-stats">
          <article><ShieldCheck /><span>本月金额<b>¥{apiCosts?.budget?.global_monthly_cost_cny?.used ?? '—'}</b><small>上限 ¥{apiCosts?.budget?.global_monthly_cost_cny?.limit ?? '—'}</small></span></article>
          <article><BarChart3 /><span>今日全站 Token<b>{apiCosts?.budget?.global_daily_tokens?.used?.toLocaleString?.() ?? '—'}</b><small>剩余 {apiCosts?.budget?.global_daily_tokens?.remaining?.toLocaleString?.() ?? '—'}</small></span></article>
          <article><History /><span>近 30 天调用<b>{apiCosts?.by_operation?.reduce((sum, item) => sum + item.calls, 0) ?? '—'}</b><small>成功 {apiCosts?.status_counts?.completed || 0} 次</small></span></article>
          <article><Activity /><span>异常与预占<b>{(apiCosts?.status_counts?.failed || 0) + (apiCosts?.status_counts?.reserved || 0)}</b><small>失败会保守计入预算</small></span></article>
        </div>
        <div className="admin-api-operations">
          {apiCosts?.by_operation?.map(item => <article key={item.operation}><b>{item.operation}</b><span>{item.calls} 次 · {item.tokens.toLocaleString()} Token · ¥{item.cost_cny.toFixed(6)}</span></article>)}
          {!apiCosts?.by_operation?.length && <p>暂无真实 API 调用记录。</p>}
        </div>
      </section>
      <section className="admin-test-launcher">
        <div className="admin-test-icon"><ShieldCheck /></div>
        <div><p className="eyebrow">管理员高级体验</p><h2>固定剧本模拟面试</h2><p>使用本地预设的简历与问答样板。数字人严格按顺序朗读问题，管理员点击发送预设学生回答；不会调用 DeepSeek。</p></div>
        <button className="primary" onClick={() => setScriptedDemo(true)}><PlayCircle />进入固定剧本测试</button>
      </section>
      <section className="admin-test-launcher admin-operations-launcher">
        <div className="admin-test-icon"><Activity /></div>
        <div><p className="eyebrow">系统级状态与日志</p><h2>运维调试中心</h2><p>查看真实面试状态、SQLite 持久断点、详细结构化日志与服务健康；必要时可以填写原因后执行可审计的人工干预。</p></div>
        <button className="primary" onClick={() => setOperationsOpen(true)}><Activity />进入运维调试中心</button>
      </section>
      <div className="admin-columns">
        <section className="admin-table-panel">
          <div className="admin-table-title"><h2>账号记录</h2><span>每页 {ADMIN_PAGE_SIZE} 条</span></div>
          <div className="admin-table"><div className="table-head"><span>姓名 / 账号</span><span>简历</span><span>面试</span></div><div className="admin-table-body">{users.map(item => <div className="table-row" key={item.id}><span><b>{item.name}</b><small>{item.username} · {item.role}{item.interruption_status?.cooldown_remaining_seconds ? ` · 冷却中 ${Math.ceil(item.interruption_status.cooldown_remaining_seconds / 60)} 分钟` : item.interruption_status?.forced_exit_count ? ` · 近期强退 ${item.interruption_status.forced_exit_count} 次` : ''}</small></span><span>{item.resume_count}</span><span>{item.interview_count}</span></div>)}{!users.length && <div className="admin-table-empty">暂无账号记录</div>}</div></div>
          <AdminPager page={userPage} total={userTotal} onChange={setUserPage} label="账号记录" />
        </section>
        <section className="admin-table-panel">
          <div className="admin-table-title"><h2>面试记录</h2><span>每页 {ADMIN_PAGE_SIZE} 条</span></div>
          <div className="admin-table"><div className="table-head interviews"><span>候选人 / 岗位</span><span>状态 / 文档</span><span>操作</span></div><div className="admin-table-body">{interviews.map(item => <div className="table-row interviews" key={item.id}><span><b>{item.candidate}</b><small>{item.target_role || '综合岗位探索'} · {new Date(item.started_at).toLocaleString('zh-CN')}</small></span><span><b>{item.status === 'completed' ? '已完成' : '进行中'}</b><small>{item.document_formats?.length ? `已选 ${item.document_formats.map(format => format.toUpperCase()).join(' / ')}` : '未生成文档'}</small></span><span>{item.has_report && <button onClick={() => viewDetails(item)} disabled={loadingRecordId === item.id}>{loadingRecordId === item.id ? <LoaderCircle className="spin" /> : '详情'}</button>}</span></div>)}{!interviews.length && <div className="admin-table-empty">暂无面试记录</div>}</div></div>
          <AdminPager page={interviewPage} total={interviewTotal} onChange={setInterviewPage} label="面试记录" />
        </section>
      </div>
    </main>
  </div>
}
