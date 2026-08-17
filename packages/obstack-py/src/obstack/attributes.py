"""The D8 attribute names, in the one module allowed to spell them.

Every attribute obstack-py puts on a span is named here and nowhere else. The
names are not this SDK's to choose: they are the interop contract ingest reads,
declared in services/ingest/internal/mapping/mapping.go, and a typo in any of
them is silent — the span still exports, ingest still stores it, and the row
simply arrives without a model, without tokens and classified into the wrong
layer. Keeping them in one module is what lets the contract owner pin them:
services/ingest/internal/mapping/sdk_contract_test.go reads this file and fails
the every-PR `go` job when a literal here stops matching mapping.go.

Layers are absent on purpose. Ingest derives `layer` from the attributes below —
any `gen_ai.*` makes a span llm, `obstack.agent.step` makes it agent,
`obstack.tool.name` makes it tool — so an SDK that also stated a layer would be
asserting a classification it does not own.

# D8 literals this SDK deliberately does not emit

`gen_ai.response.finish_reason` — the scalar form. D8's amendment accepts either
it or the array below; obstack-py emits the array, because that is what the
GenAI semantic conventions specify and what real provider instrumentations
produce. Ingest reads element [0] of the array into its singular column.

`http.request.method` and `http.route` — the two attributes that classify a span
into the api layer. They come from the stock HTTP/framework instrumentation
init() turns on, never from obstack code; init()'s default of
OTEL_SEMCONV_STABILITY_OPT_IN=http is what keeps them from arriving as the
legacy `http.method`, which classifies as `other` instead.

`gen_ai.input.messages` and `gen_ai.output.messages` — the log-record wire form
of prompt and completion (D38 FINAL / D42). obstack-py carries GenAI content on
span attributes only; the second form exists for upstream's Events API and is
not a shape this SDK produces.
"""

# The GenAI span attributes ingest unpacks into obstack.spans' dedicated columns.
GEN_AI_SYSTEM = "gen_ai.system"
GEN_AI_REQUEST_MODEL = "gen_ai.request.model"
GEN_AI_RESPONSE_MODEL = "gen_ai.response.model"
GEN_AI_INPUT_TOKENS = "gen_ai.usage.input_tokens"
GEN_AI_OUTPUT_TOKENS = "gen_ai.usage.output_tokens"
GEN_AI_PROMPT = "gen_ai.prompt"
GEN_AI_COMPLETION = "gen_ai.completion"
GEN_AI_FINISH_REASONS = "gen_ai.response.finish_reasons"

# The two obstack-owned attributes: the only names in this file that are not
# borrowed from the semantic conventions, and the ones that make an ordinary
# INTERNAL span an agent step or a tool call.
AGENT_STEP = "obstack.agent.step"
TOOL_NAME = "obstack.tool.name"

# `gen_ai.system` values. Provider identity is a literal per provider rather than
# anything read off the client, so a customer's proxy or gateway base_url cannot
# rename the system ingest prices against.
SYSTEM_OPENAI = "openai"
SYSTEM_ANTHROPIC = "anthropic"
