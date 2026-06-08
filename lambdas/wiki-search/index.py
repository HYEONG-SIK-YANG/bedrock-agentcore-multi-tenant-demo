"""AC-Harness wiki-search tool.

Wired into the shared Gateway as MCP tool `wiki-search-mcp`. Performs a
BM25 multi-match across the AOSS `wiki-shared` index.

Input schema:
    { "query": "<free text>", "size": <int, optional, default 5> }

Output:
    { "hits": [ { "id", "title", "score", "snippet" }, ... ] }

Env:
    OPENSEARCH_ENDPOINT — required, e.g. "https://abc.us-east-1.aoss.amazonaws.com"
    INDEX_NAME          — defaults to "wiki-shared".
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any
from urllib.parse import urlparse

import boto3
from opensearchpy import AWSV4SignerAuth, OpenSearch, RequestsHttpConnection

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

_ENDPOINT = os.environ["OPENSEARCH_ENDPOINT"]
_INDEX = os.environ.get("INDEX_NAME", "wiki-shared")
_REGION = os.environ.get("AWS_REGION", "us-east-1")

_host = urlparse(_ENDPOINT).hostname
_credentials = boto3.Session().get_credentials()
_auth = AWSV4SignerAuth(_credentials, _REGION, "aoss")

_client = OpenSearch(
    hosts=[{"host": _host, "port": 443}],
    http_auth=_auth,
    use_ssl=True,
    verify_certs=True,
    connection_class=RequestsHttpConnection,
    pool_maxsize=20,
    timeout=30,
    max_retries=3,
    retry_on_timeout=True,
)


def _extract_args(event: dict[str, Any]) -> tuple[str, int]:
    if "query" in event:
        return str(event["query"]).strip(), int(event.get("size", 5))
    args = event.get("arguments") or event.get("input") or {}
    if isinstance(args, str):
        args = json.loads(args)
    return str(args.get("query", "")).strip(), int(args.get("size", 5))


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    logger.info("wiki-search invoked: %s", json.dumps(event)[:1000])

    query, size = _extract_args(event)
    if not query:
        return {"hits": [], "error": "missing_query"}

    body = {
        "size": max(1, min(size, 20)),
        "query": {
            "multi_match": {
                "query": query,
                "fields": ["title^2", "body"],
            }
        },
        "highlight": {"fields": {"body": {"fragment_size": 180, "number_of_fragments": 1}}},
    }

    resp = _client.search(index=_INDEX, body=body)
    hits_out = []
    for h in resp.get("hits", {}).get("hits", []):
        src = h.get("_source", {})
        highlight = h.get("highlight", {}).get("body", [])
        snippet = highlight[0] if highlight else (src.get("body", "")[:180])
        hits_out.append(
            {
                "id": h.get("_id"),
                "title": src.get("title"),
                "score": h.get("_score"),
                "snippet": snippet,
            }
        )

    return {"hits": hits_out, "total": resp.get("hits", {}).get("total", {}).get("value", 0)}
