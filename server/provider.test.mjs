import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'node:http'
import { DEFAULT_PROVIDER_TIMEOUT_MS, editImage, generateImage, materializeImageResult, ProviderError } from '../dist-server/provider.js'

const requests = []
const mock = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const bodyText = Buffer.concat(chunks).toString()
  requests.push({ url: req.url, headers: req.headers, body: req.headers['content-type']?.startsWith('application/json') ? JSON.parse(bodyText) : bodyText })
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ data: [{ b64_json: 'ZmFrZS1pbWFnZQ==' }] }))
})
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
const port = mock.address().port

const imageResult = createServer((req, res) => {
  if (req.url === '/result.png') {
    res.setHeader('content-type', 'image/png')
    res.end(Buffer.from('fake-image'))
    return
  }
  res.statusCode = 404
  res.end()
})
await new Promise((resolve) => imageResult.listen(0, '127.0.0.1', resolve))
const imageResultPort = imageResult.address().port

after(async () => {
  await new Promise((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()))
  await new Promise((resolve, reject) => imageResult.close((error) => error ? reject(error) : resolve()))
})

test('Provider 发送 OpenAI 兼容请求并解析 base64 图片', async () => {
  const result = await generateImage({
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey: 'test-secret',
    prompt: '一张测试图片',
    size: '1024x1024',
    quality: 'high',
  })
  assert.deepEqual(result, { kind: 'base64', value: 'ZmFrZS1pbWFnZQ==' })
  assert.equal(requests[0].headers.authorization, 'Bearer test-secret')
  assert.deepEqual(requests[0].body, {
    model: 'gpt-image-2',
    prompt: '一张测试图片',
    size: '1024x1024',
    quality: 'high',
    n: 1,
  })
})

test('Provider 未配置 Key 时在本地校验失败', async () => {
  await assert.rejects(
    generateImage({ baseUrl: `http://127.0.0.1:${port}`, apiKey: '', prompt: '测试' }),
    (error) => error instanceof ProviderError && error.code === 'provider_not_configured',
  )
})

test('Provider 默认请求超时为 3 分钟', () => {
  assert.equal(DEFAULT_PROVIDER_TIMEOUT_MS, 180000)
})

test('Provider 主请求网络异常时返回可诊断错误码', async () => {
  await assert.rejects(
    generateImage({ baseUrl: 'http://127.0.0.1:1', apiKey: 'test-secret', prompt: '网络异常测试' }),
    (error) => error instanceof ProviderError && error.code === 'provider_network_error',
  )
})

test('Provider 返回图片 URL 时下载为可落盘的图片字节', async () => {
  const bytes = await materializeImageResult({ kind: 'url', value: `http://127.0.0.1:${imageResultPort}/result.png` })
  assert.deepEqual(Buffer.from(bytes), Buffer.from('fake-image'))
})

test('Provider 图片 URL 响应体读取异常时返回下载错误码', async () => {
  const originalFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => ({
    ok: true,
    headers: { get: () => 'image/png' },
    arrayBuffer: async () => { attempts += 1; throw new Error('response body terminated') },
  })
  try {
    await assert.rejects(
      materializeImageResult({ kind: 'url', value: 'https://provider.example/result.png' }),
      (error) => error instanceof ProviderError && error.code === 'provider_result_download_failed',
    )
    assert.equal(attempts, 4)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Provider 图片 URL 非成功响应后最多重试三次并在重试成功时返回图片', async () => {
  const originalFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    if (attempts < 4) return { ok: false, status: 503, headers: { get: () => 'text/plain' } }
    return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => Buffer.from('retry-image') }
  }
  try {
    const bytes = await materializeImageResult({ kind: 'url', value: 'https://provider.example/result.png' })
    assert.deepEqual(Buffer.from(bytes), Buffer.from('retry-image'))
    assert.equal(attempts, 4)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Provider 图片 URL 下载异常三次后返回最后一次下载错误', async () => {
  const originalFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    throw new Error(`network failure ${attempts}`)
  }
  try {
    await assert.rejects(
      materializeImageResult({ kind: 'url', value: 'https://provider.example/result.png' }),
      (error) => error instanceof ProviderError && error.code === 'provider_result_download_failed' && error.detail?.includes('network failure 4'),
    )
    assert.equal(attempts, 4)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Provider base64 图片不触发 URL 下载重试', async () => {
  const originalFetch = globalThis.fetch
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    throw new Error('不应下载 base64 结果')
  }
  try {
    const bytes = await materializeImageResult({ kind: 'base64', value: 'ZmFrZS1pbWFnZQ==' })
    assert.deepEqual(Buffer.from(bytes), Buffer.from('fake-image'))
    assert.equal(attempts, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Provider 图片下载被调用方取消时不重试', async () => {
  const originalFetch = globalThis.fetch
  const controller = new AbortController()
  let attempts = 0
  globalThis.fetch = async () => {
    attempts += 1
    controller.abort()
    throw new DOMException('任务已取消', 'AbortError')
  }
  try {
    await assert.rejects(
      materializeImageResult({ kind: 'url', value: 'https://provider.example/result.png' }, controller.signal),
      (error) => error instanceof DOMException && error.name === 'AbortError',
    )
    assert.equal(attempts, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('Provider 已包含 v1 路径时不会重复拼接', async () => {
  await generateImage({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'test-secret',
    prompt: '路径测试',
  })
  assert.equal(requests.at(-1).body.prompt, '路径测试')
})

test('Provider 使用 multipart 调用改图接口并上传源图片', async () => {
  const result = await editImage({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: 'test-secret',
    prompt: '把背景改成蓝色',
    sourceImage: { data: 'ZmFrZS1pbWFnZQ==', mimeType: 'image/png', name: 'source.png' },
    size: '1024x1024',
    quality: 'high',
  })
  assert.deepEqual(result, { kind: 'base64', value: 'ZmFrZS1pbWFnZQ==' })
  const request = requests.at(-1)
  assert.equal(request.url, '/v1/images/edits')
  assert.equal(request.headers.authorization, 'Bearer test-secret')
  assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/)
  assert.match(request.body, /name="model"/)
  assert.match(request.body, /name="prompt"/)
  assert.match(request.body, /把背景改成蓝色/)
  assert.match(request.body, /filename="source\.png"/)
  assert.match(request.body, /name="image"/)
  assert.match(request.body, /fake-image/)
  assert.doesNotMatch(request.body, /name="response_format"/)
})
