// The D8 span-attribute names are now spelled in three languages: the attr*
// constants in mapping.go, `packages/obstack-py/src/obstack/attributes.py` and
// `packages/obstack-js/src/attributes.ts`. Nothing in any of the three builds
// makes them agree, and the drift is silent in the worst way: an SDK that emits
// `gen_ai.usege.input_tokens` still exports, ingest still stores the span, and
// the row simply arrives with no tokens, no cost and — if the typo is in every
// gen_ai name — classified `other` instead of `llm`. Nobody sees a failure; a
// customer sees a trace missing its model.
//
// The contract owner pins its consumers (D81): this file reads all three
// declarations out of their real sources and compares them, so the person
// changing an attribute name learns about it from the every-PR `go` job rather
// than from a customer's empty column. It is the single sanctioned test-only
// exception to "no ingest changes" in S2.4 — it asserts about the SDKs, it does
// not change what ingest does.
//
// The SDK side of each comparison is PARSED, never restated: a test that kept
// its own copy of the names would be a fourth place to update. What is stated
// here is the one thing no parser can derive — which of ingest's attributes
// each SDK is responsible for emitting (sdkAttributeDuties below). D86 covers
// the other half of the drift chain: each SDK's own conformance tests restate
// the literals independently on the test side, so mapping.go ↔ attributes
// module is checked here and attributes module ↔ emitted span is checked there.
//
// Precondition this file enforces by construction (D81/D86): each SDK keeps its
// D8 literals in exactly ONE shipped module, the two named below.

package mapping_test

import (
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"

	"go/ast"
	"go/parser"
	"go/token"
)

const (
	// Both relative to the repo root, not the Go module root — the SDKs live
	// outside this module entirely, so there is no go:embed path to them.
	pyAttributesFile = "packages/obstack-py/src/obstack/attributes.py"
	tsAttributesFile = "packages/obstack-js/src/attributes.ts"
)

// What each attribute in mapping.go means for the two SDKs. This table is the
// one restatement in the file, and it exists because the split cannot be
// derived: `gen_ai.prompt` and `http.request.method` are both attributes ingest
// reads, but only one of them is an obstack SDK's to emit. Every attr*
// constant in mapping.go must appear here — TestEveryIngestAttributeHasAnSDKDuty
// fails otherwise, so a new D8 attribute forces a deliberate decision about the
// SDKs instead of silently landing outside their contract.
var sdkAttributeDuties = map[string]bool{
	// The GenAI set both SDKs emit on every LLM span (D8 + D82).
	"attrGenAISystem":        true,
	"attrGenAIRequestModel":  true,
	"attrGenAIResponseModel": true,
	"attrGenAIInputTokens":   true,
	"attrGenAIOutputTokens":  true,
	"attrGenAIPrompt":        true,
	"attrGenAICompletion":    true,
	"attrGenAIFinishReasons": true,

	// The two obstack-owned attributes: what makes an ordinary INTERNAL span an
	// agent step or a tool call, and the only names in the contract that are not
	// borrowed from the semantic conventions.
	"attrAgentStep": true,
	"attrToolName":  true,

	// The scalar finish reason. D8-AMENDMENT accepts either it or the array
	// form; D82 picks the array, so neither SDK declares this name. Checking for
	// it would also prove nothing — it is a prefix of the array name, so a
	// verbatim search finds it in a file that never mentions the scalar at all.
	"attrGenAIFinishReason": false,

	// The api layer's two attributes. They come from the stock HTTP/framework
	// instrumentation init() turns on, never from obstack code, which is exactly
	// why the SDKs do not spell them (the Python side does document the
	// OTEL_SEMCONV_STABILITY_OPT_IN default that keeps them from arriving as the
	// legacy `http.method`).
	"attrHTTPMethod": false,
	"attrHTTPRoute":  false,

	// The log-record wire form of prompt and completion (D38 FINAL / D42):
	// upstream's Events API, not obstack's. The SDKs carry GenAI content on span
	// attributes only, so an SDK declaring either of these would be producing a
	// shape it has no code for.
	"attrGenAIInputMessages":  false,
	"attrGenAIOutputMessages": false,

	// Resource attributes, promoted to their own columns by ingest (D7). They
	// are set by the OTel SDK from OTEL_SERVICE_NAME and by the collector's
	// k8sattributes stage — no obstack SDK writes them.
	"attrServiceName":  false,
	"attrK8sNamespace": false,
	"attrK8sPod":       false,
	"attrK8sContainer": false,
	"attrK8sNode":      false,
}

// Module-level constants in the Python module: NAME = "value". Anchored at the
// start of the line so the names quoted throughout the module docstring — which
// deliberately discusses the attributes it does NOT declare — are not harvested
// as declarations.
var pyConstRE = regexp.MustCompile(`(?m)^([A-Z][A-Z0-9_]*)\s*=\s*"([^"]*)"`)

// The TypeScript equivalent. `export const` rather than any assignment, for the
// same reason: attributes.ts documents the two names it deliberately omits in a
// JSDoc block directly above the declarations it does make.
var tsConstRE = regexp.MustCompile(`(?m)^export const ([A-Za-z][A-Za-z0-9_]*)\s*=\s*"([^"]*)"`)

// Each SDK module must declare exactly the attributes it owes ingest — no
// fewer (a missing name is a column that never fills) and no more (a name
// ingest does not read is a span attribute nobody will ever query).
func TestSDKAttributeModulesMatchTheD8Contract(t *testing.T) {
	owed, namespaces := sdkOwedAttributes(t)

	for _, sdk := range []struct {
		file string
		re   *regexp.Regexp
	}{
		{pyAttributesFile, pyConstRE},
		{tsAttributesFile, tsConstRE},
	} {
		declared := sdkDeclaredAttributes(t, sdk.file, sdk.re)

		// Only the namespaces the contract itself uses. An SDK constant like
		// SYSTEM_OPENAI = "openai" is a VALUE of gen_ai.system, not an attribute
		// name, and has no business in this comparison.
		inNamespace := map[string]string{}
		for name, value := range declared {
			for _, ns := range namespaces {
				if strings.HasPrefix(value, ns) {
					inNamespace[value] = name
				}
			}
		}

		for _, attr := range slices.Sorted(maps.Keys(owed)) {
			if _, ok := inNamespace[attr]; !ok {
				t.Errorf("%s does not declare %q, which %s reads (%s) — an SDK that stops emitting it produces spans whose column arrives empty, with no error anywhere; add it, or the SDK is no longer D8-conformant", sdk.file, attr, mappingFile, owed[attr])
			}
		}

		for _, attr := range slices.Sorted(maps.Keys(inNamespace)) {
			if _, ok := owed[attr]; !ok {
				t.Errorf("%s declares %q as %s, and %s reads no such attribute — check it against the contract in %s's package doc: a near-miss (a typo, a renamed semconv key) exports fine and lands as a span with the column unfilled and, for gen_ai.*, possibly the wrong layer", sdk.file, attr, inNamespace[attr], mappingFile, mappingFile)
			}
		}
	}
}

// Guards the table above rather than the SDKs: a new attribute in mapping.go is
// a new decision about what the SDKs emit, and the cheapest place to make it
// wrongly is by not making it at all.
func TestEveryIngestAttributeHasAnSDKDuty(t *testing.T) {
	consts := goAttributeConstants(t)

	for _, name := range slices.Sorted(maps.Keys(consts)) {
		if _, ok := sdkAttributeDuties[name]; !ok {
			t.Errorf("%s = %q is new in %s and unclassified in sdkAttributeDuties — say whether the obstack SDKs emit it (and add it to both attributes modules) or why they never will", name, consts[name], mappingFile)
		}
	}
	for _, name := range slices.Sorted(maps.Keys(sdkAttributeDuties)) {
		if _, ok := consts[name]; !ok {
			t.Errorf("sdkAttributeDuties classifies %s, which no longer exists in %s — the constant was renamed or removed, and the duty it described is now unenforced", name, mappingFile)
		}
	}
}

// sdkOwedAttributes returns the attribute values the SDKs must declare, mapped
// to the Go constant they come from, plus the namespaces those values live in
// (`gen_ai.`, `obstack.`) derived from the values themselves — the comparison
// above needs a way to tell an attribute name from an attribute value, and
// deriving it here keeps that from becoming a second hardcoded list.
func sdkOwedAttributes(t *testing.T) (map[string]string, []string) {
	t.Helper()

	consts := goAttributeConstants(t)
	owed := map[string]string{}
	seen := map[string]bool{}
	var namespaces []string
	for name, value := range consts {
		if !sdkAttributeDuties[name] {
			continue
		}
		owed[value] = name
		ns, _, found := strings.Cut(value, ".")
		if !found {
			t.Fatalf("%s = %q in %s has no namespace — every D8 attribute name is dotted, and this test derives the namespaces it compares on from these values", name, value, mappingFile)
		}
		if !seen[ns+"."] {
			seen[ns+"."] = true
			namespaces = append(namespaces, ns+".")
		}
	}
	// A parser that finds nothing must say so: an empty contract would let every
	// assertion above pass while comparing two empty sets.
	if len(owed) == 0 {
		t.Fatalf("no attribute in %s is marked as SDK-emitted in sdkAttributeDuties — this test was about to check the SDKs against an empty contract", mappingFile)
	}
	slices.Sort(namespaces)
	return owed, namespaces
}

// goAttributeConstants returns mapping.go's attr* constants by name -> value.
// An AST walk rather than a text match, for the reason goLayerConstants gives:
// the file holds several const blocks, gofmt pads the `=` to a variable width,
// and the package doc restates the whole contract in prose — an AST walk cannot
// mistake the doc for a declaration.
func goAttributeConstants(t *testing.T) map[string]string {
	t.Helper()

	path := filepath.Join(packageDir(t), mappingFile)
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}

	// The `attr` prefix is the anchor, the same way `Layer` is in
	// layer_contract_test.go: an attribute constant that does not carry it is
	// invisible here by construction, which is what TestEveryIngestAttributeHas…
	// cannot catch and a reviewer must.
	consts := map[string]string{}
	for _, decl := range file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for i, name := range vs.Names {
				if !strings.HasPrefix(name.Name, "attr") {
					continue
				}
				if i >= len(vs.Values) {
					t.Fatalf("%s in %s has no value — an attribute constant must spell its own string", name.Name, mappingFile)
				}
				lit, ok := vs.Values[i].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					t.Fatalf("%s in %s is not a plain string literal — the attribute name read off the wire has to be readable from the source", name.Name, mappingFile)
				}
				value, err := strconv.Unquote(lit.Value)
				if err != nil {
					t.Fatalf("unquote %s in %s: %v", name.Name, mappingFile, err)
				}
				consts[name.Name] = value
			}
		}
	}
	if len(consts) == 0 {
		t.Fatalf("no attr* constants found in %s — they were renamed or moved out of the package, and this test was about to compare the SDKs against an empty contract", path)
	}
	return consts
}

// sdkDeclaredAttributes returns one SDK module's declared string constants by
// name -> value.
func sdkDeclaredAttributes(t *testing.T, file string, re *regexp.Regexp) map[string]string {
	t.Helper()

	path := filepath.Join(repoRoot(t), file)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v — D81 requires each SDK to keep its D8 literals in exactly this module, so a missing file is the contract being unverifiable, not a skip", path, err)
	}

	declared := map[string]string{}
	for _, m := range re.FindAllStringSubmatch(string(body), -1) {
		if prev, dup := declared[m[1]]; dup {
			t.Fatalf("%s declares %s twice, as %q and %q", file, m[1], prev, m[2])
		}
		declared[m[1]] = m[2]
	}
	// Same reason as everywhere else in this file: a module that parsed to
	// nothing would pass the "declares nothing it should not" half silently.
	if len(declared) == 0 {
		t.Fatalf("no string constants parsed out of %s — the declaration style changed past what this test reads, and it was about to compare an empty module against the contract", path)
	}
	return declared
}
