import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  PhysicalResourceIdReference,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

const DEPTS = ['hr', 'sales', 'eng', 'fin'] as const;
type Dept = (typeof DEPTS)[number];

// 8th session — eng PoC confirmed READY in 7th session, expanding to all 4
// departments. Permissions and dept role trust patterns are already in place.
const POC_DEPTS: readonly Dept[] = DEPTS;

const AGENTCORE_SERVICE = 'bedrock-agentcore-control';

interface HarnessStackProps extends StackProps {
  readonly deptRoles: Record<Dept, iam.IRole>;
  readonly gatewayArn: string;
  readonly gatewayUrl: string;
  readonly discoveryUrl: string;
  readonly audience: string;
  readonly bedrockModelId?: string;
}

/**
 * Phase 7 — Harness per department, Docker-less PoC.
 *
 * boto3 1.43.21 createHarness shape (verified 6th-session introspect):
 *   required = ['harnessName', 'executionRoleArn']
 *   environmentArtifact is OPTIONAL — when omitted, AgentCore should fall
 *   back to a default runtime (no container build needed). This is the PoC
 *   bet that lets us run without Docker. If the service rejects the empty
 *   artifact, we fall back to ECR Public Strands image (decision pending).
 *
 * Naming constraints (verified by 6th-session API rejection):
 *   harnessName regex = `^[A-Za-z][A-Za-z0-9_]{0,39}$`  -- hyphens FORBIDDEN
 *   IdentityStack dept role trust SourceArn pattern matches `acharness_${dept}_*`.
 *
 * Scope: only POC_DEPTS provisioned. Expand to all 4 once 1 dept is healthy
 * (just remove the filter).
 */
export class HarnessStack extends Stack {
  readonly harnessIds: Record<string, string>;
  readonly harnessArns: Record<string, string>;

  constructor(scope: Construct, id: string, props: HarnessStackProps) {
    super(scope, id, props);

    const modelId = props.bedrockModelId ?? 'claude-haiku-4-5-20251001';

    this.harnessIds = {};
    this.harnessArns = {};

    for (const dept of POC_DEPTS) {
      const role = props.deptRoles[dept];
      const harnessName = `acharness_${dept}_harness`;

      // -----------------------------------------------------------------
      // Per-dept inline runtime policy: Gateway invoke, Bedrock InvokeModel,
      // logs. ECR pull dropped (no container in this PoC).
      // -----------------------------------------------------------------
      new iam.Policy(this, `DeptRuntimePolicy-${dept}`, {
        policyName: `acharness-${dept}-runtime-policy`,
        roles: [role],
        statements: [
          new iam.PolicyStatement({
            actions: [
              'bedrock-agentcore:InvokeGateway',
              'bedrock-agentcore:CallTool',
              'bedrock-agentcore:GetGateway',
              'bedrock-agentcore:ListGatewayTargets',
            ],
            resources: [props.gatewayArn],
          }),
          new iam.PolicyStatement({
            actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
            resources: [
              `arn:aws:bedrock:${this.region}::foundation-model/${modelId}`,
              `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/*`,
            ],
          }),
          new iam.PolicyStatement({
            actions: [
              'logs:CreateLogGroup',
              'logs:CreateLogStream',
              'logs:PutLogEvents',
              'logs:DescribeLogStreams',
            ],
            resources: [
              `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`,
            ],
          }),
        ],
      });

      const systemPromptText =
        `You are the AC-Harness assistant for the ${dept.toUpperCase()} department. ` +
        'You have access to MCP tools through a shared corporate Gateway. ' +
        'When a tool returns an authorization error, tell the user clearly that ' +
        'their department lacks access -- do not retry or speculate about the data.';

      // -----------------------------------------------------------------
      // createHarness — environmentArtifact intentionally omitted to test
      // the "default runtime" path. tools[] points at the shared Gateway
      // via type=agentcore_gateway.
      // -----------------------------------------------------------------
      const harnessParams: Record<string, unknown> = {
        harnessName,
        executionRoleArn: role.roleArn,
        environment: {
          agentCoreRuntimeEnvironment: {
            networkConfiguration: { networkMode: 'PUBLIC' },
          },
        },
        environmentVariables: {
          DEPT: dept,
          BEDROCK_MODEL_ID: modelId,
          GATEWAY_URL: props.gatewayUrl,
          LOG_LEVEL: 'INFO',
        },
        authorizerConfiguration: {
          customJWTAuthorizer: {
            discoveryUrl: props.discoveryUrl,
            allowedAudience: [props.audience],
          },
        },
        model: {
          bedrockModelConfig: {
            modelId,
            maxTokens: 4096,
            temperature: 0.2,
          },
        },
        systemPrompt: [{ text: systemPromptText }],
        tools: [
          {
            type: 'agentcore_gateway',
            name: 'shared_gateway',
            config: {
              agentCoreGateway: {
                gatewayArn: props.gatewayArn,
                outboundAuth: { awsIam: {} },
              },
            },
          },
        ],
        truncation: {
          strategy: 'sliding_window',
          config: { slidingWindow: { messagesCount: 20 } },
        },
        maxIterations: 10,
        timeoutSeconds: 120,
      };

      const harnessCr = new AwsCustomResource(this, `Harness-${dept}`, {
        onCreate: {
          service: AGENTCORE_SERVICE,
          action: 'createHarness',
          parameters: harnessParams,
          physicalResourceId: PhysicalResourceId.fromResponse('harness.harnessId'),
        },
        onDelete: {
          service: AGENTCORE_SERVICE,
          action: 'deleteHarness',
          parameters: { harnessId: new PhysicalResourceIdReference() },
          ignoreErrorCodesMatching: 'ValidationException|ResourceNotFoundException',
        },
        policy: AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: [
              'bedrock-agentcore:CreateHarness',
              'bedrock-agentcore:UpdateHarness',
              'bedrock-agentcore:DeleteHarness',
              'bedrock-agentcore:GetHarness',
              'bedrock-agentcore:ListHarnesses',
              // Harness sits ATOP AgentCore Runtime — createHarness fans out
              // to createAgentRuntime in the background, so the CR principal
              // needs runtime perms too. Without these the harness lands
              // CREATE_FAILED with "not authorized to perform
              // bedrock-agentcore:CreateAgentRuntime".
              'bedrock-agentcore:CreateAgentRuntime',
              'bedrock-agentcore:UpdateAgentRuntime',
              'bedrock-agentcore:DeleteAgentRuntime',
              'bedrock-agentcore:GetAgentRuntime',
              'bedrock-agentcore:ListAgentRuntimes',
              'bedrock-agentcore:CreateAgentRuntimeEndpoint',
              'bedrock-agentcore:DeleteAgentRuntimeEndpoint',
              'bedrock-agentcore:GetAgentRuntimeEndpoint',
              'bedrock-agentcore:ListAgentRuntimeEndpoints',
              // Same workload-identity perms Gateway/Registry need for async
              // provisioning.
              'bedrock-agentcore:CreateWorkloadIdentity',
              'bedrock-agentcore:DeleteWorkloadIdentity',
              'bedrock-agentcore:GetWorkloadIdentity',
              'bedrock-agentcore:ListWorkloadIdentities',
            ],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            actions: ['iam:PassRole'],
            resources: [role.roleArn],
            conditions: {
              StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' },
            },
          }),
        ]),
        installLatestAwsSdk: true,
        logRetention: logs.RetentionDays.ONE_WEEK,
      });

      this.harnessIds[dept] = harnessCr.getResponseField('harness.harnessId');
      this.harnessArns[dept] = harnessCr.getResponseField('harness.arn');

      new CfnOutput(this, `HarnessId-${dept}`, {
        value: this.harnessIds[dept],
        description: `${dept.toUpperCase()} harness id`,
        exportName: `AcharnessHarnessId-${dept}`,
      });
      new CfnOutput(this, `HarnessArn-${dept}`, {
        value: this.harnessArns[dept],
        description: `${dept.toUpperCase()} harness ARN`,
        exportName: `AcharnessHarnessArn-${dept}`,
      });
    }
  }
}
