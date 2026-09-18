import { Agent, ProxyAgent } from 'undici'

/**
 * 出口分发器：由应用配置决定是否走代理，而不是交给进程环境变量。
 *
 * Node 内置 fetch 只接受与其内部版本一致的 undici Dispatcher，因此这里锁定 undici 7.x；
 * 升级 Node 大版本后必须重新验证（provider.test.mjs 里有走本地 CONNECT 代理的回归测试）。
 */
const proxyAgents = new Map<string, ProxyAgent>()
// 直连也显式给一个 Agent：即使用户环境里存在 NODE_USE_ENV_PROXY，出口仍由应用配置说了算。
const directAgent = new Agent()

export function networkDispatcher(proxyUrl?: string): Agent | ProxyAgent {
  if (!proxyUrl) return directAgent
  const cached = proxyAgents.get(proxyUrl)
  if (cached) return cached
  const agent = new ProxyAgent(proxyUrl)
  proxyAgents.set(proxyUrl, agent)
  return agent
}

/**
 * 组装 fetch 初始化参数。Node 的 fetch 支持 dispatcher，但 tsconfig 引入的 DOM 类型里没有该字段，
 * 所以集中在这里断言一次；所有对外请求都经过它，保证「出口只由应用配置决定」。
 */
export function networkInit(signal?: AbortSignal | null, proxyUrl?: string): RequestInit {
  return { ...(signal ? { signal } : {}), dispatcher: networkDispatcher(proxyUrl) } as RequestInit
}

/** 校验并归一化代理地址；不接受账号密码，避免凭据经由接口回显到前端。 */
export function normalizeProxyUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  let parsed: URL
  try { parsed = new URL(trimmed) } catch { return undefined }
  if (!['http:', 'https:'].includes(parsed.protocol)) return undefined
  if (parsed.username || parsed.password) return undefined
  return trimmed
}

/** 桌面版由 Tauri 注入检测结果；开发环境（npm run backend:dev）没有注入通道，回落到环境变量方便联调。 */
export function detectedSystemProxy(): string | undefined {
  const injected = process.env.LINGTU_SYSTEM_PROXY
  // 注入值为空串表示「确实没有系统代理」，此时不能再回落到环境变量，否则本机残留的
  // HTTPS_PROXY 会变成用户看不见的默认出口。
  if (injected !== undefined) return normalizeProxyUrl(injected)
  return normalizeProxyUrl(process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY)
}
