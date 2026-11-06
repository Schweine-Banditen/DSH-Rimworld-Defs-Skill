#!/usr/bin/env python3
"""把游戏 Assets.zip 里的 Def 贴图解码成 PNG，输出到 stdout。

RimWorld 1.7 的原版纹理不在 Data/**/Textures 下，而是打包在游戏根目录的
``Assets.zip`` 中，条目形如::

    Resources/Textures/Things/Item/Resource/Steel/Steel_a.psd.dds.split

后缀 ``.split`` 的内容是独立的 DDS 文件；ZIP 使用 ZSTD 压缩（方法 93，
需要 Python 3.13+）。本脚本用 Pillow 解码后直接输出 PNG 字节。

用法::

    python scripts/render_icon.py --game <RimWorld 根目录> --tex Things/Item/Resource/Steel > steel.png

退出码：0 成功；3 未找到贴图；4 解码失败；2 参数错误。
"""

from __future__ import annotations

import argparse
import io
import sys
import zipfile
from pathlib import Path

from PIL import Image

TEXTURE_ROOT = "Resources/Textures/"


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="render_icon", description="把 Assets.zip 中的 DDS 贴图转为 PNG")
    parser.add_argument("--game", required=True, metavar="DIR", help="RimWorld 根目录（其下有 Assets.zip）")
    parser.add_argument("--tex", required=True, metavar="PATH", help="贴图路径，如 Things/Item/Resource/Steel")
    return parser.parse_args(argv)


def pick_entry(archive: zipfile.ZipFile, tex_path: str) -> str | None:
    """在 zip 中选择该 texPath 的贴图条目，优先 `_a` 帧。"""
    prefix = f"{TEXTURE_ROOT}{tex_path.strip('/')}/"
    names = [
        name
        for name in archive.namelist()
        if name.startswith(prefix) and name.endswith(".split")
    ]
    if not names:
        return None
    preferred = [name for name in names if "_a." in name]
    return sorted(preferred or names)[0]


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    assets = Path(args.game).expanduser() / "Assets.zip"
    if not assets.is_file():
        print(f"找不到 Assets.zip：{assets}", file=sys.stderr)
        return 2
    try:
        with zipfile.ZipFile(assets) as archive:
            entry = pick_entry(archive, args.tex)
            if entry is None:
                print(f"未找到贴图：{args.tex}", file=sys.stderr)
                return 3
            payload = archive.read(entry)
    except (zipfile.BadZipFile, OSError) as exc:
        print(f"读取 Assets.zip 失败：{exc}", file=sys.stderr)
        return 4

    try:
        with Image.open(io.BytesIO(payload)) as image:
            buffer = io.BytesIO()
            image.convert("RGBA").save(buffer, format="PNG")
    except Exception as exc:  # noqa: BLE001 - 解码失败统一处理
        print(f"贴图解码失败（{entry}）：{exc}", file=sys.stderr)
        return 4

    sys.stdout.buffer.write(buffer.getvalue())
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
