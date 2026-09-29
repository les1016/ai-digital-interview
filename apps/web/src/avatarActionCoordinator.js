// Per interview stage, not a global singleton. No queue: outdated expressions
// must never play after a newer question, pause, or navigation.
export function createAvatarActionCoordinator() {
  let current = null
  return {
    acquire({ owner, priority, cancel }) {
      if (current && current.priority >= priority) return null
      const previous = current
      current = null
      previous?.cancel()
      const ticket = { owner, priority, cancel }
      current = ticket
      return { release() { if (current === ticket) current = null } }
    },
    cancelAll() {
      const previous = current
      current = null
      previous?.cancel()
    },
    get owner() { return current?.owner || null },
  }
}

// Ref-counted mute leases also protect callers without a coordinator. Restoring
// an old boolean from an overlapping player must not unmute somebody else's audio.
const mutedMedia = new WeakMap()
export function muteMedia(element) {
  let entry = mutedMedia.get(element)
  if (!entry) {
    entry = { original: element.muted, count: 0 }
    mutedMedia.set(element, entry)
  }
  entry.count++
  element.muted = true
  let released = false
  return () => {
    if (released) return
    released = true
    if (--entry.count === 0) {
      element.muted = entry.original
      mutedMedia.delete(element)
    }
  }
}
