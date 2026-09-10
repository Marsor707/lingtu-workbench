import { LlmChatError, chatVision } from './llm-chat.js'
import type { LlmChatConfig } from './llm-chat.js'

export type ImageNamingConfig = LlmChatConfig

// 图片命名的错误类型与通用 LLM 调用共用同一个类，既有调用点的 instanceof 判断继续成立。
export { LlmChatError as ImageNamingError }
const ImageNamingError = LlmChatError

const IMAGE_NAMING_PROMPT = `
你是一名电商图片命名助手。请根据图片内容生成一个适合作为图片文件名的中文电商标题。

命名参考以下业务模板：
1. 浴帘：4件装，180*180浴帘+3pcs地垫，A浴帘套装，B浴室装饰，浴室配件包括浴室地垫、U型垫、马桶盖套、带挂钩的浴帘，C。
2. 地垫：3pcs 2D flat法兰绒A节B图案浴室垫套装，套装包含45*75cm地垫+U型垫+马桶盖套，点塑底，可做节日礼物；没有节日时不要添加节日。
3. 床上三件套：3pcs床上用品风格B图案，C节日涤纶数码印花被套套装，不含填充，面料柔软舒适，适合卧室、酒店、旅馆、学校宿舍。
4. 扇子：1pc，7英寸A手持折叠扇，B印花，便携降温扇子，塑料骨涤纶扇面，2D Flat Printing精美印花，可折叠设计，适合随身携带，C。A为风格/主题，B为颜色图案，C为场景/节日/用途。
5. 雨伞：1pc，A便携折叠伞，B图案晴伞，2D Flat Printing精美艺术印花，防晒防紫外线黑胶涂层，加固8骨防风骨架，轻巧便携设计，C。A为风格/主题，B为颜色图案，C为场景/节日/用途。
6. 3/4pcs地垫：3/4pcs，A图案地垫，B家居地垫套装，包含马桶盖套、马桶垫、洗漱台垫，4pcs额外包含厨房垫，点塑底防滑，适合浴室、厨房等多场景。
7. 1pc地垫：1pc，A图案地垫，B家居地垫，多尺寸可选，点塑底防滑，适合浴室、厨房等多场景。

标题应优先描述图片中明确可见的产品类型、主题风格、颜色、图案和适用场景；不要臆造图片中不可见的规格、材质或功能。只生成一个最匹配图片的标题，不要生成七个分类标题。不要出现儿童、品牌名称、特殊专有名称、营销夸张词或无法从图片确认的内容。标题简洁、可读、适合作为文件名，建议不超过 80 个汉字。

只返回一个 JSON 对象，不要 Markdown、代码块或额外解释。
JSON 格式必须严格为：{"name":"图片标题"}
`.trim()

function parseName(content: string): string {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch {
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) throw new ImageNamingError('llm_invalid_response', 'LLM 返回内容不是有效 JSON')
    try { parsed = JSON.parse(match[0]) } catch { throw new ImageNamingError('llm_invalid_response', 'LLM 返回内容不是有效 JSON') }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ImageNamingError('llm_invalid_response', 'LLM 返回 JSON 不是对象')
  const value = (parsed as Record<string, unknown>).name ?? (parsed as Record<string, unknown>)['图片名称'] ?? (parsed as Record<string, unknown>).title
  if (typeof value !== 'string' || !value.trim()) throw new ImageNamingError('llm_invalid_response', 'LLM 返回 JSON 缺少图片名称')
  return value.trim().replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').slice(0, 160)
}

export async function nameImage(config: ImageNamingConfig, bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  return parseName(await chatVision(config, '你是专业的电商图片命名助手。', IMAGE_NAMING_PROMPT, bytes, signal))
}

export function sanitizeImageName(value: string): string | undefined {
  const safe = value.trim().replace(/\.(?:png|jpe?g|webp)$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').replace(/[. ]+$/g, '').slice(0, 120).trim()
  if (!safe || safe === '.' || safe === '..') return undefined
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(safe)) return undefined
  return safe
}
