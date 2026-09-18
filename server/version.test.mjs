import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { versionTargets } from '../scripts/version.mjs'

// Cargo.lock 里的 version 有多处，必须只改 lingtu-workbench 这个 package 块。
// 写错位置会让 Cargo 重新解析锁定版本，构建结果不可复现，所以单独验证读写。

const LOCK = `version = 4

[[package]]
name = "log"
version = "0.4.28"

[[package]]
name = "lingtu-workbench"
version = "1.0.4"
dependencies = [
 "log",
 "tauri",
]

[[package]]
name = "tauri"
version = "2.11.5"
`

function lockTarget() {
  const target = versionTargets.find((item) => item.path.endsWith('Cargo.lock'))
  assert.ok(target, 'version.mjs 必须包含 Cargo.lock')
  return target
}

test('Cargo.lock 只读取 lingtu-workbench 自己的版本', () => {
  assert.equal(lockTarget().read(LOCK), '1.0.4')
})

test('Cargo.lock 只改写 lingtu-workbench，其他依赖版本不受影响', () => {
  const next = lockTarget().write(LOCK, '1.0.6')
  assert.ok(next.includes('name = "lingtu-workbench"\nversion = "1.0.6"'))
  // 相邻与其他包的版本号必须原样保留。
  assert.ok(next.includes('name = "log"\nversion = "0.4.28"'))
  assert.ok(next.includes('name = "tauri"\nversion = "2.11.5"'))
  assert.equal((next.match(/version = "1\.0\.6"/g) ?? []).length, 1)
})

test('Cargo.lock 同步的是真实文件，且当前与清单版本一致', () => {
  const target = lockTarget()
  const path = join(import.meta.dirname, '..', 'src-tauri', 'Cargo.lock')
  const text = readFileSync(path, 'utf8')
  const manifest = readFileSync(join(import.meta.dirname, '..', 'src-tauri', 'Cargo.toml'), 'utf8')
  const manifestVersion = manifest.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)[1]
  // 这正是本次要修的问题：Cargo.lock 一度停在 1.0.4 而 Cargo.toml 已是 1.0.6。
  assert.equal(target.read(text), manifestVersion)
})

test('Cargo.lock 缺少目标 package 时明确报错，而不是静默跳过', () => {
  assert.throws(() => lockTarget().read('[[package]]\nname = "log"\nversion = "0.4.28"\n'), /lingtu-workbench/)
  assert.throws(() => lockTarget().write('[[package]]\nname = "log"\nversion = "0.4.28"\n', '1.0.6'), /lingtu-workbench/)
})

test('写入没有实际变化时返回原文，供 setVersion 判定是否需要落盘', () => {
  const target = lockTarget()
  assert.equal(target.write('[[package]]\nname = "lingtu-workbench"\nversion = "1.0.6"\n', '1.0.6'), '[[package]]\nname = "lingtu-workbench"\nversion = "1.0.6"\n')
})

// setVersion 会遍历所有 target 并写盘；用临时目录验证端到端，避免污染真实清单。
test('setVersion 能把 Cargo.lock 一起同步', async () => {
  const { setVersion, versionTargets: targets } = await import('../scripts/version.mjs')
  const directory = mkdtempSync(join(tmpdir(), 'lingtu-version-'))
  const lockPath = join(directory, 'Cargo.lock')
  writeFileSync(lockPath, LOCK)
  // 临时把 target 指向副本：确认写盘路径可用，且不会碰真实仓库文件。
  const original = lockTarget().path
  try {
    Object.assign(lockTarget(), { path: lockPath })
    assert.equal(setVersion('1.0.6', [lockTarget()]), '1.0.6')
    assert.ok(readFileSync(lockPath, 'utf8').includes('name = "lingtu-workbench"\nversion = "1.0.6"'))
  } finally {
    lockTarget().path = original
    assert.ok(targets.length >= 4)
    rmSync(directory, { recursive: true, force: true })
  }
})
