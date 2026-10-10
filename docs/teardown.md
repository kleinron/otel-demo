# Teardown runbook

Tear the eu-central-1 experiment down only after its records are on disk. The command is idempotent: if a credential expires in the middle, refresh it and run the same command again.

Ron deletes the Budgets alert named `otel-demo-experiment` by hand after the experiment is fully finished. Teardown never deletes that budget, and the verify step never reports it as a leftover, whether or not it carries the experiment tag.

## Tag contract

Every resource created for this experiment must carry one tag, defined in `infra/aws/src/tags.ts`:

```text
experiment = otel-demo
```

Names use the `otel-demo` token (`otel-demo-shop`, `/otel-demo/shop`). `otel-demonstration` is not a match. `CDKToolkit` and `cdk-*` bootstrap buckets are not experiment resources.

The AWS budget name is `otel-demo-experiment`. That string also matches the name token, which is why delete and verify allow-list it by name instead of trusting the absence of a tag. The catalog id `experiment-budget` in `observability/alerts.yml` is not the AWS name.

## How to run

From the repo root, with credentials in the environment (never in the repo):

```bash
npm run teardown:rehearsal
npm run teardown -- --dry-run
npm run teardown -- --region eu-central-1
npm run teardown -- --run-id run-2026-10-10
```

`--region` defaults to `eu-central-1`. Precedence is `--region`, then `EXPERIMENT_REGION`, then `AWS_REGION`, then `eu-central-1`.

Run `npm run teardown:rehearsal` before the first full deploy. It creates one tagged S3 bucket and one tagged CloudWatch log group, then runs the real teardown path against them: export, destroy, leftover deletion, and verify. The command exits non-zero if either resource remains. That rehearsal is not an experiment archive. Its `results/rehearsal-<token>/` directory only proves the delete path works on an otherwise empty account.

`--dry-run` checks credentials and prints the full plan. It does not export, does not write `EXPORT_MISSING`, does not call `cdk destroy`, and does not delete. The plan lists every resource that would be deleted, one per line. A resource matched only by the whole-token `otel-demo` name is marked `name-only match, no tag`. Read that list before a real run. A tagged resource is marked `experiment tag`.

## What it does

1. Checks that `sts` credentials work. Prints the time left on the session when the credential has an expiry, or says the credential is long-lived. Prints the time left until `EXPERIMENT_HARD_STOP_UTC` when that variable is set. Stops if either deadline is inside 15 minutes.
2. Exports first, into gitignored `results/<run-id>/`. The export contains the run record (load profile, start, end, database-timeout and payment-delay state), CloudWatch alarm state and history when alarms exist (this stack creates none, and that case writes `alarms/not-used.json`), saved Logs Insights query definitions and each saved query's result for the run window, log events for the load generator, the four services, Grafana, and `/otel-demo/alerts`, the `grafana_alert_state_change` lines, the Grafana rule files generated from `observability/alerts.yml`, and sanitized checkout traces. Account ids, ARNs, IP addresses, and cloud hostnames are redacted before the files are written. `EXPORT_OK` is written only after every file is on disk. A query that returns no rows is still a successful file. No traces is a failed export unless `EXPERIMENT_CHECKOUT_COUNT=0`, which writes `traces/none.json`.
3. Destroys experiment CloudFormation stacks. `CDKToolkit` is never destroyed. `infra/aws/cdk.json` is present, so this step runs `npx cdk destroy` for experiment stack names only.
4. Deletes leftovers by the experiment tag and by name: manual RDS snapshots, automated snapshots, retained automated backups, cluster snapshots, CloudWatch log groups, ECR repositories, S3 buckets in this region (including versions and delete markers), available ENIs, Elastic IPs, NAT gateways, load balancers, security groups, running ECS tasks, Secrets Manager secrets, SSM parameters, ACM certificates, ECS services and clusters, and stacks that are still present. A resource whose owner is unclear is left in place.
5. Verifies. The process exits non-zero if any experiment-tagged resource remains, or if any of these still exist by experiment name: RDS instances and snapshots, log groups, NAT gateways, load balancers, security groups, ECS clusters and running tasks (including Grafana), ECR repositories, secrets, the SSM faults parameter, the ACM certificate, CloudFormation stacks, S3 buckets. The report lists each remainder. A clean account prints `VERIFY OK: nothing remains.`
6. After that tagged and named check, scans the region for billable resource kinds regardless of tag or name. Every finding is printed as `WARN`. The scan does not change the exit code. Kinds: VPC endpoints, Secrets Manager secrets, KMS customer keys (AWS-managed keys are skipped), CloudWatch alarms and dashboards, running ECS tasks and services, EC2 instances, EBS volumes, Elastic IPs, NAT gateways, load balancers, RDS instances, clusters, and snapshots, ElastiCache, and OpenSearch. The Budgets alert `otel-demo-experiment` stays ignored. A different resource that happens to use that name, such as a dashboard, is still a warning. A list call that fails is also a `WARN` and does not fail the command by itself.

The budget check for step 5 is read from `us-east-1` (`BUDGETS_REGION` overrides that). A regional resource list that does not show the budget is not evidence that it was deleted.

## What it does not delete

- The Budgets alert `otel-demo-experiment`. Ron deletes it by hand after the experiment is fully finished.
- `CDKToolkit` and CDK asset buckets (`cdk-*`).
- Long-lived IAM access keys. The key owner deletes those after teardown, so a re-run can still authenticate.
- Resources that do not carry the experiment tag and do not match the experiment name.

## Export failure

Default behavior is to abort. `cdk destroy` does not start, and the process exits non-zero.

- No saved Logs Insights queries, a failed API call, a missing log group, no traces (unless `EXPERIMENT_CHECKOUT_COUNT=0`), or a partial write: no `EXPORT_OK`. Fix the export and run the command again. CloudWatch alarms are not required. When none exist, the export writes `alarms/not-used.json` and continues.
- Continuing while the stacks still exist requires both `--skip-export` and `--i-understand-no-export`. Either flag alone exits non-zero and destroys nothing. When both are set, the command writes `results/<run-id>/EXPORT_MISSING` and then destroys. That marker is not a successful export. Use the pair only when the records are already archived somewhere else.
- If the experiment stacks are already gone and `EXPORT_OK` is not on disk, the command writes `results/<run-id>/EXPORT_MISSING` and continues leftover cleanup so NAT gateways and RDS do not keep billing. That marker is not a successful export.

Re-running with the same `--run-id` (or `EXPERIMENT_RUN_ID`) reuses `EXPORT_OK` when every file it lists is still on disk and non-empty.

## Credentials expire mid-run

The command checks credentials before export, destroy, leftover deletion, and verify.

- Session expiry inside 15 minutes, or `EXPERIMENT_HARD_STOP_UTC` inside 15 minutes: it stops before the next delete. It does not write `EXPORT_OK` for a partial export.
- Put fresh credentials in the environment. Do not copy the account id, caller ARN, or keys into the repo, the PR, or `results/`.
- Run the same command again with the same `--run-id` and `--region`. Completed export is kept. Stack delete and leftover delete are safe to repeat. Not-found errors are treated as already gone.
- If verify still prints a remainder, run it once more after the in-progress delete finishes. NAT gateways and RDS instances can outlive the first call.

## Before the first full deploy

```bash
npm run teardown:rehearsal
```

This is the step to run before the first full deploy. It needs the same credentials as teardown and writes under `results/`. It fails if the tagged bucket or log group is still present after the real delete path. Do not treat that directory as the archive of a 72-hour run.

The CDK app destroys cleanly. Database backups are off: retention is 0 days and destroy does not take a final snapshot. The stack also uses:

- RDS instances: `removalPolicy: RemovalPolicy.DESTROY` and `deletionProtection: false`.
- CloudWatch log groups: 7-day retention and `removalPolicy: RemovalPolicy.DESTROY`.
- ECR repositories: `emptyOnDelete: true`.
- One app-level tag so every construct inherits it: `Tags.of(app).add('experiment', 'otel-demo')`.
- No S3 buckets. A later bucket still needs `autoDeleteObjects: true`.

## Deploy guard

Before any later deploy:

```bash
EXPERIMENT_HARD_STOP_UTC=2026-10-17T00:00:00Z npm run deploy:check
```

The guard exits non-zero unless all of the following are true:

- Credentials are valid.
- `EXPERIMENT_HARD_STOP_UTC` is at least 5 days away. That window covers the 72-hour run plus export and teardown.
- A Budgets alert named `otel-demo-experiment` exists.
- The regional RDS quota has room for 4 `db.t4g.micro` instances (`EXPERIMENT_DB_ENGINE`, default `postgres`), and the VPC quota has room for 1 VPC.

## Environment

| Variable                                                     | Role                                                                                                                               |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `EXPERIMENT_REGION`                                          | Workload region. Overrides `AWS_REGION`. Default `eu-central-1`.                                                                   |
| `BUDGETS_REGION`                                             | Budgets API region. Default `us-east-1`.                                                                                           |
| `EXPERIMENT_HARD_STOP_UTC`                                   | IAM deny-after instant. Required for `deploy:check`. Printed by teardown when set.                                                 |
| `AWS_CREDENTIAL_EXPIRATION` or `AWS_SESSION_EXPIRATION`      | Session expiry. Long-lived keys omit this.                                                                                         |
| `EXPERIMENT_RUN_ID`                                          | `results/` directory name.                                                                                                         |
| `EXPERIMENT_LOAD_PROFILE`                                    | Required for a real export.                                                                                                        |
| `EXPERIMENT_STARTED_AT` / `EXPERIMENT_ENDED_AT`              | Run window. Required for a real export.                                                                                            |
| `EXPERIMENT_DATABASE_TIMEOUTS` / `EXPERIMENT_PAYMENT_DELAYS` | `on` or `off`. Default `off`.                                                                                                      |
| `EXPERIMENT_LOG_GROUPS`                                      | Comma-separated log groups. Defaults to `/otel-demo/shop`, `inventory`, `payment`, `delivery`, `loadgen`, `alerts`, and `grafana`. |
| `EXPERIMENT_CHECKOUT_COUNT`                                  | Set to `0` only when the run recorded zero checkouts. Otherwise an empty trace export fails.                                       |
| `EXPERIMENT_DB_ENGINE`                                       | Engine for the deploy-guard orderable check. Default `postgres`.                                                                   |
| `EXPERIMENT_RESULTS_DIR`                                     | Override the `results/` directory.                                                                                                 |

Standard AWS credential variables are read by the SDK. Do not commit them.

## After the cloud resources are gone

1. Confirm verify printed `VERIFY OK` and that `otel-demo-experiment` is still present.
2. Ron deletes that budget by hand.
3. The key owner deletes the long-lived IAM keys and confirms they no longer work.

`results/` stays local. Sanitize it again before anyone attaches it to a PR or issue. The checklist in `observability/teardown-checklist.md` is the operator sequence this command implements.
