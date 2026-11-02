"""把 WeiLin-Comfyui-Tools 导出的 tag SQL 转成本插件的 JSON 词库。

用法：

    # 单个文件（输出到 builtin_tags/人物.json）
    python tools/weilin_sql_to_json.py "D:/xxx/人物_export_1793173496021.sql" --name 人物 --filename renwu

    # 整个目录里的所有 .sql，每个文件一份词库
    python tools/weilin_sql_to_json.py "D:/xxx" -o builtin_tags

    # 目录里所有 .sql 合并成一份词库
    python tools/weilin_sql_to_json.py "D:/xxx" --merge --name 全部人物

也可以用 `--out-dir` 直接写进 ComfyUI 的用户词库目录：

    python tools/weilin_sql_to_json.py xxx.sql --out-dir "D:/ComfyUI/user/prompt_tag_manager"

转换完成后重启 ComfyUI（或在面板里切一下词库）即可看到。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(HERE)
if PKG_DIR not in sys.path:
    sys.path.insert(0, PKG_DIR)

import tag_store  # noqa: E402


def _ascii_stem(text: str, fallback: str = "weilin_tags") -> str:
    """取一个安全的文件名（尽量保留 ASCII）。"""
    out = []
    for ch in str(text or ""):
        if ch.isascii() and (ch.isalnum() or ch in "-_ "):
            out.append(ch)
        elif not ch.isascii():
            continue
        else:
            out.append("_")
    cleaned = "".join(out).strip().strip("_")
    cleaned = "_".join(cleaned.split())
    return cleaned or fallback


def collect(paths) -> list:
    files = []
    for path in paths:
        if os.path.isdir(path):
            for name in sorted(os.listdir(path)):
                if name.lower().endswith(".sql"):
                    files.append(os.path.join(path, name))
        elif os.path.isfile(path):
            files.append(path)
        else:
            print("跳过（不存在）：%s" % path)
    return files


def convert_one(path: str, name: str = None) -> dict:
    """按扩展名解析（.sql 走流式解析，上百 MB 也不会把内存吃爆）。"""
    return tag_store.parse_file(path, name=name)


def describe(lib: dict) -> str:
    counts = tag_store.library_counts(lib)
    descs = sum(
        len(s.get("descs") or {}) for g in lib["groups"] for s in g.get("subs") or []
    )
    return "%d 个一级 / %d 个二级 / %d 个 tag / %d 条中文描述" % (
        counts["groups"],
        counts["subs"],
        counts["tags"],
        descs,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="WeiLin tag SQL → 本插件 JSON 词库")
    parser.add_argument("paths", nargs="+", help=".sql 文件或包含 .sql 的目录")
    parser.add_argument("-o", "--out-dir", default=os.path.join(PKG_DIR, "builtin_tags"), help="输出目录")
    parser.add_argument("--name", default=None, help="词库名（默认用文件名）")
    parser.add_argument("--filename", default=None, help="输出文件名（不含 .json，默认自动生成）")
    parser.add_argument("--merge", action="store_true", help="把多个 .sql 合并成一份词库")
    parser.add_argument(
        "--split-by-tags",
        type=int,
        default=0,
        metavar="N",
        help="按二级分类拆分成多份词库，每份最多约 N 个 tag（超大文件建议用，例如 3000）",
    )
    args = parser.parse_args()

    files = collect(args.paths)
    if not files:
        print("没有找到任何 .sql 文件")
        return 1

    os.makedirs(args.out_dir, exist_ok=True)

    if args.merge:
        merged = None
        for path in files:
            lib = convert_one(path, args.name if len(files) == 1 else None)
            print("  读入 %s → %s" % (os.path.basename(path), describe(lib)))
            merged = lib if merged is None else tag_store.merge_library(merged, lib)
        out_name = tag_store.sanitize_name(args.name or "WeiLin 合并词库")
        merged["name"] = out_name
        if args.split_by_tags:
            return write_split(merged, args.split_by_tags, args.out_dir, args.filename)
        stem = args.filename or _ascii_stem(out_name, "weilin_merged")
        write(os.path.join(args.out_dir, stem + ".json"), merged)
        return 0

    written = 0
    for path in files:
        lib = convert_one(path, args.name if len(files) == 1 else None)
        if len(files) == 1 and args.name:
            lib["name"] = tag_store.sanitize_name(args.name)
        if args.split_by_tags:
            written += write_split(lib, args.split_by_tags, args.out_dir, args.filename)
            continue
        stem = args.filename if (args.filename and len(files) == 1) else _ascii_stem(lib.get("name") or os.path.basename(path))
        out_path = os.path.join(args.out_dir, stem + ".json")
        write(out_path, lib)
        written += 1
    return 0 if written else 1


def write_split(lib: dict, max_tags: int, out_dir: str, stem: str = None) -> int:
    """把词库按二级分类拆成多份写盘，返回写出的份数。"""
    base = stem or _ascii_stem(lib.get("name") or "weilin_tags")
    parts = tag_store.split_library(lib, max_tags, name=lib.get("name"))
    total = tag_store.library_counts(lib)
    print(
        "\n拆分为 %d 份（原 %d 个 tag / %d 个二级分类，每份上限约 %d tag）"
        % (len(parts), total["tags"], total["subs"], max_tags)
    )
    for idx, part in enumerate(parts, 1):
        counts = tag_store.library_counts(part)
        out_path = os.path.join(out_dir, "%s-%02d.json" % (base, idx))
        with open(out_path, "w", encoding="utf-8", newline="\n") as f:
            json.dump(tag_store.normalize_library(part, name=part.get("name")), f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(
            "  %s  %d 个一级 / %d 个二级 / %d 个 tag"
            % (os.path.basename(out_path), counts["groups"], counts["subs"], counts["tags"])
        )
    return len(parts)


def write(out_path: str, lib: dict) -> None:
    lib = tag_store.normalize_library(lib, name=lib.get("name"))
    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(lib, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print("写出 %s" % out_path)
    print("  词库名：%s" % lib.get("name"))
    print("  统计：%s" % describe(lib))
    if lib["groups"]:
        for g in lib["groups"][:5]:
            subs = "、".join(s["name"] for s in g["subs"][:6])
            print("  - %s：%s" % (g["name"], subs))
        if len(lib["groups"]) > 5:
            print("  - …（共 %d 个一级分类）" % len(lib["groups"]))


if __name__ == "__main__":
    raise SystemExit(main())
