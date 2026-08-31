# obstack ClickHouse image for Railway (S5 T3 / D334).
#
# Railway mounts no repository files, so the two-user grant file that
# deploy/compose/docker-compose.yml bind-mounts at runtime
# (./clickhouse/users.d/obstack-users.xml -> /etc/clickhouse-server/users.d/)
# must be baked into the image instead. That XML stays a single source —
# this Dockerfile COPYs it from its compose path rather than duplicating it.
#
# Build from the REPO ROOT so the COPY path below resolves:
#   docker build -t obstack-clickhouse -f deploy/railway/clickhouse/Dockerfile .
#
# The grant file (deploy/compose/clickhouse/users.d/obstack-users.xml) reads
# both user passwords via from_env (OBSTACK_CLICKHOUSE_INGEST_PASSWORD,
# OBSTACK_CLICKHOUSE_WEB_PASSWORD) — no further wiring is needed in this
# image beyond setting those two env vars on the Railway service.
#
# D350: that same file also pins the base image's built-in `default` user to
# loopback (`<default><networks replace="replace">`), because Railway's
# private network is shared across every service in the project and the
# base image only applies its own loopback restriction to `default` when
# neither CLICKHOUSE_USER nor CLICKHOUSE_PASSWORD is set on the container —
# setting either turns `default` into a network-reachable superuser. Do NOT
# set CLICKHOUSE_USER or CLICKHOUSE_PASSWORD on this service; the XML's
# `replace="replace"` network restriction on `default` holds regardless.
#
# Railway operational notes (compose's equivalents don't carry over 1:1):
#   - PORT=8123: Railway's healthcheck probes this port; 8123 is ClickHouse's
#     HTTP interface (see EXPOSE below), so set PORT=8123 on the service.
#   - /var/lib/clickhouse is the data directory — mount Railway's volume there.
#   - compose sets ulimit nofile 262144 for this service; Railway's own
#     nofile ceiling is unverified here and must be observed on staging.
#
# D358: this image also bakes in config.d/obstack-logs.xml, which removes
# ClickHouse's unbounded system.*_log tables (metric_log,
# asynchronous_metric_log, trace_log, part_log, query_thread_log, text_log)
# and gives query_log a 7-day TTL — Railway's volumes are small (trial
# 500 MB, Hobby 5 GB) and those tables carry no TTL by default.
#
# The only delta from the pinned upstream image is the two COPYs below —
# base image user/entrypoint are untouched.
FROM clickhouse/clickhouse-server:26.3.17.110

COPY deploy/compose/clickhouse/users.d/obstack-users.xml /etc/clickhouse-server/users.d/obstack-users.xml
COPY deploy/railway/clickhouse/config.d/obstack-logs.xml /etc/clickhouse-server/config.d/obstack-logs.xml

EXPOSE 8123 9000
