import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const apiSource = fs.readFileSync(new URL('../apps/web/src/api.js', import.meta.url), 'utf8')
const appSource = fs.readFileSync(new URL('../apps/web/src/App.jsx', import.meta.url), 'utf8')

function harness() {
  const values = new Map()
  const listeners = new Map()
  const calls = []
  let blocked = false
  let fetcher = async () => ({ ok: true, status: 200, json: async () => ({ id: 1 }) })
  const storage = {
    getItem(key) { if (blocked) throw new Error('storage denied'); return values.get(key) ?? null },
    setItem(key, value) { if (blocked) throw new Error('storage denied'); values.set(key, value) },
    removeItem(key) { if (blocked) throw new Error('storage denied'); values.delete(key) },
  }
  const window = {
    location: { hostname: 'localhost', origin: 'http://localhost' },
    localStorage: storage,
    setTimeout, clearTimeout,
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener) },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener) },
    dispatchEvent(event) { for (const listener of [...(listeners.get(event.type) || [])]) listener(event) },
  }
  const context = { window, localStorage: storage, AbortController, Headers, FormData, Event, Blob,
    fetch: (...args) => { calls.push(args); return fetcher(...args) } }
  vm.runInNewContext(apiSource.replaceAll('import.meta.env', '({})').replace(/\bexport\s+/g, '') +
    '\nthis.module = {getToken,setToken,beginSessionChange,acceptSessionToken,cancelSessionRequests,api,apiBlob,TOKEN_KEY};', context)
  return { context, window, values, calls, module: context.module,
    blockStorage(value = true) { blocked = value },
    setFetch(value) { fetcher = value },
  }
}

test('storage deletion clears the memory copy; access errors retain in-memory login', () => {
  const h = harness()
  h.module.setToken('account-A')
  h.blockStorage()
  assert.equal(h.module.getToken(), 'account-A')
  h.blockStorage(false)
  h.values.delete(h.module.TOKEN_KEY)
  assert.equal(h.module.getToken(), '')
  h.blockStorage()
  assert.equal(h.module.getToken(), '')
  h.module.setToken('memory-only-account')
  assert.equal(h.module.getToken(), 'memory-only-account')
  h.module.setToken('')
  assert.equal(h.module.getToken(), '')
})

test('old account requests cannot silently send another tab account token', async () => {
  const h = harness()
  h.module.setToken('account-A')
  h.values.set(h.module.TOKEN_KEY, 'account-B')
  await assert.rejects(h.module.api('/resumes/quick', { method: 'POST', body: '{}' }), { code: 'session_changed' })
  assert.equal(h.calls.length, 0)
  const token = h.module.beginSessionChange()
  await h.module.api('/me', { expectedToken: token })
  assert.equal(h.calls[0][1].headers.get('Authorization'), 'Bearer account-B')
  assert.equal(h.module.acceptSessionToken(token), true)
  await h.module.api('/resumes')
  assert.equal(h.calls[1][1].headers.get('Authorization'), 'Bearer account-B')
})

test('logout in another tab rejects rather than resurrecting old credentials', async () => {
  const h = harness()
  h.module.setToken('account-A')
  h.values.delete(h.module.TOKEN_KEY)
  await assert.rejects(h.module.api('/resumes'), { code: 'session_changed' })
  assert.equal(h.calls.length, 0)
  assert.equal(h.module.getToken(), '')
})

test('session changes cancel in-flight requests and discard late JSON and blob results', async () => {
  for (const method of ['api', 'apiBlob']) {
    const h = harness()
    let deliver
    h.module.setToken('account-A')
    h.setFetch((_url, options) => new Promise(resolve => {
      deliver = () => resolve({ ok: true, status: 200, json: async () => ({ private: 'synthetic A data' }), blob: async () => new Blob(['synthetic A data']) })
      assert.equal(options.signal.aborted, false)
    }))
    const request = h.module[method]('/private')
    h.values.set(h.module.TOKEN_KEY, 'account-B')
    h.module.beginSessionChange()
    assert.equal(h.calls[0][1].signal.aborted, true)
    deliver()
    await assert.rejects(request, { code: 'session_changed' })
  }
})

function mountSessionEffect(h) {
  const start = appSource.indexOf('  useEffect(() => {')
  const end = appSource.indexOf('\n  }, [])', start)
  assert.ok(start > 0 && end > start)
  const body = appSource.slice(start + '  useEffect(() => {'.length, end)
  const state = { user: { id: 'old-account' }, authOpen: true, checking: false }
  const context = h.context
  Object.assign(context, h.module, {
    setUser: value => { state.user = value },
    setAuthOpen: value => { state.authOpen = value },
    setCheckingSession: value => { state.checking = value },
  })
  const cleanup = vm.runInNewContext(`(() => { ${body}\n})()`, context)
  return { state, cleanup }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

test('App storage event unmounts old user immediately, restores new identity, and ignores stale restore', async () => {
  const h = harness()
  const deliveries = []
  h.module.setToken('account-A')
  h.setFetch((_url, options) => new Promise(resolve => deliveries.push({ options, resolve })))
  const { state, cleanup } = mountSessionEffect(h)
  assert.equal(state.user, null)
  h.values.set(h.module.TOKEN_KEY, 'account-B')
  h.window.dispatchEvent({ type: 'storage', key: h.module.TOKEN_KEY, storageArea: h.window.localStorage })
  assert.equal(state.user, null)
  assert.equal(state.authOpen, false)
  assert.equal(state.checking, true)
  assert.equal(deliveries[0].options.signal.aborted, true)
  deliveries[1].resolve({ ok: true, status: 200, json: async () => ({ id: 'B' }) })
  await settle()
  assert.equal(state.user.id, 'B')
  assert.equal(state.checking, false)
  deliveries[0].resolve({ ok: true, status: 200, json: async () => ({ id: 'A' }) })
  await settle()
  assert.equal(state.user.id, 'B')
  h.values.clear()
  h.window.dispatchEvent({ type: 'storage', key: null, storageArea: h.window.localStorage })
  assert.equal(state.user, null)
  assert.equal(state.checking, false)
  assert.equal(h.module.getToken(), '')
  cleanup()
})

test('late failure from a previous account cannot clear the newly restored account token', async () => {
  const h = harness()
  const deliveries = []
  h.module.setToken('account-A')
  h.setFetch(() => new Promise(resolve => deliveries.push(resolve)))
  const { state, cleanup } = mountSessionEffect(h)
  h.values.set(h.module.TOKEN_KEY, 'account-B')
  h.window.dispatchEvent({ type: 'storage', key: h.module.TOKEN_KEY })
  deliveries[1]({ ok: true, status: 200, json: async () => ({ id: 'B' }) })
  await settle()
  deliveries[0]({ ok: false, status: 401, json: async () => ({ detail: 'old account expired' }) })
  await settle()
  assert.equal(h.module.getToken(), 'account-B')
  assert.equal(state.user.id, 'B')
  cleanup()
})
