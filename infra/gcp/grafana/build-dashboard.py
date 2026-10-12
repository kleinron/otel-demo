#!/usr/bin/env python3
"""Generate provisioning/dashboard-json/otel-demo.json.

Port of infra/aws/src/grafana/provision.ts dashboard() to GCP: CloudWatch
SEARCH panels become Cloud Monitoring queries on the workload.googleapis.com
metrics the collector exports (PR #29); the two CloudWatch Logs Insights panels
become Cloud Logging panels. Labels used are low-cardinality only:
service, operation, outcome, http_response_status_code.
"""
import json, pathlib

GCM = {"type": "stackdriver", "uid": "gcm"}
GCL = {"type": "googlecloud-logging-datasource", "uid": "gcl"}
SERVICES = ["shop", "inventory", "payment", "delivery"]
W = "workload.googleapis.com/"

def ts(metric, service, aligner, reducer, group_by, extra_filters=(), per_series="ALIGN_RATE"):
    filters = ["metric.type", "=", W + metric, "AND", "metric.label.service", "=", service]
    for k, v in extra_filters:
        filters += ["AND", k, "=", v]
    return {
        "refId": "A",
        "datasource": GCM,
        "queryType": "timeSeriesList",
        "timeSeriesList": {
            "projectName": "$project",
            "filters": filters,
            "groupBys": group_by,
            "crossSeriesReducer": reducer,
            "perSeriesAligner": aligner,
            "alignmentPeriod": "60s",
            "view": "FULL",
        },
    }

def panel(pid, title, target, x, y, unit="short", w=4):
    return {"id": pid, "type": "timeseries", "title": title, "datasource": GCM,
            "gridPos": {"h": 6, "w": w, "x": x, "y": y},
            "fieldConfig": {"defaults": {"unit": unit}, "overrides": []},
            "targets": [target]}

panels, pid, y = [], 1, 0
for svc in SERVICES:
    panels.append({"id": pid, "type": "row", "title": svc, "collapsed": False,
                   "gridPos": {"h": 1, "w": 24, "x": 0, "y": y}}); pid += 1; y += 1
    specs = [
        ("Request rate", ts("http.server.requests", svc, "ALIGN_RATE", "REDUCE_SUM", ["metric.label.operation"]), "reqps"),
        ("Error rate (5xx)", ts("http.server.errors", svc, "ALIGN_RATE", "REDUCE_SUM", ["metric.label.operation"]), "reqps"),
        ("p50", ts("http.server.request.duration", svc, "ALIGN_DELTA", "REDUCE_PERCENTILE_50", ["metric.label.operation"]), "ms"),
        ("p95", ts("http.server.request.duration", svc, "ALIGN_DELTA", "REDUCE_PERCENTILE_95", ["metric.label.operation"]), "ms"),
        ("p99", ts("http.server.request.duration", svc, "ALIGN_DELTA", "REDUCE_PERCENTILE_99", ["metric.label.operation"]), "ms"),
        ("Outbound calls", ts("outbound.calls", svc, "ALIGN_RATE", "REDUCE_SUM", ["metric.label.target", "metric.label.outcome"]), "reqps"),
    ]
    for i, (title, t, unit) in enumerate(specs):
        panels.append(panel(pid, f"{svc} {title}", t, i * 4, y, unit)); pid += 1
    y += 6

# New on GCP (not in the AWS board): checkout outcomes, from the same counter.
panels.append({"id": pid, "type": "row", "title": "checkout", "collapsed": False,
               "gridPos": {"h": 1, "w": 24, "x": 0, "y": y}}); pid += 1; y += 1
panels.append(panel(pid, "checkout requests by outcome",
                    ts("http.server.requests", "shop", "ALIGN_RATE", "REDUCE_SUM", ["metric.label.outcome"],
                       [("metric.label.operation", "/carts/:cartId/checkout")]), 0, y, "reqps", 12)); pid += 1
panels.append(panel(pid, "checkout requests by status",
                    ts("http.server.requests", "shop", "ALIGN_RATE", "REDUCE_SUM", ["metric.label.http_response_status_code"],
                       [("metric.label.operation", "/carts/:cartId/checkout")]), 12, y, "reqps", 12)); pid += 1
y += 6

LOG_BASE = 'resource.type="cloud_run_revision" resource.labels.service_name="otel-demo-shop"'
# AWS "all lines for a trace id" (Logs Insights) -> Cloud Logging filter on the trace field.
panels.append({
    "id": pid, "type": "logs", "title": "all lines for a trace id",
    "description": "Port of the CloudWatch saved query. Every app log line carries the Cloud Trace id in the LogEntry trace field; open it in Google Cloud Trace via Explore.",
    "datasource": GCL, "gridPos": {"h": 8, "w": 24, "x": 0, "y": y},
    "targets": [{"refId": "A", "datasource": GCL, "projectId": "$project",
                 "queryText": LOG_BASE + ' trace="projects/$project/traces/$trace_id"'}],
    "options": {"showTime": True, "enableLogDetails": True, "dedupStrategy": "none", "sortOrder": "Ascending"},
}); pid += 1; y += 8
# AWS "errors by service last 15m" (stats count() by service) -> error lines, last 15m.
# Cloud Logging cannot aggregate in-query; the logs volume histogram plus the
# service label give the per-service split.
panels.append({
    "id": pid, "type": "logs", "title": "errors by service last 15m",
    "datasource": GCL, "timeFrom": "15m", "gridPos": {"h": 8, "w": 24, "x": 0, "y": y},
    "targets": [{"refId": "A", "datasource": GCL, "projectId": "$project",
                 "queryText": LOG_BASE + " severity>=ERROR"}],
    "options": {"showTime": True, "showLabels": True, "enableLogDetails": True, "dedupStrategy": "none"},
}); pid += 1

dash = {
    "uid": "otel-demo", "title": "otel-demo", "tags": ["otel-demo", "gcp"], "timezone": "utc",
    "schemaVersion": 39, "version": 1, "refresh": "1m", "time": {"from": "now-1h", "to": "now"},
    "templating": {"list": [
        {"name": "project", "type": "constant", "hide": 2, "query": "otel-demo-gcp",
         "current": {"text": "otel-demo-gcp", "value": "otel-demo-gcp"}},
        {"name": "trace_id", "type": "textbox", "label": "trace id", "current": {"text": "", "value": ""}},
    ]},
    "panels": panels,
}
out = pathlib.Path(__file__).parent / "provisioning/dashboard-json/otel-demo.json"
out.write_text(json.dumps(dash, indent=2) + "\n")
print(f"run: npx prettier --write {out}")
print(f"wrote {out} ({len(panels)} panels)")
