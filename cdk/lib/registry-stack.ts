import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  CfnOutput,
  CustomResource,
  Duration,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

interface RegistryStackProps extends StackProps {
  readonly gatewayId: string;
  readonly wikiTargetId: string;
  readonly piiTargetId: string;
  readonly discoveryUrl: string;
  readonly audience: string;
}

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const LAMBDA_DIR = path.join(PROJECT_ROOT, 'lambdas', 'registry-cr');

/**
 * Phase 5 — AWS Agent Registry slice for AC-Harness.
 *
 * boto3 1.43.21 SDK shape (verified by introspect, 7th session):
 *   CreateRegistry        required=['name']
 *     approvalConfiguration = { autoApproval: bool }   // ONLY field
 *     authorizerType        = 'CUSTOM_JWT' | 'AWS_IAM'
 *     authorizerConfiguration.customJWTAuthorizer.{discoveryUrl, allowedAudience}
 *   CreateRegistryRecord  required=['registryId','name','descriptorType']
 *     descriptors.mcp.server.{schemaVersion, inlineContent}
 *     descriptors.mcp.tools.{protocolVersion, inlineContent}
 *
 * Verified-good values (SDK probe + console docs, 7th session):
 *   server.schemaVersion        = '2025-12-11' (current MCP server.json)
 *   tools.protocolVersion       = '2024-11-05' (MCP wire protocol)
 *   server.inlineContent JSON   = MCP server.json schema (name, description,
 *                                 version REQUIRED) — extra keys are accepted.
 *
 * Identifier shapes accept full ARN OR id-only (regex `(arn...)?[a-zA-Z0-9]{12,16}`).
 *
 * SDK gap: there is NO `targetType=GATEWAY_TARGET` / `targetReference{gatewayId,
 * targetId}` field. RegistryRecord and Gateway target are decoupled in the data
 * model. To preserve the demo narrative, we embed `{gatewayId, gatewayTargetId}`
 * inside the descriptors.mcp.server.inlineContent JSON.
 *
 * IMPORTANT: createRegistry returns 200 immediately but the registry is
 * provisioned asynchronously (CREATING -> READY in ~60s). createRegistryRecord
 * REJECTS while the registry is still CREATING with `Registry is not in READY
 * state`. AwsCustomResource has no waiter; we use Provider framework with an
 * `is_complete` poller in [lambdas/registry-cr](../lambdas/registry-cr/index.py).
 */
export class RegistryStack extends Stack {
  readonly registryArn: string;

  constructor(scope: Construct, id: string, props: RegistryStackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------
    // 0. Provider Lambda — single Lambda services both registry and record
    //    CRs (Provider dispatches by ResourceType).
    // -----------------------------------------------------------------
    const handlerFn = new lambda.Function(this, 'RegistryCrHandler', {
      functionName: 'acharness-registry-cr',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.on_event',
      code: registryCrAsset(),
      timeout: Duration.seconds(60),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
      description:
        'AC-Harness RegistryStack — CR on_event/is_complete handler (boto3 1.43.21).',
    });
    handlerFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:CreateRegistry',
          'bedrock-agentcore:UpdateRegistry',
          'bedrock-agentcore:DeleteRegistry',
          'bedrock-agentcore:GetRegistry',
          'bedrock-agentcore:ListRegistries',
          'bedrock-agentcore:CreateRegistryRecord',
          'bedrock-agentcore:UpdateRegistryRecord',
          'bedrock-agentcore:DeleteRegistryRecord',
          'bedrock-agentcore:GetRegistryRecord',
          'bedrock-agentcore:ListRegistryRecords',
          // Registry async provisioning creates a workload identity behind the
          // scenes — same pattern Gateway uses. Without these the CREATING
          // status flips to CREATE_FAILED with "Unable to create workload
          // identity because access was denied".
          'bedrock-agentcore:CreateWorkloadIdentity',
          'bedrock-agentcore:DeleteWorkloadIdentity',
          'bedrock-agentcore:GetWorkloadIdentity',
          'bedrock-agentcore:ListWorkloadIdentities',
        ],
        resources: ['*'],
      }),
    );

    const provider = new Provider(this, 'RegistryProvider', {
      onEventHandler: handlerFn,
      isCompleteHandler: new lambda.Function(this, 'RegistryCrIsCompleteHandler', {
        functionName: 'acharness-registry-cr-iscomplete',
        runtime: lambda.Runtime.PYTHON_3_12,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.is_complete',
        code: registryCrAsset(),
        timeout: Duration.seconds(30),
        memorySize: 256,
        logRetention: logs.RetentionDays.ONE_WEEK,
        description:
          'AC-Harness RegistryStack — Provider is_complete poller (boto3 1.43.21).',
        initialPolicy: [
          new iam.PolicyStatement({
            actions: [
              'bedrock-agentcore:GetRegistry',
              'bedrock-agentcore:GetRegistryRecord',
            ],
            resources: ['*'],
          }),
        ],
      }),
      // Registry create takes ~60s; record create takes ~5s. Poll once every
      // 15s up to 5 minutes — covers both with margin.
      queryInterval: Duration.seconds(15),
      totalTimeout: Duration.minutes(5),
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // -----------------------------------------------------------------
    // 1. Registry — `acharness-org`. autoApproval=false makes new records
    //    land in PENDING. CUSTOM_JWT mirrors the Gateway authorizer.
    // -----------------------------------------------------------------
    const registry = new CustomResource(this, 'OrgRegistry', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::AcharnessRegistry',
      properties: {
        name: 'acharness-org',
        description:
          'AC-Harness organization registry — dept-namespaced MCP catalog.',
        authorizerType: 'CUSTOM_JWT',
        authorizerConfiguration: {
          customJWTAuthorizer: {
            discoveryUrl: props.discoveryUrl,
            allowedAudience: [props.audience],
          },
        },
        approvalConfiguration: { autoApproval: false },
      },
    });
    this.registryArn = registry.getAttString('RegistryArn');

    // -----------------------------------------------------------------
    // 2. Shared MCP record — wiki-search.
    //    inlineContent must conform to the official MCP server.json schema
    //    (name/description/version REQUIRED). Extra keys (gatewayId /
    //    gatewayTargetId / visibility) are accepted, verified by SDK probe —
    //    we use them to keep the Gateway target join the SDK does not model.
    // -----------------------------------------------------------------
    const wikiInline = JSON.stringify({
      name: 'io.acharness/wiki-search-mcp',
      description: 'Shared corporate wiki search — every department.',
      version: '1.0.0',
      gatewayId: props.gatewayId,
      gatewayTargetId: props.wikiTargetId,
      visibility: 'shared',
    });
    const wikiTools = JSON.stringify({
      tools: [
        {
          name: 'wiki_search',
          description: 'Search the corporate wiki (BM25). Returns top hits.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Free-text query.' },
              size: { type: 'integer', description: 'Max hits (default 5).' },
            },
            required: ['query'],
          },
        },
      ],
    });

    const sharedRecord = new CustomResource(this, 'SharedWikiRecord', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::AcharnessRegistryRecord',
      properties: {
        registryId: this.registryArn,
        name: 'wiki-search-mcp',
        description:
          'org/shared/wiki-search-mcp — every dept (gatewayId=' +
          props.gatewayId +
          ',targetId=' +
          props.wikiTargetId +
          '). Submit + approve via console for the demo.',
        descriptorType: 'MCP',
        recordVersion: '1.0',
        descriptors: {
          mcp: {
            server: { schemaVersion: '2025-12-11', inlineContent: wikiInline },
            tools: { protocolVersion: '2024-11-05', inlineContent: wikiTools },
          },
        },
      },
    });
    sharedRecord.node.addDependency(registry);

    // -----------------------------------------------------------------
    // 3. HR-only MCP record — pii-lookup.
    // -----------------------------------------------------------------
    const piiInline = JSON.stringify({
      name: 'io.acharness/pii-lookup-mcp',
      description: 'Employee PII lookup — HR-only (Cedar-gated at Gateway).',
      version: '1.0.0',
      gatewayId: props.gatewayId,
      gatewayTargetId: props.piiTargetId,
      visibility: 'restricted',
      gating: { policyEngine: 'acharness_shared_gateway_engine', principal: 'dept=hr' },
    });
    const piiTools = JSON.stringify({
      tools: [
        {
          name: 'pii_lookup',
          description: 'Return the employee record for a given username or employee_id.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'username or employee_id (E-####).' },
            },
            required: ['query'],
          },
        },
      ],
    });

    const hrRecord = new CustomResource(this, 'HrPiiRecord', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::AcharnessRegistryRecord',
      properties: {
        registryId: this.registryArn,
        name: 'pii-lookup-mcp',
        description:
          'org/hr/pii-lookup-mcp — manual approval (gatewayId=' +
          props.gatewayId +
          ',targetId=' +
          props.piiTargetId +
          ').',
        descriptorType: 'MCP',
        recordVersion: '1.0',
        descriptors: {
          mcp: {
            server: { schemaVersion: '2025-12-11', inlineContent: piiInline },
            tools: { protocolVersion: '2024-11-05', inlineContent: piiTools },
          },
        },
      },
    });
    hrRecord.node.addDependency(registry);
    hrRecord.node.addDependency(sharedRecord);

    // -----------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------
    new CfnOutput(this, 'RegistryArn', {
      value: this.registryArn,
      description: 'AC-Harness organization registry ARN',
      exportName: 'AcharnessRegistryArn',
    });
    new CfnOutput(this, 'SharedWikiRecordArn', {
      value: sharedRecord.getAttString('RecordArn'),
      description:
        'org/shared/wiki-search-mcp record ARN — submit for approval in console (manual).',
    });
    new CfnOutput(this, 'HrPiiRecordArn', {
      value: hrRecord.getAttString('RecordArn'),
      description:
        'org/hr/pii-lookup-mcp record ARN — approve in console for the demo.',
    });
  }
}

/**
 * Bundle the registry-cr Lambda. boto3 ≥ 1.43.21 is required (Lambda runtime
 * ships ≤ 1.40 which lacks bedrock-agentcore-control). pip install via local
 * Python first; fall back to docker bundling if local pip is missing.
 */
function registryCrAsset(): lambda.AssetCode {
  const pyExe = pickPythonExecutable();
  return lambda.Code.fromAsset(LAMBDA_DIR, {
    bundling: {
      image: lambda.Runtime.PYTHON_3_12.bundlingImage,
      command: [
        'bash',
        '-c',
        [
          'pip install -r requirements.txt --target /asset-output',
          'cp -r . /asset-output',
        ].join(' && '),
      ],
      local: pyExe
        ? {
            tryBundle(outputDir: string): boolean {
              try {
                execSync(
                  `${pyExe} -m pip install -r requirements.txt --target ${outputDir}`,
                  { cwd: LAMBDA_DIR, stdio: 'inherit' },
                );
                for (const f of fs.readdirSync(LAMBDA_DIR)) {
                  const from = path.join(LAMBDA_DIR, f);
                  const to = path.join(outputDir, f);
                  const stat = fs.statSync(from);
                  if (stat.isDirectory()) {
                    fs.cpSync(from, to, { recursive: true });
                  } else {
                    fs.copyFileSync(from, to);
                  }
                }
                return true;
              } catch (err) {
                process.stderr.write(
                  `[acharness] local python bundling failed (${(err as Error).message}); will try docker.\n`,
                );
                return false;
              }
            },
          }
        : undefined,
    },
  });
}

function pickPythonExecutable(): string | null {
  for (const candidate of ['python3', 'python']) {
    try {
      const out = execSync(`${candidate} --version`, { stdio: 'pipe' }).toString();
      if (/Python 3\./.test(out)) {
        return candidate;
      }
    } catch {
      /* keep trying */
    }
  }
  return null;
}
