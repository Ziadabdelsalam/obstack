import {
  API_KEY_SCOPES,
  API_KEY_SCOPE_LABELS,
  MCP_HOST_PLACEHOLDER_ENDPOINT,
  MCP_PROMPTS,
  MCP_TOOLS,
  mcpClientSetups,
} from "@/lib/mcp-types";

/**
 * The MCP docs page's blocks (S8.1 D656/D668), rendered from THE constants the
 * server registers and the live page lists — `MCP_TOOLS`, `MCP_PROMPTS`,
 * `mcpClientSetups` — so the prose and the product cannot diverge: a tool
 * added to the registry appears here on the next build, a step changed in
 * the prompt changes here.
 *
 * A server component: no state, no handlers, nothing shipped to the browser.
 * The docs mount on the marketing image and the app image alike, so this file
 * branches on no data mode and imports nothing from the demo corpus; the
 * endpoint it prints is the host placeholder, the same one the mock page
 * prints, and the token is always the placeholder (D98).
 */

/** The MDX element styling, borrowed so a component block sits flush with prose (`QuickstartSnippets.tsx`). */
const PRE =
  "mt-4 overflow-x-auto rounded-md border border-line bg-raised p-3 font-mono text-[11.5px] leading-relaxed text-ink";
const P = "mt-3.5 text-[13.5px] leading-relaxed text-mid";
const H3 = "mt-7 scroll-mt-24 text-[15px] font-semibold text-ink";
const CODE = "rounded-[3px] font-mono text-[12px] text-ink";
const TABLE = "mt-4 w-full border-collapse text-[13px]";
const TH = "border-b border-line py-1.5 pr-4 text-left font-mono text-[10.5px] uppercase tracking-widest text-faint";
const TD = "border-b border-line/60 py-2 pr-4 align-top text-mid";

/** The three client setups, stacked — the docs have no tab bar because a reader who cannot click is a reader who scrolls. */
export function McpClientSetups() {
  return (
    <>
      {mcpClientSetups(MCP_HOST_PLACEHOLDER_ENDPOINT).map((setup) => (
        <section key={setup.id}>
          <h3 className={H3}>{setup.label}</h3>
          <pre className={PRE}>{setup.snippet}</pre>
        </section>
      ))}
      <p className={P}>
        <code className={CODE}>{MCP_HOST_PLACEHOLDER_ENDPOINT}</code> is your deployment&apos;s own address —
        the MCP page inside the product prints the real one, with the same three snippets filled in.
      </p>
    </>
  );
}

/** The three scopes, one line each — the settings picker's own words. */
export function McpScopes() {
  return (
    <ul className="mt-3.5 list-disc space-y-1 pl-5 text-[13.5px] leading-relaxed text-mid">
      {API_KEY_SCOPES.map((scope) => (
        <li key={scope}>
          <code className={CODE}>{scope}</code> — {API_KEY_SCOPE_LABELS[scope].slice(scope.length + 3)}
        </li>
      ))}
    </ul>
  );
}

/** Every tool the server registers, from the registry. */
export function McpToolsTable() {
  return (
    <table className={TABLE}>
      <thead>
        <tr>
          <th className={TH}>tool</th>
          <th className={TH}>kind</th>
          <th className={TH}>returns</th>
        </tr>
      </thead>
      <tbody>
        {MCP_TOOLS.map((tool) => (
          <tr key={tool.name}>
            <td className={TD}>
              <code className={CODE}>{tool.name}</code>
            </td>
            <td className={`${TD} font-mono text-[11px]`}>{tool.kind}</td>
            <td className={TD}>{tool.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The setup prompt's steps, the same list the server sends the agent. */
export function McpSetupSteps() {
  const [setup] = MCP_PROMPTS;
  return (
    <ol className="mt-3.5 list-decimal space-y-2 pl-5 text-[13.5px] leading-relaxed text-mid">
      {setup.steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}
