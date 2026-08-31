import { useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, ReactNode, SetStateAction } from 'react'
import { createRoot } from 'react-dom/client'
import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  BarChart3,
  Bell,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Clock3,
  CloudUpload,
  Copy,
  Eye,
  EyeOff,
  FileImage,
  FolderOpen,
  GalleryHorizontalEnd,
  GripVertical,
  ImagePlus,
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
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { builtinPrompts } from './data/builtin-prompts'
import type { BuiltinPrompt } from './data/builtin-prompts'
import './styles.css'

type Mode = 'generate' | 'edit' | 'text' | 'one-to-many'
type Page = 'workbench' | 'queue' | 'gallery' | 'prompts' | 'compliance'

type PromptWindow = {
  id: number
  name: string
  prompt: string
  enabled: boolean
}

type PromptSelection = BuiltinPrompt['id']

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
}

type GalleryAsset = {
  src: string
  title: string
  tag: string
  tone: string
}

type ApiJob = {
  id: string
  mode: string
  status: string
  progress?: number
  createdAt?: string
  updatedAt?: string
  job?: ApiJob
}

type ApiErrorBody = {
  error?: { message?: string }
}

const LOCAL_API_BASE = 'http://127.0.0.1:8765'
const MAX_SOURCE_IMAGE_BYTES = 8 * 1024 * 1024
const SOURCE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])

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
  { id: 'generate', label: '正常生图', detail: '批量输入 · 多模板生产' },
  { id: 'edit', label: '改图', detail: '单图附件 · 定向修改' },
  { id: 'text', label: '文生图', detail: '无附件 · 独立尺寸' },
  { id: 'one-to-many', label: '一裂多', detail: '一张源图 · 多方向变体' },
]

const galleryImages = [
  { src: 'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=900&q=85', title: '城市机能鞋 · A组', tag: 'PASS', tone: 'pass' },
  { src: 'https://images.unsplash.com/photo-1529139574466-a303027c1d8b?auto=format&fit=crop&w=900&q=85', title: '户外层叠 · 结构版', tag: 'REVIEW', tone: 'review' },
  { src: 'https://images.unsplash.com/photo-1503342217505-b0a15ec3261c?auto=format&fit=crop&w=900&q=85', title: '美式复古 · 字标版', tag: 'PASS', tone: 'pass' },
  { src: 'https://images.unsplash.com/photo-1460353581641-37baddab0fa2?auto=format&fit=crop&w=900&q=85', title: '跑鞋细节 · 4K', tag: 'BLOCK', tone: 'block' },
  { src: 'https://images.unsplash.com/photo-1525507119028-ed4c629a60a3?auto=format&fit=crop&w=900&q=85', title: '服装陈列 · 二宫格', tag: 'PASS', tone: 'pass' },
  { src: 'https://images.unsplash.com/photo-1551488831-00ddcb6c6bd3?auto=format&fit=crop&w=900&q=85', title: '材质实验 · 测试', tag: 'REVIEW', tone: 'review' },
]

const statusNames: Record<string, string> = {
  PASS: '可用',
  REVIEW: '待复核',
  BLOCK: '高风险',
  UNKNOWN: '待确认',
}

const queueSeed: QueueItem[] = [
  { id: 'LT-240830-014', title: '夏季户外鞋 · 一裂多', meta: '3 个窗口 · 4K 四宫格', status: 'running', progress: 68, time: '运行 02:41' },
  { id: 'LT-240830-013', title: '城市机能鞋 · 常规批次', meta: '18 张 · 6 个模板', status: 'done', progress: 100, time: '完成于 09:42' },
  { id: 'LT-240830-012', title: '复古字标 · 改图', meta: '单张 · 标准 IMG2', status: 'review', progress: 100, time: '待人工确认' },
  { id: 'LT-240830-011', title: '春季陈列 · 文生图', meta: '4 张 · 1K 方图', status: 'failed', progress: 44, time: '接口超时' },
]

const defaultPrompt = builtinPrompts.find((item) => item.layout === 'four_up') ?? builtinPrompts[0]

function App() {
  const [page, setPage] = useState<Page>('workbench')
  const [mode, setMode] = useState<Mode>('generate')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [running, setRunning] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
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
  const [selectedPrompt, setSelectedPrompt] = useState<PromptSelection>(defaultPrompt.id)
  const [textPrompt, setTextPrompt] = useState(defaultPrompt.text)
  const [layout, setLayout] = useState('4K 四宫格')
  const [size, setSize] = useState('3840 × 2160')
  const [quality, setQuality] = useState('高')
  const [repeat, setRepeat] = useState(1)
  const [inputName, setInputName] = useState('未选择输入文件夹')
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [promptWindows, setPromptWindows] = useState<PromptWindow[]>([
    { id: 1, name: builtinPrompts[0].title, prompt: builtinPrompts[0].text, enabled: true },
    { id: 2, name: builtinPrompts[1].title, prompt: builtinPrompts[1].text, enabled: true },
    { id: 3, name: '节日氛围', prompt: '', enabled: false },
  ])
  const [queue, setQueue] = useState(queueSeed)
  const [galleryAssets, setGalleryAssets] = useState<GalleryAsset[]>([])
  const [serviceOnline, setServiceOnline] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const eventSourceRef = useRef<EventSource | null>(null)

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

  useEffect(() => () => {
    eventSourceRef.current?.close()
  }, [])

  const activeMode = modes.find((item) => item.id === mode) ?? modes[0]
  const selectedPromptItem = builtinPrompts.find((item) => item.id === selectedPrompt) ?? defaultPrompt
  const enabledWindows = promptWindows.filter((item) => item.enabled && item.prompt.trim())
  const pageTitle = useMemo(() => {
    const titles: Record<Page, string> = {
      workbench: '生产工作台',
      queue: '任务队列',
      gallery: '生成画廊',
      prompts: '提示词库',
      compliance: '合规中心',
    }
    return titles[page]
  }, [page])

  const handlePromptSelect = (id: PromptSelection) => {
    const item = builtinPrompts.find((prompt) => prompt.id === id)
    setSelectedPrompt(id)
    if (item) setTextPrompt(item.text)
  }

  const saveChannelConfig = (config: ChannelConfig) => {
    setChannelConfig(config)
    try {
      // 只记住地址，API Key 不写入浏览器存储，避免超出本地服务安全边界。
      window.localStorage.setItem('lingtu-channel-config', JSON.stringify({ baseUrl: config.baseUrl }))
    } catch {
      // 无痕模式等场景可能禁用存储，仍保留当前会话配置。
    }
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
      meta: `${job.mode === 'one_to_many' ? enabledWindows.length : 1} 个任务项 · ${layout}`,
      status,
      progress,
      time,
    }
    setQueue((items) => [item, ...items.filter((existing) => existing.id !== job.id)])
    return status
  }

  const refreshQueue = async () => {
    try {
      const response = await fetch(`${LOCAL_API_BASE}/api/jobs`)
      if (!response.ok) return
      const body = await response.json() as { items?: ApiJob[] }
      if (!Array.isArray(body.items)) return
      const completedAssets = body.items.flatMap((job) => (job.status === 'completed' && Array.isArray((job as ApiJob & { results?: Array<{ index: number }> }).results)
        ? ((job as ApiJob & { results: Array<{ index: number }> }).results).map((result) => ({
          src: `${LOCAL_API_BASE}/api/jobs/${encodeURIComponent(job.id)}/results/${result.index}`,
          title: `${modes.find((item) => item.id === (job.mode === 'text_to_image' ? 'text' : job.mode))?.label ?? '生图'} · ${job.id.slice(-8)}`,
          tag: 'PASS',
          tone: 'pass',
        }))
        : []))
      setGalleryAssets(completedAssets)
      setQueue(body.items.map((job) => {
        return {
          id: job.id,
          title: `${modes.find((item) => item.id === (job.mode === 'text_to_image' ? 'text' : job.mode))?.label ?? '生图'} · 任务`,
          meta: `${job.mode === 'one_to_many' ? enabledWindows.length : 1} 个任务项 · ${layout}`,
          status: job.status === 'completed' ? 'done' : job.status === 'failed' ? 'failed' : job.status === 'cancelled' ? 'cancelled' : job.status === 'running' ? 'running' : 'queued',
          progress: job.progress ?? (job.status === 'completed' ? 100 : 0),
          time: job.status === 'completed' ? '已完成' : job.status === 'failed' ? '失败' : job.status === 'cancelled' ? '已取消' : '进行中',
        } satisfies QueueItem
      }))
    } catch {
      // 本地服务未启动时保留已有队列，避免刷新动作清空用户当前视图。
    }
  }

  const cancelJob = async (jobId: string) => {
    try {
      const response = await fetch(`${LOCAL_API_BASE}/api/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' })
      if (response.ok) updateQueueFromJob(await response.json() as ApiJob)
    } catch {
      setSubmitError('取消任务失败，请检查本地服务状态')
    }
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

  const subscribeJob = (jobId: string) => {
    eventSourceRef.current?.close()
    const source = new EventSource(`${LOCAL_API_BASE}/api/jobs/${encodeURIComponent(jobId)}/events`)
    eventSourceRef.current = source
    const handleEvent = (event: Event) => {
      try {
        const body = JSON.parse((event as MessageEvent<string>).data) as ApiJob & { completed?: number; total?: number }
        const eventJob = body.job ?? body
        if (!eventJob.id) return
        const status = updateQueueFromJob({ ...eventJob, progress: body.total ? Math.round((body.completed ?? 0) / body.total * 100) : eventJob.progress })
        if (status === 'done' || status === 'review' || status === 'failed' || status === 'cancelled') {
          source.close()
          if (eventSourceRef.current === source) eventSourceRef.current = null
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
      if (eventSourceRef.current === source) eventSourceRef.current = null
      void readJobDetail(jobId)
    }
  }

  const startJob = async () => {
    if (running) return
    setSubmitError('')
    if (mode === 'edit' && !sourceFile) {
      setSubmitError('请先选择一张源图后再开始改图')
      return
    }
    const prompt = mode === 'one-to-many' ? enabledWindows[0]?.prompt.trim() ?? '' : textPrompt.trim() || selectedPromptItem.text
    if (!prompt) {
      setSubmitError('请输入提示词后再开始任务')
      return
    }
    setRunning(true)
    try {
      const sourceImage = mode === 'edit' && sourceFile
        ? { data: await encodeFile(sourceFile), mimeType: sourceFile.type, name: sourceFile.name }
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
          quality,
          repeat,
          sourceImage,
          provider: {
            baseUrl: channelConfig.baseUrl.trim(),
            apiKey: channelConfig.apiKey,
          },
          idempotencyKey: `lingtu-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        }),
      })
      const body = await response.json() as ApiJob | ApiErrorBody
      if (!response.ok || !('id' in body)) {
        throw new Error(('error' in body && body.error?.message) || '本地服务拒绝了任务提交')
      }
      updateQueueFromJob(body)
      setRunning(false)
      subscribeJob(body.id)
      // POST 成功后立即回读详情，覆盖响应不完整或 SSE 尚未连接的情况。
      void readJobDetail(body.id)
    } catch (error) {
      setRunning(false)
      setSubmitError(error instanceof Error ? error.message : '任务提交失败，请检查本地服务状态')
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
    { id: 'compliance', label: '合规中心', icon: ShieldCheck },
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
            return <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)} title={item.label}>
              <Icon size={18} strokeWidth={1.8} /><span>{sidebarOpen && item.label}</span>{sidebarOpen && item.badge && <span className="nav-badge">{item.badge}</span>}
            </button>
          })}
        </nav>
        <div className="sidebar-bottom">
          {sidebarOpen && <div className="storage-meter"><div className="storage-line"><span>工作区存储</span><span>2.4 / 20 GB</span></div><div className="meter"><i style={{ width: '12%' }} /></div></div>}
          <button className="nav-item" onClick={() => setShowSettings(true)} title="设置"><Settings2 size={18} /><span>{sidebarOpen && '设置'}</span></button>
          <button className="nav-item" onClick={() => setSidebarOpen((open) => !open)} title={sidebarOpen ? '收起侧栏' : '展开侧栏'}>{sidebarOpen ? <PanelLeftClose size={18} /> : <PanelLeftOpen size={18} />}<span>{sidebarOpen && '收起侧栏'}</span></button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div className="breadcrumb"><span>本地工作区</span><span className="crumb-slash">/</span><strong>{pageTitle}</strong></div>
          <div className="topbar-actions">
            <div className="connection-status"><span className={`status-dot ${serviceOnline ? '' : 'offline'}`} />{serviceOnline ? '本地服务已连接' : '本地服务未启动'}</div>
            <button className="icon-button" title="通知"><Bell size={18} /><span className="notification-dot" /></button>
            <div className="avatar">M</div>
          </div>
        </header>

        {page === 'workbench' && <Workbench mode={mode} setMode={setMode} activeMode={activeMode} layout={layout} setLayout={setLayout} size={size} setSize={setSize} quality={quality} setQuality={setQuality} repeat={repeat} setRepeat={setRepeat} inputName={inputName} setInputName={setInputName} sourceFile={sourceFile} setSourceFile={setSourceFile} selectedPrompt={selectedPrompt} selectedPromptItem={selectedPromptItem} textPrompt={textPrompt} setTextPrompt={setTextPrompt} setSelectedPrompt={handlePromptSelect} promptWindows={promptWindows} updatePromptWindow={updatePromptWindow} addPromptWindow={addPromptWindow} enabledWindows={enabledWindows} running={running} startJob={startJob} queue={queue} channelConfig={channelConfig} submitError={submitError} />}
        {page === 'queue' && <QueuePage queue={queue} setQueue={setQueue} onRefresh={refreshQueue} onCancel={cancelJob} />}
        {page === 'gallery' && <GalleryPage assets={galleryAssets} />}
        {page === 'prompts' && <PromptsPage selectedPrompt={selectedPrompt} setSelectedPrompt={handlePromptSelect} />}
        {page === 'compliance' && <CompliancePage />}
      </main>

      {showSettings && <SettingsModal config={channelConfig} onSave={saveChannelConfig} onClose={() => setShowSettings(false)} />}
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
  quality: string
  setQuality: (value: string) => void
  repeat: number
  setRepeat: (value: number) => void
  inputName: string
  setInputName: (value: string) => void
  sourceFile: File | null
  setSourceFile: (value: File | null) => void
  selectedPrompt: PromptSelection
  selectedPromptItem: BuiltinPrompt
  textPrompt: string
  setTextPrompt: (value: string) => void
  setSelectedPrompt: (value: PromptSelection) => void
  promptWindows: PromptWindow[]
  updatePromptWindow: (id: number, patch: Partial<PromptWindow>) => void
  addPromptWindow: () => void
  enabledWindows: PromptWindow[]
  running: boolean
  startJob: () => void | Promise<void>
  queue: typeof queueSeed
  channelConfig: ChannelConfig
  submitError: string
}

function Workbench(props: WorkbenchProps) {
  const { mode, setMode, activeMode, layout, setLayout, size, setSize, quality, setQuality, repeat, setRepeat, inputName, setInputName, sourceFile, setSourceFile, selectedPrompt, selectedPromptItem, textPrompt, setTextPrompt, setSelectedPrompt, promptWindows, updatePromptWindow, addPromptWindow, enabledWindows, running, startJob, queue, channelConfig, submitError } = props
  return <div className="page-content workbench-page">
    <section className="page-heading heading-row">
      <div><div className="eyebrow"><span className="eyebrow-line" />今日生产 <span className="mono">2026.08.30</span></div><h1>开始一轮新的生产</h1><p>从源图、模板到合规归档，在一个本地工作区完成闭环。</p></div>
      <div className="heading-actions"><button className="button button-ghost"><FolderOpen size={16} />打开工作区</button><button className="button button-ghost"><RefreshCw size={16} />刷新状态</button></div>
    </section>

    <section className="metrics-grid">
      <MetricCard label="今日已完成" value="38" unit="张" change="+14.2%" icon={<CheckCircle2 size={18} />} tone="green" />
      <MetricCard label="运行中任务" value="01" unit="批" change="预计 07:18" icon={<LoaderCircle size={18} />} tone="orange" />
      <MetricCard label="待合规复核" value="06" unit="张" change="需要关注" icon={<ShieldCheck size={18} />} tone="purple" />
      <MetricCard label="本地空间" value="2.4" unit="GB" change="剩余 17.6 GB" icon={<Archive size={18} />} tone="blue" />
    </section>

    <section className="workbench-layout">
      <div className="composer-panel panel">
        <div className="panel-heading"><div><span className="section-kicker">01 / 工作流</span><h2>选择生产模式</h2></div><button className="icon-button subtle" title="查看模式说明"><CircleHelp size={17} /></button></div>
        <div className="mode-tabs" role="tablist" aria-label="生产模式">
          {modes.map((item) => <button key={item.id} className={`mode-tab ${mode === item.id ? 'active' : ''}`} onClick={() => setMode(item.id)} role="tab" aria-selected={mode === item.id}><span>{item.label}</span><small>{item.detail}</small></button>)}
        </div>

        {mode !== 'text' && <div className="field-block"><div className="field-label"><label htmlFor="source-input">{mode === 'edit' ? '源图附件' : mode === 'one-to-many' ? '裂变源图' : '输入文件夹'}</label><span className="field-required">必填</span></div><div className={`dropzone ${inputName !== '未选择输入文件夹' ? 'has-file' : ''}`}><input id="source-input" type="file" hidden accept="image/*" multiple={mode !== 'edit'} onChange={(event) => { const file = event.target.files?.[0]; if (mode === 'edit') { if (!file) { setSourceFile(null); setInputName('未选择源图'); return }; if (!SOURCE_IMAGE_TYPES.has(file.type) || file.size > MAX_SOURCE_IMAGE_BYTES) { setSourceFile(null); setInputName('源图需为 PNG / JPG / WEBP 且不超过 8 MB'); return }; setSourceFile(file); setInputName(file.name); return }; setInputName(event.target.files?.length ? `${event.target.files.length} 个文件已选择` : '未选择输入文件夹') }} /><div className="dropzone-icon"><CloudUpload size={19} /></div><div className="dropzone-copy"><strong>{inputName}</strong><span>{mode === 'edit' ? '支持 PNG / JPG / WEBP，单张不超过 8 MB' : '拖拽图片至此，或点击选择本地文件夹'}</span></div><label className="button button-small button-dark" htmlFor="source-input"><Upload size={14} />选择</label></div></div>}

        {mode === 'text' && <div className="field-block"><div className="field-label"><label htmlFor="text-prompt">创作描述</label><span className="field-required">必填</span></div><textarea id="text-prompt" className="prompt-editor" value={textPrompt} onChange={(event) => setTextPrompt(event.target.value)} /></div>}

        {mode === 'one-to-many' ? <div className="field-block one-to-many-block"><div className="field-label"><div><label>一裂多提示词窗口</label><span className="field-hint">已启用 {enabledWindows.length} 个</span></div><button className="button button-small button-ghost" onClick={addPromptWindow}><Plus size={14} />添加窗口</button></div><div className="prompt-window-list">{promptWindows.map((item, index) => <div className={`prompt-window ${item.enabled ? 'enabled' : ''}`} key={item.id}><div className="window-grip"><GripVertical size={15} /></div><button className={`toggle ${item.enabled ? 'on' : ''}`} onClick={() => updatePromptWindow(item.id, { enabled: !item.enabled })} aria-label={`${item.name} ${item.enabled ? '已启用' : '未启用'}`}><span /></button><div className="window-fields"><input aria-label={`窗口 ${index + 1} 名称`} value={item.name} onChange={(event) => updatePromptWindow(item.id, { name: event.target.value })} /><textarea aria-label={`${item.name}提示词`} placeholder="输入这个方向的提示词" value={item.prompt} onChange={(event) => updatePromptWindow(item.id, { prompt: event.target.value })} /></div><button className="icon-button danger-icon" title="删除窗口" onClick={() => updatePromptWindow(item.id, { prompt: '', enabled: false })}><Trash2 size={15} /></button></div>)}</div>{enabledWindows.length < 2 && <div className="inline-warning"><AlertTriangle size={14} />至少启用两个非空窗口后才能开始</div>}</div> : <div className="field-block"><div className="field-label"><label htmlFor="template-select">提示词模板</label><button className="text-link" onClick={() => setSelectedPrompt(defaultPrompt.id)}>浏览全部 <ArrowUpRight size={13} /></button></div><div className="select-wrap"><select id="template-select" value={selectedPrompt} onChange={(event) => setSelectedPrompt(event.target.value)}>{builtinPrompts.map((item) => <option key={item.id} value={item.id}>{item.category} · {item.title}</option>)}</select><ChevronDown size={16} /></div><div className="prompt-preview"><span className="prompt-type">{mode === 'text' ? '文字' : '图片'} / 模板</span><p>{selectedPromptItem.text.slice(0, 320)}{selectedPromptItem.text.length > 320 ? '…' : ''}</p><button className="icon-button subtle" title="复制提示词"><Copy size={15} /></button></div></div>}

        <div className="settings-divider"><button className="advanced-trigger" onClick={() => {}}><SlidersHorizontal size={15} />高级参数 <span>默认生产规范</span><ChevronDown size={15} /></button></div>
        <div className="settings-grid"><div className="compact-field"><label htmlFor="layout-select">输出布局</label><div className="select-wrap"><select id="layout-select" value={layout} onChange={(event) => setLayout(event.target.value)}><option>4K 四宫格</option><option>1K 二宫格</option><option>4K 十五宫格（测试）</option></select><ChevronDown size={15} /></div></div><div className="compact-field"><label htmlFor="size-select">生图尺寸</label><div className="select-wrap"><select id="size-select" value={size} onChange={(event) => setSize(event.target.value)}><option>3840 × 2160</option><option>1129 × 1254</option><option>1024 × 1024</option><option>1536 × 1024</option></select><ChevronDown size={15} /></div></div><div className="compact-field"><label htmlFor="quality-select">质量</label><div className="select-wrap"><select id="quality-select" value={quality} onChange={(event) => setQuality(event.target.value)}><option>高</option><option>中</option><option>自动</option></select><ChevronDown size={15} /></div></div><div className="compact-field"><label htmlFor="repeat-input">重复次数</label><div className="number-control"><input id="repeat-input" type="number" min="1" max="20" value={repeat} onChange={(event) => setRepeat(Math.min(20, Math.max(1, Number(event.target.value) || 1)))} /><span>次</span></div></div></div>
        <div className="composer-footer"><div className="footer-note"><span className="secure-icon"><ShieldCheck size={14} /></span>默认通道已配置 <span className="mono">· 仅保存在本机</span>{submitError && <span className="form-error" role="alert"><AlertTriangle size={14} />{submitError}</span>}</div><button className="button button-primary start-button" onClick={startJob} disabled={running || (mode === 'one-to-many' && enabledWindows.length < 2)}>{running ? <><LoaderCircle size={16} className="spin" />创建任务中</> : <><Play size={16} fill="currentColor" />开始{activeMode.label}<ArrowUpRight size={16} /></>}</button></div>
      </div>

      <div className="preview-column"><div className="preview-panel panel"><div className="panel-heading"><div><span className="section-kicker">02 / 预览</span><h2>版式预览</h2></div><div className="preview-actions"><button className="icon-button subtle" title="刷新预览"><RefreshCw size={16} /></button><button className="icon-button subtle" title="更多操作"><MoreHorizontal size={17} /></button></div></div><div className={`layout-preview ${layout.includes('二宫格') ? 'layout-two' : layout.includes('十五') ? 'layout-fifteen' : ''}`}><div className="preview-cell cell-a"><span>A</span><small>主视觉区域</small></div><div className="preview-cell cell-b"><span>B</span><small>卖点信息区域</small></div>{layout.includes('四宫格') && <><div className="preview-cell cell-c"><span>C</span><small>细节变体</small></div><div className="preview-cell cell-d"><span>D</span><small>场景变体</small></div></>}</div><div className="preview-caption"><div><strong>{layout}</strong><span>安全区已锁定 · 不跨格 · 不拉伸</span></div><span className="ratio">{size.replace(' × ', ':')}</span></div></div><div className="quick-panel panel"><div className="quick-heading"><span>最近使用</span><button className="text-link">查看全部 <ArrowUpRight size={13} /></button></div><div className="recent-row">{galleryImages.slice(0, 4).map((image) => <button key={image.title} className="recent-thumb" title={image.title}><img src={image.src} alt="" /><span className={`mini-status ${image.tone}`} /></button>)}<button className="recent-thumb add-thumb" title="导入图片"><Plus size={17} /></button></div></div></div>
    </section>

    <section className="bottom-grid"><div className="activity-panel panel"><div className="panel-heading compact"><div><span className="section-kicker">活动</span><h2>最近任务</h2></div><button className="text-link">打开队列 <ArrowUpRight size={13} /></button></div><div className="activity-list">{queue.slice(0, 3).map((item) => <div className="activity-item" key={item.id}><div className={`activity-icon ${item.status}`}><StatusIcon status={item.status} /></div><div className="activity-copy"><strong>{item.title}</strong><span>{item.id} · {item.meta}</span></div><div className="activity-state"><StatusLabel status={item.status} /><small>{item.time}</small></div></div>)}</div></div><div className="health-panel panel"><div className="panel-heading compact"><div><span className="section-kicker">服务状态</span><h2>本地运行健康度</h2></div><span className="healthy-pill"><span />正常</span></div><div className="health-content"><div className="health-ring"><div><strong>98</strong><span>健康分</span></div></div><div className="health-list"><HealthRow label="本地任务引擎" value="运行中" tone="good" /><HealthRow label="本地数据库" value="已连接" tone="good" /><HealthRow label="合规引擎" value="待命" tone="idle" /><HealthRow label="工作区" value="2.4 GB / 20 GB" tone="good" /></div></div></div></section>
  </div>
}

function MetricCard({ label, value, unit, change, icon, tone }: { label: string; value: string; unit: string; change: string; icon: ReactNode; tone: string }) {
  return <div className="metric-card panel"><div className={`metric-icon ${tone}`}>{icon}</div><div className="metric-copy"><span>{label}</span><strong>{value}<small>{unit}</small></strong><em className={tone === 'green' ? 'positive' : ''}>{change}</em></div></div>
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'running' || status === 'queued') return <LoaderCircle size={16} className="spin" />
  if (status === 'done') return <Check size={16} />
  if (status === 'review') return <ShieldCheck size={16} />
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

function QueuePage({ queue, setQueue, onRefresh, onCancel }: { queue: typeof queueSeed; setQueue: Dispatch<SetStateAction<typeof queueSeed>>; onRefresh: () => Promise<void>; onCancel: (jobId: string) => Promise<void> }) {
  const [filter, setFilter] = useState<'全部' | 'running' | 'review' | 'failed'>('全部')
  const [search, setSearch] = useState('')
  const visible = queue.filter((item) => (filter === '全部' || item.status === filter) && (!search.trim() || `${item.title}${item.id}${item.meta}`.toLowerCase().includes(search.trim().toLowerCase())))
  return <div className="page-content inner-page"><section className="page-heading heading-row"><div><div className="eyebrow"><span className="eyebrow-line" />生产监控</div><h1>任务队列</h1><p>查看批次进度、失败原因和需要人工确认的请求。</p></div><div className="heading-actions"><button className="button button-ghost" onClick={() => void onRefresh()}><RefreshCw size={16} />刷新</button><button className="button button-primary" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><Plus size={16} />创建任务</button></div></section><div className="queue-toolbar panel"><div className="filter-tabs"><button className={filter === '全部' ? 'active' : ''} onClick={() => setFilter('全部')}>全部 <span>{queue.length}</span></button><button className={filter === 'running' ? 'active' : ''} onClick={() => setFilter('running')}>运行中 <span>{queue.filter((item) => item.status === 'running').length}</span></button><button className={filter === 'review' ? 'active' : ''} onClick={() => setFilter('review')}>待复核 <span>{queue.filter((item) => item.status === 'review').length}</span></button><button className={filter === 'failed' ? 'active' : ''} onClick={() => setFilter('failed')}>失败 <span>{queue.filter((item) => item.status === 'failed').length}</span></button></div><div className="queue-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索任务名称或编号" /></div></div><div className="queue-list panel">{visible.map((item) => <div className="queue-row" key={item.id}><div className={`queue-status-icon ${item.status}`}><StatusIcon status={item.status} /></div><div className="queue-main"><div className="queue-title-line"><strong>{item.title}</strong><span className="mono">{item.id}</span></div><span>{item.meta}</span><div className="progress-track"><i className={item.status} style={{ width: `${item.progress}%` }} /></div></div><div className="queue-progress"><strong>{item.progress}%</strong><span>{item.time}</span></div><StatusLabel status={item.status} />{(item.status === 'queued' || item.status === 'running') ? <button className="icon-button subtle" title="取消任务" onClick={() => void onCancel(item.id)}><Square size={15} /></button> : <button className="icon-button subtle" title="更多操作"><MoreHorizontal size={17} /></button>}</div>)}</div><div className="queue-footnote"><CircleHelp size={15} />生图接口超时会进入“待确认”，不会自动重复计费请求。</div></div>
}

function GalleryPage({ assets }: { assets: GalleryAsset[] }) {
  const [filter, setFilter] = useState('全部')
  const source = assets.length ? assets : galleryImages
  const visible = filter === '全部' ? source : source.filter((item) => item.tag === filter)
  return <div className="page-content inner-page"><section className="page-heading heading-row"><div><div className="eyebrow"><span className="eyebrow-line" />本地资产</div><h1>生成画廊</h1><p>浏览最近产物，按合规状态快速筛选和打开本地文件。</p></div><div className="heading-actions"><button className="button button-ghost"><FolderOpen size={16} />打开输出目录</button><button className="button button-primary"><DownloadIcon />导入资产</button></div></section><div className="gallery-toolbar"><div className="filter-tabs"><button className={filter === '全部' ? 'active' : ''} onClick={() => setFilter('全部')}>全部 <span>{source.length}</span></button><button className={filter === 'PASS' ? 'active' : ''} onClick={() => setFilter('PASS')}>可用 <span>{source.filter((item) => item.tag === 'PASS').length}</span></button><button className={filter === 'REVIEW' ? 'active' : ''} onClick={() => setFilter('REVIEW')}>待复核 <span>{source.filter((item) => item.tag === 'REVIEW').length}</span></button><button className={filter === 'BLOCK' ? 'active' : ''} onClick={() => setFilter('BLOCK')}>高风险 <span>{source.filter((item) => item.tag === 'BLOCK').length}</span></button></div><div className="gallery-view-toggle"><button className="active" title="网格视图"><LayoutGrid size={16} /></button><button title="列表视图"><ListChecks size={16} /></button></div></div><div className="gallery-grid">{visible.map((image) => <article className="gallery-card" key={`${image.title}-${image.src}`}><div className="gallery-image"><img src={image.src} alt={image.title} /><span className={`gallery-tag ${image.tone}`}>{statusNames[image.tag] ?? image.tag}</span><button className="image-more" title="更多操作"><MoreHorizontal size={17} /></button></div><div className="gallery-card-body"><strong>{image.title}</strong><span>{assets.length ? '本地任务结果' : '演示资产 · 4K 四宫格'}</span></div></article>)}</div></div>
}

function PromptsPage({ selectedPrompt, setSelectedPrompt }: { selectedPrompt: string; setSelectedPrompt: (value: string) => void }) {
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('全部提示词')
  const categoryCounts = useMemo(() => builtinPrompts.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.category]: (counts[item.category] ?? 0) + 1 }), {}), [])
  const categories = ['全部提示词', ...Array.from(new Set(builtinPrompts.map((item) => item.category)))]
  const filtered = builtinPrompts.filter((item) => {
    const matchesCategory = category === '全部提示词' || item.category === category
    const query = search.trim().toLowerCase()
    return matchesCategory && (!query || `${item.title}${item.category}${item.text}`.toLowerCase().includes(query))
  })
  return <div className="page-content inner-page"><section className="page-heading heading-row"><div><div className="eyebrow"><span className="eyebrow-line" />内容资产</div><h1>提示词库</h1><p>已内置参考软件 v2.3.9 的 79 条非空生成提示词，可直接用于工作台。</p></div><button className="button button-primary"><Plus size={16} />新建提示词</button></section><div className="prompt-toolbar"><div className="search-field"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索模板名称、分类或内容" /></div><button className="button button-ghost"><SlidersHorizontal size={16} />筛选</button><button className="button button-ghost"><Archive size={16} />导入库</button></div><div className="prompt-layout"><aside className="category-panel panel"><span className="section-kicker">分类</span>{categories.map((item) => <button className={`category-item ${category === item ? 'active' : ''}`} key={item} onClick={() => setCategory(item)}>{item}<span>{item === '全部提示词' ? builtinPrompts.length : categoryCounts[item] ?? 0}</span></button>)}</aside><div className="prompt-cards">{filtered.map((item) => <article className={`prompt-card panel ${selectedPrompt === item.id ? 'selected' : ''}`} key={item.id} onClick={() => setSelectedPrompt(item.id)}><div className="prompt-card-top"><span className="category-chip">{item.category}</span><button className="icon-button subtle" title="更多操作"><MoreHorizontal size={16} /></button></div><h3>{item.title}</h3><p>{item.text.slice(0, 180)}{item.text.length > 180 ? '…' : ''}</p><div className="prompt-card-footer"><span>{item.layout === 'four_up' ? '4K 四宫格' : item.layout === 'fifteen_up_test' ? '4K 十五宫格测试' : '两宫格'} · 内置</span>{selectedPrompt === item.id ? <span className="selected-label"><Check size={13} />已选中</span> : <button className="text-link">用于工作台 <ArrowUpRight size={13} /></button>}</div></article>)}</div></div></div>
}

function CompliancePage() {
  return <div className="page-content inner-page"><section className="page-heading heading-row"><div><div className="eyebrow"><span className="eyebrow-line" />风险控制</div><h1>合规中心</h1><p>在图片进入裁切和上架前，集中查看初筛结果和人工复核项。</p></div><div className="heading-actions"><button className="button button-ghost"><DownloadIcon />导出报告</button><button className="button button-primary"><ShieldCheck size={16} />开始复核</button></div></section><div className="compliance-metrics"><div className="compliance-stat pass"><span><CheckCircle2 size={16} />可用</span><strong>18</strong><small>低风险，可进入裁切</small></div><div className="compliance-stat review"><span><Clock3 size={16} />待复核</span><strong>04</strong><small>需要人工确认</small></div><div className="compliance-stat block"><span><AlertTriangle size={16} />高风险</span><strong>02</strong><small>高风险，禁止使用</small></div><div className="compliance-stat unknown"><span><CircleHelp size={16} />待确认</span><strong>01</strong><small>模型返回不完整</small></div></div><div className="compliance-layout"><div className="review-table panel"><div className="panel-heading compact"><div><span className="section-kicker">待处理</span><h2>人工复核清单</h2></div><div className="table-actions"><button className="icon-button subtle" title="刷新"><RefreshCw size={16} /></button><button className="icon-button subtle" title="筛选"><SlidersHorizontal size={16} /></button></div></div><div className="table-head"><span>资产</span><span>风险等级</span><span>命中项</span><span>时间</span><span /></div>{galleryImages.filter((image) => image.tag !== 'PASS').map((image, index) => <div className="table-row" key={image.title}><div className="table-asset"><img src={image.src} alt="" /><div><strong>{image.title}</strong><span>run_20260830_00{index + 1}</span></div></div><span className={`risk-pill ${image.tone}`}>{statusNames[image.tag] ?? image.tag}</span><span className="hit-copy">{image.tag === 'BLOCK' ? '品牌/字符疑似命中' : '文字可读性 · 需确认'}</span><span className="table-time">10:{32 - index * 4}</span><button className="button button-small button-ghost">查看</button></div>)}</div><div className="compliance-side panel"><div className="panel-heading compact"><div><span className="section-kicker">策略</span><h2>当前筛查设置</h2></div><button className="icon-button subtle" title="编辑策略"><Settings2 size={16} /></button></div><div className="policy-list"><PolicyRow label="预检" value="已开启" enabled /><PolicyRow label="后检" value="已关闭" enabled={false} /><PolicyRow label="文字识别" value="已开启" enabled /><PolicyRow label="视觉审核模型" value="轻量模式" enabled /><PolicyRow label="高风险阈值" value="70 分" enabled /></div><div className="policy-note"><ShieldCheck size={15} /><span>合规结果是风险初筛，不替代人工版权判断。</span></div></div></div></div>
}

function PolicyRow({ label, value, enabled }: { label: string; value: string; enabled: boolean }) {
  return <div className="policy-row"><span><i className={`health-dot ${enabled ? 'good' : 'idle'}`} />{label}</span><strong>{value}</strong></div>
}

function SettingsModal({ config, onSave, onClose }: { config: ChannelConfig; onSave: (config: ChannelConfig) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(config)
  const [showKey, setShowKey] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const updateDraft = (patch: Partial<ChannelConfig>) => {
    setSaved(false)
    setError('')
    setDraft((current) => ({ ...current, ...patch }))
  }

  const handleSave = () => {
    if (!draft.baseUrl.trim() || !draft.apiKey.trim()) {
      setError('请填写接口地址和 API Key。')
      return
    }
    try {
      const url = new URL(draft.baseUrl)
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported protocol')
    } catch {
      setError('接口地址需填写完整的 http:// 或 https:// 地址。')
      return
    }
    // 原型阶段先更新本地状态；接入 FastAPI 后由同名动作写入 SQLite。
    onSave(draft)
    setSaved(true)
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
                <input id="channel-api-key" type={showKey ? 'text' : 'password'} value={draft.apiKey} onChange={(event) => updateDraft({ apiKey: event.target.value })} placeholder="输入当前通道的 API Key" autoComplete="off" />
                <button className="icon-button subtle" type="button" onClick={() => setShowKey((visible) => !visible)} title={showKey ? '隐藏 API Key' : '显示 API Key'} aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button>
              </div>
              <span className="field-help">密钥仅在本地服务调用时使用，不展示在任务、日志或导出文件中。</span>
            </div>
            {error && <div className="form-error" role="alert"><AlertTriangle size={14} />{error}</div>}
          </div>
          <div className="setting-row">
            <div><strong>输出工作区</strong><span>结果、报告和日志均写入本机</span></div>
            <button className="button button-small button-ghost"><FolderOpen size={14} />选择目录</button>
          </div>
          <div className="setting-row">
            <div><strong>最大并发</strong><span>建议根据供应商配额逐步增加</span></div>
            <div className="number-control compact"><input type="number" defaultValue="4" /><span>线程</span></div>
          </div>
        </div>
        <div className="modal-footer">
          <span className={`save-feedback ${saved ? 'visible' : ''}`} role="status">{saved ? <><CheckCircle2 size={14} />已保存到本地配置</> : '修改后点击保存'}</span>
          <button className="button button-ghost" onClick={onClose}>取消</button>
          <button className="button button-primary" onClick={handleSave}><Check size={16} />保存设置</button>
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
