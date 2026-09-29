import { useEffect, useState } from 'react'
import { ArrowRight, LockKeyhole, UserRound } from 'lucide-react'
import { api, setToken } from './api'

export default function AuthDialog({ onClose, onSuccess }) {
  const [kind, setKind] = useState('login')
  const [form, setForm] = useState({ username: '', password: '', display_name: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const closeOnEscape = event => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [busy, onClose])

  const submit = async (event) => {
    event.preventDefault()
    setBusy(true); setError('')
    try {
      const result = await api(`/auth/${kind}`, { method: 'POST', body: JSON.stringify(form) })
      setToken(result.token)
      onSuccess(result.user)
    } catch (reason) {
      setError(reason.message)
    } finally {
      setBusy(false)
    }
  }

  return <div className="modal-backdrop" onMouseDown={() => { if (!busy) onClose() }}>
    <section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-dialog-title" onMouseDown={event => event.stopPropagation()}>
      <button type="button" className="modal-close" aria-label="关闭登录窗口" disabled={busy} onClick={onClose}>×</button>
      <p className="eyebrow">欢迎来到成长空间</p>
      <h2 id="auth-dialog-title">{kind === 'login' ? '继续你的面试练习' : '创建一份成长档案'}</h2>
      <div className="tabs auth-tabs">
        <button type="button" disabled={busy} className={kind === 'login' ? 'active' : ''} onClick={() => setKind('login')}>登录</button>
        <button type="button" disabled={busy} className={kind === 'register' ? 'active' : ''} onClick={() => setKind('register')}>注册</button>
      </div>
      <form className="auth-form" onSubmit={submit}>
        {kind === 'register' && <label><span>显示姓名</span><div><UserRound /><input required value={form.display_name} onChange={e => setForm({ ...form, display_name: e.target.value })} placeholder="同学怎么称呼你？" /></div></label>}
        <label><span>账号</span><div><UserRound /><input required minLength="3" value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} placeholder="请输入账号" /></div></label>
        <label><span>密码</span><div><LockKeyhole /><input required minLength="6" type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} placeholder="至少 6 位" /></div></label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary wide" disabled={busy}>{busy ? '请稍候…' : kind === 'login' ? '登录并继续' : '创建账号'} <ArrowRight size={18} /></button>
      </form>
    </section>
  </div>
}
