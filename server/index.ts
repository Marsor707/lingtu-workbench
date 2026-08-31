import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isSea } from 'node:sea'
import { editImage, generateImage, ProviderError } from './provider.js'
import type { GenerationResult } from './provider.js'

declare const process: { env: Record<string, string | undefined>; argv: string[]; exitCode?: number }
type HttpRequest = { method?: string; url?: string; headers: Record<string, string | string[] | undefined>; on(event: string, listener: (...args: any[]) => void): void }
type HttpResponse = { statusCode: number; setHeader(name: string, value: string): void; writeHead(statusCode: number, headers?: Record<string, string>): void; write(chunk: string | Uint8Array): void; end(chunk?: string | Uint8Array): void; on?(event: string, listener: (...args: any[]) => void): void }
type NativeServer = { listen(port: number, host: string, callback: () => void): void; close(callback: (error?: Error) => void): void; address(): { port: number } | string | null; once?(event: string, listener: (...args: any[]) => void): void }

export type JobMode = 'generate' | 'edit' | 'text_to_image' | 'one_to_many'
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export type PromptWindow = { id?: string | number; name?: string; prompt: string; enabled?: boolean }
export type JobResult = { path: string; index: number }
export type SourceImage = { data: string; mimeType: string; name: string }
export type Job = {
  id: string; mode: JobMode; status: JobStatus; idempotencyKey?: string; prompt?: string; layout?: string; size?: string; quality?: string; repeat: number
  windows?: PromptWindow[]; results?: JobResult[]; error?: { code: string; message: string }
  provider: { status: 'not_implemented' | 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'; invoked: boolean }
  createdAt: string; updatedAt: string; cancelledAt?: string
}
type ProviderConfig = { baseUrl: string; apiKey: string }
type JobInput = { mode?: unknown; idempotencyKey?: unknown; windows?: unknown; promptWindows?: unknown; prompt?: unknown; layout?: unknown; size?: unknown; quality?: unknown; repeat?: unknown; provider?: unknown; sourceImage?: unknown }
type StoredRequest = { prompt?: string; layout?: string; size?: string; quality?: string; repeat: number; provider: ProviderConfig; sourceImage?: SourceImage }
type Runtime = { controller: AbortController; listeners: Set<HttpResponse> }
type GenerateImage = typeof generateImage
type EditImage = typeof editImage
export type AppOptions = { workspaceDir?: string; staticDir?: string; generateImage?: GenerateImage; editImage?: EditImage; defaultProvider?: Partial<ProviderConfig> }

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 8765
const MAX_BODY_BYTES = 12 * 1024 * 1024
const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_SOURCE_IMAGE_BASE64_LENGTH = Math.ceil(MAX_SOURCE_IMAGE_BYTES / 3) * 4
const VALID_MODES = new Set<JobMode>(['generate', 'edit', 'text_to_image', 'one_to_many'])
const MODE_ALIASES: Record<string, JobMode> = { text: 'text_to_image', 'one-to-many': 'one_to_many' }
function now(): string { return new Date().toISOString() }
function json(res: HttpResponse, statusCode: number, body: unknown): void { res.statusCode = statusCode; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)) }
function errorResponse(res: HttpResponse, statusCode: number, code: string, message: string): void { json(res, statusCode, { error: { code, message } }) }
function headerValue(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value }

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
function providerConfig(value: unknown, defaults: Partial<ProviderConfig>): ProviderConfig {
  if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) throw new RequestValidationError('invalid_provider', 'provider 必须是配置对象')
  const item = (value ?? {}) as Record<string, unknown>
  return { baseUrl: optionalString(item.baseUrl ?? defaults.baseUrl ?? process.env.LINGTU_PROVIDER_BASE_URL, 'provider_base_url') ?? '', apiKey: optionalString(item.apiKey ?? defaults.apiKey ?? process.env.LINGTU_API_KEY, 'provider_api_key') ?? '' }
}

export class JobStore {
  private readonly db: DatabaseSync
  // Provider 密钥只保存在当前进程内存，绝不写入任务快照或 SQLite。
  private readonly runtimeProviders = new Map<string, ProviderConfig>()
  constructor(dbPath = ':memory:') {
    if (dbPath !== ':memory:' && !dbPath.startsWith('file:')) mkdirSync(dirname(resolve(dbPath)), { recursive: true })
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, mode TEXT NOT NULL, status TEXT NOT NULL, windows_json TEXT, provider_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, cancelled_at TEXT, request_json TEXT, results_json TEXT, error_json TEXT);`)
    for (const column of ['request_json TEXT', 'results_json TEXT', 'error_json TEXT']) { try { this.db.exec(`ALTER TABLE jobs ADD COLUMN ${column}`) } catch { /* 兼容已包含列的旧数据库 */ } }
  }
  close(): void { this.db.close() }
  private fromRow(row: Record<string, unknown>): Job {
    const request = row.request_json ? JSON.parse(String(row.request_json)) as StoredRequest : undefined
    return { id: String(row.id), mode: row.mode as JobMode, status: row.status as JobStatus, ...(row.idempotency_key ? { idempotencyKey: String(row.idempotency_key) } : {}), ...(request?.prompt ? { prompt: request.prompt } : {}), ...(request?.layout ? { layout: request.layout } : {}), ...(request?.size ? { size: request.size } : {}), ...(request?.quality ? { quality: request.quality } : {}), repeat: request?.repeat ?? 1, ...(row.windows_json ? { windows: JSON.parse(String(row.windows_json)) as PromptWindow[] } : {}), ...(row.results_json ? { results: JSON.parse(String(row.results_json)) as JobResult[] } : {}), ...(row.error_json ? { error: JSON.parse(String(row.error_json)) as Job['error'] } : {}), provider: JSON.parse(String(row.provider_json)) as Job['provider'], createdAt: String(row.created_at), updatedAt: String(row.updated_at), ...(row.cancelled_at ? { cancelledAt: String(row.cancelled_at) } : {}) }
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
    const request: StoredRequest = { prompt, layout: optionalString(input.layout, 'layout'), size: optionalString(input.size, 'size'), quality: optionalString(input.quality, 'quality'), repeat: repeatValue(input.repeat), provider: providerConfig(input.provider, defaults), ...(sourceImage ? { sourceImage } : {}) }
    const timestamp = now(); const job: Job = { id: `job_${randomUUID()}`, mode, status: 'queued', ...(idempotencyKey ? { idempotencyKey } : {}), ...(request.prompt ? { prompt: request.prompt } : {}), ...(request.layout ? { layout: request.layout } : {}), ...(request.size ? { size: request.size } : {}), ...(request.quality ? { quality: request.quality } : {}), repeat: request.repeat, ...(windows ? { windows } : {}), provider: { status: request.prompt || windows ? 'pending' : 'not_implemented', invoked: false }, createdAt: timestamp, updatedAt: timestamp }
    const persistedRequest = { ...request, provider: { baseUrl: request.provider.baseUrl, apiKey: '' } }
    this.db.prepare('INSERT INTO jobs (id, idempotency_key, mode, status, windows_json, provider_json, created_at, updated_at, request_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(job.id, idempotencyKey ?? null, job.mode, job.status, job.windows ? JSON.stringify(job.windows) : null, JSON.stringify(job.provider), job.createdAt, job.updatedAt, JSON.stringify(persistedRequest))
    this.runtimeProviders.set(job.id, request.provider)
    return { job, created: true }
  }
  list(): Job[] { return (this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as Record<string, unknown>[]).map((row) => this.fromRow(row)) }
  get(id: string): Job | undefined { const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined; return row ? this.fromRow(row) : undefined }
  request(id: string): StoredRequest | undefined { const row = this.db.prepare('SELECT request_json FROM jobs WHERE id = ?').get(id) as { request_json?: string } | undefined; return row?.request_json ? JSON.parse(row.request_json) as StoredRequest : undefined }
  provider(id: string): ProviderConfig | undefined { return this.runtimeProviders.get(id) }
  forgetProvider(id: string): void { this.runtimeProviders.delete(id) }
  update(id: string, status: JobStatus, patch: { provider?: Job['provider']; results?: JobResult[]; error?: Job['error'] } = {}): Job | undefined { const timestamp = now(); this.db.prepare('UPDATE jobs SET status = ?, provider_json = COALESCE(?, provider_json), results_json = COALESCE(?, results_json), error_json = COALESCE(?, error_json), updated_at = ? WHERE id = ?').run(status, patch.provider ? JSON.stringify(patch.provider) : null, patch.results ? JSON.stringify(patch.results) : null, patch.error ? JSON.stringify(patch.error) : null, timestamp, id); return this.get(id) }
  cancel(id: string): Job | undefined { const job = this.get(id); if (!job || ['completed', 'failed', 'cancelled'].includes(job.status)) return job; const timestamp = now(); this.db.prepare('UPDATE jobs SET status = ?, cancelled_at = ?, updated_at = ?, provider_json = ? WHERE id = ?').run('cancelled', timestamp, timestamp, JSON.stringify({ status: 'cancelled', invoked: job.provider.invoked }), id); return this.get(id) }
}
export class RequestValidationError extends Error { constructor(public readonly code: string, message: string) { super(message) } }
function portFromEnvironment(): number { const value = process.env.LINGTU_PORT; if (value === undefined || value === '') return DEFAULT_PORT; const port = Number(value); if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('LINGTU_PORT must be an integer between 0 and 65535'); return port }
function setCors(res: HttpResponse): void { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS') }
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
    const runtime: Runtime = { controller: new AbortController(), listeners: new Set() }; runtimes.set(id, runtime); const running = store.update(id, 'running', { provider: { status: 'running', invoked: false } }); if (!running) return; emit(id, 'snapshot', running)
    const prompts = initial.mode === 'one_to_many' ? (initial.windows ?? []).map((window) => window.prompt) : request.prompt ? [request.prompt] : []
    // 无提示词的旧版请求作为草稿保留，避免凭空调用 Provider。
    if (prompts.length === 0) { runtimes.delete(id); return }
    const total = prompts.length * request.repeat; const results: JobResult[] = []
    try {
      mkdirSync(join(workspaceDir, 'jobs', id), { recursive: true })
      for (const prompt of prompts) for (let repeatIndex = 0; repeatIndex < request.repeat; repeatIndex += 1) {
        if (runtime.controller.signal.aborted) throw new DOMException('任务已取消', 'AbortError')
        const provider = store.provider(id) ?? request.provider
        const result: GenerationResult = initial.mode === 'edit'
          ? await imageEditor({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, prompt, sourceImage: request.sourceImage!, size: request.size, quality: request.quality, signal: runtime.controller.signal })
          : await imageGenerator({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, prompt, size: request.size, quality: request.quality, signal: runtime.controller.signal })
        if (result.kind !== 'base64') throw new Error('Provider 返回的图片不是 base64')
        const index = results.length; const relativePath = join('jobs', id, `${String(index + 1).padStart(3, '0')}.png`); writeFileSync(join(workspaceDir, relativePath), Buffer.from(result.value, 'base64')); results.push({ path: relativePath, index })
        const current = store.get(id); if (current?.status === 'cancelled' || runtime.controller.signal.aborted) return
        emit(id, 'progress', { completed: index + 1, total, result: results[index], job: current })
      }
      const current = store.get(id); if (current?.status === 'cancelled') return; const completed = store.update(id, 'completed', { provider: { status: 'completed', invoked: true }, results }); if (completed) emit(id, 'completed', completed)
    } catch (error) {
      const current = store.get(id); if (current?.status === 'cancelled' || runtime.controller.signal.aborted) { if (current) emit(id, 'failed', current); return }
      const safeError = error instanceof ProviderError ? { code: error.code, message: error.message } : { code: 'generation_failed', message: '生图任务失败' }
      const failed = store.update(id, 'failed', { provider: { status: 'failed', invoked: true }, error: safeError }); if (failed) emit(id, 'failed', failed)
    } finally { if (runtimes.get(id) === runtime) runtimes.delete(id); store.forgetProvider(id) }
  }
  const queue = (id: string): void => { setImmediate(() => { void execute(id) }) }
  return createServer(async (req: HttpRequest, res: HttpResponse) => {
    setCors(res); if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }; const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (req.method === 'GET' && path === '/health') { json(res, 200, { status: 'ok', service: 'lingtu-workbench' }); return }
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
