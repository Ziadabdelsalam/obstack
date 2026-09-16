#!/usr/bin/env bash
# obstack air-gap bundle — run on a machine WITH internet access, once per
# release you intend to install. Produces one directory that carries everything
# a k3s VM inside a network with no internet needs to run the chart:
#
#   images/*.tar         every image the chart renders for YOUR values file,
#                        pulled for linux/amd64 (the VM's platform, D682) as
#                        OCI layouts — the manifest bytes are preserved, so a
#                        digest-pinned `image:` value resolves offline exactly as
#                        it would against the registry;
#   k3s/                 the k3s binary, its own air-gap image pack, its
#                        checksum file, and the upstream install script;
#   helm/                the helm binary for the VM;
#   obstack-src-*.tar.gz the repository at this commit: the chart, the SDK
#                        sources the client's apps install from, the docs;
#   images.tsv           what each tarball is: the chart's reference, the name
#                        containerd must hold for the kubelet to find it, and
#                        the manifest digest — load.sh reads this;
#   SHA256SUMS           every file above; load.sh refuses a bundle that fails it.
#
# Nothing here is a credential: the values file is read for its image
# references only and is NOT copied into the bundle (carry it separately, it
# names your Secrets). The bundle is inert data — transfer it however the
# client's network allows (scp through a jump host, a USB drive).
#
# Needs: bash, curl, tar, git, helm (to render the image list from the chart);
# `crane` (pulls images without a Docker daemon) is fetched into the bundle's
# own .tools/ if it is not on PATH. Works on macOS (arm64 or x86_64) and Linux.
#
#   deploy/airgap/bundle.sh -f pilot-values.yaml -o ./obstack-airgap
set -euo pipefail

K3S_VERSION="${K3S_VERSION:-v1.36.4+k3s1}"   # the runbook's pin — one release, stated
HELM_VERSION="${HELM_VERSION:-v3.19.0}"
CRANE_VERSION="${CRANE_VERSION:-v0.22.1}"
PLATFORM="linux/amd64"

usage() {
  echo "usage: $0 -f <values.yaml> [-o <out dir>]" >&2
  echo "  env: K3S_VERSION (default $K3S_VERSION) HELM_VERSION (default $HELM_VERSION) CRANE_VERSION (default $CRANE_VERSION)" >&2
  exit 2
}

values=""; out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -f) values="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$values" ] || usage
[ -f "$values" ] || { echo "values file not found: $values" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$here/../.." && pwd)"
chart_dir="$repo_root/deploy/helm/obstack"
commit="$(git -C "$repo_root" rev-parse HEAD)"
short="$(git -C "$repo_root" rev-parse --short=12 HEAD)"
out="${out:-./obstack-airgap-$short}"
mkdir -p "$out/images" "$out/k3s" "$out/helm" "$out/.tools"
out="$(cd "$out" && pwd)"

step() { printf '\n== %s\n' "$1"; }
fail() { printf 'bundle: %s\n' "$1" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required on PATH"; }
need curl; need tar; need git; need helm

# Portable sha256: coreutils on Linux, shasum on macOS.
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
fetch() { # fetch <url> <dest>
  curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1" || fail "download failed: $1"
}

# ---------------------------------------------------------------- crane -----
# Pulls images to disk without a Docker daemon (the box this was written on
# had none, and a bundling laptop often has none either). Fetched into the
# bundle's own tools directory when absent, verified against the release's
# checksums.txt.
step "crane"
if command -v crane >/dev/null 2>&1; then
  CRANE="$(command -v crane)"
else
  os="$(uname -s)"; arch="$(uname -m)"
  case "$arch" in x86_64|amd64) arch=x86_64 ;; arm64|aarch64) arch=arm64 ;; *) fail "unsupported bundling arch: $arch" ;; esac
  case "$os" in Darwin|Linux) ;; *) fail "unsupported bundling OS: $os (run this on macOS or Linux)" ;; esac
  asset="go-containerregistry_${os}_${arch}.tar.gz"
  base="https://github.com/google/go-containerregistry/releases/download/$CRANE_VERSION"
  fetch "$base/$asset" "$out/.tools/$asset"
  fetch "$base/checksums.txt" "$out/.tools/crane-checksums.txt"
  want="$(grep " $asset\$" "$out/.tools/crane-checksums.txt" | awk '{print $1}')"
  [ -n "$want" ] || fail "no checksum for $asset in the crane release"
  [ "$(sha256 "$out/.tools/$asset")" = "$want" ] || fail "crane tarball checksum mismatch"
  tar -C "$out/.tools" -xzf "$out/.tools/$asset" crane
  CRANE="$out/.tools/crane"
fi
"$CRANE" version >/dev/null || fail "crane does not run"
printf '   %s (%s)\n' "$CRANE" "$("$CRANE" version)"

# ------------------------------------------------------- the image list -----
# Read off the rendered chart for THIS values file — the same line
# acceptance.sh uses to side-load kind. Whatever the values pin is what the
# bundle carries; nothing is listed twice.
step "the chart's images for $values"
images="$(helm template obstack "$chart_dir" -f "$values" | sed -n 's/^ *image: *//p' | tr -d '"' | sort -u)"
[ -n "$images" ] || fail "helm template rendered no images"
printf '%s\n' "$images" | sed 's/^/   /'

# canonical <ref-without-digest> -> the name containerd's CRI looks up for it:
# a bare name gains docker.io/library/, a namespaced Docker Hub name gains
# docker.io/, anything with a registry host stays as written.
canonical() {
  local ref="$1" first
  first="${ref%%/*}"
  if [ "$ref" = "$first" ]; then
    printf 'docker.io/library/%s\n' "$ref"
  elif [[ "$first" == *.* || "$first" == *:* || "$first" == localhost ]]; then
    printf '%s\n' "$ref"
  else
    printf 'docker.io/%s\n' "$ref"
  fi
}

# images.tsv columns: chart_ref, canonical_name (name:tag the kubelet asks for),
# digest_name (name@digest — what CRI resolves a tag@digest reference to),
# manifest digest, tarball, imported_name (the OCI annotation crane wrote).
tsv="$out/images.tsv"
printf 'chart_ref\tcanonical_name\tdigest_name\tdigest\ttarball\timported_name\n' > "$tsv"
step "pulling images for $PLATFORM as OCI layouts (manifest digests preserved)"
i=0
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  i=$((i + 1))
  pinned="${ref#*@}"; [ "$pinned" = "$ref" ] && pinned=""
  base="${ref%%@*}"                       # name:tag (or name)
  name="${base%%:*}"; tag="${base#*:}"
  # a registry port (host:5000/x) has the colon before the first slash — not a tag
  if [[ "$name" == */* && "$base" == *:* && "${base%%/*}" == *:* && "${base#*/}" != *:* ]]; then name="$base"; tag=""; fi
  [ "$tag" = "$base" ] && tag=""
  canon_name="$(canonical "$name")"
  slug="$(printf '%s' "$canon_name${tag:+-$tag}" | tr '/:@' '___')"
  tmp="$out/.tools/oci-$i"; rm -rf "$tmp"
  printf '   [%d] %s\n' "$i" "$ref"
  "$CRANE" pull --platform "$PLATFORM" --format=oci --annotate-ref "$ref" "$tmp" >/dev/null 2>&1 || fail "crane pull failed for $ref"
  digest="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['manifests'][0]['digest'])" "$tmp/index.json" 2>/dev/null || true)"
  imported="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['manifests'][0].get('annotations',{}).get('org.opencontainers.image.ref.name',''))" "$tmp/index.json" 2>/dev/null || true)"
  if [ -z "$digest" ]; then
    # no python3: read the index with sed (one manifest per layout, as pulled)
    digest="$(sed -n 's/.*"digest": *"\(sha256:[0-9a-f]*\)".*/\1/p' "$tmp/index.json" | head -1)"
    imported="$(sed -n 's/.*"org.opencontainers.image.ref.name": *"\([^"]*\)".*/\1/p' "$tmp/index.json" | head -1)"
  fi
  [ -n "$digest" ] || fail "no manifest digest in the OCI layout for $ref"
  if [ -n "$pinned" ] && [ "$pinned" != "$digest" ]; then fail "$ref: the registry served $digest, not the pinned $pinned"; fi
  tarball="images/$slug.tar"
  tar -C "$tmp" -cf "$out/$tarball" . ; rm -rf "$tmp"
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$ref" "$canon_name${tag:+:$tag}" "$canon_name@$digest" "$digest" "$tarball" "$imported" >> "$tsv"
  printf '       %s  (%s)\n' "$digest" "$(du -h "$out/$tarball" | cut -f1)"
done <<< "$images"

# ------------------------------------------------------------------- k3s -----
step "k3s $K3S_VERSION (binary, air-gap image pack, checksums, install script)"
enc="$(printf '%s' "$K3S_VERSION" | sed 's/+/%2B/g')"
k3s_base="https://github.com/k3s-io/k3s/releases/download/$enc"
fetch "$k3s_base/sha256sum-amd64.txt" "$out/k3s/sha256sum-amd64.txt"
fetch "$k3s_base/k3s" "$out/k3s/k3s"
fetch "$k3s_base/k3s-airgap-images-amd64.tar.zst" "$out/k3s/k3s-airgap-images-amd64.tar.zst"
for f in k3s k3s-airgap-images-amd64.tar.zst; do
  want="$(grep " $f\$" "$out/k3s/sha256sum-amd64.txt" | awk '{print $1}')"
  [ "$(sha256 "$out/k3s/$f")" = "$want" ] || fail "k3s checksum mismatch for $f"
done
fetch "https://get.k3s.io" "$out/k3s/install.sh"
printf '   k3s %s · images pack %s · install.sh %s\n' "$(du -h "$out/k3s/k3s" | cut -f1)" "$(du -h "$out/k3s/k3s-airgap-images-amd64.tar.zst" | cut -f1)" "$(sha256 "$out/k3s/install.sh" | cut -c1-12)…"

# ------------------------------------------------------------------ helm -----
step "helm $HELM_VERSION for the VM (linux-amd64)"
helm_tgz="helm-$HELM_VERSION-linux-amd64.tar.gz"
fetch "https://get.helm.sh/$helm_tgz" "$out/helm/$helm_tgz"
fetch "https://get.helm.sh/$helm_tgz.sha256sum" "$out/helm/$helm_tgz.sha256sum"
[ "$(sha256 "$out/helm/$helm_tgz")" = "$(awk '{print $1}' "$out/helm/$helm_tgz.sha256sum")" ] || fail "helm checksum mismatch"

# ---------------------------------------------------------------- source -----
step "the repository at $short (chart, SDK sources, docs)"
git -C "$repo_root" archive --format=tar.gz --prefix="obstack/" -o "$out/obstack-src-$short.tar.gz" HEAD
cp "$here/load.sh" "$out/load.sh"; chmod +x "$out/load.sh"
cp "$here/README.md" "$out/README.md"
chart_version="$(sed -n 's/^version: *//p' "$chart_dir/Chart.yaml")"
cat > "$out/bundle.env" <<ENV
SRC_COMMIT=$commit
CHART_VERSION=$chart_version
K3S_VERSION=$K3S_VERSION
HELM_VERSION=$HELM_VERSION
PLATFORM=$PLATFORM
CREATED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ENV

# ------------------------------------------------------------- checksums -----
step "SHA256SUMS"
rm -rf "$out/.tools"
( cd "$out" && find . -type f ! -name SHA256SUMS | sed 's#^\./##' | sort | while IFS= read -r f; do printf '%s  %s\n' "$(sha256 "$f")" "$f"; done > SHA256SUMS )
printf '   %s files · %s total\n' "$(wc -l < "$out/SHA256SUMS" | tr -d ' ')" "$(du -sh "$out" | cut -f1)"

printf '\nbundle: DONE — %s\n' "$out"
printf 'next: copy the directory to the VM, then as root there:  sudo ./load.sh\n'
printf '      carry your values file separately; it is not in the bundle.\n'
