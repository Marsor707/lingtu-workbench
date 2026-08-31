#!/usr/bin/env python3
"""从参考软件配置快照提取非空生成提示词，不读取或写入任何密钥字段。"""

from __future__ import annotations

import json
from pathlib import Path
import sys


DEFAULT_OUTPUT = Path("src/data/builtin-prompts.ts")
CATEGORIES = (
    "AB风格识别文化夸张",
    "Batch10 元素杯身美术创作",
    "元素套用通用结构",
    "AB成分表类",
    "AB纯文字类",
    "AB图文类",
    "画布图文类",
    "画布插画类",
    "网络热图",
)


def split_name(name: str) -> tuple[str, str, str]:
    layout = "two_up"
    base_name = name
    if base_name.startswith("4K十五宫格测试｜"):
        layout = "fifteen_up_test"
        base_name = base_name.removeprefix("4K十五宫格测试｜")
    if base_name.startswith("4K四宫格｜"):
        if layout == "two_up":
            layout = "four_up"
        base_name = base_name.removeprefix("4K四宫格｜")

    for category in CATEGORIES:
        if base_name.startswith(f"{category}_"):
            return category, base_name[len(category) + 1 :], layout
        if category == "网络热图" and base_name.startswith(category):
            return category, base_name[len(category) :], layout
    return "未分类", base_name, layout


def main() -> None:
    if len(sys.argv) < 2:
        raise SystemExit("用法：python3 scripts/import-reference-prompts.py <配置快照路径> [输出路径]")
    source = Path(sys.argv[1])
    output = Path(sys.argv[2]) if len(sys.argv) > 2 else DEFAULT_OUTPUT
    payload = json.loads(source.read_text(encoding="utf-8"))
    names = payload.get("template_names", [])
    prompts = payload.get("template_prompts", [])
    items = []
    for index, (name, prompt) in enumerate(zip(names, prompts)):
        if not isinstance(name, str) or not isinstance(prompt, str) or not prompt.strip():
            continue
        category, title, layout = split_name(name)
        items.append(
            {
                "id": f"reference-v239-{layout}-{index:03d}",
                "category": category,
                "title": title,
                "text": prompt.strip(),
                "layout": layout,
                "builtin": True,
                "sourceName": name,
            }
        )

    output.parent.mkdir(parents=True, exist_ok=True)
    serialized = json.dumps(items, ensure_ascii=False, indent=2)
    output.write_text(
        """/**\n * 参考软件 v2.3.9 的内置生成提示词。\n * 仅包含非空 template_prompts；原配置中的 API Key、地址和本地路径未迁移。\n */\nexport type BuiltinPromptLayout = 'two_up' | 'four_up' | 'fifteen_up_test'\n\nexport type BuiltinPrompt = {\n  id: string\n  category: string\n  title: string\n  text: string\n  layout: BuiltinPromptLayout\n  builtin: true\n  sourceName: string\n}\n\nexport const builtinPrompts: BuiltinPrompt[] = """
        + serialized
        + "\n"
    )
    print(f"已提取 {len(items)} 条提示词到 {output}")


if __name__ == "__main__":
    main()
