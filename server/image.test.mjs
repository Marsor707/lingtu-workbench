import assert from 'node:assert/strict'
import test from 'node:test'
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'
import { pixelUpscaleTo4K } from '../dist-server/image.js'

function pngFixture(width, height) {
  const data = Buffer.alloc(width * height * 4)
  for (let index = 0; index < data.length; index += 4) {
    data[index] = 255
    data[index + 1] = index / 4 % width ? 0 : 255
    data[index + 2] = 0
    data[index + 3] = 255
  }
  return PNG.sync.write({ data, width, height })
}

test('像素放大按最长边 3840 保持比例并输出 PNG', () => {
  const result = pixelUpscaleTo4K(pngFixture(2, 1))
  assert.equal(result.upscaled, true)
  assert.deepEqual([result.sourceWidth, result.sourceHeight, result.targetWidth, result.targetHeight], [2, 1, 3840, 1920])
  const decoded = PNG.sync.read(Buffer.from(result.bytes))
  assert.deepEqual([decoded.width, decoded.height], [3840, 1920])
  assert.deepEqual([...decoded.data.subarray(0, 4)], [255, 255, 0, 255])

  // Lanczos3 在原图边界生成过渡像素，不应退化为最近邻的硬切换。
  const boundaryGreen = decoded.data[(1920 * 4) + 1]
  assert.ok(boundaryGreen > 0 && boundaryGreen < 255)
})

test('JPEG 结果也能放大并统一编码为 PNG', () => {
  const jpegBytes = jpeg.encode({ data: Buffer.from([255, 0, 0, 255]), width: 1, height: 1 }, 90).data
  const result = pixelUpscaleTo4K(jpegBytes)
  assert.equal(result.upscaled, true)
  const decoded = PNG.sync.read(Buffer.from(result.bytes))
  assert.deepEqual([decoded.width, decoded.height], [3840, 3840])
})

test('已达到 4K 或无法识别的格式不改写原始字节', () => {
  const original = Buffer.from('not-an-image')
  const unsupported = pixelUpscaleTo4K(original)
  assert.equal(unsupported.upscaled, false)
  assert.equal(unsupported.reason, 'unsupported_format')
  assert.strictEqual(unsupported.bytes, original)

  const large = pngFixture(3840, 1)
  const unchanged = pixelUpscaleTo4K(large)
  assert.equal(unchanged.upscaled, false)
  assert.equal(unchanged.reason, 'already_4k')
  assert.deepEqual(Buffer.from(unchanged.bytes), large)
})
