import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer, loadConfigFromFile } from '../apps/web/node_modules/vite/dist/node/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('Vite denies direct and raw access to the private administrator script', async () => {
  const result = await loadConfigFromFile(
    { command: 'serve', mode: 'test' }, path.join(root, 'apps/web/vite.config.js'), undefined, 'silent',
  )
  assert.ok(result?.config.server?.fs?.deny)
  const fixture = await mkdtemp(path.join(tmpdir(), 'admin-demo-privacy-'))
  let server
  try {
    const data = path.join(fixture, 'src', 'data')
    await mkdir(data, { recursive: true })
    await writeFile(path.join(data, 'adminInterviewScript.json'), JSON.stringify({ marker: 'synthetic-private-test-marker' }))
    server = await createServer({
      configFile: false, root: fixture, publicDir: false, logLevel: 'silent', appType: 'custom',
      server: {
        host: '127.0.0.1', port: 0,
        fs: { ...result.config.server.fs, allow: [fixture] },
      },
    })
    await server.listen()
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`
    for (const resource of [
      '/src/data/adminInterviewScript.json',
      '/src/data/adminInterviewScript.json?raw',
      '/src/data/adminInterviewScript.json?import',
    ]) {
      const response = await fetch(origin + resource)
      assert.equal(response.status, 403, resource)
      assert.ok(!(await response.text()).includes('synthetic-private-test-marker'))
    }
  } finally {
    await server?.close()
    await rm(fixture, { recursive: true, force: true })
  }
})
