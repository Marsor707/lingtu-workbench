import { readdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Tauri 用中文 productName 拼安装包名（灵图工作台_1.0.5_x64-setup.exe），
// 而 GitHub Release 上传资产时会剥掉文件名里的非 ASCII 字符，
// 结果是 `_1.0.5_x64-setup.exe`：中文没了、URL 不可预期、用户下载下来一脸懵。
// 所以在发布前把安装包改成纯 ASCII 名，让 GitHub 拿到什么就存什么。
// 只改发布用的文件名；安装后的快捷方式、安装目录仍取 productName，用户无感知。
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** bundle 目录固定，由 tauri build 生成；调用方只在测试里传别的根目录。 */
export const BUNDLE_ROOT = join(projectRoot, 'src-tauri', 'target')

const SUFFIXES = ['.exe', '.dmg']

/** 匹配 Tauri 产物名 `<productName>_<版本>_<架构><后缀>`，最后一个下划线之前就是 productName。 */
const INSTALLER = /^.+_(\d+\.\d+\.\d+)_([^_/]+)\.(exe|dmg)$/

/** 与发布资产、latest.json 里的文件名保持同一套规则。 */
export function installerName(version, arch, extension) {
  return `lingtu-workbench_${version}_${arch}.${extension}`
}

/** 递归收集 bundle 下的安装包；无法识别的名字直接报错，避免悄悄漏掉一个资产。 */
function collect(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...collect(path))
      continue
    }
    if (!SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) continue
    const match = entry.name.match(INSTALLER)
    if (!match) throw new Error(`无法从安装包名解析版本与架构：${path}`)
    found.push({ path, name: entry.name, version: match[1], arch: match[2], extension: match[3] })
  }
  return found
}

/** 把 bundle 下的安装包改成纯 ASCII 名，返回每个文件的改名前后状态。 */
export function renameInstallers(root = BUNDLE_ROOT) {
  const targets = collect(root)
  if (targets.length === 0) throw new Error(`没有在 ${root} 下找到 .exe/.dmg 安装包，请先执行 tauri build`)

  return targets.map((target) => {
    const name = installerName(target.version, target.arch, target.extension)
    const nextPath = join(dirname(target.path), name)
    if (nextPath !== target.path) renameSync(target.path, nextPath)
    return { from: target.name, to: name, bytes: statSync(nextPath).size }
  })
}

function main() {
  try {
    console.log(JSON.stringify(renameInstallers(), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

// 被测试 import 时不执行，只有直接 `node scripts/rename-installers.mjs` 才跑。
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
