#!/usr/bin/env python3
"""把 RimWorld 贴图解码成 PNG，输出到 stdout。

两类来源：

- ``Assets.zip``（原版 Core）：条目形如
  ``Resources/Textures/Things/Item/Resource/Steel/Steel_a.psd.dds.split``，
  可能是 DXT 或 BC7（DX10）；BC7 由 ``texture2ddecoder`` 兜底。
- ``Data/<DLC>/AssetBundles/resources_<dlc>``（官方 DLC）：Unity 资源包，
  通过 ``UnityPy`` 读取 Texture2D，按 texPath 最后一段匹配贴图名。

用法::

    python scripts/render_icon.py --game <根目录> --source Royalty \\
        --tex Things/Pawn/Humanlike/Apparel/CataphractArmor/CataphractArmor > icon.png

退出码：0 成功；2 参数/资源缺失；3 未找到贴图；4 解码失败。
"""

from __future__ import annotations

import argparse
import hashlib
import io
import struct
import sys
import zipfile
from pathlib import Path

from PIL import Image

TEXTURE_ROOT = "Resources/Textures/"
FRAME_SUFFIXES = {"", "a", "b", "c", "d", "e", "south", "north", "east", "west", "side", "top", "bottom"}


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="render_icon", description="把 RimWorld 贴图转为 PNG")
    parser.add_argument("--game", required=True, metavar="DIR", help="RimWorld 根目录")
    parser.add_argument("--tex", required=True, metavar="PATH", help="贴图路径，如 Things/Item/Resource/Steel")
    parser.add_argument("--source", default="Core", help="来源（Core / Royalty / …），DLC 从 AssetBundles 读取")
    parser.add_argument("--cache-dir", default=None, help="可选：PNG 缓存目录")
    return parser.parse_args(argv)


# ----------------------------------------------------------------------
# Assets.zip（Core）
# ----------------------------------------------------------------------


def _matches_frame(stem: str, base: str) -> bool:
    stem_lower = stem.lower()
    base_lower = base.lower()
    if stem_lower == base_lower:
        return True
    if not stem_lower.startswith(base_lower):
        return False
    rest = stem_lower[len(base_lower):]
    if rest.startswith("_"):
        rest = rest[1:]
    return rest in FRAME_SUFFIXES


def _stems(names: list[str], prefix: str, base: str) -> list[str]:
    exact: list[str] = []
    variants: list[str] = []
    for name in names:
        if not name.endswith(".split") or not name.startswith(prefix):
            continue
        tail = name[len(prefix):]
        if "/" in tail:
            continue
        stem = tail.split(".")[0]
        if stem.lower() == base.lower():
            exact.append(name)
        elif _matches_frame(stem, base):
            variants.append(name)
    return exact + variants


def find_candidates(names: list[str], tex_path: str) -> list[str]:
    tex_path = tex_path.strip("/")
    parts = [part for part in tex_path.split("/") if part]
    if not parts:
        return []
    base = parts[-1]
    parent = "/".join(parts[:-1])

    folder_prefix = f"{TEXTURE_ROOT}{tex_path}/"
    folder_files = [
        name
        for name in names
        if name.startswith(folder_prefix)
        and "/" not in name[len(folder_prefix):]
        and name.endswith(".split")
    ]
    if folder_files:
        return folder_files

    found = _stems(names, folder_prefix, base)
    if found:
        return found

    if parent:
        found = _stems(names, f"{TEXTURE_ROOT}{parent}/", base)
        if found:
            return found

    exact_file = f"{TEXTURE_ROOT}{tex_path}"
    return [name for name in names if name == exact_file or name.startswith(exact_file + ".")]


def _stem_of(name: str) -> str:
    return name.rsplit("/", 1)[-1].split(".")[0].lower()


def pick_entry(candidates: list[str], tex_path: str) -> str | None:
    if not candidates:
        return None
    base = tex_path.strip("/").split("/")[-1].lower()
    for suffix in ("", "_south", "_a", "_north", "_east", "_west"):
        for name in candidates:
            if _stem_of(name) == base + suffix:
                return name
    for suffix in ("a", "b", "c", "d", "e"):
        for name in candidates:
            if _stem_of(name) == base + suffix:
                return name
    directional = ("_north", "_south", "_east", "_west", "north", "south", "east", "west")
    plain = [name for name in candidates if not _stem_of(name).endswith(directional)]
    return sorted(plain or candidates)[0]


def decode_dds(payload: bytes) -> Image.Image:
    """Pillow 解 DXT；BC7（DX10）用 texture2ddecoder 兜底。"""
    try:
        with Image.open(io.BytesIO(payload)) as image:
            image.load()
            return image.convert("RGBA")
    except Exception:
        if payload[84:88] != b"DX10" or len(payload) < 148:
            raise
        dxgi = struct.unpack_from("<I", payload, 128)[0]
        if dxgi != 98:  # BC7
            raise
        import texture2ddecoder

        height, width = struct.unpack_from("<II", payload, 12)
        rgba = texture2ddecoder.decode_bc7(payload[148:], width, height)
        return Image.frombytes("RGBA", (width, height), rgba)


def render_from_assets(assets: Path, tex_path: str) -> tuple[bytes | None, str | None]:
    try:
        with zipfile.ZipFile(assets) as archive:
            entry = pick_entry(find_candidates(archive.namelist(), tex_path), tex_path)
            if entry is None:
                return None, f"未找到贴图：{tex_path}"
            try:
                image = decode_dds(archive.read(entry))
            except Exception as exc:  # noqa: BLE001
                return None, f"贴图解码失败（{entry}）：{exc}"
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            return buffer.getvalue(), None
    except (zipfile.BadZipFile, OSError) as exc:
        return None, f"读取 Assets.zip 失败：{exc}"


# ----------------------------------------------------------------------
# DLC AssetBundles（UnityPy）
# ----------------------------------------------------------------------


def _bundle_path(game_root: Path, source: str) -> Path | None:
    folder = game_root / "Data" / source / "AssetBundles"
    if not folder.is_dir():
        return None
    preferred = folder / f"resources_{source.lower()}"
    if preferred.is_file():
        return preferred
    candidates = [path for path in folder.iterdir() if path.is_file() and not path.name.endswith(".manifest")]
    return candidates[0] if candidates else None


def _pick_texture_name(names: list[str], base: str) -> str | None:
    base_lower = base.lower()
    exact = [name for name in names if name.lower() == base_lower]
    prefixed = [name for name in names if name.lower().startswith(base_lower + "_")]
    pool = exact or prefixed
    if not pool:
        return None

    def rank(name: str) -> int:
        lower = name.lower()
        if lower.endswith("_south"):
            return 0
        if lower.endswith("_east"):
            return 1
        if lower.endswith("_north"):
            return 2
        if lower.endswith("_west"):
            return 3
        return 4

    return sorted(pool, key=rank)[0]


def render_from_bundle(game_root: Path, source: str, tex_path: str) -> tuple[bytes | None, str | None]:
    bundle = _bundle_path(game_root, source)
    if bundle is None:
        return None, f"未找到 {source} 的 AssetBundles"
    try:
        import UnityPy
    except ImportError:
        return None, "缺少 UnityPy（DLC 贴图需要）"

    base = tex_path.strip("/").split("/")[-1]
    try:
        env = UnityPy.load(str(bundle))
        names: list[str] = []
        for obj in env.objects:
            if obj.type.name != "Texture2D":
                continue
            try:
                names.append(obj.peek_name() if hasattr(obj, "peek_name") else obj.read().m_Name)
            except Exception:  # noqa: BLE001
                continue
        target_name = _pick_texture_name(names, base)
        if target_name is None:
            return None, f"未找到贴图：{base}（{source}）"
        for obj in env.objects:
            if obj.type.name != "Texture2D":
                continue
            try:
                data = obj.read()
            except Exception:  # noqa: BLE001
                continue
            if getattr(data, "m_Name", None) != target_name:
                continue
            image = data.image
            buffer = io.BytesIO()
            image.convert("RGBA").save(buffer, format="PNG")
            return buffer.getvalue(), None
        return None, f"Texture2D 读取失败：{target_name}"
    except Exception as exc:  # noqa: BLE001
        return None, f"读取资源包失败：{exc}"


# ----------------------------------------------------------------------
# 入口
# ----------------------------------------------------------------------


def cache_file(cache_dir: Path, source: str, tex_path: str) -> Path:
    digest = hashlib.sha1(f"{source}|{tex_path}".encode("utf-8")).hexdigest()
    return cache_dir / f"{digest}.png"


def render(game_root: Path, tex_path: str, source: str = "Core", cache_dir: Path | None = None) -> tuple[bytes | None, str | None]:
    if cache_dir is not None:
        target = cache_file(cache_dir, source, tex_path)
        if target.is_file():
            return target.read_bytes(), None

    if source.lower() == "core":
        png, error = render_from_assets(game_root / "Assets.zip", tex_path)
    else:
        png, error = render_from_bundle(game_root, source, tex_path)

    if png is not None and cache_dir is not None:
        cache_dir.mkdir(parents=True, exist_ok=True)
        cache_file(cache_dir, source, tex_path).write_bytes(png)
    return png, error


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    cache_dir = Path(args.cache_dir).expanduser() if args.cache_dir else None
    png, error = render(Path(args.game).expanduser(), args.tex, args.source, cache_dir)
    if png is None:
        print(error, file=sys.stderr)
        return 3 if "未找到贴图" in (error or "") else 4
    sys.stdout.buffer.write(png)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
