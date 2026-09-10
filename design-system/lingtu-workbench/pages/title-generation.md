# 标题生成页 · 局部规范

> 本文件是 `design-system/lingtu-workbench/MASTER.md` 的页面覆盖，仅适用于「标题生成」页。
> 与 Master 冲突时以本文件为准；本文件未提到的部分严格遵循 Master。

**页面路由**：`src/main.tsx` 中的 `page === 'title-generation'`，组件在 `src/title-generation.tsx`
**页面性质**：数据密集型批处理面板（与「任务队列」同级密度）

> 提示词库页的工具栏复用 `.prompt-layout` 的 `190px + 1fr` 列宽，使搜索框与下方提示词卡片左对齐（见 `src/styles.css` 末尾）。

## 1. 与 Master 的关系

- 颜色、字体、字号阶梯、按钮、表单字段、抽屉、空状态、Toast **全部复用 Master**，本页不新增十六进制色值。
- 本页新增的 class 只有布局壳与结果表：`.title-generation-*`。所有取值来自 `:root` 变量。

## 2. 页面结构

| 区块 | 规格 |
|------|------|
| 页头 `.page-heading.heading-row` | eyebrow「内容资产」+ `h1 标题生成` + 一行说明；右侧 `heading-actions` 放当前 LLM 供应商状态 |
| 配置区 `.panel` | `.title-generation-grid` 四列：标题提示词（`.select-wrap`）、图片文件夹、RPM、执行模型；按钮行为 `.heading-actions` 同款 `.button` 三连 |
| 统计条 `.metrics-grid` | 复用 `.metric-card`，四张：总图片数 / 已完成 / 成功 / 失败 |
| 进度 `.progress-track` | 复用队列的轨道样式，`i` 宽度百分比驱动；不新增 `<progress>` 原生控件 |
| 双栏 `.title-generation-workspace` | 左「执行日志」、右「结果预览」，各为一张 `.panel`，`min-height: 420px` |
| 结果表 | `.title-generation-table`，8 列（图片名称 + 7 个标题类别），表头 `position: sticky`，单元格 `vertical-align: top` + 换行 |

## 3. 本页专属规则

- 图片输入用系统文件夹选择（`webkitdirectory`），保留 `<label for>` 可见标签；触发器是 `.title-generation-folder` 按钮，与输入框同高（36px）、同描边，可键盘聚焦。
- 字段不写 `.field-help`：四个控件等高对齐即可，说明性文案只留在页头描述里。
- LLM 供应商未配置时：开始按钮禁用，配置区内显示 `.form-error` 级别的提示，并提供跳转「模型设置」的 `.button-ghost`。
- 提示词下拉只列出用途为「商品标题」的提示词；为空时给出「去提示词库新建」的入口。
- 运行中锁定输入；结束后 `.toast` 提示导出可用（2.4s，复用 Master 规范）。
- ≤760px：双栏塌成单栏，结果表横向滚动放在 `.title-generation-table-scroll` 容器内，页面本身不产生横向溢出。

## 4. 明确不做

- 不做暗色主题分支、不做行内重试、不做拖拽上传（本页只保留文件夹选择）。
