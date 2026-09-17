import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER = /^\d+\.\d+\.\d+$/

// 三处清单文件必须同步；任意一处漏改都会让检查更新静默失灵。
const targets = [
  {
    path: join(projectRoot, 'package.json'),
    read: (text) => { const version = JSON.parse(text).version; if (typeof version !== 'string') throw new Error('package.json 缺少 version'); return version },
    write: (text, version) => text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`),
  },
  {
    path: join(projectRoot, 'src-tauri', 'Cargo.toml'),
    read: (text) => { const match = text.match(/^\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m); if (!match) throw new Error('Cargo.toml 缺少 [package] version'); return match[1] },
    write: (text, version) => text.replace(/^(\[package\][\s\S]*?^version\s*=\s*)"[^"]*"/m, `$1"${version}"`),
  },
  {
    path: join(projectRoot, 'src-tauri', 'tauri.conf.json'),
    read: (text) => { const version = JSON.parse(text).version; if (typeof version !== 'string') throw new Error('tauri.conf.json 缺少 version'); return version },
    write: (text, version) => text.replace(/("version"\s*:\s*)"[^"]*"/, `$1"${version}"`),
  },
]

function readVersions() {
  return targets.map((target) => ({ path: target.path, version: target.read(readFileSync(target.path, 'utf8')) }))
}

function check() {
  const entries = readVersions()
  const versions = new Set(entries.map((entry) => entry.version))
  if (versions.size > 1) {
    // 直接把三处读到的值都列出来，省去人工翻文件。
    const detail = entries.map((entry) => `${entry.path.slice(projectRoot.length + 1)}=${entry.version}`).join('，')
    throw new Error(`应用版本号不一致：${detail}。请先运行 npm run version:set -- <版本号> 同步。`)
  }
  const [version] = versions
  if (!SEMVER.test(version)) throw new Error(`应用版本号必须是 x.y.z 形式，当前为 ${version}`)
  return version
}

function setVersion(version) {
  if (!SEMVER.test(version)) throw new Error(`应用版本号必须是 x.y.z 形式，收到 ${version}`)
  for (const target of targets) {
    const text = readFileSync(target.path, 'utf8')
    const relativePath = target.path.slice(projectRoot.length + 1)
    if (target.read(text) === version) continue
    const next = target.write(text, version)
    if (next === text) throw new Error(`未能改写 ${relativePath}，请检查 version 字段格式`)
    writeFileSync(target.path, next)
  }
  return version
}

const [, , command, argument] = process.argv
try {
  if (command === 'check') {
    console.log(check())
  } else if (command === 'set') {
    if (!argument) throw new Error('用法：node scripts/version.mjs set <版本号>')
    console.log(setVersion(argument))
  } else {
    throw new Error('用法：node scripts/version.mjs <check|set> [版本号]')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
