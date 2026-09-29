// A small independently testable media state machine. One audio owner, a
// bounded wait, cancellation and once-per-request keys; no timers survive stop.
import { muteMedia } from './avatarActionCoordinator.js'

export function createAcknowledgmentPlayer({ video, getCompetingMedia = () => [], onState = () => {}, onEvent = () => {}, nowHidden = () => false, timers = globalThis, expectedDuration = 2, startTimeoutMs = 900, playbackTimeoutMs = 2800, coordinator, owner = 'acknowledgment', priority = 60, silent = false }) {
  let active = null
  const seen = new Set()
  function finish(outcome) {
    const ticket = active
    if (!ticket) return
    active = null
    const positionSeconds = Math.max(0, Number(video.currentTime) || 0)
    timers.clearTimeout(ticket.timeout)
    for (const [event, handler] of ticket.listeners) video.removeEventListener(event, handler)
    video.pause()
    video.muted = true
    try { video.currentTime = 0 } catch { /* metadata unavailable */ }
    for (const release of ticket.competitors) release()
    ticket.lease?.release()
    onState('idle')
    onEvent(outcome, { key: ticket.key, positionSeconds, durationSeconds: expectedDuration })
    ticket.resolve(outcome)
  }
  function play({ key, guard = () => true }) {
    if (!video || !key || active || seen.has(key) || !guard() || nowHidden() || video.error) return Promise.resolve('skipped')
    seen.add(key)
    if (seen.size > 128) seen.delete(seen.values().next().value)
    return new Promise(resolve => {
      const ticket = { key, guard, resolve, listeners: [], timeout: null, competitors: [] }
      active = ticket
      if (coordinator) {
        ticket.lease = coordinator.acquire({ owner, priority, cancel: () => finish('cancelled') })
        if (!ticket.lease) { active = null; resolve('skipped'); return }
      }
      const listen = (name, fn) => { video.addEventListener(name, fn); ticket.listeners.push([name, fn]) }
      const valid = () => Number.isFinite(video.duration) && Math.abs(video.duration - expectedDuration) < .15
      listen('loadedmetadata', () => { if (!valid()) finish('invalid-media') })
      listen('playing', () => {
        if (!guard() || nowHidden()) return finish('cancelled')
        if (!valid()) return finish('invalid-media')
        timers.clearTimeout(ticket.timeout)
        ticket.timeout = timers.setTimeout(() => finish('playback-timeout'), playbackTimeoutMs)
        onState('playing')
        onEvent('started', { key })
      })
      listen('ended', () => finish(guard() ? 'completed' : 'cancelled'))
      listen('error', () => finish('media-error'))
      if (video.readyState >= 1 && !valid()) return finish('invalid-media')
      video.pause()
      video.currentTime = 0
      video.loop = false
      video.playbackRate = 1
      for (const element of getCompetingMedia().filter(Boolean)) {
        ticket.competitors.push(muteMedia(element))
      }
      video.muted = silent
      onState('loading')
      onEvent('requested', { key })
      ticket.timeout = timers.setTimeout(() => finish('start-timeout'), startTimeoutMs)
      try {
        Promise.resolve(video.play()).then(() => {
          if (active !== ticket && !active) { video.pause(); video.muted = true }
        }).catch(() => { if (active === ticket) finish('play-blocked') })
      } catch { finish('play-blocked') }
    })
  }
  return { play, stop: () => finish('cancelled'), skip: () => finish('manual-skipped'), get busy() { return Boolean(active) } }
}
