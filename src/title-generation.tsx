import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, BookOpen, CheckCircle2, ChevronDown, Download, FileSpreadsheet, FolderOpen, LoaderCircle, Play, Settings2, Trash2 } from 'lucide-react'
import writeXlsxFile from 'write-excel-file/browser'
import type { Cell } from 'write-excel-file/browser'
import { LOCAL_API_BASE } from './api-base'

// 七个标题类别是结果表与导出文件的列，与后端 title-generation.ts 的 TITLE_CATEGORIES 一一对应。
const TITLE_CATEGORIES = ['浴帘', '地垫', '床上三件套', '扇子', '雨伞', '3/4pcs地垫', '1pc地垫'] as const
type TitleCategory = typeof TITLE_CATEGORIES[number]
type TitleRow = { name: string; titles: Record<TitleCategory, string> }

type TitlePrompt = { id: string; title: string; category: string; text: string; purpose?: string }
type TitleLlmProvider = { id: string; name: string; model: string; enabled: boolean }

type LogEntry = { time: string; message: string; type: 'info' | 'success' | 'error' }

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg'])
const MAX_LOG_ENTRIES = 300

function emptyTitles(): Record<TitleCategory, string> {
  return { 浴帘: '', 地垫: '', 床上三件套: '', 扇子: '', 雨伞: '', '3/4pcs地垫': '', '1pc地垫': '' }
}

function fileExtension(name: string): string {
  const match = name.toLowerCase().match(/\.([a-z0-9]+)$/)
  return match ? match[1] : ''
}

function collectImageFiles(input: HTMLInputElement | null): File[] {
  if (!input?.files) return []
  return Array.from(input.files)
    .filter((file) => IMAGE_EXTENSIONS.has(fileExtension(file.name)))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }))
}

function resolveRpm(raw: string): number {
  const parsed = Number.parseInt(raw, 10)
  if (Number.isNaN(parsed) || parsed <= 0) throw new Error('RPM 必须是大于 0 的整数。')
  return parsed
}

function createRateLimiter(rpm: number) {
  const intervalMs = Math.ceil(60000 / rpm)
  let nextAvailableAt = 0
  return {
    async waitTurn(): Promise<void> {
      const now = Date.now()
      const scheduledAt = Math.max(now, nextAvailableAt)
      nextAvailableAt = scheduledAt + intervalMs
      if (scheduledAt > now) await new Promise((resolve) => window.setTimeout(resolve, scheduledAt - now))
    },
  }
}

function inferMimeType(file: File): string {
  if (file.type === 'image/png' || file.type === 'image/jpeg') return file.type
  return fileExtension(file.name) === 'png' ? 'image/png' : 'image/jpeg'
}

function drawSourceToDataUrl(source: CanvasImageSource, mimeType: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const context = canvas.getContext('2d')
  if (!context) throw new Error('浏览器不支持 Canvas。')
  // JPEG 没有透明通道，先铺白底避免透明区域变黑。
  if (mimeType === 'image/jpeg') {
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, 512, 512)
  }
  context.drawImage(source, 0, 0, 512, 512)
  return canvas.toDataURL(mimeType, 0.92)
}

// 与参考工具一致：先把图片压到 512×512 再上送，减少请求体积。
async function prepareImageData(file: File): Promise<string> {
  if ('createImageBitmap' in window) {
    const bitmap = await createImageBitmap(file)
    try {
      return drawSourceToDataUrl(bitmap, inferMimeType(file))
    } finally {
      if (typeof bitmap.close === 'function') bitmap.close()
    }
  }
  const objectUrl = URL.createObjectURL(file)
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image()
      element.onload = () => resolve(element)
      element.onerror = () => reject(new Error('浏览器无法读取该图片。'))
      element.src = objectUrl
    })
    return drawSourceToDataUrl(image, inferMimeType(file))
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function TitleGenerationPage({ prompts, llmProviders, onOpenModelSettings, onOpenPromptLibrary }: {
  prompts: TitlePrompt[]
  llmProviders: TitleLlmProvider[]
  onOpenModelSettings: () => void
  onOpenPromptLibrary: () => void
}) {
  const folderInputRef = useRef<HTMLInputElement | null>(null)
  const [promptId, setPromptId] = useState('')
  const [rpm, setRpm] = useState('20')
  const [folderCount, setFolderCount] = useState(0)
  const [rows, setRows] = useState<TitleRow[]>([])
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [running, setRunning] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [statusNote, setStatusNote] = useState('等待开始。')
  const [stats, setStats] = useState({ total: 0, completed: 0, success: 0, failed: 0 })
  const [feedback, setFeedback] = useState('')

  const titlePrompts = useMemo(() => prompts.filter((item) => item.purpose === 'title'), [prompts])
  const activeLlm = llmProviders.find((provider) => provider.enabled)
  const selectedPrompt = titlePrompts.find((item) => item.id === promptId) ?? titlePrompts[0]

  // 提示词库变化后（新增/删除）回落到第一条可用项，避免选中已不存在的提示词。
  useEffect(() => {
    if (titlePrompts.length > 0 && !titlePrompts.some((item) => item.id === promptId)) setPromptId(titlePrompts[0].id)
  }, [titlePrompts, promptId])

  useEffect(() => {
    if (!feedback) return
    const timer = window.setTimeout(() => setFeedback(''), 2400)
    return () => window.clearTimeout(timer)
  }, [feedback])

  const appendLog = (message: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    setLogs((entries) => [...entries, { time, message, type }].slice(-MAX_LOG_ENTRIES))
  }

  const clearResults = () => {
    if (running) return
    setRows([])
    setLogs([])
    setStats({ total: 0, completed: 0, success: 0, failed: 0 })
    setStatusNote('等待开始。')
  }

  const startProcessing = async () => {
    if (running) return
    const files = collectImageFiles(folderInputRef.current)
    const prompt = selectedPrompt
    if (!activeLlm) { appendLog('未配置启用的 LLM 供应商，请先到模型设置中配置。', 'error'); return }
    if (!prompt) { appendLog('提示词库中没有可用的商品标题提示词。', 'error'); return }
    if (files.length === 0) { appendLog('请先选择包含图片的文件夹。', 'error'); return }
    let intervalRpm: number
    try { intervalRpm = resolveRpm(rpm) } catch (error) { appendLog(error instanceof Error ? error.message : 'RPM 无效。', 'error'); return }

    setRows([])
    setLogs([])
    setRunning(true)
    const nextStats = { total: files.length, completed: 0, success: 0, failed: 0 }
    setStats(nextStats)
    setStatusNote(`已完成 0/${files.length}，成功 0，失败 0`)
    appendLog(`发现 ${files.length} 张图片，RPM 限制 ${intervalRpm}，使用「${prompt.title}」开始处理。`)

    const resultRows: Array<TitleRow | undefined> = new Array(files.length)
    const limiter = createRateLimiter(intervalRpm)
    // 管线宽度跟随 RPM：RPM 同时是每分钟请求数和同时在飞请求数的上限。
    // 写死管线深度会在 RPM 较高或单次调用较慢时把实际速率压到配置值以下。
    const pipelineSize = Math.max(1, Math.min(files.length, intervalRpm))
    let nextIndex = 0

    const worker = async () => {
      while (true) {
        const index = nextIndex
        nextIndex += 1
        if (index >= files.length) return
        const file = files[index]
        const row: TitleRow = { name: file.name, titles: emptyTitles() }
        try {
          const dataUrl = await prepareImageData(file)
          await limiter.waitTurn()
          const response = await fetch(`${LOCAL_API_BASE}/api/title-generation`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ promptId: prompt.id, image: { data: dataUrl.split(',')[1] ?? '' } }),
          })
          const body = await response.json().catch(() => null) as { titles?: Record<string, string>; error?: { message?: string } } | null
          if (!response.ok || !body?.titles) throw new Error(body?.error?.message || `标题生成失败（HTTP ${response.status}）`)
          for (const category of TITLE_CATEGORIES) row.titles[category] = body.titles[category] ?? ''
          nextStats.success += 1
          appendLog(`[${nextStats.completed + 1}/${nextStats.total}] 完成 ${file.name}`, 'success')
        } catch (error) {
          nextStats.failed += 1
          appendLog(`[${nextStats.completed + 1}/${nextStats.total}] 跳过 ${file.name}：${error instanceof Error ? error.message : String(error)}`, 'error')
        }
        nextStats.completed += 1
        resultRows[index] = row
        setRows(resultRows.filter((item): item is TitleRow => item !== undefined))
        setStats({ ...nextStats })
        setStatusNote(`已完成 ${nextStats.completed}/${nextStats.total}，成功 ${nextStats.success}，失败 ${nextStats.failed}`)
      }
    }

    try {
      await Promise.all(Array.from({ length: pipelineSize }, () => worker()))
      setStatusNote(`处理结束。总计 ${files.length} 张，成功 ${nextStats.success}，失败 ${nextStats.failed}`)
      if (nextStats.success > 0) { appendLog('全部图片处理完成，可以导出 Excel。', 'success'); setFeedback('处理完成，可以导出 Excel') }
    } finally {
      setRunning(false)
    }
  }

  const exportExcel = async () => {
    if (running || exporting) return
    if (rows.length === 0) { appendLog('当前没有可导出的结果。', 'error'); return }
    setExporting(true)
    try {
      const header: Cell[] = ['图片名称', ...TITLE_CATEGORIES].map((value) => ({ value, type: String, fontWeight: 'bold', align: 'center', alignVertical: 'center', wrap: true }))
      const body: Cell[][] = rows.map((row) => [row.name, ...TITLE_CATEGORIES.map((category) => row.titles[category])].map((value) => ({ value, type: String, alignVertical: 'top', wrap: true })))
      const { toFile } = writeXlsxFile([header, ...body], {
        sheet: '商品标题',
        stickyRowsCount: 1,
        columns: [{ width: 26 }, ...TITLE_CATEGORIES.map(() => ({ width: 60 }))],
      })
      await toFile(`商品标题_${formatTimestamp(new Date())}.xlsx`)
      appendLog('Excel 文件已导出。', 'success')
    } catch {
      appendLog('导出 Excel 失败，请重试。', 'error')
    } finally {
      setExporting(false)
    }
  }

  const progress = stats.total === 0 ? 0 : Math.round((stats.completed / stats.total) * 100)

  return <div className="page-content inner-page title-generation-page">
    <section className="page-heading heading-row">
      <div>
        <div className="eyebrow"><span className="eyebrow-line" />内容资产</div>
        <h1>标题生成</h1>
        <p>按七类模板批量生成商品标题并导出 Excel；模型使用模型设置中启用的 LLM 供应商。</p>
      </div>
      <div className="heading-actions">
        <button className="button button-ghost" type="button" onClick={onOpenModelSettings}><Settings2 size={16} />模型设置</button>
      </div>
    </section>

    <section className="panel title-generation-setup">
      <div className="title-generation-grid">
        <div className="setting-field">
          <label htmlFor="title-prompt-select">标题提示词</label>
          {titlePrompts.length > 0
            ? <div className="select-wrap">
              <select id="title-prompt-select" value={selectedPrompt?.id ?? ''} onChange={(event) => setPromptId(event.target.value)} disabled={running}>
                {titlePrompts.map((item) => <option key={item.id} value={item.id}>{item.category} · {item.title}</option>)}
              </select>
              <ChevronDown size={16} />
            </div>
            : <div className="title-generation-inline-empty">提示词库暂无商品标题提示词 <button className="text-link" type="button" onClick={onOpenPromptLibrary}><BookOpen size={13} />去新建</button></div>}
        </div>

        <div className="setting-field">
          <label htmlFor="title-folder-input">图片文件夹</label>
          <button className={`title-generation-folder ${folderCount > 0 ? 'has-files' : ''}`} type="button" disabled={running} aria-label="选择图片文件夹" onClick={() => folderInputRef.current?.click()}>
            <FolderOpen size={15} />
            <span>{folderCount > 0 ? `${folderCount} 张图片` : '未选择文件夹'}</span>
          </button>
          <input
            ref={folderInputRef}
            id="title-folder-input"
            className="gallery-import-input"
            type="file"
            multiple
            accept=".png,.jpg,.jpeg"
            disabled={running}
            // webkitdirectory 让浏览器选择整个文件夹；React 类型定义没有该属性，这里按原样透传。
            {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
            onChange={(event) => setFolderCount(collectImageFiles(event.currentTarget).length)}
          />
        </div>

        <div className="setting-field">
          <label htmlFor="title-rpm-input">RPM（每分钟请求数）</label>
          <input id="title-rpm-input" type="number" min={1} max={600} value={rpm} disabled={running} onChange={(event) => setRpm(event.target.value)} />
        </div>

        <div className="setting-field">
          <label htmlFor="title-provider-status">执行模型</label>
          <div className="title-generation-provider" id="title-provider-status">
            {activeLlm
              ? <><strong>{activeLlm.name}</strong><span className="mono">{activeLlm.model}</span></>
              : <><AlertTriangle size={14} /><span>未配置启用的 LLM 供应商</span></>}
          </div>
        </div>
      </div>

      <div className="title-generation-actions">
        <button className="button button-primary" type="button" disabled={running || !activeLlm || !selectedPrompt} onClick={() => void startProcessing()}>{running ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{running ? '处理中' : '开始处理'}</button>
        <button className="button button-ghost" type="button" disabled={running || exporting || rows.length === 0} onClick={() => void exportExcel()}>{exporting ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}{exporting ? '导出中' : '导出 Excel'}</button>
        <button className="button button-ghost" type="button" disabled={running} onClick={clearResults}><Trash2 size={15} />清空结果</button>
      </div>

      {!activeLlm && <div className="form-error title-generation-error" role="alert"><AlertTriangle size={14} />请先到模型设置中配置并启用一个 LLM 供应商，标题生成才能开始。</div>}

      <div className="metrics-grid title-generation-metrics">
        <div className="metric-card panel"><div className="metric-icon blue"><FileSpreadsheet size={18} /></div><div className="metric-copy"><span>总图片数</span><strong>{stats.total}</strong><em /></div></div>
        <div className="metric-card panel"><div className="metric-icon purple"><LoaderCircle size={18} /></div><div className="metric-copy"><span>已完成</span><strong>{stats.completed}</strong><em /></div></div>
        <div className="metric-card panel"><div className="metric-icon green"><CheckCircle2 size={18} /></div><div className="metric-copy"><span>成功</span><strong>{stats.success}</strong><em className="positive" /></div></div>
        <div className="metric-card panel"><div className="metric-icon orange"><AlertTriangle size={18} /></div><div className="metric-copy"><span>失败</span><strong>{stats.failed}</strong><em /></div></div>
      </div>

      <div className="title-generation-progress">
        <div className="progress-track" role="progressbar" aria-label="标题生成进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></div>
        <p className="title-generation-note">{statusNote}</p>
      </div>
    </section>

    <section className="title-generation-workspace">
      <div className="panel title-generation-panel">
        <div className="panel-heading compact"><div><span className="section-kicker">执行日志</span><h2>进度与错误</h2></div><span className="title-generation-tag">{logs.length} 条</span></div>
        <div className="title-generation-log-list">
          {logs.length === 0
            ? <div className="empty-state panel">还没有日志。开始处理后会在这里显示进度。</div>
            : logs.map((entry, index) => <div className={`title-generation-log ${entry.type === 'success' ? 'is-success' : entry.type === 'error' ? 'is-error' : ''}`} key={index}><strong>{entry.time}</strong>{entry.message}</div>)}
        </div>
      </div>

      <div className="panel title-generation-panel">
        <div className="panel-heading compact"><div><span className="section-kicker">结果预览</span><h2>七类商品标题</h2></div><span className="title-generation-tag">{rows.length} 行</span></div>
        {rows.length === 0
          ? <div className="empty-state panel">处理完成后，这里会显示导出的表格内容预览。</div>
          : <div className="title-generation-table-scroll">
            <table className="title-generation-table">
              <thead><tr><th>图片名称</th>{TITLE_CATEGORIES.map((category) => <th key={category}>{category}</th>)}</tr></thead>
              <tbody>{rows.map((row) => <tr key={row.name}><td className="mono">{row.name}</td>{TITLE_CATEGORIES.map((category) => <td key={category}>{row.titles[category]}</td>)}</tr>)}</tbody>
            </table>
          </div>}
      </div>
    </section>

    {feedback && <div className="toast" role="status"><CheckCircle2 size={14} />{feedback}</div>}
  </div>
}
