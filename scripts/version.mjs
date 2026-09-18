import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER = /^\d+\.\d+\.\d+$/

// 清单文件必须同步；任意一处漏改都会让检查更新静默失灵。
// Cargo.lock 也在这里：它的 `lingtu-workbench` 包版本会在 cargo 运行时被自动改写，
// 放任漂移会让同一次提交里的清单版本不一致，构建产物不可复现。
export const versionTargets = [
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
    write: (text, version) => text.replace(/^  "version": "[^"]*",/m, `  "version": "${version}",`),
  },
  {
    // Cargo.lock 里 version 出现多处（依赖自身也各有版本），必须锚定 lingtu-workbench 包块，
    // 否则会把依赖的版本号改掉，导致 Cargo 重新解析锁定版本。
    path: join(projectRoot, 'src-tauri', 'Cargo.lock'),
    read: (text) => {
      const match = text.match(/\[\[package\]\]\nname = "lingtu-workbench"\nversion = "([^"]+)"/)
      if (!match) throw new Error('Cargo.lock 缺少 lingtu-workbench 包块')
      return match[1]
    },
    write: (text, version) => {
      const pattern = /(\[\[package\]\]\nname = "lingtu-workbench"\nversion = ")[^"]*(")/
      if (!pattern.test(text)) throw new Error('Cargo.lock 缺少 lingtu-workbench 包块')
      return text.replace(pattern, `$1${version}$2`)
    },
  },
]

export function readVersions(targets = versionTargets) {
  return targets.map((target) => ({ path: target.path, version: target.read(readFileSync(target.path, 'utf8')) }))
}

export function check(targets = versionTargets) {
  const entries = readVersions(targets)
  const versions = new Set(entries.map((entry) => entry.version))
  if (versions.size > 1) {
    // 直接把各处读到的值都列出来，省去人工翻文件。
    const detail = entries.map((entry) => `${entry.path.slice(projectRoot.length + 1)}=${entry.version}`).join('，')
    throw new Error(`应用版本号不一致：${detail}。请先运行 npm run version:set -- <版本号> 同步。`)
  }
  const [version] = versions
  if (!SEMVER.test(version)) throw new Error(`应用版本号必须是 x.y.z 形式，当前为 ${version}`)
  return version
}

export function setVersion(version, targets = versionTargets) {
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
// 被测试 import 时不执行 CLI 分支。
if (import.meta.url === `file://${process.argv[1]}`) {
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
}
