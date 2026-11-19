#!/usr/bin/env python3
"""Build validation/heldout/heldout_manifest.csv from Zenodo 17866827 (IG2_data.zip).

Uses HTTP Range requests to read only the ZIP End of Central Directory (EOCD)
and Central Directory (~50 KB) instead of downloading the full 955 MB archive.
"""

from __future__ import annotations

import csv
import os
import struct
import urllib.request
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

ZENODO_RECORD_URL = "https://zenodo.org/api/records/17866827"
IG2_ZIP_URL = "https://zenodo.org/records/17866827/files/IG2_data.zip?download=1"
EXPECTED_SIZE_BYTES = 955926595

# Crops from K1_C2_385 / K1_C3_0449 in dmair1989/imagegrains demo_data appear in APF_2
K1_OVERLAP_PREFIXES = ("K1_2_C1_DJI_0385", "K1_2_C1_DJI_0449", "K1_C2_385", "K1_C3_0449")


def http_range_get(url: str, start: int, end: int) -> bytes:
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def http_head_size(url: str) -> int:
    req = urllib.request.Request(url, method="HEAD")
    with urllib.request.urlopen(req, timeout=30) as resp:
        cl = resp.headers.get("Content-Length")
        if cl is None:
            raise RuntimeError("Missing Content-Length header")
        return int(cl)


def parse_zip_central_directory(url: str) -> list[dict]:
    total_size = http_head_size(url)
    tail_len = min(65557, total_size)
    tail = http_range_get(url, total_size - tail_len, total_size - 1)

    eocd_sig = b"PK\x05\x06"
    eocd_idx = tail.rfind(eocd_sig)
    if eocd_idx == -1:
        raise RuntimeError("Could not locate ZIP End of Central Directory (EOCD)")

    (
        _disk_no,
        _cd_disk,
        _disk_entries,
        total_entries,
        cd_size,
        cd_offset,
        _comment_len,
    ) = struct.unpack_from("<HHHHIIH", tail, eocd_idx + 4)

    cd_bytes = http_range_get(url, cd_offset, cd_offset + cd_size - 1)
    entries = []
    pos = 0
    cd_sig = b"PK\x01\x02"
    while pos < len(cd_bytes):
        if cd_bytes[pos : pos + 4] != cd_sig:
            raise RuntimeError(f"Unexpected CD signature at offset {pos}")
        (
            _ver_made,
            _ver_need,
            _flags,
            _method,
            _mtime,
            _mdate,
            crc32,
            comp_size,
            uncomp_size,
            fname_len,
            extra_len,
            comment_len,
            _disk_start,
            _int_attr,
            _ext_attr,
            _local_hdr_off,
        ) = struct.unpack_from("<HHHHHHIIIHHHHHII", cd_bytes, pos + 4)
        fname_start = pos + 46
        fname = cd_bytes[fname_start : fname_start + fname_len].decode("utf-8", errors="replace")
        entries.append(
            {
                "filename": fname,
                "crc32": crc32,
                "comp_size": comp_size,
                "uncomp_size": uncomp_size,
            }
        )
        pos = fname_start + fname_len + extra_len + comment_len

    if len(entries) != total_entries:
        raise RuntimeError(f"Expected {total_entries} entries, parsed {len(entries)}")
    return entries


def build_manifest_rows(entries: list[dict]) -> list[dict]:
    # Group files by (site, split)
    # Expected layout inside IG2_data.zip: IG2_data/<SITE>/<train|test>/<filename>
    buckets: dict[tuple[str, str], dict[str, dict]] = defaultdict(dict)
    for e in entries:
        fn = e["filename"]
        if fn.endswith("/"):
            continue
        parts = [p for p in fn.split("/") if p]
        if len(parts) < 3:
            continue
        # Handle optional top-level IG2_data/ folder
        if parts[0] == "IG2_data" and len(parts) >= 4:
            site, split, leaf = parts[1], parts[2], "/".join(parts[3:])
        else:
            site, split, leaf = parts[0], parts[1], "/".join(parts[2:])
        if split not in ("train", "test"):
            continue
        buckets[(site, split)][leaf] = {
            "relpath": fn,
            "bytes": e["uncomp_size"],
        }

    rows: list[dict] = []
    for (site, split) in sorted(buckets.keys()):
        files = buckets[(site, split)]
        # Identify masks vs images: masks end with _mask.tif / _mask.png / _masks.tif etc.
        images = {
            k: v
            for k, v in files.items()
            if "_mask" not in k.lower()
            and k.lower().endswith((".jpg", ".jpeg", ".png", ".tif", ".tiff"))
        }
        masks = {
            k: v
            for k, v in files.items()
            if "_mask" in k.lower()
            and k.lower().endswith((".jpg", ".jpeg", ".png", ".tif", ".tiff", ".npy"))
        }

        for img_leaf, img_info in sorted(images.items()):
            stem = os.path.splitext(img_leaf)[0]
            # Match mask by stem
            matched_mask = None
            for m_leaf, m_info in masks.items():
                m_stem = os.path.splitext(m_leaf)[0]
                if m_stem in (f"{stem}_mask", f"{stem}_masks", f"{stem}_cp_masks"):
                    matched_mask = m_info["relpath"]
                    break
            if matched_mask is None:
                raise RuntimeError(f"No mask found for {site}/{split}/{img_leaf}")

            uid = f"{site}__{split}__{stem}"
            is_k1 = any(img_leaf.startswith(pfx) for pfx in K1_OVERLAP_PREFIXES)
            rows.append(
                {
                    "uid": uid,
                    "site": site,
                    "official_split": split,
                    "image_relpath": img_info["relpath"],
                    "mask_relpath": matched_mask,
                    "image_bytes": img_info["bytes"],
                    "is_k1_overlap": "true" if is_k1 else "false",
                }
            )

    return rows


def main() -> None:
    out_csv = Path(__file__).resolve().parent / "heldout_manifest.csv"
    print(f"Fetching central directory from {IG2_ZIP_URL} ...")
    entries = parse_zip_central_directory(IG2_ZIP_URL)
    print(f"Parsed {len(entries)} zip entries.")

    rows = build_manifest_rows(entries)
    split_counts = Counter(r["official_split"] for r in rows)
    site_counts = Counter(r["site"] for r in rows)
    k1_count = sum(1 for r in rows if r["is_k1_overlap"] == "true")

    fieldnames = [
        "uid",
        "site",
        "official_split",
        "image_relpath",
        "mask_relpath",
        "image_bytes",
        "is_k1_overlap",
    ]
    with out_csv.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} rows to {out_csv}")
    print(f"Split counts: {dict(split_counts)}")
    print(f"Sites ({len(site_counts)}): {sorted(site_counts.keys())}")
    print(f"K1 overlap rows: {k1_count}")

    assert len(rows) == 243, f"Expected 243 rows in IG2_data.zip, got {len(rows)}"
    assert split_counts["test"] == 40, f"Expected 40 test rows, got {split_counts['test']}"
    assert split_counts["train"] == 203, f"Expected 203 train rows, got {split_counts['train']}"
    assert len(site_counts) == 13, f"Expected 13 sites, got {len(site_counts)}"


if __name__ == "__main__":
    main()
