import { API_KEY_PLACEHOLDER } from "@/components/connections/connectors";
import { snippetsFor } from "@/components/onboarding/snippets";
import { OTLP_GRPC_ENDPOINT, OTLP_HTTP_ENDPOINT } from "@/lib/ingest-endpoint";

/**
 * The two things a docs page may NOT spell for itself (D322): the quickstart's
 * three snippets, and the SDK environment table they come from.
 *
 * `src/content/docs/README.md` states the rule and `Quickstart.test.ts`
 * enforces it — no line of the corpus may carry an install command or an
 * `OTEL_EXPORTER_OTLP_*` assignment, because a copy in prose is a second
 * definition of the command a stranger pastes into a terminal, and it goes
 * stale silently. Both components below render from the ONE definition
 * instead: `@/components/onboarding/snippets` (shared with the in-app
 * quickstart) and, for the table, the obstack-py README, which
 * `src/lib/docs/mirror.test.ts` re-reads as text and compares row by row.
 *
 * A server component: no state, no handlers, nothing shipped to the browser.
 * The docs mount on the marketing image and the app image alike, so this file
 * branches on no data mode and imports nothing from the demo corpus.
 */

/** The MDX element styling, borrowed so a component block sits flush with prose. */
const PRE =
  "mt-4 overflow-x-auto rounded-md border border-line bg-raised p-3 font-mono text-[11.5px] leading-relaxed text-ink";
const P = "mt-3.5 text-[13.5px] leading-relaxed text-mid";
const H3 = "mt-7 scroll-mt-24 text-[15px] font-semibold text-ink";

/**
 * The three tabs, stacked — the docs have no tab bar because a reader who
 * cannot click is a reader who scrolls, and a printed page shows all three.
 *
 * The addresses are the compose defaults (`@/lib/ingest-endpoint`, D215), so
 * the snippets are copy-pasteable against a `docker compose up` install with
 * nothing to substitute but the key. A `<your endpoint>` placeholder would be
 * a third definition of nothing and would break the paste (D322).
 */
export function QuickstartSnippets() {
  const tabs = snippetsFor(API_KEY_PLACEHOLDER, {
    http: OTLP_HTTP_ENDPOINT,
    grpc: OTLP_GRPC_ENDPOINT,
  });
  // The D282 corner, rendered from the same function rather than retold: a
  // deployment that publishes gRPC only gets no HTTP snippet on the SDK tabs,
  // and this is the sentence the in-app quickstart puts there instead.
  const httpAbsence = snippetsFor(API_KEY_PLACEHOLDER, {
    http: null,
    grpc: OTLP_GRPC_ENDPOINT,
  }).find((tab) => tab.absence !== null)?.absence;

  return (
    <>
      {tabs.map((tab) => (
        <section key={tab.id}>
          <h3 className={H3}>{tab.label}</h3>
          {tab.code === null ? (
            <p className={P}>{tab.absence}</p>
          ) : (
            <pre className={PRE}>{tab.code}</pre>
          )}
        </section>
      ))}
      <p className={P}>
        Those addresses are the ones a compose install publishes on the machine it runs on; your
        deployment&apos;s own endpoint is on the in-app quickstart, which fills the key slot in as
        well.
      </p>
      <h3 className={H3}>If your deployment publishes gRPC only</h3>
      <p className={P}>
        Both SDKs export OTLP over HTTP. Where an operator has published the gRPC port and not the
        HTTP one, the Python and TypeScript snippets above are not shown at all — the in-app
        quickstart puts this in their place, and the third snippet still works as written with the
        protocol set to <code className="rounded-[3px] font-mono text-[12px] text-ink">grpc</code>:
      </p>
      <p className={P}>{httpAbsence}</p>
    </>
  );
}

/**
 * obstack-py's environment table (`packages/obstack-py/README.md`, "Environment").
 *
 * Mirrored, not retyped: `mirror.test.ts` reads that README as text and
 * requires every cell below to appear in it. The endpoint example is
 * interpolated from `@/lib/ingest-endpoint` for the same reason the snippets
 * are — one definition of the address (D215).
 */
const OTEL_ENV_ROWS: readonly (readonly [string, string])[] = [
  ["OTEL_SERVICE_NAME", "service name on every span and log"],
  ["OTEL_EXPORTER_OTLP_ENDPOINT", `OTLP/HTTP base URL, e.g. ${OTLP_HTTP_ENDPOINT}`],
  ["OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf"],
  [
    "OTEL_EXPORTER_OTLP_HEADERS",
    "Authorization=Bearer%20<key> — URL-encoded, the SDK drops a header with a raw space",
  ],
  [
    "OTEL_SEMCONV_STABILITY_OPT_IN",
    "init() defaults it to http; without it FastAPI emits the legacy http.method and the api layer disappears",
  ],
  ["OTEL_BSP_SCHEDULE_DELAY / OTEL_BLRP_SCHEDULE_DELAY", "export interval, ms"],
];

/** The rows as data, for the mirror test — the component renders exactly these. */
export const otelEnvRows = OTEL_ENV_ROWS;

export function OtelEnvTable() {
  return (
    <div className="mt-4 overflow-x-auto">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            <th className="border-b border-line-strong px-2.5 py-1.5 text-left font-medium text-ink">
              Variable
            </th>
            <th className="border-b border-line-strong px-2.5 py-1.5 text-left font-medium text-ink">
              Purpose
            </th>
          </tr>
        </thead>
        <tbody>
          {OTEL_ENV_ROWS.map(([variable, purpose]) => (
            <tr key={variable}>
              <td className="border-b border-line px-2.5 py-1.5 align-top text-mid">
                <code className="rounded-[3px] font-mono text-[12px] text-ink">{variable}</code>
              </td>
              <td className="border-b border-line px-2.5 py-1.5 align-top text-mid">{purpose}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
