"""AC-Harness Registry CR — Provider-style handler.

Provider invokes `on_event` for Create/Update/Delete and (when the handler
returns no payload `Status: SUCCESS`) keeps invoking `is_complete` on a
schedule until it returns `IsComplete: true`.

Two ResourceType values:

  Custom::AcharnessRegistry        -- top-level registry; waits for READY.
  Custom::AcharnessRegistryRecord  -- record under a registry; waits for DRAFT
                                     (or any non-CREATING terminal state).

For deletes we wait for ResourceNotFoundException so CFN doesn't try to
recreate against a half-removed registry.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional

import boto3
from botocore.exceptions import ClientError

LOG = logging.getLogger(__name__)
LOG.setLevel(os.environ.get("LOG_LEVEL", "INFO"))

REGION = os.environ["AWS_REGION"]
agentcore = boto3.client("bedrock-agentcore-control", region_name=REGION)


# ----------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------

def _registry_terminal(status: str) -> bool:
    return status in ("READY", "CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED")


def _record_terminal(status: str) -> bool:
    # CREATING / UPDATING are the only transient states the create flow can
    # be in. APPROVED / REJECTED / DEPRECATED are post-approval, but the
    # initial create lands in DRAFT.
    return status not in ("CREATING", "UPDATING")


# ----------------------------------------------------------------------
# Registry handlers
# ----------------------------------------------------------------------

def _coerce_bool(v: Any) -> bool:
    """CFN serializes bools as 'true'/'false' strings — coerce back."""
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() == "true"
    return bool(v)


def _registry_create(props: Dict[str, Any]) -> Dict[str, Any]:
    payload: Dict[str, Any] = {"name": props["name"]}
    if props.get("description"):
        payload["description"] = props["description"]
    if props.get("authorizerType"):
        payload["authorizerType"] = props["authorizerType"]
    if props.get("authorizerConfiguration"):
        payload["authorizerConfiguration"] = props["authorizerConfiguration"]
    if "approvalConfiguration" in props:
        ac = props["approvalConfiguration"]
        if isinstance(ac, str):
            ac = json.loads(ac)
        if "autoApproval" in ac:
            ac["autoApproval"] = _coerce_bool(ac["autoApproval"])
        payload["approvalConfiguration"] = ac
    LOG.info("createRegistry %s", json.dumps(payload, default=str))
    resp = agentcore.create_registry(**payload)
    arn = resp["registryArn"]
    return {
        "PhysicalResourceId": arn,
        "Data": {"RegistryArn": arn},
    }


def _registry_delete(physical_id: str) -> Dict[str, Any]:
    if not physical_id or physical_id.startswith("invalid-"):
        return {"PhysicalResourceId": physical_id}
    # Records must be deleted first; we rely on Provider/CFN dependency order
    # so by the time the registry CR runs delete, the records are gone.
    try:
        agentcore.delete_registry(registryId=physical_id)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("ResourceNotFoundException", "ValidationException"):
            LOG.info("registry already gone: %s", code)
        else:
            raise
    return {"PhysicalResourceId": physical_id}


def _registry_complete(event: Dict[str, Any]) -> Dict[str, Any]:
    rid = event.get("PhysicalResourceId")
    op = event.get("RequestType")
    if not rid:
        return {"IsComplete": True}
    try:
        g = agentcore.get_registry(registryId=rid)
        status = g.get("status", "UNKNOWN")
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code == "ResourceNotFoundException":
            # Delete success — registry is gone.
            return {"IsComplete": True} if op == "Delete" else {"IsComplete": False}
        raise
    if op == "Delete":
        return {"IsComplete": status == "DELETE_FAILED"}
    if _registry_terminal(status):
        if status != "READY":
            raise RuntimeError(
                f"Registry {rid} reached terminal status {status}: {g.get('statusReason')!r}"
            )
        return {"IsComplete": True, "Data": {"RegistryArn": rid}}
    LOG.info("registry %s still %s", rid, status)
    return {"IsComplete": False}


# ----------------------------------------------------------------------
# Record handlers
# ----------------------------------------------------------------------

def _record_create(props: Dict[str, Any]) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "registryId": props["registryId"],
        "name": props["name"],
        "descriptorType": props["descriptorType"],
    }
    if props.get("description"):
        payload["description"] = props["description"]
    if props.get("recordVersion"):
        payload["recordVersion"] = props["recordVersion"]
    # CFN serializes nested objects as strings when passed via Provider. The
    # Provider construct already JSON-decodes top-level structures for us, so
    # we accept either dict OR string.
    desc = props.get("descriptors")
    if isinstance(desc, str):
        desc = json.loads(desc)
    if desc:
        payload["descriptors"] = desc
    LOG.info("createRegistryRecord %s/%s", props["registryId"], props["name"])
    resp = agentcore.create_registry_record(**payload)
    arn = resp["recordArn"]
    return {
        "PhysicalResourceId": arn,
        "Data": {"RecordArn": arn, "Status": resp.get("status", "UNKNOWN")},
    }


def _record_delete(props: Dict[str, Any], physical_id: str) -> Dict[str, Any]:
    if not physical_id or physical_id.startswith("invalid-"):
        return {"PhysicalResourceId": physical_id}
    # PhysicalResourceId is the record ARN; Identifier shape accepts ARN.
    rid = props["registryId"]
    try:
        agentcore.delete_registry_record(registryId=rid, recordId=physical_id)
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code in ("ResourceNotFoundException", "ValidationException"):
            LOG.info("record already gone: %s", code)
        else:
            raise
    return {"PhysicalResourceId": physical_id}


def _record_complete(event: Dict[str, Any]) -> Dict[str, Any]:
    rid = event.get("PhysicalResourceId")
    op = event.get("RequestType")
    props = event.get("ResourceProperties", {}) or {}
    if not rid:
        return {"IsComplete": True}
    registry_id = props.get("registryId")
    if not registry_id:
        return {"IsComplete": True}
    try:
        g = agentcore.get_registry_record(registryId=registry_id, recordId=rid)
        status = g.get("status", "UNKNOWN")
    except ClientError as e:
        code = e.response.get("Error", {}).get("Code", "")
        if code == "ResourceNotFoundException":
            return {"IsComplete": True} if op == "Delete" else {"IsComplete": False}
        raise
    if op == "Delete":
        return {"IsComplete": False}
    if _record_terminal(status):
        if status in ("CREATE_FAILED", "UPDATE_FAILED", "REJECTED"):
            raise RuntimeError(f"Record {rid} terminal status {status}")
        return {"IsComplete": True, "Data": {"RecordArn": rid, "Status": status}}
    LOG.info("record %s still %s", rid, status)
    return {"IsComplete": False}


# ----------------------------------------------------------------------
# Provider entrypoints
# ----------------------------------------------------------------------

def on_event(event: Dict[str, Any], _context: Any) -> Dict[str, Any]:
    LOG.info("on_event: %s", json.dumps({k: v for k, v in event.items() if k != "ResourceProperties"}))
    request = event["RequestType"]  # Create | Update | Delete
    rtype = event.get("ResourceType", "")
    props = event.get("ResourceProperties", {}) or {}
    physical = event.get("PhysicalResourceId", "")

    if rtype.endswith("AcharnessRegistry"):
        if request == "Create":
            return _registry_create(props)
        if request == "Update":
            # Replace strategy: update via UpdateRegistry not implemented in PoC.
            return _registry_create(props)
        if request == "Delete":
            return _registry_delete(physical)
    elif rtype.endswith("AcharnessRegistryRecord"):
        if request == "Create":
            return _record_create(props)
        if request == "Update":
            return _record_create(props)
        if request == "Delete":
            return _record_delete(props, physical)
    raise RuntimeError(f"unknown ResourceType={rtype} request={request}")


def is_complete(event: Dict[str, Any], _context: Any) -> Dict[str, Any]:
    rtype = event.get("ResourceType", "")
    if rtype.endswith("AcharnessRegistry"):
        return _registry_complete(event)
    if rtype.endswith("AcharnessRegistryRecord"):
        return _record_complete(event)
    return {"IsComplete": True}
