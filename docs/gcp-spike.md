# GCP spike

A throwaway Cloud Run shape for one shop service. It is not the AWS demo and it does not change the AWS stack. AWS tasks leave `CLOUD_PROVIDER` and `LOG_FORMAT` unset, so their logs and the SSM kill switch stay as they are.

Terraform lives in `infra/gcp/terraform`. The fault-switch selector is `@otel-demo/infra-gcp/fault-switch`. Nothing here calls a cloud API during tests.

## What gets created

- Artifact Registry docker repository `otel-demo`.
- One Cloud Run service, `otel-demo-shop`, with a collector sidecar. Minimum instances is 1. CPU is always allocated (`cpu_idle = false`) on both containers, so the sidecar is not frozen between requests. Maximum instances defaults to 1.
- The shop process logs with `LOG_FORMAT=gcp` and `CLOUD_PROVIDER=gcp`. Traces go to the sidecar at `http://localhost:4318`. The sidecar's `googlecloud` exporter writes them to Cloud Trace.
- Secret Manager secret `otel-demo-faults-enabled`, created as `off`.
- A billing budget on the billing account, filtered to this project. The amount is `budget_amount_usd`, default 25 USD, with alerts at 50%, 90%, and 100%. Billing account admins receive the email. The same alerts are published to the Pub/Sub topic `otel-demo-budget-alerts`.
- A Cloud Scheduler job that, at `hard_stop_utc` (default `2026-10-14T00:00:00Z`), patches the service so `scaling.manualInstanceCount` is 0.

`region` is `europe-west1` or `me-west1`. Cloud Scheduler might not be offered in `me-west1`. Set `scheduler_region` to `europe-west1` if the job cannot be created there. The schedule is minute resolution in UTC. `2026-10-14T00:00:00Z` is cron `0 0 14 10 *`.

## Before apply

You need a project, billing, and permission to enable APIs, deploy Cloud Run, write Artifact Registry, create a budget, and create a Scheduler job.

Prefer user credentials (`gcloud auth login` and `gcloud auth application-default login`). Do not create a JSON service-account key unless something you are using cannot take Application Default Credentials. See [Key hygiene](#key-hygiene).

Copy the example variables and fill them locally. That file is gitignored.

```bash
cp infra/gcp/terraform/terraform.tfvars.example infra/gcp/terraform/terraform.tfvars
```

Set `project_id`, `billing_account`, `region`, and `shop_image`.

Shop will not listen until `DATABASE_URL` is set. The AWS image builds that URL from database parts. This spike does not create a database (a Cloud SQL instance would spend the budget on its own). Create a secret yourself and pass its id as `database_secret`:

```bash
printf '%s' "$DATABASE_URL" | gcloud secrets create otel-demo-shop-database-url --data-file=- --project="$PROJECT_ID"
```

The URL must not be written into terraform, a tfvars file that you commit, or a pull request. Unset the shell variable when you are done. `INVENTORY_URL`, `PAYMENT_URL`, and `DELIVERY_URL` default to localhost ports so the process can start; checkout calls to those ports fail until real services exist. A request that only needs shop, such as reading an order, is enough to emit a log line.

The service command is `node services/shop/dist/index.js`. It does not use the AWS SSM entrypoint. `FAULT_SWITCH_SOURCE=env` and `OTEL_DEMO_FAULTS_ENABLED=off` keep faults off without calling AWS. The env also sets `FAULT_SWITCH_PROVIDER=gcp` and points `GCP_FAULT_SWITCH_SECRET` at the secret created above. The running image still uses the env switch, because the AWS image does not contain `infra/gcp`. To poll Secret Manager, build an image that includes `@otel-demo/infra-gcp/fault-switch` and set `FAULT_SWITCH_SOURCE=module` and `FAULT_SWITCH_MODULE` to that module. The module's default provider is `aws-ssm`; `FAULT_SWITCH_PROVIDER=gcp` selects Secret Manager. `GCP_FAULT_SWITCH_SOURCE=config` reads `GCP_FAULT_SWITCH_VALUE` and makes no cloud call.

### Image

`shop_image` must be an image Cloud Run can run, pushed to Artifact Registry before apply:

```bash
gcloud auth configure-docker europe-west1-docker.pkg.dev
docker build --platform linux/amd64 -f infra/aws/docker/service.Dockerfile -t "$SHOP_IMAGE" .
docker push "$SHOP_IMAGE"
```

The AWS Dockerfile refuses any build that is not `linux/arm64`, because Fargate in this demo is ARM. That check is unchanged. If Cloud Run in the chosen region only runs amd64, that Dockerfile will reject the build. Confirm the region's supported architectures before you rely on this command. Do not weaken the AWS check to make the spike build.

The collector image defaults to `otel/opentelemetry-collector-contrib:0.128.0`. The `googlecloud` exporter is part of the contrib distribution, not the core `otel/opentelemetry-collector` image. Confirm the tag still ships that exporter (`googlecloud` on the traces pipeline) before apply. The config is passed with `--config=env:OTEL_COLLECTOR_CONFIG`.

Cloud Run multi-container (the shop process plus the collector sidecar) has to be available for the service resource. Containers share localhost, so the collector listens on `localhost:4318` and shop exports there.

## Deploy

```bash
cd infra/gcp/terraform
terraform init
terraform plan
terraform apply
```

A later `terraform apply` sets minimum instances back to 1. That undoes the hard stop. Leave the spike applied until the scheduler fires, then delete the project.

## Check a log line and the view-trace link

Cloud Run sends container stdout to Cloud Logging. With `LOG_FORMAT=gcp` a line looks like this (fields that matter for the link):

```json
{
  "severity": "INFO",
  "message": "request",
  "service": "shop",
  "logging.googleapis.com/trace": "projects/PROJECT_ID/traces/TRACE_ID",
  "logging.googleapis.com/spanId": "SPAN_ID",
  "logging.googleapis.com/trace_sampled": true
}
```

`severity` is a name (`INFO`, `WARNING`, `ERROR`), not a pino number. `message` is the old `msg`. `orderId` and `service` are unchanged. There is no `xray_trace_id`. The trace value is the Cloud Trace resource name. `TRACE_ID` is 32 lowercase hex characters. On this spike those ids are standard W3C random ids, not the X-Ray time prefix.

Open the line in Log Explorer. The trace field is what draws the **view trace** link next to the log entry. The link opens that trace in Cloud Trace. It appears after the collector has exported the span. A line written before the sidecar is up, or a line whose span was not sampled, will not link.

Query (replace the project):

```text
resource.type="cloud_run_revision"
resource.labels.service_name="otel-demo-shop"
jsonPayload.service="shop"
```

In the results, open one JSON payload and confirm `logging.googleapis.com/trace` starts with `projects/` and your project id. Use the view-trace control on that row. If the control is missing, check that the collector sidecar is running and that the shop revision became ready (it needs `DATABASE_URL`).

Call the service with an identity token. The spike does not grant public invoker:

```bash
URL="$(terraform output -raw shop_uri)"
curl -sS -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$URL/health"
```

`/health` is not logged. Request an order path to get a `request` line, for example `$URL/orders/ord_spike`.

## Teardown

Delete the project. That removes Cloud Run, Artifact Registry, Scheduler, secrets, and the enabled APIs.

```bash
gcloud projects delete "$PROJECT_ID"
```

The budget is on the billing account, not inside the project, so it can outlive the project. List it and delete it if it is still there:

```bash
gcloud billing budgets list --billing-account="$BILLING_ACCOUNT"
```

Delete the budget from the billing console, or with `gcloud billing budgets delete`, using the id from that list. Do not paste the billing account id into the repo.

Then confirm nothing from the spike is still listed. A deleted project should not return resources:

```bash
gcloud run services list --project="$PROJECT_ID" --region="$REGION"
gcloud artifacts repositories list --project="$PROJECT_ID" --location="$REGION"
gcloud scheduler jobs list --project="$PROJECT_ID" --location="$REGION"
gcloud secrets list --project="$PROJECT_ID"
gcloud projects describe "$PROJECT_ID"
```

`gcloud projects describe` should fail or show the project as pending deletion. The four list commands should fail because the project is gone, or return no rows. The budgets list above is the one place a resource can remain, because it is attached to the billing account.

## Key hygiene

- Do not commit a service-account JSON key, a filled `terraform.tfvars`, a `.tfstate`, or an application-default credential file.
- `.gitignore` ignores `*.tfvars` (the `terraform.tfvars.example` placeholder is the exception), `*.tfstate`, `.terraform/`, and `*-sa-key.json`.
- If you did create a JSON key, delete it when the spike is over and remove the file from disk:

```bash
gcloud iam service-accounts keys delete "$KEY_ID" --iam-account="$SERVICE_ACCOUNT"
rm -f "$KEY_FILE"
```

- Do not put the key contents in a shell history you share, a log, or a pull request. `gitleaks` runs on pull requests and rejects private keys, AWS account ids, and IP addresses.
- Application Default Credentials from `gcloud auth application-default login` are stored outside the repo. Revoke them with `gcloud auth application-default revoke` when you are finished.

## Assumptions to verify

- Cloud Run accepts two containers in one service (the sidecar) in `europe-west1` and `me-west1`, and `cpu_idle = false` keeps CPU allocated for both.
- `otel/opentelemetry-collector-contrib:0.128.0` still contains the `googlecloud` exporter and still accepts `--config=env:OTEL_COLLECTOR_CONFIG`.
- Cloud Scheduler can `PATCH` the Cloud Run Admin API with `updateMask=scaling.manualInstanceCount` and a body of `{ "scaling": { "manualInstanceCount": 0 } }`, and that scales the service to zero. The hard-stop service account has `roles/run.developer` and the Scheduler service agent can mint its token.
- Cloud Scheduler exists in the region you set. `me-west1` may require `scheduler_region = "europe-west1"`.
- The shop image's architecture matches Cloud Run. The AWS Dockerfile only builds `linux/arm64`.
- A useful log line needs `DATABASE_URL` in Secret Manager (`database_secret`). This terraform does not create a database.
- `roles/run.developer` is enough for the hard-stop account to patch scaling. If the API returns a permission error, the account needs `roles/run.admin` instead.
- Setting `manualInstanceCount` replaces the template's minimum of 1. A later `terraform apply` puts the minimum back.
