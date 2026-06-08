# AC-Harness dept-agent — Strands runtime container for Bedrock AgentCore Harness.
#
# NOTE: Currently UNUSED. HarnessStack provisions each dept Harness with the
# default AgentCore runtime (no container). This Dockerfile + server.py remain
# as a reference for the container-runtime fallback path. To switch:
#   1. docker build --platform linux/arm64 -t acharness-dept-agent .
#   2. push to ECR
#   3. set `environmentArtifact` on createHarness in cdk/lib/harness-stack.ts
#      to the ECR image URI
#
# AgentCore Runtime spec (per docs):
#   - HTTP server on port 8080
#   - POST /invocations  -> agent invocation
#   - GET  /ping         -> health
#   - linux/arm64 (Graviton — required by Runtime)

FROM public.ecr.aws/docker/library/python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY agent.py server.py ./

EXPOSE 8080

CMD ["python", "server.py"]
