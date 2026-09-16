# PILOT RUNBOOK v2.1 — obstack chart 0.8.0 on the client's single-VM k3s cluster: `pilot.obstack.dev` / `otlp-pilot.obstack.dev`, the install pulls, the operation is silent, nothing of the client's leaves the network

meta:
- date: 2026-09-16 · **v2.1 supersedes v2** (same day) on two facts from the user: the labels are ratified (`pilot`, `otlp-pilot`), and **the client's VM has an internet connection**. So the install path is the connected one (path A: k3s pulls the pinned images itself), and the carried-in bundle (path B, `deploy/airgap/`) stays as the proven alternative for a VM without egress. Everything that makes the running system silent is the same on both paths. The rulings behind this are the pilot packet's addendum **D703–D706** and its evening status update; `deploy/airgap/README.md` is the line-by-line table of what leaves the network.
- chart `deploy/helm/obstack` **0.8.0** at `master` @ **`6a845d2`** (PR #42, merged 2026-09-16) · k3s `v1.36.4+k3s1`, helm `v3.19.0` (the same pins path B carries).
- images: the two `image:` lines in step 5 pin the **0.8.0 merge's** images (`6a845d2`; `images` run 35142829993, its `publish` job green 19:55 UTC). Digests read anonymously from the registry 2026-09-16 20:01 UTC — the `Docker-Content-Digest` of each sha tag's manifest, single-platform `linux/amd64` as D682 requires — web `4864ee51…`, ingest `4795b105…`. A later merge publishes new ones, and the two lines change as a reviewed edit of this file, never a floating tag.
- who runs what: **the operator** (the user) runs every command on the VM, plus the DNS records at the registrar and, if preferred, the certificate on a laptop. This session reaches none of it; each step names what to paste back if it does not match.
- names, fixed: `OBSTACK_HOST` = **`pilot.obstack.dev`**, `OTLP_HOST` = **`otlp-pilot.obstack.dev`**. `VM_IP` = **`172.27.28.14`** (the VM's private IPv4 on the client's network, given 2026-09-16 — the public A records carry it by design, so writing it here adds nothing to what DNS publishes). Still the operator's: `ACME_EMAIL` (who Let's Encrypt writes to about expiry). Namespace `default` (the Service names in steps 8–9 assume it). `CHART` = `~/obstack/deploy/helm/obstack` on path A, `/opt/obstack/deploy/helm/obstack` on path B.
- the guarantee, in one sentence (D703, restated for a connected VM): the VM's outbound traffic is an allow-list the client enforces and logs — registries and downloads for the install, the client's NTP, Let's Encrypt for the certificate — and nothing on the VM is configured to send anything else, so no product data, no telemetry and no crash report leaves; the software side is measured (chart 0.8.0, the Traefik config, the OS made quiet), the firewall side is the client's. The one door through which trace content leaves by design is a developer's Claude Code over MCP (step 11), on their machine, and the client decides whether it opens.
- what is deliberately NOT here: HA, autoscaling, backup automation (out of the chart by ruling), cert-manager (gone: DNS-01 from a laptop or the VM is simpler and needs no inbound port 80), the S7.5 on-call sprint (deferred behind this install by the user's direction).

---

## 0. Before the VM: two things only the operator can do

**0.1 — The three packages public (call (a)) — DONE 2026-09-16.** Measured anonymously: `obstack-web`, `obstack-ingest` and `obstack-clickhouse` fetch with HTTP 200 and their `Docker-Content-Digest` equals the pin. On path A that is what lets the VM's k3s pull them with no credentials; on path B, the laptop.

**0.2 — DNS: two A records under `obstack.dev`, answering the VM's PRIVATE address (D705).** At the registrar (Squarespace, the zone's DNS settings):

```
pilot.obstack.dev.        A   172.27.28.14
otlp-pilot.obstack.dev.   A   172.27.28.14
```

In Squarespace's DNS panel the **Host** field takes the label only — `pilot` and `otlp-pilot` — and the panel appends `obstack.dev` itself; typed in full, the record lands at `pilot.obstack.dev.obstack.dev` (measured 2026-09-16 20:47 UTC: both records answered 172.27.28.14 at the doubled names and NXDOMAIN at the real ones, until re-entered at 22:0x UTC). The NAME column displays the full name either way, so the table does not show the difference; a public resolver does.

Why this works: the client's resolver forwards to public DNS and gets back a private address that is reachable only inside their network; from the internet the same name resolves to an address nobody outside can reach. What it publishes: the two names, and the fact that a private address exists — nothing else, which is why the labels are neutral (public DNS and certificate-transparency logs carry them for good). **DONE 2026-09-16, measured from outside at 22:08 UTC:** both names answer `172.27.28.14` on Google, Cloudflare and NextDNS (TTL 14400), and the doubled names are gone. What remains for DNS is the in-network `dig` below, the rebind-protection check.

Verify from a machine **inside the client's network**: `dig +short pilot.obstack.dev` → `172.27.28.14`. If it answers nothing while `dig +short pilot.obstack.dev @8.8.8.8` does, the client's resolver drops private addresses in public answers (rebind protection) — the fix is the same two names in their internal zone, and the certificate in step 3 is unchanged (the DNS challenge is proven on the public zone).

**Paste back:** the two `dig` outputs from inside the network — or just say the records are in, and this session checks them from outside.

## 1. The VM: what the client provides, and the OS made quiet (D680, D681, D703)

Floor: 4 vCPU, 8 GiB, 60 GiB disk, amd64 (the images are `linux/amd64`, single-manifest — D682), Ubuntu 22.04 or 24.04, and a clock that is right (a wrong clock cannot validate a certificate). Network, asked of the client in these words:

- inbound **443** from their network (the product and the OTLP door), **22** from the operator's host, nothing else in;
- outbound: an **allow-list, logged** — the install's sources (`ghcr.io`, `pkg-containers.githubusercontent.com`; `registry-1.docker.io`, `auth.docker.io`, `production.cloudflare.docker.com`; `get.k3s.io`, `github.com`, `objects.githubusercontent.com`; `get.helm.sh`), Let's Encrypt (`acme-v02.api.letsencrypt.org`) if the certificate is issued from the VM (step 3), the client's NTP server, and DNS through the client's resolver; **everything else denied and logged**. If an allow-list is not possible on their edge, at least log egress: the meter in step 6 then says what the VM did with its access.
- no proxy configured on the VM (`env | grep -i proxy` prints nothing) unless the client's egress goes through one — then k3s needs it too (`/etc/default/k3s` with `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY=10.0.0.0/8,127.0.0.0/8,172.27.28.14`), stated here so it is not discovered at the first pull.

Then the OS's own callers — a stock Ubuntu opens connections on its own, and while the allow-list would refuse each one, off is what keeps the firewall's log meaningful:

```bash
# time: the client's NTP server, never the public pool (or, if the hypervisor syncs the guest clock, `sudo timedatectl set-ntp false`)
sudo sed -i 's/^#\?NTP=.*/NTP=<the client NTP server>/' /etc/systemd/timesyncd.conf && sudo systemctl restart systemd-timesyncd
timedatectl                                   # "System clock synchronized: yes", the time correct

# the archive, the news, the store, the Pro client
sudo systemctl disable --now apt-daily.timer apt-daily-upgrade.timer     # or point /etc/apt/sources.list at the client's mirror
sudo sed -i 's/^ENABLED=.*/ENABLED=0/' /etc/default/motd-news
sudo systemctl disable --now snapd.socket snapd.service 2>/dev/null; sudo systemctl mask snapd 2>/dev/null
sudo systemctl disable --now ua-timer.timer 2>/dev/null                  # Ubuntu Pro's poll, if the package is present

# DNS fallback: resolved falls back to Cloudflare/Google when the network hands it no resolver — blank that
sudo sed -i 's/^#\?FallbackDNS=.*/FallbackDNS=/' /etc/systemd/resolved.conf && sudo systemctl restart systemd-resolved
resolvectl status | grep -A3 'Current DNS'   # the client's resolver, nothing public
```

**Paste back if it differs:** `timedatectl`, `resolvectl status`, and `nproc; free -g; df -h /` from the VM.

## 2. The cluster — path A: the connected install (this runbook's default)

Two paths, one system. **Path A** (below): the VM pulls what it needs, once, through the allow-list. **Path B** (`deploy/airgap/README.md`): `bundle.sh` on a laptop, one directory carried in, `sudo ./load.sh` on the VM — for a VM with no route out, or a client who would rather copy 1 GB than open a firewall; it lands you at step 3 with `CHART=/opt/obstack/deploy/helm/obstack` and Traefik's version check already off. Both are proven: A is 0.7.0's runbook shape, B's tooling ran end to end here (17 files, 855 MB, exit 0) and its images are the same six.

**A.1 — Traefik's version check off BEFORE k3s starts** (D703). k3s's packaged Traefik chart (`40.1.4+up40.1.0`, Traefik 3.7.8) inherits upstream's `global.checkNewVersion: true` — a request to the vendor at start and on a schedule. k3s applies every file in its manifests directory when it starts, and a `HelmChartConfig` merges into the packaged chart's values, so the file goes in first:

```bash
sudo install -d -m 755 /var/lib/rancher/k3s/server/manifests
sudo tee /var/lib/rancher/k3s/server/manifests/traefik-config.yaml >/dev/null <<'YAML'
apiVersion: helm.cattle.io/v1
kind: HelmChartConfig
metadata:
  name: traefik
  namespace: kube-system
spec:
  valuesContent: |-
    global:
      checkNewVersion: false
      sendAnonymousUsage: false
YAML
```

**A.2 — k3s, pinned; helm, pinned and checksummed; the repository at the merge:**

```bash
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="v1.36.4+k3s1" sh -      # the installer verifies the binary's sha256 itself
mkdir -p ~/.kube && sudo install -o "$USER" -g "$USER" -m 600 /etc/rancher/k3s/k3s.yaml ~/.kube/config
export KUBECONFIG=~/.kube/config                                       # put this line in ~/.bashrc too

curl -fsSLO https://get.helm.sh/helm-v3.19.0-linux-amd64.tar.gz && curl -fsSL https://get.helm.sh/helm-v3.19.0-linux-amd64.tar.gz.sha256sum | sha256sum -c -
tar -xzf helm-v3.19.0-linux-amd64.tar.gz linux-amd64/helm && sudo install -m 755 linux-amd64/helm /usr/local/bin/helm && rm -rf linux-amd64 helm-v3.19.0-linux-amd64.tar.gz

git clone https://github.com/Ziadabdelsalam/obstack.git ~/obstack && cd ~/obstack && git checkout 6a845d2
export CHART=~/obstack/deploy/helm/obstack
helm show chart "$CHART" | grep '^version'                             # version: 0.8.0
```

**A.3 — the cluster, checked:**

```bash
kubectl get nodes -o wide                                             # Ready, amd64
kubectl get storageclass                                              # local-path (default)
kubectl get ingressclass                                              # traefik (appears within a minute of the node)
kubectl -n kube-system get helmchartconfig traefik -o jsonpath='{.spec.valuesContent}'   # checkNewVersion: false
kubectl -n kube-system get pods                                       # coredns, local-path, metrics-server, traefik Running
kubectl describe node | grep -A2 Allocatable                          # cpu ≥ 4, memory ≥ 8Gi minus k3s's own share
```

**Paste back if it differs:** the `kubectl get` outputs, the Allocatable block; for k3s, `journalctl -u k3s --no-pager | tail -40`.

## 3. The certificate: Let's Encrypt by a DNS challenge, from the VM or a laptop (D705)

One certificate for both names, proven by a TXT record on `obstack.dev` — no inbound port 80, no cert-manager, and every browser on the client's network already trusts the issuer. `lego` runs wherever is convenient: on the VM (it has the allow-list's Let's Encrypt entry, and the files land where the Secret is made) or on a laptop (then carry the two files). Install a current 4.x release (`brew install lego`, or the tarball from `github.com/go-acme/lego/releases`), then:

```bash
lego --email "<ACME_EMAIL>" --accept-tos --dns manual -d pilot.obstack.dev -d otlp-pilot.obstack.dev run
```

`lego` prints, for each name, a TXT record `_acme-challenge.<name>` and its value, and waits. Create both at the registrar, confirm they have propagated (`dig +short TXT _acme-challenge.pilot.obstack.dev @8.8.8.8` prints the value), press Enter. Before issuing, `lego` checks the records itself by asking the zone's nameservers directly (UDP 53 to the internet); on a VM whose egress is an allow-list that check can hang at "Checking DNS record propagation" — then run `lego` on a laptop with ordinary internet instead, which is the simplest place for it anyway. The result is under `./.lego/certificates/`: `pilot.obstack.dev.crt` (the leaf followed by its chain) and `pilot.obstack.dev.key`. The TXT records can be deleted afterwards; renewal asks for new ones.

Renewal is a calendar item: the certificate is valid 90 days; before day 60, `lego … --dns manual -d pilot.obstack.dev -d otlp-pilot.obstack.dev renew --days 30` (the same two TXT prompts), then re-apply the Secret (`kubectl create secret tls obstack-tls --cert=… --key=… --dry-run=client -o yaml | kubectl apply -f -`) — Traefik picks it up on its own. To rehearse without spending a rate-limit slot, add `--server https://acme-staging-v02.api.letsencrypt.org/directory`; a staging certificate is not browser-trusted.

**Paste back if it differs:** `lego`'s error line; `openssl x509 -in pilot.obstack.dev.crt -noout -subject -dates -ext subjectAltName` should print both names and ~90 days.

## 4. Path B only: load the bundle (D704)

Skipped on path A. On path B: `cd ~/obstack-airgap && sudo ./load.sh` — verifies `SHA256SUMS`, writes the Traefik `HelmChartConfig` (A.1's file, byte for byte) before k3s's first start, installs k3s from the bundle, imports the six images into containerd with their digests and verifies them, installs helm, unpacks the repository at `/opt/obstack`, and leaves a kubeconfig for your user. Then A.3's checks, plus `kubectl get events --field-selector reason=Pulled` after step 6 printing only "already present on machine". Re-running is safe. **Paste back if it differs:** the failing `==` step's output.

## 5. Secrets, the certificate, the values file (D685, D686, D689)

Credentials never pass through the values file. The chart's key names are fixed:

```bash
kubectl create secret generic obstack-stores \
  --from-literal=clickhouse-ingest-password="$(openssl rand -base64 24)" \
  --from-literal=clickhouse-web-password="$(openssl rand -base64 24)" \
  --from-literal=postgres-password="$(openssl rand -base64 24)"
kubectl create secret generic obstack-web \
  --from-literal=better-auth-secret="$(openssl rand -base64 32)"        # no explain-api-key: Explain is fake (step 10)
kubectl create secret tls obstack-tls --cert=pilot.obstack.dev.crt --key=pilot.obstack.dev.key
```

`~/pilot-values.yaml` (on path B, the same file `bundle.sh` was pointed at — every `image:` line must be one of `images.tsv`'s `chart_ref` values):

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
  image: ghcr.io/ziadabdelsalam/obstack-web:live-sha-6a845d2063410a9961bd8c20292b7909ba2869ce@sha256:4864ee5187d80b314a17f3b741fa16a44c6dbde6032b7986a70f85d970277cf3
  pullPolicy: IfNotPresent
  existingSecret: obstack-web
  betterAuthUrl: https://pilot.obstack.dev     # the https origin is what upgrades the session cookie (D119)
  explainMode: fake                            # step 10: nothing leaves for a model
  ingress:
    enabled: true
    className: traefik
    host: pilot.obstack.dev
    tls:
      enabled: true
      secretName: obstack-tls
ingest:
  image: ghcr.io/ziadabdelsalam/obstack-ingest:sha-6a845d2063410a9961bd8c20292b7909ba2869ce@sha256:4795b105fc292fcc27006a92ac892b19e24a6dc500ff818fa77e7f478233ac35
  pullPolicy: IfNotPresent
  ingress:
    enabled: true                              # OTLP/HTTP for the client's services OUTSIDE the cluster (step 9)
    className: traefik
    host: otlp-pilot.obstack.dev
    tls:
      enabled: true
      secretName: obstack-tls                  # the same certificate carries both names
demo:
  enabled: false                               # from the first install (D706): the demo image is unpublished; the proof comes from the client's own service
```

**Measured for this exact shape on 2026-09-16** (chart 0.8.0; `helm lint --strict` clean; `helm template`; `acceptance.ts budget -f`): **24 objects**, 6 images, zero credential literals, the two Ingresses naming `obstack-tls`, the privacy config.d file mounted, and ONE Secret rendered — the chart's own `obstack-credentials`, carrying the seeded collector key until step 8 brings `obstack-collector`. CPU requests **960m** with the demo off: fits the 1000m kind budget with 40m spare, far under the VM's allocatable.

## 6. Install, and what the VM did with its access (D697, D703)

Path A first pulls the six images explicitly, so a slow link or a missing allow-list host shows up here, by name, and never inside `helm install --wait`'s deadline:

```bash
for image in $(helm template obstack "$CHART" -f ~/pilot-values.yaml | sed -n 's/^ *image: *//p' | tr -d '"' | sort -u); do
  sudo k3s crictl pull "$image"       # the same six the chart renders; the two ghcr ones by digest
done
```

Then, on either path:

```bash
helm install obstack "$CHART" -f ~/pilot-values.yaml --timeout 900s --wait
kubectl get jobs                      # obstack-migrate-1 and obstack-pg-migrate-1: 1/1
kubectl get pods                      # everything Running; ingest held in Init until the stores answered
kubectl get events --field-selector reason=Pulled -o custom-columns=POD:involvedObject.name,MSG:message
                                      # every line "already present on machine": path A pre-pulled, path B imported
curl -sI --resolve pilot.obstack.dev:443:172.27.28.14 https://pilot.obstack.dev/login | head -1      # HTTP/2 200, from the VM itself, no DNS needed
```

Then from a browser on the client's network: `https://pilot.obstack.dev/login` — the padlock is Let's Encrypt's, no warning. With the images already on the node the install is the stores' first start and the two migrate Jobs — minutes, not the 7–11-minute ClickHouse pull the chart README measured for an install that pulls as it goes. A pod stuck `Pending` is a scheduling fact, not a timeout — `kubectl describe pod <name>` names the resource. A `crictl pull` that fails on path A is the allow-list missing a host, and its error names the host.

**The egress meter** — what the VM sends outside the private ranges, seen from inside. An nftables counter on the host's own output and on what it forwards for pods; it drops nothing, it counts. Add it AFTER the install (the install's pulls are expected and the firewall log has them); from then on the expected reading is `packets 0 bytes 0` on both, and a non-zero one is a fact to explain:

```bash
sudo nft add table inet egresswatch
sudo nft add chain inet egresswatch out '{ type filter hook output priority 0; }'
sudo nft add chain inet egresswatch fwd '{ type filter hook forward priority 0; }'
for c in out fwd; do sudo nft add rule inet egresswatch $c ip daddr != { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, 224.0.0.0/4, 255.255.255.255 } counter; done
sudo nft list table inet egresswatch                                  # read it after a day: packets 0 bytes 0 on both
```

Expected non-zero readings, and only these: an upgrade's pulls (the "Upgrades" section), and a renewal or `lego` run from the VM (step 3). If the client uses public address space internally, add those ranges to the set; the meter does not survive a reboot (re-add it). The client's firewall log is the authoritative record; the meter is the same fact from the VM's side.

**Paste back if it differs:** `kubectl get pods,jobs`, the `Pulled` events, and for any pod not Running `kubectl describe pod <name> | tail -20`; after a day, the two counters.

## 7. Sign up, then the plan row (D693, D694 — as drafted)

Sign up at `https://pilot.obstack.dev/signup`. The first account creates the workspace; Settings → General prints the **workspace id** (`ws_…`). A fresh workspace is on `free` (50,000 events/month, 7-day retention) with no billing rail on this cluster, so move it to `pro` by the one row everything reads:

```bash
kubectl exec statefulset/obstack-postgres -- psql -U obstack -d obstack -c \
  "INSERT INTO workspace_plans (workspace_id, plan_id) VALUES ('<workspace id>', 'pro')
   ON CONFLICT (workspace_id) DO UPDATE SET plan_id = 'pro', updated_at = now();"
```

Settings → Billing & usage then reads the pro quota and 30-day retention. (The product call behind this — a `self-hosted` plan row — is call (b), open, and does not block the pilot.)

## 8. The two keys: issue yours, replace the seed, revoke it (D687, D688, D695 — as drafted)

1. Settings → API keys → New key, scope **ingest** (the default). Copy it once.
2. Put it in a Secret and point the collector at it, in one upgrade:

```bash
kubectl create secret generic obstack-collector --from-literal=collector-api-key='<the issued key>'
```

Append to `~/pilot-values.yaml`:

```yaml
collector:
  existingSecret: obstack-collector
```

```bash
helm upgrade obstack "$CHART" -f ~/pilot-values.yaml --timeout 300s --wait
kubectl get pods            # both collector workloads re-created; nothing pulled (the Pulled events again)
```

3. Revoke the seeded public key (the collector was its only user here; the demo pod never rendered):

```bash
kubectl exec statefulset/obstack-postgres -- psql -U obstack -d obstack -c \
  "UPDATE api_keys SET revoked_at = now() WHERE id = 'key_dev_local';"
```

Ingest caches key lookups for 30 seconds; after that, a POST with `ok_dev_local` answers 401. Prove it from the VM (or from any machine on the client's network, without `--resolve`):

```bash
sleep 35; curl -s -o /dev/null -w "%{http_code}\n" --resolve otlp-pilot.obstack.dev:443:172.27.28.14 -X POST "https://otlp-pilot.obstack.dev/v1/traces" \
  -H "Authorization: Bearer ok_dev_local" -H "content-type: application/json" -d '{}'     # 401
```

## 9. The client's application, and the exit (D698, D699)

From the client's other machines on their network the application sends to `https://otlp-pilot.obstack.dev` (OTLP/HTTP, the Ingress, the Let's Encrypt certificate); a service running INSIDE the cluster sends to `http://obstack-ingest.default.svc:4318`. Both with the issued key as `Authorization: Bearer …`. Two paths, both documented: an obstack SDK from source (`/docs/quickstart` — the sources are in the checkout under `packages/`; the SDK's own dependencies come from wherever the client's build machines get packages), or plain OpenTelemetry (`/docs/sdks/bring-your-own-otel` — needs only what their apps already have). The collector needs nothing from the client's manifests: pod logs, kubelet metrics, cluster events and state arrive on their own for whatever runs on this cluster, and `/app/infra` renders its namespaces.

**The exit (the M1 smoke shape, through the product):** one request through the client's service, then `/app/traces` lists it and `/app/traces/<id>` resolves it with the `api`, `agent`, `tool` and `llm` layers under one trace id, the prompt and completion on the `llm` span, a cost priced at ingest, and the collector's correlated logs beside it. Settings → Data & ingest shows the key's arrival.

**Paste back if it differs:** the trace id and which layer is missing; `kubectl logs deploy/obstack-ingest --tail=40`.

## 10. Explain (D692, D706)

`explainMode: fake`: "Explain this trace" and incident RCA call no model, and the panel says so. The two ways to make it real, each a stated decision to let trace text leave the VM: (1) an internal Anthropic-compatible gateway — `web.explainBaseUrl: https://<gateway>` and `web.explainModel: <its model name>` (chart 0.8.0), plus `explain-api-key` in `obstack-web` and `explainMode: anthropic`; the text goes to the gateway, inside the network; (2) Anthropic's API directly — the same values without a base URL, and `api.anthropic.com` added to the client's allow-list, which is trace text leaving the network by their decision. Runs are metered per plan (200/month on pro). A wrong mode value fails `helm upgrade` at render with the sentence naming the two admitted values.

## 11. A developer's Claude Code over MCP (D691, D700, D706)

Settings → API keys → New key, scope **read**. On a developer's machine **on the client's network**:

```bash
claude mcp add --transport http obstack "https://pilot.obstack.dev/mcp" --header "Authorization: Bearer <read key>"
```

`/app/mcp` prints that exact line with the real origin (the chart set `OBSTACK_PUBLIC_MCP_ENDPOINT` from the Ingress host — measured on this values file: `https://pilot.obstack.dev/mcp`). In a Claude Code session: `tools/list` shows the fifteen tools; `get_trace` with the exit's trace id returns it. Nothing over that door writes, and the read key can be revoked from the same tab.

**Said plainly:** this is the one place trace content leaves by design. Claude Code sends what the tool returns to the model, from the developer's machine — never from the VM, whose posture is unchanged. Whether that door opens is the client's decision; until they take it, no read key is issued.

## 12. Backups, the floor (D696 — as drafted)

1. The VM's disk snapshot on the hypervisor's schedule (k3s's `local-path` volumes are directories under `/var/lib/rancher/k3s/storage`).
2. Nightly, off the node to a target INSIDE the network — Postgres first, it holds what people authored:

```bash
kubectl exec statefulset/obstack-postgres -- pg_dump -U obstack -Fc obstack > "obstack-$(date -u +%F).dump"
```

3. Optional, store-level ClickHouse backups: add `clickhouse: { backups: { enabled: true } }` to the values file (its own PVC through `existingClaim` if the disk should not share the data volume), `helm upgrade`, then the loop in the chart README's "Backups" section (`BACKUP DATABASE obstack TO Disk('backups', …)` + `kubectl cp`).

## 13. After 24 hours of real traffic: the first numbers a real install produces (D681, D283)

Record these and paste them back; they are the reopen-on-measurement inputs the chart's requests were waiting for:

```bash
kubectl top pods                                                      # CPU and memory per pod (k3s ships metrics-server)
kubectl exec statefulset/obstack-clickhouse -- clickhouse-client --query \
  "SELECT table, formatReadableSize(sum(bytes_on_disk)) AS size, sum(rows) AS rows FROM system.parts WHERE active AND database = 'obstack' GROUP BY table ORDER BY sum(bytes_on_disk) DESC"
df -h /var/lib/rancher/k3s/storage                                    # the PVCs' real ceiling
sudo nft list table inet egresswatch                                  # step 6's meter: packets 0 bytes 0
```

Plus, from the product: Settings → Billing & usage's events-per-day, and how far under the pro quota the client sits.

---

## Upgrades, when a new merge publishes new images

Path A: `cd ~/obstack && git fetch && git checkout <the new merge>`, a reviewed edit of the two `image:` lines (the new sha and digests from that merge's `publish` summary), then `helm upgrade obstack "$CHART" -f ~/pilot-values.yaml --timeout 300s --wait` — k3s pulls the two new images through the allow-list (the meter counts them; expected). Path B: `bundle.sh` at the new commit on the laptop, carry, `sudo ./load.sh` (k3s left alone, the new images imported beside the old, `/opt/obstack` replaced), the same edit, the same `helm upgrade`. Either way the migrate Jobs run as pre-upgrade hooks; never run `ingest migrate` by hand beside them.

## What leaves the network — the short form of `deploy/airgap/README.md`

During an install or upgrade on path A: image pulls and downloads, to the allow-listed hosts, and nothing else. In operation: nothing, by construction — ClickHouse's crash reports are off (chart 0.8.0), Traefik's version check is off (A.1 / `load.sh`), the web pod states `NEXT_TELEMETRY_DISABLED`, ingest's only outbound client is the notifier and it delivers only to channels the workspace's members configure, Explain is fake, billing is fake, the OS's own callers are off (step 1), time comes from the client's NTP. What can leave, only by a decision the runbook names: Explain in `anthropic` mode (step 10), an alert channel pointed at a public receiver, a developer's Claude Code over MCP (step 11), and a certificate renewal's ACME exchange if `lego` runs on the VM (step 3).

## What this session can do from here

Check the DNS records from outside once they exist; diagnose any pasted output against the tree; edit the values file's shape; add a chart value if the client's cluster needs one the packet ruled out (a namespace fence on the collector, say — a small, additive 0.9.0 item); and, once the pilot is up, resume S7.5 from its packet.
