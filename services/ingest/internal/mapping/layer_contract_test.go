// The span layer vocabulary is declared three times in three languages: the
// Enum8 on obstack.spans, the Layer* constants in this package, and the Layer
// union in the web app's src/lib/types.ts. Nothing in either build makes them
// agree. The expensive divergence is Go emitting a layer the Enum8 does not
// contain — ClickHouse rejects the INSERT, so the drift surfaces as dropped
// telemetry in production ingest rather than as a red build. A TS/SQL
// divergence is cheaper but silent: src/server/adapters.ts relabels any layer
// it does not recognise as "other", so an LLM span quietly loses its model,
// tokens and cost.
//
// This file reads all three declarations out of their real sources and compares
// them, so the person changing the mapper learns about it from `go test ./...`.
// Every vocabulary here is derived by parsing; nothing restates it. A test that
// kept its own copy of the layer list would be a fourth place to update, which
// is the failure it exists to prevent. The one exception is the ordinal table
// below, pinned for the reason given there.

package mapping_test

import (
	"io/fs"
	"maps"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"

	"go/ast"
	"go/parser"
	"go/token"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/migrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/migrations"
)

// The Enum8 ordinals, pinned — the one fact this file refuses to derive.
// ClickHouse stores the ordinal, not the name, so renumbering the enum
// reinterprets every row already on disk: yesterday's 'llm' spans read back as
// 'tool', with no error anywhere and no migration that can undo it, because the
// old numbers are gone. Deriving the numbers from the SQL would make that
// rewrite invisible; hardcoding them makes it a deliberate edit to this table,
// reviewed alongside whatever rewrites the stored rows.
//
// The cost is that a genuinely new layer needs an edit here as well as in the
// three sources. That friction is the point: an ordinal, once written to disk,
// is permanent. Nothing else in this file consults this map — the cross-source
// checks compare parsed source against parsed source, never against this list.
var frozenLayerOrdinals = map[string]int8{
	"other": 0,
	"api":   1,
	"agent": 2,
	"tool":  3,
	"llm":   4,
	"infra": 5,
}

const (
	// Sibling of this test; parsed for the Layer* constants and the package doc.
	mappingFile = "mapping.go"
	// Relative to the repo root, not the Go module root.
	tsTypesFile = "src/lib/types.ts"
)

// Anchored on the column name because 0001_spans.sql holds three Enum8 columns
// and `kind` comes first. Spans newlines so a reformatted, wrapped declaration
// is still read whole rather than truncated to its first line.
var layerColumnRE = regexp.MustCompile(`(?m)^\s*layer\s+Enum8\s*\(([^)]*)\)`)

// ClickHouse writes the members as `'name' = N`, spaces included, and an Enum8
// ordinal may be negative.
var enumMemberRE = regexp.MustCompile(`'([^']*)'\s*=\s*(-?\d+)`)

// The package doc is where 'infra' is declared reserved. Parsing the sentence
// rather than keeping a list of allowances means the prose is the contract: a
// layer the Enum8 has and Go does not is only tolerated while the doc says why.
var reservedLayerRE = regexp.MustCompile(`'([a-z_]+)' is reserved`)

// Anchored past the `=` on purpose: the JSDoc line directly above the union
// contains the quoted word "other", and a file-wide scan would harvest it as a
// phantom member — invisible for exactly as long as "other" is a real member.
var tsUnionRE = regexp.MustCompile(`(?s)export\s+type\s+Layer\s*=\s*(.*?);`)

var tsMemberRE = regexp.MustCompile("[\"'`]([^\"'`]*)[\"'`]")

// The Go constants are what the writer actually sends. A constant whose value
// is not in the Enum8 is the failure that costs a production batch.
func TestGoLayerConstantsMatchEnum8(t *testing.T) {
	enum, sqlFile := enumLayers(t)
	consts, reserved := goLayerConstants(t)

	// Constant name -> layer, inverted. Iterating sorted keeps the first
	// constant for a layer stable, so a duplicate report names the same pair
	// every run instead of following map order.
	byLayer := map[string]string{}
	for _, name := range slices.Sorted(maps.Keys(consts)) {
		layer := consts[name]
		if prev, dup := byLayer[layer]; dup {
			t.Errorf("layer %q has two constants in %s, %s and %s", layer, mappingFile, prev, name)
		} else {
			byLayer[layer] = name
		}
		if _, ok := enum[layer]; !ok {
			t.Errorf("%s = %q in %s is not a value of the layer Enum8 in %s — ClickHouse rejects the whole INSERT batch as soon as the mapper emits it, so this drift lands as dropped spans in production, not as a failed build", name, layer, mappingFile, sqlFile)
		}
	}

	for _, layer := range slices.Sorted(maps.Keys(enum)) {
		name, hasConst := byLayer[layer]
		switch {
		case hasConst && reserved[layer]:
			t.Errorf("the %s package doc reserves layer %q, but %s exists — the doc is stale, or the constant should not have been added", mappingFile, layer, name)
		case hasConst, reserved[layer]:
			// Either Go can emit it, or the doc says why it never will.
		default:
			t.Errorf("layer %q is a value of the Enum8 in %s but has no Layer* constant in %s and the package doc does not reserve it — add the constant, or say in the doc why the mapper never emits it", layer, sqlFile, mappingFile)
		}
	}

	for _, layer := range slices.Sorted(maps.Keys(reserved)) {
		if _, ok := enum[layer]; !ok {
			t.Errorf("the %s package doc reserves layer %q, which is not a value of the layer Enum8 in %s", mappingFile, layer, sqlFile)
		}
	}
}

// The web app types the same vocabulary independently, and its adapter coerces
// anything it does not recognise, so drift here is silent in both directions.
func TestTypeScriptLayerUnionMatchesEnum8(t *testing.T) {
	enum, sqlFile := enumLayers(t)
	union := tsLayerUnion(t)

	for _, layer := range slices.Sorted(maps.Keys(union)) {
		if _, ok := enum[layer]; !ok {
			t.Errorf("layer %q is a member of the Layer union in %s but not a value of the Enum8 in %s — the UI is typed for a layer ClickHouse can never store", layer, tsTypesFile, sqlFile)
		}
	}
	for _, layer := range slices.Sorted(maps.Keys(enum)) {
		if !union[layer] {
			t.Errorf("layer %q is a value of the Enum8 in %s but missing from the Layer union in %s — rows carrying it reach the web adapter, fail its membership check and are relabelled \"other\" with no error", layer, sqlFile, tsTypesFile)
		}
	}
}

// Guards the numbers rather than the names: see frozenLayerOrdinals.
func TestLayerEnum8OrdinalsAreFrozen(t *testing.T) {
	enum, sqlFile := enumLayers(t)

	for _, layer := range slices.Sorted(maps.Keys(frozenLayerOrdinals)) {
		want := frozenLayerOrdinals[layer]
		got, ok := enum[layer]
		if !ok {
			t.Errorf("layer %q = %d in the frozen ordinal table but is gone from the Enum8 in %s — every row already stored under that ordinal is now unreadable", layer, want, sqlFile)
			continue
		}
		if got != want {
			t.Errorf("layer %q = %d in %s, want %d — renumbering reinterprets every row already on disk; if the rows are being rewritten too, edit the frozen table in the same change", layer, got, sqlFile, want)
		}
	}

	for _, layer := range slices.Sorted(maps.Keys(enum)) {
		if _, ok := frozenLayerOrdinals[layer]; !ok {
			t.Errorf("layer %q = %d is new in %s and absent from the frozen ordinal table — add it there once the ordinal is final, because it can never be changed afterwards", layer, enum[layer], sqlFile)
		}
	}
}

// enumLayers reads the layer vocabulary out of the embedded schema and reports
// the migration it came from. It reads through migrations.FS rather than a
// relative path because that is the same byte-for-byte copy the service applies
// at boot: a migration renamed, moved or dropped from the embed pattern changes
// what ClickHouse gets, and the test follows it instead of reading a file the
// binary no longer ships.
func enumLayers(t *testing.T) (map[string]int8, string) {
	t.Helper()

	names, err := fs.Glob(migrations.FS, "*.sql")
	if err != nil {
		t.Fatalf("list embedded migrations: %v", err)
	}

	type match struct{ file, members string }
	var matches []match
	for _, name := range names {
		body, err := fs.ReadFile(migrations.FS, name)
		if err != nil {
			t.Fatalf("read embedded migration %s: %v", name, err)
		}
		// Split with the migration runner's own splitter, which already strips
		// `--` comments: 0001 carries both a semicolon and a quoted 'other'
		// inside the three comment lines immediately above the layer column, so
		// a scanner that reads the raw file finds phantom members and a bogus
		// statement boundary. Sharing the splitter also means a regression in it
		// breaks this test rather than leaving it quietly parsing a comment.
		for _, stmt := range migrate.SplitStatements(string(body)) {
			for _, m := range layerColumnRE.FindAllStringSubmatch(stmt, -1) {
				matches = append(matches, match{name, m[1]})
			}
		}
	}

	// A parser that finds nothing must say so. Comparing an empty set against
	// the other two would pass every assertion below while checking nothing,
	// and a contract test that passes vacuously is worse than no test.
	if len(matches) == 0 {
		t.Fatalf("no `layer Enum8(...)` column in any of the %d embedded migrations (%s) — the declaration moved or was reformatted past what layerColumnRE reads, and this test was about to compare an empty vocabulary", len(names), strings.Join(names, ", "))
	}
	if len(matches) > 1 {
		var where []string
		for _, m := range matches {
			where = append(where, m.file)
		}
		t.Fatalf("%d `layer Enum8(...)` columns across the migrations (%s), want exactly one authoritative declaration", len(matches), strings.Join(where, ", "))
	}

	found := matches[0]
	layers := map[string]int8{}
	for _, m := range enumMemberRE.FindAllStringSubmatch(found.members, -1) {
		// bitSize 8 rejects an ordinal that would not fit an Enum8 at all.
		n, err := strconv.ParseInt(m[2], 10, 8)
		if err != nil {
			t.Fatalf("layer %q = %s in %s is not an Enum8 ordinal: %v", m[1], m[2], found.file, err)
		}
		if _, dup := layers[m[1]]; dup {
			t.Fatalf("layer %q is declared twice in the Enum8 in %s", m[1], found.file)
		}
		layers[m[1]] = int8(n)
	}
	// Whatever the member pattern did not consume is text this parser did not
	// understand — an escaped quote in a name, a member with no ordinal. Better
	// to stop than to hand back a vocabulary that is silently short a member.
	if rest := strings.Trim(enumMemberRE.ReplaceAllString(found.members, ""), ", \t\r\n"); rest != "" {
		t.Fatalf("unparsed text %q left in the layer Enum8 in %s: %q", rest, found.file, found.members)
	}
	if len(layers) == 0 {
		t.Fatalf("the layer Enum8 in %s parsed to no members at all: %q", found.file, found.members)
	}
	return layers, found.file
}

// goLayerConstants returns the Layer* constants by name -> layer value, plus the
// layers the package doc declares reserved. It walks the AST rather than
// matching text because mapping.go holds three const blocks, gofmt pads the `=`
// to a variable width, and the package doc restates the whole vocabulary in
// prose — an AST walk sees none of that, and cannot mistake a comment for a
// declaration.
func goLayerConstants(t *testing.T) (map[string]string, map[string]bool) {
	t.Helper()

	path := filepath.Join(packageDir(t), mappingFile)
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
	if err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}

	// The `Layer` prefix is the anchor: these constants are the vocabulary, so a
	// new one that does not carry the prefix is invisible here by construction.
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
				if !strings.HasPrefix(name.Name, "Layer") {
					continue
				}
				if i >= len(vs.Values) {
					t.Fatalf("%s in %s has no value — a layer constant must spell its own string", name.Name, mappingFile)
				}
				lit, ok := vs.Values[i].(*ast.BasicLit)
				if !ok || lit.Kind != token.STRING {
					t.Fatalf("%s in %s is not a plain string literal — the layer written to ClickHouse has to be readable from the source", name.Name, mappingFile)
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
		t.Fatalf("no Layer* constants found in %s — they were renamed or moved out of the package, and this test was about to compare an empty vocabulary against the Enum8", path)
	}

	// No emptiness guard on the reserved set: an empty one is legitimate, and if
	// the doc sentence is reworded the reserved layer simply loses its excuse
	// and TestGoLayerConstantsMatchEnum8 fails naming it. That is the loud path.
	reserved := map[string]bool{}
	if file.Doc != nil {
		for _, m := range reservedLayerRE.FindAllStringSubmatch(file.Doc.Text(), -1) {
			reserved[m[1]] = true
		}
	}
	return consts, reserved
}

// tsLayerUnion returns the members of the Layer union in the web app.
func tsLayerUnion(t *testing.T) map[string]bool {
	t.Helper()

	path := filepath.Join(repoRoot(t), tsTypesFile)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}

	decl := tsUnionRE.FindSubmatch(body)
	if decl == nil {
		t.Fatalf("no `export type Layer = ...;` in %s — the union was renamed or moved, and this test was about to compare an empty vocabulary against the Enum8", path)
	}

	union := map[string]bool{}
	for _, m := range tsMemberRE.FindAllSubmatch(decl[1], -1) {
		union[string(m[1])] = true
	}
	// Prettier reflows the union to a leading-pipe multi-line form the moment it
	// outgrows the print width, so pipes and whitespace are all that may remain.
	// Anything else means the declaration grew a shape this parser misreads.
	if rest := strings.Trim(string(tsMemberRE.ReplaceAll(decl[1], nil)), "| \t\r\n"); rest != "" {
		t.Fatalf("unparsed text %q left in the Layer union in %s: %q", rest, path, decl[1])
	}
	if len(union) == 0 {
		t.Fatalf("the Layer union in %s parsed to no members at all: %q", path, decl[1])
	}
	return union
}

// packageDir locates this package's own sources. `go test` sets the working
// directory to the package directory, so mapping.go would resolve from there —
// but a binary built with `go test -c` and run elsewhere would not, and neither
// would the repo-relative TypeScript path. runtime.Caller(0) is this file's
// compile-time path and is independent of both; the working directory is only a
// fallback for builds that strip paths (-trimpath). Neither is trusted without
// checking the source is actually there.
func packageDir(t *testing.T) string {
	t.Helper()

	var tried []string
	if _, file, _, ok := runtime.Caller(0); ok {
		tried = append(tried, filepath.Dir(file))
	}
	if wd, err := os.Getwd(); err == nil {
		tried = append(tried, wd)
	}
	for _, dir := range tried {
		if _, err := os.Stat(filepath.Join(dir, mappingFile)); err == nil {
			return dir
		}
	}
	t.Fatalf("cannot locate %s from %s — the layer contract cannot be checked against sources this test cannot find", mappingFile, strings.Join(tried, " or "))
	return ""
}

// repoRoot walks out of internal/mapping to the repo root, which is four levels
// up and two above the Go module: the TypeScript half of the contract lives
// outside the module entirely, so there is no go:embed path to it.
func repoRoot(t *testing.T) string {
	t.Helper()

	root := filepath.Clean(filepath.Join(packageDir(t), "..", "..", "..", ".."))
	if _, err := os.Stat(filepath.Join(root, tsTypesFile)); err != nil {
		t.Fatalf("no %s under %s — services/ingest moved relative to the web app, or was checked out on its own; either way the Go/TypeScript half of the layer contract is unverified", tsTypesFile, root)
	}
	return root
}
