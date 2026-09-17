import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { chatEndpoint, chatVision, LlmChatError } from '../dist-server/llm-chat.js'

test('LLM 服务地址按版本段拼接，豆包 /api/v3 不会被多加一层 /v1', () => {
  // 豆包 Ark 的 OpenAI 兼容根地址自带 /v3，旧逻辑会拼成 /api/v3/v1/chat/completions 导致 404。
  assert.equal(chatEndpoint('https://ark.cn-beijing.volces.com/api/v3'), 'https://ark.cn-beijing.volces.com/api/v3/chat/completions')
  assert.equal(chatEndpoint('https://ark.cn-beijing.volces.com/api/v3/'), 'https://ark.cn-beijing.volces.com/api/v3/chat/completions')
  // 只填到主机名或 /v1 的传统 OpenAI 兼容地址仍补 /v1。
  assert.equal(chatEndpoint('https://api.openai.com'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(chatEndpoint('https://api.openai.com/v1'), 'https://api.openai.com/v1/chat/completions')
  // 已填完整端点时原样使用，查询字符串保留。
  assert.equal(chatEndpoint('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/chat/completions')
  assert.equal(chatEndpoint('http://127.0.0.1:8317/v1/chat/completions?trace=1'), 'http://127.0.0.1:8317/v1/chat/completions?trace=1')
  assert.throws(() => chatEndpoint('not-a-url'), (error) => error instanceof LlmChatError && error.code === 'invalid_llm_url')
  assert.throws(() => chatEndpoint('ftp://example.com/v1'), (error) => error instanceof LlmChatError && error.code === 'invalid_llm_url')
})

test('LLM 请求失败时错误信息带上实际请求路径，便于定位地址拼错', async () => {
  const server = createServer((req, res) => { res.statusCode = 404; res.end() })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/api/v3`
    await assert.rejects(
      () => chatVision({ baseUrl, apiKey: 'test-secret', model: 'vision-model' }, '系统提示', '文本', Buffer.from([1, 2, 3])),
      (error) => error.code === 'llm_http_error' && error.message === 'LLM 请求失败（HTTP 404，请求地址 /api/v3/chat/completions）',
    )
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
