{{/*
The wait-for-postgres init container — ONE definition included by BOTH the
pg-migrate Job and the ingest Deployment, exactly as obstack.waitForClickhouse
(templates/_helpers.tpl) is, and for the same K1 reason: two pods waiting on the
same database must not drift apart in how long they are willing to wait. It
lives beside the Postgres workload it polls rather than in the chart's shared
helpers file; Helm's defines are chart-global, so the include site does not care
which file it came from.

The probe is the postgres image's own pg_isready over TCP, not busybox and an
HTTP GET: Postgres speaks a binary protocol, and a bare TCP connect would pass
against the temporary socket-only server the image's entrypoint runs during
initdb. Budget and cadence are the ClickHouse helper's, unchanged (420 x 2s =
840s), because the case they are sized for is the same one — a node that has
never pulled these images. Init containers gate startup only: a pod waiting here
holds in Init with zero restarts, and once the main container has started this
has no effect at all.
*/}}
{{- define "obstack.waitForPostgres" -}}
- name: wait-for-postgres
  image: {{ .Values.postgres.image }}
  command:
    - sh
    - -c
    - |
      for i in $(seq 1 420); do
        pg_isready -h {{ .Release.Name }}-postgres -p 5432 -U obstack -d obstack && exit 0
        echo "waiting for postgres ($i/420)..."
        sleep 2
      done
      echo "postgres did not become reachable in time" >&2
      exit 1
{{- end -}}
