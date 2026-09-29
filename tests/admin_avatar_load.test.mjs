import test from 'node:test'
import assert from 'node:assert/strict'
import { INITIAL_AVATAR_LOAD, beginAvatarLoad, updateAvatarLoad, avatarLoadSeconds } from '../apps/web/src/adminAvatarLoad.js'

const stages = (overrides = {}) => Object.fromEntries(Object.entries({ session:'ready',rtc:'ready',video:'ready',audio:'ready',tts:'idle', ...overrides }).map(([k,status])=>[k,{status}]))

test('loading time advances until all four actual media stages are ready', () => {
  let state = beginAvatarLoad(INITIAL_AVATAR_LOAD, 1000)
  state = updateAvatarLoad(state, stages({video:'pending'}), 4200)
  assert.equal(state.status,'loading');assert.equal(avatarLoadSeconds(state, 5300),4.3)
  state = updateAvatarLoad(state, stages(), 7625)
  assert.equal(state.status,'ready');assert.equal(avatarLoadSeconds(state, 12000),6.625)
  assert.equal(state.completedAt,7625)
})

test('completion does not wait for TTS and never keeps counting through the intro', () => {
  let state = beginAvatarLoad(INITIAL_AVATAR_LOAD, 0)
  state = updateAvatarLoad(state, stages({tts:'pending'}), 6400)
  assert.equal(state.status,'ready')
  state = updateAvatarLoad(state, stages(), 31000)
  assert.equal(avatarLoadSeconds(state, 60000),6.4)
})

test('session creation alone and partial audio cannot claim ready', () => {
  for (const missing of ['rtc','video','audio']) {
    const state = updateAvatarLoad(beginAvatarLoad(INITIAL_AVATAR_LOAD, 0), stages({[missing]:'pending'}), 2000)
    assert.equal(state.status,'loading');assert.equal(state.completedAt,null)
  }
})

test('explicit reconnect starts a new independent stopwatch', () => {
  let state = updateAvatarLoad(beginAvatarLoad(INITIAL_AVATAR_LOAD, 1000), stages(), 5500)
  state = beginAvatarLoad(state, 20000)
  assert.equal(state.attempt,2);assert.equal(state.status,'loading');assert.equal(state.completedAt,null)
  assert.equal(avatarLoadSeconds(state, 20250),.25)
  state = updateAvatarLoad(state, stages(), 22000)
  assert.equal(avatarLoadSeconds(state, 99000),2)
})

test('failure freezes incomplete time and does not invent a completion', () => {
  const state = updateAvatarLoad(beginAvatarLoad(INITIAL_AVATAR_LOAD, 0), stages({session:'error'}), 3000)
  assert.equal(state.status,'failed');assert.equal(state.completedAt,null)
  assert.equal(avatarLoadSeconds(state, 9000),3)
})

test('later buffering or disconnect is visible while retaining the first completion time', () => {
  let state = updateAvatarLoad(beginAvatarLoad(INITIAL_AVATAR_LOAD, 0), stages(), 6400)
  state = updateAvatarLoad(state, stages({video:'pending'}), 10000)
  assert.equal(state.status,'buffering');assert.equal(avatarLoadSeconds(state, 20000),6.4)
  state = updateAvatarLoad(state, stages({rtc:'error'}), 25000)
  assert.equal(state.status,'disconnected')
  state = updateAvatarLoad(state, stages(), 30000)
  assert.equal(state.status,'ready');assert.equal(avatarLoadSeconds(state, 40000),6.4)
})

test('idle and cancellation do not show a successful load', () => {
  assert.equal(updateAvatarLoad(INITIAL_AVATAR_LOAD, stages(), 9000),INITIAL_AVATAR_LOAD)
  const state = updateAvatarLoad(beginAvatarLoad(INITIAL_AVATAR_LOAD, 1000), stages({session:'idle'}), 5000)
  assert.equal(state.status,'cancelled');assert.equal(avatarLoadSeconds(state, 99000),4)
})
