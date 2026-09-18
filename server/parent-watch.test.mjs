import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isProcessAlive } from '../dist-server/index.js'

// 这条自杀通道的唯一职责是：启动器被强杀（TerminateProcess，不给任何收尾时机）后，
// sidecar 必须尽快退出，否则会占用安装目录里的 lingtu-server.exe，让覆盖安装报
// "Error opening file for writing"。所以测试必须起真实进程，用 SIGKILL 模拟强杀，
// 不能在进程内调用 watchParentProcess——它要独占 stdin。

const serverEntry = fileURLToPath(new URL('../dist-server/index.js', import.meta.url))

function waitForExit(child, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时：子进程没有在预期时间内退出')), timeoutMs)
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
  })
}

/** 启动真实 sidecar；返回句柄与临时目录，调用方负责清理。 */
function startSidecar() {
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-sidecar-'))
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      LINGTU_PORT: '0',
      LINGTU_DB_PATH: join(directory, 'lingtu.db'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const ready = new Promise((resolve, reject) => {
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      if (buffer.includes('"ready":true')) resolve()
    })
    child.once('exit', () => reject(new Error(`sidecar 在就绪前退出：${buffer}`)))
  })
  return { child, directory, ready }
}

function cleanup({ child, directory }) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  rmSync(directory, { recursive: true, force: true })
}

test('当前进程与 PID 1 判定为存活', () => {
  assert.equal(isProcessAlive(process.pid), true)
  assert.equal(isProcessAlive(1), true)
})

test('已退出的进程判定为不存活', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid
  await waitForExit(child)
  // 进程可能已被系统回收（ESRCH）或被复用；两种结果都说明"不能判定为存活"。
  assert.equal(isProcessAlive(pid), false)
})

test('非法 PID 一律判定为不存活', () => {
  assert.equal(isProcessAlive(undefined), false)
  assert.equal(isProcessAlive(0), false)
  assert.equal(isProcessAlive(-1), false)
  assert.equal(isProcessAlive(1.5), false)
})

test('启动器被强杀后 sidecar 随 stdin EOF 退出', async () => {
  // 生产结构是三层：安装器强杀启动器 → 启动器死 → 它持有的 sidecar stdin 写端被内核关闭。
  // 所以必须让"启动器"作为中间进程真实持有管道，否则测不到这条路径。
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-parent-watch-'))
  const launcherScript = `
    import { spawn } from 'node:child_process'
    const sidecar = spawn(process.execPath, [${JSON.stringify(serverEntry)}], {
      env: { ...process.env, LINGTU_PORT: '0', LINGTU_DB_PATH: ${JSON.stringify(join(directory, 'lingtu.db'))}, LINGTU_PARENT_PID: String(process.pid) },
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    console.log('SIDECAR_PID=' + sidecar.pid)
    sidecar.stdout.on('data', (chunk) => process.stdout.write(chunk))
    setInterval(() => {}, 1000)
  `
  const launcher = spawn(process.execPath, ['--input-type=module', '-e', launcherScript], { stdio: ['pipe', 'pipe', 'pipe'] })
  let sidecarPid
  const ready = new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`启动器未在预期时间内就绪：${buffer}`)), 5000)
    launcher.stdout.on('data', (chunk) => {
      buffer += chunk
      const matched = buffer.match(/SIDECAR_PID=(\d+)/)
      if (matched) sidecarPid = Number(matched[1])
      if (sidecarPid && buffer.includes('"ready":true')) { clearTimeout(timer); resolve() }
    })
    launcher.once('exit', () => { clearTimeout(timer); reject(new Error(`启动器提前退出：${buffer}`)) })
  })

  try {
    await ready
    assert.equal(isProcessAlive(sidecarPid), true, 'sidecar 应已随启动器就绪')

    // TerminateProcess 等价路径：不给启动器任何收尾时机，stop_sidecar 不会执行。
    launcher.kill('SIGKILL')
    await waitForExit(launcher)

    const deadline = Date.now() + 5000
    while (Date.now() < deadline && isProcessAlive(sidecarPid)) await new Promise((resolve) => setTimeout(resolve, 50))
    // 这条断言就是 bug 的回归点：修复前 sidecar 会一直活着并锁住 lingtu-server.exe。
    assert.equal(isProcessAlive(sidecarPid), false, '启动器被强杀后 sidecar 必须自行退出')
  } finally {
    if (isProcessAlive(launcher.pid)) launcher.kill('SIGKILL')
    if (isProcessAlive(sidecarPid)) process.kill(sidecarPid, 'SIGKILL')
    rmSync(directory, { recursive: true, force: true })
  }
})

test('未注入 LINGTU_PARENT_PID 时独立运行的服务不会自杀', async () => {
  const sidecar = startSidecar()
  try {
    await sidecar.ready
    await new Promise((resolve) => setTimeout(resolve, 1500))
    assert.equal(sidecar.child.exitCode, null, '独立运行的服务不能被父进程监听误杀')
  } finally {
    cleanup(sidecar)
  }
})
