# infra/aws

Safety tooling that has to exist before any experiment resource is created. There is no ECS or RDS stack in this directory yet. When that CDK app is added, it is the only place provider-specific code belongs, and every construct must use the tag below.

## Tagging contract

One tag, applied to every resource this experiment creates:

```text
experiment = otel-demo
```

The constants and the CDK-shaped list live in `src/tags.ts` (`experimentTagList()`). Do not invent a second tag. Names use the `otel-demo` token so teardown can still find snapshots, log groups, and ENIs that were created without the tag.

The Budgets alert named `otel-demo-experiment` is allow-listed by that exact name. Teardown does not delete it, and verify does not report it as a leftover, tagged or not. Ron deletes it by hand after the experiment is fully finished.

`CDKToolkit` and `cdk-*` asset buckets stay. They are bootstrap, not experiment resources.

## Commands

From the repo root:

```bash
npm run teardown -- --dry-run
npm run teardown -- --region eu-central-1
npm run deploy:check
```

Region defaults to `eu-central-1`. Cloud settings come from environment variables. See [docs/teardown.md](../../docs/teardown.md).

`deploy:check` refuses a deploy unless credentials are valid, `EXPERIMENT_HARD_STOP_UTC` leaves at least five days (a 72-hour run plus export and teardown), the `otel-demo-experiment` budget exists, and RDS and VPC quotas cover 4 `db.t4g.micro` instances and 1 VPC.

Until `cdk.json` exists, teardown deletes experiment stacks with the CloudFormation API. It never deletes `CDKToolkit`.

Do not put account ids, ARNs, IP addresses, or credentials in this tree.
