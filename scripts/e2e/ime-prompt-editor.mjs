// 回归检查：改图 / 文生图 / 一裂多 三处「放大编辑」抽屉内的中文输入法输入。
//
// 背景（缺陷根因，勿删）：
//   ProviderSheet 的 effect 原先依赖 [open, onClose]。onClose 多为内联箭头函数，每次渲染都是
//   新引用；抽屉内每次按键都会更新提示词状态 -> 重渲染 -> effect 重跑 -> 清理函数把焦点送回触发
//   按钮。输入法的组合上下文在 blur 时被提交，于是「敲一个字、焦点跳走一次」，中文无法正常上屏。
//   修复方式是把 onClose 放进 ref，effect 只依赖 [open]。
//
// 运行前置：
//   1) 先启动前端：npm run dev（默认 http://localhost:5173，端口被占用时会顺延）
//   2) 需要 Playwright。仓库当前未声明该依赖，可临时用全局安装：
//        npm i -g @playwright/cli
//      并通过 PW_MODULE 指向其 playwright 入口，例如：
//        PW_MODULE=/path/to/node_modules/playwright/index.mjs \
//        CHROME_PATH=/path/to/chrome-headless-shell \
//        BASE_URL=http://localhost:5174 node scripts/e2e/ime-prompt-editor.mjs
//
// 断言要点：中文必须真的上屏，且输入期间 blur 次数为 0（核心缺陷信号）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const BASE = process.env.BASE_URL || 'http://localhost:5173'
const MARK = '中中中中中'

// Playwright 既可能是本地依赖，也可能来自全局安装，这里按顺序尝试。
async function loadPlaywright() {
  const candidates = [
    process.env.PW_MODULE,
    'playwright',
  ].filter(Boolean)
  const require = createRequire(import.meta.url)
  for (const candidate of candidates) {
    try {
      const resolved = candidate.startsWith('/') || candidate.startsWith('.')
        ? pathToFileURL(candidate).href
        : candidate
      return await import(resolved)
    } catch {
      try { return await import(pathToFileURL(require.resolve(candidate)).href) } catch { /* 继续尝试下一个 */ }
    }
  }
  console.error('未找到 Playwright。请先安装：npm i -D playwright && npx playwright install chromium')
  process.exit(2)
}

const { chromium } = await loadPlaywright()
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) })

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  ok ? pass++ : fail++
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

async function newPage() {
  const page = await browser.newPage()
  page.on('pageerror', (error) => console.log('  PAGEERROR', String(error)))
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1400)
  return page
}

// 逐字输入中文并统计期间失焦次数：不假设输入框初值，改用「长度增长 + 标记串」判断是否上屏。
async function typeChinese(page, cdp, selector) {
  const area = page.locator(selector).first()
  await area.click()
  await page.waitForTimeout(250)
  const before = await area.inputValue()
  await page.evaluate(() => {
    window.__blurCount = 0
    window.__blurHandler = () => window.__blurCount++
    document.addEventListener('blur', window.__blurHandler, true)
  })
  for (let index = 0; index < MARK.length; index++) {
    await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
    await page.waitForTimeout(80)
    await cdp.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 })
    await page.waitForTimeout(80)
    await cdp.send('Input.insertText', { text: '中' })
    await page.waitForTimeout(170)
  }
  const after = await area.inputValue()
  const blur = await page.evaluate(() => {
    document.removeEventListener('blur', window.__blurHandler, true)
    return window.__blurCount
  })
  return { before, after, blur, grew: after.length - before.length, committed: after.includes(MARK) }
}

async function scenario(label, tab, options = {}) {
  console.log(`\n【${label}】`)
  const page = await newPage()
  const cdp = await page.context().newCDPSession(page)
  await page.getByRole('tab', { name: new RegExp(tab) }).first().click()
  await page.waitForTimeout(500)
  if (options.prepare) await options.prepare(page, cdp)

  if (options.mainSelector) {
    const main = await typeChinese(page, cdp, options.mainSelector)
    check('主面板输入框中文可上屏', main.committed, `长度 +${main.grew}`)
    check('主面板输入期间无焦点抖动', main.blur === 0, `blur=${main.blur}`)
    await page.locator(options.mainSelector).first().fill('')
    await page.waitForTimeout(200)
  }

  await page.locator('.prompt-expand').first().click()
  await page.waitForTimeout(800)
  check('抽屉已打开', await page.locator('.sheet-overlay.open').count() === 1)

  const sheet = await typeChinese(page, cdp, '.sheet-panel #editor-sheet-prompt')
  check('抽屉内中文可连续上屏', sheet.committed, `长度 +${sheet.grew}`)
  check('抽屉输入期间无焦点抖动（核心缺陷信号）', sheet.blur === 0, `blur=${sheet.blur}`)

  if (options.syncSelector) {
    const synced = await page.locator(options.syncSelector).first().inputValue()
    check('内容实时同步回主面板', synced.includes(MARK), `主面板长度 ${synced.length}`)
  }

  await page.keyboard.press('Escape')
  await page.waitForTimeout(700)
  check('Esc 仍能关闭抽屉', await page.locator('.sheet-overlay.open').count() === 0)
  await page.close()
}

await scenario('文生图 · 放大编辑', '文生图', { mainSelector: '#text-prompt', syncSelector: '#text-prompt' })

await scenario('改图 · 放大编辑（自由输入）', '改图', {
  prepare: async (page) => {
    const options = await page.locator('#template-select option').allTextContents()
    const index = options.findIndex((item) => item.includes('自由输入'))
    if (index >= 0) await page.selectOption('#template-select', { index })
    await page.waitForTimeout(500)
  },
  mainSelector: '#edit-prompt',
  syncSelector: '#edit-prompt',
})

await scenario('一裂多 · 窗口放大编辑', '一裂多', {
  mainSelector: '.prompt-window .prompt-editor',
  syncSelector: '.prompt-window .prompt-editor',
})

// 抽屉既有键盘契约：Tab 焦点陷阱、组合期 Esc 不误关、非组合期 Esc 正常关闭。
console.log('\n【抽屉键盘契约】')
{
  const page = await newPage()
  const cdp = await page.context().newCDPSession(page)
  await page.getByRole('tab', { name: /文生图/ }).first().click()
  await page.waitForTimeout(400)
  await page.locator('.prompt-expand').first().click()
  await page.waitForTimeout(700)
  await page.locator('.sheet-panel #editor-sheet-prompt').click()
  await page.waitForTimeout(200)

  const trapped = await page.evaluate(async () => {
    const panel = document.querySelector('.sheet-panel')
    for (let index = 0; index < 10; index++) {
      await new Promise((resolve) => setTimeout(resolve, 25))
      if (!panel.contains(document.activeElement)) return false
    }
    return true
  })
  check('Tab 焦点循环不逃出抽屉', trapped)

  await cdp.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 })
  await page.waitForTimeout(200)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  check('组合期按 Esc 不误关抽屉', await page.locator('.sheet-overlay.open').count() === 1)
  await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  await page.waitForTimeout(200)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(600)
  check('非组合期 Esc 正常关闭', await page.locator('.sheet-overlay.open').count() === 0)
  await page.close()
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`)
await browser.close()
process.exit(fail === 0 ? 0 : 1)
