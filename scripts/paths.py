#!/usr/bin/env python3
"""解析本机路径：游戏根目录、数据文件、Python 解释器。

设计目标：**仓库内不出现任何绝对路径**，换机器 / 搬盘后无需改代码或改配置。

解析顺序（自高到低）：

游戏根目录 ``game_root()``:

1. 显式参数（``--game``）
2. 环境变量 ``RIMWORLD_GAME``
3. 仓库根的 ``rimworld-defs.local.json``（gitignore，不入库）
4. 已有数据文件里记录的 ``gameRoot``（仅当目录仍有效）
5. Steam 自动发现：注册表 SteamPath → ``steamapps/libraryfolders.vdf`` → 各库
6. 兜底候选目录：各盘符的 ``SteamLibrary`` / ``Steam`` / GOG 常见位置

数据文件 ``data_path()``:

1. 显式参数（``--json`` / ``--output``）
2. 环境变量 ``RIMWORLD_DATA``
3. ``rimworld-defs.local.json`` 的 ``dataPath``
4. ``<仓库根>/data/rimworld-defs.json``

Python 解释器 ``python_exe()``（供 UI 与文档引用，脚本自身不需要）:

1. 环境变量 ``RIMWORLD_PYTHON``
2. ``rimworld-defs.local.json`` 的 ``pythonExe``
3. ``python``（走 PATH）

命令行自检::

    python scripts/paths.py --json
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any

# 仓库根目录：本文件位于 <仓库>/scripts/，故取上一级。
REPO_ROOT = Path(__file__).resolve().parent.parent

# 本机配置文件名（放在仓库根，被 .gitignore 忽略）。
LOCAL_CONFIG_NAME = "rimworld-defs.local.json"

# 默认数据文件位置（相对仓库根）。
DEFAULT_DATA_REL = Path("data") / "rimworld-defs.json"

# 环境变量名。Node 侧（ui/index.js）使用完全相同的名字与优先级。
ENV_GAME = "RIMWORLD_GAME"
ENV_DATA = "RIMWORLD_DATA"
ENV_PYTHON = "RIMWORLD_PYTHON"

# 判定「这是一个可用的 RimWorld 根目录」的唯一标准。
GAME_MARKER = Path("Data") / "Core" / "Defs"

# RimWorld 的 Steam AppID；仅用于日志与候选提示。
RIMWORLD_APP_ID = "294100"

# 单个 SKILL 的输出限制，避免候选过多时刷屏。
_MAX_REPORTED_CANDIDATES = 8


def repo_root() -> Path:
    """返回仓库根目录（由本文件位置推出，不读取任何配置）。"""
    return REPO_ROOT


def local_config_path() -> Path:
    """返回本机配置文件的绝对路径（无论是否存在）。"""
    return REPO_ROOT / LOCAL_CONFIG_NAME


def read_local_config() -> dict[str, Any]:
    """读取本机配置文件；不存在、不可解析或不是对象时返回空字典。

    故意不抛异常：本机配置是可选覆盖，坏文件不应该让查询或提取直接失败。
    """
    path = local_config_path()
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _clean(value: Any) -> str | None:
    """把配置值规整成非空字符串；``None`` / 空串 / 非字符串视为未设置。"""
    if isinstance(value, str):
        text = value.strip()
        if text:
            return text
    return None


def is_valid_game_root(path: Path | str | None) -> bool:
    """校验目录是否为 RimWorld 根目录（存在 ``Data/Core/Defs``）。"""
    if path is None:
        return False
    try:
        return Path(path).joinpath(GAME_MARKER).is_dir()
    except OSError:
        return False


def _expand(path: str) -> Path:
    """展开 ``~`` 与环境变量，并转成绝对路径。"""
    return Path(os.path.expandvars(os.path.expanduser(path))).resolve()


# ----------------------------------------------------------------------
# 数据文件 / Python 解释器
# ----------------------------------------------------------------------


def data_path(explicit: str | Path | None = None) -> Path:
    """按优先级解析数据文件路径；不保证文件存在。"""
    if explicit is not None:
        return Path(explicit).expanduser().resolve()

    env_value = _clean(os.environ.get(ENV_DATA))
    if env_value:
        return _expand(env_value)

    config_value = _clean(read_local_config().get("dataPath"))
    if config_value:
        return _expand(config_value)

    return REPO_ROOT / DEFAULT_DATA_REL


def python_exe() -> str:
    """按优先级解析 Python 解释器（环境变量 → 本机配置 → ``python``）。"""
    env_value = _clean(os.environ.get(ENV_PYTHON))
    if env_value:
        return env_value

    config_value = _clean(read_local_config().get("pythonExe"))
    if config_value:
        return config_value

    return "python"


# ----------------------------------------------------------------------
# Steam 发现
# ----------------------------------------------------------------------


def _registry_steam_paths() -> list[Path]:
    """从注册表读取 Steam 安装目录；非 Windows 或读取失败时返回空列表。

    HKCU 优先（当前用户装的 Steam），其次 HKLM 的 32/64 位视图。
    单项失败不影响其余项：注册表结构因版本而异，不能指望一定存在。
    """
    if sys.platform != "win32":
        return []
    try:
        import winreg  # noqa: PLC0415 - 仅在 Windows 上可用
    except ImportError:  # pragma: no cover - 非 Windows 环境
        return []

    probes = (
        (winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam", "SteamPath"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Valve\Steam", "InstallPath"),
    )
    found: list[Path] = []
    for hive, key, value_name in probes:
        try:
            with winreg.OpenKey(hive, key) as handle:
                value, _ = winreg.QueryValueEx(handle, value_name)
        except OSError:
            continue
        if isinstance(value, str) and value.strip():
            found.append(_expand(value.strip()))
    return found


_VDF_PATH_RE = re.compile(r'^\s*"path"\s+"(?P<path>.+?)"\s*$')


def _vdf_string(raw: str) -> str:
    """还原 VDF 里的反斜杠转义（``C:\\\\SteamLibrary`` → ``C:\\SteamLibrary``）。"""
    return raw.replace("\\\\", "\\")


def library_folders(steam_root: Path) -> list[Path]:
    """解析 ``steamapps/libraryfolders.vdf``，返回其中登记的全部库路径。

    这是「Steam 装在 D 盘、游戏装在 E 盘」场景下唯一可靠的来源；
    只查 ``SteamPath/steamapps/common`` 会漏掉其它库。
    """
    vdf = steam_root / "steamapps" / "libraryfolders.vdf"
    try:
        text = vdf.read_text(encoding="utf-8-sig", errors="replace")
    except OSError:
        return []

    libraries: list[Path] = []
    for line in text.splitlines():
        match = _VDF_PATH_RE.match(line)
        if match is None:
            continue
        libraries.append(_expand(_vdf_string(match.group("path"))))
    return libraries


def _steam_candidates() -> list[Path]:
    """按 Steam 注册表与库清单生成候选游戏目录（未校验）。"""
    candidates: list[Path] = []
    for steam_root in _registry_steam_paths():
        candidates.append(steam_root / "steamapps" / "common" / "RimWorld")
        for library in library_folders(steam_root):
            candidates.append(library / "steamapps" / "common" / "RimWorld")
    return candidates


def _fallback_candidates() -> list[Path]:
    """注册表不可用时的兜底探测：常见安装位置 + 各盘符常见目录。"""
    candidates: list[Path] = []
    suffixes = (
        Path("steamapps") / "common" / "RimWorld",
        Path("SteamLibrary") / "steamapps" / "common" / "RimWorld",
        Path("Steam") / "steamapps" / "common" / "RimWorld",
        Path("Games") / "SteamLibrary" / "steamapps" / "common" / "RimWorld",
        Path("Program Files (x86)") / "Steam" / "steamapps" / "common" / "RimWorld",
        Path("GOG Games") / "RimWorld",
    )
    for drive in _drive_roots():
        for suffix in suffixes:
            candidates.append(drive / suffix)
    return candidates


def _drive_roots() -> list[Path]:
    """枚举本机盘符根目录；失败时退回 C/D/E 三个常见盘。"""
    try:
        drives = [Path(f"{letter}:\\") for letter in os.listdrives()]  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        drives = [Path(f"{letter}:\\") for letter in "CDE"]
        drives = [drive for drive in drives if drive.exists()]
    return drives


def discover_game_roots() -> list[Path]:
    """返回本机全部通过校验的 RimWorld 根目录（Steam 优先，按发现顺序去重）。"""
    return _discover()[0]


def _discover() -> tuple[list[Path], bool]:
    """返回 ``(可用根目录列表, 是否由 Steam 库清单命中)``。"""
    steam_hits = [item for item in _steam_candidates() if is_valid_game_root(item)]
    fallback_hits = [item for item in _fallback_candidates() if is_valid_game_root(item)]

    seen: set[str] = set()
    found: list[Path] = []
    for candidate in (*steam_hits, *fallback_hits):
        key = str(candidate).casefold()
        if key in seen:
            continue
        seen.add(key)
        found.append(candidate)
    return found, bool(steam_hits)


# ----------------------------------------------------------------------
# 游戏根目录
# ----------------------------------------------------------------------


def game_root(
    explicit: str | Path | None = None,
    data_file: str | Path | None = None,
) -> tuple[Path | None, str]:
    """按优先级解析游戏根目录，返回 ``(路径, 来源)``；失败时 ``(None, "none")``。

    来源取值：``explicit`` / ``env`` / ``local-config`` / ``data-file`` /
    ``steam`` / ``fallback`` / ``none``，便于 UI 与日志说明「这个路径哪来的」。

    ``--game`` 与其它来源的区别：显式参数无效时**直接失败**（避免拼错却静默
    用了别处）；环境变量 / 本机配置无效时提示一句后**继续往下找**（换机器后
    残留的旧环境变量不应该让整个工具不可用）。
    """
    if explicit is not None:
        candidate = Path(explicit).expanduser().resolve()
        return (candidate, "explicit") if is_valid_game_root(candidate) else (None, "none")

    env_value = _clean(os.environ.get(ENV_GAME))
    if env_value:
        candidate = _expand(env_value)
        if is_valid_game_root(candidate):
            return candidate, "env"
        print(
            f"警告：环境变量 {ENV_GAME}={env_value} 不是有效的 RimWorld 目录，已忽略。",
            file=sys.stderr,
        )

    config_value = _clean(read_local_config().get("gameRoot"))
    if config_value:
        candidate = _expand(config_value)
        if is_valid_game_root(candidate):
            return candidate, "local-config"
        print(
            f"警告：{local_config_path()} 里的 gameRoot={config_value} 无效，已忽略。",
            file=sys.stderr,
        )

    recorded = _game_root_from_data(data_file)
    if recorded is not None and is_valid_game_root(recorded):
        return recorded, "data-file"

    discovered, via_steam = _discover()
    if discovered:
        return discovered[0], "steam" if via_steam else "fallback"

    return None, "none"


def _game_root_from_data(data_file: str | Path | None) -> Path | None:
    """读取数据文件里记录的 ``gameRoot``（仅用于兜底，不保证仍有效）。"""
    path = data_path(data_file)
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError):
        return None
    value = payload.get("gameRoot") if isinstance(payload, dict) else None
    return _expand(value) if isinstance(value, str) and value.strip() else None


# ----------------------------------------------------------------------
# CLI 自检
# ----------------------------------------------------------------------


def describe(explicit_game: str | None = None) -> dict[str, Any]:
    """返回一份路径解析快照，供 ``--json`` 与排障使用。"""
    resolved_game, game_source = game_root(explicit_game)
    resolved_data = data_path()
    candidates = discover_game_roots()
    return {
        "repoRoot": str(REPO_ROOT),
        "localConfig": {
            "path": str(local_config_path()),
            "exists": local_config_path().is_file(),
        },
        "data": {
            "path": str(resolved_data),
            "exists": resolved_data.is_file(),
        },
        "gameRoot": {
            "path": str(resolved_game) if resolved_game else None,
            "source": game_source,
            "valid": resolved_game is not None,
        },
        "python": python_exe(),
        "env": {
            ENV_GAME: os.environ.get(ENV_GAME) or None,
            ENV_DATA: os.environ.get(ENV_DATA) or None,
            ENV_PYTHON: os.environ.get(ENV_PYTHON) or None,
        },
        "discoveredGameRoots": [str(item) for item in candidates[:_MAX_REPORTED_CANDIDATES]],
        "discoveredCount": len(candidates),
    }


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    as_json = "--json" in args
    explicit = None
    for index, item in enumerate(args):
        if item == "--game" and index + 1 < len(args):
            explicit = args[index + 1]

    snapshot = describe(explicit)
    if as_json:
        print(json.dumps(snapshot, ensure_ascii=False, indent=2))
        return 0

    print(f"仓库根目录 : {snapshot['repoRoot']}")
    print(f"本机配置   : {snapshot['localConfig']['path']}（{'存在' if snapshot['localConfig']['exists'] else '不存在'}）")
    print(f"数据文件   : {snapshot['data']['path']}（{'存在' if snapshot['data']['exists'] else '不存在'}）")
    game = snapshot["gameRoot"]
    print(f"游戏根目录 : {game['path'] or '(未找到)'}（来源 {game['source']}）")
    print(f"Python     : {snapshot['python']}")
    if snapshot["discoveredCount"]:
        print(f"发现 {snapshot['discoveredCount']} 个可用安装：")
        for item in snapshot["discoveredGameRoots"]:
            print(f"  - {item}")
    return 0 if game["valid"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
