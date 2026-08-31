import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'node:http'
import { editImage, generateImage, ProviderError } from '../dist-server/provider.js'

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

after(async () => {
  await new Promise((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()))
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
    response_format: 'b64_json',
    n: 1,
  })
})

test('Provider 未配置 Key 时在本地校验失败', async () => {
  await assert.rejects(
    generateImage({ baseUrl: `http://127.0.0.1:${port}`, apiKey: '', prompt: '测试' }),
    (error) => error instanceof ProviderError && error.code === 'provider_not_configured',
  )
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
})
