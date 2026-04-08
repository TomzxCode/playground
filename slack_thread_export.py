#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "slack-sdk>=3.19.0",
# ]
# ///
"""
Slack Thread Exporter

Exports all Slack threads where a user participated to JSONL files.
Supports incremental updates via --days to refresh a rolling window.

Authentication:
    Requires a Slack user token (xoxp-*) with scopes:
        search:read, channels:history, groups:history, im:history, mpim:history

    Bot tokens (xoxb-*) cannot use search.messages — use a user token.

Output format (one JSON object per line):
    {
        "channel_id": "C123ABC",
        "thread_ts": "1234567890.123456",
        "message_count": 5,
        "messages": [ ... ],   # full conversations.replies payload
        "exported_at": "2024-01-15T12:00:00"
    }

Usage:
    export SLACK_TOKEN=xoxp-...
    uv run slack_thread_export.py --user @jane.doe --days 7 --output ./exports/
    # or make it executable: chmod +x slack_thread_export.py && ./slack_thread_export.py ...
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Generator, Optional, Set, Tuple

from slack_sdk import WebClient
from slack_sdk.errors import SlackApiError


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _handle_rate_limit(exc: SlackApiError, context: str) -> None:
    retry_after = int(exc.response.headers.get("Retry-After", 30))
    print(f"  [rate-limit] {context} – waiting {retry_after}s…", flush=True)
    time.sleep(retry_after)


def _ts_to_date(ts: float) -> str:
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------
# Step 1: search for user messages and collect (channel_id, thread_ts) pairs
# ---------------------------------------------------------------------------

def search_user_messages(
    client: WebClient,
    user_query: str,
    oldest_ts: float,
    latest_ts: float,
) -> Generator[Tuple[str, str], None, None]:
    """
    Yield unique (channel_id, thread_ts) pairs for messages sent by the user
    within [oldest_ts, latest_ts].

    Slack's search API only has day-granularity for date filters, so we widen
    the query by one day on each side and then filter by exact timestamp.

    user_query examples:
        @jane.doe        – display-name mention
        <@U123ABC>       – user-ID mention (most reliable)
    """
    oldest_dt = datetime.fromtimestamp(oldest_ts)
    latest_dt = datetime.fromtimestamp(latest_ts)

    # Widen by 1 day to compensate for day-granularity in search
    after_str = (oldest_dt - timedelta(days=1)).strftime("%Y-%m-%d")
    before_str = (latest_dt + timedelta(days=1)).strftime("%Y-%m-%d")

    query = f"from:{user_query} after:{after_str} before:{before_str}"
    page = 1
    total_pages: Optional[int] = None

    seen: Set[Tuple[str, str]] = set()

    while total_pages is None or page <= total_pages:
        while True:  # retry loop for rate limits
            try:
                response = client.search_messages(
                    query=query,
                    count=100,
                    page=page,
                    sort="timestamp",
                    sort_dir="desc",
                )
                break
            except SlackApiError as e:
                if e.response["error"] == "ratelimited":
                    _handle_rate_limit(e, "search.messages")
                    continue
                raise

        messages_data = response["messages"]
        paging = messages_data["paging"]
        total_pages = paging["pages"]
        matches = messages_data["matches"]

        print(
            f"  search page {page}/{total_pages} → {len(matches)} hits",
            flush=True,
        )

        for msg in matches:
            msg_ts = float(msg["ts"])
            # Exact timestamp filter (search has day granularity only)
            if not (oldest_ts <= msg_ts <= latest_ts):
                continue

            channel_id = msg["channel"]["id"]
            # thread_ts points to the root of the thread; fall back to msg ts
            thread_ts = msg.get("thread_ts") or msg["ts"]
            key = (channel_id, thread_ts)
            if key not in seen:
                seen.add(key)
                yield key

        page += 1


# ---------------------------------------------------------------------------
# Step 2: fetch the full thread via conversations.replies
# ---------------------------------------------------------------------------

def fetch_thread(
    client: WebClient,
    channel_id: str,
    thread_ts: str,
) -> list:
    """Return all messages in the thread (paginated)."""
    messages = []
    cursor: Optional[str] = None

    while True:
        kwargs = dict(channel=channel_id, ts=thread_ts, limit=200, inclusive=True)
        if cursor:
            kwargs["cursor"] = cursor

        while True:  # retry loop for rate limits
            try:
                response = client.conversations_replies(**kwargs)
                break
            except SlackApiError as e:
                if e.response["error"] == "ratelimited":
                    _handle_rate_limit(e, "conversations.replies")
                    continue
                raise

        messages.extend(response["messages"])

        if not response.get("has_more"):
            break
        cursor = response["response_metadata"]["next_cursor"]

    return messages


# ---------------------------------------------------------------------------
# Incremental-update support: skip already-exported threads
# ---------------------------------------------------------------------------

def load_exported_keys(output_file: Path) -> Set[Tuple[str, str]]:
    """Return (channel_id, thread_ts) pairs already present in the JSONL file."""
    exported: Set[Tuple[str, str]] = set()
    if not output_file.exists():
        return exported
    with open(output_file) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                exported.add((rec["channel_id"], rec["thread_ts"]))
            except (json.JSONDecodeError, KeyError):
                pass
    return exported


# ---------------------------------------------------------------------------
# Main export routine
# ---------------------------------------------------------------------------

def export_threads(
    token: str,
    user: str,
    output_dir: str,
    days: int,
    end_date: Optional[datetime] = None,
) -> None:
    client = WebClient(token=token)

    if end_date is None:
        end_date = datetime.now().replace(hour=23, minute=59, second=59, microsecond=0)
    start_date = (end_date - timedelta(days=days)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )

    oldest_ts = start_date.timestamp()
    latest_ts = end_date.timestamp()

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    date_tag = f"{start_date.strftime('%Y%m%d')}_{end_date.strftime('%Y%m%d')}"
    output_file = output_path / f"threads_{date_tag}.jsonl"

    print(f"User   : {user}")
    print(f"Range  : {start_date.date()} → {end_date.date()} ({days} days)")
    print(f"Output : {output_file}")
    print()

    # Load already-exported keys so re-runs are safe (append-only, no dupes)
    already_exported = load_exported_keys(output_file)
    if already_exported:
        print(f"Skipping {len(already_exported)} already-exported threads.\n")

    # ── Step 1: collect thread ids ──────────────────────────────────────────
    print("Step 1 – searching for user messages (newest first)…")
    thread_keys: list = []
    seen_set: Set[Tuple[str, str]] = set()

    for channel_id, thread_ts in search_user_messages(client, user, oldest_ts, latest_ts):
        key = (channel_id, thread_ts)
        if key not in seen_set:
            seen_set.add(key)
            thread_keys.append(key)

    new_keys = [k for k in thread_keys if k not in already_exported]

    print(
        f"\nFound {len(thread_keys)} unique thread(s); "
        f"{len(new_keys)} new to export.\n"
    )

    if not new_keys:
        print("Nothing new to export.")
        return

    # ── Step 2: fetch and write threads ────────────────────────────────────
    print(f"Step 2 – fetching {len(new_keys)} thread(s)…")
    exported_count = 0
    failed_count = 0

    with open(output_file, "a") as fh:
        for i, (channel_id, thread_ts) in enumerate(new_keys, 1):
            print(
                f"  [{i:>4}/{len(new_keys)}] channel={channel_id}  "
                f"thread_ts={thread_ts}  ({_ts_to_date(float(thread_ts))})",
                flush=True,
            )
            try:
                messages = fetch_thread(client, channel_id, thread_ts)
                record = {
                    "channel_id": channel_id,
                    "thread_ts": thread_ts,
                    "message_count": len(messages),
                    "messages": messages,
                    "exported_at": datetime.now().isoformat(),
                }
                fh.write(json.dumps(record) + "\n")
                exported_count += 1
            except SlackApiError as e:
                error = e.response.get("error", "unknown")
                print(f"         ERROR [{error}] – skipping thread")
                failed_count += 1
            except Exception as exc:
                print(f"         ERROR [{exc}] – skipping thread")
                failed_count += 1

    print(f"\nExported : {exported_count} thread(s) → {output_file}")
    if failed_count:
        print(f"Failed   : {failed_count} thread(s)")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export Slack threads where a user participated to JSONL files.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  # last 7 days (default)
  uv run slack_thread_export.py --user @jane.doe

  # last 30 days, custom output directory
  uv run slack_thread_export.py --user @jane.doe --days 30 --output ./exports/

  # specific end date (useful for backfills)
  uv run slack_thread_export.py --user @jane.doe --days 7 --end-date 2024-01-01

  # use user ID instead of display name (more reliable)
  uv run slack_thread_export.py --user "<@U04ABCDEF>" --days 7

token:
  Set SLACK_TOKEN env var or pass --token.
  Must be a USER token (xoxp-*) – bot tokens cannot use search.messages.
  Required scopes: search:read, channels:history, groups:history,
                   im:history, mpim:history
""",
    )
    parser.add_argument(
        "--user",
        required=True,
        help=(
            "Slack user to search for. "
            "Use @display-name or <@UXXXXXXXX> (user ID, most reliable)."
        ),
    )
    parser.add_argument(
        "--days",
        type=int,
        default=7,
        help="Number of days to look back from end-date (default: 7).",
    )
    parser.add_argument(
        "--output",
        default="./slack_exports",
        help="Directory for output JSONL files (default: ./slack_exports).",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("SLACK_TOKEN"),
        help="Slack API token (default: $SLACK_TOKEN env var).",
    )
    parser.add_argument(
        "--end-date",
        metavar="YYYY-MM-DD",
        help="Inclusive end date for the export window (default: today).",
    )

    args = parser.parse_args()

    if not args.token:
        parser.error(
            "Slack token is required. "
            "Set the SLACK_TOKEN environment variable or pass --token."
        )

    end_date: Optional[datetime] = None
    if args.end_date:
        try:
            end_date = datetime.strptime(args.end_date, "%Y-%m-%d").replace(
                hour=23, minute=59, second=59
            )
        except ValueError:
            parser.error(f"Invalid --end-date format: {args.end_date!r}. Use YYYY-MM-DD.")

    try:
        export_threads(
            token=args.token,
            user=args.user,
            output_dir=args.output,
            days=args.days,
            end_date=end_date,
        )
    except SlackApiError as e:
        print(f"\nSlack API error: {e.response['error']}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)


if __name__ == "__main__":
    main()
