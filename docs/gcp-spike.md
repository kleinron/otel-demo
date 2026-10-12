# GCP spike

A throwaway Cloud Run shape for one shop service. It is not the AWS demo and it does not change the AWS stack. AWS tasks leave `CLOUD_PROVIDER` and `LOG_FORMAT` unset, so their logs and the SSM kill switch stay as they are.

Terraform lives in `infra/gcp/terraform`. The fault-switch selector is `@otel-demo/infra-gcp/fault-switch`. Nothing here calls a cloud API during tests.

## What gets created

- Artifact Registry docker repository `otel-demo`.
- One Cloud Run service, `otel-demo-shop`, with a collector sidecar. Minimum instances is 1. CPU is always allocated (`cpu_idle = false`) on both containers, so the sidecar is not frozen between requests. Maximum instances defaults to 1.
- The shop process logs with `LOG_FORMAT=gcp` and `CLOUD_PROVIDER=gcp`. Traces go to the sidecar at `http://localhost:4318`. The sidecar's `googlecloud` exporter writes them to Cloud Trace. The shop container sets `container_port` to 3001 and does not set a `PORT` environment variable. Cloud Run reserves `PORT` and sets it from that container port. `deletion_protection` is false so `terraform destroy` can delete the service.
- The collector health extension listens on all interfaces, port 13133. Cloud Run's TCP startup probe connects to that port from outside the container's localhost, so a localhost bind never becomes ready and the revision does not start. Terraform joins the address octets and passes the result into the collector config as `health_bind`. Collector telemetry logs default to `error`. Set `collector_log_level` to `info` to raise them.
- Secret Manager secret `otel-demo-faults-enabled`, created as `off`.
- A billing budget, only when `create_budget` is true. The default is false. When it is false, Terraform creates neither the Pub/Sub topic `otel-demo-budget-alerts` nor the budget, and it does not enable the Pub/Sub or billing-budget APIs. When it is true, the budget is on the billing account, filtered to this project. The amount is `budget_amount_usd`, default 25 USD, with alerts at 50%, 90%, and 100%. Billing account admins receive the email. The same alerts are published to that topic. `billing_account` is required only in that case.
- A Cloud Scheduler job that, at `hard_stop_utc` (default `2026-10-14T00:00:00Z`), patches the service so `scaling.scalingMode` is `MANUAL` and `scaling.manualInstanceCount` is 0. Both fields are in the update mask. The job does not depend on the Cloud Run service. The service depends on the job, so the hard stop exists before the revision runs.

`region` defaults to `me-west1` (Tel Aviv). Set it to `europe-west1` (Belgium) to place the spike there instead. `scheduler_region` follows `region` when it is empty. Set `scheduler_region` to `europe-west1` only if the Scheduler job cannot be created in the chosen region. The locations page lists Cloud Scheduler in `me-west1`, so the default job stays in Tel Aviv. The schedule is minute resolution in UTC. `2026-10-14T00:00:00Z` is cron `0 0 14 10 *`.

The fault-switch secret uses user-managed replication in `region`, so its versions are stored in Tel Aviv unless you override the region.

## Required variables

`project_id` and `shop_image` have no default. Everything else can be left at its default for a first apply.

Copy the example and fill those two locally. The copy is gitignored.

```bash
cp infra/gcp/terraform/terraform.tfvars.example infra/gcp/terraform/terraform.tfvars
```

```hcl
project_id = "your-project-id"
shop_image = "me-west1-docker.pkg.dev/your-project-id/otel-demo/shop:spike"
```

`project_id` is the project id, not the project number. `shop_image` is the Artifact Registry image Cloud Run will run. Push it before apply. The registry host must match `region` (`me-west1-docker.pkg.dev` for the default). The full example, including the optional budget and collector log settings, is `infra/gcp/terraform/terraform.tfvars.example`.

`region` defaults to `me-west1`. Set `europe-west1` only as a fallback. Leave `create_budget` false unless you want the budget. Leave `collector_log_level` unset to keep collector logs at `error`.

## Access

The identity that runs Terraform and pushes the image needs these project roles:

| Role                                    | Used for                                       |
| --------------------------------------- | ---------------------------------------------- |
| `roles/run.admin`                       | Cloud Run service                              |
| `roles/artifactregistry.admin`          | Docker repository                              |
| `roles/cloudbuild.builds.editor`        | Cloud Build, when the image is built that way  |
| `roles/storage.admin`                   | Cloud Build source uploads and build artifacts |
| `roles/iam.serviceAccountAdmin`         | Shop and hard-stop service accounts            |
| `roles/resourcemanager.projectIamAdmin` | Project IAM bindings for those accounts        |
| `roles/secretmanager.admin`             | Fault-switch secret                            |
| `roles/cloudscheduler.admin`            | Hard-stop job                                  |
| `roles/logging.viewer`                  | Log Explorer                                   |
| `roles/cloudtrace.user`                 | The view-trace link                            |

`roles/resourcemanager.projectIamAdmin` is the projectIamAdmin role.

Cloud Build's default compute service account (`PROJECT_NUMBER-compute@developer.gserviceaccount.com`) needs `roles/storage.objectViewer`, `roles/artifactregistry.writer`, and `roles/logging.logWriter` so a build can read its source, push the image, and write logs.

Prefer user credentials (`gcloud auth login` and `gcloud auth application-default login`). Do not create a JSON service-account key unless something you are using cannot take Application Default Credentials. See [Key hygiene](#key-hygiene).

## Before apply

You need a project and billing on that project. A budget resource is optional (`create_budget`).

Shop will not listen until `DATABASE_URL` is set. The AWS image builds that URL from database parts. This spike does not create a database (a Cloud SQL instance would spend the budget on its own). Create a secret yourself and pass its id as `database_secret`:

```bash
printf '%s' "$DATABASE_URL" | gcloud secrets create otel-demo-shop-database-url --data-file=- --project="$PROJECT_ID"
```

The URL must not be written into terraform, a tfvars file that you commit, or a pull request. Unset the shell variable when you are done. `INVENTORY_URL`, `PAYMENT_URL`, and `DELIVERY_URL` default to localhost ports so the process can start; checkout calls to those ports fail until real services exist. A request that only needs shop, such as reading an order, is enough to emit a log line.

The service command is `node services/shop/dist/index.js`. It does not use the AWS SSM entrypoint. `FAULT_SWITCH_SOURCE=env` and `OTEL_DEMO_FAULTS_ENABLED=off` keep faults off without calling AWS. The env also sets `FAULT_SWITCH_PROVIDER=gcp` and points `GCP_FAULT_SWITCH_SECRET` at the secret created above. The running image still uses the env switch, because the AWS image does not contain `infra/gcp`. To poll Secret Manager, build an image that includes `@otel-demo/infra-gcp/fault-switch` and set `FAULT_SWITCH_SOURCE=module` and `FAULT_SWITCH_MODULE` to that module. The module's default provider is `aws-ssm`; `FAULT_SWITCH_PROVIDER=gcp` selects Secret Manager. `GCP_FAULT_SWITCH_SOURCE=config` reads `GCP_FAULT_SWITCH_VALUE` and makes no cloud call.

### Image

`shop_image` must be an image Cloud Run can run, pushed to Artifact Registry before apply:

```bash
gcloud auth configure-docker me-west1-docker.pkg.dev
docker build --platform linux/amd64 -f infra/aws/docker/service.Dockerfile -t "$SHOP_IMAGE" .
docker push "$SHOP_IMAGE"
```

The AWS Dockerfile refuses any build that is not `linux/arm64`, because Fargate in this demo is ARM. That check is unchanged. If Cloud Run in the chosen region only runs amd64, that Dockerfile will reject the build. Confirm the region's supported architectures before you rely on this command. Do not weaken the AWS check to make the spike build.

The collector image defaults to `otel/opentelemetry-collector-contrib:0.128.0`. The `googlecloud` exporter is part of the contrib distribution, not the core `otel/opentelemetry-collector` image. Confirm the tag still ships that exporter (`googlecloud` on the traces pipeline) before apply. The config is passed with `--config=env:OTEL_COLLECTOR_CONFIG`. Telemetry logs in that config default to `error`.

Cloud Run multi-container (the shop process plus the collector sidecar) has to be available for the service resource. Containers share localhost, so the OTLP receiver stays on `localhost:4318` and shop exports there. The health extension does not. It listens on all interfaces, port 13133, because the startup probe is a TCP check Cloud Run makes against the container port and a localhost socket never accepts it.

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

The budget, when `create_budget` was true, is on the billing account, not inside the project, so it can outlive the project. List it and delete it if it is still there:

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

- Creating that key also requires an org-policy override. Both the legacy constraint `constraints/iam.disableServiceAccountKeyCreation` and the managed constraint `constraints/iam.managed.disableServiceAccountKeyCreation` block key creation until they are overridden for the project or the organization. Prefer Application Default Credentials and skip the key.
- Do not put the key contents in a shell history you share, a log, or a pull request. `gitleaks` runs on pull requests and rejects private keys, AWS account ids, and IP addresses. The health bind is assembled in Terraform so the all-interfaces address is not written as a literal.
- Application Default Credentials from `gcloud auth application-default login` are stored outside the repo. Revoke them with `gcloud auth application-default revoke` when you are finished.

## Region check (me-west1)

Checked against the Google Cloud locations pages on 2026-10-11. `me-west1` is Tel Aviv.

| Product                            | In me-west1                                                                                                                                                                                                            | Source                                                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Cloud Run                          | Listed, Tier 1 pricing                                                                                                                                                                                                 | https://cloud.google.com/run/docs/locations                                                     |
| Cloud Run multi-container sidecars | No separate location table. The deploying guide documents sidecars as a service feature and lists `me-west1` as a Cloud Run region. Release notes mark service sidecars generally available, with no region exclusion. | https://cloud.google.com/run/docs/deploying and https://cloud.google.com/run/docs/release-notes |
| Artifact Registry                  | Listed (`me-west1`, Tel Aviv)                                                                                                                                                                                          | https://cloud.google.com/artifact-registry/docs/repositories/repo-locations                     |
| Cloud Scheduler                    | Listed under Middle East (`me-west1`, Tel Aviv)                                                                                                                                                                        | https://cloud.google.com/scheduler/docs/locations                                               |
| Secret Manager                     | Regional Secret Manager: Yes for `me-west1` (Tel Aviv)                                                                                                                                                                 | https://cloud.google.com/secret-manager/docs/locations                                          |
| Cloud Trace storage                | Observability buckets include `me-west1` (Tel Aviv). The page says those buckets store data from services such as Cloud Trace.                                                                                         | https://cloud.google.com/stackdriver/docs/observability/observability-bucket-locations          |
| Cloud Logging storage              | Log bucket locations include `me-west1` (Tel Aviv)                                                                                                                                                                     | https://cloud.google.com/logging/docs/region-support                                            |
| Cloud SQL for PostgreSQL           | Listed under Middle East (`me-west1`, Tel Aviv)                                                                                                                                                                        | https://cloud.google.com/sql/docs/postgres/locations                                            |

Gaps:

- There is no locations page that says sidecar support region by region. Sidecar support in `me-west1` is inferred from Cloud Run being available there and from sidecars being a general feature of a Cloud Run service.
- This stack does not create a Cloud SQL instance. The locations page is the availability check only.
- Cloud Run stdout is ingested by the Logging API. New `_Default` and `_Required` buckets are in `global` unless the organization sets another default (https://cloud.google.com/logging/docs/regionalized-logs). This terraform does not create a `me-west1` log bucket or a sink, so log storage is not forced into Tel Aviv.
- The collector sends traces to the Cloud Trace API. It does not set an observability-bucket location. Unless the project default for observability buckets is `me-west1`, trace storage may be somewhere else. https://cloud.google.com/trace/docs/storage-overview
- The fault-switch secret is user-managed in `region`. A `database_secret` you create outside terraform is stored wherever that secret's replication policy says.

## Live spike

Checked on a real apply. Folded into this terraform:

- The collector `health_check` extension must listen on all interfaces, port 13133. `localhost:13133` fails Cloud Run's TCP startup probe and the revision never starts.
- Collector telemetry logs default to `error`. `info` is opt-in through `collector_log_level`.
- The hard-stop PATCH sets `scalingMode` to `MANUAL` and `manualInstanceCount` to 0, and the update mask names both fields. `manualInstanceCount` alone is likely rejected. The Scheduler job is created before the Cloud Run service and does not depend on it.
- `deletion_protection` is false.
- `PORT` is not set. `container_port` is 3001, and Cloud Run sets `PORT` from it.
- The Pub/Sub budget topic and the billing budget exist only when `create_budget` is true.

## Assumptions to verify

- `cpu_idle = false` keeps CPU allocated for both containers in `me-west1`. The locations pages do not mention that setting.
- `otel/opentelemetry-collector-contrib:0.128.0` still contains the `googlecloud` exporter and still accepts `--config=env:OTEL_COLLECTOR_CONFIG`.
- Cloud Scheduler's PATCH of `scaling.scalingMode=MANUAL` together with `scaling.manualInstanceCount=0` is accepted by the Cloud Run Admin API and scales the service to zero. The hard-stop service account has `roles/run.developer` and the Scheduler service agent can mint its token. The locations page lists the service in `me-west1`; it does not document this API call.
- The shop image's architecture matches Cloud Run. The AWS Dockerfile only builds `linux/arm64`.
- A useful log line needs `DATABASE_URL` in Secret Manager (`database_secret`). This terraform does not create a database.
- `roles/run.developer` is enough for the hard-stop account to patch scaling. If the API returns a permission error, the account needs `roles/run.admin` instead.
- Setting `manualInstanceCount` replaces the template's minimum of 1. A later `terraform apply` puts the minimum back.
