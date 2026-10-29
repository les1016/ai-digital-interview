const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const DEFAULT_API_BASE = LOOPBACK_HOSTS.has(window.location.hostname)
  ? 'http://127.0.0.1:8000/api'
  : `${window.location.origin}/api`
const API_BASE = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE).replace(/\/+$/, '')
const DEFAULT_TIMEOUT = 75000
export const TOKEN_KEY = 'ai-interview-token'
let memoryToken = ''
// Bind requests to the identity accepted by this tab, not a new storage value
// that another tab wrote before React has restored the corresponding user.
let acceptedToken
let pendingChangedToken
const sessionRequests = new Set()

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'request_failed', retryable = false } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

export function getToken() {
  try {
    memoryToken = localStorage.getItem(TOKEN_KEY) || ''
    return memoryToken
  } catch {
    return memoryToken
  }
}

export function setToken(token) {
  cancelSessionRequests()
  memoryToken = token || ''
  acceptedToken = memoryToken
  pendingChangedToken = undefined
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Some browser privacy modes block localStorage; keep the session in memory.
  }
}

export function cancelSessionRequests() {
  for (const controller of sessionRequests) controller.abort('session_changed')
  sessionRequests.clear()
  avatarTicketCache = null
  avatarTicketPending = null
}

export function beginSessionChange() {
  cancelSessionRequests()
  pendingChangedToken = getToken()
  return pendingChangedToken
}

export function acceptSessionToken(token) {
  if (getToken() !== token) return false
  acceptedToken = token
  pendingChangedToken = undefined
  return true
}

function requestToken(expectedToken) {
  const token = getToken()
  if (expectedToken !== undefined) {
    if (token === expectedToken) return token
  } else {
    if (acceptedToken === undefined) acceptedToken = token
    if (token === acceptedToken) return token
  }
  cancelSessionRequests()
  if (pendingChangedToken !== token) {
    pendingChangedToken = token
    window.dispatchEvent(new Event('ai-interview-session-changed'))
  }
  throw new ApiError('登录状态已改变，请等待页面恢复后重试', { code: 'session_changed' })
}

function ensureResponseSession(token, controller) {
  if (getToken() !== token || controller.signal.reason === 'session_changed') {
    throw new ApiError('登录状态已改变，请重试', { code: 'session_changed' })
  }
}

export async function api(path, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, signal, expectedToken, ...fetchOptions } = options
  const headers = new Headers(fetchOptions.headers || {})
  const token = requestToken(expectedToken)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (fetchOptions.body && !(fetchOptions.body instanceof FormData)) headers.set('Content-Type', 'application/json')

  const controller = new AbortController()
  sessionRequests.add(controller)
  const abortFromCaller = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) abortFromCaller()
    else signal.addEventListener('abort', abortFromCaller, { once: true })
  }
  const timer = window.setTimeout(() => controller.abort('timeout'), timeout)

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...fetchOptions,
      headers,
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => ({}))
    ensureResponseSession(token, controller)
    if (!response.ok) {
      if (response.status === 401 && token && getToken() === token) {
        setToken('')
        window.dispatchEvent(new Event('ai-interview-auth-expired'))
      }
      const detail = Array.isArray(payload.detail)
        ? payload.detail.map(item => item.msg).filter(Boolean).join('；')
        : payload.detail
      throw new ApiError(detail || '请求失败，请稍后重试', {
        status: response.status,
        code: 'http_error',
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      })
    }
    return payload
  } catch (reason) {
    if (reason instanceof ApiError) throw reason
    if (controller.signal.reason === 'session_changed') {
      throw new ApiError('登录状态已改变，请重试', { code: 'session_changed' })
    }
    if (controller.signal.aborted && !signal?.aborted) {
      throw new ApiError('请求等待超时，请检查服务状态后重试', {
        code: 'timeout',
        retryable: true,
      })
    }
    if (signal?.aborted) {
      throw new ApiError('请求已取消', { code: 'aborted' })
    }
    throw new ApiError('无法连接本地服务，请确认一键启动已成功运行', {
      code: 'network_error',
      retryable: true,
    })
  } finally {
    sessionRequests.delete(controller)
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

export function apiKeepalive(path, body) {
  const url = `${API_BASE}${path}/beacon`
  const payload = JSON.stringify(body)
  if (navigator.sendBeacon) {
    return navigator.sendBeacon(url, new Blob([payload], { type: 'text/plain;charset=UTF-8' }))
  }
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: payload,
    keepalive: true,
  }).catch(() => null)
}

export async function apiBlob(path, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, signal, expectedToken, ...fetchOptions } = options
  const headers = new Headers(fetchOptions.headers || {})
  const token = requestToken(expectedToken)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const controller = new AbortController()
  sessionRequests.add(controller)
  const abortFromCaller = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) abortFromCaller()
    else signal.addEventListener('abort', abortFromCaller, { once: true })
  }
  const timer = window.setTimeout(() => controller.abort('timeout'), timeout)
  try {
    const response = await fetch(`${API_BASE}${path}`, { ...fetchOptions, headers, signal: controller.signal })
    ensureResponseSession(token, controller)
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      if (response.status === 401 && token && getToken() === token) {
        setToken('')
        window.dispatchEvent(new Event('ai-interview-auth-expired'))
      }
      throw new ApiError(payload.detail || '文档读取失败，请稍后重试', {
        status: response.status,
        code: 'http_error',
        retryable: response.status === 408 || response.status === 429 || response.status >= 500,
      })
    }
    const blob = await response.blob()
    ensureResponseSession(token, controller)
    return blob
  } catch (reason) {
    if (reason instanceof ApiError) throw reason
    if (controller.signal.reason === 'session_changed') {
      throw new ApiError('登录状态已改变，请重试', { code: 'session_changed' })
    }
    if (controller.signal.aborted && !signal?.aborted) {
      throw new ApiError('文档请求等待超时，请稍后重试', { code: 'timeout', retryable: true })
    }
    if (signal?.aborted) throw new ApiError('请求已取消', { code: 'aborted' })
    throw new ApiError('无法连接本地服务，请确认一键启动已成功运行', { code: 'network_error', retryable: true })
  } finally {
    sessionRequests.delete(controller)
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}

let avatarTicketCache = null
let avatarTicketPending = null
async function getAvatarTicket() {
  const accessToken = requestToken()
  if (avatarTicketCache?.accessToken === accessToken && avatarTicketCache.expires > Date.now()) return avatarTicketCache.token
  if (avatarTicketPending?.accessToken === accessToken) return avatarTicketPending.promise
  const pending = { accessToken, promise: null }
  pending.promise = api('/avatar/token', { method: 'POST' }).then(result => {
    if (getToken() !== accessToken) throw new Error('登录状态已改变，请重试')
    avatarTicketCache = { accessToken, token: result.token, expires: Date.now() + 60000 }
    return result.token
  }).finally(() => { if (avatarTicketPending === pending) avatarTicketPending = null })
  avatarTicketPending = pending
  return pending.promise
}

export async function avatarFetch(url, options = {}) {
  const accessToken = requestToken()
  const headers = new Headers(options.headers || {})
  headers.set('Authorization', `Bearer ${await getAvatarTicket()}`)
  if (getToken() !== accessToken) throw new ApiError('登录状态已改变，请重试', { code: 'session_changed' })
  return fetch(url, { ...options, headers })
}

export async function avatarSocket(url) {
  const accessToken = requestToken()
  const ticket = await getAvatarTicket()
  if (getToken() !== accessToken) throw new ApiError('登录状态已改变，请重试', { code: 'session_changed' })
  return new WebSocket(url, ['asr', `auth.${ticket}`])
}
