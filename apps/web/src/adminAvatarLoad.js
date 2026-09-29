// A per-connection stopwatch. Opening video and TTS never gate avatar readiness.
export const AVATAR_LOAD_STAGES = ['session', 'rtc', 'video', 'audio']
export const INITIAL_AVATAR_LOAD = { attempt: 0, status: 'idle', startedAt: null, completedAt: null, stoppedAt: null }

export function beginAvatarLoad(previous, now) {
  return { ...INITIAL_AVATAR_LOAD, attempt: previous.attempt + 1, status: 'loading', startedAt: now }
}

export function updateAvatarLoad(previous, stages, now) {
  if (previous.startedAt === null) return previous
  const statuses = AVATAR_LOAD_STAGES.map(key => stages[key]?.status)
  if (statuses.every(status => status === 'ready')) {
    return { ...previous, status: 'ready', completedAt: previous.completedAt ?? now, stoppedAt: null }
  }
  if (statuses.some(status => ['error', 'degraded', 'idle'].includes(status))) {
    const status = previous.completedAt !== null ? 'disconnected' : statuses.some(s => ['error', 'degraded'].includes(s)) ? 'failed' : 'cancelled'
    return { ...previous, status, stoppedAt: previous.stoppedAt ?? now }
  }
  return { ...previous, status: previous.completedAt !== null ? 'buffering' : 'loading', stoppedAt: null }
}

export function avatarLoadSeconds(snapshot, now) {
  if (snapshot.startedAt === null) return 0
  return Math.max(0, ((snapshot.completedAt ?? snapshot.stoppedAt ?? now) - snapshot.startedAt) / 1000)
}
