"""HTTP shim for AgentCore Runtime contract.

The Runtime expects:
    POST /invocations   -- body is the user payload, returns the agent output
    GET  /ping          -- 200 OK while the container is healthy

We delegate the actual work to ``agent.handler`` (the Strands agent entry).

NOTE: Currently UNUSED. HarnessStack provisions each dept Harness with the
default AgentCore runtime (no container) — see cdk/lib/harness-stack.ts.
This file + Dockerfile remain as a reference for the container-runtime
fallback: build with the Dockerfile, push to ECR, and set the Harness
`environmentArtifact` to the image URI.
"""

from __future__ import annotations

import json
import logging
import os
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import agent as agent_module

logger = logging.getLogger("acharness.runtime")
logger.setLevel(os.environ.get("LOG_LEVEL", "INFO"))


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: D401, A003
        logger.info(fmt, *args)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/ping":
            self._respond(200, {"status": "ok"})
        else:
            self._respond(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/invocations":
            self._respond(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except json.JSONDecodeError as exc:
            self._respond(400, {"error": f"invalid json: {exc}"})
            return

        bearer = self._extract_bearer(payload)
        if bearer:
            payload.setdefault("auth", {})["bearerToken"] = bearer
        try:
            result = agent_module.handler(payload, None)
        except Exception:  # noqa: BLE001
            logger.error("agent invocation failed: %s", traceback.format_exc())
            self._respond(500, {"error": "agent invocation failed"})
            return
        self._respond(200, result)

    def _extract_bearer(self, payload: dict) -> str | None:
        # Prefer payload-supplied auth; fall back to incoming Authorization header.
        token = ((payload or {}).get("auth") or {}).get("bearerToken")
        if token:
            return token
        header = self.headers.get("Authorization") or ""
        if header.lower().startswith("bearer "):
            return header[7:].strip()
        return None

    def _respond(self, status: int, body: dict) -> None:
        encoded = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    server = ThreadingHTTPServer(("0.0.0.0", port), _Handler)
    logger.info("AC-Harness dept=%s listening on :%d", os.environ.get("DEPT", "?"), port)
    server.serve_forever()


if __name__ == "__main__":
    main()
