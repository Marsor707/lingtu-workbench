/**
 * OpenAI 兼容的视觉 LLM 调用底座：图片命名与商品标题生成共用同一套端点拼接、超时和响应解析。
 * 本模块只负责「把图片和文本发给模型并取回文本」，具体提示词与结果校验由调用方负责。
 */
export type LlmChatConfig = { baseUrl: string; apiKey: string; model: string }

export class LlmChatError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message)
  }
}

const DEFAULT_TIMEOUT_MS = 45_000

export function chatEndpoint(baseUrl: string): string {
  let parsed: URL
  try { parsed = new URL(baseUrl) } catch { throw new LlmChatError('invalid_llm_url', 'LLM 服务地址格式无效') }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new LlmChatError('invalid_llm_url', 'LLM 服务地址必须使用 http 或 https')
  const path = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = path.endsWith('/chat/completions') ? path : `${path.endsWith('/v1') ? path : `${path}/v1`}/chat/completions`
  return parsed.toString()
}

export function imageMimeType(bytes: Uint8Array): string {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp'
  return 'image/png'
}

export function responseContent(body: unknown): string {
  const choices = body && typeof body === 'object' && Array.isArray((body as { choices?: unknown }).choices) ? (body as { choices: unknown[] }).choices : []
  const message = choices[0] && typeof choices[0] === 'object' ? (choices[0] as { message?: unknown }).message : undefined
  const content = message && typeof message === 'object' ? (message as { content?: unknown }).content : undefined
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : '').filter(Boolean).join('\n')
  throw new LlmChatError('llm_invalid_response', 'LLM 返回内容缺少 message.content')
}

export async function chatVision(config: LlmChatConfig, system: string, text: string, bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  if (!config.apiKey.trim() || !config.model.trim()) throw new LlmChatError('llm_not_configured', 'LLM 未配置完整')
  const timeoutSignal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  let response: Response
  try {
    response = await fetch(chatEndpoint(config.baseUrl), {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model.trim(),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:${imageMimeType(bytes)};base64,${Buffer.from(bytes).toString('base64')}` } },
            { type: 'text', text },
          ] },
        ],
      }),
      signal: requestSignal,
    })
  } catch (error) {
    if (timeoutSignal.aborted && !signal?.aborted) throw new LlmChatError('llm_timeout', 'LLM 请求超时')
    if (signal?.aborted) throw new DOMException('LLM 请求已取消', 'AbortError')
    throw new LlmChatError('llm_network_error', 'LLM 网络请求失败')
  }
  if (!response.ok) throw new LlmChatError('llm_http_error', `LLM 请求失败（HTTP ${response.status}）`, response.status)
  let body: unknown
  try { body = await response.json() } catch { throw new LlmChatError('llm_invalid_response', 'LLM 返回不是有效 JSON') }
  return responseContent(body)
}
