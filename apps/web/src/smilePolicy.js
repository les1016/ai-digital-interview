export const SMILE_SECONDS = 2.4
export const SMILE_GLOBAL_GAP_MS = 30000
export const REASSURANCE_GAP_MS = 180000
export const REASSURANCE_LIMIT = 2
export const REASSURANCE_CAPTION = '不用着急，可以先整理思路，从一个具体经历开始。'
export const SMILE_REASONS = ['welcome', 'resume', 'closing', 'silence', 'manual']

export function createSmilePolicy({ initial = {}, now = Date.now, save = () => {} } = {}) {
  const timestamp = value => Number.isFinite(value) && value >= 0 ? Math.min(value, now()) : 0
  const state = {
    lastSmileAt: timestamp(initial.lastSmileAt),
    lastReassureAt: timestamp(initial.lastReassureAt),
    count: Math.min(REASSURANCE_LIMIT, Math.max(0, Math.floor(Number(initial.count) || 0))),
    questions: Array.isArray(initial.questions) ? initial.questions.filter(q => typeof q === 'string').slice(-2) : [],
    lastProgress: Math.max(0, Number(initial.lastProgress) || 0),
  }
  function check({ reason, questionKey, progress = 0 }) {
    if (!SMILE_REASONS.includes(reason)) return 'unknown-reason'
    if (state.lastSmileAt && now() - state.lastSmileAt < SMILE_GLOBAL_GAP_MS) return 'global-cooldown'
    if (reason !== 'silence') return null
    if (!questionKey) return 'missing-question'
    if (state.count >= REASSURANCE_LIMIT) return 'interview-limit'
    if (state.questions.includes(String(questionKey))) return 'question-limit'
    if (state.lastReassureAt && now() - state.lastReassureAt < REASSURANCE_GAP_MS) return 'silence-cooldown'
    // Only a server-accepted answer advances progress, not noise or elapsed time.
    if (state.count && progress <= state.lastProgress) return 'awaiting-effective-answer'
    return null
  }
  return {
    check,
    reserve(request) {
      const blocked = check(request)
      if (blocked) return blocked
      state.lastSmileAt = now()
      if (request.reason === 'silence') {
        state.lastReassureAt = now()
        state.count++
        state.questions.push(String(request.questionKey))
        state.lastProgress = Math.max(0, Number(request.progress) || 0)
      }
      // Reserve before asynchronous playback. Failure never creates a retry loop.
      save({ ...state, questions: [...state.questions] })
      return null
    },
    snapshot() {
      return { ...state, questions: [...state.questions],
        globalRemaining: Math.max(0, Math.ceil((state.lastSmileAt + SMILE_GLOBAL_GAP_MS - now()) / 1000)),
        silenceRemaining: Math.max(0, Math.ceil((state.lastReassureAt + REASSURANCE_GAP_MS - now()) / 1000)),
      }
    },
  }
}
