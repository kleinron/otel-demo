# infra/aws

Safety tooling and the demo CDK app. This is the only place provider-specific code belongs. Every construct inherits the tag below from the app. Database backups are off. `cdk destroy` is expected to finish without a retained database, log group, repository, or snapshot.

## Tagging contract

One tag, applied to every resource this experiment creates:

```text
experiment = otel-demo
```

The constants and the CDK-shaped list live in `src/tags.ts` (`experimentTagList()`). Do not invent a second tag. Names use the `otel-demo` token so teardown can still find snapshots, log groups, and ENIs that were created without the tag.

The Budgets alert named `otel-demo-experiment` is allow-listed by that exact name. Teardown does not delete it, and verify does not report it as a leftover, tagged or not. Ron deletes it by hand after the experiment is fully finished.

`CDKToolkit` and `cdk-*` asset buckets stay. They are bootstrap, not experiment resources.

## Fault kill switch

Application services do not import the AWS SDK. When a task must poll SSM, set `FAULT_SWITCH_SOURCE=module` and `FAULT_SWITCH_MODULE=@otel-demo/infra-aws/fault-switch`. `createFaultSwitch` reads the parameter `/otel-demo/faults-enabled` unless `FAULT_SWITCH_SSM_PARAMETER` overrides it. This package does not create that parameter.

## Commands

From the repo root:

```bash
npm run teardown:rehearsal
npm run teardown -- --dry-run
npm run teardown -- --region eu-central-1
npm run deploy:check
npm run synth -w @otel-demo/infra-aws
```

Region defaults to `eu-central-1`. Cloud settings come from environment variables. See [docs/teardown.md](../../docs/teardown.md).

`npm run teardown:rehearsal` is the step to run before the first full deploy. It creates one tagged S3 bucket and one tagged CloudWatch log group, runs export, destroy, leftover deletion, and verify against them, and exits non-zero if anything remains.

`--dry-run` prints every resource it would delete. A name-only match is marked `name-only match, no tag`.

A real run that skips the archive requires both `--skip-export` and `--i-understand-no-export`, and always writes `results/<run-id>/EXPORT_MISSING`.

After the tagged and named verify check, teardown scans the region for billable resources regardless of tag or name and prints each one as `WARN`. Those lines do not change the exit code. The `otel-demo-experiment` budget stays ignored.

`deploy:check` refuses a deploy unless credentials are valid, `EXPERIMENT_HARD_STOP_UTC` leaves at least five days (a 72-hour run plus export and teardown), the `otel-demo-experiment` budget exists, and RDS and VPC quotas cover 4 `db.t4g.micro` instances and 1 VPC.

`cdk.json` is present, so teardown runs `npx cdk destroy` for experiment stacks only. It never deletes `CDKToolkit`.

## Clean destroy

The stack in `src/cdk` uses:

- RDS: `RemovalPolicy.DESTROY`, `deletionProtection: false`, backup retention 0, and no final snapshot. Database backups are off on purpose.
- CloudWatch log groups: 7-day retention and `RemovalPolicy.DESTROY`.
- ECR repositories: `emptyOnDelete: true`.
- The experiment tag once, on the app: `Tags.of(app).add('experiment', 'otel-demo')`.
- No S3 buckets. A later bucket still needs `autoDeleteObjects: true`.

Verify also lists security groups (including the Grafana task group), running ECS tasks (including Grafana), Secrets Manager secrets (including the Grafana admin password), and the SSM faults parameter, and deletes any of those that remain. Deploy with `--region eu-central-1`. Synth does not call AWS.

`npm run grafana:url` prints the Grafana task's current public address. The security group starts with no inbound rules; add your address on port 3000 after every deploy.

Do not put account ids, ARNs, IP addresses, or credentials in this tree. Cost notes: [docs/cost-estimate.md](../../docs/cost-estimate.md).
