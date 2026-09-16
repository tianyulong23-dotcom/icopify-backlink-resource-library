from __future__ import annotations

import argparse
import csv
import json
import sqlite3
from collections import Counter
from pathlib import Path
from urllib.parse import urlparse


CSV_FIELDS = [
    "website_id",
    "website",
    "domain",
    "website_url",
    "categories",
    "monthly_traffic",
    "ahrefs_dr",
    "moz_da",
    "language",
    "price",
    "currency",
    "max_links",
    "link_type",
    "turnaround",
    "added_on",
    "source_page",
]


def normalized_domain(row: dict) -> str:
    url = row.get("website_url") or row.get("website") or ""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    return (parsed.hostname or "").lower().removeprefix("www.")


def load_rows(raw_path: Path) -> list[dict]:
    rows = []
    with raw_path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as error:
                raise ValueError(f"Invalid JSON on line {line_number}") from error
            row["domain"] = normalized_domain(row)
            rows.append(row)
    return rows


def deduplicate(rows: list[dict]) -> tuple[list[dict], int]:
    selected: dict[str, dict] = {}
    for row in rows:
        key = (
            f"domain:{row['domain']}"
            if row.get("domain")
            else f"website_id:{row.get('website_id') or row.get('website')}"
        )
        current = selected.get(key)
        if current is None:
            selected[key] = row
            continue
        current_score = sum(current.get(field) is not None for field in CSV_FIELDS)
        new_score = sum(row.get(field) is not None for field in CSV_FIELDS)
        if new_score > current_score:
            selected[key] = row
    return list(selected.values()), len(rows) - len(selected)


def write_csv(rows: list[dict], output_path: Path) -> None:
    with output_path.open("w", newline="", encoding="utf-8-sig") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for row in rows:
            item = {field: row.get(field) for field in CSV_FIELDS}
            item["categories"] = " | ".join(row.get("categories") or [])
            writer.writerow(item)


def write_sqlite(rows: list[dict], output_path: Path) -> None:
    with sqlite3.connect(output_path) as connection:
        connection.execute("DROP TABLE IF EXISTS publishers")
        connection.execute(
            """
            CREATE TABLE publishers (
                website_id TEXT,
                website TEXT NOT NULL,
                domain TEXT,
                website_url TEXT,
                categories_json TEXT NOT NULL,
                monthly_traffic INTEGER,
                ahrefs_dr INTEGER,
                moz_da INTEGER,
                language TEXT,
                price REAL,
                currency TEXT,
                max_links INTEGER,
                link_type TEXT,
                turnaround TEXT,
                added_on TEXT,
                source_page INTEGER
            )
            """
        )
        connection.executemany(
            """
            INSERT INTO publishers VALUES (
                :website_id, :website, :domain, :website_url, :categories_json,
                :monthly_traffic, :ahrefs_dr, :moz_da, :language, :price,
                :currency, :max_links, :link_type, :turnaround, :added_on,
                :source_page
            )
            """,
            [
                {
                    **row,
                    "categories_json": json.dumps(
                        row.get("categories") or [], ensure_ascii=False
                    ),
                }
                for row in rows
            ],
        )
        connection.execute(
            "CREATE UNIQUE INDEX publishers_domain_idx ON publishers(domain) "
            "WHERE domain IS NOT NULL AND domain <> ''"
        )
        connection.execute(
            "CREATE INDEX publishers_metrics_idx "
            "ON publishers(ahrefs_dr, moz_da, monthly_traffic)"
        )


def build_summary(
    rows: list[dict],
    raw_count: int,
    raw_source_pages: int,
    duplicate_count: int,
) -> dict:
    missing = {
        field: sum(row.get(field) in (None, "", []) for row in rows)
        for field in [
            "website",
            "categories",
            "monthly_traffic",
            "ahrefs_dr",
            "moz_da",
            "language",
            "price",
        ]
    }
    languages = Counter(row.get("language") or "Unknown" for row in rows)
    return {
        "raw_rows": raw_count,
        "unique_rows": len(rows),
        "duplicates_removed": duplicate_count,
        "source_pages": raw_source_pages,
        "missing_values": missing,
        "top_languages": dict(languages.most_common(20)),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "raw_path",
        type=Path,
        nargs="?",
        default=Path("data/icopify-39023/publishers.raw.jsonl"),
    )
    args = parser.parse_args()

    output_dir = args.raw_path.parent
    rows = load_rows(args.raw_path)
    raw_source_pages = len({row.get("source_page") for row in rows})
    unique_rows, duplicate_count = deduplicate(rows)
    unique_rows.sort(key=lambda row: (row.get("domain") or "", row.get("website_id") or ""))

    write_csv(unique_rows, output_dir / "publishers.csv")
    write_sqlite(unique_rows, output_dir / "publishers.sqlite")
    summary = build_summary(
        unique_rows,
        len(rows),
        raw_source_pages,
        duplicate_count,
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
