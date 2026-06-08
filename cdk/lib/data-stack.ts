import * as fs from 'fs';
import * as path from 'path';
import {
  CfnOutput,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as aoss from 'aws-cdk-lib/aws-opensearchserverless';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

const DEPTS = ['hr', 'sales', 'eng', 'fin'] as const;
type Dept = (typeof DEPTS)[number];

const COLLECTION_NAME = 'wiki-shared';
const PII_TABLE_NAME = 'employees-pii';

interface DataStackProps extends StackProps {
  // Cross-stack handoff from IdentityStack — these roles get scoped data
  // permissions here (HR-only PII read; all-dept AOSS search in Phase 3).
  readonly deptRoles: Record<Dept, iam.IRole>;
}

export class DataStack extends Stack {
  readonly piiTable: ddb.Table;
  readonly wikiCollection: aoss.CfnCollection;
  // Convenience: name only (endpoint/arn are CFN tokens until deploy).
  readonly wikiCollectionName: string = COLLECTION_NAME;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);

    // -----------------------------------------------------------------
    // 1. AOSS encryption policy — must exist BEFORE the collection.
    //    AWS-owned key for PoC; Phase C swaps to CMK.
    // -----------------------------------------------------------------
    const encPolicy = new aoss.CfnSecurityPolicy(this, 'WikiEncPolicy', {
      name: `${COLLECTION_NAME}-enc`,
      type: 'encryption',
      description: 'AC-Harness wiki collection encryption (AWS-owned KMS).',
      policy: JSON.stringify({
        Rules: [
          {
            ResourceType: 'collection',
            Resource: [`collection/${COLLECTION_NAME}`],
          },
        ],
        AWSOwnedKey: true,
      }),
    });

    // -----------------------------------------------------------------
    // 2. AOSS network policy — public for PoC.
    //    Production setup uses the AOSS VPC endpoint instead.
    // -----------------------------------------------------------------
    const netPolicy = new aoss.CfnSecurityPolicy(this, 'WikiNetPolicy', {
      name: `${COLLECTION_NAME}-net`,
      type: 'network',
      description: 'AC-Harness wiki collection network (public; PoC only).',
      policy: JSON.stringify([
        {
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${COLLECTION_NAME}`],
            },
            {
              ResourceType: 'dashboard',
              Resource: [`collection/${COLLECTION_NAME}`],
            },
          ],
          AllowFromPublic: true,
        },
      ]),
    });

    // -----------------------------------------------------------------
    // 3. AOSS collection — type SEARCH (BM25), no vectors.
    // -----------------------------------------------------------------
    this.wikiCollection = new aoss.CfnCollection(this, 'WikiCollection', {
      name: COLLECTION_NAME,
      type: 'SEARCH',
      description: 'AC-Harness shared wiki — BM25 search, no vectors.',
    });
    this.wikiCollection.addDependency(encPolicy);
    this.wikiCollection.addDependency(netPolicy);

    // -----------------------------------------------------------------
    // 4. AOSS data access policy.
    //    Granted principals:
    //      - All four dept runtime roles (wiki-search-fn / pii-lookup-fn
    //        invocations transit dept→Gateway→Lambda; same-account SigV4).
    //      - Account root — required so wiki-seed-fn (created in
    //        ToolsStack, which depends on this stack and so cannot be
    //        forward-referenced) can index documents during deploy. AOSS
    //        requires *both* IAM perms AND a data-access-policy principal
    //        match; granting via root keeps the policy stable while
    //        ToolsStack hands wiki-seed-fn the IAM perms separately.
    //    Phase 6 Cedar Policy enforces dept routing on the *Gateway*
    //    tool-call path, not the AOSS data plane. The account-root
    //    grant is PoC-acceptable because cross-account access is blocked
    //    by IAM and SigV4 still applies.
    // -----------------------------------------------------------------
    const deptRoleArns = DEPTS.map((d) => props.deptRoles[d].roleArn);
    const dataAccessPolicy = new aoss.CfnAccessPolicy(this, 'WikiAccessPolicy', {
      name: `${COLLECTION_NAME}-access`,
      type: 'data',
      description: 'AC-Harness wiki — dept roles + account principals.',
      policy: JSON.stringify([
        {
          Description: 'Read+write for dept roles and account principals',
          Rules: [
            {
              ResourceType: 'collection',
              Resource: [`collection/${COLLECTION_NAME}`],
              Permission: [
                'aoss:DescribeCollectionItems',
                'aoss:CreateCollectionItems',
                'aoss:UpdateCollectionItems',
              ],
            },
            {
              ResourceType: 'index',
              Resource: [`index/${COLLECTION_NAME}/*`],
              Permission: [
                'aoss:CreateIndex',
                'aoss:DescribeIndex',
                'aoss:ReadDocument',
                'aoss:WriteDocument',
                'aoss:UpdateIndex',
                'aoss:DeleteIndex',
              ],
            },
          ],
          Principal: [
            ...deptRoleArns,
            // See block comment above for why root is here.
            `arn:aws:iam::${this.account}:root`,
          ],
        },
      ]),
    });
    dataAccessPolicy.addDependency(this.wikiCollection);

    // -----------------------------------------------------------------
    // 5. DynamoDB employees-pii table.
    //    On-demand billing, AWS-owned KMS (Phase C swaps to CMK), GSI on
    //    `username` for the pii-lookup-fn convenience path.
    // -----------------------------------------------------------------
    this.piiTable = new ddb.Table(this, 'EmployeesPiiTable', {
      tableName: PII_TABLE_NAME,
      partitionKey: { name: 'employee_id', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
      deletionProtection: false,
    });
    this.piiTable.addGlobalSecondaryIndex({
      indexName: 'username-index',
      partitionKey: { name: 'username', type: ddb.AttributeType.STRING },
      projectionType: ddb.ProjectionType.ALL,
    });

    // -----------------------------------------------------------------
    // 6. DDB seed via AwsCustomResource.
    //    BatchWriteItem caps at 25 items/request — chunk if seed grows.
    //    Items are read at synth time and inlined into the CR call.
    // -----------------------------------------------------------------
    const piiSeedPath = path.join(
      __dirname,
      '..',
      '..',
      'data',
      'pii-seed.json',
    );
    const piiItems: Array<Record<string, string>> = JSON.parse(
      fs.readFileSync(piiSeedPath, 'utf-8'),
    );

    const chunks: Array<Array<Record<string, string>>> = [];
    for (let i = 0; i < piiItems.length; i += 25) {
      chunks.push(piiItems.slice(i, i + 25));
    }

    chunks.forEach((chunk, idx) => {
      const requestItems = {
        [PII_TABLE_NAME]: chunk.map((item) => ({
          PutRequest: {
            Item: Object.fromEntries(
              Object.entries(item).map(([k, v]) => [k, { S: String(v) }]),
            ),
          },
        })),
      };

      const seedCr = new AwsCustomResource(this, `PiiSeed-${idx}`, {
        onCreate: {
          service: 'DynamoDB',
          action: 'batchWriteItem',
          parameters: { RequestItems: requestItems },
          physicalResourceId: PhysicalResourceId.of(`PiiSeed-${idx}`),
        },
        onUpdate: {
          service: 'DynamoDB',
          action: 'batchWriteItem',
          parameters: { RequestItems: requestItems },
          physicalResourceId: PhysicalResourceId.of(`PiiSeed-${idx}`),
        },
        policy: AwsCustomResourcePolicy.fromStatements([
          new iam.PolicyStatement({
            actions: ['dynamodb:BatchWriteItem', 'dynamodb:PutItem'],
            resources: [this.piiTable.tableArn],
          }),
        ]),
        installLatestAwsSdk: false,
        logRetention: logs.RetentionDays.ONE_WEEK,
      });
      seedCr.node.addDependency(this.piiTable);
    });

    // -----------------------------------------------------------------
    // 7. HR-only PII read policy. Cross-stack: the role is defined in
    //    IdentityStack; the Policy resource lives here so the data
    //    permissions ship with the data stack.
    // -----------------------------------------------------------------
    new iam.Policy(this, 'HrPiiReadPolicy', {
      policyName: 'acharness-hr-pii-read',
      roles: [props.deptRoles.hr],
      statements: [
        new iam.PolicyStatement({
          actions: [
            'dynamodb:GetItem',
            'dynamodb:Query',
            'dynamodb:BatchGetItem',
          ],
          resources: [
            this.piiTable.tableArn,
            `${this.piiTable.tableArn}/index/*`,
          ],
        }),
      ],
    });

    // -----------------------------------------------------------------
    // 8. Outputs — exported so Phase 3+ stacks can reference by name.
    // -----------------------------------------------------------------
    new CfnOutput(this, 'WikiCollectionEndpoint', {
      value: this.wikiCollection.attrCollectionEndpoint,
      description: 'OpenSearch Serverless wiki collection endpoint',
      exportName: 'AcharnessWikiCollectionEndpoint',
    });
    new CfnOutput(this, 'WikiCollectionArn', {
      value: this.wikiCollection.attrArn,
      description: 'OpenSearch Serverless wiki collection ARN',
      exportName: 'AcharnessWikiCollectionArn',
    });
    new CfnOutput(this, 'WikiCollectionName', {
      value: COLLECTION_NAME,
      description: 'OpenSearch Serverless wiki collection name',
      exportName: 'AcharnessWikiCollectionName',
    });
    new CfnOutput(this, 'PiiTableName', {
      value: this.piiTable.tableName,
      description: 'DynamoDB employees-pii table name',
      exportName: 'AcharnessPiiTableName',
    });
    new CfnOutput(this, 'PiiTableArn', {
      value: this.piiTable.tableArn,
      description: 'DynamoDB employees-pii table ARN',
      exportName: 'AcharnessPiiTableArn',
    });
  }
}
