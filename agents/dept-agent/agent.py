"""AC-Harness scenario A — single Strands agent, one shape, four deployments.

Each Harness instance sets DEPT via env. The agent itself is identical across
deployments; routing through the shared Gateway carries a JWT with `dept`
claim, and the AgentCore Policy (Phase 6) gates pii-lookup on dept=="hr".

Tools come from the shared MCP Gateway — no in-proc tool definitions. The
agent discovers tools via `tools/list` and calls them via `tools/call`.

Env:
    DEPT                     — sales / hr / eng / fin
    BEDROCK_MODEL_ID         — defaults to claude-haiku-4-5-20251001
    GATEWAY_URL              — shared Gateway invocation URL
    GATEWAY_AUTH_TOKEN       — JWT minted at Harness invocation time and
                               passed in via the runtime so the MCP client
                               carries it as Bearer.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from strands import Agent
from strands.models.bedrock import BedrockModel
from strands.tools.mcp import MCPClient
from mcp.client.streamable_http import streamablehttp_client

logger = logging.getLogger()
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

DEPT = os.environ["DEPT"]
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "claude-haiku-4-5-20251001")
GATEWAY_URL = os.environ["GATEWAY_URL"]


def _make_mcp_client(bearer: str) -> MCPClient:
    headers = {"Authorization": f"Bearer {bearer}"}
    return MCPClient(lambda: streamablehttp_client(GATEWAY_URL, headers=headers))


_SYSTEM = (
    f"You are the AC-Harness assistant for the {DEPT.upper()} department. "
    "You have access to MCP tools through a shared corporate Gateway. "
    "When a tool returns an authorization error, tell the user clearly that "
    "their department lacks access — do not retry or speculate about the data."
)


def handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    """AgentCore Harness invocation entry.

    Event shape (PoC-ASSUMED):
        {
          "input": "<user message>",
          "auth": { "bearerToken": "<JWT minted by Harness for this caller>" }
        }
    """
    logger.info("dept=%s invoking", DEPT)
    user_input = event.get("input") or event.get("prompt") or ""
    bearer = (event.get("auth") or {}).get("bearerToken") or os.environ.get(
        "GATEWAY_AUTH_TOKEN", ""
    )
    if not bearer:
        return {"output": "Missing bearer token; cannot reach Gateway tools.", "dept": DEPT}

    mcp = _make_mcp_client(bearer)
    with mcp:
        tools = mcp.list_tools_sync()
        agent = Agent(
            model=BedrockModel(model_id=MODEL_ID),
            tools=tools,
            system_prompt=_SYSTEM,
        )
        result = agent(user_input)

    return {"output": str(result), "dept": DEPT}
