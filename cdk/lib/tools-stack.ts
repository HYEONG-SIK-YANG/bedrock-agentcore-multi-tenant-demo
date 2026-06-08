import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CfnOutput,
  CustomResource,
  Duration,
  Stack,
  StackProps,
} from 'aws-cdk-lib';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as aoss from 'aws-cdk-lib/aws-opensearchserverless';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

interface ToolsStackProps extends StackProps {
  readonly piiTable: ddb.ITable;
  readonly wikiCollection: aoss.CfnCollection;
  readonly wikiCollectionName: string;
}

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const LAMBDAS_DIR = path.join(PROJECT_ROOT, 'lambdas');
const DATA_WIKI_DIR = path.join(PROJECT_ROOT, 'data', 'wiki-seed');
const BUILD_DIR = path.join(__dirname, '..', 'build');

/**
 * Stage the wiki-seed Lambda source + the .md docs into a single asset
 * directory at synth time. CDK Code.fromAsset can only point at one path,
 * and we don't want to vendor /data/wiki-seed/*.md into /lambdas/wiki-seed.
 */
function stageWikiSeedAsset(): string {
  const stagingDir = path.join(BUILD_DIR, 'wiki-seed');
  if (fs.existsSync(stagingDir)) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.cpSync(path.join(LAMBDAS_DIR, 'wiki-seed'), stagingDir, { recursive: true });
  fs.cpSync(DATA_WIKI_DIR, path.join(stagingDir, 'docs'), { recursive: true });
  return stagingDir;
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

/**
 * Build a Python Lambda asset.
 *
 * Order of preference:
 *  1. Local bundling — requires `python3` (or `python`) + pip on PATH. Fast,
 *     no Docker. We resolve manylinux2014 aarch64 wheels so the runtime is
 *     compatible even when the host is Windows.
 *  2. Docker bundling — falls back to the official Lambda Python 3.12 image
 *     when local pip is missing. Required to be running.
 */
function pythonAsset(srcDir: string): lambda.AssetCode {
  const pyExe = pickPythonExecutable();

  return lambda.Code.fromAsset(srcDir, {
    bundling: {
      image: lambda.Runtime.PYTHON_3_12.bundlingImage,
      command: [
        'bash',
        '-c',
        [
          'pip install -r requirements.txt ' +
            '--platform manylinux2014_aarch64 ' +
            '--implementation cp --python-version 3.12 ' +
            '--only-binary=:all: --upgrade --target /asset-output',
          'cp -r . /asset-output',
        ].join(' && '),
      ],
      local: pyExe
        ? {
            tryBundle(outputDir: string): boolean {
              try {
                const pipArgs = [
                  pyExe,
                  '-m',
                  'pip',
                  'install',
                  '-r',
                  'requirements.txt',
                  '--platform',
                  'manylinux2014_aarch64',
                  '--implementation',
                  'cp',
                  '--python-version',
                  '3.12',
                  '--only-binary=:all:',
                  '--upgrade',
                  '--target',
                  outputDir,
                ];
                execSync(pipArgs.join(' '), {
                  cwd: srcDir,
                  stdio: 'inherit',
                });
                // Copy source files alongside the installed wheels.
                for (const f of fs.readdirSync(srcDir)) {
                  const from = path.join(srcDir, f);
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
                // Fall through to docker bundling if local fails.
                process.stderr.write(
                  `[acharness] local python bundling failed (${(err as Error).message}); ` +
                    `will try docker.${os.EOL}`,
                );
                return false;
              }
            },
          }
        : undefined,
    },
  });
}

export class ToolsStack extends Stack {
  readonly wikiSearchFn: lambda.Function;
  readonly piiLookupFn: lambda.Function;

  constructor(scope: Construct, id: string, props: ToolsStackProps) {
    super(scope, id, props);

    const collectionEndpoint = props.wikiCollection.attrCollectionEndpoint;
    const collectionArn = props.wikiCollection.attrArn;

    // -----------------------------------------------------------------
    // 1. wiki-search-fn — MCP tool, BM25 search via opensearch-py.
    // -----------------------------------------------------------------
    this.wikiSearchFn = new lambda.Function(this, 'WikiSearchFn', {
      functionName: 'wiki-search-fn',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: pythonAsset(path.join(LAMBDAS_DIR, 'wiki-search')),
      timeout: Duration.seconds(15),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
      description: 'AC-Harness MCP tool: BM25 search over wiki-shared AOSS index.',
      environment: {
        OPENSEARCH_ENDPOINT: collectionEndpoint,
        INDEX_NAME: props.wikiCollectionName,
      },
    });
    // AOSS data plane: data access policy already grants account-root +
    // dept roles; IAM-side aoss:APIAccessAll lets this Lambda hit the API.
    this.wikiSearchFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['aoss:APIAccessAll'],
        resources: [collectionArn],
      }),
    );

    // -----------------------------------------------------------------
    // 2. pii-lookup-fn — MCP tool, employees-pii table read.
    // -----------------------------------------------------------------
    this.piiLookupFn = new lambda.Function(this, 'PiiLookupFn', {
      functionName: 'pii-lookup-fn',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: pythonAsset(path.join(LAMBDAS_DIR, 'pii-lookup')),
      timeout: Duration.seconds(10),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_WEEK,
      description: 'AC-Harness MCP tool: employees-pii lookup by username or employee_id.',
      environment: {
        DDB_TABLE: props.piiTable.tableName,
        USERNAME_INDEX: 'username-index',
      },
    });
    props.piiTable.grantReadData(this.piiLookupFn);

    // -----------------------------------------------------------------
    // 3. wiki-seed-fn (CR-driven) — creates index + bulk-indexes docs.
    //    Bundles data/wiki-seed/*.md into the Lambda asset.
    // -----------------------------------------------------------------
    const seedAssetDir = stageWikiSeedAsset();
    const wikiSeedFn = new lambda.Function(this, 'WikiSeedFn', {
      functionName: 'wiki-seed-fn',
      runtime: lambda.Runtime.PYTHON_3_12,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: pythonAsset(seedAssetDir),
      timeout: Duration.minutes(2),
      memorySize: 512,
      logRetention: logs.RetentionDays.ONE_WEEK,
      description: 'AC-Harness one-shot CR Lambda: seed wiki-shared AOSS index from bundled .md docs.',
      environment: {
        OPENSEARCH_ENDPOINT: collectionEndpoint,
        INDEX_NAME: props.wikiCollectionName,
        DOCS_DIR: '/var/task/docs',
      },
    });
    wikiSeedFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['aoss:APIAccessAll'],
        resources: [collectionArn],
      }),
    );

    // Drive seed via CR Provider so it runs once at deploy and again on
    // delete (drops the index — clean cdk destroy).
    const seedProvider = new Provider(this, 'WikiSeedProvider', {
      onEventHandler: wikiSeedFn,
      logRetention: logs.RetentionDays.ONE_WEEK,
    });
    new CustomResource(this, 'WikiSeedTrigger', {
      serviceToken: seedProvider.serviceToken,
      // Bumping this property forces a re-seed on demand.
      properties: { seedVersion: 'v1' },
    });

    // -----------------------------------------------------------------
    // 4. Outputs
    // -----------------------------------------------------------------
    new CfnOutput(this, 'WikiSearchFnArn', {
      value: this.wikiSearchFn.functionArn,
      description: 'wiki-search-fn ARN — Phase 4 Gateway target',
      exportName: 'AcharnessWikiSearchFnArn',
    });
    new CfnOutput(this, 'PiiLookupFnArn', {
      value: this.piiLookupFn.functionArn,
      description: 'pii-lookup-fn ARN — Phase 4 Gateway target',
      exportName: 'AcharnessPiiLookupFnArn',
    });
  }
}
