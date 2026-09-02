import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { createRoot } from 'react-dom/client'
import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  CloudUpload,
  Copy,
  Eye,
  EyeOff,
  FileImage,
  FolderOpen,
  GalleryHorizontalEnd,
  GripVertical,
  ImagePlus,
  Images,
  LayoutGrid,
  ListChecks,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import './styles.css'

type Mode = 'generate' | 'edit' | 'text' | 'one-to-many'
type Page = 'workbench' | 'queue' | 'gallery' | 'prompts'

type PromptWindow = {
  id: number
  name: string
  prompt: string
  enabled: boolean
}

type PromptSelection = string

type PromptItem = {
  id: string
  title: string
  text: string
  category: string
  layout: string
}

type ChannelConfig = {
  baseUrl: string
  apiKey: string
}

type QueueStatus = 'queued' | 'running' | 'done' | 'review' | 'failed' | 'cancelled'

type QueueItem = {
  id: string
  title: string
  meta: string
  status: QueueStatus
  progress: number
  time: string
  resultCount?: number
  error?: string
  createdAt?: string
}

type GalleryAsset = {
  src: string
  title: string
  tag: string
  tone: string
  jobId?: string
}

type ApiJob = {
  id: string
  mode: string
  status: string
  progress?: number
  createdAt?: string
  updatedAt?: string
  layout?: string
  size?: string
  resolution?: string
  job?: ApiJob
  results?: Array<{ index: number }>
  error?: { message?: string }
}

type DashboardStats = {
  completed?: number
  running?: number
  review?: number
  failed?: number
  total?: number
  storageBytes?: number
  storageUsedGb?: number
  storageTotalGb?: number
}

type ApiErrorBody = {
  error?: { message?: string }
}

const LOCAL_API_BASE = 'http://127.0.0.1:8765'
const SELECTED_PROMPT_STORAGE_KEY = 'lingtu-selected-prompt'
const MAX_CONCURRENCY_STORAGE_KEY = 'lingtu-max-concurrency'
const DEFAULT_MAX_CONCURRENCY = 4
const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024
const SOURCE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const SIZE_OPTIONS = [
  { value: '3840 × 2160', label: '16:9' },
  { value: '1129 × 1254', label: '9:10' },
  { value: '1024 × 1024', label: '1:1' },
  { value: '1536 × 1024', label: '3:2' },
] as const
const ADVANCED_SETTINGS_STORAGE_KEY = 'lingtu-advanced-settings'
type AdvancedSettings = { layout: string; size: string; resolution: string; quality: string; repeat: number }
const DEFAULT_ADVANCED_SETTINGS: AdvancedSettings = { layout: '四宫格', size: '3840 × 2160', resolution: '1K', quality: '高', repeat: 1 }

function readStoredAdvancedSettings(): AdvancedSettings {
  try {
    const saved = window.localStorage.getItem(ADVANCED_SETTINGS_STORAGE_KEY)
    if (!saved) return { ...DEFAULT_ADVANCED_SETTINGS }
    const parsed = JSON.parse(saved) as Partial<AdvancedSettings>
    const layout = parsed.layout === '四宫格' || parsed.layout === '二宫格' || parsed.layout === '九宫格' ? parsed.layout : DEFAULT_ADVANCED_SETTINGS.layout
    const size = SIZE_OPTIONS.some((option) => option.value === parsed.size) ? parsed.size! : DEFAULT_ADVANCED_SETTINGS.size
    const resolution = parsed.resolution === '1K' || parsed.resolution === '2K' || parsed.resolution === '4K' ? parsed.resolution : DEFAULT_ADVANCED_SETTINGS.resolution
    const quality = parsed.quality === '高' || parsed.quality === '中' || parsed.quality === '自动' ? parsed.quality : DEFAULT_ADVANCED_SETTINGS.quality
    const repeat = typeof parsed.repeat === 'number' && Number.isFinite(parsed.repeat) ? Math.min(20, Math.max(1, Math.round(parsed.repeat))) : DEFAULT_ADVANCED_SETTINGS.repeat
    return { layout, size, resolution, quality, repeat }
  } catch {
    // 浏览器存储损坏或不可用时回退到稳定默认值，不阻塞工作台使用。
    return { ...DEFAULT_ADVANCED_SETTINGS }
  }
}

function readStoredMaxConcurrency(): number {
  try {
    const raw = window.localStorage.getItem(MAX_CONCURRENCY_STORAGE_KEY)
    if (!raw) return DEFAULT_MAX_CONCURRENCY
    const saved = Number(raw)
    return Number.isInteger(saved) ? Math.min(20, Math.max(1, saved)) : DEFAULT_MAX_CONCURRENCY
  } catch {
    return DEFAULT_MAX_CONCURRENCY
  }
}

function readStoredPromptId(): string {
  try {
    return window.localStorage.getItem(SELECTED_PROMPT_STORAGE_KEY)?.trim() ?? ''
  } catch {
    // 浏览器禁用本地存储时仍允许当前会话选择模板。
    return ''
  }
}

function storePromptId(id: string): void {
  try {
    window.localStorage.setItem(SELECTED_PROMPT_STORAGE_KEY, id)
  } catch {
    // 无痕模式等场景可能禁用存储，不影响当前页面使用。
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function isSupportedSourceImage(file: File): boolean {
  return SOURCE_IMAGE_TYPES.has(file.type) || /\.(png|jpe?g|webp)$/i.test(file.name)
}

function sourceFilePath(file: File): string {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
}

function summarizeSourceFiles(files: File[]): string {
  return files.length === 0 ? '未选择源图' : `已添加：${files.map(sourceFilePath).join('、')}`
}

function sourceFileKey(file: File): string {
  return `${sourceFilePath(file)}-${file.size}-${file.lastModified}`
}

function validateSourceFiles(fileList: FileList | null): { files: File[]; error?: string; skippedCount: number } {
  const selectedFiles = Array.from(fileList ?? [])
  const supportedFiles = selectedFiles.filter(isSupportedSourceImage)
  const files = supportedFiles.filter((file) => file.size <= MAX_SOURCE_IMAGE_BYTES)
  const skippedCount = selectedFiles.length - files.length
  if (files.length === 0) {
    const error = supportedFiles.length > 0 ? '所选图片均超过 8 MB' : '未找到 PNG、JPG 或 WEBP 图片'
    return { files: [], error, skippedCount }
  }
  // 目录选择返回相对路径，按路径排序后提交顺序稳定；多选文件仍保留选择器返回顺序。
  if (files.some((file) => sourceFilePath(file) !== file.name)) files.sort((a, b) => sourceFilePath(a).localeCompare(sourceFilePath(b), 'zh-CN'))
  return { files, skippedCount }
}

function formatToday(): string {
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replaceAll('/', '.')
}

function formatQueueCreatedAt(value?: string): string {
  if (!value) return '创建时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '创建时间未知'
  return `创建于 ${new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date).replaceAll('/', '-')}`
}

function formatLayoutLabel(layout?: string): string {
  switch (layout?.trim()) {
    case '4K 四宫格':
    case 'four_up':
      return '四宫格'
    case '1K 二宫格':
    case 'two_up':
      return '二宫格'
    case '4K 十五宫格（测试）':
    case 'fifteen_up_test':
      return '十五宫格'
    case 'nine_up':
      return '九宫格'
    default:
      return layout?.trim() || '四宫格'
  }
}

function formatSizeRatio(size?: string): string {
  return SIZE_OPTIONS.find((option) => option.value === size)?.label ?? size ?? '16:9'
}

function formatSizeAspectRatio(size?: string): string {
  return formatSizeRatio(size).replace(':', ' / ')
}

async function encodeFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

const modes: Array<{ id: Mode; label: string; detail: string }> = [
  { id: 'generate', label: '正常生图', detail: '提示词模板 · 快速生产' },
  { id: 'edit', label: '改图', detail: '多图/文件夹 · 并发修改' },
  { id: 'text', label: '文生图', detail: '无附件 · 独立尺寸' },
  { id: 'one-to-many', label: '一裂多', detail: '一张源图 · 多方向变体' },
]

const statusNames: Record<string, string> = {
  PASS: '可用',
  REVIEW: '待复核',
  BLOCK: '高风险',
  UNKNOWN: '待确认',
}

function assetsFromJob(job: ApiJob): GalleryAsset[] {
  if (job.status !== 'completed' || !Array.isArray(job.results)) return []
  const modeLabel = modes.find((item) => item.id === (job.mode === 'text_to_image' ? 'text' : job.mode))?.label ?? '生图'
  return job.results.map((result) => ({
    src: `${LOCAL_API_BASE}/api/jobs/${encodeURIComponent(job.id)}/results/${result.index}`,
    title: `${modeLabel} · ${job.id.slice(-8)} · ${String(result.index + 1).padStart(2, '0')}`,
    tag: 'PASS',
    tone: 'pass',
    jobId: job.id,
  }))
}

function App() {
  const [page, setPage] = useState<Page>('workbench')
  const [mode, setMode] = useState<Mode>('generate')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [running, setRunning] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [maxConcurrency, setMaxConcurrency] = useState(() => readStoredMaxConcurrency())
  const [channelConfig, setChannelConfig] = useState<ChannelConfig>(() => {
    try {
      const saved = window.localStorage.getItem('lingtu-channel-config')
      if (saved) {
        const parsed = JSON.parse(saved) as Partial<ChannelConfig>
        if (typeof parsed.baseUrl === 'string') {
          window.localStorage.setItem('lingtu-channel-config', JSON.stringify({ baseUrl: parsed.baseUrl }))
          return { baseUrl: parsed.baseUrl, apiKey: '' }
        }
      }
    } catch {
      // 本地存储不可用时回退到默认空配置。
    }
    return { baseUrl: 'https://api.example.com/v1', apiKey: '' }
  })
  const [prompts, setPrompts] = useState<PromptItem[]>([])
  const [promptsLoading, setPromptsLoading] = useState(true)
  const [promptsError, setPromptsError] = useState('')
  const [selectedPrompt, setSelectedPrompt] = useState<PromptSelection>(() => readStoredPromptId())
  const [textPrompt, setTextPrompt] = useState('')
  const [advancedSettings] = useState<AdvancedSettings>(() => readStoredAdvancedSettings())
  const [layout, setLayout] = useState(advancedSettings.layout)
  const [size, setSize] = useState(advancedSettings.size)
  const [resolution, setResolution] = useState(advancedSettings.resolution)
  const [quality, setQuality] = useState(advancedSettings.quality)
  const [repeat, setRepeat] = useState(advancedSettings.repeat)
  const [inputName, setInputName] = useState('未选择源图')
  const [sourceFiles, setSourceFiles] = useState<File[]>([])
  const [submissionProgress, setSubmissionProgress] = useState<{ current: number; total: number } | null>(null)
  const [promptWindows, setPromptWindows] = useState<PromptWindow[]>([])
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [galleryAssets, setGalleryAssets] = useState<GalleryAsset[]>([])
  const [galleryJobId, setGalleryJobId] = useState<string | null>(null)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [statsLoading, setStatsLoading] = useState(true)
  const [statsError, setStatsError] = useState('')
  const [serviceOnline, setServiceOnline] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const eventSourcesRef = useRef<Map<string, EventSource>>(new Map())

  useEffect(() => {
    try {
      window.localStorage.setItem(MAX_CONCURRENCY_STORAGE_KEY, String(maxConcurrency))
    } catch {
      // 存储不可用时保留当前会话的并发设置。
    }
  }, [maxConcurrency])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${LOCAL_API_BASE}/api/settings`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<{ maxConcurrency?: number }> : Promise.reject(new Error('settings unavailable')))
      .then((body) => {
        if (typeof body.maxConcurrency === 'number' && Number.isInteger(body.maxConcurrency)) {
          setMaxConcurrency(Math.min(20, Math.max(1, body.maxConcurrency)))
        }
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    // 高级参数属于本机工作偏好，实时保存后刷新页面仍恢复上次选择。
    try {
      window.localStorage.setItem(ADVANCED_SETTINGS_STORAGE_KEY, JSON.stringify({ layout, size, resolution, quality, repeat }))
    } catch {
      // 存储不可用时保留当前会话状态，不影响提交任务。
    }
  }, [layout, size, resolution, quality, repeat])

  useEffect(() => {
    const controller = new AbortController()
    // 仅探测本机 Node 服务，不把服务状态误报为“已连接”。
    fetch(`${LOCAL_API_BASE}/health`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('health check failed')))
      .then((body: { status?: string; service?: string }) => {
        setServiceOnline(body.status === 'ok' && body.service === 'lingtu-workbench')
      })
      .catch(() => setServiceOnline(false))
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${LOCAL_API_BASE}/api/provider`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() as Promise<{ baseUrl?: string }> : Promise.reject(new Error('provider config unavailable')))
      .then((body) => {
        if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) setChannelConfig((current) => ({ ...current, baseUrl: body.baseUrl!.trim() }))
      })
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setPromptsLoading(true)
    setPromptsError('')
    fetch(`${LOCAL_API_BASE}/api/prompts`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('提示词接口不可用')))
      .then((body: unknown) => {
        const rawItems = Array.isArray(body) ? body : body && typeof body === 'object' && Array.isArray((body as { items?: unknown }).items) ? (body as { items: unknown[] }).items : []
        const items = rawItems.flatMap((value, index) => {
          if (!value || typeof value !== 'object') return []
          const item = value as Record<string, unknown>
          const text = typeof item.text === 'string' ? item.text : typeof item.prompt === 'string' ? item.prompt : ''
          const title = typeof item.title === 'string' ? item.title : typeof item.name === 'string' ? item.name : `提示词 ${index + 1}`
          const id = item.id === undefined || item.id === null ? `prompt-${index + 1}` : String(item.id)
          if (!text.trim()) return []
          return [{ id, title, text, category: typeof item.category === 'string' ? item.category : '未分类', layout: typeof item.layout === 'string' ? item.layout : '' }]
        })
        setPrompts(items)
        if (items.length > 0) {
          const first = items.find((item) => item.layout.includes('four') || item.layout.includes('四')) ?? items[0]
          const storedId = readStoredPromptId()
          const selectedId = items.some((item) => item.id === storedId) ? storedId : first.id
          const selectedItem = items.find((item) => item.id === selectedId) ?? first
          setSelectedPrompt(selectedId)
          setTextPrompt(selectedItem.text)
          storePromptId(selectedId)
          setPromptWindows(items.slice(0, 2).map((item, index) => ({ id: index + 1, name: item.title, prompt: item.text, enabled: true })))
        } else {
          setSelectedPrompt('')
          setTextPrompt('')
          setPromptWindows([])
        }
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setPrompts([])
        setSelectedPrompt('')
        setTextPrompt('')
        setPromptWindows([])
        setPromptsError(error instanceof Error ? error.message : '提示词加载失败')
      })
      .finally(() => setPromptsLoading(false))
    return () => controller.abort()
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setStatsLoading(true)
    setStatsError('')
    fetch(`${LOCAL_API_BASE}/api/stats`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('统计接口不可用')))
      .then((body: unknown) => {
        const source = body && typeof body === 'object' && body !== null && 'data' in body && body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : body as Record<string, unknown>
        const numberValue = (...keys: string[]) => { const value = keys.map((key) => source?.[key]).find((item) => typeof item === 'number'); return typeof value === 'number' ? value : undefined }
        setStats({
          completed: numberValue('completed', 'completedToday', 'todayCompleted'),
          running: numberValue('running', 'runningJobs', 'activeJobs'),
          review: numberValue('review', 'pendingReview', 'reviewCount'),
          failed: numberValue('failed'),
          total: numberValue('total'),
          storageBytes: numberValue('storageBytes'),
        })
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        setStats(null)
        setStatsError(error instanceof Error ? error.message : '统计加载失败')
      })
      .finally(() => setStatsLoading(false))
    return () => controller.abort()
  }, [])

  useEffect(() => () => {
    eventSourcesRef.current.forEach((source) => source.close())
    eventSourcesRef.current.clear()
  }, [])

  const activeMode = modes.find((item) => item.id === mode) ?? modes[0]
  const selectedPromptItem = prompts.find((item) => item.id === selectedPrompt)
  const enabledWindows = promptWindows.filter((item) => item.enabled && item.prompt.trim())
  const pageTitle = useMemo(() => {
    const titles: Record<Page, string> = {
      workbench: '生产工作台',
      queue: '任务队列',
      gallery: '生成画廊',
      prompts: '提示词库',
    }
    return titles[page]
  }, [page])

  const handlePromptSelect = (id: PromptSelection) => {
    const item = prompts.find((prompt) => prompt.id === id)
    setSelectedPrompt(id)
    storePromptId(id)
    if (item) setTextPrompt(item.text)
  }

  const saveWorkspaceConfig = async (config: ChannelConfig, nextMaxConcurrency: number) => {
    if (config.apiKey.trim()) {
      const response = await fetch(`${LOCAL_API_BASE}/api/provider`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: config.baseUrl.trim(), apiKey: config.apiKey }),
      })
      const body = await response.json() as ApiErrorBody & { baseUrl?: string }
      if (!response.ok) throw new Error(body.error?.message || 'Provider 配置保存失败')
      // 保存成功后清空前端内存副本，后续任务由本地服务读取已保存配置。
      setChannelConfig({ baseUrl: config.baseUrl, apiKey: '' })
      try {
        // 只记住地址，API Key 由本地服务保存，避免写入浏览器存储。
        window.localStorage.setItem('lingtu-channel-config', JSON.stringify({ baseUrl: config.baseUrl }))
      } catch {
        // 无痕模式等场景可能禁用存储，仍保留当前会话配置。
      }
    }
    const settingsResponse = await fetch(`${LOCAL_API_BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConcurrency: nextMaxConcurrency }),
    })
    const settingsBody = await settingsResponse.json() as ApiErrorBody & { maxConcurrency?: number }
    if (!settingsResponse.ok || typeof settingsBody.maxConcurrency !== 'number') throw new Error(settingsBody.error?.message || '并发设置保存失败')
    setMaxConcurrency(settingsBody.maxConcurrency)
  }

  const updateQueueFromJob = (job: ApiJob) => {
    const status = job.status === 'completed' || job.status === 'done'
      ? 'done'
      : job.status === 'failed' || job.status === 'error'
        ? 'failed'
        : job.status === 'review'
          ? 'review'
          : job.status === 'cancelled'
            ? 'cancelled'
            : job.status === 'running'
              ? 'running'
              : 'queued'
    const progress = typeof job.progress === 'number'
      ? job.progress
      : status === 'done' || status === 'review' ? 100 : status === 'queued' ? 0 : status === 'failed' ? 44 : 8
    const time = status === 'done'
      ? `完成于 ${new Date(job.updatedAt ?? Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
      : status === 'failed'
        ? '提交失败'
        : status === 'cancelled'
          ? '已取消'
          : status === 'queued'
            ? '已进入队列'
            : '运行中'
    const title = `${modes.find((item) => item.id === (job.mode === 'text_to_image' ? 'text' : job.mode))?.label ?? '生图'} · 新任务`
    const item: QueueItem = {
      id: job.id,
      title,
      // 队列仅展示可公开的任务摘要，provider.apiKey 永不写入队列状态。
      meta: `${job.mode === 'one_to_many' ? enabledWindows.length : 1} 个任务项 · ${formatLayoutLabel(job.layout ?? layout)}${job.resolution ? ` · ${job.resolution}` : ''}${job.error?.message ? ` · ${job.error.message}` : ''}`,
      status,
      progress,
      time,
      createdAt: job.createdAt,
      resultCount: Array.isArray(job.results) ? job.results.length : undefined,
      ...(job.error?.message ? { error: job.error.message } : {}),
    }
    setQueue((items) => [item, ...items.filter((existing) => existing.id !== job.id)])
    if (status === 'done' && Array.isArray(job.results)) {
      const newAssets = assetsFromJob(job)
      setGalleryAssets((items) => [...newAssets, ...items.filter((asset) => !newAssets.some((next) => next.src === asset.src))])
    }
    return status
  }

  const refreshQueue = async () => {
    try {
      const response = await fetch(`${LOCAL_API_BASE}/api/jobs`)
      if (!response.ok) {
        // 服务失败时清空本地投影，避免把旧的演示或过期任务继续展示给用户。
        setQueue([])
        setGalleryAssets([])
        return
      }
      const body = await response.json() as { items?: ApiJob[] }
      if (!Array.isArray(body.items)) {
        setQueue([])
        setGalleryAssets([])
        return
      }
      const completedAssets = body.items.flatMap(assetsFromJob)
      setGalleryAssets(completedAssets)
      setQueue((previous) => body.items!.map((job) => {
        const previousItem = previous.find((item) => item.id === job.id)
        const status: QueueStatus = job.status === 'completed' ? 'done' : job.status === 'failed' ? 'failed' : job.status === 'cancelled' ? 'cancelled' : job.status === 'review' ? 'review' : job.status === 'running' ? 'running' : 'queued'
        // 服务端列表接口可能暂时没有进度字段；运行中任务沿用本地已知进度，避免刷新时回退到 0%。
        const progress = status === 'done'
          ? 100
          : status === 'running'
            ? Math.max(job.progress ?? 0, previousItem?.progress ?? 0)
            : job.progress ?? (status === 'queued' ? 0 : previousItem?.progress ?? 0)
        return {
          id: job.id,
          title: `${modes.find((item) => item.id === (job.mode === 'text_to_image' ? 'text' : job.mode))?.label ?? '生图'} · 任务`,
          meta: `${job.mode === 'one_to_many' ? enabledWindows.length : 1} 个任务项 · ${formatLayoutLabel(job.layout ?? layout)}${job.resolution ? ` · ${job.resolution}` : ''}${job.error?.message ? ` · ${job.error.message}` : ''}`,
          status,
          progress,
          time: job.status === 'completed' ? '已完成' : job.status === 'failed' ? '失败' : job.status === 'cancelled' ? '已取消' : '进行中',
          createdAt: job.createdAt,
          resultCount: Array.isArray(job.results) ? job.results.length : undefined,
          ...(job.error?.message ? { error: job.error.message } : {}),
        } satisfies QueueItem
      }))
    } catch {
      // 本地服务未启动时清空投影，空态比伪造或保留旧任务更准确。
      setQueue([])
      setGalleryAssets([])
    }
  }

  const refreshStats = async () => {
    try {
      const response = await fetch(`${LOCAL_API_BASE}/api/stats`)
      if (response.ok) setStats(await response.json() as DashboardStats)
    } catch {
      // 统计刷新失败时保留当前已知值，避免任务队列被统计接口拖断。
    }
  }

  const refreshWorkbench = async () => {
    await Promise.all([refreshQueue(), refreshStats()])
  }

  const cancelJob = async (jobId: string) => {
    try {
      const response = await fetch(`${LOCAL_API_BASE}/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
      if (response.ok) updateQueueFromJob(await response.json() as ApiJob)
    } catch {
      setSubmitError('取消任务失败，请检查本地服务状态')
    }
  }

  const openJobResults = (jobId: string) => {
    // 任务结果通过画廊统一查看，并保留任务 ID 作为可见筛选上下文。
    setGalleryJobId(jobId)
    setPage('gallery')
  }

  const navigateTo = (nextPage: Page) => {
    if (nextPage !== 'gallery') setGalleryJobId(null)
    setPage(nextPage)
  }

  useEffect(() => {
    void refreshQueue()
  }, [])

  const readJobDetail = async (jobId: string): Promise<ApiJob | undefined> => {
    try {
      const response = await fetch(`${LOCAL_API_BASE}/api/jobs/${encodeURIComponent(jobId)}`)
      const body = await response.json() as ApiJob | ApiErrorBody
      if (!response.ok || !('id' in body)) return undefined
      updateQueueFromJob(body)
      return body
    } catch {
      return undefined
    }
  }

  const subscribeJob = (jobId: string): Promise<QueueStatus> => new Promise((resolve) => {
    let settled = false
    const settle = (status: QueueStatus) => {
      if (settled) return
      settled = true
      resolve(status)
    }
    eventSourcesRef.current.get(jobId)?.close()
    const source = new EventSource(`${LOCAL_API_BASE}/api/jobs/${encodeURIComponent(jobId)}/events`)
    eventSourcesRef.current.set(jobId, source)
    const handleEvent = (event: Event) => {
      try {
        const body = JSON.parse((event as MessageEvent<string>).data) as ApiJob & { completed?: number; total?: number }
        const eventJob = body.job ?? body
        if (!eventJob.id) return
        const status = updateQueueFromJob({ ...eventJob, progress: body.total ? Math.round((body.completed ?? 0) / body.total * 100) : eventJob.progress })
        void refreshStats()
        if (status === 'done' || status === 'review' || status === 'failed' || status === 'cancelled') {
          source.close()
          if (eventSourcesRef.current.get(jobId) === source) eventSourcesRef.current.delete(jobId)
          settle(status)
        }
      } catch {
        // 事件数据异常时交给详情接口回读，不让前端任务状态卡死。
      }
    }
    ;['snapshot', 'progress', 'completed', 'failed', 'job.created', 'job.progress', 'job.item.updated', 'job.completed', 'job.error'].forEach((eventName) => {
      source.addEventListener(eventName, handleEvent)
    })
    source.onerror = () => {
      source.close()
      if (eventSourcesRef.current.get(jobId) === source) eventSourcesRef.current.delete(jobId)
      // SSE 断开时轮询任务详情，确保并发 worker 只在当前任务结束后领取下一张。
      const poll = async () => {
        const detail = await readJobDetail(jobId)
        const status = detail ? updateQueueFromJob(detail) : undefined
        if (status === 'done' || status === 'review' || status === 'failed' || status === 'cancelled') {
          settle(status)
          return
        }
        window.setTimeout(() => void poll(), 800)
      }
      void poll()
    }
  })

  const startJob = async () => {
    if (running) return
    setSubmitError('')
    if (mode === 'edit' && sourceFiles.length === 0) {
      setSubmitError('请先选择至少一张源图后再开始改图')
      return
    }
    const prompt = mode === 'one-to-many' ? enabledWindows[0]?.prompt.trim() ?? '' : textPrompt.trim() || selectedPromptItem?.text || ''
    if (!prompt) {
      setSubmitError('请输入提示词后再开始任务')
      return
    }
    setRunning(true)
    setSubmissionProgress(mode === 'edit' ? { current: 0, total: sourceFiles.length } : null)
    try {
      const filesToSubmit: Array<File | undefined> = mode === 'edit' ? sourceFiles : [undefined]
      let submittedCount = 0
      let failedCount = 0
      let firstError = ''
      const submitOne = async (file: File | undefined, index: number) => {
        try {
          const sourceImage = mode === 'edit' && file
            ? { data: await encodeFile(file), mimeType: file.type, name: file.name }
            : undefined
          const response = await fetch(`${LOCAL_API_BASE}/api/jobs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              mode: mode === 'text' ? 'text_to_image' : mode,
              prompt,
              textPrompt: textPrompt.trim(),
              windows: mode === 'one-to-many' ? enabledWindows.map(({ id, name, prompt: windowPrompt, enabled }) => ({ id, name, prompt: windowPrompt.trim(), enabled })) : undefined,
              layout,
              size,
              resolution,
              quality,
              repeat,
              sourceImage,
              provider: {
                baseUrl: channelConfig.baseUrl.trim(),
                ...(channelConfig.apiKey.trim() ? { apiKey: channelConfig.apiKey } : {}),
              },
              idempotencyKey: `lingtu-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
            }),
          })
          const body = await response.json() as ApiJob | ApiErrorBody
          if (!response.ok || !('id' in body)) {
            throw new Error(('error' in body && body.error?.message) || '本地服务拒绝了任务提交')
          }
          updateQueueFromJob(body)
          void refreshStats()
          // 所有图片先独立提交并持久化，后端调度器负责排队和并发执行；页面关闭不影响已提交任务。
          void subscribeJob(body.id)
          void readJobDetail(body.id)
        } catch (error) {
          failedCount += 1
          if (!firstError) firstError = error instanceof Error ? error.message : '任务提交失败，请检查本地服务状态'
        } finally {
          submittedCount += 1
          if (mode === 'edit') setSubmissionProgress({ current: submittedCount, total: filesToSubmit.length })
        }
      }
      // Promise.all 只负责并行发起提交，不等待 Provider 完成，执行生命周期完全交给后端。
      await Promise.all(filesToSubmit.map((file, index) => submitOne(file, index)))
      if (failedCount > 0) setSubmitError(`${firstError}；本批次有 ${failedCount} 张图片失败，请查看任务队列`)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : '任务提交失败，请检查本地服务状态')
    } finally {
      setRunning(false)
      setSubmissionProgress(null)
    }
  }

  const addPromptWindow = () => {
    setPromptWindows((items) => [...items, { id: Date.now(), name: `新窗口 ${items.length + 1}`, prompt: '', enabled: true }])
  }

  const updatePromptWindow = (id: number, patch: Partial<PromptWindow>) => {
    setPromptWindows((items) => items.map((item) => item.id === id ? { ...item, ...patch } : item))
  }

  const navItems: Array<{ id: Page; label: string; icon: typeof LayoutGrid; badge?: string }> = [
    { id: 'workbench', label: '生产工作台', icon: LayoutGrid },
    { id: 'queue', label: '任务队列', icon: ListChecks, badge: `${queue.filter((item) => item.status === 'running').length}` },
    { id: 'gallery', label: '生成画廊', icon: GalleryHorizontalEnd },
    { id: 'prompts', label: '提示词库', icon: BookOpen },
  ]

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
        <div className="brand-lockup">
          <div className="brand-mark"><Sparkles size={17} /></div>
          {sidebarOpen && <div><div className="brand-name">灵图工作台</div><div className="brand-caption">本地图片生产工作台</div></div>}
        </div>
        <div className="workspace-switcher">
          <div className="workspace-icon" aria-hidden="true"><Sparkles size={16} /></div>
          {sidebarOpen && <><div className="workspace-copy"><strong>本地工作区</strong><span>默认空间</span></div><ChevronDown size={15} className="muted-icon" /></>}
        </div>
        <div className="nav-section-label">工作台</div>
        <nav className="main-nav" aria-label="主导航">
          {navItems.map((item) => {
            const Icon = item.icon
            return <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => navigateTo(item.id)} title={item.label}>
              <Icon size={18} strokeWidth={1.8} /><span>{sidebarOpen && item.label}</span>{sidebarOpen && item.badge && <span className="nav-badge">{item.badge}</span>}
            </button>
          })}
        </nav>
        <div className="sidebar-bottom">
          {sidebarOpen && <div className="storage-meter"><div className="storage-line"><span>结果文件</span><span>{statsLoading ? '加载中' : formatBytes(stats?.storageBytes ?? 0)}</span></div><div className="meter"><i style={{ width: stats ? '100%' : '0%' }} /></div></div>}
          <button className="nav-item" onClick={() => setShowSettings(true)} title="设置"><Settings2 size={18} /><span>{sidebarOpen && '设置'}</span></button>
          <button className="nav-item" onClick={() => setSidebarOpen((open) => !open)} title={sidebarOpen ? '收起侧栏' : '展开侧栏'}>{sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}<span>{sidebarOpen && '收起侧栏'}</span></button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>本地工作区</span><span className="crumb-slash">/</span><strong>{pageTitle}</strong></div>
          <div className="topbar-actions">
            <div className="connection-status"><span className={`status-dot ${serviceOnline ? '' : 'offline'}`} />{serviceOnline ? '本地服务已连接' : '本地服务未启动'}</div>
            <div className="avatar">M</div>
          </div>
        </header>

        {page === 'workbench' && <Workbench mode={mode} setMode={setMode} activeMode={activeMode} layout={layout} setLayout={setLayout} size={size} setSize={setSize} resolution={resolution} setResolution={setResolution} quality={quality} setQuality={setQuality} repeat={repeat} setRepeat={setRepeat} inputName={inputName} setInputName={setInputName} sourceFiles={sourceFiles} setSourceFiles={setSourceFiles} submissionProgress={submissionProgress} selectedPrompt={selectedPrompt} selectedPromptItem={selectedPromptItem} prompts={prompts} promptsLoading={promptsLoading} promptsError={promptsError} textPrompt={textPrompt} setTextPrompt={setTextPrompt} setSelectedPrompt={handlePromptSelect} promptWindows={promptWindows} updatePromptWindow={updatePromptWindow} addPromptWindow={addPromptWindow} enabledWindows={enabledWindows} running={running} startJob={startJob} queue={queue} galleryAssets={galleryAssets} stats={stats} statsLoading={statsLoading} statsError={statsError} serviceOnline={serviceOnline} channelConfig={channelConfig} submitError={submitError} onRefresh={refreshWorkbench} onNavigate={navigateTo} onViewResults={openJobResults} />}
        {page === 'queue' && <QueuePage queue={queue} setQueue={setQueue} onRefresh={refreshQueue} onCancel={cancelJob} onCreate={() => { navigateTo('workbench'); window.scrollTo({ top: 0, behavior: 'smooth' }) }} onViewResults={openJobResults} />}
        {page === 'gallery' && <GalleryPage assets={galleryAssets} focusJobId={galleryJobId} onClearFocus={() => setGalleryJobId(null)} />}
        {page === 'prompts' && <ApiPromptsPage prompts={prompts} loading={promptsLoading} error={promptsError} selectedPrompt={selectedPrompt} setSelectedPrompt={handlePromptSelect} />}
      </main>

      {showSettings && <SettingsModal config={channelConfig} maxConcurrency={maxConcurrency} onSave={saveWorkspaceConfig} onClose={() => setShowSettings(false)} />}
    </div>
  )
}

type WorkbenchProps = {
  mode: Mode
  setMode: (mode: Mode) => void
  activeMode: { id: Mode; label: string; detail: string }
  layout: string
  setLayout: (value: string) => void
  size: string
  setSize: (value: string) => void
  resolution: string
  setResolution: (value: string) => void
  quality: string
  setQuality: (value: string) => void
  repeat: number
  setRepeat: (value: number) => void
  inputName: string
  setInputName: (value: string) => void
  sourceFiles: File[]
  setSourceFiles: (value: File[]) => void
  submissionProgress: { current: number; total: number } | null
  selectedPrompt: PromptSelection
  selectedPromptItem?: PromptItem
  prompts: PromptItem[]
  promptsLoading: boolean
  promptsError: string
  textPrompt: string
  setTextPrompt: (value: string) => void
  setSelectedPrompt: (value: PromptSelection) => void
  promptWindows: PromptWindow[]
  updatePromptWindow: (id: number, patch: Partial<PromptWindow>) => void
  addPromptWindow: () => void
  enabledWindows: PromptWindow[]
  running: boolean
  startJob: () => void | Promise<void>
  queue: QueueItem[]
  galleryAssets: GalleryAsset[]
  stats: DashboardStats | null
  statsLoading: boolean
  statsError: string
  serviceOnline: boolean
  channelConfig: ChannelConfig
  submitError: string
  onRefresh: () => Promise<void>
  onNavigate: (page: Page) => void
  onViewResults: (jobId: string) => void
}

function Workbench(props: WorkbenchProps) {
  const { mode, setMode, activeMode, layout, setLayout, size, setSize, resolution, setResolution, quality, setQuality, repeat, setRepeat, inputName, setInputName, sourceFiles, setSourceFiles, submissionProgress, selectedPrompt, selectedPromptItem, prompts, promptsLoading, promptsError, textPrompt, setTextPrompt, setSelectedPrompt, promptWindows, updatePromptWindow, addPromptWindow, enabledWindows, running, startJob, queue, galleryAssets, stats, statsLoading, statsError, serviceOnline, channelConfig, submitError, onRefresh, onNavigate, onViewResults } = props
  const [showAdvanced, setShowAdvanced] = useState(true)
  const [feedback, setFeedback] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const statValue = (value: number | undefined) => statsLoading ? '...' : value === undefined ? '--' : String(value)
  const storageText = statsLoading ? '...' : formatBytes(stats?.storageBytes ?? 0)
  const healthScore = serviceOnline && stats ? 100 : 0
  const today = formatToday()
  const previewCount = layout === '二宫格' ? 2 : layout === '九宫格' ? 9 : 4
  const sourceTotalBytes = sourceFiles.reduce((total, file) => total + file.size, 0)
  const handleSourceSelection = (fileList: FileList | null) => {
    const result = validateSourceFiles(fileList)
    if (result.error) {
      setSourceFiles([])
      setInputName(result.error)
      return
    }
    setSourceFiles(result.files)
    setInputName(summarizeSourceFiles(result.files))
    setFeedback(result.skippedCount > 0 ? `已添加 ${result.files.length} 张，跳过 ${result.skippedCount} 个不符合要求的文件` : `已添加 ${result.files.length} 张候选图片`)
  }
  const removeSourceFile = (target: File) => {
    const nextFiles = sourceFiles.filter((file) => file !== target)
    setSourceFiles(nextFiles)
    setInputName(summarizeSourceFiles(nextFiles))
    setFeedback(`已移除 ${sourceFilePath(target)}`)
  }
  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(''), 2400)
    return () => window.clearTimeout(timer)
  }, [feedback])

  const copyPrompt = async () => {
    if (!selectedPromptItem) return
    try {
      await navigator.clipboard.writeText(selectedPromptItem.text)
      setFeedback('提示词已复制')
    } catch {
      setFeedback('复制失败，请检查浏览器权限')
    }
  }

  const refreshStatus = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const minimumAnimation = new Promise<void>((resolve) => window.setTimeout(resolve, 700))
      await Promise.all([onRefresh(), minimumAnimation])
      setFeedback('状态已刷新')
    } finally {
      setRefreshing(false)
    }
  }

  const openRecentAsset = (image: GalleryAsset) => {
    window.open(image.src, '_blank', 'noopener,noreferrer')
    setFeedback(`已打开：${image.title}`)
  }

  return <div className="page-content workbench-page">
    <section className="page-heading heading-row">
      <div><div className="eyebrow"><span className="eyebrow-line" />今日生产 <span className="mono">{today}</span></div><h1>开始一轮新的生产</h1><p>从源图、模板到合规归档，在一个本地工作区完成闭环。</p></div>
      <div className="heading-actions"><button className="button button-ghost" onClick={() => void refreshStatus()} disabled={refreshing} aria-busy={refreshing}><RefreshCw size={16} className={refreshing ? 'refreshing-icon' : ''} />{refreshing ? '刷新中…' : '刷新状态'}</button></div>
    </section>

    <section className="metrics-grid">
      <MetricCard label="已完成任务" value={statValue(stats?.completed)} unit="批" change="本地数据库" icon={<CheckCircle2 size={18} />} tone="green" />
      <MetricCard label="运行中任务" value={statValue(stats?.running)} unit="批" change="本地数据库" icon={<LoaderCircle size={18} />} tone="orange" />
      <MetricCard label="待处理任务" value={statValue(stats?.review)} unit="项" change="本地数据库" icon={<ListChecks size={18} />} tone="purple" />
      <MetricCard label="结果文件" value={storageText} unit="" change="工作区实际文件" icon={<Archive size={18} />} tone="blue" />
    </section>
    {statsError && <div className="form-error stats-error" role="status"><AlertTriangle size={14} />{statsError}，工作台统计暂不可用</div>}

    <section className="workbench-layout">
      <div className="composer-panel panel">
        <div className="panel-heading"><div><span className="section-kicker">01 / 工作流</span><h2>选择生产模式</h2></div></div>
        <div className="mode-tabs" role="tablist" aria-label="生产模式">
          {modes.map((item) => <button key={item.id} className={`mode-tab ${mode === item.id ? 'active' : ''}`} onClick={() => setMode(item.id)} role="tab" aria-selected={mode === item.id}><span>{item.label}</span><small>{item.detail}</small></button>)}
        </div>

        {/* 普通生图只提交提示词和高级参数；源图输入仅用于改图与一裂多。 */}
        {(mode === 'edit' || mode === 'one-to-many') && <div className="field-block"><div className="field-label"><div><label htmlFor="source-input">{mode === 'edit' ? '源图附件' : '裂变源图'}</label><span className="field-required">必填</span></div>{mode === 'edit' && sourceFiles.length > 0 && <span className="field-hint">{sourceFiles.length} 张 · {formatBytes(sourceTotalBytes)}</span>}</div><div className={`dropzone ${sourceFiles.length > 0 ? 'has-file' : ''}`}><input id="source-input" type="file" hidden accept="image/png,image/jpeg,image/webp" multiple disabled={running} onChange={(event) => { handleSourceSelection(event.target.files); event.currentTarget.value = '' }} /><input id="source-folder-input" type="file" hidden accept="image/png,image/jpeg,image/webp" multiple disabled={running} ref={(node) => { node?.setAttribute('webkitdirectory', ''); node?.setAttribute('directory', '') }} onChange={(event) => { handleSourceSelection(event.target.files); event.currentTarget.value = '' }} /><div className="dropzone-icon"><CloudUpload size={19} /></div><div className="dropzone-copy"><strong title={inputName}>{inputName}</strong><span>{mode === 'edit' ? '支持 PNG / JPG / WEBP，单张不超过 8 MB；可多选或选择文件夹' : '拖拽图片至此，或点击选择本地图片'}</span></div>{mode === 'edit' && <label className="button button-small button-dark" htmlFor="source-folder-input"><FolderOpen size={14} />文件夹</label>}<label className="button button-small button-dark" htmlFor="source-input"><Images size={14} />图片</label></div>{mode === 'edit' && sourceFiles.length > 0 && <div className="source-file-list" aria-label="候选源图"><div className="source-file-list-heading"><strong>候选图片</strong><span>按以下顺序进入队列</span></div><div className="source-file-items">{sourceFiles.map((file, index) => <div className="source-file-chip" key={sourceFileKey(file)} title={sourceFilePath(file)}><FileImage size={14} /><span className="source-file-name">{index + 1}. {sourceFilePath(file)}</span><button className="source-file-remove" type="button" title={`移除 ${sourceFilePath(file)}`} aria-label={`移除候选图片 ${sourceFilePath(file)}`} disabled={running} onClick={() => removeSourceFile(file)}><X size={14} /></button></div>)}</div></div>}</div>}

        {mode === 'text' && <div className="field-block"><div className="field-label"><label htmlFor="text-prompt">创作描述</label><span className="field-required">必填</span></div><textarea id="text-prompt" className="prompt-editor" value={textPrompt} onChange={(event) => setTextPrompt(event.target.value)} /></div>}

        {mode === 'one-to-many' ? <div className="field-block one-to-many-block"><div className="field-label"><div><label>一裂多提示词窗口</label><span className="field-hint">已启用 {enabledWindows.length} 个</span></div><button className="button button-small button-ghost" onClick={addPromptWindow}><Plus size={14} />添加窗口</button></div><div className="prompt-window-list">{promptWindows.map((item, index) => <div className={`prompt-window ${item.enabled ? 'enabled' : ''}`} key={item.id}><div className="window-grip"><GripVertical size={15} /></div><button className={`toggle ${item.enabled ? 'on' : ''}`} onClick={() => updatePromptWindow(item.id, { enabled: !item.enabled })} aria-label={`${item.name} ${item.enabled ? '已启用' : '未启用'}`}><span /></button><div className="window-fields"><input aria-label={`窗口 ${index + 1} 名称`} value={item.name} onChange={(event) => updatePromptWindow(item.id, { name: event.target.value })} /><textarea aria-label={`${item.name}提示词`} placeholder="输入这个方向的提示词" value={item.prompt} onChange={(event) => updatePromptWindow(item.id, { prompt: event.target.value })} /></div><button className="icon-button danger-icon" title="删除窗口" aria-label={`删除窗口 ${item.name}`} onClick={() => updatePromptWindow(item.id, { prompt: '', enabled: false })}><Trash2 size={15} /></button></div>)}</div>{enabledWindows.length < 2 && <div className="inline-warning"><AlertTriangle size={14} />至少启用两个非空窗口后才能开始</div>}</div> : <div className="field-block"><div className="field-label"><label htmlFor="template-select">提示词模板</label><button className="text-link" onClick={() => onNavigate('prompts')} disabled={promptsLoading || prompts.length === 0}>浏览全部 <ArrowUpRight size={13} /></button></div><div className="select-wrap"><select id="template-select" value={selectedPrompt} onChange={(event) => setSelectedPrompt(event.target.value)} disabled={promptsLoading || prompts.length === 0}><option value="">{promptsLoading ? '提示词加载中…' : promptsError ? '提示词加载失败' : '暂无可用提示词'}</option>{prompts.map((item) => <option key={item.id} value={item.id}>{item.category} · {item.title}</option>)}</select><ChevronDown size={16} /></div><div className="prompt-preview"><span className="prompt-type">{mode === 'text' ? '文字' : '图片'} / 模板</span><p>{selectedPromptItem ? `${selectedPromptItem.text.slice(0, 320)}${selectedPromptItem.text.length > 320 ? '…' : ''}` : promptsLoading ? '提示词加载中…' : promptsError ? '提示词暂时无法加载，请检查本地服务。' : '后端暂无可用提示词。'}</p><button className="icon-button subtle" title="复制提示词" aria-label="复制提示词" onClick={() => void copyPrompt()} disabled={!selectedPromptItem}><Copy size={15} /></button></div>{promptsError && <div className="form-error" role="status"><AlertTriangle size={14} />{promptsError}</div>}</div>}

        <div className="settings-divider"><button className="advanced-trigger" onClick={() => setShowAdvanced((open) => !open)} aria-expanded={showAdvanced}><SlidersHorizontal size={15} />高级参数 <span>默认生产规范</span><ChevronDown size={15} className={showAdvanced ? 'rotate-180' : ''} /></button></div>
        {showAdvanced && <div className="settings-grid"><div className="compact-field"><label htmlFor="layout-select">输出布局</label><div className="select-wrap"><select id="layout-select" value={layout} onChange={(event) => setLayout(event.target.value)}><option>四宫格</option><option>二宫格</option><option>九宫格</option></select><ChevronDown size={15} /></div></div><div className="compact-field"><label htmlFor="size-select">长宽比例</label><div className="select-wrap"><select id="size-select" value={size} onChange={(event) => setSize(event.target.value)}>{SIZE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDown size={15} /></div></div><div className="compact-field"><label htmlFor="resolution-select">分辨率</label><div className="select-wrap"><select id="resolution-select" value={resolution} onChange={(event) => setResolution(event.target.value)}><option>1K</option><option>2K</option><option>4K</option></select><ChevronDown size={15} /></div></div><div className="compact-field"><label htmlFor="quality-select">质量</label><div className="select-wrap"><select id="quality-select" value={quality} onChange={(event) => setQuality(event.target.value)}><option>高</option><option>中</option><option>自动</option></select><ChevronDown size={15} /></div></div><div className="compact-field"><label htmlFor="repeat-input">重复次数</label><div className="number-control"><input id="repeat-input" type="number" min="1" max="20" value={repeat} onChange={(event) => setRepeat(Math.min(20, Math.max(1, Number(event.target.value) || 1)))} /><span>次</span></div></div></div>}
        <div className="composer-footer"><div className="footer-note"><span className="secure-icon"><ShieldCheck size={14} /></span>默认通道已配置 <span className="mono">· 仅保存在本机</span>{submitError && <span className="form-error" role="alert"><AlertTriangle size={14} />{submitError}</span>}{submissionProgress && <span className="submit-progress" role="status">已提交 {submissionProgress.current} / {submissionProgress.total} 张，后端并发处理中</span>}</div><button className="button button-primary start-button" onClick={startJob} disabled={running || (mode === 'one-to-many' && enabledWindows.length < 2)}>{running ? <><LoaderCircle size={16} className="spin" />{mode === 'edit' ? '批量提交中' : '创建任务中'}</> : <><Play size={16} fill="currentColor" />开始{activeMode.label}<ArrowUpRight size={16} /></>}</button></div>
      </div>

      <div className="preview-column"><div className="preview-panel panel"><div className="panel-heading"><div><span className="section-kicker">02 / 预览</span><h2>版式预览</h2></div><div aria-hidden="true" /></div><div className={`layout-preview ${layout === '二宫格' ? 'layout-two' : layout === '九宫格' ? 'layout-nine' : ''}`} style={{ aspectRatio: formatSizeAspectRatio(size) }}>{Array.from({ length: previewCount }, (_, index) => <div className={`preview-cell cell-${String.fromCharCode(97 + index)}`} key={String.fromCharCode(65 + index)}><span>{String.fromCharCode(65 + index)}</span><small>{index === 0 ? '主视觉区域' : index === 1 ? '卖点信息区域' : '细节变体'}</small></div>)}</div><div className="preview-caption"><div><strong>{layout}</strong><span>安全区已锁定 · 不跨格 · 不拉伸</span></div><span className="ratio">{formatSizeRatio(size)}</span></div></div><div className="quick-panel panel"><div className="quick-heading"><span>最近使用</span><button className="text-link" onClick={() => onNavigate('gallery')}>查看全部 <ArrowUpRight size={13} /></button></div><div className="recent-row">{galleryAssets.slice(0, 4).map((image) => <button key={image.title} className="recent-thumb" title={`打开 ${image.title}`} aria-label={`打开 ${image.title}`} onClick={() => openRecentAsset(image)}><img src={image.src} alt={image.title} /><span className={`mini-status ${image.tone}`} /></button>)}{galleryAssets.length === 0 && <span className="empty-inline">暂无生成结果</span>}</div></div></div>
    </section>

    <section className="bottom-grid"><div className="activity-panel panel"><div className="panel-heading compact"><div><span className="section-kicker">活动</span><h2>最近任务</h2></div><button className="text-link" onClick={() => onNavigate('queue')}>打开队列 <ArrowUpRight size={13} /></button></div><div className="activity-list">{queue.slice(0, 3).map((item) => <div className={`activity-item ${item.status === 'done' && item.resultCount ? 'has-result' : ''}`} key={item.id}><div className={`activity-icon ${item.status}`}><StatusIcon status={item.status} /></div><div className="activity-copy"><strong>{item.title}</strong><span>{item.id} · {item.meta}</span></div>{item.status === 'done' && item.resultCount ? <div className="activity-state"><button className="activity-result-button" type="button" aria-label={`查看任务 ${item.id} 的 ${item.resultCount} 张结果`} onClick={() => onViewResults(item.id)}><Eye size={14} />查看结果</button></div> : null}</div>)}{queue.length === 0 && <div className="empty-state">暂无任务记录</div>}</div></div><div className="health-panel panel"><div className="panel-heading compact"><div><span className="section-kicker">服务状态</span><h2>本地运行健康度</h2></div><span className={`healthy-pill ${serviceOnline ? '' : 'offline'} `}><span />{serviceOnline ? '正常' : '未连接'}</span></div><div className="health-content"><div className="health-ring" style={{ '--health-score': `${healthScore}%` } as React.CSSProperties}><div><strong>{statsLoading ? '...' : healthScore}</strong><span>健康分</span></div></div><div className="health-list"><HealthRow label="本地任务引擎" value={serviceOnline ? '运行中' : '未连接'} tone={serviceOnline ? 'good' : 'idle'} /><HealthRow label="本地数据" value={serviceOnline ? '已就绪' : '不可用'} tone={serviceOnline ? 'good' : 'idle'} /><HealthRow label="工作区" value={storageText + (stats?.storageTotalGb ? ` / ${stats.storageTotalGb} GB` : '')} tone={stats?.storageUsedGb === undefined ? 'idle' : 'good'} /></div></div></div></section>
  {feedback && <div className="toast" role="status"><CheckCircle2 size={14} />{feedback}</div>}
  </div>
}

function MetricCard({ label, value, unit, change, icon, tone }: { label: string; value: string; unit: string; change: string; icon: ReactNode; tone: string }) {
  return <div className="metric-card panel"><div className={`metric-icon ${tone}`}>{icon}</div><div className="metric-copy"><span>{label}</span><strong>{value}<small>{unit}</small></strong><em className={tone === 'green' ? 'positive' : ''}>{change}</em></div></div>
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'running' || status === 'queued') return <LoaderCircle size={16} className="spin" />
  if (status === 'done') return <Check size={16} />
  if (status === 'review') return <ShieldCheck size={16} />
  if (status === 'cancelled') return <X size={16} />
  return <AlertTriangle size={16} />
}

function StatusLabel({ status }: { status: string }) {
  const labels: Record<string, string> = { queued: '排队中', running: '运行中', done: '已完成', review: '待复核', failed: '失败', cancelled: '已取消' }
  return <span className={`status-label ${status}`}>{labels[status]}</span>
}

function HealthRow({ label, value, tone }: { label: string; value: string; tone: string }) {
  const displayLabel = label === '本地数据库' ? '本地数据' : label
  const displayValue = label === '本地数据库' ? '已就绪' : value
  return <div className="health-row"><span><i className={`health-dot ${tone}`} />{displayLabel}</span><strong>{displayValue}</strong></div>
}

type QueueFilter = '全部' | 'running' | 'review' | 'done' | 'failed' | 'cancelled'

function QueueFilterBar({ queue, filter, setFilter, search, setSearch }: { queue: QueueItem[]; filter: QueueFilter; setFilter: (value: QueueFilter) => void; search: string; setSearch: (value: string) => void }) {
  return <div className="queue-toolbar panel"><div className="filter-tabs"><button className={filter === '全部' ? 'active' : ''} onClick={() => setFilter('全部')}>全部 <span>{queue.length}</span></button><button className={filter === 'running' ? 'active' : ''} onClick={() => setFilter('running')}>运行中 <span>{queue.filter((item) => item.status === 'running').length}</span></button><button className={filter === 'review' ? 'active' : ''} onClick={() => setFilter('review')}>待复核 <span>{queue.filter((item) => item.status === 'review').length}</span></button><button className={filter === 'done' ? 'active' : ''} onClick={() => setFilter('done')}>已完成 <span>{queue.filter((item) => item.status === 'done').length}</span></button><button className={filter === 'failed' ? 'active' : ''} onClick={() => setFilter('failed')}>失败 <span>{queue.filter((item) => item.status === 'failed').length}</span></button><button className={filter === 'cancelled' ? 'active' : ''} onClick={() => setFilter('cancelled')}>已取消 <span>{queue.filter((item) => item.status === 'cancelled').length}</span></button></div><div className="queue-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务名称或编号" /></div></div>
}

function QueuePage({ queue, setQueue, onRefresh, onCancel, onCreate, onViewResults }: { queue: QueueItem[]; setQueue: Dispatch<SetStateAction<QueueItem[]>>; onRefresh: () => Promise<void>; onCancel: (jobId: string) => Promise<void>; onCreate: () => void; onViewResults: (jobId: string) => void }) {
  const [filter, setFilter] = useState<QueueFilter>('全部')
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const visible = queue.filter((item) => (filter === '全部' || item.status === filter) && (!search.trim() || `${item.title}${item.id}${item.meta}`.toLowerCase().includes(search.trim().toLowerCase())))
  const handleRefresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }
  const refreshButton = <button className="button button-ghost" onClick={() => void handleRefresh()} disabled={refreshing} aria-label="刷新任务队列" aria-busy={refreshing}><RefreshCw size={16} className={refreshing ? 'spin' : ''} />{refreshing ? '刷新中' : '刷新'}</button>
  const createButton = <button className="button button-primary" onClick={onCreate}><Plus size={16} />创建任务</button>
  if (visible.length === 0) return <div className="page-content inner-page"><section className="page-heading heading-row"><div><div className="eyebrow"><span className="eyebrow-line" />生产监控</div><h1>任务队列</h1><p>查看批次进度、失败原因和需要人工确认的请求。</p></div><div className="heading-actions">{refreshButton}{createButton}</div></section><QueueFilterBar queue={queue} filter={filter} setFilter={setFilter} search={search} setSearch={setSearch} /><div className="empty-state panel">暂无任务记录</div></div>
  return <div className="page-content inner-page"><section className="page-heading heading-row"><div><div className="eyebrow"><span className="eyebrow-line" />生产监控</div><h1>任务队列</h1><p>查看批次进度、失败原因和需要人工确认的请求。</p></div><div className="heading-actions">{refreshButton}{createButton}</div></section><div className="queue-toolbar panel"><div className="filter-tabs"><button className={filter === '全部' ? 'active' : ''} onClick={() => setFilter('全部')}>全部 <span>{queue.length}</span></button><button className={filter === 'running' ? 'active' : ''} onClick={() => setFilter('running')}>运行中 <span>{queue.filter((item) => item.status === 'running').length}</span></button><button className={filter === 'review' ? 'active' : ''} onClick={() => setFilter('review')}>待复核 <span>{queue.filter((item) => item.status === 'review').length}</span></button><button className={filter === 'done' ? 'active' : ''} onClick={() => setFilter('done')}>已完成 <span>{queue.filter((item) => item.status === 'done').length}</span></button><button className={filter === 'failed' ? 'active' : ''} onClick={() => setFilter('failed')}>失败 <span>{queue.filter((item) => item.status === 'failed').length}</span></button><button className={filter === 'cancelled' ? 'active' : ''} onClick={() => setFilter('cancelled')}>已取消 <span>{queue.filter((item) => item.status === 'cancelled').length}</span></button></div><div className="queue-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务名称或编号" /></div></div><div className="queue-list panel">{visible.map((item) => <div className={`queue-row ${item.status === 'done' && item.resultCount ? 'has-result' : ''}`} key={item.id}><div className={`queue-status-icon ${item.status}`}><StatusIcon status={item.status} /></div><div className="queue-main"><div className="queue-title-line"><strong>{item.title}</strong><span className="mono">{item.id}</span></div><div className="queue-meta-line"><span>{item.meta}</span><time dateTime={item.createdAt}>{formatQueueCreatedAt(item.createdAt)}</time></div><div className="progress-track" role="progressbar" aria-label={`${item.title}进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}><i className={item.status} style={{ width: `${item.progress}%` }} /></div></div><div className="queue-summary"><div className="queue-progress"><strong>{item.progress}%</strong></div><StatusLabel status={item.status} />{item.status === 'done' && item.resultCount ? <button className="queue-result-button" type="button" aria-label={`查看任务 ${item.id} 的 ${item.resultCount} 张结果`} onClick={() => onViewResults(item.id)}><Eye size={15} />查看结果<span>{item.resultCount} 张</span></button> : null}{(item.status === 'queued' || item.status === 'running') && <button className="queue-cancel-button" title="取消任务" aria-label={`取消任务 ${item.title}`} onClick={() => void onCancel(item.id)}><X size={15} /><span>取消</span></button>}</div></div>)}</div><div className="queue-footnote"><CircleHelp size={15} />生图接口超时会进入“待确认”，不会自动重复计费请求。</div></div>
}

function GalleryPage({ assets, focusJobId, onClearFocus }: { assets: GalleryAsset[]; focusJobId: string | null; onClearFocus: () => void }) {
  const [filter, setFilter] = useState('全部')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid')
  const [importedAssets, setImportedAssets] = useState<GalleryAsset[]>([])
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const importedUrls = useRef<string[]>([])

  useEffect(() => () => {
    importedUrls.current.forEach((url) => URL.revokeObjectURL(url))
  }, [])

  const source = [...importedAssets, ...assets]
  const focusedSource = focusJobId ? source.filter((item) => item.jobId === focusJobId) : source
  const visible = filter === '全部' ? focusedSource : focusedSource.filter((item) => item.tag === filter)

  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(''), 2400)
    return () => window.clearTimeout(timer)
  }, [feedback])

  useEffect(() => {
    if (!openMenu) return
    const closeMenu = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null)
    }
    window.addEventListener('keydown', closeMenu)
    return () => window.removeEventListener('keydown', closeMenu)
  }, [openMenu])

  const openAsset = (image: GalleryAsset) => {
    window.open(image.src, '_blank', 'noopener,noreferrer')
    setFeedback(`已打开：${image.title}`)
  }

  const copyAssetUrl = async (image: GalleryAsset) => {
    try {
      await navigator.clipboard.writeText(image.src)
      setFeedback('图片地址已复制')
    } catch {
      setFeedback('复制失败，请检查浏览器权限')
    }
    setOpenMenu(null)
  }

  const importAssets = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith('image/'))
    if (files.length === 0) {
      setFeedback('请选择 PNG、JPG 或 WEBP 图片')
      return
    }
    const nextAssets = files.map((file) => {
      const url = URL.createObjectURL(file)
      importedUrls.current.push(url)
      return { src: url, title: file.name, tag: 'PASS', tone: 'pass' }
    })
    setImportedAssets((current) => [...nextAssets, ...current])
    setFeedback(`已导入 ${files.length} 张图片`)
    event.target.value = ''
  }

  return <div className="page-content inner-page"><section className="page-heading heading-row"><div><div className="eyebrow"><span className="eyebrow-line" />本地资产</div><h1>生成画廊</h1><p>{focusJobId ? <>当前查看任务 <span className="mono">{focusJobId}</span> 的生成结果。</> : '浏览最近产物，按合规状态快速筛选和打开本地文件。'}</p></div><div className="heading-actions"><label className="button button-primary" htmlFor="gallery-import"><DownloadIcon />导入资产</label><input id="gallery-import" className="gallery-import-input" type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={importAssets} /></div></section>{focusJobId && <div className="gallery-focus-bar" role="status"><div><Eye size={15} /><span>任务结果筛选</span><strong className="mono">{focusJobId}</strong><small>{focusedSource.length} 张图片</small></div><button className="button button-ghost button-small" type="button" onClick={onClearFocus}><X size={14} />查看全部画廊</button></div>}<div className="gallery-toolbar"><div className="filter-tabs"><button className={filter === '全部' ? 'active' : ''} onClick={() => setFilter('全部')}>全部 <span>{focusedSource.length}</span></button><button className={filter === 'PASS' ? 'active' : ''} onClick={() => setFilter('PASS')}>可用 <span>{focusedSource.filter((item) => item.tag === 'PASS').length}</span></button><button className={filter === 'REVIEW' ? 'active' : ''} onClick={() => setFilter('REVIEW')}>待复核 <span>{focusedSource.filter((item) => item.tag === 'REVIEW').length}</span></button><button className={filter === 'BLOCK' ? 'active' : ''} onClick={() => setFilter('BLOCK')}>高风险 <span>{focusedSource.filter((item) => item.tag === 'BLOCK').length}</span></button></div><div className="gallery-view-toggle" role="group" aria-label="画廊视图"><button className={viewMode === 'grid' ? 'active' : ''} title="网格视图" aria-label="网格视图" aria-pressed={viewMode === 'grid'} onClick={() => setViewMode('grid')}><LayoutGrid size={16} /></button><button className={viewMode === 'list' ? 'active' : ''} title="列表视图" aria-label="列表视图" aria-pressed={viewMode === 'list'} onClick={() => setViewMode('list')}><ListChecks size={16} /></button></div></div>{visible.length === 0 ? <div className="empty-state panel">{focusJobId ? '该任务暂无可展示的生成结果。' : '暂无生成结果，点击“导入资产”添加本地图片。'}</div> : <div className={`gallery-grid ${viewMode === 'list' ? 'list-view' : ''}`}>{visible.map((image) => <article className="gallery-card" key={`${image.title}-${image.src}`}><button className="gallery-card-open" type="button" onClick={() => openAsset(image)} aria-label={`打开 ${image.title}`}><div className="gallery-image"><img src={image.src} alt={image.title} loading="lazy" /><span className={`gallery-tag ${image.tone}`}>{statusNames[image.tag] ?? image.tag}</span></div><div className="gallery-card-body"><strong>{image.title}</strong><span>{importedAssets.some((item) => item.src === image.src) ? '已导入本地图片' : '本地任务结果'}</span></div></button><div className="gallery-card-actions"><button className="image-more" type="button" title="更多操作" aria-label={`更多操作：${image.title}`} aria-expanded={openMenu === image.src} onClick={() => setOpenMenu((current) => current === image.src ? null : image.src)}><MoreHorizontal size={17} /></button>{openMenu === image.src && <div className="image-menu" role="menu"><button type="button" role="menuitem" onClick={() => openAsset(image)}><Eye size={14} />打开原图</button><button type="button" role="menuitem" onClick={() => void copyAssetUrl(image)}><Copy size={14} />复制图片地址</button></div>}</div></article>)}</div>}{feedback && <div className="toast" role="status"><CheckCircle2 size={14} />{feedback}</div>}</div>
}

function ApiPromptsPage({ prompts, loading, error, selectedPrompt, setSelectedPrompt }: { prompts: PromptItem[]; loading: boolean; error: string; selectedPrompt: string; setSelectedPrompt: (value: string) => void }) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('全部提示词')
  const categories = ['全部提示词', ...Array.from(new Set(prompts.map((item) => item.category)))]
  const filtered = prompts.filter((item) => {
    const matchesCategory = category === '全部提示词' || item.category === category
    const query = search.trim().toLowerCase()
    return matchesCategory && (!query || `${item.title}${item.category}${item.text}`.toLowerCase().includes(query))
  })
  return <div className="page-content inner-page"><section className="page-heading heading-row"><div><div className="eyebrow"><span className="eyebrow-line" />内容资产</div><h1>提示词库</h1><p>提示词由本地服务初始化并从数据库读取。</p></div></section><div className="prompt-toolbar"><div className="search-field"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索模板名称、分类或内容" /></div></div>{error && <div className="form-error" role="status"><AlertTriangle size={14} />{error}</div>}{loading ? <div className="empty-state">提示词加载中…</div> : filtered.length === 0 ? <div className="empty-state">暂无可用提示词</div> : <div className="prompt-layout"><aside className="category-panel panel"><span className="section-kicker">分类</span>{categories.map((item) => <button className={`category-item ${category === item ? 'active' : ''}`} key={item} onClick={() => setCategory(item)}>{item}<span>{item === '全部提示词' ? prompts.length : prompts.filter((prompt) => prompt.category === item).length}</span></button>)}</aside><div className="prompt-cards">{filtered.map((item) => <article className={`prompt-card panel ${selectedPrompt === item.id ? 'selected' : ''}`} key={item.id} onClick={() => setSelectedPrompt(item.id)}><div className="prompt-card-top"><span className="category-chip">{item.category}</span></div><h3>{item.title}</h3><p>{item.text.slice(0, 180)}{item.text.length > 180 ? '…' : ''}</p><div className="prompt-card-footer"><span>{item.layout === 'four_up' ? '4K 四宫格' : item.layout === 'fifteen_up_test' ? '4K 十五宫格测试' : '两宫格'} · 后端初始化</span>{selectedPrompt === item.id && <span className="selected-label"><Check size={13} />已选中</span>}</div></article>)}</div></div>}</div>
}

function SettingsModal({ config, maxConcurrency, onSave, onClose }: { config: ChannelConfig; maxConcurrency: number; onSave: (config: ChannelConfig, maxConcurrency: number) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(config)
  const [draftMaxConcurrency, setDraftMaxConcurrency] = useState(maxConcurrency)
  const [showKey, setShowKey] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const updateDraft = (patch: Partial<ChannelConfig>) => {
    setSaved(false)
    setError('')
    setDraft((current) => ({ ...current, ...patch }))
  }

  const handleSave = async () => {
    if (saving) return
    if (!draft.baseUrl.trim()) {
      setError('请填写接口地址。')
      return
    }
    try {
      const url = new URL(draft.baseUrl)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol')
    } catch {
      setError('接口地址需填写完整的 http:// 或 https:// 地址。')
      return
    }
    setSaving(true)
    try {
      await onSave(draft, draftMaxConcurrency)
      setSaved(true)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Provider 配置保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(event) => event.stopPropagation()}>
        <div className="modal-heading">
          <div>
            <span className="section-kicker">本地配置</span>
            <h2 id="settings-title">工作区设置</h2>
            <p className="modal-description">当前版本仅支持一个默认通道，填写地址和密钥即可开始使用。</p>
          </div>
          <button className="icon-button subtle" onClick={onClose} title="关闭"><X size={18} /></button>
        </div>
        <div className="settings-modal-body">
          <div className="channel-form">
            <div className="setting-field">
              <label htmlFor="channel-base-url">接口地址（baseUrl）</label>
              <input id="channel-base-url" value={draft.baseUrl} onChange={(event) => updateDraft({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" inputMode="url" aria-invalid={Boolean(error)} />
            </div>
            <div className="setting-field">
              <label htmlFor="channel-api-key">API Key</label>
      <div className="secret-input">
                <input id="channel-api-key" className={showKey ? 'api-key-input' : 'api-key-input masked'} type="text" value={draft.apiKey} onChange={(event) => updateDraft({ apiKey: event.target.value })} placeholder="输入当前通道的 API Key" autoComplete="off" />
                <button className="icon-button subtle" type="button" onClick={() => setShowKey((visible) => !visible)} title={showKey ? '隐藏 API Key' : '显示 API Key'} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              </div>
              <span className="field-help">密钥仅保存到本地服务配置表并用于 Provider 调用，不展示在任务、日志或导出文件中。</span>
            </div>
            {error && <div className="form-error" role="alert"><AlertTriangle size={14} />{error}</div>}
          </div>
          <div className="setting-row">
            <div><strong>输出工作区</strong><span>结果、报告和日志均写入本机</span></div>
            <span className="field-help">由本地服务自动管理</span>
          </div>
          <div className="setting-row">
            <div><strong>最大并发</strong><span>建议根据供应商配额逐步增加</span></div>
            <div className="number-control compact"><input type="number" min="1" max="20" value={draftMaxConcurrency} onChange={(event) => { setSaved(false); setError(''); setDraftMaxConcurrency(Math.min(20, Math.max(1, Number(event.target.value) || 1))) }} aria-label="最大并发数" /><span>线程</span></div>
          </div>
        </div>
        <div className="modal-footer">
          <span className={`save-feedback ${saved ? 'visible' : ''}`} role="status">{saved ? <><CheckCircle2 size={14} />已保存到本地配置</> : '修改后点击保存'}</span>
          <button className="button button-ghost" onClick={onClose}>取消</button>
          <button className="button button-primary" onClick={() => void handleSave()} disabled={saving}><Check size={16} />{saving ? '保存中…' : '保存设置'}</button>
        </div>
      </div>
    </div>
  )
}

function DownloadIcon() {
  return <FileImage size={16} />
}

export default App

createRoot(document.getElementById('root')!).render(<App />)
