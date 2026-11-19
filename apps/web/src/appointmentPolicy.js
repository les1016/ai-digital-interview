export function appointmentStage(appointment, now) {
  if (!appointment) return 'none'
  if (appointment.status === 'checked_in') {
    const end = Date.parse(appointment.ends_at)
    return Number.isFinite(end) && now < end ? 'checked-in' : 'elapsed'
  }
  if (appointment.status !== 'booked') return 'none'
  const start = Date.parse(appointment.start_at)
  const cutoff = Date.parse(appointment.check_in_by)
  if (!Number.isFinite(start) || !Number.isFinite(cutoff) || now >= cutoff) return 'elapsed'
  return now < start ? 'upcoming' : 'sign-in'
}

export function availableAppointmentSlot(slot, now) {
  return Boolean(slot.available && Date.parse(slot.check_in_by) > now)
}
