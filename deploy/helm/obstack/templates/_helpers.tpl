{{/*
Common labels, applied to every resource this chart creates. Selectors are
spelled out per-Deployment/DaemonSet template instead of reusing this helper,
because a selector is immutable once a workload exists and must never pick up
a label this helper starts adding later.
*/}}
{{- define "obstack.labels" -}}
app.kubernetes.io/name: obstack
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/*
The wait-for-clickhouse init container — ONE definition included by BOTH the
migrate Job and the ingest Deployment (K1's one-definition rule, in-chart),
so the poll budget can never drift between the two. The budget
(420 × 2s = 840s) is sized off the measured cold ClickHouse pull — 7m28s and
~11m on two real machines — not a guess. Init containers gate startup only:
a pod waiting here holds in Init:0/1 with zero restarts (no CrashLoopBackOff
clock runs), and once the main container has started this has no effect at
all — a running pod that loses ClickHouse crash-loops exactly as it always
did.
*/}}
{{- define "obstack.waitForClickhouse" -}}
- name: wait-for-clickhouse
  image: {{ .Values.utilityImage }}
  command:
    - sh
    - -c
    - |
      for i in $(seq 1 420); do
        wget -q -O /dev/null http://{{ .Release.Name }}-clickhouse:8123/ping && exit 0
        echo "waiting for clickhouse ($i/420)..."
        sleep 2
      done
      echo "clickhouse did not become reachable in time" >&2
      exit 1
{{- end -}}

{{/*
D275 — the migrate Job's password-rotation helper this used to be
(`obstack.migrate.clickhousePassword`) is deleted, not fixed: it worked by
`lookup`-ing a live ClickHouse `Deployment`'s env, and that target stopped
existing the moment ClickHouse became a StatefulSet
(`templates/clickhouse/statefulset.yaml`, D253 item 2) — every upgrade since
has silently fallen through to `.Values.clickhouse.ingestPassword` regardless
of what it looked up, which is dead code wearing a live comment. The
`existingSecret` path (`templates/ingest/migrate-job.yaml`,
`templates/ingest/pg-migrate-job.yaml`) replaces the concern it existed for —
see README.md, "Credentials and rotation" — and the default chart-owned-Secret
path keeps the plain values password this always actually ran with.
*/}}

{{/*
D276 — refuses a `helm upgrade` over a pre-0.3.0 (<=0.2.0) install rather than
silently data-losing it. Those releases shipped ClickHouse/Postgres as
Deployments over hostPath; this chart's StatefulSets share their names but
are a different resource kind, so Helm patches nothing in place — measured
(README.md, "Upgrading from 0.2.0"): it deletes the old Deployment, creates
an empty-PVC StatefulSet, and reports `Upgrade complete` while both stores
come up empty. `lookup` sees the live Deployment a real upgrade runs
against and this `fail`s before Helm touches anything. `lookup` returns an
empty dict outside a live cluster — `helm template`, `helm lint`,
`helm upgrade --dry-run=client`, and a from-scratch `helm install` (which
never has an old Deployment to find) — so none of those trip this; only a
genuine upgrade over a live pre-0.3.0 release does. No adoption code: the
fix is the README's manual path, not this chart's (`helm uninstall`, remove
the old release's node-local hostPath directories, fresh install).
*/}}
{{- define "obstack.refuseLegacyDeployment" -}}
{{- $name := printf "%s-%s" .root.Release.Name .component -}}
{{- if lookup "apps/v1" "Deployment" .root.Release.Namespace $name -}}
{{- fail (printf "%s exists as a Deployment — the pre-0.3.0 (<=0.2.0) shape this chart no longer ships. There is no upgrade path across that boundary (README.md, \"Upgrading from 0.2.0\"): helm uninstall this release, remove its node-local hostPath directories, then helm install fresh." $name) -}}
{{- end -}}
{{- end -}}
