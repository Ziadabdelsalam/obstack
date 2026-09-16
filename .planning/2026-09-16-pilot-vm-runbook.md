# PILOT RUNBOOK v2 — obstack chart 0.8.0 on the client's single-VM k3s cluster, AIR-GAPPED: everything carried in, nothing leaves the network, names under `obstack.dev`

meta:
- date: 2026-09-16 · **v2 supersedes v1** (the same morning's connected-VM shape: cert-manager, HTTP-01, `git clone` and image pulls on the VM) on the user's direction: *"lets use obstack.dev and i want to be able to pull everything into the vm so that it works inside their network with 0 data leakage to the public internet"*. The rulings behind v2 are the pilot packet's addendum **D703–D706**; `deploy/airgap/README.md` is the line-by-line table of what does and does not leave the network.
- chart `deploy/helm/obstack` **0.8.0** (the air-gap posture; its PR is open on `claude/continuing-work-6qef96`, and the bundle is built at the commit that merges it) · the tooling `deploy/airgap/bundle.sh` (laptop) and `deploy/airgap/load.sh` (VM) · k3s `v1.36.4+k3s1`, helm `v3.19.0`, crane `v0.22.1` — pinned in `bundle.sh`, stated in the bundle's `bundle.env`.
- images: the two `image:` lines in step 5 pin the **0.7.0 merge's** images (`d7ea9d0`, run 35006742764, digests measured 2026-09-15/16). Chart 0.8.0 runs them unchanged — every variable it renders is one those images already read — and the 0.8.0 merge publishes new ones (its `publish` job's summary lists the digests), which replace the two lines as a reviewed edit before the bundle is built; `bundle.sh` refuses a pin the registry does not serve, so a mis-typed digest cannot pass.
- who runs what: **the operator** (the user) runs every command — the laptop side (a machine with internet: the bundle, the certificate, DNS) and the VM side (no internet). This session reaches neither; each step names what to paste back if it does not match.
- variables, chosen once: `OBSTACK_HOST` = **`pilot.obstack.dev`** and `OTLP_HOST` = **`otlp-pilot.obstack.dev`** (suggested — see step 0.2 for why the labels are neutral; rename both consistently if you prefer others), `VM_IP` (the VM's **private** IPv4 on the client's network), `ACME_EMAIL` (who Let's Encrypt writes to about expiry), namespace `default` (the Service names in steps 8–9 assume it).
- the guarantee, in one sentence (D703): the VM makes no connection to the internet because nothing on it is configured to make one, AND the client's firewall denies its egress, so an attempt would fail at the edge and be logged — two facts, neither trusted alone. The one door through which trace content leaves by design is a developer's Claude Code over MCP (step 11), on their machine, and the client decides whether it opens.
- what is deliberately NOT here: HA, autoscaling, backup automation (out of the chart by ruling), cert-manager (gone in this posture), the S7.5 on-call sprint (deferred behind this install by the user's direction).

---

## 0. Before the VM: two things only the operator can do

**0.1 — The three packages public (call (a)) — DONE 2026-09-16.** Measured anonymously: `obstack-web` `003c35d3…`, `obstack-ingest` `bc2fb345…`, `obstack-clickhouse` `d4a75d16…` fetch with HTTP 200 and their `Docker-Content-Digest` equals the pin. In this posture that is what lets the **laptop** pull them for the bundle; the VM never pulls anything (D703).

**0.2 — DNS: two A records under `obstack.dev`, answering the VM's PRIVATE address (D705).** At the registrar (Squarespace, the zone's DNS settings):

```
pilot.obstack.dev.        A   <VM_IP>       (e.g. 10.x.x.x — the address the client's network reaches the VM at)
otlp-pilot.obstack.dev.   A   <VM_IP>
```

Why this works: the client's resolver forwards to public DNS and gets back a private address that is reachable only inside their network; from the internet the same name resolves to an address nobody outside can reach. What it publishes: the two names, and the fact that a private address exists — nothing else. That is why the labels are neutral: public DNS and certificate-transparency logs (step 3's certificate is public) carry these names for good, so they say nothing about the client.

Verify from a machine **inside the client's network**: `dig +short pilot.obstack.dev` → `<VM_IP>`. If it answers nothing while `dig +short pilot.obstack.dev @8.8.8.8` does, the client's resolver drops private addresses in public answers (rebind protection) — the fix is the same two names in their internal zone, and the certificate in step 3 is unchanged (the DNS challenge is proven on the public zone from the laptop).

**Paste back:** the two `dig` outputs from inside the network.

## 1. The VM: what the client provides, and the OS made quiet (D680, D681, D703)

Floor: 4 vCPU, 8 GiB, 60 GiB disk, amd64 (the images are `linux/amd64`, single-manifest — D682), Ubuntu 22.04 or 24.04, and a clock that is right (an air-gapped VM with a wrong clock cannot validate a certificate). Network, asked of the client in these words:

- inbound **443** from their network (the product and the OTLP door), **22** from the operator's host, nothing else in;
- **outbound: deny all**, logged. If deny-all is not possible on their edge, at least log. This is the posture's second fact, not a nice-to-have.
- no proxy configured on the VM (`env | grep -i proxy` prints nothing), and a resolver the client provides (see the last line below).

Then the OS's own callers — a stock Ubuntu opens connections on its own, and while the firewall would refuse each one, off is what keeps the firewall's log meaningful:

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

## 2. On the laptop: the bundle (D704)

Needs: a checkout at the commit to install (after the 0.8.0 PR merges: `git fetch origin && git checkout master && git pull`), `helm`, `git`, `curl`, `tar`; `crane` is fetched into the bundle's own tools directory if absent. Put step 5's `pilot-values.yaml` beside the checkout first — `bundle.sh` reads it for its `image:` lines and never copies it.

```bash
cd ~/obstack && git log -1 --format='%h %s'                # the 0.8.0 merge
deploy/airgap/bundle.sh -f ~/pilot-values.yaml -o ~/obstack-airgap
```

What it prints, in order: crane; the six images the chart renders for this values file (`busybox:1.37.0`, `clickhouse/clickhouse-server:26.3.17.110`, `otel/opentelemetry-collector-k8s:0.158.0`, `postgres:17.11`, the two ghcr images by digest), each pulled as an OCI layout with its manifest digest verified against the pin; k3s and its image pack, checksums verified; helm, verified; the source tarball; `SHA256SUMS`. Measured here 2026-09-16 at `1c50c9e`: **17 files, 855 MB, exit 0** (a bundle at the 0.8.0 merge differs only in the source tarball and, once the two lines are edited, the two ghcr images).

Carry the directory to the VM however the client's network allows (`scp -r ~/obstack-airgap <vm>:~/`, a jump host, a USB drive). Carry `pilot-values.yaml` **separately** (it names your Secrets) and, after step 3, the certificate's two files (a credential).

**Paste back if it differs:** the script's output from its last `==` line.

## 3. On the laptop: the certificate, issued off the VM (D705)

One certificate for both names, from Let's Encrypt, proven by a DNS record on `obstack.dev` — the VM talks to no certificate authority, and every browser on the client's network already trusts the issuer (no CA to distribute). Install `lego` (a current 4.x: `brew install lego` on macOS, or the release tarball from `github.com/go-acme/lego/releases`), then:

```bash
lego --email "<ACME_EMAIL>" --accept-tos --dns manual -d pilot.obstack.dev -d otlp-pilot.obstack.dev run
```

`lego` prints, for each name, a TXT record `_acme-challenge.<name>` and its value, and waits. Create both at the registrar, confirm they have propagated (`dig +short TXT _acme-challenge.pilot.obstack.dev @8.8.8.8` prints the value), press Enter. The result is under `./.lego/certificates/`: `pilot.obstack.dev.crt` (the leaf followed by its chain) and `pilot.obstack.dev.key`. Delete the two TXT records afterwards if you like; they are not needed until renewal.

Renewal is a calendar item (D705): the certificate is valid 90 days; before day 60, `lego … --dns manual -d pilot.obstack.dev -d otlp-pilot.obstack.dev renew --days 30` (the same two TXT prompts), then re-apply the Secret on the VM (step 5's `kubectl create secret tls … --dry-run=client -o yaml | kubectl apply -f -`) — Traefik picks the new Secret up on its own. To rehearse without spending a rate-limit slot, add `--server https://acme-staging-v02.api.letsencrypt.org/directory`; a staging certificate is not browser-trusted.

**Paste back if it differs:** `lego`'s error line; `openssl x509 -in pilot.obstack.dev.crt -noout -subject -dates -ext subjectAltName` should print both names and ~90 days.

## 4. On the VM: load the bundle (D704)

```bash
cd ~/obstack-airgap && sudo ./load.sh
```

Four steps, and it stops at the first that fails: **1/4** every file against `SHA256SUMS`; **2/4** k3s from the bundle — a `HelmChartConfig` for Traefik is written into k3s's manifests directory FIRST (`global.checkNewVersion: false`, `sendAnonymousUsage: false` — the packaged chart `40.1.4+up40.1.0` inherits upstream's version check ON), then the upstream installer with downloads skipped, then the node Ready and `local-path` the default class; **3/4** the six images imported into containerd with their digests, re-tagged to the names the kubelet asks for, and every name and digest verified as containerd holds them; **4/4** helm, the repository at `/opt/obstack`, a kubeconfig for your user. Then:

```bash
export KUBECONFIG=~/.kube/config
kubectl get nodes -o wide                                             # Ready, amd64
kubectl get storageclass                                              # local-path (default)
kubectl get ingressclass                                              # traefik (appears within a minute of the node)
kubectl -n kube-system get helmchartconfig traefik -o jsonpath='{.spec.valuesContent}'   # checkNewVersion: false
kubectl -n kube-system get pods                                       # coredns, local-path, metrics-server, traefik Running — from k3s's own pack
helm show chart /opt/obstack/deploy/helm/obstack | grep '^version'   # version: 0.8.0
```

Re-running `load.sh` is safe: a k3s already at the bundle's version is left alone, images import beside what is there, `/opt/obstack` is replaced whole.

**Paste back if it differs:** `load.sh`'s output from the failing `==` step; for step 2, `journalctl -u k3s --no-pager | tail -40`.

## 5. On the VM: Secrets, the certificate, the values file (D685, D686, D689)

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

`pilot-values.yaml` — the SAME file the bundle was built from in step 2 (every `image:` line must be one of `images.tsv`'s `chart_ref` values; `load.sh` prints that list):

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
  image: ghcr.io/ziadabdelsalam/obstack-ingest:sha-d7ea9d044d899fac2ad67b0ae83a5e045ed640d7@sha256:bc2fb345c1a60d6005312f33fd1a5858d22287cbc75204e5d62be86ce76eeb58
  pullPolicy: IfNotPresent
  ingress:
    enabled: true                              # OTLP/HTTP for the client's services OUTSIDE the cluster (step 9)
    className: traefik
    host: otlp-pilot.obstack.dev
    tls:
      enabled: true
      secretName: obstack-tls                  # the same certificate carries both names
demo:
  enabled: false                               # from the first install (D706): the demo image is unpublished, the bundle carries only published images
```

**Measured for this exact shape on 2026-09-16** (chart 0.8.0 as it stands; `helm lint --strict` clean; `helm template`; `acceptance.ts budget -f`): **24 objects**, 6 images (all in the bundle), zero credential literals, the two Ingresses naming `obstack-tls`, the privacy config.d file mounted, and ONE Secret rendered — the chart's own `obstack-credentials`, carrying the seeded collector key until step 8 brings `obstack-collector`. CPU requests **960m** with the demo off, which fits the 1000m kind budget with 40m spare and is far under the VM's allocatable.

## 6. Install, and the proof that nothing was pulled (D697, D703)

```bash
helm install obstack /opt/obstack/deploy/helm/obstack -f pilot-values.yaml --timeout 900s --wait
kubectl get jobs                      # obstack-migrate-1 and obstack-pg-migrate-1: 1/1
kubectl get pods                      # everything Running; ingest held in Init until the stores answered
kubectl get events --field-selector reason=Pulled -o custom-columns=POD:involvedObject.name,MSG:message
                                      # every line: "Container image … already present on machine"
curl -sI --resolve pilot.obstack.dev:443:127.0.0.1 https://pilot.obstack.dev/login | head -1     # HTTP/2 200, from the VM itself
```

Then from a browser on the client's network: `https://pilot.obstack.dev/login` — the padlock is Let's Encrypt's, no warning. The cold-install cost that dominated the connected shape (the ClickHouse pull, 7–11 minutes) is gone: the stores' first start and the two migrate Jobs are the wait, minutes not tens. A pod stuck `Pending` is a scheduling fact, not a timeout — `kubectl describe pod <name>` names the resource.

**The egress meter** — the posture's fact seen from inside. An nftables counter over packets addressed outside the private ranges, on the host's own output and on what it forwards for pods; it drops nothing, it counts:

```bash
sudo nft add table inet egresswatch
sudo nft add chain inet egresswatch out '{ type filter hook output priority 0; }'
sudo nft add chain inet egresswatch fwd '{ type filter hook forward priority 0; }'
for c in out fwd; do sudo nft add rule inet egresswatch $c ip daddr != { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, 224.0.0.0/4, 255.255.255.255 } counter; done
sudo nft list table inet egresswatch                                  # read it after a day: packets 0 bytes 0 on both
```

If the client uses public address space internally, add those ranges to the set; the meter does not survive a reboot (re-add it). The client's firewall log is the authoritative record; the meter is the same fact from the VM's side.

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

Append to `pilot-values.yaml`:

```yaml
collector:
  existingSecret: obstack-collector
```

```bash
helm upgrade obstack /opt/obstack/deploy/helm/obstack -f pilot-values.yaml --timeout 300s --wait
kubectl get pods            # both collector workloads re-created; no image pulled (the Pulled events again)
```

3. Revoke the seeded public key (the collector was its only user here; the demo pod never rendered):

```bash
kubectl exec statefulset/obstack-postgres -- psql -U obstack -d obstack -c \
  "UPDATE api_keys SET revoked_at = now() WHERE id = 'key_dev_local';"
```

Ingest caches key lookups for 30 seconds; after that, a POST with `ok_dev_local` answers 401. Prove it from the VM (or from any machine on the client's network without `--resolve`):

```bash
sleep 35; curl -s -o /dev/null -w "%{http_code}\n" --resolve otlp-pilot.obstack.dev:443:127.0.0.1 -X POST "https://otlp-pilot.obstack.dev/v1/traces" \
  -H "Authorization: Bearer ok_dev_local" -H "content-type: application/json" -d '{}'     # 401
```

## 9. The client's application, and the exit (D698, D699)

From the client's other machines on their network the application sends to `https://otlp-pilot.obstack.dev` (OTLP/HTTP, the Ingress, the Let's Encrypt certificate); a service running INSIDE the cluster sends to `http://obstack-ingest.default.svc:4318`. Both with the issued key as `Authorization: Bearer …`. Two paths, both documented: an obstack SDK from source (`/docs/quickstart` — the sources are in the bundle at `/opt/obstack/packages/`, and the SDK's own dependencies come from the client's package mirror, since their build machines have no internet either), or plain OpenTelemetry (`/docs/sdks/bring-your-own-otel` — needs only what their apps already have). The collector needs nothing from the client's manifests: pod logs, kubelet metrics, cluster events and state arrive on their own for whatever runs on this cluster, and `/app/infra` renders its namespaces.

**The exit (the M1 smoke shape, through the product):** one request through the client's service, then `/app/traces` lists it and `/app/traces/<id>` resolves it with the `api`, `agent`, `tool` and `llm` layers under one trace id, the prompt and completion on the `llm` span, a cost priced at ingest, and the collector's correlated logs beside it. Settings → Data & ingest shows the key's arrival.

**Paste back if it differs:** the trace id and which layer is missing; `kubectl logs deploy/obstack-ingest --tail=40`.

## 10. Explain (D692, D706)

`explainMode: fake`: "Explain this trace" and incident RCA call no model, and the panel says so. The two ways to make it real, each a stated decision to let trace text leave the VM: (1) an internal Anthropic-compatible gateway — `web.explainBaseUrl: https://<gateway>` and `web.explainModel: <its model name>` (chart 0.8.0), plus `explain-api-key` in `obstack-web` and `explainMode: anthropic`; the text goes to the gateway, inside the network; (2) Anthropic's API directly — the same values without a base URL, and a firewall exception for `api.anthropic.com` the client would have to grant, which the posture's second fact then no longer holds for. Runs are metered per plan (200/month on pro). A wrong mode value fails `helm upgrade` at render with the sentence naming the two admitted values.

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

On the laptop, at the new commit: edit the two `image:` lines (the new sha and digests from that merge's `publish` summary), `bundle.sh` again, carry the bundle in. On the VM: `sudo ./load.sh` (k3s left alone, the new images imported beside the old, `/opt/obstack` replaced), then `helm upgrade obstack /opt/obstack/deploy/helm/obstack -f pilot-values.yaml --timeout 300s --wait`. The migrate Jobs run as pre-upgrade hooks; never run `ingest migrate` by hand beside them. Old images: `k3s ctr -n k8s.io images rm <name>`.

## What leaves the network — the short form of `deploy/airgap/README.md`

Nothing, from the VM, by construction: images, k3s, helm and the chart arrive in the bundle; DNS is answered by the client's resolver; the certificate is issued from the laptop; ClickHouse's crash reports are off (chart 0.8.0), Traefik's version check is off (`load.sh`), the web pod states `NEXT_TELEMETRY_DISABLED`, ingest's only outbound client is the notifier and it delivers only to channels the workspace's members configure; Explain is fake; billing is fake; the OS's own callers are off (step 1). What can leave, only by a decision the runbook names: Explain in `anthropic` mode (step 10), an alert channel pointed at a public receiver, and a developer's Claude Code over MCP (step 11).

## What this session can do from here

Diagnose any pasted output against the tree; edit the values file's shape; put the 0.8.0 merge's digests into step 5 when its `publish` summary is read; add a chart value if the client's cluster needs one the packet ruled out (a namespace fence on the collector, say — a small, additive 0.9.0 item); and, once the pilot is up, resume S7.5 from its packet.
