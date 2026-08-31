# Squarespace DNS facts for obstack.dev cutover (official docs only)

Note on method: content was retrieved with WebFetch, which runs the raw HTML through a
summarizing pass before returning it to me — the strings below are the closest available
reproduction of Squarespace's wording, not a guaranteed byte-exact copy. Treat quoted
sentences as high-confidence paraphrase/quote hybrids; verify anything load-bearing by
opening the URL directly before you cut over DNS.

---

## 1. Apex/root pointing to an external host (ALIAS/ANAME/CNAME-flattening)

**Answer: Yes — Squarespace DNS supports an ALIAS record type at the apex (`@`) that can
target an arbitrary external hostname.** This is the mechanism to use for Railway's
`*.up.railway.app` CNAME target at the bare `obstack.dev` domain — you do not need to fall
back to forwarding/redirect for the apex.

- URL: https://support.squarespace.com/hc/en-us/articles/31119879125645-DNS-records-for-web-hosting
  - Quote: "In the **Name** field, enter *@*." (ALIAS record instructions)
  - Quote: "In the **Data** field, enter the domain name you're pointing to, like *example.com*." — general external-domain target, not limited to Squarespace's own hosting endpoints.
  - Quote (prerequisite): "Ensure the toggle beside **DNS Security Extensions** is switched off" before adding an ALIAS record — i.e. DNSSEC must be disabled for ALIAS records to be usable.
- URL: https://support.squarespace.com/hc/en-us/articles/360035485391-DNS-records-for-connecting-third-party-domains
  - Quote: "A, AAAA, or ALIAS records conflict due to the name field, so ensure the name field for your A or AAAA record isn't the same as the name field for an ALIAS record." (confirms ALIAS and A/AAAA can't coexist on the same apex name — the four default parking A records at `@` must be removed before/while adding the apex ALIAS.)

**Fallback if ALIAS doesn't work for the Railway target for any reason:** domain forwarding
(redirect) is Squarespace's documented way to send the bare domain traffic to another URL,
but it changes the visible URL (a redirect, not a transparent proxy) — it is NOT the same as
"pointing" to an external host.

- URL: https://support.squarespace.com/hc/en-us/articles/115008288548-Forwarding-vs-pointing-domains
  - Quote (forwarding): "Visitors see the new site. The URL changes to the new site's URL."
  - Quote (pointing): "Visitors see the new site. The URL doesn't change."
  - Quote: pointing requires "a target URL to enter as a CNAME OR an IP address to enter as an A record, from any non-Squarespace site." (This older/general article names only CNAME and A for "pointing," and does not mention ALIAS or CNAME flattening — the ALIAS record described in the newer "DNS records for web hosting" article above is the actual apex mechanism; this article appears to predate/not reflect it.)
- URL: https://support.squarespace.com/hc/en-us/articles/214767107-Forwarding-a-domain
  - Quote: "You can set up domain forwarding to redirect your domain to another URL." Root-domain forwarding is configured by entering "@" for the root domain and specifying the forward-to URL.

**Does forwarding preserve HTTPS?** Partially documented, not fully.

- URL: https://support.squarespace.com/hc/en-us/articles/214767107-Forwarding-a-domain
  - Quote: "Under **Forwarding over SSL**, ... Squarespace recommends keeping SSL On selected." / troubleshooting note: "If an SSL toggle appears and it's switched off, toggle it back on" to fix domains forwarding to the wrong site.
  - The page does not document certificate-coverage mechanics (e.g. whether the forwarded HTTPS request is served by a Squarespace-issued cert before the redirect, or how a visitor's browser experience differs from a native CNAME/ALIAS). **Not documented**: exact HTTPS behavior/certificate details for forwarding.

---

## 2. Ordinary CNAME on subdomains; restrictions on `@`/apex CNAME

**Answer: Subdomain CNAMEs are supported (e.g. `app.obstack.dev`, `ingest.obstack.dev`,
`www`). A CNAME record cannot use `@` as its Name/Host — the apex must use ALIAS (or A)
instead of CNAME.**

- URL: https://support.squarespace.com/hc/en-us/articles/360035485391-DNS-records-for-connecting-third-party-domains
  - Quote: "A CNAME record points a subdomain — which is anything that appears before your root domain, including 'www' — to another domain name."
  - Quote: "CNAME records should always point to a URL, and the URL can't contain special characters such as slashes (/) or colons (:)."
  - Quote: "it's not possible to add a CNAME with @ in the Name field."
- URL: https://support.squarespace.com/hc/en-us/articles/31119879125645-DNS-records-for-web-hosting
  - Quote (same restriction, general DNS-for-hosting article): "It's not possible to add a CNAME with @ in the Name field."
- URL: https://support.squarespace.com/hc/en-us/articles/206542017-Connecting-a-third-party-subdomain-to-your-Squarespace-site
  - (This particular article is about connecting a subdomain *to a Squarespace site*, not to an arbitrary external host like Railway — it documents CNAME-to-Squarespace patterns and notes "All connected subdomains will point to the homepage... It isn't possible to connect a subdomain to a page that isn't your homepage." That restriction is specific to Squarespace-hosted destinations and does not apply to a generic CNAME record you add yourself pointing at `xxxx.up.railway.app` — ordinary user-added CNAME records to any external target follow the general CNAME rules above, not this Squarespace-site-specific restriction.)

**Practical implication for your three names:** `app.obstack.dev`, `ingest.obstack.dev`, and
`www` can each get a standard CNAME record pointing at Railway's `*.up.railway.app`
hostname; only the bare `obstack.dev` apex needs the ALIAS record instead of CNAME.

---

## 3. Removing the default parking A records (198.185.159.x / 198.49.23.x)

**Answer: They are documented as deletable via the DNS records panel; Squarespace's docs do
not state that it re-adds them automatically after a manual deletion — but this is not
explicitly confirmed either way, so treat it as "not documented" for the negative case.**

- URL: https://support.squarespace.com/hc/en-us/articles/205812378-Connect-a-third-party-domain-to-your-Squarespace-site
  - Quote (identifies the four default records by IP): A records at "198.185.159.144", "198.185.159.145", "198.49.23.144", "198.49.23.145".
- URL: https://support.squarespace.com/hc/en-us/articles/31119879125645-DNS-records-for-web-hosting
  - Quote: "When you register a domain with Squarespace, connect a domain via Nameserver Connect, or transfer a domain into Squarespace, the Squarespace defaults are added automatically." (states when they get added — at registration/connect/transfer time — not that they come back after a later manual delete)
  - Quote: "if you remove these records, any PayPal Payment Links won't work." (documents a side effect of removal, confirming removal is a supported, intended action, not something that's blocked)
- URL: https://support.squarespace.com/hc/en-us/articles/360002101888-Edit-your-domain-s-DNS-records
  - Quote: "Ensure you know what records you want to add or delete before editing the records already in place. Deleting or editing a record will affect how your domain connects to a site or email service." — general delete-capability statement; standard DNS panel edit/delete UI applies to these records like any other.
- URL: https://support.squarespace.com/hc/en-us/articles/360035485391-DNS-records-for-connecting-third-party-domains
  - Quote (apex conflict rule, relevant to why you must delete these first): "A, AAAA, or ALIAS records conflict due to the name field, so ensure the name field for your A or AAAA record isn't the same as the name field for an ALIAS record." — i.e. the four default A records at `@` must be deleted (or you'll get a conflict) before adding the apex ALIAS record for Railway.

**Not documented:** whether Squarespace automatically restores/re-adds the four default A
records under any condition after a user manually deletes them (e.g. after certain support
actions, plan changes, or "reset to defaults" flows). No official article located states
either "they will not come back" or "they may reappear."

---

## 4. Transferring the domain / changing nameservers to another DNS provider (e.g. Cloudflare)

**Two distinct paths, both documented:**

### (a) Changing only the nameservers (keep registration at Squarespace, move DNS elsewhere)

- URL: https://support.squarespace.com/hc/en-us/articles/4404183898125-Making-changes-to-nameservers
  - Steps: "Access your domains dashboard and select your domain" → "Click **DNS**, then **Domain Nameservers**" → "Click **Use Custom Nameservers**" → reauthenticate (password or 2FA) → "Click **Continue** when prompted to disable DNSSEC" → enter the new nameservers → "Click **Save**."
  - Quote (warning): "Replacing Squarespace's default nameservers will: Break your domain's link to your site; Disconnect any linked Google Workspace account from your domain, which means you may not be able to send or receive email; Prevent PayPal Payment Links from working."
  - Quote: "If you add custom nameservers to your domain, the records in the domain's Squarespace DNS settings panel won't apply to the domain."
  - Quote (timing): "It can take up to 48 hours for the nameservers to start working properly."
  - **No lock period or Google-Domains-specific restriction is documented for this nameserver-change path** — this article does not mention Google Domains at all.

### (b) Full registrar transfer away from Squarespace

- URL: https://support.squarespace.com/hc/en-us/articles/205812338-Transferring-a-domain-away-from-Squarespace
  - Steps: "switch the **Domain Lock** toggle off" → "Click **Request transfer code**. Enter your current password, or if you have two-factor authentication (2FA) enabled, reauthenticate your account" → Squarespace "sends an email with a unique authentication code to the contact details on the domain... The transfer authentication code should be received within 24 hours" → "Copy the transfer authentication code from this email and send it to your new domain provider."
  - Quote (lock scenarios documented): "If you recently purchased the domain, your domain may have a 60 day registration domain lock applied to it"; "If you recently changed the domain's registrant contact information, you may have enabled the contact update lock"; "If you recently transferred the domain to Squarespace, your domain may have a 60 day transfer domain lock applied to it."
  - **This third bullet is the one that applies to `obstack.dev`**, since it was migrated in from Google Domains: a domain transferred into Squarespace can carry a **60-day transfer lock** before it can be transferred away again.
  - Quote (duration): "Domain transfers can take up to 15 days to complete."

- URL: https://support.squarespace.com/hc/en-us/articles/17131164996365-About-the-Google-Domains-migration-to-Squarespace
  - No lock-period or transfer-restriction language specific to ex-Google-Domains domains was found on this page; it covers account access, permissions, and unavailable features (e.g. Dynamic DNS, ACME certs) post-migration, not lock timing.

**Bottom line:** to point Railway at `obstack.dev` you do **not** need to transfer the domain
or change nameservers at all — the ALIAS record (path 1 above) can be added directly in
Squarespace's own DNS panel while Squarespace stays the DNS host. Nameserver changes /
registrar transfer only matter if you decide to move DNS hosting itself (e.g. to Cloudflare)
instead of using Squarespace's ALIAS record — and if you go the full-transfer route, budget
for a possible 60-day transfer lock inherited from the Google Domains migration.

---

## 5. TTL minimums and propagation notes

- URL: https://support.squarespace.com/hc/en-us/articles/360002101888-Edit-your-domain-s-DNS-records
  - Quote: "The Time To Live (TTL) value for a DNS record controls how long that record stays cached before refreshing. All custom records have a 4-hour TTL by default, but you can change that if you have specific needs for that record."
  - Quote: custom TTL values are entered in seconds, with a documented maximum of "2,147,483,648" seconds.
  - **Not documented:** a minimum TTL value in seconds. No article located states a floor (e.g. 60s, 300s, 3600s) for custom TTL.

- Propagation timing statements found across pages (not a single canonical "propagation" article):
  - URL: https://support.squarespace.com/hc/en-us/articles/205812378-Connect-a-third-party-domain-to-your-Squarespace-site — third-party domain connection typically completes in "24 to 48 hours" after DNS records are added.
  - URL: https://support.squarespace.com/hc/en-us/articles/4404183898125-Making-changes-to-nameservers — nameserver changes: "It can take up to 48 hours for the nameservers to start working properly."
  - URL: https://support.squarespace.com/hc/en-us/articles/205812338-Transferring-a-domain-away-from-Squarespace — full registrar transfer: "up to 15 days to complete."
  - URL: https://support.squarespace.com/hc/en-us/articles/206542017-Connecting-a-third-party-subdomain-to-your-Squarespace-site — if the verification CNAME isn't correctly in place, "the subdomain will unlink from your site after 15 days" (Squarespace-hosted-subdomain-specific behavior, included for completeness though not directly relevant to a Railway-pointed subdomain).

---

## Unknowns (not documented in official Squarespace help docs found)

1. Whether Squarespace automatically re-adds/restores the four default parking A records
   (198.185.159.144/145, 198.49.23.144/145) after a user manually deletes them — no article
   confirms or denies this.
2. Exact HTTPS/TLS certificate mechanics for "domain forwarding" (which cert serves the
   redirect response, whether it's a generic Squarespace cert vs. the destination's) — only
   an "SSL toggle" is documented, not the underlying behavior.
3. Any plan-tier or domain-type restriction on using the ALIAS record type (e.g. whether it
   requires a paid Squarespace website plan vs. being available on a bare domain-only
   account) — not stated in the fetched pages.
4. A documented minimum TTL value (only a 4-hour default and a maximum of 2,147,483,648
   seconds were found).
5. Whether the Google-Domains-migration-specific page documents any lock period at all — it
   does not; the 60-day transfer-lock language comes from the general
   "Transferring-a-domain-away-from-Squarespace" article, not a Google-Domains-specific one,
   so it is inferred to apply (any domain "recently transferred... to Squarespace") rather
   than explicitly named for ex-Google-Domains domains.
