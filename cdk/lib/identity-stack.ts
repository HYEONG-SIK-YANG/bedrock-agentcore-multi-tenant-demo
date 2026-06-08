import * as path from 'path';
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

const DEPTS = ['hr', 'sales', 'eng', 'fin'] as const;
type Dept = (typeof DEPTS)[number];

interface SeedUser {
  username: string;
  email: string;
  dept: Dept;
}

const SEED_USERS: SeedUser[] = [
  { username: 'alice', email: 'alice@sales.acharness.demo', dept: 'sales' },
  { username: 'bob',   email: 'bob@hr.acharness.demo',     dept: 'hr'    },
  { username: 'carol', email: 'carol@eng.acharness.demo',  dept: 'eng'   },
  { username: 'eric',  email: 'eric@fin.acharness.demo',   dept: 'fin'   },
];

// PoC-only fixed temp password — committed intentionally for the demo.
// Anyone forking this repo deploys their own isolated Cognito user pool, so
// a known password only affects the demo users in *their* account.
// DO NOT REUSE THIS PATTERN FOR ANY REAL WORKLOAD. Change before any non-demo use.
const POC_TEMP_PASSWORD = 'AcHarness!Demo2026';

export class IdentityStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly deptRoles: Record<Dept, iam.Role>;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------
    // 1. Pre-Token Generation Lambda (v2 trigger)
    // -----------------------------------------------------------------
    const preTokenFn = new nodejs.NodejsFunction(this, 'PreTokenGenFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      entry: path.join(__dirname, '..', '..', 'lambdas', 'pre-token-gen', 'index.ts'),
      handler: 'handler',
      timeout: Duration.seconds(5),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
      bundling: { minify: true, sourceMap: true, target: 'node20' },
      description: 'AC-Harness: inject dept claim from Cognito group into access+id tokens (V2_0 trigger).',
    });

    // -----------------------------------------------------------------
    // 2. Cognito User Pool
    // -----------------------------------------------------------------
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'acharness-sso-pool',
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
      deletionProtection: false,
      // L2 wires the Lambda permission for us; we override LambdaVersion via
      // escape hatch below to enforce V2_0 (cheat sheet trap #1).
      lambdaTriggers: { preTokenGeneration: preTokenFn },
    });

    // Force V2_0 trigger version — only V2 can mutate access token claims.
    const cfnPool = this.userPool.node.defaultChild as cognito.CfnUserPool;
    cfnPool.addPropertyOverride(
      'LambdaConfig.PreTokenGenerationConfig',
      {
        LambdaArn: preTokenFn.functionArn,
        LambdaVersion: 'V2_0',
      },
    );
    // Drop the legacy v1 attribute the L2 sets so AWS doesn't see a conflict.
    cfnPool.addPropertyDeletionOverride('LambdaConfig.PreTokenGeneration');

    // -----------------------------------------------------------------
    // 3. App client
    // -----------------------------------------------------------------
    this.userPoolClient = this.userPool.addClient('AppClient', {
      userPoolClientName: 'acharness-cli',
      generateSecret: false,
      authFlows: {
        userSrp: true,
        userPassword: true,    // enables `initiate-auth USER_PASSWORD_AUTH` PoC verify
        adminUserPassword: true,
      },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
    });

    // -----------------------------------------------------------------
    // 4. Department groups
    // -----------------------------------------------------------------
    const groups: Record<Dept, cognito.CfnUserPoolGroup> = {} as Record<Dept, cognito.CfnUserPoolGroup>;
    for (const dept of DEPTS) {
      groups[dept] = new cognito.CfnUserPoolGroup(this, `Group-${dept}`, {
        userPoolId: this.userPool.userPoolId,
        groupName: dept,
        description: `AC-Harness ${dept.toUpperCase()} department`,
        precedence: 1,
      });
    }

    // -----------------------------------------------------------------
    // 5. Seed users + group attachments + permanent password
    // -----------------------------------------------------------------
    for (const u of SEED_USERS) {
      const cfnUser = new cognito.CfnUserPoolUser(this, `User-${u.username}`, {
        userPoolId: this.userPool.userPoolId,
        username: u.username,
        userAttributes: [
          { name: 'email', value: u.email },
          { name: 'email_verified', value: 'true' },
        ],
        messageAction: 'SUPPRESS',
        forceAliasCreation: false,
      });

      const attach = new cognito.CfnUserPoolUserToGroupAttachment(this, `Attach-${u.username}`, {
        userPoolId: this.userPool.userPoolId,
        username: u.username,
        groupName: u.dept,
      });
      attach.addDependency(cfnUser);
      attach.addDependency(groups[u.dept]);

      // Promote temp password → permanent so PoC `initiate-auth` works without reset.
      const setPwd = new AwsCustomResource(this, `SetPwd-${u.username}`, {
        onCreate: {
          service: 'CognitoIdentityServiceProvider',
          action: 'adminSetUserPassword',
          parameters: {
            UserPoolId: this.userPool.userPoolId,
            Username: u.username,
            Password: POC_TEMP_PASSWORD,
            Permanent: true,
          },
          physicalResourceId: PhysicalResourceId.of(`SetPwd-${u.username}`),
        },
        policy: AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['cognito-idp:AdminSetUserPassword'],
            resources: [this.userPool.userPoolArn],
          }),
        ]),
        installLatestAwsSdk: false,
        logRetention: logs.RetentionDays.ONE_WEEK,
      });
      setPwd.node.addDependency(cfnUser);
    }

    // -----------------------------------------------------------------
    // 6. Department mock IAM roles (Harness execution role placeholders)
    //
    // Trust bedrock-agentcore.amazonaws.com with aws:SourceArn locked to the
    // dept's harness ARN pattern. Permissions get attached in later phases.
    // -----------------------------------------------------------------
    this.deptRoles = {} as Record<Dept, iam.Role>;
    // Trust pattern: per AWS docs (runtime-permissions.html "AgentCore Runtime
    // trust policy"), SourceArn must be ArnLike with the account-scoped
    // wildcard `arn:aws:bedrock-agentcore:<region>:<account>:*` — Harness
    // creation fans out to harness/runtime/runtime-endpoint/workload-identity
    // resources, all of which assume this role with their own ARN as
    // SourceArn. A harness-only pattern fails the runtime sub-resource.
    // Dept isolation comes from per-dept inline policies (HarnessStack), not
    // the trust pattern.
    const sourceArnAllAgentCore = `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*`;
    for (const dept of DEPTS) {
      this.deptRoles[dept] = new iam.Role(this, `RuntimeRole-${dept}`, {
        roleName: `acharness-${dept}-runtime-role`,
        description: `AC-Harness ${dept.toUpperCase()} runtime/execution role (Phase 1 placeholder).`,
        assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
          conditions: {
            ArnLike: { 'aws:SourceArn': sourceArnAllAgentCore },
            StringEquals: { 'aws:SourceAccount': this.account },
          },
        }),
        // Phases 4/7 will add InvokeGateway / KMS / EFS / S3 inline policies.
      });
    }

    // -----------------------------------------------------------------
    // 7. Outputs
    // -----------------------------------------------------------------
    new CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito user pool id',
      exportName: 'AcharnessUserPoolId',
    });
    new CfnOutput(this, 'UserPoolArn', {
      value: this.userPool.userPoolArn,
      description: 'Cognito user pool ARN',
    });
    new CfnOutput(this, 'AppClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'App client id (use for initiate-auth)',
      exportName: 'AcharnessAppClientId',
    });
    new CfnOutput(this, 'DiscoveryUrl', {
      value: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/openid-configuration`,
      description: 'OIDC discovery URL — feed this to Gateway / Registry CUSTOM_JWT authorizer',
      exportName: 'AcharnessDiscoveryUrl',
    });
    new CfnOutput(this, 'PreTokenLambdaArn', {
      value: preTokenFn.functionArn,
      description: 'Pre-Token Generation Lambda v2 ARN',
    });
    for (const dept of DEPTS) {
      new CfnOutput(this, `RuntimeRoleArn-${dept}`, {
        value: this.deptRoles[dept].roleArn,
        description: `${dept.toUpperCase()} runtime role ARN`,
        exportName: `AcharnessRuntimeRoleArn-${dept}`,
      });
    }
    new CfnOutput(this, 'SeedUsers', {
      value: SEED_USERS.map((u) => `${u.username}(${u.dept})`).join(','),
      description: 'Seed users (username(dept))',
    });
    // PoC password intentionally NOT exported. It is hardcoded in this file
    // (search POC_TEMP_PASSWORD) and documented in README — exporting it would
    // surface it in CloudFormation outputs which leak through StackEvents.
  }
}
