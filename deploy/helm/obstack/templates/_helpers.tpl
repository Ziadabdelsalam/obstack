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
The migrate Job's ClickHouse ingest password — NOT simply
.Values.clickhouse.ingestPassword, and this is load-bearing, not decoration
(found by testing a password rotation, not by inspecting the templates):
on an upgrade the migrate Job is a pre-upgrade hook, so it runs and needs to
authenticate *before* Helm applies this revision's main resources —
including the ClickHouse Deployment's own env, which is where a rotated
password actually takes effect. A migrate DSN built from the NEW value
during a password-rotating upgrade would try to authenticate against a
ClickHouse still running the OLD one and fail every attempt, permanently
(retrying the same wrong password is not a transient race the way a cold
ClickHouse pull is). On install there is no "currently running" ClickHouse
to diverge from — it is being created with this exact value in the same
batch — so the values password is simply correct there.

On upgrade, `lookup` reads the ClickHouse Deployment as the cluster
currently has it — the password this revision's changes have not applied
yet — and that is deliberately what the migrate Job authenticates with. By
the time the *next* operation needs the new password (ingest's own DSN,
applied as a main resource in the same batch as ClickHouse's own env
change), both move together. `lookup` returns an empty dict outside a live
cluster (`helm template`, `helm lint`, and `helm upgrade --dry-run=client`),
so this still renders without one; it falls back to the values password,
same as install. A client-side dry run therefore previews the NEW password
in this DSN while the real upgrade will use the live one — `--dry-run=server`
is the rendering that shows what actually runs. The same empty-dict fallback
happens if the ClickHouse Deployment is missing entirely, and it is harmless
for the same reason it is unreachable: with no Deployment there is no
ClickHouse to authenticate against either, so the Job's
`wait-for-clickhouse` init container fails the hook loudly instead of
migrating with the wrong password.
*/}}
{{- define "obstack.migrate.clickhousePassword" -}}
{{- $password := .Values.clickhouse.ingestPassword -}}
{{- if not .Release.IsInstall -}}
{{- $deployment := lookup "apps/v1" "Deployment" .Release.Namespace (printf "%s-clickhouse" .Release.Name) -}}
{{- if $deployment -}}
{{- range $deployment.spec.template.spec.containers -}}
{{- range .env -}}
{{- if eq .name "OBSTACK_CLICKHOUSE_INGEST_PASSWORD" -}}
{{- $password = .value -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $password -}}
{{- end -}}
