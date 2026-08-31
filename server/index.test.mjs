import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { JobStore, startServer } from '../dist-server/index.js'

const server = await startServer(0)
const address = server.address()
const baseUrl = `http://127.0.0.1:${address.port}`

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options)
  const contentType = response.headers.get('content-type') ?? ''
  const body = contentType.includes('json') ? await response.json() : await response.text()
  return { response, body }
}

test('健康检查保持既有契约', async () => {
  const { response, body } = await request('/health')
  assert.equal(response.status, 200)
  assert.deepEqual(body, { status: 'ok', service: 'lingtu-workbench' })
})

test('按配置托管静态首页和资源，并隔离静态 404 与 API 404', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-static-'))
  const staticDir = join(directory, 'dist')
  mkdirSync(join(staticDir, 'assets'), { recursive: true })
  writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>灵图工作台</title>')
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log("ok")')
  writeFileSync(join(staticDir, 'assets', 'app.css'), 'body{color:red}')
  writeFileSync(join(staticDir, 'assets', 'icon.svg'), '<svg></svg>')
  writeFileSync(join(staticDir, 'assets', 'image.png'), Buffer.from([137, 80, 78, 71]))
  writeFileSync(join(staticDir, 'assets', 'favicon.ico'), Buffer.from([0, 0, 1, 0]))
  writeFileSync(join(staticDir, 'assets', 'image.webp'), Buffer.from([82, 73, 70, 70]))
  writeFileSync(join(directory, 'secret.txt'), 'private')
  const staticStore = new JobStore()
  const staticServer = await startServer(0, '127.0.0.1', staticStore, { staticDir })
  const staticAddress = staticServer.address()
  const staticBaseUrl = `http://127.0.0.1:${staticAddress.port}`
  try {
    const indexResponse = await fetch(`${staticBaseUrl}/`)
    assert.equal(indexResponse.status, 200)
    assert.match(indexResponse.headers.get('content-type') ?? '', /^text\/html/)
    assert.match(await indexResponse.text(), /灵图工作台/)

    for (const [file, contentType] of [['app.js', 'text/javascript'], ['app.css', 'text/css'], ['icon.svg', 'image/svg+xml'], ['image.png', 'image/png'], ['favicon.ico', 'image/x-icon'], ['image.webp', 'image/webp']]) {
      const response = await fetch(`${staticBaseUrl}/assets/${file}`)
      assert.equal(response.status, 200)
      assert.equal((response.headers.get('content-type') ?? '').split(';')[0], contentType)
    }

    const missingResponse = await fetch(`${staticBaseUrl}/assets/missing.js`)
    assert.equal(missingResponse.status, 404)
    assert.match(missingResponse.headers.get('content-type') ?? '', /^text\/plain/)
    assert.equal(await missingResponse.text(), '静态资源不存在')

    const traversalResponse = await fetch(`${staticBaseUrl}/assets/%2e%2e/secret.txt`)
    assert.equal(traversalResponse.status, 404)
    assert.equal(await traversalResponse.text(), '静态资源不存在')

    const apiResponse = await fetch(`${staticBaseUrl}/api/does-not-exist`)
    assert.equal(apiResponse.status, 404)
    assert.match(apiResponse.headers.get('content-type') ?? '', /application\/json/)
    assert.deepEqual(await apiResponse.json(), { error: { code: 'not_found', message: '接口不存在' } })
  } finally {
    await new Promise((resolve, reject) => staticServer.close((error) => error ? reject(error) : resolve()))
    staticStore.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('创建任务并按幂等键返回同一任务', async () => {
  const payload = JSON.stringify({ mode: 'generate', idempotencyKey: 'test-create-1' })
  const first = await request('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
  const second = await request('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
  assert.equal(first.response.status, 201)
  assert.equal(second.response.status, 200)
  assert.equal(second.body.id, first.body.id)
  assert.equal(first.body.status, 'queued')
  assert.equal(first.body.provider.invoked, false)
})

test('拒绝非法模式和不足两个窗口的一裂多任务', async () => {
  const invalidMode = await request('/api/jobs', { method: 'POST', body: JSON.stringify({ mode: 'unknown' }) })
  assert.equal(invalidMode.response.status, 400)
  assert.equal(invalidMode.body.error.code, 'invalid_mode')

  const invalidWindows = await request('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ mode: 'one-to-many', windows: [{ prompt: '仅一个窗口' }] }),
  })
  assert.equal(invalidWindows.response.status, 400)
  assert.equal(invalidWindows.body.error.code, 'invalid_windows')
})

test('任务可查询、发送 SSE 初始快照并取消', async () => {
  const created = await request('/api/jobs', { method: 'POST', body: JSON.stringify({ mode: 'text' }) })
  const id = created.body.id
  const events = await request(`/api/jobs/${id}/events`)
  assert.equal(events.response.status, 200)
  assert.match(events.body, /event: snapshot/)
  assert.match(events.body, /"status":"queued"/)

  const cancelled = await request(`/api/jobs/${id}/cancel`, { method: 'POST' })
  assert.equal(cancelled.response.status, 200)
  assert.equal(cancelled.body.status, 'cancelled')
  const detail = await request(`/api/jobs/${id}`)
  assert.equal(detail.body.status, 'cancelled')
})

test('任务元数据可从 SQLite 跨实例回读', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-server-'))
  const dbPath = join(directory, 'jobs.db')
  const firstStore = new JobStore(dbPath)
  const created = firstStore.create({ mode: 'generate' }, 'sqlite-roundtrip')
  firstStore.close()

  const secondStore = new JobStore(dbPath)
  const restored = secondStore.get(created.job.id)
  assert.equal(restored?.id, created.job.id)
  assert.equal(restored?.idempotencyKey, 'sqlite-roundtrip')
  secondStore.close()
  rmSync(directory, { recursive: true, force: true })
})

test('edit 模式必须提供源图片，并通过 mock Provider 完成改图任务', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-edit-workspace-'))
  const dbPath = join(directory, 'jobs.db')
  let editCalls = 0
  const mockEdit = async ({ prompt, sourceImage, size, quality, signal }) => {
    editCalls += 1
    assert.equal(prompt, '把背景改成蓝色')
    assert.deepEqual(sourceImage, { data: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/png', name: 'source.png' })
    assert.equal(size, '1024x1024')
    assert.equal(quality, 'high')
    assert.equal(signal.aborted, false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { kind: 'base64', value: 'ZmFrZS1pbWFnZQ==' }
  }
  const mockStore = new JobStore(dbPath)
  const mockServer = await startServer(0, '127.0.0.1', mockStore, {
    workspaceDir: directory,
    editImage: mockEdit,
  })
  const mockAddress = mockServer.address()
  const mockBaseUrl = `http://127.0.0.1:${mockAddress.port}`
  try {
    const invalidResponse = await fetch(`${mockBaseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'edit', prompt: '缺少源图' }),
    })
    assert.equal(invalidResponse.status, 400)
    assert.equal((await invalidResponse.json()).error.code, 'invalid_source_image')

    assert.throws(
      () => mockStore.create({ mode: 'edit', prompt: '图片太大', sourceImage: { data: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64'), mimeType: 'image/png', name: 'large.png' } }),
      (error) => error?.code === 'source_image_too_large',
    )
    assert.throws(
      () => mockStore.create({ mode: 'edit', prompt: '格式错误', sourceImage: { data: 'ab=c', mimeType: 'image/png', name: 'invalid.png' } }),
      (error) => error?.code === 'invalid_source_image',
    )

    const createResponse = await fetch(`${mockBaseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'edit',
        prompt: '把背景改成蓝色',
        size: '1024x1024',
        quality: 'high',
        sourceImage: { data: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/png', name: 'source.png' },
        provider: { baseUrl: 'https://provider.invalid', apiKey: 'server-secret' },
      }),
    })
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json()
    assert.equal(created.mode, 'edit')
    assert.equal(JSON.stringify(created).includes('server-secret'), false)

    const eventsResponse = await fetch(`${mockBaseUrl}/api/jobs/${created.id}/events`)
    const events = await eventsResponse.text()
    assert.match(events, /event: progress/)
    assert.match(events, /event: completed/)
    assert.equal(editCalls, 1)

    const detailResponse = await fetch(`${mockBaseUrl}/api/jobs/${created.id}`)
    const detail = await detailResponse.json()
    assert.equal(detail.status, 'completed')
    assert.equal(detail.results.length, 1)
    assert.equal(readFileSync(join(directory, detail.results[0].path), 'utf8'), 'fake-image')
  } finally {
    await new Promise((resolve, reject) => mockServer.close((error) => error ? reject(error) : resolve()))
    mockStore.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Mock Provider 完成异步生图、SSE 推送并将 base64 结果落盘', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-workspace-'))
  const dbPath = join(directory, 'jobs.db')
  const mockImage = async ({ prompt, size, quality, signal }) => {
    if (prompt === '取消测试') {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('任务已取消', 'AbortError')), { once: true })
      })
    }
    assert.equal(prompt, '测试提示词')
    assert.equal(size, '1024x1024')
    assert.equal(quality, 'high')
    assert.equal(signal.aborted, false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { kind: 'base64', value: 'ZmFrZS1pbWFnZQ==' }
  }
  const mockStore = new JobStore(dbPath)
  const mockServer = await startServer(0, '127.0.0.1', mockStore, {
    workspaceDir: directory,
    generateImage: mockImage,
  })
  const mockAddress = mockServer.address()
  const mockBaseUrl = `http://127.0.0.1:${mockAddress.port}`
  try {
    const createResponse = await fetch(`${mockBaseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'text_to_image',
        prompt: '测试提示词',
        layout: 'four_up',
        size: '1024x1024',
        quality: 'high',
        repeat: 2,
        provider: { baseUrl: 'https://provider.invalid', apiKey: 'server-secret' },
      }),
    })
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json()
    assert.equal(created.status, 'queued')
    assert.equal(created.repeat, 2)
    assert.equal(created.layout, 'four_up')
    assert.equal(JSON.stringify(created).includes('server-secret'), false)
    const db = new DatabaseSync(dbPath)
    const persisted = db.prepare('SELECT request_json FROM jobs WHERE id = ?').get(created.id)
    assert.equal(JSON.stringify(persisted).includes('server-secret'), false)
    db.close()

    const eventsResponse = await fetch(`${mockBaseUrl}/api/jobs/${created.id}/events`)
    const events = await eventsResponse.text()
    assert.match(events, /event: snapshot/)
    assert.match(events, /event: progress/)
    assert.match(events, /event: completed/)

    const detailResponse = await fetch(`${mockBaseUrl}/api/jobs/${created.id}`)
    const detail = await detailResponse.json()
    assert.equal(detail.status, 'completed')
    assert.equal(detail.results.length, 2)
    assert.equal(readFileSync(join(directory, detail.results[0].path), 'utf8'), 'fake-image')
    const resultResponse = await fetch(`${mockBaseUrl}/api/jobs/${created.id}/results/0`)
    assert.equal(resultResponse.status, 200)
    assert.equal(await resultResponse.text(), 'fake-image')

    const cancelResponse = await fetch(`${mockBaseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'text_to_image', prompt: '取消测试', provider: { baseUrl: 'https://provider.invalid', apiKey: 'server-secret' } }),
    })
    const cancelCreated = await cancelResponse.json()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const runningResponse = await fetch(`${mockBaseUrl}/api/jobs/${cancelCreated.id}`)
      if ((await runningResponse.json()).status === 'running') break
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const cancelledResponse = await fetch(`${mockBaseUrl}/api/jobs/${cancelCreated.id}/cancel`, { method: 'POST' })
    assert.equal((await cancelledResponse.json()).status, 'cancelled')
  } finally {
    await new Promise((resolve, reject) => mockServer.close((error) => error ? reject(error) : resolve()))
    mockStore.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
