import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { networkInit } from './network.js'

// 更新源是随 Release 一起发布的 latest.json；客户端只依赖它的字段契约，
// 不依赖 GitHub API 结构，也不依赖 Tauri 对安装包文件名的生成规则。
export const DEFAULT_UPDATE_SOURCE_URL = 'https://github.com/Marsor707/lingtu-workbench/releases/latest/download/latest.json'

export type UpdateAsset = { name: string; url: string; size?: number }
export type UpdatePlatform = { url: string; size?: number; name?: string }
export type UpdateSource = { version: string; min_supported_version?: string; notes?: string; pub_date?: string; platforms: Record<string, UpdatePlatform> }

// 检查结果只有三种终态：已是最新、可更新、当前版本过旧必须手动重装。
export type UpdateState = 'latest' | 'update' | 'manual'

export type UpdateCheckResult = {
  currentVersion: string
  latestVersion: string
  minSupportedVersion: string
  notes: string
  state: UpdateState
  platform: string
  asset: UpdateAsset | null
}

export class UpdateSourceError extends Error { constructor(message: string, public readonly code = 'update_source_invalid') { super(message) } }

function parseVersion(value: string): number[] | undefined {
  const match = String(value ?? '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** 比较 x.y.z 版本号；忽略前缀 v。a 小于 b 返回负数。非法版本抛错，避免静默判成"已是最新"。 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a); const right = parseVersion(b)
  if (!left || !right) throw new UpdateSourceError(`无法比较的版本号：${!left ? a : b}`, 'update_version_invalid')
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/** 当前运行平台在更新源里的键，与 latest.json 的 platforms 字段对应。 */
export function currentPlatform(platform = process.platform, arch = process.arch): string | undefined {
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64'
  if (platform === 'win32' && arch === 'x64') return 'windows-x64'
  return undefined
}

/** 更新源字段校验：缺字段或结构不对时明确报错，不让检查更新退化成"没有新版本"。 */
export function parseUpdateSource(raw: unknown): UpdateSource {
  const item = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined
  if (!item) throw new UpdateSourceError('更新源内容不是 JSON 对象')
  if (!parseVersion(String(item.version ?? ''))) throw new UpdateSourceError(`更新源缺少合法 version：${String(item.version)}`, 'update_version_invalid')
  const platformsRaw = item.platforms && typeof item.platforms === 'object' && !Array.isArray(item.platforms) ? item.platforms as Record<string, unknown> : undefined
  if (!platformsRaw) throw new UpdateSourceError('更新源缺少 platforms 字段')
  const platforms: Record<string, UpdatePlatform> = {}
  for (const [key, value] of Object.entries(platformsRaw)) {
    const entry = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
    const url = typeof entry?.url === 'string' ? entry.url.trim() : ''
    if (!url) continue
    platforms[key] = {
      url,
      ...(typeof entry?.size === 'number' && Number.isFinite(entry.size) ? { size: entry.size } : {}),
      ...(typeof entry?.name === 'string' && entry.name.trim() ? { name: entry.name.trim() } : {}),
    }
  }
  if (Object.keys(platforms).length === 0) throw new UpdateSourceError('更新源没有任何可用平台')
  return {
    version: String(item.version).trim().replace(/^v/, ''),
    ...(typeof item.min_supported_version === 'string' ? { min_supported_version: item.min_supported_version.trim() } : {}),
    ...(typeof item.notes === 'string' ? { notes: item.notes } : {}),
    ...(typeof item.pub_date === 'string' ? { pub_date: item.pub_date } : {}),
    platforms,
  }
}

/** 下载文件名只取纯文件名，杜绝更新源用 ../../ 之类路径写到下载目录之外。 */
export function safeAssetName(value: string, fallback: string): string {
  const name = basename(String(value ?? '').trim())
  if (!name || name === '.' || name === '..' || name.includes('\0')) return fallback
  return name
}

/** 由更新源得出检查结果；这是"能否更新"的唯一判定入口。 */
export function resolveUpdate(source: UpdateSource, currentVersion: string, platform: string): UpdateCheckResult {
  const minSupportedVersion = parseVersion(source.min_supported_version ?? '') ? source.min_supported_version!.replace(/^v/, '') : '0.0.0'
  const base = { currentVersion, latestVersion: source.version, minSupportedVersion, notes: (source.notes ?? '').trim(), platform }
  // 低于最低支持版本时不再引导自助更新，只能手动重装。
  if (compareVersions(currentVersion, minSupportedVersion) < 0) return { ...base, state: 'manual', asset: null }
  const entry = source.platforms[platform]
  if (!entry) return { ...base, state: 'latest', asset: null }
  const asset: UpdateAsset = { name: safeAssetName(entry.name ?? '', `lingtu-${source.version}${platform === 'windows-x64' ? '-setup.exe' : '.dmg'}`), url: entry.url, ...(entry.size !== undefined ? { size: entry.size } : {}) }
  // 本地版本不低于更新源时不提示，避免回滚或预发布场景出现"更新到更旧版本"。
  const newer = compareVersions(source.version, currentVersion) > 0
  return { ...base, state: newer ? 'update' : 'latest', asset: newer ? asset : null }
}

export type UpdateResponse = { ok: boolean; status: number; json(): Promise<unknown>; body: AsyncIterable<Uint8Array> | null }
export type UpdateFetch = (url: string, init?: RequestInit) => Promise<UpdateResponse>

export type CheckUpdateOptions = { sourceUrl?: string; currentVersion: string; platform?: string; fetch?: UpdateFetch; signal?: AbortSignal; proxyUrl?: string }

/** 拉取更新源并给出检查结果。网络或解析失败一律抛错，由调用方转成用户可见的失败原因。 */
export async function checkForUpdate(options: CheckUpdateOptions): Promise<UpdateCheckResult> {
  const sourceUrl = options.sourceUrl ?? process.env.LINGTU_UPDATE_SOURCE_URL ?? DEFAULT_UPDATE_SOURCE_URL
  const platform = options.platform ?? currentPlatform()
  if (!platform) throw new UpdateSourceError(`当前平台不支持自动更新：${process.platform}/${process.arch}`, 'update_platform_unsupported')
  const fetchImpl = (options.fetch ?? globalThis.fetch) as unknown as UpdateFetch
  const response = await fetchImpl(sourceUrl, networkInit(options.signal, options.proxyUrl))
  if (!response.ok) throw new UpdateSourceError(`更新源请求失败（HTTP ${response.status}）`, 'update_source_unreachable')
  return resolveUpdate(parseUpdateSource(await response.json()), options.currentVersion, platform)
}

export type DownloadProgress = { downloaded: number; total: number }
export type DownloadResult = { path: string; bytes: number }

/** 系统下载目录；更新包是一次性安装件，不进工作区。 */
export function defaultDownloadDirectory(): string {
  return process.env.LINGTU_DOWNLOAD_DIR?.trim() || join(homedir(), 'Downloads')
}

/**
 * 流式下载更新包到下载目录。先写 .part 临时文件，校验字节数后再改名，
 * 避免中途失败在下载目录里留下一个看起来可安装的半成品。
 */
export type RevealSpawn = (command: string, args: string[]) => void

/** 各平台在文件管理器中定位文件的命令；Windows 的 /select 必须与路径拼成同一个参数。 */
export function revealCommand(path: string, platform: string = process.platform): { command: string; args: string[] } | undefined {
  if (platform === 'darwin') return { command: 'open', args: ['-R', path] }
  if (platform === 'win32') return { command: 'explorer.exe', args: [`/select,${path}`] }
  if (platform === 'linux') return { command: 'xdg-open', args: [dirname(path)] }
  return undefined
}

/**
 * 在系统文件管理器中定位安装包。更新包已经落盘，这一步只是替用户省掉手动开目录，
 * 因此失败只向上报错，不回头改下载结果。
 */
export function revealInFileManager(path: string, options: { platform?: string; spawn?: RevealSpawn } = {}): void {
  const platform = options.platform ?? process.platform
  const target = revealCommand(path, platform)
  if (!target) throw new UpdateSourceError(`当前平台不支持打开下载目录：${platform}`, 'update_reveal_unsupported')
  const spawnReveal = options.spawn ?? ((command: string, args: string[]) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    // 命令缺失只会异步抛 error；忽略它，避免未处理的错误事件杀掉常驻的本地服务。
    child.on('error', () => {})
    child.unref()
  })
  try { spawnReveal(target.command, target.args) } catch (error) {
    throw new UpdateSourceError(`打开下载目录失败：${(error as Error).message}`, 'update_reveal_failed')
  }
}

export async function downloadUpdateAsset(options: { asset: UpdateAsset; directory?: string; fetch?: UpdateFetch; onProgress?: (progress: DownloadProgress) => void; signal?: AbortSignal; proxyUrl?: string }): Promise<DownloadResult> {
  const directory = options.directory ?? defaultDownloadDirectory()
  const fetchImpl = (options.fetch ?? globalThis.fetch) as unknown as UpdateFetch
  const response = await fetchImpl(options.asset.url, networkInit(options.signal, options.proxyUrl))
  if (!response.ok) throw new UpdateSourceError(`下载更新包失败（HTTP ${response.status}）`, 'update_download_failed')
  const total = options.asset.size ?? 0
  const body = response.body
  if (!body) throw new UpdateSourceError('下载更新包失败：响应没有内容', 'update_download_failed')

  mkdirSync(directory, { recursive: true })
  const finalPath = join(directory, options.asset.name)
  const partPath = `${finalPath}.part`
  rmSync(partPath, { force: true })
  let downloaded = 0
  // 用 pipeline 串联进度包装与写入流：取消或写入失败时流会被一并销毁，
  // 不会在测试或运行期留下游离的异步写入错误。
  async function* withProgress(): AsyncGenerator<Uint8Array> {
    for await (const chunk of body!) {
      if (options.signal?.aborted) throw new UpdateSourceError('下载已取消', 'update_download_cancelled')
      downloaded += chunk.byteLength
      options.onProgress?.({ downloaded, total })
      yield chunk
    }
  }
  try {
    await pipeline(Readable.from(withProgress(), { objectMode: false }), createWriteStream(partPath))
  } catch (error) {
    rmSync(partPath, { force: true })
    throw error
  }
  // 更新源给出字节数时必须严格对上，否则说明下载被截断或中间被改写。
  if (total > 0 && downloaded !== total) {
    rmSync(partPath, { force: true })
    throw new UpdateSourceError(`更新包大小不符：期望 ${total} 字节，实际 ${downloaded} 字节`, 'update_size_mismatch')
  }
  if (existsSync(finalPath)) rmSync(finalPath, { force: true })
  renameSync(partPath, finalPath)
  return { path: finalPath, bytes: downloaded }
}
