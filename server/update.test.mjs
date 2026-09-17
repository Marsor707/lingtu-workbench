import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { JobStore, createApp } from '../dist-server/index.js'
import { checkForUpdate, compareVersions, currentPlatform, downloadUpdateAsset, parseUpdateSource, resolveUpdate, safeAssetName } from '../dist-server/update.js'

const source = {
  version: '1.0.5',
  min_supported_version: '1.0.0',
  notes: '修复若干问题',
  platforms: {
    'darwin-arm64': { url: 'https://example.test/_1.0.5_aarch64.dmg', size: 43_709_859, name: '_1.0.5_aarch64.dmg' },
    'windows-x64': { url: 'https://example.test/_1.0.5_x64-setup.exe', size: 26_225_602, name: '_1.0.5_x64-setup.exe' },
  },
}

test('版本比较忽略 v 前缀', () => {
  assert.equal(compareVersions('1.0.4', 'v1.0.5'), -1)
  assert.equal(compareVersions('v1.0.5', '1.0.5'), 0)
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
  assert.throws(() => compareVersions('1.0', '1.0.5'), /无法比较的版本号/)
})

test('平台键只覆盖当前发布的两端', () => {
  assert.equal(currentPlatform('darwin', 'arm64'), 'darwin-arm64')
  assert.equal(currentPlatform('win32', 'x64'), 'windows-x64')
  assert.equal(currentPlatform('darwin', 'x64'), undefined)
  assert.equal(currentPlatform('linux', 'x64'), undefined)
})

test('更新源字段缺失时明确报错而不是静默判为已是最新', () => {
  assert.throws(() => parseUpdateSource({ version: 'abc', platforms: {} }), /合法 version/)
  assert.throws(() => parseUpdateSource({ version: '1.0.5' }), /缺少 platforms/)
  assert.throws(() => parseUpdateSource({ version: '1.0.5', platforms: { 'darwin-arm64': {} } }), /没有任何可用平台/)
  assert.throws(() => parseUpdateSource('nope'), /不是 JSON 对象/)
})

test('有更新时给出对应平台安装包', () => {
  const result = resolveUpdate(parseUpdateSource(source), '1.0.4', 'darwin-arm64')
  assert.equal(result.state, 'update')
  assert.equal(result.latestVersion, '1.0.5')
  assert.equal(result.notes, '修复若干问题')
  assert.equal(result.asset?.url, 'https://example.test/_1.0.5_aarch64.dmg')
  assert.equal(result.asset?.size, 43_709_859)
})

test('本地版本不低于更新源时不提示更新', () => {
  assert.equal(resolveUpdate(parseUpdateSource(source), '1.0.5', 'windows-x64').state, 'latest')
  assert.equal(resolveUpdate(parseUpdateSource(source), '1.0.6', 'windows-x64').state, 'latest')
  assert.equal(resolveUpdate(parseUpdateSource(source), '1.0.5', 'windows-x64').asset, null)
})

test('当前版本低于最低支持版本时要求手动重装', () => {
  const result = resolveUpdate(parseUpdateSource({ ...source, min_supported_version: '1.0.4' }), '1.0.3', 'darwin-arm64')
  assert.equal(result.state, 'manual')
  assert.equal(result.asset, null)
  assert.equal(result.minSupportedVersion, '1.0.4')
})

test('更新源没有当前平台条目时视为已是最新', () => {
  assert.equal(resolveUpdate(parseUpdateSource(source), '1.0.4', 'linux-x64').state, 'latest')
})

test('下载文件名剥离路径，阻止写到下载目录之外', () => {
  assert.equal(safeAssetName('../../evil.app', 'fallback.dmg'), 'evil.app')
  assert.equal(safeAssetName('/tmp/a b.dmg', 'fallback.dmg'), 'a b.dmg')
  assert.equal(safeAssetName('..', 'fallback.dmg'), 'fallback.dmg')
  assert.equal(safeAssetName('', 'fallback.dmg'), 'fallback.dmg')
})

test('检查更新走更新源 URL 并返回可更新结果', async () => {
  const seen = []
  const result = await checkForUpdate({
    currentVersion: '1.0.4',
    platform: 'darwin-arm64',
    sourceUrl: 'https://example.test/latest.json',
    fetch: async (url) => { seen.push(url); return { ok: true, status: 200, body: null, json: async () => source } },
  })
  assert.deepEqual(seen, ['https://example.test/latest.json'])
  assert.equal(result.state, 'update')
})

test('更新源不可达时抛错', async () => {
  await assert.rejects(
    checkForUpdate({ currentVersion: '1.0.4', platform: 'darwin-arm64', fetch: async () => ({ ok: false, status: 502, body: null, json: async () => ({}) }) }),
    /更新源请求失败（HTTP 502）/,
  )
})

test('下载更新包写入下载目录并回报进度', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-update-'))
  try {
    const payload = new TextEncoder().encode('lingtu-installer-payload')
    const progress = []
    const result = await downloadUpdateAsset({
      asset: { name: 'pkg.dmg', url: 'https://example.test/pkg.dmg', size: payload.byteLength },
      directory,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({}), body: (async function* () { yield payload.slice(0, 8); yield payload.slice(8) })() }),
      onProgress: (item) => progress.push(item.downloaded),
    })
    assert.equal(result.bytes, payload.byteLength)
    assert.equal(result.path, join(directory, 'pkg.dmg'))
    assert.equal(readFileSync(result.path, 'utf8'), 'lingtu-installer-payload')
    assert.deepEqual(progress, [8, payload.byteLength])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('下载字节数与更新源不符时删除临时文件并报错', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-update-size-'))
  try {
    await assert.rejects(
      downloadUpdateAsset({
        asset: { name: 'pkg.dmg', url: 'https://example.test/pkg.dmg', size: 1024 },
        directory,
        fetch: async () => ({ ok: true, status: 200, json: async () => ({}), body: (async function* () { yield new TextEncoder().encode('short') })() }),
      }),
      /更新包大小不符/,
    )
    // 失败不留半成品，避免用户双击安装一个损坏的包。
    assert.throws(() => readFileSync(join(directory, 'pkg.dmg'), 'utf8'))
    assert.throws(() => readFileSync(join(directory, 'pkg.dmg.part'), 'utf8'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('下载中途取消会清理临时文件', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-update-cancel-'))
  const controller = new AbortController()
  try {
    await assert.rejects(
      downloadUpdateAsset({
        asset: { name: 'pkg.dmg', url: 'https://example.test/pkg.dmg', size: 1024 },
        directory,
        signal: controller.signal,
        fetch: async () => ({ ok: true, status: 200, json: async () => ({}), body: (async function* () { yield new TextEncoder().encode('first'); controller.abort(); yield new TextEncoder().encode('second') })() }),
      }),
      /下载已取消/,
    )
    assert.throws(() => readFileSync(join(directory, 'pkg.dmg.part'), 'utf8'))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('失败不留半成品时也不会覆盖已下载的同名旧包', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-update-keep-'))
  try {
    writeFileSync(join(directory, 'pkg.dmg'), 'previous')
    await assert.rejects(
      downloadUpdateAsset({
        asset: { name: 'pkg.dmg', url: 'https://example.test/pkg.dmg', size: 1024 },
        directory,
        fetch: async () => ({ ok: true, status: 200, json: async () => ({}), body: (async function* () { yield new TextEncoder().encode('short') })() }),
      }),
      /更新包大小不符/,
    )
    assert.equal(readFileSync(join(directory, 'pkg.dmg'), 'utf8'), 'previous')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

// 以下测试走真实 HTTP：本地 stub 充当更新源，验证两个路由的完整链路。
test('更新路由：检查到新版本后可下载更新包', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lingtu-update-route-'))
  const downloads = join(workspace, 'downloads')
  mkdirSync(downloads, { recursive: true })
  const payload = new TextEncoder().encode('installer-binary')
  const stub = createServer((req, res) => {
    if (req.url === '/latest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ version: '9.9.9', notes: '测试版本', platforms: { 'darwin-arm64': { url: `http://127.0.0.1:${stub.address().port}/pkg.dmg`, size: payload.byteLength, name: 'pkg.dmg' } } }))
      return
    }
    if (req.url === '/pkg.dmg') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(payload.byteLength) })
      res.end(payload)
      return
    }
    res.writeHead(404); res.end()
  })
  await new Promise((resolveListen) => stub.listen(0, '127.0.0.1', () => resolveListen()))
  const store = new JobStore(join(workspace, 'lingtu.db'))
  // 显式注入平台：路由层测试不应依赖宿主机操作系统（CI 跑在 Linux 上而发布目标只有 macOS/Windows）。
  const app = createApp(store, { workspaceDir: join(workspace, 'workspace'), currentVersion: '1.0.4', updateSourceUrl: `http://127.0.0.1:${stub.address().port}/latest.json`, downloadDir: downloads, platform: 'darwin-arm64' })
  await new Promise((resolveListen) => app.listen(0, '127.0.0.1', () => resolveListen()))
  const baseUrl = `http://127.0.0.1:${app.address().port}`
  try {
    const checked = await (await fetch(`${baseUrl}/api/update/check`)).json()
    assert.equal(checked.state, 'update')
    assert.equal(checked.latestVersion, '9.9.9')
    assert.equal(checked.currentVersion, '1.0.4')
    assert.equal(checked.notes, '测试版本')

    const stream = await (await fetch(`${baseUrl}/api/update/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '9.9.9' }) })).text()
    assert.match(stream, /event: started/)
    assert.match(stream, /event: progress/)
    assert.match(stream, /event: completed/)
    assert.equal(readFileSync(join(downloads, 'pkg.dmg'), 'utf8'), 'installer-binary')
  } finally {
    await new Promise((resolveClose) => app.close(() => resolveClose()))
    await new Promise((resolveClose) => stub.close(() => resolveClose()))
    store.close?.()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('更新路由：服务端不接受与更新源不符的版本号', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'lingtu-update-version-'))
  const stub = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ version: '9.9.9', platforms: { 'darwin-arm64': { url: `http://127.0.0.1:${stub.address().port}/pkg.dmg`, size: 3 } } }))
  })
  await new Promise((resolveListen) => stub.listen(0, '127.0.0.1', () => resolveListen()))
  const store = new JobStore(join(workspace, 'lingtu.db'))
  // 同上：固定平台，避免在 Linux 上因平台不受支持而返回 502，掩盖真正的 409 校验。
  const app = createApp(store, { workspaceDir: join(workspace, 'workspace'), currentVersion: '1.0.4', updateSourceUrl: `http://127.0.0.1:${stub.address().port}/latest.json`, downloadDir: join(workspace, 'downloads'), platform: 'darwin-arm64' })
  await new Promise((resolveListen) => app.listen(0, '127.0.0.1', () => resolveListen()))
  try {
    const baseUrl = `http://127.0.0.1:${app.address().port}`
    const response = await fetch(`${baseUrl}/api/update/download`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: '1.2.3' }) })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'update_not_available')
  } finally {
    await new Promise((resolveClose) => app.close(() => resolveClose()))
    await new Promise((resolveClose) => stub.close(() => resolveClose()))
    store.close?.()
    rmSync(workspace, { recursive: true, force: true })
  }
})
