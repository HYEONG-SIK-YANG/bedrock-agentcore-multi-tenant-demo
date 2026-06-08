"""AC-Harness pii-lookup tool.

Wired into the shared Gateway as MCP tool `pii-lookup-mcp`. Cedar Policy
(Phase 6) gates the *call*; this Lambda assumes the call is already
authorized and returns the row.

Input schema (MCP tool args):
    { "query": "<username | employee_id>" }

Output: a flat dict of the matching employee row, or {"error": "not_found"}.

Lookup strategy:
    1. If query starts with "E-", treat as employee_id (table PK).
    2. Otherwise, query the username GSI.

Env:
    DDB_TABLE      — required, DynamoDB table name.
    USERNAME_INDEX — defaults to "username-index".
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import boto3
from botocore.config import Config

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_TABLE_NAME = os.environ["DDB_TABLE"]
_USERNAME_INDEX = os.environ.get("USERNAME_INDEX", "username-index")

# Reuse a single client across warm invocations.
_ddb = boto3.client(
    "dynamodb",
    config=Config(retries={"max_attempts": 3, "mode": "standard"}),
)


def _unmarshall(item: dict[str, dict[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in item.items():
        # Seed only writes string attributes; this is sufficient for PoC.
        out[k] = v.get("S") if "S" in v else next(iter(v.values()))
    return out


def _extract_query(event: dict[str, Any]) -> str:
    # MCP tool calls land here either via Gateway (already-unwrapped args)
    # or via direct invoke for testing. Accept both shapes.
    if "query" in event:
        return str(event["query"]).strip()
    args = event.get("arguments") or event.get("input") or {}
    if isinstance(args, str):
        args = json.loads(args)
    return str(args.get("query", "")).strip()


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    logger.info("pii-lookup invoked: %s", json.dumps(event)[:1000])

    query = _extract_query(event)
    if not query:
        return {"error": "missing_query"}

    if query.upper().startswith("E-"):
        resp = _ddb.get_item(
            TableName=_TABLE_NAME,
            Key={"employee_id": {"S": query}},
        )
        item = resp.get("Item")
    else:
        resp = _ddb.query(
            TableName=_TABLE_NAME,
            IndexName=_USERNAME_INDEX,
            KeyConditionExpression="username = :u",
            ExpressionAttributeValues={":u": {"S": query}},
            Limit=1,
        )
        items = resp.get("Items", [])
        item = items[0] if items else None

    if not item:
        return {"error": "not_found", "query": query}

    return _unmarshall(item)
