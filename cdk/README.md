# CDK app — `bedrock-agentcore-multi-tenant-demo`

This directory contains the seven CDK stacks composing the demo. See the [project README](../README.md) for the full architecture and demo guide.

## Common commands

- `npm install`         install dependencies
- `npm run build`       compile TypeScript
- `npx cdk synth`       emit CloudFormation templates to `cdk.out/`
- `npx cdk deploy --all` deploy all 7 stacks (~10 min)
- `npx cdk destroy --all` tear down

Stacks are pinned to `us-east-1` in `bin/acharness.ts`.
