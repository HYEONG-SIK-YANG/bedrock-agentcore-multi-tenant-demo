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

interface PolicyStackProps extends StackProps {
  readonly gatewayId: string;
  readonly gatewayArn: string;
  readonly gatewayRoleArn: string;
  /** Target *name* (not id) — used to assemble the AgentCore::Action::"<TargetName>___<tool>" entity. */
  readonly piiTargetName: string;
  readonly piiToolName: string;
}

const AGENTCORE_SERVICE = 'bedrock-agentcore-control';

/**
 * Phase 6 — PolicyEngine + Cedar policies (AgentCore dialect) attached to the
 * shared Gateway in LOG_ONLY mode.
 *
 * Cedar dialect (verified against
 * https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/policy-understanding-cedar.html):
 *   action   = AgentCore::Action::"<TargetName>___<tool_name>"
 *   resource = AgentCore::Gateway::"<gatewayArn>"
 *   claims   = principal.hasTag("dept") && principal.getTag("dept") == "hr"
 *
 * IAM design note: every CR shares ONE explicit Lambda role (`crRole`) granted
 * the full AgentCore action surface upfront. Per-CR policy attach (the default
 * AwsCustomResource path) caused IAM eventual-consistency races on first
 * deploy — CreatePolicy was denied because the role's just-attached policy
 * hadn't propagated by the time the Lambda invoked the API. By pre-creating
 * the role with all perms baked in, we eliminate that race entirely.
 *
 * Initial mode = LOG_ONLY so deploys + early demos generate deny *spans*
 * without breaking traffic. Flip to ENFORCE via:
 *   aws bedrock-agentcore-control update-gateway \
 *     --gateway-identifier <id> \
 *     --policy-engine-configuration arn=<engineArn>,mode=ENFORCE
 */
export class PolicyStack extends Stack {
  readonly policyEngineId: string;
  readonly policyEngineArn: string;
  readonly permitPolicyId: string;
  readonly forbidPolicyId: string;

  constructor(scope: Construct, id: string, props: PolicyStackProps) {
    super(scope, id, props);

    const piiAction = `${props.piiTargetName}___${props.piiToolName}`;

    const permitCedar = [
      'permit(',
      '  principal,',
      `  action == AgentCore::Action::"${piiAction}",`,
      `  resource == AgentCore::Gateway::"${props.gatewayArn}"`,
      ') when {',
      '  principal.hasTag("dept") && principal.getTag("dept") == "hr"',
      '};',
    ].join('\n');

    const forbidCedar = [
      'forbid(',
      '  principal,',
      `  action == AgentCore::Action::"${piiAction}",`,
      `  resource == AgentCore::Gateway::"${props.gatewayArn}"`,
      ') unless {',
      '  principal.hasTag("dept") && principal.getTag("dept") == "hr"',
      '};',
    ].join('\n');

    // -----------------------------------------------------------------
    // Shared CR role -- all AgentCore perms attached in ONE inline policy
    // before any CR runs, so IAM propagation finishes before the first
    // AwsCustomResource invocation.
    // -----------------------------------------------------------------
    const crRole = new iam.Role(this, 'PolicyCrRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'AC-Harness PolicyStack -- shared role for all AgentCore CR Lambdas.',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });
    crRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:CreatePolicyEngine',
          'bedrock-agentcore:UpdatePolicyEngine',
          'bedrock-agentcore:DeletePolicyEngine',
          'bedrock-agentcore:GetPolicyEngine',
          'bedrock-agentcore:GetPolicyEngineSummary',
          'bedrock-agentcore:ListPolicyEngines',
          'bedrock-agentcore:ListPolicyEngineSummaries',
          'bedrock-agentcore:CreatePolicy',
          'bedrock-agentcore:UpdatePolicy',
          'bedrock-agentcore:DeletePolicy',
          'bedrock-agentcore:GetPolicy',
          'bedrock-agentcore:GetPolicySummary',
          'bedrock-agentcore:ListPolicySummaries',
          'bedrock-agentcore:ManageResourceScopedPolicy',
          'bedrock-agentcore:UpdateGateway',
          'bedrock-agentcore:GetGateway',
          'bedrock-agentcore:ListGateways',
          'bedrock-agentcore:ListGatewayTargets',
          'bedrock-agentcore:GetGatewayTarget',
        ],
        resources: ['*'],
      }),
    );
    crRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [props.gatewayRoleArn],
        conditions: {
          StringEquals: { 'iam:PassedToService': 'bedrock-agentcore.amazonaws.com' },
        },
      }),
    );

    // -----------------------------------------------------------------
    // 1. CreatePolicyEngine
    // -----------------------------------------------------------------
    const engineCr = new AwsCustomResource(this, 'GatewayPolicyEngine', {
      onCreate: {
        service: AGENTCORE_SERVICE,
        action: 'createPolicyEngine',
        parameters: {
          name: 'acharness_shared_gateway_engine',
          description: 'AC-Harness PolicyEngine -- Cedar policies for shared Gateway',
        },
        physicalResourceId: PhysicalResourceId.fromResponse('policyEngineId'),
      },
      onDelete: {
        service: AGENTCORE_SERVICE,
        action: 'deletePolicyEngine',
        parameters: { policyEngineId: new PhysicalResourceIdReference() },
        ignoreErrorCodesMatching: 'ValidationException|ResourceNotFoundException',
      },
      role: crRole,
      installLatestAwsSdk: true,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    engineCr.node.addDependency(crRole);
    this.policyEngineId = engineCr.getResponseField('policyEngineId');
    this.policyEngineArn = engineCr.getResponseField('policyEngineArn');

    // -----------------------------------------------------------------
    // 2a. CreatePolicy — permit pii_lookup when dept == hr
    // -----------------------------------------------------------------
    const permitCr = new AwsCustomResource(this, 'GatewayPiiPermitPolicy', {
      onCreate: {
        service: AGENTCORE_SERVICE,
        action: 'createPolicy',
        parameters: {
          policyEngineId: this.policyEngineId,
          name: 'acharness_pii_permit_hr',
          description: 'AC-Harness -- permit pii_lookup only when dept=hr.',
          definition: { cedar: { statement: permitCedar } },
          validationMode: 'IGNORE_ALL_FINDINGS',
        },
        physicalResourceId: PhysicalResourceId.fromResponse('policyId'),
      },
      onDelete: {
        service: AGENTCORE_SERVICE,
        action: 'deletePolicy',
        parameters: {
          policyEngineId: this.policyEngineId,
          policyId: new PhysicalResourceIdReference(),
        },
        ignoreErrorCodesMatching: 'ValidationException|ResourceNotFoundException',
      },
      role: crRole,
      installLatestAwsSdk: true,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    permitCr.node.addDependency(engineCr);
    this.permitPolicyId = permitCr.getResponseField('policyId');

    // -----------------------------------------------------------------
    // 2b. CreatePolicy — forbid pii_lookup unless dept == hr
    // -----------------------------------------------------------------
    const forbidCr = new AwsCustomResource(this, 'GatewayPiiForbidPolicy', {
      onCreate: {
        service: AGENTCORE_SERVICE,
        action: 'createPolicy',
        parameters: {
          policyEngineId: this.policyEngineId,
          name: 'acharness_pii_forbid_non_hr',
          description: 'AC-Harness -- forbid pii_lookup for non-hr depts.',
          definition: { cedar: { statement: forbidCedar } },
          validationMode: 'IGNORE_ALL_FINDINGS',
        },
        physicalResourceId: PhysicalResourceId.fromResponse('policyId'),
      },
      onDelete: {
        service: AGENTCORE_SERVICE,
        action: 'deletePolicy',
        parameters: {
          policyEngineId: this.policyEngineId,
          policyId: new PhysicalResourceIdReference(),
        },
        ignoreErrorCodesMatching: 'ValidationException|ResourceNotFoundException',
      },
      role: crRole,
      installLatestAwsSdk: true,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    forbidCr.node.addDependency(permitCr);
    this.forbidPolicyId = forbidCr.getResponseField('policyId');

    // -----------------------------------------------------------------
    // 3. UpdateGateway -- attach the policy engine in LOG_ONLY mode.
    // -----------------------------------------------------------------
    const attachCr = new AwsCustomResource(this, 'AttachEngineToGateway', {
      onCreate: {
        service: AGENTCORE_SERVICE,
        action: 'updateGateway',
        parameters: {
          gatewayIdentifier: props.gatewayId,
          policyEngineConfiguration: {
            arn: this.policyEngineArn,
            mode: 'LOG_ONLY',
          },
        },
        physicalResourceId: PhysicalResourceId.of(`attach-${props.gatewayId}`),
        ignoreErrorCodesMatching: 'ValidationException',
      },
      onUpdate: {
        service: AGENTCORE_SERVICE,
        action: 'updateGateway',
        parameters: {
          gatewayIdentifier: props.gatewayId,
          policyEngineConfiguration: {
            arn: this.policyEngineArn,
            mode: 'LOG_ONLY',
          },
        },
        physicalResourceId: PhysicalResourceId.of(`attach-${props.gatewayId}`),
        ignoreErrorCodesMatching: 'ValidationException',
      },
      role: crRole,
      installLatestAwsSdk: true,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    attachCr.node.addDependency(forbidCr);

    // -----------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------
    new CfnOutput(this, 'PolicyEngineId', {
      value: this.policyEngineId,
      description: 'AC-Harness PolicyEngine id',
      exportName: 'AcharnessPolicyEngineId',
    });
    new CfnOutput(this, 'PolicyEngineArn', {
      value: this.policyEngineArn,
      description: 'AC-Harness PolicyEngine ARN -- used by Gateway attach',
      exportName: 'AcharnessPolicyEngineArn',
    });
    new CfnOutput(this, 'PermitPolicyId', {
      value: this.permitPolicyId,
      description: 'Permit pii_lookup-when-dept=hr policy id',
    });
    new CfnOutput(this, 'ForbidPolicyId', {
      value: this.forbidPolicyId,
      description: 'Forbid pii_lookup-unless-dept=hr policy id',
    });
    new CfnOutput(this, 'PolicyMode', {
      value: 'LOG_ONLY',
      description:
        'Current attach mode -- toggle to ENFORCE via update-gateway --policy-engine-configuration arn=<arn>,mode=ENFORCE',
    });
    new CfnOutput(this, 'PiiAction', {
      value: piiAction,
      description: 'Cedar action entity (TargetName___ToolName)',
    });
  }
}
