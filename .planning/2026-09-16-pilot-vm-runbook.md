# PILOT RUNBOOK — obstack chart 0.7.0 on the client's single-VM k3s cluster, from an empty VM to a developer's Claude Code reading a trace (the pilot packet's §11, executed)

meta:
- date: 2026-09-16 · chart `deploy/helm/obstack` **0.7.0** at `master` @ `d7ea9d0` (PR #41); the published images below are the ones `images.yml`'s `publish` job pushed on that merge (run 35006742764, green).
- who runs what: **the operator** (the user, at the VM and in the GitHub package settings) runs every command; this session cannot reach the VM. Each step names what to paste back if something does not match, so it can be diagnosed from here.
- governing: the pilot packet (D680–D700, as drafted); the docs page `/docs/self-hosting/helm-chart` "A real install, in order" (the same eleven steps, prose); the chart README ("Upgrading to 0.7.0", "Credentials and rotation", "Backups").
- variables, chosen once and used throughout: `OBSTACK_HOST` (e.g. `obstack.<client-domain>`), `OTLP_HOST` (e.g. `otlp.<client-domain>`), `ACME_EMAIL` (who Let's Encrypt writes to), a namespace (this runbook uses `default` — the chart's Service names in step 6 assume it; change both if you change one).
- what is deliberately NOT in this runbook: anything the packet keeps out of the chart (HA, autoscaling, backup automation), and the S7.5 on-call sprint, deferred behind this install by the user's direction.

---

## 0. Before the VM: two things only the operator can do

**0.1 — Make the three packages public (the pilot packet's call (a), as drafted).** Measured 2026-09-15: anonymous pulls of `obstack-web`, `obstack-ingest` and `obstack-clickhouse` answer 401/403, so the cluster cannot pull them as they stand. In GitHub: the repository → Packages → each package → Package settings → Danger zone → Change visibility → Public. Verify from any machine with no credentials:

```bash
curl -s "https://ghcr.io/token?scope=repository:ziadabdelsalam/obstack-web:pull" | head -c 80; echo   # a token, not "denied"
```

The alternative (a pull secret on the cluster) needs a chart value the 0.7.0 bump deliberately left out; say so if you want that path instead.

**0.2 — DNS.** Two A records to the VM's public IP: `OBSTACK_HOST` and `OTLP_HOST`. Let's Encrypt's HTTP-01 challenge needs port 80 reachable on the VM from the internet, and the product needs 443.

## 1. The VM and the cluster (D680, D681)

Floor: 4 vCPU, 8 GiB, 60 GiB disk, amd64 (the images are `linux/amd64`, single-manifest — D682), Ubuntu 22.04 or 24.04. Open inbound 80 and 443; keep 6443 (the API server) closed to the internet or firewalled to your own address.

```bash
# k3s — stable channel is v1.36.4+k3s1 today; pin it so a re-install is the same install
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="v1.36.4+k3s1" sh -
sudo install -o "$USER" -m 600 /etc/rancher/k3s/k3s.yaml ~/.kube/config
export KUBECONFIG=~/.kube/config

kubectl get storageclass          # expect: local-path (default)
kubectl get ingressclass          # expect: traefik
kubectl get nodes -o wide         # Ready, amd64
kubectl describe node | grep -A2 Allocatable   # cpu ≥ 4, memory ≥ 8Gi minus k3s's own share
```

Helm and the chart's source on the VM (the repository is public; the chart has no chart repository):

```bash
curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
git clone --depth 1 https://github.com/Ziadabdelsalam/obstack.git ~/obstack && cd ~/obstack
helm show chart deploy/helm/obstack | grep '^version'   # expect: version: 0.7.0
```

**Paste back if it differs:** the three `kubectl get` outputs and the Allocatable block.

## 2. TLS: cert-manager and one ClusterIssuer (D690, as drafted)

```bash
helm repo add jetstack https://charts.jetstack.io && helm repo update
helm search repo jetstack/cert-manager --versions | head -3      # take the newest version printed
helm install cert-manager jetstack/cert-manager --namespace cert-manager --create-namespace \
  --version <that version> --set crds.enabled=true --wait
kubectl get pods -n cert-manager                                  # three pods Running
```

```yaml
# clusterissuer.yaml — HTTP-01 through Traefik; the account key is a Secret cert-manager creates
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: <ACME_EMAIL>
    privateKeySecretRef:
      name: letsencrypt-account-key
    solvers:
      - http01:
          ingress:
            class: traefik
```

```bash
kubectl apply -f clusterissuer.yaml
kubectl get clusterissuer letsencrypt        # READY True within a minute
```

The chart never renders certificate material (`values.yaml`, `web.ingress.tls`): the two Ingresses below carry the `cert-manager.io/cluster-issuer` annotation and name the Secrets cert-manager will fill. If the client already holds a certificate, load it as those two Secrets instead and skip cert-manager (the packet's alternative (d)).

## 3. Secrets, then the values file (D685, D686, D689)

Credentials never pass through the values file. The chart's key names are fixed:

```bash
kubectl create secret generic obstack-stores \
  --from-literal=clickhouse-ingest-password="$(openssl rand -base64 24)" \
  --from-literal=clickhouse-web-password="$(openssl rand -base64 24)" \
  --from-literal=postgres-password="$(openssl rand -base64 24)"
kubectl create secret generic obstack-web \
  --from-literal=better-auth-secret="$(openssl rand -base64 32)" \
  --from-literal=explain-api-key="<the client's Anthropic API key, or omit this line for fake Explain>"
```

`pilot-values.yaml` — the image references are the merge's own, digest-pinned (the digests were read off the `publish` job's `docker push` output on 2026-09-15; a later merge publishes new ones and this file changes as a reviewed edit, never a floating tag):

```yaml
clickhouse:
  existingSecret: obstack-stores
  storage:
    size: 100Gi          # events per day × the plan's retention, with headroom; local-path = the VM's disk
postgres:
  existingSecret: obstack-stores
  storage:
    size: 20Gi
web:
  image: ghcr.io/ziadabdelsalam/obstack-web:live-sha-d7ea9d044d899fac2ad67b0ae83a5e045ed640d7@sha256:003c35d3d6505b9235ac279d57004e8d8ff0725072cdbed2fe8acc2a2ecf08ea
  pullPolicy: IfNotPresent
  existingSecret: obstack-web
  betterAuthUrl: https://<OBSTACK_HOST>       # the https origin is what upgrades the session cookie (D119)
  explainMode: anthropic                        # fake if no key was put in obstack-web
  ingress:
    enabled: true
    className: traefik
    host: <OBSTACK_HOST>
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt
    tls:
      enabled: true
      secretName: obstack-web-tls
ingest:
  image: ghcr.io/ziadabdelsalam/obstack-ingest:sha-d7ea9d044d899fac2ad67b0ae83a5e045ed640d7@sha256:bc2fb345c1a60d6005312f33fd1a5858d22287cbc75204e5d62be86ce76eeb58
  pullPolicy: IfNotPresent
  ingress:
    enabled: true                               # OTLP/HTTP for senders OUTSIDE the cluster only
    className: traefik
    host: <OTLP_HOST>
    annotations:
      cert-manager.io/cluster-issuer: letsencrypt
    tls:
      enabled: true
      secretName: obstack-otlp-tls
# demo stays on for the first proof (D688 as drafted) and goes off in step 6 with the collector's key
```

**Already measured for this exact shape on 2026-09-15** (`helm lint --strict` clean; `acceptance.ts budget -f`): 23 objects, zero Secret objects rendered, zero credential literals, CPU requests **960m** with the demo off (990m with it on) — the VM's allocatable is far above the 1000m kind budget, so the check does not need re-running unless a `resources:` block is added.

## 4. Install, and the three things to watch (D697)

```bash
helm install obstack deploy/helm/obstack -f pilot-values.yaml --timeout 900s --wait
kubectl get jobs                      # obstack-migrate-1 and obstack-pg-migrate-1: 1/1
kubectl get pods                      # everything Running; the ingest pods held in Init until the stores answered
kubectl get certificate               # two, READY True (HTTP-01 takes a minute or two after the Ingresses exist)
curl -sI "https://<OBSTACK_HOST>/login" | head -1     # HTTP/2 200
```

Cold-install budget: the ClickHouse image pull is the whole cost (7–11 minutes measured on two machines, the README's numbers); everything after it is seconds. A pod stuck `Pending` is a scheduling fact, not a timeout — `kubectl describe pod <name>` names the resource.

**Paste back if it differs:** `kubectl get pods,jobs,certificate`, and for any pod not Running, `kubectl describe pod <name> | tail -20`.

## 5. Sign up, then the plan row (D693, D694 — as drafted)

Sign up at `https://<OBSTACK_HOST>/signup`. The first account creates the workspace; Settings → General prints the **workspace id** (`ws_…`). A fresh workspace is on `free` (50,000 events/month, 7-day retention) with no billing rail on this cluster, so move it to `pro` by the one row everything reads:

```bash
kubectl exec statefulset/obstack-postgres -- psql -U obstack -d obstack -c \
  "INSERT INTO workspace_plans (workspace_id, plan_id) VALUES ('<workspace id>', 'pro')
   ON CONFLICT (workspace_id) DO UPDATE SET plan_id = 'pro', updated_at = now();"
```

Settings → Billing & usage then reads the pro quota and 30-day retention. (The product call behind this — a `self-hosted` plan row — is open and does not block the pilot.)

## 6. The two keys: issue yours, replace the seed, revoke it (D687, D688, D695 — as drafted)

1. Settings → API keys → New key, scope **ingest** (the default). Copy it once.
2. Put it in a Secret, point the collector at it, and turn the demo pod off, in one upgrade:

```bash
kubectl create secret generic obstack-collector --from-literal=collector-api-key='<the issued key>'
```

Append to `pilot-values.yaml`:

```yaml
collector:
  existingSecret: obstack-collector
demo:
  enabled: false
```

```bash
helm upgrade obstack deploy/helm/obstack -f pilot-values.yaml --timeout 300s --wait
kubectl get pods            # both collector pods re-created; no demo pod
```

3. Revoke the seeded public key (the collector and the demo pod were its only users):

```bash
kubectl exec statefulset/obstack-postgres -- psql -U obstack -d obstack -c \
  "UPDATE api_keys SET revoked_at = now() WHERE id = 'key_dev_local';"
```

Ingest caches key lookups for 30 seconds; after that, a POST with `ok_dev_local` answers 401. Prove it from the VM:

```bash
sleep 35; curl -s -o /dev/null -w "%{http_code}\n" -X POST "https://<OTLP_HOST>/v1/traces" \
  -H "Authorization: Bearer ok_dev_local" -H "content-type: application/json" -d '{}'     # 401
```

## 7. The client's application, and the exit (D698, D699)

Inside the cluster the application sends to `http://obstack-ingest.default.svc:4318` (OTLP/HTTP) with the issued key as `Authorization: Bearer …`; from outside, to `https://<OTLP_HOST>`. Two paths, both documented: an obstack SDK from source (`/docs/quickstart`), or plain OpenTelemetry (`/docs/sdks/bring-your-own-otel`). The collector needs nothing from the client's manifests: pod logs, kubelet metrics, cluster events and state arrive on their own, and `/app/infra` renders the client's namespaces.

**The exit (the M1 smoke shape, through the product):** one request through the client's service, then `/app/traces` lists it and `/app/traces/<id>` resolves it with the `api`, `agent`, `tool` and `llm` layers under one trace id, the prompt and completion on the `llm` span, a cost priced at ingest, and the collector's correlated logs beside it. Settings → Data & ingest shows the key's arrival.

**Paste back if it differs:** the trace id and which layer is missing; `kubectl logs deploy/obstack-ingest --tail=40`.

## 8. Explain (D692)

With `explainMode: anthropic` and the key in `obstack-web`, "Explain this trace" and incident RCA call the model; runs are metered per plan (200/month on pro). With `fake`, the panel says so. A wrong value fails `helm upgrade` at render with the sentence naming the two admitted values.

## 9. A developer's Claude Code over MCP (D691, D700)

Settings → API keys → New key, scope **read**. On the developer's machine:

```bash
claude mcp add --transport http obstack "https://<OBSTACK_HOST>/mcp" --header "Authorization: Bearer <read key>"
```

`/app/mcp` prints that exact line with the real origin (the chart set `OBSTACK_PUBLIC_MCP_ENDPOINT` from the Ingress host). In a Claude Code session: `tools/list` shows the fifteen tools; `get_trace` with the exit's trace id returns it. The read key can be revoked from the same tab; nothing over that door writes.

## 10. Backups, the floor (D696 — as drafted)

1. The VM's disk snapshot on the hypervisor's schedule (k3s's `local-path` volumes are directories under `/var/lib/rancher/k3s/storage`).
2. Nightly, off the node — Postgres first, it holds what people authored:

```bash
kubectl exec statefulset/obstack-postgres -- pg_dump -U obstack -Fc obstack > "obstack-$(date -u +%F).dump"
```

3. Optional, store-level ClickHouse backups: add `clickhouse: { backups: { enabled: true } }` to the values file (its own PVC through `existingClaim` if the disk should not share the data volume), `helm upgrade`, then the loop in the chart README's "Backups" section (`BACKUP DATABASE obstack TO Disk('backups', …)` + `kubectl cp`).

## 11. After 24 hours of real traffic: the first numbers a real install produces (D681, D283)

Record these and paste them back; they are the reopen-on-measurement inputs the chart's requests were waiting for:

```bash
kubectl top pods                                                      # CPU and memory per pod (k3s ships metrics-server)
kubectl exec statefulset/obstack-clickhouse -- clickhouse-client --query \
  "SELECT table, formatReadableSize(sum(bytes_on_disk)) AS size, sum(rows) AS rows FROM system.parts WHERE active AND database = 'obstack' GROUP BY table ORDER BY sum(bytes_on_disk) DESC"
df -h /var/lib/rancher/k3s/storage                                    # the PVCs' real ceiling
```

Plus, from the product: Settings → Billing & usage's events-per-day, and how far under the pro quota the client sits.

---

## Upgrades, when a new merge publishes new images

A reviewed edit of the two `image:` lines (new sha and digests from that merge's `publish` summary), then `helm upgrade obstack deploy/helm/obstack -f pilot-values.yaml --timeout 300s --wait` from a fresh `git pull`. The migrate Jobs run as pre-upgrade hooks; never run `ingest migrate` by hand beside them.

## What this session can do from here

Diagnose any pasted output against the tree; edit the values file's shape; add a chart value if the client's cluster needs one the packet ruled out (a pull secret, a namespace fence on the collector — each a small, additive 0.8.0 item); and, once the pilot is up, resume S7.5 from its packet.
