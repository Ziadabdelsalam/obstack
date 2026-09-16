#!/usr/bin/env bash
# obstack air-gap load — run ON THE VM, as root, from inside the bundle
# directory bundle.sh produced. No network is used. In order:
#
#   1. verify every file against SHA256SUMS (a bundle that fails is refused);
#   2. install k3s from the bundled binary and image pack (server role, the
#      k3s defaults: Traefik, local-path, metrics-server, CoreDNS), with
#      Traefik's version check switched off BEFORE its first start — a
#      HelmChartConfig in k3s's manifests directory, because the packaged
#      Traefik chart inherits upstream's `global.checkNewVersion: true` — and
#      wait for the node to be Ready. A node already running this exact k3s
#      version is left as it is, so an upgrade re-run only imports images and
#      refreshes the source;
#   3. import every chart image into k3s's containerd under the names the
#      kubelet will ask for (images.tsv), and verify each digest is present;
#   4. install helm, unpack the repository to /opt/obstack (replaced whole —
#      keep your values file elsewhere), and give the invoking user a
#      kubeconfig.
#
# It stops at the first failure and says which step. Re-running is safe: every
# step is idempotent (the version check on k3s, ctr import, tag --force, tar -x).
#
#   sudo ./load.sh
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "load: run as root (sudo ./load.sh)" >&2; exit 2; }
bundle="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$bundle"
[ -f bundle.env ] && [ -f images.tsv ] && [ -f SHA256SUMS ] || { echo "load: run from inside the bundle directory" >&2; exit 2; }
# shellcheck disable=SC1091
. ./bundle.env

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'load: %s\n' "$1" >&2; exit 1; }
SUDO_USER_HOME="$(getent passwd "${SUDO_USER:-root}" | cut -d: -f6)"

step "1/4 verifying the bundle (SHA256SUMS)"
sha256sum --quiet -c SHA256SUMS || fail "the bundle does not match its checksums — do not install from it"
printf '   %s files verified\n' "$(wc -l < SHA256SUMS | tr -d ' ')"
[ "$(uname -m)" = x86_64 ] || fail "this VM is $(uname -m); the bundle's images are $PLATFORM"

step "2/4 k3s $K3S_VERSION from the bundle (no download)"
# Traefik's update check off before Traefik ever starts: k3s applies every
# file in this directory when it starts, and a HelmChartConfig merges into
# the packaged chart's values (k3s docs, "Customizing packaged components").
# Written on every run — the same bytes, so a re-run changes nothing.
install -d -m 755 /var/lib/rancher/k3s/server/manifests
cat > /var/lib/rancher/k3s/server/manifests/traefik-config.yaml <<'YAML'
# obstack air-gap posture (deploy/airgap/README.md): the Traefik chart k3s
# packages inherits its upstream default global.checkNewVersion: true — a
# request to the vendor for a newer version, at start and on a schedule.
# Off. Anonymous usage statistics are already off upstream; stated here so
# this file says what the posture is.
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
installed="$(k3s --version 2>/dev/null | awk 'NR==1{print $3}' || true)"
if [ "$installed" = "$K3S_VERSION" ] && [ -f /etc/rancher/k3s/k3s.yaml ]; then
  printf '   k3s %s is already installed; leaving it as it is\n' "$K3S_VERSION"
else
  install -d -m 755 /var/lib/rancher/k3s/agent/images
  install -m 644 k3s/k3s-airgap-images-amd64.tar.zst /var/lib/rancher/k3s/agent/images/
  install -m 755 k3s/k3s /usr/local/bin/k3s
  # The upstream installer, told to use the binary already in place and to
  # fetch nothing (the SELinux RPM is an rpm-distro fetch; skipped for the
  # same reason). Server role, defaults kept: Traefik is the ingress
  # controller the chart's Ingresses name, local-path the default
  # StorageClass the PVCs bind to.
  INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_SKIP_SELINUX_RPM=true INSTALL_K3S_SKIP_START=false sh k3s/install.sh server
fi
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
printf '   waiting for the node...\n'
for _ in $(seq 1 60); do
  if k3s kubectl get nodes --no-headers 2>/dev/null | grep -q ' Ready'; then break; fi
  sleep 5
done
k3s kubectl get nodes --no-headers | grep -q ' Ready' || fail "the node did not become Ready in 5 minutes — journalctl -u k3s"
k3s kubectl get storageclass --no-headers | grep -q 'local-path.*(default)' || fail "local-path is not the default StorageClass"
printf '   node Ready · local-path (default) · '
k3s kubectl get ingressclass --no-headers 2>/dev/null | grep -q traefik && printf 'traefik ingress class present\n' || printf 'traefik ingress class not yet registered (it appears once the helm-controller installs Traefik; re-check before helm install)\n'

step "3/4 importing the chart's images into containerd (k8s.io namespace)"
# --digests registers each image under name@digest as well as its annotated
# name, which is what containerd's CRI resolves a `name:tag@sha256:…` pod image
# to; the canonical `name:tag` the kubelet asks for otherwise is tagged
# explicitly from images.tsv (crane records Docker Hub names as index.docker.io).
tail -n +2 images.tsv | while IFS=$'\t' read -r chart_ref canonical_name digest_name digest tarball imported_name; do
  printf '   %s\n' "$chart_ref"
  k3s ctr -n k8s.io images import --digests "$tarball" >/dev/null || fail "ctr import failed for $tarball"
  src="$imported_name"; [ -n "$src" ] || src="$digest_name"
  k3s ctr -n k8s.io images tag --force "$src" "$canonical_name" >/dev/null 2>&1 || \
    k3s ctr -n k8s.io images tag --force "$digest_name" "$canonical_name" >/dev/null || fail "could not tag $canonical_name"
  k3s ctr -n k8s.io images tag --force "$canonical_name" "$digest_name" >/dev/null 2>&1 || true
done
printf '   verifying names and digests as containerd holds them\n'
listing="$(k3s ctr -n k8s.io images ls -q)"
tail -n +2 images.tsv | while IFS=$'\t' read -r chart_ref canonical_name digest_name digest tarball imported_name; do
  printf '%s\n' "$listing" | grep -qxF "$canonical_name" || fail "containerd does not hold $canonical_name"
  printf '%s\n' "$listing" | grep -qxF "$digest_name" || fail "containerd does not hold $digest_name"
  held="$(k3s ctr -n k8s.io images ls "name==$canonical_name" | awk 'NR==2{print $3}')"
  [ "$held" = "$digest" ] || fail "$canonical_name is held at $held, expected $digest"
done
printf '   %s images present, every digest as bundled\n' "$(($(wc -l < images.tsv) - 1))"

step "4/4 helm, the repository, and a kubeconfig for ${SUDO_USER:-root}"
tar -C /tmp -xzf "helm/helm-$HELM_VERSION-linux-amd64.tar.gz" linux-amd64/helm
install -m 755 /tmp/linux-amd64/helm /usr/local/bin/helm; rm -rf /tmp/linux-amd64
# Replaced whole: a file the previous release had and this one removed (a
# chart template, say) must not survive underneath the new tree.
rm -rf /opt/obstack
tar -C /opt -xzf obstack-src-*.tar.gz
if [ -n "${SUDO_USER:-}" ] && [ -n "$SUDO_USER_HOME" ]; then
  install -d -m 700 -o "$SUDO_USER" "$SUDO_USER_HOME/.kube"
  install -m 600 -o "$SUDO_USER" /etc/rancher/k3s/k3s.yaml "$SUDO_USER_HOME/.kube/config"
fi
printf '   helm %s · chart %s at /opt/obstack/deploy/helm/obstack · kubeconfig at %s/.kube/config\n' \
  "$(helm version --short)" "$CHART_VERSION" "${SUDO_USER_HOME:-/root}"

cat <<NEXT

load: DONE. Nothing left the VM. Next, as ${SUDO_USER:-root} (the runbook, from its Secrets step):
  kubectl create secret ...                       # the brought Secrets and the TLS Secret
  helm install obstack /opt/obstack/deploy/helm/obstack -f pilot-values.yaml --timeout 900s --wait
Every image: line in the values file must be one of the chart_ref values in images.tsv (pullPolicy IfNotPresent).
NEXT
