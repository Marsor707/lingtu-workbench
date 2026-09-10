import { LlmChatError, chatVision } from './llm-chat.js'
import type { LlmChatConfig } from './llm-chat.js'

// 商品标题生成的固定七个输出槽位，同时也是结果表与导出文件的列。顺序与提示词中的 JSON 契约一致。
export const TITLE_CATEGORIES = ['浴帘', '地垫', '床上三件套', '扇子', '雨伞', '3/4pcs地垫', '1pc地垫'] as const
export type TitleCategory = typeof TITLE_CATEGORIES[number]
export type TitleResult = Record<TitleCategory, string>

// 提示词用途取值之一：与生图提示词共库但用途分离，只有该用途的提示词会出现在标题生成页面。
export const TITLE_PROMPT_PURPOSE = 'title'

// 参考「豆包命名工具 9.4」的七类标题模板提示词，作为内置资产首次初始化写入提示词库，用户可继续编辑。
export const TITLE_PROMPT_TEXT = `
我是一名电商从业者，销售浴帘，地垫，床上三件套，扇子，雨伞。我会给到你标题模版例子，我需要让你根据我提供的图片，帮我写标题的名字，我有标题的模版，只有几个地方需要你来概述照片。
1.浴帘标题模版：比如这个标题的就是：\`Printed Design–Not Textured 4件装浴帘，情人节浴帘套装，高级红色背景金色爱心印花浴室装饰，浴室配件包括1pc shower curtain 180*180cm + 3pcs mat 38*44cm + 38*45cm + 45*75 cm，带挂钩的浴帘，情人节、情人节装饰。\`，因此模版是：\`Printed Design–Not Textured 4件装浴帘，"A" 浴帘套装，"B"浴室装饰，浴室配件包括1pc shower curtain 180*180cm + 3pcs mat 38*44cm + 38*45cm + 45*75 cm，带挂钩的浴帘，"C"。\`，你需要帮我填 ABC的内容，生成最终标题的名字。
2.地垫标题模版：比如这个标题的就是：\`3pcs 2D flat 法兰绒母亲节粉红色玫瑰花图案浴室垫套装，套装包含 45*75cm地垫+U型垫+马桶盖套 ，点塑底 ，可做节日礼物\`，因此模版是：\`3pcs 2D flat法兰绒A节B图案浴室垫套装，套装包含 45*75cm地垫+U型垫+马桶盖套 ， 点塑底，可做节日礼物。\`，所以你需要帮我填 AB的内容，生成的标题数量不要少，无节日不要写，顺序不要乱。
3.床上三件套模版：比如这个标题的就是：\`(2D)3pcs床上用品温馨简约风格动物蝴蝶与植物花卉图案，情人节涤纶数码印花被套套装不含填充面料柔软舒适，适合卧室、酒店、旅馆、学校宿舍（1件被套+2件枕套）可做节日礼物.\`，因此模版是：\`(2D)3pcs床上用品风格B图案，C节日涤纶数码印花被套套装不含填充面料柔软舒适，适合卧室、酒店、旅馆、学校宿舍（1件被套+2件枕套）可做节日礼物.\`，你需要帮我填 ABC的内容，生成最终标题的名字。
4.扇子标题模版：比如这个标题的就是：\`1pc，7英寸复古花卉手持折叠扇，红色玫瑰印花，便携降温扇子，塑料骨涤纶扇面，2D Flat Printing精美印花，可折叠设计，适合随身携带，夏日户外。\`，因此模版是：\`1pc，7英寸"A"手持折叠扇，"B"印花，便携降温扇子，塑料骨涤纶扇面，2D Flat Printing精美印花，可折叠设计，适合随身携带，"C"。\`，你需要帮我填 ABC处的内容，A对应内容为产品风格/主题名称如：复古花卉、夏日清凉、中式古风、婚礼伴手礼；B对应内容为设计特点/颜色图案如：绿色碎花图案、红色玫瑰印花、金色爱心图案；C对应内容为适用场景/节日/用途如：夏日户外、婚礼派对、母亲节礼物、舞蹈表演、情人节装饰。根据实际的产品图填好对应ABC处的内容生成最终标题的名字。
5.雨伞模版：比如这个标题的就是：\`Printed Design – Not Textured 1pc，向日葵大象便携折叠伞，绿色背景向日葵花环大象图案伞， 精美艺术印花，防晒防紫外线黑胶涂层，加固8骨防风骨架，轻巧便携设计，日常通勤、户外旅行、生日礼物、母亲节、便利出行。\`，因此模版是：\`Printed Design – Not Textured 1pc，"A"便携折叠伞，"B"图案伞，精美艺术印花，防晒防紫外线黑胶涂层，加固8骨防风骨架，轻巧便携设计，"C"。\`，你需要帮我填 ABC处的内容，A对应内容为产品风格/主题名称，B对应内容为设计特点/颜色图案；C对应内容为适用场景/节日/用途如：日常通勤，户外旅行，生日礼物，母亲节，便利出行。根据实际的产品图填好对应ABC处的内容生成最终标题的名字。
6.3/4pcs地垫模版：比如这个标题的就是：\`(2D)3/4pcs,向日葵大象图案地垫，绿色背景向日葵花环大象家居地垫套装，包含马桶盖套，马桶垫，洗漱台垫，4pcs额外包含厨房垫，点塑底防滑，家居装饰地垫，适合浴室，厨房等多场景使用。\`，因此模版是：\`(2D)3/4pcs,"A"图案地垫，"B"家居地垫套装，包含马桶盖套，马桶垫，洗漱台垫，4pcs额外包含厨房垫，点塑底防滑，家居装饰地垫，适合浴室，厨房等多场景使用。\`，你需要帮我填 AB处的内容，A对应内容为产品风格/主题名称，B对应内容为设计特点/颜色图案，根据实际的产品图填好对应AB处的内容生成最终标题的名字。
7.1pc地垫模版：比如这个标题的就是：\`(2D)1pc,向日葵大象图案地垫，绿色背景向日葵花环大象家居地垫，多尺寸可选，点塑底防滑，家居装饰地垫，适合浴室，厨房等多场景使用。\`，因此模版是：\`(2D)1pc,"A"图案地垫，"B"家居地垫，多尺寸可选，点塑底防滑，家居装饰地垫，适合浴室，厨房等多场景使用。\`，你需要帮我填 AB处的内容，A对应内容为产品风格/主题名称，B对应内容为设计特点/颜色图案，根据实际的产品图填好对应AB处的内容生成最终标题的名字。
请将生成的模版按照浴帘，地垫，床上三件套，扇子，雨伞，3/4pcs地垫，1pc地垫七个类别整理后以JSON的格式输出，注意每个模版生成1个标题名称，不要出现儿童，品牌名称，特殊专有名称。
输出时只允许返回一个 JSON 对象，不要输出 Markdown，不要输出代码块，不要输出额外解释。
JSON 格式必须严格如下：
{
  "浴帘": "标题内容",
  "地垫": "标题内容",
  "床上三件套": "标题内容",
  "扇子": "标题内容",
  "雨伞": "标题内容",
  "3/4pcs地垫": "标题内容",
  "1pc地垫": "标题内容"
}
`.trim()

export const builtinTitlePrompt = {
  id: 'lingtu-title-seven-categories-000',
  category: '商品标题',
  title: '七类商品标题生成',
  text: TITLE_PROMPT_TEXT,
  layout: '',
  purpose: TITLE_PROMPT_PURPOSE,
  sourceName: '豆包命名工具9.4',
}

function parseTitles(content: string): TitleResult {
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  let parsed: unknown
  try { parsed = JSON.parse(cleaned) } catch {
    const match = cleaned.match(/\{[\s\S]*\}/)
    if (!match) throw new LlmChatError('title_invalid_response', '模型返回内容不是有效 JSON')
    try { parsed = JSON.parse(match[0]) } catch { throw new LlmChatError('title_invalid_response', '模型返回内容不是有效 JSON') }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new LlmChatError('title_invalid_response', '模型返回的 JSON 不是对象')
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record)
  // 七个标题类别是结果表的列，提示词可编辑也不能改变输出契约；缺项或多出类别都判该图失败。
  if (keys.length !== TITLE_CATEGORIES.length || keys.some((key) => !(TITLE_CATEGORIES as readonly string[]).includes(key))) {
    throw new LlmChatError('title_invalid_response', '模型返回的标题类别与约定不一致')
  }
  const result = {} as TitleResult
  for (const category of TITLE_CATEGORIES) {
    const value = record[category]
    if (typeof value !== 'string' || !value.trim()) throw new LlmChatError('title_invalid_response', `模型返回的「${category}」标题为空`)
    result[category] = value.trim().replace(/\s+/g, ' ')
  }
  return result
}

export async function generateTitles(config: LlmChatConfig, promptText: string, bytes: Uint8Array, signal?: AbortSignal): Promise<TitleResult> {
  if (!promptText.trim()) throw new LlmChatError('title_prompt_empty', '标题提示词正文为空')
  return parseTitles(await chatVision(config, '你是一个专业的电商标题生成助手。', promptText, bytes, signal))
}
