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

function resizeRgba(source: Uint8Array, sourceWidth: number, sourceHeight: number, targetWidth: number, targetHeight: number): Buffer {
  const target = Buffer.allocUnsafe(targetWidth * targetHeight * 4)
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(sourceHeight - 1, Math.floor(y * sourceHeight / targetHeight))
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(x * sourceWidth / targetWidth))
      const sourceOffset = (sourceY * sourceWidth + sourceX) * 4
      const targetOffset = (y * targetWidth + x) * 4
      target[targetOffset] = source[sourceOffset]
      target[targetOffset + 1] = source[sourceOffset + 1]
      target[targetOffset + 2] = source[sourceOffset + 2]
      target[targetOffset + 3] = source[sourceOffset + 3]
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
