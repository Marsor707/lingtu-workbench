export type GenerationRequest = {
  baseUrl: string
  apiKey: string
  prompt: string
  size?: string
  quality?: string
  signal?: AbortSignal
}

export type EditImageRequest = {
  baseUrl: string
  apiKey: string
  prompt: string
  sourceImage: { data: string; mimeType: string; name: string }
  size?: string
  quality?: string
  signal?: AbortSignal
}

export type GenerationResult = {
  kind: 'base64' | 'url'
  value: string
}

export class ProviderError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) {
    super(message)
  }
}

function endpoint(baseUrl: string, resource: 'generations' | 'edits'): string {
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new ProviderError('invalid_provider_url', 'Provider 地址格式无效')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ProviderError('invalid_provider_url', 'Provider 地址必须使用 http 或 https')
  }
  const path = parsed.pathname.replace(/\/+$/, '')
  parsed.pathname = `${path.endsWith('/v1') ? path : `${path}/v1`}/images/${resource}`
  return parsed.toString()
}

async function parseImageResponse(response: Response): Promise<GenerationResult> {
  if (!response.ok) {
    // 错误信息不拼接响应原文，避免 Provider 回显凭据或用户提示词。
    throw new ProviderError('provider_http_error', `Provider 请求失败（HTTP ${response.status}）`, response.status)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new ProviderError('provider_invalid_response', 'Provider 返回不是有效 JSON')
  }
  const first = body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
    ? (body as { data: unknown[] }).data[0]
    : undefined
  if (!first || typeof first !== 'object') throw new ProviderError('provider_invalid_response', 'Provider 响应缺少图片数据')

  const item = first as { b64_json?: unknown; url?: unknown }
  if (typeof item.b64_json === 'string' && item.b64_json.length > 0) return { kind: 'base64', value: item.b64_json }
  if (typeof item.url === 'string' && item.url.length > 0) return { kind: 'url', value: item.url }
  throw new ProviderError('provider_invalid_response', 'Provider 响应缺少图片内容')
}

export async function generateImage(request: GenerationRequest): Promise<GenerationResult> {
  if (!request.apiKey.trim()) throw new ProviderError('provider_not_configured', '未配置生图 API Key')
  if (!request.prompt.trim()) throw new ProviderError('invalid_prompt', '生图提示词不能为空')

  const response = await fetch(endpoint(request.baseUrl, 'generations'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${request.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt: request.prompt.trim(),
      ...(request.size ? { size: request.size } : {}),
      ...(request.quality ? { quality: request.quality } : {}),
      response_format: 'b64_json',
      n: 1,
    }),
    signal: request.signal,
  })

  return parseImageResponse(response)
}

export async function editImage(request: EditImageRequest): Promise<GenerationResult> {
  if (!request.apiKey.trim()) throw new ProviderError('provider_not_configured', '未配置生图 API Key')
  if (!request.prompt.trim()) throw new ProviderError('invalid_prompt', '改图提示词不能为空')
  if (!request.sourceImage.data || !request.sourceImage.mimeType || !request.sourceImage.name) {
    throw new ProviderError('invalid_source_image', '改图必须提供源图片')
  }

  const form = new FormData()
  form.append('model', 'gpt-image-2')
  form.append('prompt', request.prompt.trim())
  form.append('image', new Blob([Uint8Array.from(Buffer.from(request.sourceImage.data, 'base64'))], { type: request.sourceImage.mimeType }), request.sourceImage.name)
  if (request.size) form.append('size', request.size)
  if (request.quality) form.append('quality', request.quality)
  form.append('response_format', 'b64_json')
  form.append('n', '1')

  const response = await fetch(endpoint(request.baseUrl, 'edits'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${request.apiKey}`,
    },
    body: form,
    signal: request.signal,
  })

  return parseImageResponse(response)
}
