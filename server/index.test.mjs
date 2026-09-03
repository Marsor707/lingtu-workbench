import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createServer as createHttpServer } from 'node:http'
import { buildEffectivePrompt, JobStore, startServer } from '../dist-server/index.js'

const server = await startServer(0)
const address = server.address()
const baseUrl = `http://127.0.0.1:${address.port}`
const environmentKeys = ['LINGTU_PROVIDER_BASE_URL', 'LINGTU_API_KEY']
const ambientEnvironment = Object.fromEntries(environmentKeys.map((name) => [name, process.env[name]]))
for (const name of environmentKeys) delete process.env[name]

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  for (const name of environmentKeys) {
    if (ambientEnvironment[name] === undefined) delete process.env[name]
    else process.env[name] = ambientEnvironment[name]
  }
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

test('提示词接口返回安装时初始化的 79 条内置数据', async () => {
  const { response, body } = await request('/api/prompts')
  assert.equal(response.status, 200)
  assert.equal(body.total, 79)
  assert.equal(body.items.length, 79)
  assert.equal(body.items[0].id, 'reference-v239-two_up-000')
  assert.equal(body.items[0].builtin, true)
  assert.ok(body.items.every((item) => item.text.length > 0))
  assert.ok(body.items.every((item) => !/Output rules:|Output contract:|LT_4K_|Final (?:4K|4K square) structure check:|\b(?:two-up|four-panel|fifteen-panel)\b|\b(?:1129x1254|1129x627|3840x2160|1890x1050|3840x3840|1206x670)\b/i.test(item.text)))
})

test('已有数据库只迁移含旧输出契约的内置提示词', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-prompt-migration-'))
  const dbPath = join(directory, 'jobs.db')
  const initial = new JobStore(dbPath)
  initial.close()
  const legacyDb = new DatabaseSync(dbPath)
  legacyDb.prepare('UPDATE prompts SET text = ? WHERE id = ?').run('旧模板\nOutput rules:\n- Return one vertical two-up raw image requested as 1129x1254.', 'reference-v239-two_up-000')
  legacyDb.close()
  const migrated = new JobStore(dbPath)
  try {
    const prompt = migrated.prompts().find((item) => item.id === 'reference-v239-two_up-000')
    assert.ok(prompt)
    assert.doesNotMatch(prompt.text, /Output rules:|1129x1254/)
  } finally {
    migrated.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('高级参数追加段覆盖模板输出布局并保留目标长宽比', () => {
  const result = buildEffectivePrompt('保持原有主题和风格。', '四宫格', '1024 × 1024', '1K')
  assert.match(result, /灵图高级输出参数（最高优先级）/)
  assert.match(result, /四个彼此独立的成品区域，固定为 2 列 × 2 行排列/)
  assert.match(result, /目标画布长宽比：1:1/)
  assert.match(result, /目标分辨率等级：1K/)
  assert.match(result, /Provider 可选择其支持的实际分辨率/)

  const nine = buildEffectivePrompt('测试', '九宫格', '1536x1024', '2K')
  assert.match(nine, /九个彼此独立的成品区域，固定为 3 列 × 3 行排列/)
  assert.match(nine, /目标画布长宽比：3:2/)
  assert.match(nine, /目标分辨率等级：2K/)

  const two = buildEffectivePrompt('测试', '二宫格', '未知尺寸', '4K')
  assert.match(two, /两个彼此独立的成品区域，固定为上下两行排列/)
  assert.doesNotMatch(two, /目标画布长宽比：/)
  assert.match(two, /目标分辨率等级：4K/)

  const single = buildEffectivePrompt('测试', 'single', '1024x1024', '1K')
  assert.match(single, /输出布局：单图；一个完整的独立成品区域，不拆分为宫格/)
})

test('旧版单 Provider 配置首次启动自动迁移为默认启用供应商', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-provider-migration-'))
  const dbPath = join(directory, 'jobs.db')
  const legacyDb = new DatabaseSync(dbPath)
  legacyDb.exec('CREATE TABLE provider_config (id INTEGER PRIMARY KEY CHECK (id = 1), base_url TEXT NOT NULL, api_key TEXT NOT NULL, updated_at TEXT NOT NULL)')
  legacyDb.prepare('INSERT INTO provider_config (id, base_url, api_key, updated_at) VALUES (1, ?, ?, ?)').run('https://legacy.example/v1', 'legacy-secret', '2026-09-01T00:00:00.000Z')
  legacyDb.close()
  const store = new JobStore(dbPath)
  try {
    const providers = store.listProviders()
    assert.equal(providers.length, 1)
    assert.deepEqual(providers[0], {
      id: 'legacy-default', name: '默认供应商', baseUrl: 'https://legacy.example/v1', configured: true, enabled: true, successCount: 0, failureCount: 0,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: providers[0].updatedAt,
    })
    assert.equal(JSON.stringify(providers).includes('legacy-secret'), false)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Provider 配置写入 SQLite，重启后任务创建可复用且不回传密钥', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-provider-config-'))
  const dbPath = join(directory, 'jobs.db')
  const configStore = new JobStore(dbPath)
  const configServer = await startServer(0, '127.0.0.1', configStore)
  const configAddress = configServer.address()
  const configBaseUrl = `http://127.0.0.1:${configAddress.port}`
  try {
    const saveResponse = await fetch(`${configBaseUrl}/api/provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://provider.example/v1', apiKey: 'local-secret' }),
    })
    assert.equal(saveResponse.status, 200)
    assert.deepEqual(await saveResponse.json(), { baseUrl: 'https://provider.example/v1', configured: true })
    const readResponse = await fetch(`${configBaseUrl}/api/provider`)
    assert.equal(readResponse.status, 200)
    assert.deepEqual(await readResponse.json(), { baseUrl: 'https://provider.example/v1', configured: true })
  } finally {
    await new Promise((resolve, reject) => configServer.close((error) => error ? reject(error) : resolve()))
    configStore.close()
  }

  const restoredStore = new JobStore(dbPath)
  try {
    const created = restoredStore.create({ mode: 'generate', prompt: '测试提示词', provider: { baseUrl: 'https://provider.example/v1' } }).job
    assert.equal(restoredStore.provider(created.id)?.apiKey, 'local-secret')
  } finally {
    restoredStore.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('后端 Provider 环境变量覆盖请求体和 SQLite 配置', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-provider-env-'))
  const dbPath = join(directory, 'jobs.db')
  const previous = Object.fromEntries(environmentKeys.map((name) => [name, process.env[name]]))
  process.env.LINGTU_PROVIDER_BASE_URL = 'https://env-provider.example'
  process.env.LINGTU_API_KEY = 'env-secret'
  let receivedProvider
  const store = new JobStore(dbPath)
  store.saveProviderConfig({ baseUrl: 'https://sqlite-provider.example', apiKey: 'sqlite-secret' })
  const mockServer = await startServer(0, '127.0.0.1', store, {
    workspaceDir: directory,
    generateImage: async ({ baseUrl: requestBaseUrl, apiKey }) => {
      receivedProvider = { baseUrl: requestBaseUrl, apiKey }
      return { kind: 'base64', value: 'ZmFrZS1pbWFnZQ==' }
    },
  })
  const mockAddress = mockServer.address()
  const mockBaseUrl = `http://127.0.0.1:${mockAddress.port}`
  try {
    const metadataResponse = await fetch(`${mockBaseUrl}/api/provider`)
    assert.deepEqual(await metadataResponse.json(), { baseUrl: 'https://env-provider.example', configured: true })
    const createResponse = await fetch(`${mockBaseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'generate', prompt: '环境变量测试', provider: { baseUrl: 'https://request-provider.example', apiKey: 'request-secret' } }),
    })
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json()
    await fetch(`${mockBaseUrl}/api/jobs/${created.id}/events`)
    assert.deepEqual(receivedProvider, { baseUrl: 'https://env-provider.example', apiKey: 'env-secret' })
    const saveResponse = await fetch(`${mockBaseUrl}/api/provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://request-provider.example', apiKey: 'request-secret' }),
    })
    assert.deepEqual(await saveResponse.json(), { baseUrl: 'https://env-provider.example', configured: true })
    assert.equal(store.getProviderConfig()?.baseUrl, 'https://sqlite-provider.example')
  } finally {
    await new Promise((resolve, reject) => mockServer.close((error) => error ? reject(error) : resolve()))
    store.close()
    rmSync(directory, { recursive: true, force: true })
    for (const name of environmentKeys) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
  }
})

test('模型供应商支持新增、编辑、唯一启用和受约束删除，且接口不回传密钥', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-model-providers-'))
  const store = new JobStore(join(directory, 'jobs.db'))
  const server = await startServer(0, '127.0.0.1', store, { workspaceDir: directory })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const create = async (name, baseUrl, apiKey) => {
      const response = await fetch(`${base}/api/providers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, baseUrl, apiKey }),
      })
      assert.equal(response.status, 201)
      return response.json()
    }
    const first = await create('主力模型', 'https://primary.example/v1', 'primary-secret')
    const second = await create('备用模型', 'https://backup.example/v1', 'backup-secret')
    assert.equal(first.enabled, true)
    assert.equal(second.enabled, false)
    assert.equal(JSON.stringify(first).includes('primary-secret'), false)

    const editResponse = await fetch(`${base}/api/providers/${second.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '备用模型 2', baseUrl: 'https://backup-2.example/v1', apiKey: '' }),
    })
    assert.equal(editResponse.status, 200)
    assert.equal(store.getProvider(second.id)?.apiKey, 'backup-secret')

    const enableResponse = await fetch(`${base}/api/providers/${second.id}/enable`, { method: 'POST' })
    assert.equal(enableResponse.status, 200)
    const providers = (await (await fetch(`${base}/api/providers`)).json()).items
    assert.equal(providers.filter((provider) => provider.enabled).length, 1)
    assert.equal(providers.find((provider) => provider.id === second.id).enabled, true)
    assert.equal(JSON.stringify(providers).includes('backup-secret'), false)

    const activeDelete = await fetch(`${base}/api/providers/${second.id}`, { method: 'DELETE' })
    assert.equal(activeDelete.status, 409)
    assert.equal((await activeDelete.json()).error.code, 'provider_enabled')
    const inactiveDelete = await fetch(`${base}/api/providers/${first.id}`, { method: 'DELETE' })
    assert.equal(inactiveDelete.status, 204)
    const lastDelete = await fetch(`${base}/api/providers/${second.id}`, { method: 'DELETE' })
    assert.equal(lastDelete.status, 409)
    assert.equal((await lastDelete.json()).error.code, 'provider_last_one')
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('运行任务锁定供应商切换，任务终态按创建时绑定的供应商统计', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-provider-lock-'))
  const store = new JobStore(join(directory, 'jobs.db'))
  let releaseFirst
  let requestCount = 0
  const server = await startServer(0, '127.0.0.1', store, {
    workspaceDir: directory,
    generateImage: async () => {
      requestCount += 1
      if (requestCount === 1) await new Promise((resolve) => { releaseFirst = resolve })
      else throw new Error('mock provider failure')
      return { kind: 'base64', value: 'ZmFrZS1pbWFnZQ==' }
    },
  })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const createProvider = async (name) => {
      const response = await fetch(`${base}/api/providers`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, baseUrl: `https://${name}.example/v1`, apiKey: `${name}-secret` }),
      })
      return response.json()
    }
    const first = await createProvider('first')
    const second = await createProvider('second')
    const firstJobResponse = await fetch(`${base}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'generate', prompt: '统计成功' }),
    })
    const firstJob = await firstJobResponse.json()
    assert.equal(firstJob.providerId, first.id)
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await (await fetch(`${base}/api/jobs/${firstJob.id}`)).json()).status === 'running') break
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const locked = await fetch(`${base}/api/providers/${second.id}/enable`, { method: 'POST' })
    assert.equal(locked.status, 409)
    assert.equal((await locked.json()).error.code, 'provider_switch_locked')
    releaseFirst()
    assert.match(await (await fetch(`${base}/api/jobs/${firstJob.id}/events`)).text(), /event: completed/)

    assert.equal((await fetch(`${base}/api/providers/${second.id}/enable`, { method: 'POST' })).status, 200)
    const failedJobResponse = await fetch(`${base}/api/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'generate', prompt: '统计失败' }),
    })
    const failedJob = await failedJobResponse.json()
    assert.equal(failedJob.providerId, second.id)
    assert.match(await (await fetch(`${base}/api/jobs/${failedJob.id}/events`)).text(), /event: failed/)

    const providers = (await (await fetch(`${base}/api/providers`)).json()).items
    assert.deepEqual(
      providers.map((provider) => ({ id: provider.id, success: provider.successCount, failure: provider.failureCount })),
      [
        { id: first.id, success: 1, failure: 0 },
        { id: second.id, success: 0, failure: 1 },
      ],
    )
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('统计接口读取任务状态和工作区实际结果文件大小', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-stats-workspace-'))
  const statsStore = new JobStore(join(directory, 'jobs.db'))
  const statsServer = await startServer(0, '127.0.0.1', statsStore, { workspaceDir: directory })
  const statsAddress = statsServer.address()
  const statsBaseUrl = `http://127.0.0.1:${statsAddress.port}`
  try {
    const emptyResponse = await fetch(`${statsBaseUrl}/api/stats`)
    assert.equal(emptyResponse.status, 200)
    assert.deepEqual(await emptyResponse.json(), { completed: 0, running: 0, review: 0, failed: 0, total: 0, storageBytes: 0 })

    const completed = statsStore.create({ mode: 'generate' }).job
    const running = statsStore.create({ mode: 'generate' }).job
    const review = statsStore.create({ mode: 'generate' }).job
    const failed = statsStore.create({ mode: 'generate' }).job
    const resultPath = join('jobs', completed.id, '001.png')
    mkdirSync(join(directory, 'jobs', completed.id), { recursive: true })
    writeFileSync(join(directory, resultPath), Buffer.alloc(7))
    statsStore.update(completed.id, 'completed', { results: [{ path: resultPath, index: 0 }] })
    statsStore.update(running.id, 'running')
    statsStore.update(review.id, 'review')
    statsStore.update(failed.id, 'failed')

    const response = await fetch(`${statsBaseUrl}/api/stats`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { completed: 1, running: 1, review: 1, failed: 1, total: 4, storageBytes: 7 })
  } finally {
    await new Promise((resolve, reject) => statsServer.close((error) => error ? reject(error) : resolve()))
    statsStore.close()
    rmSync(directory, { recursive: true, force: true })
  }
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

test('失败或取消任务可沿用原 ID 重试并重新完成', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-retry-workspace-'))
  const store = new JobStore(join(directory, 'jobs.db'))
  const previousEnvironment = Object.fromEntries(environmentKeys.map((name) => [name, process.env[name]]))
  let failAttempts = 0
  let cancelAttempts = 0
  const seenProviders = []
  const mockGenerate = async ({ prompt, signal, baseUrl, apiKey }) => {
    seenProviders.push({ baseUrl, apiKey })
    if (prompt.startsWith('首次失败') && failAttempts === 0) {
      failAttempts += 1
      throw new Error('mock provider failure')
    }
    if (prompt.startsWith('取消后重试') && cancelAttempts === 0) {
      cancelAttempts += 1
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('任务已取消', 'AbortError')), { once: true })
      })
    }
    return { kind: 'base64', value: 'ZmFrZS1pbWFnZQ==' }
  }
  const server = await startServer(0, '127.0.0.1', store, { workspaceDir: directory, generateImage: mockGenerate, editImage: mockGenerate })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const providerResponse = await fetch(`${base}/api/providers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'provider-a', baseUrl: 'https://provider-a.example/v1', apiKey: 'provider-a-secret' }) })
    const providerA = await providerResponse.json()
    const backupProviderResponse = await fetch(`${base}/api/providers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'provider-b', baseUrl: 'https://provider-b.example/v1', apiKey: 'provider-b-secret' }) })
    const providerB = await backupProviderResponse.json()
    await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pixelUpscale4K: false }) })
    const create = async (prompt) => {
      const response = await fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'edit', prompt, layout: 'four_up', size: '1024x1024', resolution: '1K', quality: 'high', sourceImage: { data: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/png', name: 'source.png' } }) })
      assert.equal(response.status, 201)
      return response.json()
    }

    const failedJob = await create('首次失败')
    assert.match(await (await fetch(`${base}/api/jobs/${failedJob.id}/events`)).text(), /event: failed/)
    assert.equal((await (await fetch(`${base}/api/jobs/${failedJob.id}`)).json()).status, 'failed')
    const originalRequest = store.request(failedJob.id)
    await new Promise((resolve) => setTimeout(resolve, 2))
    assert.equal((await fetch(`${base}/api/providers/${providerB.id}/enable`, { method: 'POST' })).status, 200)
    await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pixelUpscale4K: true }) })

    const retryResponse = await fetch(`${base}/api/jobs/${failedJob.id}/retry`, { method: 'POST' })
    const retryJob = await retryResponse.json()
    assert.equal(retryResponse.status, 200)
    assert.equal(retryJob.id, failedJob.id)
    assert.equal(retryJob.status, 'queued')
    assert.equal(retryJob.error, undefined)
    assert.notEqual(retryJob.createdAt, failedJob.createdAt)
    const retriedRequest = store.request(failedJob.id)
    assert.equal(retriedRequest?.providerId, providerB.id)
    assert.equal(retriedRequest?.provider.baseUrl, 'https://provider-b.example/v1')
    assert.equal(retriedRequest?.pixelUpscale4K, true)
    assert.deepEqual(seenProviders.slice(0, 2), [{ baseUrl: 'https://provider-a.example/v1', apiKey: 'provider-a-secret' }, { baseUrl: 'https://provider-b.example/v1', apiKey: 'provider-b-secret' }])
    assert.deepEqual({ prompt: retriedRequest?.prompt, layout: retriedRequest?.layout, size: retriedRequest?.size, resolution: retriedRequest?.resolution, quality: retriedRequest?.quality, sourceImage: retriedRequest?.sourceImage }, { prompt: originalRequest?.prompt, layout: originalRequest?.layout, size: originalRequest?.size, resolution: originalRequest?.resolution, quality: originalRequest?.quality, sourceImage: originalRequest?.sourceImage })
    assert.match(await (await fetch(`${base}/api/jobs/${failedJob.id}/events`)).text(), /event: completed/)
    assert.equal((await (await fetch(`${base}/api/jobs/${failedJob.id}`)).json()).status, 'completed')

    const cancelledJob = await create('取消后重试')
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if ((await (await fetch(`${base}/api/jobs/${cancelledJob.id}`)).json()).status === 'running') break
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    assert.equal((await (await fetch(`${base}/api/jobs/${cancelledJob.id}`)).json()).status, 'running')
    const cancelResponse = await fetch(`${base}/api/jobs/${cancelledJob.id}/cancel`, { method: 'POST' })
    assert.equal((await cancelResponse.json()).status, 'cancelled')
    process.env.LINGTU_PROVIDER_BASE_URL = 'https://env-retry.example/v1'
    process.env.LINGTU_API_KEY = 'env-retry-secret'
    const cancelledRetryResponse = await fetch(`${base}/api/jobs/${cancelledJob.id}/retry`, { method: 'POST' })
    const cancelledRetry = await cancelledRetryResponse.json()
    assert.equal(cancelledRetryResponse.status, 200)
    assert.equal(cancelledRetry.id, cancelledJob.id)
    assert.deepEqual(seenProviders.at(-1), { baseUrl: 'https://env-retry.example/v1', apiKey: 'env-retry-secret' })
    assert.match(await (await fetch(`${base}/api/jobs/${cancelledJob.id}/events`)).text(), /event: completed/)
  } finally {
    for (const name of environmentKeys) {
      if (previousEnvironment[name] === undefined) delete process.env[name]
      else process.env[name] = previousEnvironment[name]
    }
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
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
    assert.match(prompt, /^把背景改成蓝色\n\n\[灵图高级输出参数（最高优先级）\]/)
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

test('任务队列按 maxConcurrency 限制 Provider 并发', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-concurrency-'))
  const store = new JobStore(join(directory, 'jobs.db'))
  let active = 0
  let maxActive = 0
  const server = await startServer(0, '127.0.0.1', store, {
    workspaceDir: directory,
    generateImage: async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 35))
      active -= 1
      return { kind: 'base64', value: 'ZmFrZS1pbWFnZQ==' }
    },
  })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const settingsResponse = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConcurrency: 2 }),
    })
    assert.equal(settingsResponse.status, 200)
    assert.deepEqual(await settingsResponse.json(), { maxConcurrency: 2, pixelUpscale4K: false })
    assert.deepEqual(await (await fetch(`${base}/api/settings`)).json(), { maxConcurrency: 2, pixelUpscale4K: false })

    const upscaleResponse = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pixelUpscale4K: true }),
    })
    assert.deepEqual(await upscaleResponse.json(), { maxConcurrency: 2, pixelUpscale4K: true })
    assert.equal(store.getPixelUpscale4K(), true)
    const snapshotted = store.create({ mode: 'generate', prompt: '快照测试' }).job
    assert.equal(snapshotted.pixelUpscale4K, true)
    assert.equal(store.request(snapshotted.id)?.pixelUpscale4K, true)

    const created = await Promise.all(Array.from({ length: 3 }, async (_, index) => {
      const response = await fetch(`${base}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode: 'generate', prompt: `并发测试 ${index}` }),
      })
      assert.equal(response.status, 201)
      return response.json()
    }))
    await Promise.all(created.map(async (job) => {
      const events = await fetch(`${base}/api/jobs/${job.id}/events`)
      assert.match(await events.text(), /event: completed/)
    }))
    assert.equal(maxActive, 2)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Mock Provider 完成异步生图、SSE 推送并将 base64 结果落盘', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-workspace-'))
  const dbPath = join(directory, 'jobs.db')
  const mockImage = async ({ prompt, size, quality, signal }) => {
    if (prompt.startsWith('取消测试')) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('任务已取消', 'AbortError')), { once: true })
      })
    }
    assert.match(prompt, /^测试提示词\n\n\[灵图高级输出参数（最高优先级）\]/)
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
        resolution: '1K',
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
    assert.equal(created.resolution, '1K')
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
    assert.deepEqual(detail.results.map((result) => result.path), [`jobs/${created.id}-001.png`, `jobs/${created.id}-002.png`])
    assert.deepEqual(readdirSync(join(directory, 'jobs')).sort(), [`${created.id}-001.png`, `${created.id}-002.png`])
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

test('Mock Provider 返回图片 URL 时由后端下载并落盘', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-url-workspace-'))
  const resultServer = createHttpServer((req, res) => {
    if (req.url === '/result.png') {
      res.setHeader('content-type', 'image/png')
      res.end(Buffer.from('url-image'))
      return
    }
    res.statusCode = 404
    res.end()
  })
  await new Promise((resolve) => resultServer.listen(0, '127.0.0.1', resolve))
  const resultPort = resultServer.address().port
  const store = new JobStore(join(directory, 'jobs.db'))
  const app = await startServer(0, '127.0.0.1', store, {
    workspaceDir: directory,
    generateImage: async () => ({ kind: 'url', value: `http://127.0.0.1:${resultPort}/result.png` }),
  })
  const appBaseUrl = `http://127.0.0.1:${app.address().port}`
  try {
    const createResponse = await fetch(`${appBaseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'generate', prompt: 'URL 结果测试' }),
    })
    assert.equal(createResponse.status, 201)
    const created = await createResponse.json()
    const events = await (await fetch(`${appBaseUrl}/api/jobs/${created.id}/events`)).text()
    assert.match(events, /event: completed/)
    const detail = await (await fetch(`${appBaseUrl}/api/jobs/${created.id}`)).json()
    assert.equal(detail.status, 'completed')
    assert.equal(readFileSync(join(directory, detail.results[0].path), 'utf8'), 'url-image')
    const executionLog = readFileSync(join(directory, 'logs', 'execution.log'), 'utf8')
    assert.match(executionLog, /"timestamp":"[^\"]+\+08:00"/)
    assert.match(executionLog, new RegExp(`"event":"job_started".*"jobId":"${created.id}"`))
    assert.match(executionLog, /"event":"provider_response_received".*"resultKind":"url"/)
    assert.match(executionLog, new RegExp(`"event":"provider_response_received".*"resultUrl":"http://127\\.0\\.0\\.1:${resultPort}/result\\.png"`))
    assert.match(executionLog, /"event":"provider_result_materialized".*"bytes":9/)
    assert.match(executionLog, /"event":"job_completed"/)
    assert.equal(executionLog.includes('URL 结果测试'), false)
  } finally {
    await new Promise((resolve, reject) => app.close((error) => error ? reject(error) : resolve()))
    await new Promise((resolve, reject) => resultServer.close((error) => error ? reject(error) : resolve()))
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
