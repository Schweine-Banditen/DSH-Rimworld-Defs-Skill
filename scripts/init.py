#!/usr/bin/env python3
"""一键初始化与自检：检查环境 → 生成数据 → 验证查询 → 检查 Skill 联接。

给智能体工具 ``rimworld_init`` 使用，也可以直接跑：

    python scripts/init.py            # 人类可读摘要
    python scripts/init.py --json     # 只输出 JSON（给工具消费）
    python scripts/init.py --force    # 强制重新生成数据
    python scripts/init.py --workspace <会话目录> --link   # 顺带建立 Skill 联接

设计原则：
- **幂等**：已就绪的步骤只检查、不重复做；
- **不猜**：找不到游戏目录/解释器时给出可执行的修复建议，而不是静默失败；
- **不越权**：不会自动 pip install，也不会在未提供 --workspace 时创建联接。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import paths  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parent.parent
SKILL_LINK_NAME = REPO_ROOT.name


def module_version(name: str) -> str | None:
    try:
        module = __import__(name)
    except Exception:  # noqa: BLE001 - 任何导入失败都视为未安装
        return None
    return getattr(module, "__version__", "installed")


def run_script(script: str, args: list[str], timeout: int = 600) -> dict[str, Any]:
    """用当前解释器跑仓库内的脚本，返回退出码与输出尾部。"""
    command = [sys.executable, str(REPO_ROOT / "scripts" / script), *args]
    try:
        proc = subprocess.run(
            command,
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "exitCode": None, "error": f"{type(exc).__name__}: {exc}", "tail": ""}
    tail = "\n".join((proc.stdout or "").strip().splitlines()[-6:])
    return {
        "ok": proc.returncode == 0,
        "exitCode": proc.returncode,
        "tail": tail,
        "stderr": (proc.stderr or "").strip()[-400:],
    }


def read_data_summary(data_path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(data_path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        return {"readable": False, "error": f"{type(exc).__name__}: {exc}"}
    return {
        "readable": True,
        "schemaVersion": payload.get("schemaVersion"),
        "gameVersion": payload.get("gameVersion"),
        "defs": len(payload.get("defs") or []),
        "sizeMB": round(data_path.stat().st_size / (1024 * 1024), 1),
    }


def describe_skill_link(workspace: Path | None, link: bool) -> dict[str, Any]:
    """检查（并可选创建）工作区的 .dsh/skills 联接。"""
    result: dict[str, Any] = {"workspace": str(workspace) if workspace else None, "checked": False, "exists": False, "created": False, "entries": []}
    if workspace is None:
        return result
    skills_dir = workspace / ".dsh" / "skills"
    result["checked"] = True
    if skills_dir.is_dir():
        result["entries"] = sorted(item.name for item in skills_dir.iterdir() if item.is_dir())
    target = skills_dir / SKILL_LINK_NAME
    result["target"] = str(target)
    result["exists"] = target.exists()
    if link and not target.exists():
        try:
            skills_dir.mkdir(parents=True, exist_ok=True)
            if os.name == "nt":
                proc = subprocess.run(
                    ["cmd", "/c", "mklink", "/J", str(target), str(REPO_ROOT)],
                    capture_output=True,
                    text=True,
                )
                created = proc.returncode == 0
                if not created:
                    result["error"] = (proc.stdout or proc.stderr or "").strip()[:200]
            else:
                os.symlink(REPO_ROOT, target, target_is_directory=True)
                created = True
            result["created"] = created
        except OSError as exc:
            result["error"] = f"{type(exc).__name__}: {exc}"
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="init", description="RimWorld Defs 初始化与自检")
    parser.add_argument("--force", action="store_true", help="即使数据已存在也重新生成")
    parser.add_argument("--workspace", default=None, metavar="DIR", help="会话工作目录（用于检查 .dsh/skills）")
    parser.add_argument("--link", action="store_true", help="缺失时创建 Skill 目录联接（需 --workspace）")
    parser.add_argument("--json", action="store_true", help="只输出 JSON")
    args = parser.parse_args(argv)

    warnings: list[str] = []
    actions: list[str] = []

    snapshot = paths.describe()
    game = snapshot["gameRoot"]
    data = snapshot["data"]
    data_path = Path(data["path"])
    local_config = snapshot["localConfig"]

    # 1. Python 与依赖
    lxml_version = module_version("lxml")
    pillow_version = module_version("PIL")
    unitypy_version = module_version("UnityPy")
    if lxml_version is None:
        warnings.append("缺少 lxml：pip install lxml（否则无法解析 XML）")
    if pillow_version is None:
        warnings.append("缺少 Pillow：pip install pillow（面板贴图预览不可用）")

    # 2. 数据目录与生成
    data_path.parent.mkdir(parents=True, exist_ok=True)
    existed_before = data_path.is_file()
    generated = False
    if args.force or not existed_before:
        if not game["valid"]:
            warnings.append("未找到游戏目录，无法生成数据：设 RIMWORLD_GAME 或写 rimworld-defs.local.json")
        else:
            action = run_script("extract_defs.py", [])
            if action["ok"]:
                generated = True
                actions.append("已重新生成数据")
            else:
                warnings.append(f"生成数据失败：{action.get('stderr') or action.get('tail')}")

    data_summary = read_data_summary(data_path) if data_path.is_file() else {"readable": False, "error": "数据文件不存在"}

    # 3. 工作区 / Skill 联接
    workspace = Path(args.workspace).expanduser().resolve() if args.workspace else None
    if args.link and workspace is None:
        warnings.append("--link 需要同时提供 --workspace")
    skill = describe_skill_link(workspace, args.link and workspace is not None)
    if skill["created"]:
        actions.append(f"已创建 Skill 联接：{skill['target']}")

    # 4. 创意工坊目录（可选能力）
    workshop_dir = paths.workshop_content_dir(game["path"] if game.get("path") else None)
    if workshop_dir is None:
        warnings.append("未找到创意工坊目录（<steamapps>/workshop/content/294100）；工坊功能不可用")

    ok = bool(game["valid"]) and data_summary.get("readable") and lxml_version is not None
    payload = {
        "ok": ok,
        "python": {"executable": sys.executable, "version": sys.version.split()[0], "required": ">=3.10"},
        "deps": {"lxml": lxml_version, "pillow": pillow_version, "unitypy": unitypy_version},
        "paths": {
            "repoRoot": str(REPO_ROOT),
            "gameRoot": {"path": game.get("path"), "source": game.get("source"), "valid": game.get("valid")},
            "dataPath": {"path": str(data_path), "source": data.get("source"), "exists": data_path.is_file()},
            "localConfig": {"path": local_config.get("path"), "exists": local_config.get("exists")},
        },
        "data": {**data_summary, "existedBefore": existed_before, "generated": generated},
        "workshop": {"contentDir": str(workshop_dir) if workshop_dir else None},
        "skill": skill,
        "actions": actions,
        "warnings": warnings,
    }

    if args.json:
        # ensure_ascii 保证在任意控制台编码下 stdout 都是纯 ASCII，Node 侧照常解析。
        print(json.dumps(payload, ensure_ascii=True))
    else:
        print(f"仓库根目录 : {REPO_ROOT}")
        print(f"游戏目录   : {game.get('path') or '(未找到)'}（来源 {game.get('source')}）")
        print(f"数据文件   : {data_path}（{'存在' if data_path.is_file() else '不存在'}）")
        print(f"Python     : {sys.version.split()[0]} @ {sys.executable}")
        print(f"依赖       : lxml={lxml_version} pillow={pillow_version} unitypy={unitypy_version}")
        if data_summary.get("readable"):
            print(f"数据内容   : {data_summary['defs']} defs / {data_summary['gameVersion']}")
        for item in actions:
            print(f"[动作] {item}")
        for item in warnings:
            print(f"[警告] {item}")
        print("状态：" + ("就绪" if ok else "未就绪"))

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
