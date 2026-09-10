# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

> **SOURCE OF TRUTH:** 本文件按 `src/styles.css` 的现有实现反向整理（核对于 2026-09-10）。
> 与代码冲突时以代码为准；改完视觉代码请回来同步本文件，不要在这里写"期望"值。

**Project:** 灵图工作台（lingtu-workbench）
**Category:** 本地单用户图像工作台 · 数据密集型工具面板
**Theme:** 单一浅色主题（无暗色模式、无主题切换、无 `prefers-color-scheme` 分支）

**Design Dials:** Variance 4/10（克制、对称、无花哨版式）| Motion 3/10（180ms 微交互为主，仅抽屉有 320ms 入场）| Density 8/10（38 处 10px、28 处 11px 小字号，紧凑面板）

---

## 1. 颜色

全部来自 `src/styles.css` 的 `:root`，**组件内不要写新的十六进制**（见 §7）。

| 角色 | 变量 | 值 | 用途 |
|------|------|-----|------|
| 页面底色 | `--bg` | `#f3f7f5` | body 背景（叠加径向绿色光晕） |
| 面板底 | `--surface` | `#ffffff` | 卡片、抽屉、输入框 |
| 抬升面 | `--surface-raised` | `#fbfdfc` | 表头、抽屉底部操作区 |
| 柔和面 | `--surface-soft` | `#edf6f1` | hover 底、禁用控件底 |
| 描边 | `--border` | `#d7e6de` | 分隔线、卡片描边 |
| 强描边 | `--border-strong` | `#b8d1c3` | 输入框/按钮描边 |
| 次要文字 | `--muted` | `#5d766a` | 说明文字、标签 |
| 弱化文字 | `--muted-2` | `#80968b` | 9–10px 元信息（对比度不足，见下） |
| 正文 | `--text` | `#17352a` | 标题、正文、输入值 |
| 主色 | `--green` | `#0b8f5b` | 主按钮、焦点环、当前项 |
| 主色浅底 | `--green-deep` | `#ddf5e9` | 选中项底 |
| 警示 | `--orange` / `--orange-deep` | `#c2410c` / `#ffedd5` | 锁定横幅、待处理 |
| 危险 | `--red` / `--red-deep` | `#b42318` / `#fee4e2` | 删除、错误文案 |
| 信息 | `--blue` / `--blue-deep` | `#0b6ea8` / `#dceeff` | 中性信息徽标 |
| 辅助 | `--purple` / `--purple-deep` | `#6d4cc5` / `#ede9fe` | 次要分类徽标 |

### 对比度（白底实测）

| 变量 | 对比度 | 结论 |
|------|--------|------|
| `--text` | 13.3:1 | 通过 |
| `--muted` | 4.92:1 | 通过 AA，正文级次要文字用它 |
| `--muted-2` | 3.16:1 | **未达 4.5:1**，仅限非关键元信息 |

`.field-help` 已从 `--muted-2` 修正为 `--muted`。新增的说明性文字请直接用 `--muted`，不要沿用 `--muted-2`。

---

## 2. 字体

- 正文：`'Fira Sans', system-ui, sans-serif`
- 等宽（模型 ID、路径、时间、计数）：`var(--mono)` = `'Fira Code', ui-monospace, monospace`
- 引入方式：`src/styles.css` 顶部 `@import` Google Fonts（400/500/600/700 与 400/500/600）

### 字号阶梯（按代码统计的实际取值）

| 字号 | 用途 |
|------|------|
| 20–21px | 指标数字（`.metric-copy strong`）、二级区块标题（`.llm-heading h2`） |
| 16–17px | 面板标题、抽屉标题 |
| 14px | 卡片标题 |
| 12px | 主要按钮、空状态正文 |
| 11px | 表单标签、输入值、下拉框（**表单控件基准**） |
| 10px | 说明文字、统计标签、Toast |
| 9px | 徽标、抽屉 eyebrow、行内元信息 |
| 8px | 极少数元信息（`.gallery-card-body span`，不建议再用） |

不要引入小于 9px 的字号，也不要为"更好看"把表单控件提到 12px 以上——会破坏面板密度。

---

## 3. 布局与断点

| 元素 | 规格 |
|------|------|
| 侧边栏 | 固定 `236px`；`≤1100px` 收成 `76px`（仅图标） |
| 顶栏 | 高 `67px`，`padding: 0 35px` |
| 页面容器 | `.page-content`：`max-width: 1540px`，`padding: 34px 35px 58px` |
| 内页 | `.inner-page` `1360px`；模型设置页 `1320px` |

断点（只有这四档，不要新造）：

- `≤1100px`：侧边栏收窄、多列面板塌为单列/两列
- `≤760px`：页面内边距降到 `24px 16px`、工具栏纵向排列、表格列裁剪
- `≤640px`：右侧抽屉占满整宽
- `≤430px`：指标卡与画廊两列紧凑

### 间距

**没有 `--space-*` 变量**（早期生成的规范里那套 token 从未落地）。按组件手写 px，惯用值：

`gap`：8px（最多）、7px、6px、4px、12px；`padding`：`0 10px`（控件）、`4px 6px`（徽标）、`10px 12px`（提示条）、`18px 20px`（提示词表单）、`22px 24px`（抽屉 body）。

### 层级 z-index（固定分配，不要插空）

`10` 顶栏 / `15` Toast / `20` 侧边栏 / `30` 居中弹窗遮罩 / `40` 右侧抽屉遮罩

---

## 4. 组件规范

### 按钮

| 类 | 高度 | 字号 | 说明 |
|----|------|------|------|
| `.button` | `36px` | 12px | 圆角 6px，`padding: 0 13px`，600 字重，`transition 180ms` |
| `.button-primary` | — | — | 底 `--green`、白字、`box-shadow: 0 8px 20px rgba(11,143,91,.16)`；hover `#087c4e` |
| `.button-ghost` | — | — | 透明底 + `--border-strong` 描边；hover 底 `#edf6f1`、描边 `#8fbba5` |
| `.button-dark` | — | — | 浅绿底次级按钮 |
| `.button-small` | `29px` | 11px | 行内操作用 |
| `.icon-button` | `34px` / `.subtle` `30px` | — | 透明底，hover 出现描边与底色 |

上浮 `translateY(-1px/-2px)` 只用于 `.button:hover`、结果按钮、`.gallery-card:hover`、`.prompt-card`；`.icon-button` 不做位移。

### 表单字段（`.setting-field`）

统一结构：`label`（11px / 600 / `--text`）→ 控件 → 可选 `.field-help`（10px / `--muted`）。**label 必须可见，不能用 placeholder 代替。**

- 输入框与下拉框共用一套外观：`min-height: 36px`、`border-radius: 6px`、`padding: 0 10px`、`font-size: 11px`、白底、`--border-strong` 描边
- 悬停描边 `#6fa988`；聚焦 `border-color: var(--green)` + `box-shadow: 0 0 0 3px rgba(11,143,91,.12)`
- 过渡：`border-color / box-shadow / background 160ms ease`
- 禁用：`cursor: not-allowed` + `--surface-soft` 底 + `--muted-2` 文字

**下拉框**：用 `.select-wrap` 包裹 `<select>` + `<ChevronDown size={15} />`（`appearance: none`，箭头绝对定位 `right: 10px`，箭头 `pointer-events: none`）。`select` 必须保留 `padding-right: 33px`，否则长选项会被箭头压住；悬停/聚焦时箭头转 `--green`（160ms）。

**密码框**：`.secret-input` 负责描边与 `:focus-within` 焦点环，内部 `input` 去掉自身描边，右侧放显示/隐藏图标按钮。

### 右侧抽屉（`.sheet-*`，供应商配置等表单）

| 元素 | 规格 |
|------|------|
| `.sheet-overlay` | `position: fixed; inset: 0`；`z-index: 40`；底 `rgba(1,8,5,.45)`；`backdrop-filter: blur(2px)`；`display: flex; justify-content: flex-end` |
| 关闭态 | `opacity: 0; visibility: hidden`，并延迟 280ms 切换 `visibility`，保证出场动画可见且隐藏时不可聚焦 |
| `.sheet-panel` | `width: min(640px, 100vw)`；`height: 100%`；右侧贴边、无圆角；`border-left: 1px solid var(--border)`；`box-shadow: -10px 0 34px rgba(23,53,42,.16)` |
| 入场 | `transform: translateX(100%) → 0`，`320ms cubic-bezier(.16,1,.3,1)` |
| `.sheet-header` | `padding: 20px 56px 18px 24px`（右侧留出关闭按钮）；`border-bottom` |
| `.sheet-body` | `flex: 1; overflow-y: auto; overscroll-behavior: contain; padding: 22px 24px` |
| `.sheet-footer` | 右对齐操作区，`padding: 14px 24px`；`border-top`；底 `--surface-raised` |
| `.sheet-close` | `32px` 方按钮，绝对定位 `top: 14px; right: 14px` |
| `≤640px` | 占满 `100vw`、去左边框、`padding` 收紧到 `16px` 级 |

行为契约（由 `ProviderSheet` 组件提供，勿在页面里另写一份）：Esc 关闭；点击遮罩关闭（**必须 `preventDefault()`**，否则浏览器 mousedown 默认行为会在 `focus()` 之后把焦点丢回 `body`）；打开时焦点进入第一个字段；关闭后焦点归还触发按钮；`role="dialog"` + `aria-modal="true"` + `aria-labelledby`（id 用 `useId()`，因为同页可有多个抽屉）。

已知未实现（刻意）：Tab 焦点陷阱、`body` 滚动锁定。

### 其他

- `.panel`：圆角 9px，白到浅绿的 145deg 渐变底，`box-shadow: 0 12px 30px rgba(26,77,54,.08)`
- `.provider-row`：`grid-template-columns: 78px 1fr 180px 180px`，`min-height: 104px`；启用态加 `inset 3px 0 var(--green)` 左侧色条；`≤760px` 单列且操作按钮触控尺寸提到 44px
- `.toast`：固定右下（`right: 24px; bottom: 20px`），`z-index: 15`，10px 字号，2.4s 自动消失
- `.empty-state.panel`：虚线描边，居中，`min-height: 190px`

---

## 5. 交互与动效

| 场景 | 时长 / 缓动 |
|------|-------------|
| 按钮、图标按钮、卡片 hover | `180ms ease`（代码中最常用，38 处） |
| 表单控件描边/焦点环 | `160ms ease` |
| 抽屉遮罩淡入淡出 | `280ms ease` |
| 抽屉面板滑入 | `320ms cubic-bezier(.16,1,.3,1)` |

`prefers-reduced-motion: reduce` 已有全局兜底（`transition-duration: .01ms !important`），新组件不需要单独再写一遍。

---

## 6. 无障碍

- 全局 `:focus-visible { outline: 2px solid var(--green); outline-offset: 2px }` 覆盖 button/input/select/textarea，**不要为了"干净"去掉轮廓**
- 抽屉/弹窗：`role="dialog"` + `aria-modal` + 标题关联；错误用 `role="alert"` 且必须靠近出错的字段（不能只放在页面顶部、更不能被遮罩挡在背后）
- 表单控件一律有可见 `<label for>`
- 触控尺寸：本项目控件基准是 36px，**低于 44px 的通用建议**，这是高密度桌面工具的刻意取舍；仅在 `≤760px` 对行内操作按钮补到 44px
- 图标按钮必须有 `aria-label` 或 `title`

---

## 7. 反模式（本项目特有）

- ❌ **不要在组件里写新的十六进制色值**：`src/styles.css` 有一层"浅色生产主题"覆盖块（约 355–442 行）专门覆盖早期的深色底值。新样式用 `:root` 变量；若确实要写 hex，先确认不需要同步覆盖块
- ❌ 不要假设存在暗色主题（没有 `prefers-color-scheme`、没有 `data-theme`）
- ❌ 不要用 emoji 当图标（统一 `lucide-react`，`strokeWidth` 默认）
- ❌ 不要把 `position: fixed` 的浮层放进带 `transform` / `filter` / `will-change` 的祖先里（会改变包含块，浮层不再贴视口）
- ❌ 不要用 placeholder 代替 label，也不要把错误只放在页面顶部
- ❌ UI 文案不出现 SQLite、表名、密钥链、API 路径等后端细节（见 `AGENTS.md`）
- ❌ 不要用超过 3 层的 hover 效果（位移 + 变色 + 阴影叠加）；项目基调是克制的

---

## 8. 验证方式（改动视觉代码后）

用 `playwright-cli` 取**实测值**而不是靠截图推断：

```bash
playwright-cli --raw eval "getComputedStyle(document.querySelector('#provider-model')).borderColor"
playwright-cli --raw eval "JSON.stringify(document.querySelector('.sheet-panel').getBoundingClientRect())"
```

至少覆盖：1440 / 1000 / 760 / 375 四档宽度下的无横向溢出（`document.documentElement.scrollWidth - clientWidth === 0`）、焦点进出、`console` 无新增 error。
