import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isSea } from 'node:sea'
import { editImage, generateImage, materializeImageResult, ProviderError } from './provider.js'
import type { GenerationResult } from './provider.js'
import { builtinPrompts } from './prompts.js'

declare const process: { env: Record<string, string | undefined>; argv: string[]; exitCode?: number }
type HttpRequest = { method?: string; url?: string; headers: Record<string, string | string[] | undefined>; on(event: string, listener: (...args: any[]) => void): void }
type HttpResponse = { statusCode: number; setHeader(name: string, value: string): void; writeHead(statusCode: number, headers?: Record<string, string>): void; write(chunk: string | Uint8Array): void; end(chunk?: string | Uint8Array): void; on?(event: string, listener: (...args: any[]) => void): void }
type NativeServer = { listen(port: number, host: string, callback: () => void): void; close(callback: (error?: Error) => void): void; address(): { port: number } | string | null; once?(event: string, listener: (...args: any[]) => void): void }

export type JobMode = 'generate' | 'edit' | 'text_to_image' | 'one_to_many'
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type PromptWindow = { id?: string | number; name?: string; prompt: string; enabled?: boolean }
export type JobResult = { path: string; index: number }
export type Prompt = { id: string; category: string; title: string; text: string; layout: string; builtin: boolean; sourceName: string }
export type AppStats = { completed: number; running: number; review: number; failed: number; total: number; storageBytes: number }
export type SourceImage = { data: string; mimeType: string; name: string }
export type Job = {
  id: string; mode: JobMode; status: JobStatus; idempotencyKey?: string; prompt?: string; layout?: string; size?: string; resolution?: string; quality?: string; repeat: number
  windows?: PromptWindow[]; results?: JobResult[]; error?: { code: string; message: string }
  provider: { status: 'not_implemented' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; invoked: boolean }
  createdAt: string; updatedAt: string; cancelledAt?: string
}
type ProviderConfig = { baseUrl: string; apiKey: string }
type JobInput = { mode?: unknown; idempotencyKey?: unknown; windows?: unknown; promptWindows?: unknown; prompt?: unknown; layout?: unknown; size?: unknown; resolution?: unknown; quality?: unknown; repeat?: unknown; provider?: unknown; sourceImage?: unknown }
type StoredRequest = { prompt?: string; layout?: string; size?: string; resolution?: string; quality?: string; repeat: number; provider: ProviderConfig; sourceImage?: SourceImage }
type Runtime = { controller: AbortController; listeners: Set<HttpResponse> }
type GenerateImage = typeof generateImage
type EditImage = typeof editImage
export type AppOptions = { workspaceDir?: string; staticDir?: string; generateImage?: GenerateImage; editImage?: EditImage; defaultProvider?: Partial<ProviderConfig> }

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8765
const MAX_BODY_BYTES = 12 * 1024 * 1024
const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_SOURCE_IMAGE_BASE64_LENGTH = Math.ceil(MAX_SOURCE_IMAGE_BYTES / 3) * 4
const RESULTS_DIRECTORY = 'jobs'
const VALID_MODES = new Set<JobMode>(['generate', 'edit', 'text_to_image', 'one_to_many'])
const MODE_ALIASES: Record<string, JobMode> = { text: 'text_to_image', 'one-to-many': 'one_to_many' }

type OutputLayoutSpec = { name: string; arrangement: string }
const OUTPUT_LAYOUTS: Record<string, OutputLayoutSpec> = {
  '四宫格': { name: '四宫格', arrangement: '四个彼此独立的成品区域，固定为 2 列 × 2 行排列' },
  '4K 四宫格': { name: '四宫格', arrangement: '四个彼此独立的成品区域，固定为 2 列 × 2 行排列' },
  four_up: { name: '四宫格', arrangement: '四个彼此独立的成品区域，固定为 2 列 × 2 行排列' },
  '二宫格': { name: '二宫格', arrangement: '两个彼此独立的成品区域，固定为上下两行排列' },
  '1K 二宫格': { name: '二宫格', arrangement: '两个彼此独立的成品区域，固定为上下两行排列' },
  two_up: { name: '二宫格', arrangement: '两个彼此独立的成品区域，固定为上下两行排列' },
  '九宫格': { name: '九宫格', arrangement: '九个彼此独立的成品区域，固定为 3 列 × 3 行排列' },
  nine_up: { name: '九宫格', arrangement: '九个彼此独立的成品区域，固定为 3 列 × 3 行排列' },
  // 仅兼容历史任务，前端不再提供十五宫格选项。
  '4K 十五宫格（测试）': { name: '十五宫格', arrangement: '十五个彼此独立的成品区域，固定为 3 列 × 5 行排列' },
  fifteen_up_test: { name: '十五宫格', arrangement: '十五个彼此独立的成品区域，固定为 3 列 × 5 行排列' },
}
function outputAspectRatio(size?: string): string | undefined {
  if (!size) return undefined
  const match = size.trim().match(/(\d+)\s*[×xX]\s*(\d+)/)
  if (!match) return undefined
  const width = Number(match[1]); const height = Number(match[2])
  if (!width || !height) return undefined
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}
export function buildEffectivePrompt(prompt: string, layout?: string, size?: string, resolution?: string): string {
  const layoutSpec = layout ? OUTPUT_LAYOUTS[layout.trim()] : undefined
  const ratio = outputAspectRatio(size)
  const resolutionLevel = resolution?.trim()
  const parameterLines = [
    '[灵图高级输出参数（最高优先级）]',
    '- 忽略提示词中关于输出宫格数量、行列排列、画布尺寸、分辨率和长宽比例的旧指令；主题、内容结构、风格和安全要求仍然有效。',
    ...(layoutSpec ? [`- 输出布局：${layoutSpec.name}；${layoutSpec.arrangement}。`] : []),
    ...(ratio ? [`- 目标画布长宽比：${ratio}（来自高级参数 ${size}）；Provider 可选择其支持的实际分辨率，但应尽量保持该比例。`] : []),
    ...(resolutionLevel ? [`- 目标分辨率等级：${resolutionLevel}；Provider 可按模型能力返回最接近的实际分辨率。`] : []),
    '- 不要输出宫格编号、说明文字、参考板、进度图、产品 mockup 或额外画布。',
  ]
  return `${prompt.trim()}\n\n${parameterLines.join('\n')}`
}
function now(): string { return new Date().toISOString() }
function executionLogTimestamp(): string {
  // 业务日志面向本地操作者，使用东八区并保留明确的时区偏移；数据库时间仍保持 UTC。
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00')
}
function json(res: HttpResponse, statusCode: number, body: unknown): void { res.statusCode = statusCode; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)) }
function errorResponse(res: HttpResponse, statusCode: number, code: string, message: string): void { json(res, statusCode, { error: { code, message } }) }
function headerValue(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value }
function safeLogText(value: string): string { return value.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').replace(/https?:\/\/[^\s)]+/gi, '[url]').slice(0, 500) }
function providerHost(baseUrl: string): string | undefined { try { return new URL(baseUrl).hostname } catch { return undefined } }
function logErrorFields(error: unknown): Record<string, unknown> {
  if (error instanceof ProviderError) return { errorCode: error.code, ...(error.status === undefined ? {} : { httpStatus: error.status }), errorMessage: error.message, ...(error.detail ? { errorDetail: error.detail } : {}) }
  if (error instanceof Error) return { errorName: error.name, errorMessage: safeLogText(error.message) }
  return { errorName: typeof error }
}
function appendExecutionLog(workspaceDir: string, event: string, fields: Record<string, unknown> = {}): void {
  try {
    const logDirectory = join(workspaceDir, 'logs')
    mkdirSync(logDirectory, { recursive: true })
    appendFileSync(join(logDirectory, 'execution.log'), `${JSON.stringify({ timestamp: executionLogTimestamp(), event, ...fields })}\n`, 'utf8')
  } catch {
    // 日志属于旁路诊断能力，目录不可写时不能改变任务本身的成功或失败结果。
  }
}

async function readBody(req: HttpRequest): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    const chunks: string[] = []; let size = 0; let settled = false
    req.on('data', (chunk: Uint8Array | string) => { const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk); size += new TextEncoder().encode(text).byteLength; if (size > MAX_BODY_BYTES && !settled) { settled = true; reject(new Error('request body is too large')); return }; chunks.push(text) })
    req.on('end', () => { if (settled) return; settled = true; const text = chunks.join('').trim(); if (!text) { reject(new Error('request body is required')); return }; try { resolveBody(JSON.parse(text)) } catch { reject(new Error('request body must be valid JSON')) } })
    req.on('error', (error: Error) => { if (!settled) { settled = true; reject(error) } })
  })
}
function normalizeMode(value: unknown): JobMode | undefined { if (typeof value !== 'string') return undefined; const mode = MODE_ALIASES[value] ?? value; return VALID_MODES.has(mode as JobMode) ? mode as JobMode : undefined }
function validWindows(value: unknown): PromptWindow[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((window): window is PromptWindow => { if (!window || typeof window !== 'object') return false; const item = window as Record<string, unknown>; return typeof item.prompt === 'string' && item.prompt.trim().length > 0 && item.enabled !== false }).map((window) => ({ id: typeof window.id === 'string' || typeof window.id === 'number' ? window.id : undefined, name: typeof window.name === 'string' ? window.name : undefined, prompt: window.prompt.trim(), enabled: window.enabled !== false }))
}
function optionalString(value: unknown, field: string): string | undefined { if (value === undefined || value === null) return undefined; if (typeof value !== 'string' || value.trim() === '') throw new RequestValidationError(`invalid_${field}`, `${field} 必须是非空字符串`); return value.trim() }
function repeatValue(value: unknown): number { if (value === undefined) return 1; if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100) throw new RequestValidationError('invalid_repeat', 'repeat 必须是 1 到 100 的整数'); return value as number }
function sourceImageValue(value: unknown): SourceImage | undefined {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RequestValidationError('invalid_source_image', 'sourceImage 必须是图片对象')
  const item = value as Record<string, unknown>
  if (typeof item.data !== 'string' || typeof item.mimeType !== 'string' || typeof item.name !== 'string') throw new RequestValidationError('invalid_source_image', 'sourceImage 必须包含 data、mimeType 和 name')
  const data = item.data.replace(/\s+/g, '')
  const mimeType = item.mimeType.trim().toLowerCase()
  const originalName = item.name.trim()
  const name = basename(originalName)
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const estimatedBytes = Math.floor(data.length * 3 / 4) - padding
  if (data.length > MAX_SOURCE_IMAGE_BASE64_LENGTH || estimatedBytes > MAX_SOURCE_IMAGE_BYTES) throw new RequestValidationError('source_image_too_large', 'sourceImage 大小不能超过 8 MB')
  // 避免对 8MB 图片执行带大重复量词的正则，逐字符校验不会触发正则栈溢出。
  let validBase64 = data.length % 4 === 0
  let paddingStarted = false
  let paddingLength = 0
  for (let index = 0; validBase64 && index < data.length; index += 1) {
    const char = data[index]
    if (char === '=') {
      paddingStarted = true
      paddingLength += 1
      validBase64 = index >= data.length - 2
    } else validBase64 = !paddingStarted && /[A-Za-z0-9+/]/.test(char)
  }
  validBase64 = validBase64 && paddingLength <= 2
  // 在进入 Provider 前限制格式和原始字节数，避免把任意大字符串交给 multipart 上传。
  if (!data || !validBase64 || !name || originalName.includes('\0') || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) throw new RequestValidationError('invalid_source_image', 'sourceImage 必须是有效的 PNG、JPEG 或 WebP base64 图片')
  const bytes = Buffer.byteLength(data, 'base64')
  if (bytes === 0 || bytes > MAX_SOURCE_IMAGE_BYTES) throw new RequestValidationError('source_image_too_large', 'sourceImage 大小不能超过 8 MB')
  return { data, mimeType, name: name.slice(0, 200) }
}
function environmentProvider(): Partial<ProviderConfig> {
  // 灵图后端配置只使用项目自己的环境变量，避免耦合外部 Skill 的命名约定。
  const baseUrl = process.env.LINGTU_PROVIDER_BASE_URL?.trim()
  const apiKey = process.env.LINGTU_API_KEY?.trim()
  return { ...(baseUrl ? { baseUrl } : {}), ...(apiKey ? { apiKey } : {}) }
}
function providerConfig(value: unknown, defaults: Partial<ProviderConfig>): ProviderConfig {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new RequestValidationError('invalid_provider', 'provider 必须是配置对象')
  const item = (value ?? {}) as Record<string, unknown>
  const env = environmentProvider()
  return {
    // 后端环境变量是最终生效配置；请求体只在未配置环境变量时作为兼容回退。
    baseUrl: env.baseUrl ?? optionalString(item.baseUrl ?? defaults.baseUrl, 'provider_base_url') ?? '',
    apiKey: env.apiKey ?? optionalString(item.apiKey ?? defaults.apiKey, 'provider_api_key') ?? '',
  }
}
function effectiveProviderMetadata(store: JobStore): { baseUrl: string; configured: boolean } {
  const env = environmentProvider()
  const stored = store.getProviderConfig()
  return { baseUrl: env.baseUrl ?? stored?.baseUrl ?? '', configured: Boolean(env.apiKey ?? stored?.apiKey) }
}

export class JobStore {
  private readonly db: DatabaseSync
  // Provider 密钥只保存在本地配置表，不写入任务快照、列表接口或日志。
  private readonly runtimeProviders = new Map<string, ProviderConfig>()
  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:' && !dbPath.startsWith('file:')) mkdirSync(dirname(resolve(dbPath)), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, mode TEXT NOT NULL, status TEXT NOT NULL, windows_json TEXT, provider_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cancelled_at TEXT, request_json TEXT, results_json TEXT, error_json TEXT);`)
    for (const column of ['request_json TEXT', 'results_json TEXT', 'error_json TEXT']) { try { this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column}`) } catch { /* 兼容已包含列的旧数据库 */ } }
    this.db.exec('CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, layout TEXT NOT NULL, builtin INTEGER NOT NULL, source_name TEXT NOT NULL)')
    const seedPrompt = this.db.prepare('INSERT OR IGNORE INTO prompts (id, category, title, text, layout, builtin, source_name) VALUES (?, ?, ?, ?, ?, ?, ?)')
    // 提示词随数据库首次初始化写入，后续启动只补齐缺失项，不覆盖用户已有记录。
    for (const prompt of builtinPrompts) seedPrompt.run(prompt.id, prompt.category, prompt.title, prompt.text, prompt.layout, prompt.builtin ? 1 : 0, prompt.sourceName)
    const migratePrompt = this.db.prepare(`UPDATE prompts
      SET category = ?, title = ?, text = ?, layout = ?, source_name = ?
      WHERE id = ? AND builtin = 1
        AND (text LIKE '%Output rules:%' OR text LIKE '%Output contract:%' OR text LIKE '%LT_4K_%' OR text LIKE '%Final 4K structure check:%')`)
    // 仅迁移仍含旧输出契约的内置记录，避免覆盖人工新增或自定义提示词。
    for (const prompt of builtinPrompts) migratePrompt.run(prompt.category, prompt.title, prompt.text, prompt.layout, prompt.sourceName, prompt.id)
    this.db.exec('CREATE TABLE IF NOT EXISTS provider_config (id INTEGER PRIMARY KEY CHECK (id = 1), base_url TEXT NOT NULL, api_key TEXT NOT NULL, updated_at TEXT NOT NULL)')
  }
  close(): void { this.db.close() }
  private fromRow(row: Record<string, unknown>): Job {
    const request = row.request_json ? JSON.parse(String(row.request_json)) as StoredRequest : undefined
    return { id: String(row.id), mode: row.mode as JobMode, status: row.status as JobStatus, ...(row.idempotency_key ? { idempotencyKey: String(row.idempotency_key) } : {}), ...(request?.prompt ? { prompt: request.prompt } : {}), ...(request?.layout ? { layout: request.layout } : {}), ...(request?.size ? { size: request.size } : {}), ...(request?.resolution ? { resolution: request.resolution } : {}), ...(request?.quality ? { quality: request.quality } : {}), repeat: request?.repeat ?? 1, ...(row.windows_json ? { windows: JSON.parse(String(row.windows_json)) as PromptWindow[] } : {}), ...(row.results_json ? { results: JSON.parse(String(row.results_json)) as JobResult[] } : {}), ...(row.error_json ? { error: JSON.parse(String(row.error_json)) as Job['error'] } : {}), provider: JSON.parse(String(row.provider_json)) as Job['provider'], createdAt: String(row.created_at), updatedAt: String(row.updated_at), ...(row.cancelled_at ? { cancelledAt: String(row.cancelled_at) } : {}) }
  }
  create(input: JobInput, idempotencyKey?: string, defaults: Partial<ProviderConfig> = {}): { job: Job; created: boolean } {
    if (idempotencyKey) { const existing = this.db.prepare('SELECT * FROM jobs WHERE idempotency_key = ?').get(idempotencyKey) as Record<string, unknown> | undefined; if (existing) return { job: this.fromRow(existing), created: false } }
    const mode = normalizeMode(input.mode); if (!mode) throw new RequestValidationError('invalid_mode', 'mode 必须是 generate、edit、text_to_image 或 one_to_many')
    const windows = mode === 'one_to_many' ? validWindows(input.windows ?? input.promptWindows) : undefined
    if (mode === 'one_to_many' && (!windows || windows.length < 2)) throw new RequestValidationError('invalid_windows', '一裂多至少需要两个启用且非空的提示词窗口')
    const prompt = optionalString(input.prompt, 'prompt')
    const sourceImage = sourceImageValue(input.sourceImage)
    if (mode === 'edit' && !sourceImage) throw new RequestValidationError('invalid_source_image', 'edit 模式必须提供 sourceImage')
    if (mode === 'edit' && !prompt) throw new RequestValidationError('invalid_prompt', 'edit 模式必须提供 prompt')
    const request: StoredRequest = { prompt, layout: optionalString(input.layout, 'layout'), size: optionalString(input.size, 'size'), resolution: optionalString(input.resolution, 'resolution'), quality: optionalString(input.quality, 'quality'), repeat: repeatValue(input.repeat), provider: providerConfig(input.provider, { ...this.getProviderConfig(), ...defaults }), ...(sourceImage ? { sourceImage } : {}) }
    const timestamp = now(); const job: Job = { id: `job_${randomUUID()}`, mode, status: 'queued', ...(idempotencyKey ? { idempotencyKey } : {}), ...(request.prompt ? { prompt: request.prompt } : {}), ...(request.layout ? { layout: request.layout } : {}), ...(request.size ? { size: request.size } : {}), ...(request.resolution ? { resolution: request.resolution } : {}), ...(request.quality ? { quality: request.quality } : {}), repeat: request.repeat, ...(windows ? { windows } : {}), provider: { status: request.prompt || windows ? 'pending' : 'not_implemented', invoked: false }, createdAt: timestamp, updatedAt: timestamp }
    const persistedRequest = { ...request, provider: { baseUrl: request.provider.baseUrl, apiKey: '' } }
    this.db.prepare('INSERT INTO jobs (id, idempotency_key, mode, status, windows_json, provider_json, created_at, updated_at, request_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(job.id, idempotencyKey ?? null, job.mode, job.status, job.windows ? JSON.stringify(job.windows) : null, JSON.stringify(job.provider), job.createdAt, job.updatedAt, JSON.stringify(persistedRequest))
    this.runtimeProviders.set(job.id, request.provider)
    return { job, created: true }
  }
  list(): Job[] { return (this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as Record<string, unknown>[]).map((row) => this.fromRow(row)) }
  get(id: string): Job | undefined { const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined; return row ? this.fromRow(row) : undefined }
  getProviderConfig(): ProviderConfig | undefined {
    const row = this.db.prepare('SELECT base_url, api_key FROM provider_config WHERE id = 1').get() as { base_url?: string; api_key?: string } | undefined
    return row?.base_url && row.api_key ? { baseUrl: String(row.base_url), apiKey: String(row.api_key) } : undefined
  }
  saveProviderConfig(config: ProviderConfig): void {
    this.db.prepare('INSERT INTO provider_config (id, base_url, api_key, updated_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET base_url = excluded.base_url, api_key = excluded.api_key, updated_at = excluded.updated_at').run(config.baseUrl, config.apiKey, now())
  }
  prompts(): Prompt[] {
    return (this.db.prepare('SELECT id, category, title, text, layout, builtin, source_name FROM prompts ORDER BY rowid').all() as Record<string, unknown>[]).map((row) => ({
      id: String(row.id), category: String(row.category), title: String(row.title), text: String(row.text), layout: String(row.layout), builtin: Number(row.builtin) === 1, sourceName: String(row.source_name),
    }))
  }
  stats(workspaceDir: string): AppStats {
    const counts = { completed: 0, running: 0, review: 0, failed: 0, total: 0 }
    const paths = new Set<string>()
    const rows = this.db.prepare('SELECT status, results_json FROM jobs').all() as Record<string, unknown>[]
    for (const row of rows) {
      counts.total += 1
      const status = String(row.status)
      if (status === 'completed') counts.completed += 1
      else if (status === 'running') counts.running += 1
      else if (status === 'review') counts.review += 1
      else if (status === 'failed') counts.failed += 1
      if (typeof row.results_json === 'string') {
        try {
          const results = JSON.parse(row.results_json) as unknown
          if (Array.isArray(results)) for (const result of results) {
            if (result && typeof result === 'object' && typeof (result as Record<string, unknown>).path === 'string') paths.add((result as Record<string, unknown>).path as string)
          }
        } catch {
          // 旧版本结果快照损坏时跳过该条，不影响工作台其他统计。
        }
      }
    }
    const root = resolve(workspaceDir)
    let storageBytes = 0
    for (const resultPath of paths) {
      const candidate = resolve(root, resultPath)
      const outside = relative(root, candidate)
      if (isAbsolute(outside) || outside === '..' || outside.startsWith('../') || outside.startsWith('..\\')) continue
      try {
        const file = statSync(candidate)
        if (file.isFile()) storageBytes += file.size
      } catch {
        // 结果文件可能已被用户移除，统计以当前工作区实际内容为准。
      }
    }
    return { ...counts, storageBytes }
  }
  request(id: string): StoredRequest | undefined { const row = this.db.prepare('SELECT request_json FROM jobs WHERE id = ?').get(id) as { request_json?: string } | undefined; return row?.request_json ? JSON.parse(row.request_json) as StoredRequest : undefined }
  provider(id: string): ProviderConfig | undefined { return this.runtimeProviders.get(id) }
  forgetProvider(id: string): void { this.runtimeProviders.delete(id) }
  update(id: string, status: JobStatus, patch: { provider?: Job['provider']; results?: JobResult[]; error?: Job['error'] } = {}): Job | undefined { const timestamp = now(); this.db.prepare('UPDATE jobs SET status = ?, provider_json = COALESCE(?, provider_json), results_json = COALESCE(?, results_json), error_json = COALESCE(?, error_json), updated_at = ? WHERE id = ?').run(status, patch.provider ? JSON.stringify(patch.provider) : null, patch.results ? JSON.stringify(patch.results) : null, patch.error ? JSON.stringify(patch.error) : null, timestamp, id); return this.get(id) }
  cancel(id: string): Job | undefined { const job = this.get(id); if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return job; const timestamp = now(); this.db.prepare('UPDATE jobs SET status = ?, cancelled_at = ?, updated_at = ?, provider_json = ? WHERE id = ?').run('cancelled', timestamp, timestamp, JSON.stringify({ status: 'cancelled', invoked: job.provider.invoked }), id); return this.get(id) }
}
export class RequestValidationError extends Error { constructor(public readonly code: string, message: string) { super(message) } }
function portFromEnvironment(): number { const value = process.env.LINGTU_PORT; if (value === undefined || value === '') return DEFAULT_PORT; const port = Number(value); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('LINGTU_PORT must be an integer between 0 and 65535'); return port }
function setCors(res: HttpResponse): void { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS') }
function dataEvent(event: string, data: unknown): string { return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n` }
const STATIC_CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp',
}
function staticFilePath(staticDir: string, pathname: string): string | undefined {
  let decodedPath: string
  try { decodedPath = decodeURIComponent(pathname) } catch { return undefined }
  if (decodedPath.includes('\0')) return undefined
  const requestedPath = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^[/\\]+/, '').replaceAll('\\', '/')
  if (requestedPath.split('/').some((segment) => segment === '..')) return undefined
  const root = resolve(staticDir); const candidate = resolve(root, requestedPath); const outside = relative(root, candidate)
  if (isAbsolute(outside) || outside === '..' || outside.startsWith('../') || outside.startsWith('..\\')) return undefined
  return candidate
}
function serveStatic(res: HttpResponse, staticDir: string, pathname: string): boolean {
  const filePath = staticFilePath(staticDir, pathname)
  if (!filePath) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('静态资源不存在'); return true }
  try {
    const file = readFileSync(filePath); const contentType = STATIC_CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'Content-Length': String(file.byteLength) }); res.end(file)
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end('静态资源不存在') }
  return true
}

export function createApp(store = new JobStore(), options: AppOptions = {}): NativeServer {
  const runtimes = new Map<string, Runtime>(); const workspaceDir = resolve(options.workspaceDir ?? process.env.LINGTU_WORKSPACE ?? 'workspace'); const staticDirValue = options.staticDir ?? process.env.LINGTU_STATIC_DIR; const staticDir = staticDirValue?.trim() ? resolve(staticDirValue) : undefined; const imageGenerator = options.generateImage ?? generateImage; const imageEditor = options.editImage ?? editImage
  const emit = (id: string, event: string, data: unknown): void => { const runtime = runtimes.get(id); if (!runtime) return; const message = dataEvent(event, data); for (const listener of runtime.listeners) { try { listener.write(message) } catch { runtime.listeners.delete(listener) } }; if (event === 'completed' || event === 'failed') { for (const listener of runtime.listeners) listener.end(); runtime.listeners.clear() } }
  const execute = async (id: string): Promise<void> => {
    const request = store.request(id); const initial = store.get(id); if (!request || !initial || initial.status !== 'queued') return
    const jobStartedAt = Date.now()
    appendExecutionLog(workspaceDir, 'job_started', { jobId: id, mode: initial.mode, repeat: request.repeat, size: request.size, resolution: request.resolution, quality: request.quality, promptCount: initial.mode === 'one_to_many' ? initial.windows?.length ?? 0 : request.prompt ? 1 : 0 })
    const runtime: Runtime = { controller: new AbortController(), listeners: new Set() }; runtimes.set(id, runtime); const running = store.update(id, 'running', { provider: { status: 'running', invoked: false } }); if (!running) return; emit(id, 'snapshot', running)
    const prompts = initial.mode === 'one_to_many' ? (initial.windows ?? []).map((window) => window.prompt) : request.prompt ? [request.prompt] : []
    // 无提示词的旧版请求作为草稿保留，避免凭空调用 Provider。
    if (prompts.length === 0) { runtimes.delete(id); return }
    const total = prompts.length * request.repeat; const results: JobResult[] = []
    let providerStage: 'request' | 'materialize' | undefined
    try {
      // 所有结果平铺到统一目录，文件名带任务 ID 以避免不同任务互相覆盖。
      mkdirSync(join(workspaceDir, RESULTS_DIRECTORY), { recursive: true })
      for (const prompt of prompts) for (let repeatIndex = 0; repeatIndex < request.repeat; repeatIndex += 1) {
        if (runtime.controller.signal.aborted) throw new DOMException('任务已取消', 'AbortError')
        const provider = store.provider(id) ?? request.provider
        const requestStartedAt = Date.now()
        providerStage = 'request'
        appendExecutionLog(workspaceDir, 'provider_request_started', { jobId: id, mode: initial.mode, itemIndex: results.length, providerHost: providerHost(provider.baseUrl), size: request.size, resolution: request.resolution, quality: request.quality })
        const effectivePrompt = buildEffectivePrompt(prompt, request.layout, request.size, request.resolution)
        const result: GenerationResult = initial.mode === 'edit'
          ? await imageEditor({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, prompt: effectivePrompt, sourceImage: request.sourceImage!, size: request.size, quality: request.quality, signal: runtime.controller.signal })
          : await imageGenerator({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, prompt: effectivePrompt, size: request.size, quality: request.quality, signal: runtime.controller.signal })
        appendExecutionLog(workspaceDir, 'provider_response_received', { jobId: id, itemIndex: results.length, resultKind: result.kind, durationMs: Date.now() - requestStartedAt })
        // Provider 可能返回 base64，也可能返回短时效图片 URL；URL 必须在任务执行期间下载后再落盘。
        providerStage = 'materialize'
        const imageBytes = await materializeImageResult(result, runtime.controller.signal)
        appendExecutionLog(workspaceDir, 'provider_result_materialized', { jobId: id, itemIndex: results.length, resultKind: result.kind, bytes: imageBytes.byteLength, durationMs: Date.now() - requestStartedAt })
        const index = results.length; const relativePath = join(RESULTS_DIRECTORY, `${id}-${String(index + 1).padStart(3, '0')}.png`); writeFileSync(join(workspaceDir, relativePath), imageBytes); results.push({ path: relativePath, index })
        providerStage = undefined
        const current = store.get(id); if (current?.status === 'cancelled' || runtime.controller.signal.aborted) return
        emit(id, 'progress', { completed: index + 1, total, result: results[index], job: current })
      }
      const current = store.get(id); if (current?.status === 'cancelled') return; const completed = store.update(id, 'completed', { provider: { status: 'completed', invoked: true }, results }); if (completed) { appendExecutionLog(workspaceDir, 'job_completed', { jobId: id, resultCount: results.length, durationMs: Date.now() - jobStartedAt }); emit(id, 'completed', completed) }
    } catch (error) {
      const current = store.get(id); if (current?.status === 'cancelled' || runtime.controller.signal.aborted) { if (current) emit(id, 'failed', current); return }
      // 仅向前端返回可操作的诊断方向，不透传 Provider 原始响应或请求内容。
      const safeError = error instanceof ProviderError
        ? { code: error.code, message: error.message }
        : { code: 'generation_failed', message: 'Provider 请求未完成，请检查接口地址、网络或 API Key' }
      if (providerStage) appendExecutionLog(workspaceDir, 'provider_stage_failed', { jobId: id, stage: providerStage, ...logErrorFields(error) })
      appendExecutionLog(workspaceDir, 'job_failed', { jobId: id, mode: initial.mode, durationMs: Date.now() - jobStartedAt, ...logErrorFields(error) })
      const failed = store.update(id, 'failed', { provider: { status: 'failed', invoked: true }, error: safeError }); if (failed) emit(id, 'failed', failed)
    } finally { if (runtimes.get(id) === runtime) runtimes.delete(id); store.forgetProvider(id) }
  }
  const queue = (id: string): void => { setImmediate(() => { void execute(id) }) }
  return createServer(async (req: HttpRequest, res: HttpResponse) => {
    setCors(res); if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }; const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (req.method === 'GET' && path === '/health') { json(res, 200, { status: 'ok', service: 'lingtu-workbench' }); return }
    if (req.method === 'GET' && path === '/api/stats') { json(res, 200, store.stats(workspaceDir)); return }
    if (req.method === 'GET' && path === '/api/prompts') { const items = store.prompts(); json(res, 200, { items, total: items.length }); return }
    if (req.method === 'GET' && path === '/api/provider') {
      json(res, 200, effectiveProviderMetadata(store))
      return
    }
    if (req.method === 'PUT' && path === '/api/provider') {
      let body: unknown
      try { body = await readBody(req) } catch (error) { errorResponse(res, 400, 'invalid_json', (error as Error).message); return }
      try {
        const config = providerConfig(body, {})
        if (!config.baseUrl) throw new RequestValidationError('invalid_provider_base_url', 'provider_base_url 必须是非空字符串')
        if (!config.apiKey) throw new RequestValidationError('invalid_provider_api_key', 'provider_api_key 必须是非空字符串')
        if (environmentProvider().baseUrl || environmentProvider().apiKey) {
          // 环境变量管理模式下不把用户输入写回 SQLite，避免产生“看似保存但实际不生效”的端点。
          json(res, 200, effectiveProviderMetadata(store))
          return
        }
        store.saveProviderConfig(config)
        json(res, 200, { baseUrl: config.baseUrl, configured: true })
      } catch (error) {
        if (error instanceof RequestValidationError) { errorResponse(res, 400, error.code, error.message); return }
        errorResponse(res, 500, 'internal_error', 'Provider 配置保存失败')
      }
      return
    }
    if (req.method === 'POST' && path === '/api/jobs') {
      let body: unknown; try { body = await readBody(req) } catch (error) { errorResponse(res, 400, 'invalid_json', (error as Error).message); return }; if (!body || typeof body !== 'object' || Array.isArray(body)) { errorResponse(res, 400, 'invalid_body', '请求体必须是 JSON 对象'); return }
      const input = body as JobInput; const bodyKey = input.idempotencyKey; const headerKey = headerValue(req.headers['idempotency-key']); if (bodyKey !== undefined && typeof bodyKey !== 'string') { errorResponse(res, 400, 'invalid_idempotency_key', 'idempotencyKey 必须是字符串'); return }; if (bodyKey && headerKey && bodyKey !== headerKey) { errorResponse(res, 400, 'idempotency_key_mismatch', '请求体与请求头的幂等键不一致'); return }; const idempotencyKey = bodyKey || headerKey; if (idempotencyKey !== undefined && (idempotencyKey.trim() === '' || idempotencyKey.length > 200)) { errorResponse(res, 400, 'invalid_idempotency_key', 'idempotencyKey 长度必须为 1 到 200 个字符'); return }
      try { const result = store.create(input, idempotencyKey, options.defaultProvider); json(res, result.created ? 201 : 200, result.job); if (result.created && (result.job.prompt || result.job.windows)) queue(result.job.id) } catch (error) { if (error instanceof RequestValidationError) { errorResponse(res, 400, error.code, error.message); return }; errorResponse(res, 500, 'internal_error', '创建任务失败') }; return
    }
    if (req.method === 'GET' && path === '/api/jobs') { const items = store.list(); json(res, 200, { items, total: items.length }); return }
    const resultMatch = path.match(/^\/api\/jobs\/([^/]+)\/results\/(\d+)$/)
    if (req.method === 'GET' && resultMatch) {
      const job = store.get(decodeURIComponent(resultMatch[1]))
      const result = job?.results?.find((item) => item.index === Number(resultMatch[2]))
      if (!job || !result) { errorResponse(res, 404, 'result_not_found', '结果不存在'); return }
      try {
        const file = readFileSync(join(workspaceDir, result.path))
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
        res.end(file)
      } catch { errorResponse(res, 404, 'result_not_found', '结果文件不存在') }
      return
    }
    const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(?:\/([^/]+))?$/); if (jobMatch) { const id = decodeURIComponent(jobMatch[1]); const action = jobMatch[2]
      if (req.method === 'GET' && action === 'events') { const job = store.get(id); if (!job) { errorResponse(res, 404, 'job_not_found', '任务不存在'); return }; res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); const runtime = runtimes.get(id); if (runtime) runtime.listeners.add(res); res.write(dataEvent('snapshot', job)); if (['completed', 'failed', 'cancelled'].includes(job.status)) { res.write(dataEvent(job.status === 'completed' ? 'completed' : 'failed', job)); res.end(); return }; if (!runtime) { res.end(); return }; res.on?.('close', () => runtime.listeners.delete(res)); return }
      if (req.method === 'GET' && !action) { const job = store.get(id); if (!job) errorResponse(res, 404, 'job_not_found', '任务不存在'); else json(res, 200, job); return }
      if (req.method === 'POST' && action === 'cancel') { const runtime = runtimes.get(id); const job = store.cancel(id); if (!job) { errorResponse(res, 404, 'job_not_found', '任务不存在'); return }; if (runtime) { runtime.controller.abort(); emit(id, 'failed', job) }; json(res, 200, job); return }
    }
    // API 路由处理完后再托管静态文件，避免把未知 API 请求误返回前端首页。
    if (req.method === 'GET' && staticDir && path !== '/api' && !path.startsWith('/api/')) { serveStatic(res, staticDir, path); return }
    errorResponse(res, 404, 'not_found', '接口不存在')
  }) as unknown as NativeServer
}
export function startServer(port = portFromEnvironment(), host = DEFAULT_HOST, store = new JobStore(), options: AppOptions = {}): Promise<NativeServer> { const server = createApp(store, options); return new Promise((resolveServer, reject) => { server.listen(port, host, () => resolveServer(server)); server.once?.('error', reject) }) }
if (isSea() || (process.argv[1] && basename(process.argv[1]) === 'index.js')) { const dbPath = process.env.LINGTU_DB_PATH ?? 'workspace/lingtu.db'; startServer(portFromEnvironment(), DEFAULT_HOST, new JobStore(dbPath)).then((server) => { const address = server.address(); const port = typeof address === 'object' && address ? address.port : portFromEnvironment(); console.log(JSON.stringify({ ready: true, port, host: DEFAULT_HOST })) }).catch((error) => { console.error(error); process.exitCode = 1 }) }
