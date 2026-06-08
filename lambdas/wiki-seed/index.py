"""AC-Harness wiki-seed CR Lambda.

Invoked once by an AwsCustomResource at deploy time. Idempotent:
  - Creates the `wiki-shared` index if missing (mappings: title text, body text).
  - Bulk-indexes every .md file packaged alongside this Lambda.
  - On stack delete, the index is dropped (so cdk destroy is clean).

Markdown files are bundled into the Lambda asset under ./docs/*.md by the
CDK stack (asset includes data/wiki-seed/* via Code.fromAsset bundling).
The first H1 (`# title`) is the doc title; remainder is the body.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import boto3
from opensearchpy import AWSV4SignerAuth, OpenSearch, RequestsHttpConnection
from opensearchpy.helpers import bulk

logger = logging.getLogger()
logger.setLevel("INFO")

_ENDPOINT = os.environ["OPENSEARCH_ENDPOINT"]
_INDEX = os.environ.get("INDEX_NAME", "wiki-shared")
_REGION = os.environ.get("AWS_REGION", "us-east-1")
_DOCS_DIR = Path(os.environ.get("DOCS_DIR", "/var/task/docs"))

_host = urlparse(_ENDPOINT).hostname
_creds = boto3.Session().get_credentials()
_auth = AWSV4SignerAuth(_creds, _REGION, "aoss")

_client = OpenSearch(
    hosts=[{"host": _host, "port": 443}],
    http_auth=_auth,
    use_ssl=True,
    verify_certs=True,
    connection_class=RequestsHttpConnection,
    pool_maxsize=4,
    timeout=90,
    max_retries=3,
    retry_on_timeout=True,
)


def _parse_md(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    title = path.stem
    lines = text.splitlines()
    body_start = 0
    for i, line in enumerate(lines):
        if line.startswith("# "):
            title = line[2:].strip()
            body_start = i + 1
            break
    body = "\n".join(lines[body_start:]).strip()
    return title, body


def _ensure_index() -> None:
    if _client.indices.exists(index=_INDEX):
        logger.info("index %s already exists", _INDEX)
        return
    _client.indices.create(
        index=_INDEX,
        body={
            "settings": {"index": {"knn": False}},
            "mappings": {
                "properties": {
                    "title": {"type": "text"},
                    "body": {"type": "text"},
                    "source": {"type": "keyword"},
                }
            },
        },
    )
    logger.info("created index %s", _INDEX)


def _seed() -> dict[str, Any]:
    _ensure_index()

    docs = sorted(_DOCS_DIR.glob("*.md"))
    if not docs:
        logger.warning("no .md docs found at %s", _DOCS_DIR)
        return {"indexed": 0}

    actions = []
    for p in docs:
        title, body = _parse_md(p)
        actions.append(
            {
                "_op_type": "index",
                "_index": _INDEX,
                # AOSS does not allow user-supplied _id in some plans; let it auto-generate
                "_source": {"title": title, "body": body, "source": p.name},
            }
        )

    success, failed = bulk(_client, actions, refresh=False, raise_on_error=False)
    logger.info("bulk seed complete: success=%s failed=%s", success, failed)
    return {"indexed": success, "failed": len(failed) if isinstance(failed, list) else failed}


def _delete() -> dict[str, Any]:
    if _client.indices.exists(index=_INDEX):
        _client.indices.delete(index=_INDEX)
        return {"deleted": _INDEX}
    return {"deleted": None}


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """CFN custom-resource style event.

    AwsCustomResource invokes with onCreate/onUpdate/onDelete; we drive the
    branch off `RequestType` if present, else default to seed (so direct
    invokes for testing also work).
    """
    logger.info("wiki-seed event: %s", json.dumps(event)[:500])
    request_type = event.get("RequestType", "Create")

    if request_type == "Delete":
        return _delete()
    return _seed()
