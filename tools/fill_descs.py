"""列出内置词库里缺少中文描述的 tag，供翻译用。

    python tools/fill_descs.py --report            # 只看统计
    python tools/fill_descs.py --report --dump _translate   # 顺便导出待翻译清单
    python tools/fill_descs.py --map a.json b.json  # 把翻译合并进内置词库
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PKG_DIR = os.path.dirname(HERE)
if PKG_DIR not in sys.path:
    sys.path.insert(0, PKG_DIR)

import tag_store  # noqa: E402


def iter_builtin_paths():
    return sorted(glob.glob(os.path.join(tag_store.BUILTIN_DIR, "*.json")))


def missing_of(lib: dict) -> list:
    """[(一级, 二级, tag)] —— 没有中文描述的 tag"""
    out = []
    for g in lib["groups"]:
        for s in g["subs"]:
            descs = s.get("descs") or {}
            for t in s["tags"]:
                if not descs.get(t):
                    out.append((g["name"], s["name"], t))
    return out


def load(path: str) -> dict:
    with open(path, "r", encoding="utf-8-sig") as f:
        return json.load(f)


def report(dump_dir: str = None) -> int:
    total_missing = 0
    parts = []
    for path in iter_builtin_paths():
        lib = tag_store.normalize_library(load(path), name=os.path.splitext(os.path.basename(path))[0])
        counts = tag_store.library_counts(lib)
        miss = missing_of(lib)
        total_missing += len(miss)
        print(
            "%-22s %-14s tag=%-5d 描述=%-5d 缺失=%-4d"
            % (
                os.path.basename(path),
                lib.get("name"),
                counts["tags"],
                counts["tags"] - len(miss),
                len(miss),
            )
        )
        parts.append((os.path.basename(path), lib, miss))

    if dump_dir and total_missing:
        os.makedirs(dump_dir, exist_ok=True)
        # 按文件 + 分类切块，每块 ~150 条，方便分头翻译
        chunk, chunk_idx = [], 0
        index = []
        for fname, lib, miss in parts:
            for gname, sname, tag in miss:
                chunk.append(tag)
                if len(chunk) >= 150:
                    chunk_idx += 1
                    out = os.path.join(dump_dir, "part_%02d.txt" % chunk_idx)
                    with open(out, "w", encoding="utf-8", newline="\n") as f:
                        f.write("\n".join(chunk) + "\n")
                    index.append({"part": os.path.basename(out), "count": len(chunk)})
                    chunk = []
        if chunk:
            chunk_idx += 1
            out = os.path.join(dump_dir, "part_%02d.txt" % chunk_idx)
            with open(out, "w", encoding="utf-8", newline="\n") as f:
                f.write("\n".join(chunk) + "\n")
            index.append({"part": os.path.basename(out), "count": len(chunk)})
        with open(os.path.join(dump_dir, "index.json"), "w", encoding="utf-8") as f:
            json.dump({"total": total_missing, "parts": index}, f, ensure_ascii=False, indent=2)
        print("\n已导出 %d 块待翻译清单到 %s" % (len(index), dump_dir))
        for item in index:
            print("  %s  %d 条" % (item["part"], item["count"]))

    print("\n合计缺少描述:", total_missing)
    return 0 if total_missing == 0 else 0


def apply_maps(maps, dry_run=False) -> int:
    """把 {tag: 中文} 合并进内置词库（只填缺失的，不动已有描述）"""
    translations = {}
    for path in maps:
        data = load(path)
        if not isinstance(data, dict):
            print("跳过（不是 JSON 对象）：%s" % path)
            continue
        added = 0
        for key, value in data.items():
            tag = tag_store._clean_tag(key)
            desc = value.strip() if isinstance(value, str) else ""
            if tag and desc:
                translations[tag.lower()] = (tag, desc)
                added += 1
        print("%-40s +%d" % (os.path.basename(path), added))

    print("合并后翻译条数:", len(translations))

    for path in iter_builtin_paths():
        lib = tag_store.normalize_library(load(path), name=os.path.splitext(os.path.basename(path))[0])
        miss = missing_of(lib)
        if not miss:
            print("%-22s 已完整" % os.path.basename(path))
            continue
        filled = 0
        for g in lib["groups"]:
            for s in g["subs"]:
                descs = s.get("descs")
                if not isinstance(descs, dict):
                    descs = {}
                for t in s["tags"]:
                    if descs.get(t):
                        continue
                    hit = translations.get(t.lower())
                    if hit:
                        descs[t] = hit[1]
                        filled += 1
                if descs:
                    s["descs"] = descs
        still = len(missing_of(lib))
        print(
            "%-22s 补 %d 条，仍缺 %d 条" % (os.path.basename(path), filled, still)
        )
        if not dry_run and filled:
            lib["updated_at"] = tag_store._now()
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                json.dump(lib, f, ensure_ascii=False, indent=2)
                f.write("\n")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="内置词库中文描述维护")
    parser.add_argument("--report", action="store_true", help="统计缺失情况")
    parser.add_argument("--dump", default=None, help="把待翻译 tag 导出到目录")
    parser.add_argument("--map", nargs="*", default=None, help="合并 {tag:中文} 的 JSON 文件")
    parser.add_argument("--dry-run", action="store_true", help="只统计不写文件")
    args = parser.parse_args()

    if args.map:
        return apply_maps(args.map, dry_run=args.dry_run)
    return report(dump_dir=args.dump)


if __name__ == "__main__":
    raise SystemExit(main())
