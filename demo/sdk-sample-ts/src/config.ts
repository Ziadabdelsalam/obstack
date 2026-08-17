/**
 * The one setting this app has of its own. It lives here rather than in
 * server.ts because the agent needs it too — the fake model provider is served
 * by this same process, so the port decides the LLM legs' base URL — and a
 * module both of them import keeps that from becoming a require cycle.
 */
export const PORT = Number(process.env.PORT || 8100);
