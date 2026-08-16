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
