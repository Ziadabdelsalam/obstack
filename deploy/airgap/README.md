# Air-gapped install — everything the VM needs, carried in; nothing leaves the network

For a cluster that must run **inside a client's network with no data leaving it**: the images, k3s, helm and the chart are pulled ONCE on a machine that has internet, verified, and carried to the VM as one directory. The VM never talks to a registry, a package index or a certificate authority. This directory holds the two scripts and this note; the pilot runbook (`.planning/2026-09-16-pilot-vm-runbook.md`) is the step-by-step that uses them.

## The flow

```
laptop (internet)                              VM (client network, no internet)
  deploy/airgap/bundle.sh -f pilot-values.yaml    sudo ./load.sh
    → obstack-airgap-<sha>/  (~1 GB)   ──copy──→   1. SHA256SUMS verified
       images/*.tar  k3s/  helm/                   2. k3s from the bundle, Traefik's version check off, node Ready
       obstack-src-<sha>.tar.gz                    3. every image imported into containerd, digests verified
       images.tsv  SHA256SUMS  load.sh             4. helm + the repository at /opt/obstack
                                                 then the runbook (Secrets, the certificate, values, helm install)
```

`bundle.sh` reads your values file for its `image:` references only — the same line `acceptance.sh` uses to side-load kind — and never copies it: the values file names your Secrets and travels separately. The bundle is inert data.

## What leaves the network, stated line by line

| Flow | In this posture |
|---|---|
| Image pulls | None at runtime. Every image is imported by `load.sh`; the chart's app containers are `pullPolicy: IfNotPresent` and the pinned upstream tags default to it. A pod that tries to pull anyway is a values file naming an image the bundle does not carry — `load.sh` prints the carried list. |
| k3s, helm, the chart, the SDK sources | In the bundle. k3s's own images (Traefik, CoreDNS, local-path, metrics-server) come from its air-gap pack. |
| DNS for the product's names | Resolved by the client's resolver. A public record whose value is the VM's private address works wherever the resolver can reach public DNS, and is unreachable from outside; a fully isolated network hosts the same record in its internal zone instead. |
| TLS | The certificate is issued **off the VM** (a DNS-01 challenge against the domain's DNS, from the laptop) and brought as the `kubernetes.io/tls` Secret the chart's Ingresses name (one certificate carrying both names, the runbook's shape). No ACME traffic from the VM, no cert-manager on it. Renewal repeats the same off-VM step before expiry. |
| Explain / incident RCA | `web.explainMode: fake` — no model is called and the panel says so. `anthropic` sends trace text to the endpoint it is pointed at: Anthropic's API (a firewall exception the client would have to grant), or an internal Anthropic-compatible gateway through `web.explainBaseUrl` + `web.explainModel` (chart 0.8.0). |
| Alert delivery | Only to channels the workspace configures. The notifier's default egress policy refuses private-network targets (the SSRF fence, D487/D492); receivers that are all inside the network need `ingest.notifier.allowPrivate: true` (chart 0.8.0), whose consequence `values.yaml` states: the fence is off for the whole process. A public Slack webhook would carry alert titles out of the network, by the workspace's own choice. |
| Billing | `OBSTACK_BILLING_MODE` is `fake` on a self-hosted install; nothing is called. |
| The status page | Renders a link when a monitor URL was baked into the image; a link is followed by a person's browser, not by the server. |
| Fonts, scripts | Bundled into the web image at build time; the app loads nothing from a CDN. |
| Software telemetry | Chart 0.8.0 switches ClickHouse's crash reporting OFF on every install (its stock `config.xml` at the pinned version has it ON — measured with the binary's own config reader) and states `NEXT_TELEMETRY_DISABLED` on the web pod; ingest's only outbound client is the notifier above. Traefik, as k3s v1.36.4+k3s1 packages it (chart `40.1.4+up40.1.0`, Traefik 3.7.8), inherits its upstream default `global.checkNewVersion: true` (`sendAnonymousUsage` is off upstream, and k3s's own values override neither): `load.sh` writes a `HelmChartConfig` into k3s's manifests directory before k3s's first start, so the packaged chart installs with both false. |
| The operating system | A stock Ubuntu calls out on its own: `systemd-timesyncd` to the public NTP pool, the apt timers to the archive, `motd-news`, `snapd`, the Pro client, and `systemd-resolved`'s fallback resolvers when the network hands it none. The runbook's step 1 points time at the client's server and turns the rest off — the client's firewall would refuse them anyway; off keeps its log meaningful. |
| Claude Code over MCP | A developer's Claude Code reads traces through `https://<host>/mcp` from their machine on the client's network, and that tool sends what it reads to the model. The one door where trace content leaves by design — through a person's tool, on their machine, never from the VM. The client decides whether it opens; the read key can be revoked from Settings at any time. |
| Application telemetry | The client's pods send OTLP to the ingest Service inside the cluster; the OTLP Ingress is for senders outside the cluster and can stay disabled. |

## Verifying on the VM

```bash
sha256sum -c SHA256SUMS                         # what load.sh does first
k3s ctr -n k8s.io images ls | grep -E 'obstack|clickhouse|postgres|otel|busybox'
kubectl get events --field-selector reason=Pulled -o custom-columns=POD:involvedObject.name,MSG:message   # every line "already present on machine"
kubectl -n kube-system get helmchartconfig traefik -o jsonpath='{.spec.valuesContent}'                     # checkNewVersion: false
```

And the egress meter — an nftables counter on the VM for packets addressed outside the private ranges, on the host's own output and on what it forwards for pods. It drops nothing; it counts. Expected after a day of use: `packets 0 bytes 0` (the operator's SSH is inbound; add the client's own ranges to the set if they use public address space internally; it does not persist across a reboot — re-add it):

```bash
sudo nft add table inet egresswatch
sudo nft add chain inet egresswatch out '{ type filter hook output priority 0; }'
sudo nft add chain inet egresswatch fwd '{ type filter hook forward priority 0; }'
for c in out fwd; do sudo nft add rule inet egresswatch $c ip daddr != { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 127.0.0.0/8, 169.254.0.0/16, 224.0.0.0/4, 255.255.255.255 } counter; done
sudo nft list table inet egresswatch      # the two counters
```

The client's firewall, denying the VM's egress and logging it, is the authoritative record; the meter is the same fact seen from inside.

## Upgrades

A new merge publishes new images; run `bundle.sh` again at that commit, carry the new bundle in, `sudo ./load.sh` (leaves a k3s already at the bundle's version alone, imports the new images beside the old, replaces `/opt/obstack` whole), edit the two `image:` lines in the values file, `helm upgrade`. Old images can be removed with `k3s ctr -n k8s.io images rm`.

## Not covered here

The certificate's issuance (the runbook's TLS step: a public-CA certificate by a DNS challenge, from the laptop), the DNS records, the client's own application images and their build machines' package mirrors, and anything the chart keeps out by ruling (backup automation, HA).
