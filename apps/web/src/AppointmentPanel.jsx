import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, Clock3, RotateCw } from 'lucide-react'
import { appointmentStage, availableAppointmentSlot, appointmentTimeZoneLabel,
  DEFAULT_APPOINTMENT_TIME_ZONE, nextAvailableNightSlot } from './appointmentPolicy'
import './appointmentPanel.css'

const hourText = value => `${String(value).padStart(2, '0')}:00`

export default function AppointmentPanel({ schedule, now, error, busy, onReload, onReserve, onCancel, onReady, hasResume, canEnter }) {
  const [chosenDay, setChosenDay] = useState('')
  const [chosenSlot, setChosenSlot] = useState('')
  const slotList = useRef(null)
  const zone = schedule?.timezone || DEFAULT_APPOINTMENT_TIME_ZONE
  const zoneLabel = appointmentTimeZoneLabel(zone)
  const overnight = schedule?.overnight
  const dayFormat = useMemo(() => new Intl.DateTimeFormat('zh-CN', { timeZone: zone, month: 'numeric', day: 'numeric', weekday: 'short' }), [zone])
  const timeFormat = useMemo(() => new Intl.DateTimeFormat('zh-CN', {
    timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    ...(zone === DEFAULT_APPOINTMENT_TIME_ZONE ? {} : { timeZoneName: 'short' }),
  }), [zone])
  const days = useMemo(() => {
    const entries = new Map()
    for (const slot of schedule?.slots || []) {
      const label = dayFormat.format(new Date(slot.start_at))
      if (!entries.has(label)) entries.set(label, [])
      entries.get(label).push(slot)
    }
    return entries
  }, [schedule, dayFormat])
  const day = days.has(chosenDay) ? chosenDay : days.keys().next().value || ''
  const slotAvailable = slot => availableAppointmentSlot(slot, now)
  const selection = (days.get(day) || []).find(slot => slot.start_at === chosenSlot && slotAvailable(slot))
  const active = schedule?.active
  const stage = appointmentStage(active, now)
  const hasAppointment = ['upcoming', 'sign-in', 'checked-in'].includes(stage)
  const nextNight = nextAvailableNightSlot(schedule?.slots, now)
  useEffect(() => { if (hasAppointment) setChosenSlot('') }, [hasAppointment])
  useEffect(() => { if (slotList.current) slotList.current.scrollTop = 0 }, [day])

  return <section className="workspace-section appointment-panel" id="interview-appointments" aria-labelledby="appointment-heading">
    <div className="list-heading"><div><p className="eyebrow"><CalendarDays size={16} />预约面试</p><h2 id="appointment-heading">选一个方便的时间</h2></div>
      <button className="ghost action" onClick={onReload} disabled={busy} aria-label="刷新预约名额"><RotateCw size={16} />刷新</button></div>
    <p className="appointment-rules">每半小时 1 个名额，每场最长 20 分钟（含暂停）。每个账号只能保留一个有效预约；常规时段每天最多 1 次，滚动 7 天最多 3 次。原预约未签到时可限时补位，剩余面试时间可能更短。</p>
    {overnight && <p className="appointment-rules">夜间 {hourText(overnight.start_hour)}–{hourText(overnight.end_hour)} 每天最多 {overnight.daily_limit} 次，单独计算，不占用常规时段额度。午夜后的时段归到次日，可提前预约。</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {schedule && <p className="appointment-quota">预约时间按 {zoneLabel} 显示 · 常规今日剩余 {schedule.remaining_today} 次 · 常规近 7 天剩余 {schedule.remaining_7_days} 次{overnight && ` · 夜间今日剩余 ${overnight.remaining_today} 次`}</p>}
    {hasAppointment ? <div className="appointment-active" aria-live="polite">
      <div><b><Clock3 size={18} />{dayFormat.format(new Date(active.start_at))} {timeFormat.format(new Date(active.start_at))}{active.overnight && <span className="appointment-night">夜间</span>}</b>
        <p>{stage === 'upcoming' ? '已预约。请提前准备简历、摄像头和麦克风；到点后 5 分钟内确认设备并签到。' : stage === 'sign-in' ? `可签到。请在 ${timeFormat.format(new Date(active.check_in_by))} 前完成设备确认并签到。` : `已签到，本场截止 ${timeFormat.format(new Date(active.ends_at))}。`}</p></div>
      <div className="appointment-actions">
        {stage === 'upcoming' && <>
          <button className="ghost action" disabled={busy} onClick={() => onCancel(active.id)}>取消预约</button>
          <button className="primary" disabled={!canEnter || !hasResume || busy} onClick={onReady}>提前检测设备</button>
        </>}
        {stage === 'sign-in' && <button className="primary" disabled={!canEnter || !hasResume || busy} onClick={onReady}>检查设备并签到</button>}
        {stage === 'checked-in' && <button className="primary" disabled={!canEnter || !hasResume || busy} onClick={onReady}>{active.interview_id ? '继续本场面试' : '检查设备并进入'}</button>}
      </div>
      {!hasResume && <p className="appointment-quota">请先在下方选择或创建一份简历。</p>}
    </div> : <>
      {stage === 'elapsed' && <p className="appointment-quota">这个时段已结束或超过签到时间，可以选择其他时段。</p>}
      {!schedule && !error && <p role="status">正在读取预约时段…</p>}
      {schedule && days.size > 0 && <>
        <div className="appointment-calendar-tools">
          <label className="appointment-day">预约日期 <select value={day} onChange={event => { setChosenDay(event.target.value); setChosenSlot('') }}>
            {[...days.keys()].map(label => <option key={label} value={label}>{label}</option>)}
          </select></label>
          {overnight && (nextNight ? <button type="button" className="ghost action" disabled={busy} onClick={() => {
            setChosenDay(dayFormat.format(new Date(nextNight.start_at)))
            setChosenSlot('')
            if (slotList.current) slotList.current.scrollTop = 0
          }}>查看最近夜间时段</button> : <small>未来 7 天暂无可预约的夜间时段</small>)}
        </div>
        <div className="appointment-slots" ref={slotList} role="group" aria-label="选择预约时段">
          {(days.get(day) || []).map(slot => <button key={slot.start_at} type="button" aria-pressed={selection?.start_at === slot.start_at}
            disabled={busy || !slotAvailable(slot)} onClick={() => setChosenSlot(slot.start_at)}>
            <strong>{timeFormat.format(new Date(slot.start_at))}</strong><small>{slot.overnight && '夜间 · '}{slotAvailable(slot) ? slot.refill ? '可补位' : '可预约' : '不可预约'}</small>
          </button>)}
        </div>
        <button className="primary" disabled={!selection || busy} onClick={() => selection && onReserve(selection.start_at)}>{selection?.refill ? '确认补位' : '确认预约'}</button>
      </>}
      {schedule && !days.size && <p>暂时没有公布的时段，请稍后刷新。</p>}
    </>}
  </section>
}
