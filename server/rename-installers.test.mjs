import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renameInstallers } from '../scripts/rename-installers.mjs'

/**
 * 复现 GitHub 对 Release 资产名的处理：剔除非 ASCII 字符。
 * 这也顺带解释了为什么最新版本之前资产名是 `_1.0.5_x64-setup.exe`。
 * 只用在测试里当模型，不参与构建。
 */
function stripNonAscii(name) {
  return name.replace(/[^\x20-\x7e]/g, '')
}

/** 造一个最小 bundle 目录树；不跑真实 tauri build，只验证改名逻辑。 */
function makeBundle(files) {
  const root = mkdtempSync(join(tmpdir(), 'lingtu-bundle-'))
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

test('安装包按 productName 解析出版本与架构并改成纯 ASCII 名', () => {
  const root = makeBundle({
    'x86_64-pc-windows-msvc/release/bundle/nsis/灵图工作台_1.0.5_x64-setup.exe': 'exe',
    'aarch64-apple-darwin/release/bundle/dmg/灵图工作台_1.0.5_aarch64.dmg': 'dmg',
  })
  try {
    const results = renameInstallers(root)
    assert.deepEqual(results.map((item) => item.to).sort(), ['lingtu-workbench_1.0.5_aarch64.dmg', 'lingtu-workbench_1.0.5_x64-setup.exe'])
    const leftovers = readdirSync(join(root, 'x86_64-pc-windows-msvc/release/bundle/nsis'))
    assert.deepEqual(leftovers, ['lingtu-workbench_1.0.5_x64-setup.exe'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('已经是 ASCII 名的安装包保持原名', () => {
  const root = makeBundle({ 'bundle/dmg/lingtu-workbench_1.0.5_aarch64.dmg': 'dmg' })
  try {
    const [result] = renameInstallers(root)
    assert.equal(result.from, result.to)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('无法解析的安装包名直接报错，不静默漏掉一个资产', () => {
  const root = makeBundle({ 'bundle/dmg/weird-name.dmg': 'dmg' })
  try {
    assert.throws(() => renameInstallers(root), /无法从安装包名解析版本与架构/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('没有任何安装包时明确失败，避免 CI 误判成功', () => {
  const root = makeBundle({ 'bundle/dmg/notes.txt': 'x' })
  try {
    assert.throws(() => renameInstallers(root), /没有在 .* 下找到/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 回归：Windows 构建在 target 下留下 build-script-build.exe 等中间产物，
// 它们不是安装包，不能被当成「无法解析的资产」而中断发布。
test('bundle 目录之外的 exe 中间产物被忽略', () => {
  const root = makeBundle({
    'release/build/anyhow-6b31ff0b050b0730/build-script-build.exe': 'build-script',
    'x86_64-pc-windows-msvc/release/bundle/nsis/灵图工作台_1.0.6_x64-setup.exe': 'exe',
  })
  try {
    const results = renameInstallers(root)
    assert.deepEqual(results.map((item) => item.to), ['lingtu-workbench_1.0.6_x64-setup.exe'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 这是本脚本存在的唯一理由：GitHub 上传 Release 资产时会剥掉非 ASCII 字符。
// 用真实案例钉住结论，将来换文件名规则时能立刻发现。
test('纯 ASCII 名经 GitHub 剥名后不变', () => {
  assert.equal(stripNonAscii('灵图工作台_1.0.5_x64-setup.exe'), '_1.0.5_x64-setup.exe')
  assert.equal(stripNonAscii('lingtu-workbench_1.0.5_x64-setup.exe'), 'lingtu-workbench_1.0.5_x64-setup.exe')
})
