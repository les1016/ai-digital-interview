const assert = require('node:assert/strict')
const { readFile } = require('node:fs/promises')
const { createServer } = require('node:http')
const { extname, isAbsolute, relative, resolve } = require('node:path')
const { after, before, test } = require('node:test')
const { chromium } = require('playwright')

// Run against a Vite build made with VITE_API_BASE_URL=/api and
// VITE_LIVETALKING_URL=/avatar. No project server, account, or hardware is used.
const root = resolve(process.env.APPOINTMENT_TEST_WEB_DIST || resolve(__dirname, '../apps/web/dist'))
const baseTime = '2031-02-01T10:00:00.000Z'
const appointment = { id: 8, status: 'booked', start_at: baseTime, check_in_by: '2031-02-01T10:05:00Z', ends_at: null, interview_id: null }
const interview = { id: 42, resume_id: 1, target_role: '虚构测试岗位', started_at: baseTime, status: 'active', question: '请描述一个虚构项目。' }
const readyRecord = { ...interview, status: 'ready_to_finish', messages: [
  { speaker: 'interviewer', kind: 'question', content: interview.question },
  { speaker: 'candidate', kind: 'answer', content: '我完成了一个用于测试的虚构项目。' },
] }
const report = { overall_score: 82, summary: '这是合成的测试报告。' }
let origin
let browser
let server

before(async () => {
  await readFile(resolve(root, 'index.html'))
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    const file = resolve(root, '.' + (path === '/' ? '/index.html' : path))
    const outside = relative(root, file)
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)]
    try {
      if (!type || isAbsolute(outside) || outside.startsWith('..')) throw new Error('Unknown fixture asset')
      const body = await readFile(file)
      res.writeHead(200, { 'Content-Type': type }).end(body)
    } catch { res.writeHead(404).end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_EXECUTABLE,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
})

after(async () => {
  await browser?.close()
  await new Promise(resolve => server ? server.close(resolve) : resolve())
})

async function setup(t, { reportOnly = false, detailsFailOnce = false, finalResponse } = {}) {
  const context = await browser.newContext({ permissions: ['camera', 'microphone'], viewport: { width: 390, height: 844 } })
  t.after(() => context.close())
  await context.addInitScript(() => {
    localStorage.setItem('ai-interview-token', 'synthetic-test-user')
    const nativeClock = performance.now.bind(performance)
    window.appointmentClockOffset = 0
    Object.defineProperty(performance, 'now', { value: () => nativeClock() + window.appointmentClockOffset })

    const getFakeMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    window.testStreams = []
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const media = await getFakeMedia(...args)
      window.testStreams.push(media)
      return media
    }
    window.testPeerEvents = []
    window.RTCPeerConnection = class {
      constructor() { this.iceGatheringState = 'complete'; this.connectionState = 'connected' }
      addTransceiver() {}
      addEventListener() {}
      createOffer() { return { type: 'offer', sdp: 'synthetic test offer' } }
      setLocalDescription(offer) { this.localDescription = offer }
      setRemoteDescription() { window.testPeerEvents.push('connected') }
      close() { this.connectionState = 'closed'; window.testPeerEvents.push('closed') }
    }
    window.testRecorderEvents = []
    window.MediaRecorder = class extends window.MediaRecorder {
      start(...args) { super.start(...args); window.testRecorderEvents.push('start') }
      stop(...args) { super.stop(...args); window.testRecorderEvents.push('stop') }
    }
  })

  let active = reportOnly ? null : appointment
  let completed = false
  const calls = []
  await context.route('**/*', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.origin !== origin) return route.abort()
    if (!/^\/(api|avatar)\//.test(url.pathname)) return route.continue()
    const call = `${request.method()} ${url.pathname}`
    calls.push(call)
    let json = { ok: true }
    let status = 200
    switch (call) {
      case 'GET /api/me': json = { id: 1, name: '虚构测试账号', role: 'student' }; break
      case 'GET /api/resumes': json = [{ id: 1, title: '虚构简历', created_at: baseTime, source: 'quick' }]; break
      case 'GET /api/interviews': json = reportOnly ? [readyRecord] : []; break
      case 'POST /api/interviews': json = interview; break
      case 'GET /api/interviews/42':
        if (detailsFailOnce) { detailsFailOnce = false; status = 503; json = { detail: '测试：暂时无法读取面试记录' } }
        else json = completed ? { ...readyRecord, status: 'completed', report } : readyRecord
        break
      case 'POST /api/interviews/42/session/open':
        status = 409; json = { detail: '本场预约的面试时间已结束，已保存的回答仍可用于生成报告' }; break
      case 'POST /api/interviews/42/finish': completed = true; json = report; break
      case 'POST /api/appointments/8/check-in':
        active = json = { ...appointment, status: 'checked_in', started_at: baseTime, ends_at: '2031-02-01T10:20:00Z' }; break
      case 'GET /api/appointments':
        json = { now: baseTime, timezone: 'Asia/Shanghai', remaining_today: 1, remaining_7_days: 3,
          overnight: { start_hour: 0, end_hour: 7, daily_limit: 3, remaining_today: 3 }, active, slots: [] }; break
      case 'GET /api/account/interruption-status': json = { cooldown_remaining_seconds: 0 }; break
      case 'POST /api/avatar/token':
      case 'GET /api/avatar/token': json = { token: 'synthetic-avatar-ticket' }; break
      case 'POST /avatar/offer': json = { sessionid: 'fake', sdp: 'synthetic test answer' }; break
      case 'POST /avatar/is_speaking': json = { data: false }; break
      case 'POST /api/interviews/42/recording/chunks':
        if (url.searchParams.get('final') === 'true') status = await finalResponse()
        break
    }
    await route.fulfill({ status, json })
  })

  const page = await context.newPage()
  page.on('dialog', dialog => dialog.accept())
  await page.goto(origin)
  return { page, calls }
}

test('an expired interview with a saved answer can generate a report without reopening the session', { timeout: 20000 }, async t => {
  const { page, calls } = await setup(t, { reportOnly: true, detailsFailOnce: true })
  await page.getByRole('button', { name: '生成报告', exact: true }).click()
  await page.getByRole('heading', { name: '准备生成成长报告' }).waitFor({ timeout: 5000 })
  const read = page.getByRole('button', { name: '读取已保存的问答' })
  await read.click()
  await page.getByRole('alert').filter({ hasText: '测试：暂时无法读取面试记录' }).waitFor({ timeout: 5000 })
  await read.click()
  await page.getByRole('button', { name: '结束面试并生成报告' }).click()
  await page.getByRole('heading', { name: '你的面试成长报告' }).waitFor({ timeout: 5000 })
  assert.equal(await page.getByText(readyRecord.messages[1].content, { exact: true }).isVisible(), true)
  assert.equal(calls.filter(call => call === 'POST /api/interviews/42/finish').length, 1)
  assert.equal(calls.some(call => /\/session\/open|\/offer|\/recording\/chunks/.test(call)), false)
  assert.equal(await page.evaluate(() => window.testStreams.length), 0)
})

test('exit immediately releases both devices while a final recording upload is pending, and can retry a failed save', { timeout: 25000 }, async t => {
  const finalStarted = Promise.withResolvers()
  const finishFirstUpload = Promise.withResolvers()
  let attempts = 0
  const finalResponse = async () => {
    attempts += 1
    if (attempts !== 1) return attempts === 2 ? 422 : 200
    finalStarted.resolve()
    return finishFirstUpload.promise
  }
  const { page, calls } = await setup(t, { finalResponse })
  try {
    await page.getByRole('button', { name: /虚构简历/ }).click()
    await page.getByRole('button', { name: '检查设备并签到' }).click()
    await page.getByRole('checkbox').check()
    await page.getByRole('button', { name: '设备正常，立即签到' }).click()
    await page.getByRole('button', { name: '开始模拟面试' }).click()
    await page.waitForFunction(() => window.testRecorderEvents.includes('start') && window.testPeerEvents.includes('connected'), undefined, { timeout: 5000 })
    assert.deepEqual(await page.evaluate(mediaTrackStates), [['audio', 'live'], ['video', 'live']])
    await page.getByRole('button', { name: '退出面试室' }).click()
    const timer = setTimeout(() => finalStarted.reject(new Error('Final recording marker was not sent')), 5000)
    try { await finalStarted.promise } finally { clearTimeout(timer) }
    await page.getByText('正在保存录像后退出', { exact: true }).waitFor({ timeout: 5000 })
    assert.deepEqual(await page.evaluate(mediaTrackStates), [['audio', 'ended'], ['video', 'ended']])
    assert.deepEqual(await page.evaluate(() => window.testRecorderEvents), ['start', 'stop'])
    assert.equal(await page.getByText('剩余 00:00', { exact: true }).isVisible(), false)
    await page.evaluate(() => { window.appointmentClockOffset = 21 * 60 * 1000 })
    await page.getByText('剩余 00:00', { exact: true }).waitFor({ timeout: 5000 })
    assert.deepEqual(await page.evaluate(mediaTrackStates), [['audio', 'ended'], ['video', 'ended']])
    finishFirstUpload.resolve(422)
    const retry = page.getByRole('button', { name: '重试保存并退出' })
    await retry.waitFor({ timeout: 5000 })
    assert.equal(attempts, 2)
    await retry.click()
    await page.getByRole('heading', { name: '选一个方便的时间' }).waitFor({ timeout: 5000 })
    assert.equal(attempts, 3)
    assert.equal(calls.some(call => /\/finish|\/interruptions/.test(call)), false)
  } finally {
    finishFirstUpload.resolve(200)
  }
})

function mediaTrackStates() {
  return window.testStreams.flatMap(stream => stream.getTracks().map(track => [track.kind, track.readyState])).sort()
}
