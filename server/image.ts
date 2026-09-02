import { PNG } from 'pngjs'
import * as jpeg from 'jpeg-js'

export const PIXEL_UPSCALE_TARGET_LONG_EDGE = 3840

export type PixelUpscaleResult = {
  bytes: Uint8Array
  format: 'png' | 'jpeg' | 'unsupported'
  sourceWidth?: number
  sourceHeight?: number
  targetWidth?: number
  targetHeight?: number
  upscaled: boolean
  reason?: 'already_4k' | 'unsupported_format' | 'decode_failed'
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

type ResizeContribution = { indices: number[]; weights: number[] }

function sinc(value: number): number {
  if (value === 0) return 1
  const piValue = Math.PI * value
  return Math.sin(piValue) / piValue
}

function lanczos3(value: number): number {
  const distance = Math.abs(value)
  return distance >= 3 ? 0 : sinc(value) * sinc(value / 3)
}

function resizeContributions(sourceSize: number, targetSize: number): ResizeContribution[] {
  const scale = targetSize / sourceSize
  const contributions: ResizeContribution[] = []
  for (let targetIndex = 0; targetIndex < targetSize; targetIndex += 1) {
    const sourceCenter = (targetIndex + 0.5) / scale - 0.5
    const first = Math.ceil(sourceCenter - 3)
    const last = Math.floor(sourceCenter + 3)
    const weightsByIndex = new Map<number, number>()
    for (let sourceIndex = first; sourceIndex <= last; sourceIndex += 1) {
      const clampedIndex = Math.max(0, Math.min(sourceSize - 1, sourceIndex))
      weightsByIndex.set(clampedIndex, (weightsByIndex.get(clampedIndex) ?? 0) + lanczos3(sourceCenter - sourceIndex))
    }
    const totalWeight = [...weightsByIndex.values()].reduce((sum, weight) => sum + weight, 0)
    contributions.push({
      indices: [...weightsByIndex.keys()],
      weights: [...weightsByIndex.values()].map((weight) => weight / totalWeight),
    })
  }
  return contributions
}

function resizeRgba(source: Uint8Array, sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): Buffer {
  const horizontal = resizeContributions(sourceWidth, targetWidth)
  const vertical = resizeContributions(sourceHeight, targetHeight)
  const intermediate = new Float32Array(targetWidth * sourceHeight * 4)

  // Lanczos3 是可分离滤波器，先横向再纵向，避免为每个输出像素重复计算二维权重。
  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const contribution = horizontal[x]
      const targetOffset = (y * targetWidth + x) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        let value = 0
        for (let sample = 0; sample < contribution.indices.length; sample += 1) {
          const sourceOffset = (y * sourceWidth + contribution.indices[sample]) * 4 + channel
          value += source[sourceOffset] * contribution.weights[sample]
        }
        intermediate[targetOffset + channel] = Math.max(0, Math.min(255, value))
      }
    }
  }

  const target = Buffer.allocUnsafe(targetWidth * targetHeight * 4)
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const contribution = vertical[y]
      const targetOffset = (y * targetWidth + x) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        let value = 0
        for (let sample = 0; sample < contribution.indices.length; sample += 1) {
          const sourceOffset = (contribution.indices[sample] * targetWidth + x) * 4 + channel
          value += intermediate[sourceOffset] * contribution.weights[sample]
        }
        target[targetOffset + channel] = Math.max(0, Math.min(255, Math.round(value)))
      }
    }
  }
  return target
}

function targetSize(width: number, height: number): { width: number; height: number } | undefined {
  const longEdge = Math.max(width, height)
  if (!Number.isFinite(longEdge) || longEdge <= 0 || longEdge >= PIXEL_UPSCALE_TARGET_LONG_EDGE) return undefined
  const scale = PIXEL_UPSCALE_TARGET_LONG_EDGE / longEdge
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export function pixelUpscaleTo4K(input: Uint8Array): PixelUpscaleResult {
  if (!isPng(input) && !isJpeg(input)) {
    return { bytes: input, format: 'unsupported', upscaled: false, reason: 'unsupported_format' }
  }

  try {
    const decoded = isPng(input)
      ? (() => {
          const image = PNG.sync.read(Buffer.from(input))
          return { data: image.data, width: image.width, height: image.height, format: 'png' as const }
        })()
      : (() => {
          const image = jpeg.decode(Buffer.from(input), { useTArray: true })
          return { data: image.data, width: image.width, height: image.height, format: 'jpeg' as const }
        })()
    const next = targetSize(decoded.width, decoded.height)
    if (!next) return { bytes: input, format: decoded.format, sourceWidth: decoded.width, sourceHeight: decoded.height, upscaled: false, reason: 'already_4k' }
    const data = resizeRgba(decoded.data, decoded.width, decoded.height, next.width, next.height)
    const png = new PNG({ width: next.width, height: next.height, colorType: 6 })
    png.data = data
    const output = PNG.sync.write(png)
    return { bytes: output, format: decoded.format, sourceWidth: decoded.width, sourceHeight: decoded.height, targetWidth: next.width, targetHeight: next.height, upscaled: true }
  } catch {
    // 供应商返回的内容可能不是完整图片；保留原始字节，任务结果仍可供用户诊断。
    return { bytes: input, format: 'unsupported', upscaled: false, reason: 'decode_failed' }
  }
}
