#!/usr/bin/env python3
"""Validate and safely extract a privately sourced Santo medical corpus ZIP.

The ZIP is NOT stored in this public repository. All checks run BEFORE R2 writes.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import stat
import zipfile

ARCHIVE_NAME = "santo_staging_medical_library_r2_bundle.zip"
EXPECTED_OBJECTS = {"medical-articles": 7049, "medical-search": 67524,
                    "medical-library-catalog": 6}
ALLOWED = (
    re.compile(r"medical-articles/v1/(amboss|usmle|passmedicine|pastest|one-examination)/[a-z0-9-]+\.json"),
    re.compile(r"medical-search/v1/(amboss|usmle|passmedicine|pastest|one-examination)/[a-z0-9-]+/s-[0-9]{4}\.md"),
    re.compile(r"medical-library-catalog/v1/(catalog|amboss|usmle|passmedicine|pastest|one-examination)\.json"),
)
MAX_EXPANDED_BYTES = 300 * 1024 * 1024
MAX_ENTRY_BYTES = 2_000_000
MAX_MEMBER_COUNT = 85000


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_and_extract(archive: Path, destination: Path, expected_sha256: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256):
        raise ValueError("Expected SHA-256 must be 64 lowercase hex characters")
    actual = sha256_file(archive)
    if actual != expected_sha256:
        raise ValueError("Bundle SHA-256 mismatch — refusing to extract or upload")
    if archive.stat().st_size > 150 * 1024 * 1024:
        raise ValueError("Compressed bundle exceeds 150 MiB")

    counters = Counter()
    extracted_bytes = 0
    seen = set()
    with zipfile.ZipFile(archive) as bundle:
        members = bundle.infolist()
        if len(members) > MAX_MEMBER_COUNT:
            raise ValueError("Too many ZIP members")
        for entry in members:
            if entry.is_dir():
                continue
            name = entry.filename
            pure = PurePosixPath(name)
            if pure.is_absolute() or ".." in pure.parts or "\\" in name:
                raise ValueError("Unsafe ZIP path")
            mode = (entry.external_attr >> 16)
            if stat.S_ISLNK(mode):
                raise ValueError("Symlinks are not allowed in the bundle")
            if name == "export-report.json":
                continue  # local-only statistics, never upload
            if name in seen:
                raise ValueError("Duplicate object key")
            seen.add(name)
            if not any(regex.fullmatch(name) for regex in ALLOWED):
                raise ValueError("Unexpected bundle object key")
            if entry.file_size > MAX_ENTRY_BYTES:
                raise ValueError("Oversized R2 object")
            extracted_bytes += entry.file_size
            if extracted_bytes > MAX_EXPANDED_BYTES:
                raise ValueError("Oversized expanded ZIP")
            counters[pure.parts[0]] += 1

        if dict(counters) != EXPECTED_OBJECTS:
            raise ValueError(f"Incorrect bundle object counts: {dict(counters)}")
        catalog = json.loads(bundle.read("medical-library-catalog/v1/catalog.json"))
        by_id = {entry["id"]: entry["count"] for entry in catalog["libraries"]}
        if by_id != {"amboss":1481, "usmle":948, "passmedicine":3109,
                     "pastest":1127, "one-examination":384}:
            raise ValueError("Incorrect expected medical library manifest")
        if sum(by_id.values()) != EXPECTED_OBJECTS["medical-articles"]:
            raise ValueError("Manifest article total mismatch")

        destination.mkdir(parents=True, exist_ok=True)
        resolved_root = destination.resolve()
        for entry in members:
            if entry.is_dir() or entry.filename == "export-report.json":
                continue
            dest = (destination / entry.filename).resolve()
            if not dest.is_relative_to(resolved_root):
                raise ValueError("ZIP path escapes extraction root")
            dest.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(entry) as source, dest.open("wb") as output:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)

    return {"objectCount": sum(counters.values()), "byRoot": dict(counters),
            "expandedMiB": round(extracted_bytes / 1048576, 2),
            "archiveSha256": actual}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--zip", required=True)
    ap.add_argument("--sha256", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    print(json.dumps(verify_and_extract(Path(args.zip), Path(args.out), args.sha256),
                     indent=2))
