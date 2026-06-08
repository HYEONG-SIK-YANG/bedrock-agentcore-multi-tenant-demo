#!/usr/bin/env node
// AC-Harness CDK app entry point.
//
// Region is locked to us-east-1 (SESSION_HANDOFF.md §결정된 사실): it is the
// only region in Harness ∩ Registry ∩ "newest Bedrock models".
//
// Account: pulled from the active CDK_DEFAULT_ACCOUNT (the operator's profile).
// Stacks intentionally pin both to keep IAM SourceArn conditions valid.

import * as cdk from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack';
import { GatewayStack } from '../lib/gateway-stack';
import { HarnessStack } from '../lib/harness-stack';
import { IdentityStack } from '../lib/identity-stack';
import { PolicyStack } from '../lib/policy-stack';
import { RegistryStack } from '../lib/registry-stack';
import { ToolsStack } from '../lib/tools-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-east-1',
};

const tags = {
  Project: 'AC-Harness',
  Scenario: 'A',
  Owner: 'sa-demo',
  ManagedBy: 'cdk',
};

const identity = new IdentityStack(app, 'AcharnessIdentityStack', {
  env,
  description: 'AC-Harness Phase 1 — Cognito + Pre-Token Lambda v2 + dept IAM roles',
  tags,
});

const data = new DataStack(app, 'AcharnessDataStack', {
  env,
  description: 'AC-Harness Phase 2 — OpenSearch Serverless wiki + DynamoDB employees-pii',
  tags,
  deptRoles: identity.deptRoles,
});

const tools = new ToolsStack(app, 'AcharnessToolsStack', {
  env,
  description: 'AC-Harness Phase 3 — wiki-search + pii-lookup MCP Lambdas + AOSS seed CR',
  tags,
  piiTable: data.piiTable,
  wikiCollection: data.wikiCollection,
  wikiCollectionName: data.wikiCollectionName,
});

const discoveryUrl = `https://cognito-idp.${env.region}.amazonaws.com/${identity.userPool.userPoolId}/.well-known/openid-configuration`;

const gateway = new GatewayStack(app, 'AcharnessGatewayStack', {
  env,
  description: 'AC-Harness Phase 4 — shared MCP Gateway (CUSTOM_JWT) + 2 Lambda targets',
  tags,
  wikiSearchFn: tools.wikiSearchFn,
  piiLookupFn: tools.piiLookupFn,
  discoveryUrl,
  audience: identity.userPoolClient.userPoolClientId,
});

// Phase 5 (RegistryStack) — restored in 7th session.
// SDK has no `targetType=GATEWAY_TARGET` / `targetReference` fields, so we
// embed `{gatewayId, targetId}` inside descriptors.mcp.server.inlineContent
// JSON to preserve the demo's Registry-record ↔ Gateway-target join.
const registry = new RegistryStack(app, 'AcharnessRegistryStack', {
  env,
  description:
    'AC-Harness Phase 5 — Agent Registry org + 2 MCP records (shared/wiki, hr/pii)',
  tags,
  gatewayId: gateway.gatewayId,
  wikiTargetId: gateway.wikiTargetId,
  piiTargetId: gateway.piiTargetId,
  discoveryUrl,
  audience: identity.userPoolClient.userPoolClientId,
});
registry.addDependency(gateway);

const policy = new PolicyStack(app, 'AcharnessPolicyStack', {
  env,
  description: 'AC-Harness Phase 6 — PolicyEngine + Cedar policy (LOG_ONLY), gating pii-lookup on dept=hr',
  tags,
  gatewayId: gateway.gatewayId,
  gatewayArn: gateway.gatewayArn,
  gatewayRoleArn: gateway.gatewayRoleArn,
  // Cedar action entity = "<TargetName>___<ToolName>". TargetName is the
  // gateway-target's `name` (not its id) per AgentCore docs.
  piiTargetName: 'pii-lookup-mcp',
  piiToolName: 'pii_lookup',
});
policy.addDependency(gateway);

const harness = new HarnessStack(app, 'AcharnessHarnessStack', {
  env,
  description: 'AC-Harness Phase 7 — 4 dept Harness instances + Strands container agent',
  tags,
  deptRoles: identity.deptRoles,
  gatewayArn: gateway.gatewayArn,
  gatewayUrl: gateway.gatewayUrl,
  discoveryUrl,
  audience: identity.userPoolClient.userPoolClientId,
});
harness.addDependency(gateway);
harness.addDependency(policy);
