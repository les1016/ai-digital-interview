import test from 'node:test'
import assert from 'node:assert/strict'
import { createAvatarActionCoordinator } from '../apps/web/src/avatarActionCoordinator.js'
import { createAcknowledgmentPlayer } from '../apps/web/src/acknowledgmentPlayer.js'
import { createSmilePolicy } from '../apps/web/src/smilePolicy.js'

class Video extends EventTarget {
  duration = 2.4; readyState = 4; muted = true; currentTime = 0; paused = true; error = null
  play() { this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve() }
  pause() { this.paused = true }
}
const player = (coordinator, overrides = {}) => {
  const video = new Video()
  return { video, control: createAcknowledgmentPlayer({ video, coordinator, owner: 'smile', priority: 10,
    silent: true, expectedDuration: 2.4, ...overrides }) }
}

test('nod preempts smile; a low-priority smile cannot interrupt nod or queue for later', async () => {
  const coordinator = createAvatarActionCoordinator()
  const smile = player(coordinator), nod = player(coordinator, { owner: 'nod', priority: 60, silent: false })
  const one = smile.control.play({ key: 'smile' })
  const two = nod.control.play({ key: 'nod' })
  assert.equal(await one, 'cancelled'); assert.equal(smile.video.paused, true)
  assert.equal(coordinator.owner, 'nod'); assert.equal(smile.video.muted, true)
  assert.equal(await smile.control.play({ key: 'late-smile' }), 'skipped')
  nod.control.stop(); assert.equal(await two, 'cancelled')
  assert.equal(coordinator.owner, null); assert.equal(smile.control.busy, false)
})

test('one stop cancels loading and late media completion does not restart smile', async () => {
  const coordinator = createAvatarActionCoordinator(), smile = player(coordinator)
  let resolve
  smile.video.play = () => new Promise(r => { resolve = r })
  const promise = smile.control.play({ key: 'loading' })
  coordinator.cancelAll()
  assert.equal(await promise, 'cancelled')
  smile.video.paused = false; resolve(); await Promise.resolve()
  assert.equal(smile.video.paused, true); assert.equal(coordinator.owner, null)
})

test('shared audio stays muted until final lease ends, even without coordinator', async () => {
  const live = { muted: false }, a = player(undefined, { getCompetingMedia: () => [live] })
  const b = player(undefined, { getCompetingMedia: () => [live] })
  const p = a.control.play({ key: 'a' }), q = b.control.play({ key: 'b' })
  a.control.stop(); assert.equal(live.muted, true)
  b.control.stop(); assert.equal(live.muted, false)
  await Promise.all([p, q])
})

test('silence policy: 3 minutes, once per question, twice per interview, effective rearming', () => {
  let time = 1000000, persisted
  const policy = createSmilePolicy({ now: () => time, save: value => { persisted = value } })
  assert.equal(policy.reserve({ reason: 'silence', questionKey: '1', progress: 0 }), null)
  assert.equal(policy.check({ reason: 'resume' }), 'global-cooldown')
  time += 30001
  assert.equal(policy.check({ reason: 'resume' }), null)
  assert.equal(policy.check({ reason: 'silence', questionKey: '2', progress: 1 }), 'silence-cooldown')
  time += 180000
  assert.equal(policy.check({ reason: 'silence', questionKey: '1', progress: 1 }), 'question-limit')
  assert.equal(policy.check({ reason: 'silence', questionKey: '2', progress: 0 }), 'awaiting-effective-answer')
  assert.equal(policy.reserve({ reason: 'silence', questionKey: '2', progress: 1 }), null)
  time += 180001
  const restored = createSmilePolicy({ initial: persisted, now: () => time })
  assert.equal(restored.check({ reason: 'silence', questionKey: '3', progress: 2 }), 'interview-limit')
  assert.equal(restored.check({ reason: 'closing' }), null)
})

test('speech owns the stage; stale lease cannot release a new owner', async () => {
  const coordinator = createAvatarActionCoordinator()
  const first = coordinator.acquire({ owner: 'speech', priority: 100, cancel() {} })
  assert.equal(await player(coordinator).control.play({ key: 'forbidden' }), 'skipped')
  coordinator.cancelAll()
  const next = coordinator.acquire({ owner: 'opening', priority: 80, cancel() {} })
  first.release(); assert.equal(coordinator.owner, 'opening')
  next.release(); assert.equal(coordinator.owner, null)
})
