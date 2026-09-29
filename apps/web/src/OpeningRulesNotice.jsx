import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { BookOpen, X } from 'lucide-react'
import { OpeningCaption } from './useOpeningVideo'
import { openingManifest, openingPolicyMatches } from './openingPolicy'

export default function OpeningRulesNotice({ opening, policy, admin = false, visible = true }) {
  const id = useId(), rootRef = useRef(null), previousRect = useRef(null), wasPlaying = useRef(false)
  const pinned = useRef(false)
  const [expanded, setExpanded] = useState(false), [morphing, setMorphing] = useState(false)
  const busy = visible && opening.busy
  const sections = openingPolicyMatches(policy) ? openingManifest.segments : [
    openingManifest.segments[0], openingManifest.segments[1],
    { title: '临时有事，可以暂停', text: `有急事，点页面右上方暂停。每场一次，最长 ${Math.ceil((policy?.pause_max_seconds ?? 600) / 60)} 分钟，超时结束并保存已有记录。` },
    openingManifest.segments[3],
    { title: '强退与冷却', text: `${Math.ceil((policy?.window_seconds ?? 86400) / 3600)} 小时内，前 ${Math.max(0, (policy?.threshold ?? 3) - 1)} 次强退只提醒，第 ${policy?.threshold ?? 3} 次冷却 ${Math.ceil((policy?.cooldown_seconds ?? 1800) / 60)} 分钟。` },
    { title: '偶发故障不计入', text: `偶发断网或设备故障不计入。连续 ${policy?.max_invalid_answers ?? 3} 次无效回答也会结束面试。` },
    openingManifest.segments[6],
  ]
  useLayoutEffect(() => {
    if (busy && rootRef.current) previousRect.current = rootRef.current.getBoundingClientRect()
  }, [busy, opening.caption, opening.position])
  useLayoutEffect(() => {
    const element = rootRef.current
    if (!element) { wasPlaying.current = false; return }
    let animation, timer
    if (busy) {
      setExpanded(false); setMorphing(false); pinned.current = false
      previousRect.current = element.getBoundingClientRect()
    } else if (wasPlaying.current && previousRect.current && !matchMedia('(prefers-reduced-motion: reduce)').matches && element.animate) {
      const from = previousRect.current, to = element.getBoundingClientRect(), parent = element.offsetParent.getBoundingClientRect()
      setMorphing(true)
      animation = element.animate([
        { left: `${from.left - parent.left}px`, top: `${from.top - parent.top}px`, right: 'auto', bottom: 'auto', width: `${from.width}px`, height: `${from.height}px`, borderRadius: '17px' },
        { left: `${to.left - parent.left}px`, top: `${to.top - parent.top}px`, right: 'auto', bottom: 'auto', width: `${to.width}px`, height: `${to.height}px`, borderRadius: '22px' },
      ], { duration: 620, easing: 'cubic-bezier(.22,1,.36,1)' })
      timer = window.setTimeout(() => setMorphing(false), 630)
    }
    wasPlaying.current = busy
    return () => { animation?.cancel(); window.clearTimeout(timer) }
  }, [busy, visible])
  useEffect(() => {
    if (!expanded) return
    const close = event => {
      if (event.type === 'keydown' && event.key !== 'Escape') return
      if (event.type === 'pointerdown' && rootRef.current?.contains(event.target)) return
      pinned.current = false
      setExpanded(false)
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close) }
  }, [expanded])
  if (!visible) return null
  return <div ref={rootRef} className={`opening-rules-notice ${busy ? 'is-narrating' : 'is-collapsed'} ${morphing ? 'is-morphing' : ''}`}
    onMouseEnter={() => { if (!busy && !morphing && matchMedia('(hover: hover)').matches) setExpanded(true) }}
    onMouseLeave={() => { if (!pinned.current && !rootRef.current?.contains(document.activeElement)) setExpanded(false) }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { pinned.current = false; setExpanded(false) } }}>
    {busy ? <>
      <OpeningCaption caption={opening.caption} position={opening.position} />
      <small>字幕与口播同步 · 可以先调好耳机和音量，规则稍后仍可查看。</small>
      {admin && <small>以上为学生规则；管理员测试仍可多次暂停，不触发冷却。</small>}
    </> : <>
      <button className="opening-rules-button" type="button" aria-expanded={expanded} aria-controls={id}
        onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setExpanded(true) }}
        onClick={() => { pinned.current = !pinned.current; setExpanded(pinned.current) }}><BookOpen />面试须知</button>
      {morphing && <div className="opening-rules-fold-caption" aria-hidden="true"><OpeningCaption caption={opening.caption} position={opening.position} /></div>}
      {expanded && !morphing && <section id={id} className="opening-rules-popover" aria-label="完整面试须知">
        <header><div><b>面试须知</b><span>没有听清也没关系，完整规则在这里，可上下滚动查看。</span></div><button type="button" aria-label="关闭面试须知" onClick={() => { pinned.current = false; setExpanded(false) }}><X /></button></header>
        <ol>{sections.map(section => <li key={section.title}><b>{section.title}</b><p>{section.text}</p></li>)}</ol>
        {admin && <p className="opening-rules-admin-note">管理员测试可多次暂停，不计入学生强退或冷却。</p>}
      </section>}
    </>}
  </div>
}
