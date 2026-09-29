import { useEffect, useState } from 'react'
import { ArrowRight, BookOpen, Check, CircleUserRound, Sparkles } from 'lucide-react'
import AuthDialog from './AuthDialog'
import Workspace from './Workspace'
import { api, getToken, setToken } from './api'
import ParticleField from './ParticleField'

const stages = [
  { number: '01', title: '建立候选人画像', action: '上传简历 / 快速录入', feedback: '自动提取教育、项目、技能与目标岗位', output: '生成本场面试上下文' },
  { number: '02', title: '校准面试环境', action: '摄像头与麦克风预检', feedback: '确认光线、收音与画面稳定度', output: '降低正式练习中断风险' },
  { number: '03', title: '进入全息面试舱', action: '与数字人进行追问式对话', feedback: '根据回答动态调整问题深度', output: '形成完整问答证据链' },
  { number: '04', title: '生成成长报告', action: '复盘表达、逻辑与状态', feedback: '输出亮点、短板和下一轮训练建议', output: '得到可执行提升路径' },
]

function App() {
  const [authOpen, setAuthOpen] = useState(false)
  const [user, setUser] = useState(null)
  const [checkingSession, setCheckingSession] = useState(() => Boolean(getToken()))
  useEffect(() => {
    const controller = new AbortController()
    const expireSession = () => setUser(null)
    window.addEventListener('ai-interview-auth-expired', expireSession)
    if (getToken()) {
      api('/me', { signal: controller.signal })
        .then(setUser)
        .catch(reason => { if (reason.code !== 'aborted') setToken('') })
        .finally(() => setCheckingSession(false))
    }
    return () => {
      controller.abort()
      window.removeEventListener('ai-interview-auth-expired', expireSession)
    }
  }, [])
  if (checkingSession) return <main className="shell"><section className="ready"><div><p className="eyebrow">正在恢复登录状态</p><h2>马上回到你的成长空间</h2></div></section></main>
  if (user) return <Workspace user={user} onLogout={() => setUser(null)} />

  return <main className="shell">
    <ParticleField />
    <nav className="nav">
      <a className="brand" href="#top"><span className="brand-mark">A</span><span>AI数字人面试</span></a>
      <div className="nav-links"><a href="#flow">如何开始</a><a href="#growth">成长报告</a><button className="ghost" onClick={() => setAuthOpen(true)}>登录 / 注册</button></div>
    </nav>

    <section id="top" className="hero">
      <div className="hero-copy">
        <p className="eyebrow"><Sparkles size={15} /> 给第一场面试，多一点从容</p>
        <h1>把紧张的未知，<br /><em>练成笃定的表达。</em></h1>
        <p className="lede">面向初入社会的大学生。和温和专业的 AI 数字人进行一场真实感模拟面试，发现你的优势，也找到下一次更好的自己。</p>
        <div className="actions"><button className="primary" onClick={() => setAuthOpen(true)}>开始我的模拟面试 <ArrowRight size={18} /></button><a className="text-link" href="#flow">先了解流程</a></div>
        <div className="trust"><span><Check size={15} /> 中文面试场景</span><span><Check size={15} /> 全程本地保存</span><span><Check size={15} /> 专属成长建议</span></div>
      </div>
      <div className="hero-visual" aria-label="数字人面试官预览">
        <div className="orb orb-a" /><div className="orb orb-b" />
        <div className="signal-panel signal-left"><span>AI INTERVIEW</span><b>12</b><small>动态追问节点</small></div>
        <div className="interviewer-card">
          <div className="scan-grid" />
          <img className="interviewer-image" src="/ai-interviewer-generation.png" alt="基于中国女性脸模生成中的全息线框 AI 面试官" width="1536" height="1024" decoding="async" fetchPriority="high" />
          <div className="generation-glow"><i /><i /><i /><i /><i /></div>
          <div className="speaker"><span className="wave"><i /><i /><i /><i /><i /></span><p>你好，很高兴认识你。<br />我们从轻松的自我介绍开始吧。</p></div>
        </div>
        <div className="signal-panel signal-right"><span>REPORT</span><b>86</b><small>证据化成长评分</small></div>
        <div className="signal-rail"><i /><i /><i /><i /><i /></div>
        <div className="floating-note note-one"><CircleUserRound size={18} /><span>温和追问<br /><b>不制造压力</b></span></div>
        <div className="floating-note note-two"><Sparkles size={18} /><span>实时反馈<br /><b>表达与状态</b></span></div>
      </div>
    </section>

    <section id="flow" className="flow section">
      <div className="section-heading flow-heading">
        <p className="eyebrow">一场安心的练习</p>
        <h2>从资料准备，到看见成长</h2>
        <p>把一次模拟面试拆成可感知的训练链路：输入资料、校准环境、实时追问、沉淀报告，每一步都有明确输出。</p>
      </div>
      <div className="flow-console">
        <div className="flow-orbit" aria-hidden="true"><i /><i /><i /></div>
        <div className="stage-grid">
          {stages.map(stage => <article className="stage" key={stage.number}>
            <span>{stage.number}</span>
            <h3>{stage.title}</h3>
            <p>{stage.action}</p>
            <dl>
              <div><dt>系统反馈</dt><dd>{stage.feedback}</dd></div>
              <div><dt>输出</dt><dd>{stage.output}</dd></div>
            </dl>
          </article>)}
        </div>
        <aside className="flow-insight" aria-label="模拟面试流程状态">
          <span>SESSION MAP</span>
          <b>4</b>
          <small>关键阶段串联成一次完整练习</small>
          <div><i style={{ width: '82%' }} /><em>资料理解</em></div>
          <div><i style={{ width: '74%' }} /><em>追问深度</em></div>
          <div><i style={{ width: '88%' }} /><em>报告可执行性</em></div>
        </aside>
      </div>
    </section>

    <section id="growth" className="growth section">
      <div className="report-card"><div className="report-head"><div><p className="eyebrow">你的面试成长档案</p><h2>不止一个分数</h2></div><div className="score"><small>综合表现</small><b>86</b><span>/100</span></div></div><div className="report-lines"><span>表达逻辑 <i style={{ width: '86%' }} /></span><span>岗位匹配 <i style={{ width: '79%' }} /></span><span>临场稳定 <i style={{ width: '72%' }} /></span></div></div>
      <div className="growth-copy"><BookOpen size={25} /><h2>一次面试，一份更懂你的报告。</h2><p>结合简历、每一轮回答与镜头中的非语言表现，给出可解释的亮点、待提升项、情绪调节建议和职业方向。</p><ul><li><Check /> 完整问答记录与证据回放</li><li><Check /> 多维能力雷达与岗位匹配</li><li><Check /> 语速、停顿、注视等状态建议</li></ul></div>
    </section>

    <section className="ready"><div><p className="eyebrow">准备好了吗？</p><h2>你的下一次面试，可以先在这里发生。</h2></div><button className="primary light" onClick={() => setAuthOpen(true)}>创建账号并开始 <ArrowRight size={18} /></button></section>

    {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} onSuccess={result => { setUser(result); setAuthOpen(false) }} />}
  </main>
}

export default App
