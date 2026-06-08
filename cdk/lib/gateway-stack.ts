import { CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
  PhysicalResourceIdReference,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

interface GatewayStackProps extends StackProps {
  readonly wikiSearchFn: lambda.IFunction;
  readonly piiLookupFn: lambda.IFunction;
  /** Cognito OIDC discovery URL — for CUSTOM_JWT authorizer. */
  readonly discoveryUrl: string;
  /** Cognito app client id — JWT audience claim. */
  readonly audience: string;
}

/**
 * AgentCore Gateway is in Public Preview (2026-04). aws-cdk-lib 2.215.0 has
 * no L1 for it yet, so every AgentCore Control Plane call is wired through
 * AwsCustomResource → boto3 `bedrock-agentcore-control`.
 *
 * API shapes follow the documented control-plane reference:
 *   https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/
 *
 * Anything marked PoC-ASSUMED below is a best-effort mapping that should be
 * re-confirmed against the live API once the SDK ships generated types.
 */
const AGENTCORE_SERVICE = 'bedrock-agentcore-control';

export class GatewayStack extends Stack {
  /** Token resolved at deploy time — Gateway ARN. */
  readonly gatewayArn: string;
  /** Token resolved at deploy time — Gateway invocation endpoint URL. */
  readonly gatewayUrl: string;
  /** Token resolved at deploy time — Gateway id. */
  readonly gatewayId: string;
  /** Gateway execution role ARN — needed by PolicyStack to grant policy-engine attach perms. */
  readonly gatewayRoleArn: string;
  /** wiki-search-mcp Gateway target id — RegistryStack pins it into record description. */
  readonly wikiTargetId: string;
  /** pii-lookup-mcp Gateway target id — RegistryStack pins it into record description. */
  readonly piiTargetId: string;

  constructor(scope: Construct, id: string, props: GatewayStackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------
    // 1. Gateway execution role.
    //    Gateway assumes this to invoke each Lambda target.
    // -----------------------------------------------------------------
    const gatewayRole = new iam.Role(this, 'GatewayExecutionRole', {
      roleName: 'acharness-shared-gateway-role',
      description: 'AC-Harness shared Gateway execution role -- invokes MCP tool Lambdas.',
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
        },
      }),
    });
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [props.wikiSearchFn.functionArn, props.piiLookupFn.functionArn],
      }),
    );
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents', 'logs:CreateLogGroup'],
        resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/*`],
      }),
    );
    // Cedar policy evaluation perms — without these, Gateway either denies
    // every tool call (when ENFORCE) or silently skips evaluation (LOG_ONLY)
    // so deny spans never reach CloudWatch. Per
    // https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-permissions.html
    gatewayRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:AuthorizeAction',
          'bedrock-agentcore:PartiallyAuthorizeActions',
          'bedrock-agentcore:GetPolicyEngine',
        ],
        resources: ['*'],
      }),
    );

    // -----------------------------------------------------------------
    // 2. CreateGateway via AwsCustomResource.
    //    PoC-ASSUMED params: name, roleArn, protocolType=MCP,
    //    authorizerType=CUSTOM_JWT, authorizerConfiguration{ customJWT{
    //    discoveryUrl, allowedAudience } }.
    // -----------------------------------------------------------------
    const gatewayCr = new AwsCustomResource(this, 'GatewayResource', {
      onCreate: {
        service: AGENTCORE_SERVICE,
        action: 'createGateway',
        parameters: {
          name: 'acharness-shared-gateway',
          description: 'AC-Harness shared MCP Gateway (CUSTOM_JWT, Cognito).',
          roleArn: gatewayRole.roleArn,
          protocolType: 'MCP',
          authorizerType: 'CUSTOM_JWT',
          authorizerConfiguration: {
            customJWTAuthorizer: {
              discoveryUrl: props.discoveryUrl,
              allowedAudience: [props.audience],
            },
          },
        },
        physicalResourceId: PhysicalResourceId.fromResponse('gatewayId'),
      },
      onUpdate: {
        service: AGENTCORE_SERVICE,
        action: 'updateGateway',
        parameters: {
          gatewayIdentifier: new PhysicalResourceIdReference(),
          name: 'acharness-shared-gateway',
          description: 'AC-Harness shared MCP Gateway (CUSTOM_JWT, Cognito).',
          roleArn: gatewayRole.roleArn,
        },
        physicalResourceId: PhysicalResourceId.fromResponse('gatewayId'),
      },
      onDelete: {
        service: AGENTCORE_SERVICE,
        action: 'deleteGateway',
        parameters: { gatewayIdentifier: new PhysicalResourceIdReference() },
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock-agentcore:CreateGateway',
            'bedrock-agentcore:UpdateGateway',
            'bedrock-agentcore:DeleteGateway',
            'bedrock-agentcore:GetGateway',
            'bedrock-agentcore:ListGateways',
            'bedrock-agentcore:CreateWorkloadIdentity',
            'bedrock-agentcore:DeleteWorkloadIdentity',
            'bedrock-agentcore:GetWorkloadIdentity',
            'bedrock-agentcore:ListWorkloadIdentities',
          ],
          resources: ['*'],
        }),
        new iam.PolicyStatement({
          actions: ['iam:PassRole'],
          resources: [gatewayRole.roleArn],
          conditions: {
            StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' },
          },
        }),
      ]),
      installLatestAwsSdk: true,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    gatewayCr.node.addDependency(gatewayRole);

    this.gatewayArn = gatewayCr.getResponseField('gatewayArn');
    this.gatewayUrl = gatewayCr.getResponseField('gatewayUrl');
    this.gatewayId = gatewayCr.getResponseField('gatewayId');
    this.gatewayRoleArn = gatewayRole.roleArn;

    // -----------------------------------------------------------------
    // 3. Lambda resource policies — let Gateway service invoke each tool
    //    Lambda. Source ARN locked to this Gateway.
    // -----------------------------------------------------------------
    const wikiPerm = new lambda.CfnPermission(this, 'WikiSearchInvokePerm', {
      action: 'lambda:InvokeFunction',
      functionName: props.wikiSearchFn.functionName,
      principal: 'bedrock-agentcore.amazonaws.com',
      sourceArn: this.gatewayArn,
      sourceAccount: this.account,
    });
    const piiPerm = new lambda.CfnPermission(this, 'PiiLookupInvokePerm', {
      action: 'lambda:InvokeFunction',
      functionName: props.piiLookupFn.functionName,
      principal: 'bedrock-agentcore.amazonaws.com',
      sourceArn: this.gatewayArn,
      sourceAccount: this.account,
    });
    wikiPerm.node.addDependency(gatewayCr);
    piiPerm.node.addDependency(gatewayCr);

    // -----------------------------------------------------------------
    // 4. Gateway targets — one per Lambda. Each target exposes the
    //    Lambda as an MCP tool through this Gateway.
    //    PoC-ASSUMED shape: targetConfiguration{ mcp{ lambda{ lambdaArn,
    //    toolSchema{ inlinePayload } } } }.
    // -----------------------------------------------------------------
    const wikiTargetCr = this.makeTargetCr({
      id: 'WikiSearchTarget',
      logicalName: 'wiki-search-mcp',
      description: 'BM25 search over the shared wiki -- read by every dept.',
      lambdaArn: props.wikiSearchFn.functionArn,
      toolSchema: {
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
    });
    wikiTargetCr.node.addDependency(wikiPerm);

    const piiTargetCr = this.makeTargetCr({
      id: 'PiiLookupTarget',
      logicalName: 'pii-lookup-mcp',
      description: 'Look up an employee PII record by username or employee_id (HR-only via Cedar).',
      lambdaArn: props.piiLookupFn.functionArn,
      toolSchema: {
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
    });
    piiTargetCr.node.addDependency(piiPerm);
    // Serialize target creation to avoid IAM eventual-consistency races when both
    // CRs spin up at the same moment with similar inline policies.
    piiTargetCr.node.addDependency(wikiTargetCr);

    this.wikiTargetId = wikiTargetCr.getResponseField('targetId');
    this.piiTargetId = piiTargetCr.getResponseField('targetId');

    // -----------------------------------------------------------------
    // 5. Outputs
    // -----------------------------------------------------------------
    new CfnOutput(this, 'GatewayArn', {
      value: this.gatewayArn,
      description: 'AC-Harness shared Gateway ARN',
      exportName: 'AcharnessGatewayArn',
    });
    new CfnOutput(this, 'GatewayUrl', {
      value: this.gatewayUrl,
      description: 'Shared Gateway invocation URL -- feed into Harness toolConfiguration',
      exportName: 'AcharnessGatewayUrl',
    });
    new CfnOutput(this, 'GatewayId', {
      value: this.gatewayId,
      description: 'AC-Harness shared Gateway id',
      exportName: 'AcharnessGatewayId',
    });
    new CfnOutput(this, 'GatewayRoleArn', {
      value: gatewayRole.roleArn,
      description: 'Gateway execution role ARN',
    });
    new CfnOutput(this, 'WikiSearchTargetId', {
      value: wikiTargetCr.getResponseField('targetId'),
      description: 'wiki-search-mcp target id',
      exportName: 'AcharnessWikiSearchTargetId',
    });
    new CfnOutput(this, 'PiiLookupTargetId', {
      value: piiTargetCr.getResponseField('targetId'),
      description: 'pii-lookup-mcp target id',
      exportName: 'AcharnessPiiLookupTargetId',
    });
  }

  private makeTargetCr(args: {
    id: string;
    logicalName: string;
    description: string;
    lambdaArn: string;
    toolSchema: object;
  }): AwsCustomResource {
    const cr = new AwsCustomResource(this, args.id, {
      onCreate: {
        service: AGENTCORE_SERVICE,
        action: 'createGatewayTarget',
        parameters: {
          gatewayIdentifier: this.gatewayId,
          name: args.logicalName,
          description: args.description,
          targetConfiguration: {
            mcp: {
              lambda: {
                lambdaArn: args.lambdaArn,
                toolSchema: { inlinePayload: [args.toolSchema] },
              },
            },
          },
          credentialProviderConfigurations: [
            { credentialProviderType: 'GATEWAY_IAM_ROLE' },
          ],
        },
        physicalResourceId: PhysicalResourceId.fromResponse('targetId'),
      },
      onDelete: {
        service: AGENTCORE_SERVICE,
        action: 'deleteGatewayTarget',
        parameters: {
          gatewayIdentifier: this.gatewayId,
          targetId: new PhysicalResourceIdReference(),
        },
        ignoreErrorCodesMatching: 'ValidationException|ResourceNotFoundException',
      },
      policy: AwsCustomResourcePolicy.fromStatements([
        new iam.PolicyStatement({
          actions: [
            'bedrock-agentcore:CreateGatewayTarget',
            'bedrock-agentcore:DeleteGatewayTarget',
            'bedrock-agentcore:GetGatewayTarget',
            'bedrock-agentcore:ListGatewayTargets',
          ],
          resources: ['*'],
        }),
      ]),
      installLatestAwsSdk: true,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    return cr;
  }
}

