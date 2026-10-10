# Teardown checklist

Tear down the eu-central-1 experiment after the run is recorded: shop, inventory, payment, and delivery on ECS Fargate, their RDS instances, the load generator, the Grafana task, ADOT, CloudWatch, and X-Ray resources created for the experiment.

Do the steps in order. The export is the gate: if it fails while the records still exist, stop. Do not run `cdk destroy`.

This checklist is safe to re-run with fresh credentials. It does not contain credentials, account ids, or key material. Do not add any of those while you follow it.

The experiment tag is the constant pair `experiment` = `otel-demo` in `infra/aws/src/tags.ts`. Use that pair. Do not guess a different tag and delete from it.

`cdk destroy` targets the experiment stacks only. Leave the CDK bootstrap stack (`CDKToolkit`) and its asset bucket in place unless the account owner has explicitly asked to remove bootstrap.

The AWS Budgets alert (`experiment-budget` in [alerts.yml](alerts.yml), budget name `otel-demo-experiment`) stays. Teardown allow-lists that budget by name. Ron deletes the budget by hand after the experiment is fully finished. Long-lived IAM access keys are not deleted by this checklist; the key owner deletes them after teardown is finished.

Alert evidence is Grafana alert state history. That history lives inside the Grafana task and is lost on restart. Every alert state change is also sent through a webhook contact point to a small logging endpoint, so it appears as a structured log line in CloudWatch Logs. The event type is `grafana_alert_state_change`, with the rule name, the previous state, the new state, and a timestamp in UTC. A rule in Alerting (Firing) is the state this checklist records. Teardown exports those log lines and the Grafana-provisioned rule files. The export fails if neither exists.

Nothing outside Grafana watches Grafana itself, so Grafana-down is not alerted. That is deliberate because alerts are defined in one place. Do not add a CloudWatch alarm on the Grafana task to fill that gap.

## Credential check

Do this at the start of every step below, including each re-run.

- [ ] `aws sts get-caller-identity` succeeds.
- [ ] The session expiration is at least 15 minutes away. If the credentials do not expire (long-lived keys), record that they are the long-lived pair the owner will delete afterwards, and continue.
- [ ] On failure, or when expiration is inside 15 minutes: stop. Do not start the next delete. Get fresh credentials, repeat this check, and resume at the step you were on.
- [ ] Keep the caller identity in the terminal only. Do not copy the account id or the caller ARN into the repo, the PR, or `results/`.

## Step 1 — Export

Destination is a local `results/<run-id>/` directory at the repo root. Leave it untracked.

Export all of the following for the run window:

- [ ] Run records: load profile, start and end, fault-injection state (database timeouts and payment delays on or off), and the log events for the load generator and the four services.
- [ ] `grafana_alert_state_change` log lines for every alert rule generated from [alerts.yml](alerts.yml). Each line has the rule name, the previous state, the new state, and a timestamp in UTC. Alerting (Firing) is the state that means the rule fired. Grafana alert state history inside the task is lost on restart, so these log lines are the copy that survives.
- [ ] Grafana-provisioned rule files produced from that catalog (file-based provisioning), including each rule's threshold, `service` and `severity` labels, and summary annotation.
- [ ] Saved CloudWatch Logs Insights queries (`describe-query-definitions`) and the result of each saved query for the run window.

Follow pagination on every list call until there is no continuation token.

- [ ] A query that returns no rows is a successful empty result. Write the empty result file.
- [ ] A non-zero API call, an access error, a partial write, or a missing file is a failed export.
- [ ] If there are no saved Logs Insights queries to archive, the export has failed. Stop and create the saved queries before destroying anything.
- [ ] If neither the `grafana_alert_state_change` log lines nor the Grafana-provisioned rule files exist, the export has failed. Stop. A query that returns no state-change rows is still a successful empty result when that empty file and the provisioned rule files are both on disk.
- [ ] Write `results/<run-id>/EXPORT_OK` only after every export command has succeeded. The marker lists the files written.
- [ ] If the export fails, do not write `EXPORT_OK`. Stop. Leave the stack up. Fix the export and repeat this step. `cdk destroy` is not allowed.

Re-run:

- [ ] An existing `EXPORT_OK` whose file list is still on disk satisfies this step. Do not destroy on the strength of a marker you cannot open.
- [ ] If the stacks are already gone and `EXPORT_OK` is missing, the records were not archived. Write `results/<run-id>/EXPORT_MISSING`, then continue with leftover cleanup so NAT gateways, RDS, and the rest do not keep billing. Do not treat that as a successful export.

## Step 2 — `cdk destroy`

Start this step only when `EXPORT_OK` exists for the run, or when Step 1 has already recorded `EXPORT_MISSING` because the stacks are gone.

- [ ] Credential check.
- [ ] From `infra/aws`, run `cdk destroy` for the experiment stacks. Do not destroy `CDKToolkit` as part of this step.
- [ ] Wait until those stacks reach delete complete, or retry destroy until they do.
- [ ] On failure, stop. Refresh credentials if they are near expiry, then re-run this step. Do not start the leftover sweep while a stack is still in progress.
- [ ] A stack already absent is a success for this step. `cdk destroy` is safe to run again.

## Step 3 — Delete leftovers by experiment tag

Tag-based deletion misses some children. Snapshots, automated backups, log groups, and ENIs often survive without the experiment tag. Delete those only when their name, description, or source instance shows they belong to this experiment.

- [ ] Credential check.
- [ ] List tagged resources with the Resource Groups Tagging API in eu-central-1. Follow pagination. Read the list before you delete anything. Every item must be an experiment leftover.
- [ ] Delete the tagged leftovers. Skip the AWS Budgets budget and its notifications, even if they carry the experiment tag.
- [ ] Delete manual RDS snapshots for the experiment instances (`describe-db-snapshots`, snapshot type `manual`, then `delete-db-snapshot`).
- [ ] Delete retained automated RDS backups for those instances (`describe-db-instance-automated-backups`, then `delete-db-instance-automated-backup`). While an instance still exists, automated snapshots go away with the instance only if automated backups are deleted with it. Check again after the instance is gone.
- [ ] Check DB cluster snapshots the same way if any experiment database was a cluster.
- [ ] Release Elastic IPs that belonged to the experiment NAT gateways once those gateways are gone.
- [ ] Skip `CDKToolkit` and the CDK asset bucket.
- [ ] If ownership of a resource is unclear, stop and leave it. Do not delete it.

## Step 4 — Verify

Verification is read-only. A resource counts as gone only after the list call has been paginated to the end.

- [ ] Credential check.
- [ ] Resource Groups Tagging API: no experiment-tagged resources remain, except the Budgets alert if it carries the tag.
- [ ] Direct checks in eu-central-1, including types the tagging API often misses. For each type, confirm nothing that belongs to the experiment remains. Leave unrelated resources and CDK bootstrap alone.
  - [ ] NAT gateways, and Elastic IPs they allocated
  - [ ] Load balancers (application, network, and classic)
  - [ ] RDS instances
  - [ ] RDS snapshots, both manual and automated, and retained automated backups
  - [ ] Log groups
  - [ ] ECR repositories
  - [ ] Orphaned ENIs (`available` interfaces left behind by the experiment's tasks, NAT gateways, or load balancers). Delete an unattached experiment ENI if one is still present, then list again
  - [ ] S3 buckets (list is global; confirm the bucket region). Experiment-tagged buckets should be empty and removed, including versioned objects and delete markers
  - [ ] CloudFormation stacks. No experiment stack should remain, including `DELETE_FAILED`. `CDKToolkit` may remain
- [ ] Confirm the Budgets alert still exists. Budgets are queried from us-east-1 even though the workload is eu-central-1. A regional resource list that does not show the budget is not evidence that it was deleted.
- [ ] Anything still present that belongs to the experiment: return to Step 3, then repeat this step.

## Step 5 — After the cloud resources are gone

- [ ] The Budgets alert is still present.
- [ ] The owner deletes the long-lived IAM access keys used for this experiment. Do that only after the steps above are done, so a re-run can still authenticate.
- [ ] The owner confirms those keys are no longer active.
- [ ] Do not copy key ids, secrets, or session tokens into the repo, the PR, or `results/`.

## Sanitizing exports

`results/` is local. Before any of it is committed to this public repository, attached to a PR, or pasted into an issue, sanitize it.

Redact all of the following from every exported file:

- AWS account ids
- ARNs
- IP addresses
- Hostnames, including RDS endpoints, load balancer DNS names, and ECS task hostnames

Remove access key ids, secret access keys, and session tokens. Scan the directory again after redaction, then commit only the sanitized copy if a public archive is required.

## Re-running with fresh credentials

- [ ] Repeat the credential check. Resume at the first step that is not already done.
- [ ] Step 1 is done only when `EXPORT_OK` is present and the files it lists are still on disk.
- [ ] Step 2 is done only when the experiment stacks are gone.
- [ ] Steps 3 and 4 are done only when both the tagging API and the direct checks are clear, and the Budgets alert is confirmed still present.
- [ ] A new set of credentials does not require a new export if the previous export is complete.
