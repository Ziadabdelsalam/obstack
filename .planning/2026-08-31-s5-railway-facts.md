# Railway platform facts — official docs only (docs.railway.com / railway.com/changelog)

Method note: all answers below come from `WebFetch`/`WebSearch` against `docs.railway.com` (and one `railway.com/changelog` search). Where a fetch's AI-summarizer paraphrased instead of returning a literal excerpt, the paraphrase is marked. Community/forum content (station.railway.com) is **not** used as a source of fact — it is mentioned only where explicitly flagged as unofficial, for context on an item the official docs leave undocumented.

---

## 1. Multiple custom domains per service, each on a different port

**Answer:** Yes. One service can have multiple custom domains, and each domain is bound to its own "Target Port" (aka "Magic Port"). One port per domain, though — you cannot put two ports behind one domain.

**Quote:** "Target Ports, or Magic Ports, correlate a single domain to a specific internal port that the application listens on... enabling you to expose multiple HTTP ports through the use of multiple domains." / "You can change the automatically detected or manually set port at any time by clicking the edit icon next to the domain." / "If your domain does not have a target port set, Railway will direct incoming traffic to the port specified in the PORT variable."

**How to set it:** UI — edit icon next to the domain in the service's Settings → Networking. CLI — `railway domain example.com --port 8080` to add, `railway domain update example.com --port 8080` to change.

**URLs:** https://docs.railway.com/networking/domains/working-with-domains , https://docs.railway.com/cli/domain

This directly supports the plan: `ingest.obstack.dev → 4318` and `ingest-grpc.obstack.dev → 4317` as two separate custom domains on the same ingest service, each with its own target port.

---

## 2. gRPC / HTTP/2 support on the public edge proxy

**Answer: NOT DOCUMENTED.** Official docs do not state whether the public edge (HTTP) proxy supports gRPC or speaks HTTP/2 end-to-end to the app container, and do not mention any h2c requirement.

**What the official docs do say:** the edge proxy terminates TLS: "The edge proxy (tcp-proxy) terminates TLS, adds headers, and looks up routing information." (https://docs.railway.com/networking/edge-networking). `docs.railway.com/reference/public-networking` covers automatic SSL and custom/Railway-provided domains but contains no sentence mentioning gRPC, HTTP/2, or HTTP/1.1.

**Separately documented, official fact that matters here:** Railway's **TCP Proxy** is a distinct, protocol-agnostic L4 forwarding feature: "supports... any application that communicates over raw TCP" and requires you to "Enter the internal port your service listens on," after which Railway "generates a proxy domain and port" and forwards all traffic to it. (https://docs.railway.com/networking/tcp-proxy) Because it is a raw TCP forward with no HTTP awareness, it is a documented mechanism that would carry gRPC/HTTP2 traffic without protocol translation — but note it comes with a Railway-generated `*.proxy.rlwy.net:PORT` address, not a clean custom domain the way the HTTP edge proxy does, and TLS/ALPN handling for gRPC over it is not documented either.

**Flag for the plan:** given the docs are silent on HTTP/2 support through the standard custom-domain edge proxy, do not assume `ingest-grpc.obstack.dev:4317` will carry gRPC through the normal custom-domain path without live-testing it; the TCP Proxy is the documented fallback but doesn't give a custom-domain-shaped result. This is the single highest-risk unknown in this whole research pass.

---

## 3. Private networking

**Answer:**
- Hostname: `SERVICE_NAME.railway.internal`. Quote: "Reference other services using their internal DNS name: `SERVICE_NAME.railway.internal`" (https://docs.railway.com/networking/private-networking) and example usage `http://api.railway.internal:PORT` — i.e., you address the service by name and the port your app listens on; the docs do not document any narrower allow-list of reachable ports beyond "the port your app listens on."
- Ports reachable: **not explicitly documented** beyond "whatever port your app listens on" (no stated firewall/allow-list beyond that).
- IPv6-only caveat: **"Legacy environments: DNS names resolve to IPv6 addresses only."** New environments (created after October 16, 2025) resolve to both IPv4 and IPv6. Quote: "New environments (created after October 16, 2025): DNS names resolve to both internal IPv4 and IPv6 addresses" / "Legacy environments: DNS names resolve to IPv6 addresses only." (https://docs.railway.com/networking/private-networking/how-it-works)
- Build-time availability: **No.** "Private networking is only available at runtime, not during the build phase." (same URL) — so any build-time DB migration, etc., must run from the start command, not the build step.
- Also documented: traffic is Wireguard-encrypted, so use `http://` (not `https://`) between services internally.

**URLs:** https://docs.railway.com/networking/private-networking , https://docs.railway.com/networking/private-networking/how-it-works

---

## 4. Volumes

**Answer:**
- One volume per service: **"Each service can only have a single volume"** (https://docs.railway.com/reference/volumes)
- Mount path: configured by you in service settings — **"You must configure the mount path of the volume in your service"**; **"The volume mount point you specify will be available in your service as a directory to which you can read/write."** (https://docs.railway.com/guides/volumes)
- Max size: Hobby **5GB**, Pro **50GB**, with **"Pro users and above can self-serve to increase their volume up to 1 TB."** (https://docs.railway.com/reference/volumes)
- Redeploy preservation: **not explicitly stated** in the fetched content. The closest documented statement is a same-time-active constraint, not persistence-across-redeploy: **"To prevent data corruption, we prevent multiple deployments from being active and mounted to the same service."** Treat "does a redeploy preserve the volume" as not directly documented, though the same-volume-per-service model implies it is a persistent block store, not ephemeral per-deployment storage.
- Replicas: **"Replicas cannot be used with volumes."** (https://docs.railway.com/reference/volumes) — a volume-backed service is capped at 1 replica.

**URLs:** https://docs.railway.com/reference/volumes , https://docs.railway.com/guides/volumes

Relevant to the plan: ClickHouse and Postgres, each single-volume single-replica, is exactly what Railway supports — do not plan for multi-replica ClickHouse/Postgres with a shared volume.

---

## 5. Deploying from a private Docker registry (GHCR)

**Answer:** Supported, Pro-plan-gated.

**Quotes:**
- "Railway supports deploying Docker images from private container registries." (https://docs.railway.com/builds/private-registries)
- "For images hosted on `ghcr.io`, Railway provides a simplified authentication flow" using "a GitHub Personal Access Token with the `read:packages` scope." (same URL)
- **"Private registry credentials are available on the Pro plan. Public images work on any plan."** (https://docs.railway.com/guides/private-container-registry)
- Credentials entry point: service Settings → Source → Registry Credentials.
- Image reference format: full path including registry domain, e.g. `ghcr.io/your-org/my-app:1.0.0`.
- Pin + update flow: **"Push a mutable tag like :latest or :production, then trigger a redeploy with the Railway CLI. The redeploy pulls the tag again and picks up the new digest."** (https://docs.railway.com/guides/private-container-registry) — i.e. yes, you can pin the *reference* to a stable tag and cause Railway to re-pull it via `railway redeploy`; the docs do not separately document changing the image variable directly via `railway variables --set` as an alternate update path.

**URLs:** https://docs.railway.com/builds/private-registries , https://docs.railway.com/guides/private-container-registry

Note: Railway's own docs appear to have two overlapping pages on this topic (`/builds/private-registries` and `/guides/private-container-registry`) with the Pro-plan gate stated only on the second — worth a quick live UI check since our GHCR ingest image needs this.

---

## 6. Deploying from a Dockerfile in a monorepo

**Answer:**
- Dockerfile path: env var `RAILWAY_DOCKERFILE_PATH`, or config-as-code field `dockerfilePath`. Quote: **"In your service variables, set a variable named `RAILWAY_DOCKERFILE_PATH` to specify the path to the file"**, example `RAILWAY_DOCKERFILE_PATH=/build/Dockerfile`; also settable "using config as code" as `"dockerfilePath": "Dockerfile.backend"`. Default: **"By default, we look for a file named `Dockerfile` in the root directory."** (https://docs.railway.com/guides/dockerfiles , https://docs.railway.com/config-as-code/reference)
- Build context / root directory: separate setting from the Dockerfile path. **"The root directory defaults to `/` but can be changed for various use-cases like monorepo projects... all build and deploy commands will operate within the defined root directory."** Set per-service under the service's Settings → Root Directory (e.g. `/frontend`, `/backend`). **Note: "the Railway Config File does not follow the Root Directory path — you have to specify the absolute path for the railway.json/railway.toml,"** e.g. `/backend/railway.toml`. (https://docs.railway.com/builds/build-configuration , https://docs.railway.com/deployments/monorepo — reached via search, not directly quote-verified by WebFetch; treat the Root Directory sentence as a paraphrase of the official page, not a literal excerpt)
- Build ARGs: **not automatic.** Service variables are not auto-injected as Docker `ARG`s — **"If you need to use the environment variables that Railway injects at build time... you must specify them in the Dockerfile using the `ARG` command,"** e.g. `ARG RAILWAY_SERVICE_NAME` then `RUN echo $RAILWAY_SERVICE_NAME`. (https://docs.railway.com/guides/dockerfiles)

**URLs:** https://docs.railway.com/guides/dockerfiles , https://docs.railway.com/config-as-code/reference , https://docs.railway.com/builds/build-configuration

---

## 7. Railway CLI

**Install (macOS Homebrew):** `brew install railway` (https://docs.railway.com/guides/cli)

**Login flow:**
- Browser: `railway login` — "Opens your default browser to authenticate." Browserless variant: `railway login --browserless`.
- Token-based (skips interactive login): **`RAILWAY_TOKEN`** = project-scoped — "Deploying, managing variables, and other operations within a single project." **`RAILWAY_API_TOKEN`** = account-scoped — "Account-level operations like creating environments, managing multiple projects, or any action that requires broader access." **"When either variable is set, the CLI skips interactive login and authenticates automatically. Only one may be set at a time — setting both will result in an error."** (https://docs.railway.com/cli/login)

**Other commands** (https://docs.railway.com/cli):
- Link project: `railway link`
- Link service: `railway service`
- Set a variable: **`railway variable set KEY=value`** (note: docs use singular "variable" + "set" subcommand, not "variables --set" as commonly assumed — verify live before scripting)
- Add custom domain: `railway domain example.com` (add `--port <PORT>` to target a specific port — https://docs.railway.com/cli/domain)
- Trigger a deploy: `railway up` (`railway up --detach` to skip streaming logs); `railway redeploy` redeploys the current/latest deployment as-is (useful for re-pulling an updated image tag)
- View logs: `railway logs` (`railway logs --build` for build logs, `railway logs -n 100` for last N lines)
- Roll back: **no dedicated CLI rollback subcommand documented.** Rollback is a **dashboard-only** action per https://docs.railway.com/deployments/deployment-actions: **"To perform a rollback, click the three dots at the end of a previous deployment, you will then be asked to confirm your rollback."** Both "the Docker image and custom variables are restored." **"Deployments older than your plan's retention policy cannot be restored via rollback, and thus the rollback option will not be visible."**

**URLs:** https://docs.railway.com/guides/cli , https://docs.railway.com/cli/login , https://docs.railway.com/cli/domain , https://docs.railway.com/deployments/deployment-actions

---

## 8. Config-as-code (`railway.json` / `railway.toml`)

**Answer:** Yes, per-service — for a monorepo you point each service at its own file via the service's settings page, using an absolute repo path.

**Fields found** (https://docs.railway.com/config-as-code/reference):
- Build: `builder` (e.g. `"RAILPACK"`), `dockerfilePath`, `buildCommand`, `watchPatterns`, `railpackVersion`
- Deploy: `startCommand`, `preDeployCommand`, `healthcheckPath`, `healthcheckTimeout`, `restartPolicyType`, `restartPolicyMaxRetries`, `cronSchedule`, `overlapSeconds`, `drainingSeconds`
- Regions/replicas: `multiRegionConfig` block, with per-region `numReplicas` — regions named in an example include `us-west2`, `us-east4-eqdc4a`, `europe-west4-drams3a`, `asia-southeast1-eqsg3a`
- Environment overrides: settings can be nested under `"environments": { "staging": {...} }`, including a special `"pr"` environment
- Per-service in a monorepo: **"You can use a custom config as Code file by setting it on the service settings page. You should provide the absolute path to the file in your repository, for example: `/backend/railway.toml`."** (https://docs.railway.com/guides/config-as-code) — and per §6 above, this custom path is **not** relative to the service's Root Directory setting.

**URLs:** https://docs.railway.com/config-as-code/reference , https://docs.railway.com/guides/config-as-code

---

## 9. Healthchecks and zero-downtime rollout

**Answer:**
- Path: you provide an HTTP endpoint (example given: `/health`) that "return[s] an HTTP status code of 200 when the application is live and ready."
- Timeout: default **300 seconds (5 minutes)**, configurable via the service settings page or the `RAILWAY_HEALTHCHECK_TIMEOUT_SEC` variable (also as `healthcheckTimeout` in config-as-code, per §8).
- Port: Railway checks against the **`PORT`** environment variable your app listens on. If you use custom/target ports instead, you must separately set a `PORT` variable so Railway knows which port to healthcheck.
- Zero-downtime behavior: **"Railway will query the endpoint until it receives an HTTP 200 response. Only then will the new deployment be made active and the previous deployment inactive."** — i.e., the old deployment is kept live and serving traffic until the new one passes its healthcheck.
- Caveat: **"Railway does not monitor the healthcheck endpoint after the deployment has gone live"** — it's a rollout gate only, not ongoing liveness monitoring.

**URL:** https://docs.railway.com/guides/healthchecks

---

## 10. TLS and DNS records for custom domains

**Answer:**
- TLS: automatic. **"Free SSL certificates automatically provisioned and renewed."** (https://docs.railway.com/guides/public-networking)
- DNS records: Railway asks you to add **CNAME and TXT** records for a custom domain — **"adding the `CNAME` and `TXT` records Railway provides to your DNS"** (same URL).
- Apex/root domain: **"When adding a root or apex domain to your Railway service, you must ensure that you add the appropriate DNS record to the domain within your DNS provider."** and **"At this time, Railway supports CNAME Flattening and dynamic ALIAS records."** (https://docs.railway.com/networking/domains/working-with-domains) — i.e. Railway's own recommended pattern for an apex domain is still CNAME-shaped, relying on your DNS provider supporting CNAME flattening or ALIAS records, since bare apex domains can't hold a real CNAME per the DNS spec.
- Squarespace-specific note: **not documented** — Railway's docs don't mention Squarespace by name or state whether Squarespace DNS supports CNAME flattening/ALIAS for an apex record. This needs to be checked directly against Squarespace's own DNS product docs before committing `obstack.dev` (apex) to Railway; subdomains like `app.obstack.dev` are uncontroversial plain CNAMEs.

**URLs:** https://docs.railway.com/guides/public-networking , https://docs.railway.com/networking/domains/working-with-domains

---

## 11. Pricing / limits (Hobby vs Pro)

**Answer** (https://docs.railway.com/reference/pricing — **no date/version stamp found on the page**, so treat these $ figures as "current as fetched today, 2026-08-31," not doc-dated):
- Hobby: **$5/month**, includes **$5 of resource usage per month** (i.e., the subscription fee is a usage credit, not a separate charge).
- Pro: **$20/month**, includes **$20 of resource usage per month**.
- Resource ceiling per the page's table: Hobby up to **48 GB RAM / 48 vCPU**, Pro up to **1 TB RAM / 1,000 vCPU** — stated as plan-wide maximums usable **per service** ("Depending on the plan you are on, you are allowed to use up these resources per service"), not a strict per-service cap distinct from the account ceiling.
- Custom domains on Hobby: **not documented** on the pricing page (no sentence found either confirming or denying Hobby custom-domain access).
- Volumes on Hobby: **documented in §4** — Hobby gets volumes up to 5GB (from https://docs.railway.com/reference/volumes), so volumes are confirmed available on Hobby; pricing page itself doesn't repeat this.
- Private registry images: **Pro-plan-gated** per §5 (not a Hobby feature).

**URL:** https://docs.railway.com/reference/pricing (cross-referenced with https://docs.railway.com/reference/volumes and https://docs.railway.com/guides/private-container-registry for the volume/registry gating facts)

---

## 12. Postgres and ClickHouse official templates

**Postgres:** Railway's official Postgres template is Railway's own SSL-wrapped build of the stock image: **"deployed from Railway's SSL-enabled Postgres image [github.com/railwayapp-templates/postgres-ssl], which uses the official Postgres image from Docker Hub as its base."** The docs explicitly invite running your own image instead: **"Since the deployed container is based on an image built from the official PostgreSQL image in Docker hub, you can modify the deployment based on the instructions in Docker hub,"** and suggest forking `railwayapp-templates/postgres-ssl` to customize. So yes — running your own pinned `postgres:17.11` image on Railway (rather than Railway's official template) is consistent with what the docs describe, though the docs describe forking their SSL wrapper rather than deploying a bare upstream tag directly; either approach is compatible with "just a postgres image + a volume."

**URL:** https://docs.railway.com/guides/postgresql

**ClickHouse:** Railway's `/databases` doc page lists its **officially maintained** database templates as: **PostgreSQL, PostgreSQL HA, PostgreSQL Connection Pooling, MySQL, MySQL HA, Redis, Redis HA, MongoDB** — described as **"maintained by Railway and come pre-configured with sensible defaults."** ClickHouse appears only in a separate "Popular database templates" mention — **"ClickHouse, CockroachDB, Cassandra, ParadeDB, and more"** — which is not the same "officially maintained" list. So: **ClickHouse is available as a Railway template/marketplace deploy, but the docs do not classify it among Railway's officially-maintained database services** the way Postgres/MySQL/Redis/MongoDB are classified.

**URL:** https://docs.railway.com/databases

---

## 13. Regions

**Answer:** Four regions, configured per-service:
- **US West** — California ("US West Metal")
- **US East** — Virginia ("US East Metal")
- **EU West** — Amsterdam, Netherlands ("EU West Metal", identifier `europe-west4-drams3a`)
- **Southeast Asia** — Singapore ("Southeast Asia Metal")

**Quote:** "Within the service settings, you can select one of the following regions" — confirming region is a per-service setting, not per-project.

**EU availability:** Yes — EU West Metal in Amsterdam.

**URL:** https://docs.railway.com/reference/regions

---

## 14. Sleeping / scale-to-zero

**Answer:** Railway only sleeps a service if you explicitly opt it into "Serverless" mode — it is not an always-on default behavior imposed by the plan tier, but rather a per-service feature you turn on.

**Quotes:** **"When Serverless is enabled for a service, Railway automatically detects inactivity based on outbound traffic."** A service is considered inactive and sleeps roughly **"5 and 10 minutes after its last outbound traffic."** It wakes on **"receiv[ing] traffic from the internet or from another service in the same project through the private network."** **"Enabling Serverless will apply the setting across all Replicas"** (can't sleep only some replicas).

**Implication for the OTLP ingest service:** sleeping is opt-in per service — as long as Serverless is left off (the default) for the ingest service, it is not documented to sleep. The docs did not state a plan-tier restriction on which plans can enable/disable Serverless.

**URL:** https://docs.railway.com/reference/app-sleeping

---

## Unknowns (official docs did not state)

1. **gRPC/HTTP2 support through the standard HTTP edge proxy + custom domain** — not documented either way (see §2). This is the biggest open risk for the ingest service's `:4317` gRPC port.
2. Which specific ports (beyond "the port your app listens on") are reachable over the private network — no explicit allow-list documented.
3. Whether a redeploy preserves an existing volume's data — implied by the persistent-block-store model but never stated in so many words.
4. Whether the Hobby plan supports custom domains at all (pricing page silent).
5. Squarespace-specific DNS support for CNAME flattening/ALIAS records on an apex domain (`obstack.dev`) — Railway's docs don't mention Squarespace; needs to be verified against Squarespace's own DNS docs.
6. Whether `railway variables --set` (vs. the documented `railway variable set`) is also valid CLI syntax — worth a `railway --help` check before scripting deploys.
7. Any CLI-native rollback command — docs only describe rollback via the dashboard UI.
8. Exact retention window (days/deployment count) for how far back a rollback can reach — described only as "your plan's retention policy," no number given.
9. Whether config-as-code `dockerfilePath` interacts with the per-service Root Directory setting the same way `RAILWAY_DOCKERFILE_PATH` does, or is resolved differently — not explicitly cross-referenced in the docs fetched.
10. A page-level date/version stamp for the pricing figures — none found; treat the $5/$20 figures as "current as of this research pass" only.
