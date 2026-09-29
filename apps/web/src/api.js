const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const DEFAULT_API_BASE = LOOPBACK_HOSTS.has(window.location.hostname)
  ? 'http://127.0.0.1:8000/api'
  : `${window.location.origin}/api`
const API_BASE = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE).replace(/\/+$/, '')
const DEFAULT_TIMEOUT = 75000
const TOKEN_KEY = 'ai-interview-token'
let memoryToken = ''

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
    return localStorage.getItem(TOKEN_KEY) || memoryToken
  } catch {
    return memoryToken
  }
}

export function setToken(token) {
  memoryToken = token || ''
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Some browser privacy modes block localStorage; keep the session in memory.
  }
}

export async function api(path, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, signal, ...fetchOptions } = options
  const headers = new Headers(fetchOptions.headers || {})
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (fetchOptions.body && !(fetchOptions.body instanceof FormData)) headers.set('Content-Type', 'application/json')

  const controller = new AbortController()
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
  const { timeout = DEFAULT_TIMEOUT, signal, ...fetchOptions } = options
  const headers = new Headers(fetchOptions.headers || {})
  const token = getToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(signal?.reason)
  if (signal) {
    if (signal.aborted) abortFromCaller()
    else signal.addEventListener('abort', abortFromCaller, { once: true })
  }
  const timer = window.setTimeout(() => controller.abort('timeout'), timeout)
  try {
    const response = await fetch(`${API_BASE}${path}`, { ...fetchOptions, headers, signal: controller.signal })
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
    return response.blob()
  } catch (reason) {
    if (reason instanceof ApiError) throw reason
    if (controller.signal.aborted && !signal?.aborted) {
      throw new ApiError('文档请求等待超时，请稍后重试', { code: 'timeout', retryable: true })
    }
    if (signal?.aborted) throw new ApiError('请求已取消', { code: 'aborted' })
    throw new ApiError('无法连接本地服务，请确认一键启动已成功运行', { code: 'network_error', retryable: true })
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', abortFromCaller)
  }
}
