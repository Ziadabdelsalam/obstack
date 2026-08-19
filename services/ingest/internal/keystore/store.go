// Package keystore resolves API keys against Postgres, which is the one
// authority for them (D98): OBSTACK_API_KEYS is deleted and no second lookup
// path exists. A token resolves by the SHA-256 of its exact string against
// api_keys.token_hash — the same contract the web app hashes with at issue time
// — and the token's shape is never inspected, so the seeded `ok_dev_local` dev
// row and an issued `ok_live_…` resolve through identical code (D139).
//
// It holds two maps behind one mutex, on one TTL, with one staleness story
// (D164): a token map from token hash to the auth.Identity it names, and a
// workspace map from workspace to the state the write path needs — whether the
// workspace is over its plan's quota, and the price table its D108 overrides
// were already layered into. Workspace state is refreshed piggyback on a token
// round trip, so it costs no extra trip of its own, and State reads it without
// ever blocking: the consume path must never wait on Postgres. The table is
// built here, on that refresh, and never on the export path (D167/D174) — the
// layering sorts, so building it per export would put a sort in the hot path to
// produce the same table thirty seconds' worth of exports already share.
//
// Lookups are cached read-through, positive and negative alike, for
// keyCacheTTL. A Postgres round trip per export would make the control plane a
// dependency of the data path, and ingest is never the customer's outage
// (PRD §9). The cost is stated rather than hidden: a revoked key keeps working
// for up to keyCacheTTL, and a quota crossing is honored within it.
//
// # The failure asymmetry, on the record (D164d)
//
// Auth is fail-static: when Postgres is unreachable the cache keeps serving what
// it already resolved, expired or not — an outage of ours is not evidence that a
// customer's key was revoked. The honest limit of that fallback: Postgres down +
// cold cache ⇒ valid keys 401 until Postgres returns.
//
// Quota and pricing overrides are fail-open: Postgres down, or a workspace whose
// state was never fetched, reads back as not-over-quota on base prices. The two
// directions are deliberate and opposite. Our outage must never sample away a
// paying customer's traces, so quota degrades open; auth degrading open would be
// a security hole, so it degrades static. Fail-open quota is our commercial risk
// and nobody else's.
//
// # Memory (D155, restated at D164f)
//
// A token entry widened by one short string — the key id — and the
// keyCacheMaxEntries bound still protects the class it was written for: unknown
// tokens are attacker-chosen and unbounded, while positives are bounded by the
// api_keys rows customers actually issued. The workspace map is not
// attacker-growable at all: an entry appears only for a workspace some valid key
// resolved to. Its size driver is override rows, which the web app caps at 100
// per workspace, so the worst case is tens of megabytes and no second bound
// constant is needed.
package keystore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pricing"
)

const (
	// keyCacheTTL bounds how stale an answer can be. Positive and negative
	// entries share it, workspace state shares it too — one TTL, or the product
	// would have two staleness stories to tell about the same 30 seconds — and a
	// hit does not extend it: refreshing on hit would mean a busy key is never
	// re-read, so the busiest key in the system would be the last one to notice
	// its own revocation. Revocation and a quota crossing are therefore honored
	// within keyCacheTTL rather than instantly, and the product says so where
	// keys are revoked and where usage is shown.
	keyCacheTTL = 30 * time.Second

	// keyCacheMaxEntries bounds the token cache. Unknown tokens are
	// attacker-chosen and unbounded, so a cache with no bound is a memory
	// exhaustion channel; see remember for which entry class the bound protects.
	// The workspace map needs no bound of its own — see the package doc.
	keyCacheMaxEntries = 10_000

	// lookupTimeout bounds one refresh: the token read plus, when the workspace
	// state is due, the two statements that refresh it. The auth seam carries no
	// request context — both transports authenticate before they read a body —
	// so the queries get their own deadline; without one a wedged Postgres would
	// hold exports open instead of falling through to the cache.
	lookupTimeout = 3 * time.Second
)

// The lookup, whole: one indexed equality on token_hash — its UNIQUE is that
// index — with revoked rows excluded in the same predicate, so a revoked key and
// an unknown one come back identically. The D6 posture at the SQL level. The key
// id rides along because the health rows are per key (D100) and the receive path
// has nothing else to attribute an accepted record to.
const lookupSQL = `SELECT id, workspace_id FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL`

// Over quota, in the one definition D163 fixes: the calendar month's spans plus
// logs in UTC, against the quota of the workspace's plan — absent workspace_plans
// row means free, which is why the catalog joins through COALESCE rather than
// requiring a row every signup would have to write. The web app's usage.ts states
// the same sum; a second definition here in Go would be the S2.3 L3 divergence.
//
// The month boundary is UTC on both sides of the comparison (D179). The inner
// `AT TIME ZONE 'UTC'` takes now() to a UTC wall clock and date_trunc finds that
// month's first instant; the outer one reads that instant back as UTC rather than
// as whatever TimeZone the session happens to carry. Without it the boundary is
// the server's local month, which is right on a UTC host and silently wrong
// everywhere else — and a wrong month boundary is a wrong bill.
const overQuotaSQL = `
SELECT COALESCE((
           SELECT sum(u.spans + u.logs)
           FROM usage_ledger u
           WHERE u.workspace_id = w.id
             AND u.period_start >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       ), 0) >= p.event_quota
FROM workspaces w
LEFT JOIN workspace_plans wp ON wp.workspace_id = w.id
JOIN plans p ON p.id = COALESCE(wp.plan_id, 'free')
WHERE w.id = $1`

// The workspace's pricing overrides on the D9 row shape (D108). Read once per
// refresh, never per span.
const overridesSQL = `SELECT match, input_per_mtok, output_per_mtok FROM pricing_overrides WHERE workspace_id = $1`

// Store resolves tokens and caches what it resolved, along with the workspace
// state that resolution turned up. It satisfies auth.Resolver.
type Store struct {
	pool *pgxpool.Pool

	// lookup is one Postgres round trip, a field rather than a direct call so
	// the cache semantics — which decide who is authorised while Postgres is
	// unreachable — are testable with no database to point at. fetchState is the
	// same seam for the workspace half.
	lookup     lookupFunc
	fetchState stateFunc
	// now is the clock, likewise: a 30 s TTL is not a thing a test can wait out.
	now func() time.Time

	mu    sync.Mutex
	cache map[string]entry
	state map[string]stateEntry
}

// lookupFunc reports the identity a live key's hash names, with found false when
// no unrevoked row matches. A false found is an answer; an error is the absence
// of one.
type lookupFunc func(ctx context.Context, tokenHash string) (auth.Identity, bool, error)

// stateFunc reads the workspace state D164 caches: the over-quota verdict and
// the workspace's pricing overrides, in two statements under one deadline, and
// hands back the price table those overrides were layered into.
type stateFunc func(ctx context.Context, workspaceID string) (State, error)

// State is what the write path needs to know about a workspace and cannot
// afford to ask Postgres for.
type State struct {
	// OverQuota is the D163 verdict as of the last refresh. True switches
	// ingestion to sampled (D165).
	OverQuota bool
	// Prices is the table the workspace's spans are costed with: the embedded
	// list with the workspace's D108 override rows already layered over it,
	// built on the refresh that read them (D174). It is never nil on the way out
	// of State — a workspace with no overrides, and every workspace while
	// Postgres is away, gets pricing.Default itself, so the export path can use
	// it without a nil check standing in for a pricing decision.
	Prices *pricing.Table
}

// entry is one cached answer. An empty Identity.WorkspaceID is a negative entry
// — a token Postgres had no live row for.
type entry struct {
	identity  auth.Identity
	expiresAt time.Time
}

// stateEntry is one workspace's cached state, on the same TTL as a token entry.
type stateEntry struct {
	state     State
	expiresAt time.Time
}

// New builds a store over the process pool. The pool is created and closed by
// main, not here (D164e): the metering flusher writes through the same one, and
// two pools to the same Postgres would be two connection budgets nobody sized.
func New(pool *pgxpool.Pool) *Store {
	s := newStore(nil, nil)
	s.pool = pool
	s.lookup = s.queryIdentity
	s.fetchState = s.queryState
	return s
}

func newStore(lookup lookupFunc, fetchState stateFunc) *Store {
	return &Store{
		lookup:     lookup,
		fetchState: fetchState,
		now:        time.Now,
		cache:      map[string]entry{},
		state:      map[string]stateEntry{},
	}
}

// Workspace resolves a bearer token to the identity it writes as. Every failure
// — unknown, revoked, and a Postgres it could not reach with nothing cached — is
// the same auth.ErrUnauthorized, because distinguishable answers would turn the
// endpoint into a key-probing oracle (D6).
func (s *Store) Workspace(token string) (auth.Identity, error) {
	hash := hashToken(token)

	cached, ok := s.cached(hash)
	if ok && s.now().Before(cached.expiresAt) {
		if cached.identity.WorkspaceID == "" {
			return auth.Identity{}, auth.ErrUnauthorized
		}
		return cached.identity, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), lookupTimeout)
	defer cancel()

	identity, found, err := s.lookup(ctx, hash)
	if err != nil {
		// Fail-static. An entry already resolved keeps resolving, expired or
		// not, and is never evicted here: our outage is not evidence about the
		// customer's key. A negative or absent entry stays a 401 — answering
		// with a workspace nobody ever read out of Postgres is not staleness,
		// it is invention.
		if ok && cached.identity.WorkspaceID != "" {
			return cached.identity, nil
		}
		return auth.Identity{}, auth.ErrUnauthorized
	}

	s.remember(hash, identity, found)
	if !found {
		return auth.Identity{}, auth.ErrUnauthorized
	}

	// Piggyback: the workspace state refreshes on the trip the token already
	// paid for, and only when it is due. Hanging it off the token read is what
	// keeps a second periodic query — and a second staleness window — out of the
	// design, and it is why the cache-hit path above returns without asking
	// Postgres anything at all.
	s.refreshState(ctx, identity.WorkspaceID)
	return identity, nil
}

// State is the non-blocking read the consume path takes per request: a map hit
// under the same mutex, never a query, and never a table build. Missing or
// expired reads back as baseState — fail-open, per the package doc — so a
// Postgres outage cannot start sampling a paying customer's traces away, and
// cannot leave the writer without a price list either.
func (s *Store) State(workspaceID string) State {
	s.mu.Lock()
	defer s.mu.Unlock()

	e, ok := s.state[workspaceID]
	if !ok || !s.now().Before(e.expiresAt) {
		return baseState()
	}
	return e.state
}

// baseState is the fail-open answer spelled out in one place: not over quota, on
// the embedded list.
func baseState() State { return State{Prices: pricing.Default} }

func (s *Store) cached(hash string) (entry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	e, ok := s.cache[hash]
	return e, ok
}

// remember caches one answer. Which entry class the bound protects is the whole
// design: unknown tokens are attacker-chosen and unbounded, valid ones are the
// customer's and few. So a positive entry is always stored — evicting an
// arbitrary negative to make room when the cache is full — and a new negative is
// dropped at the cap instead. A dropped negative costs a round trip per request
// for that one token; a dropped positive would cost the fail-static guarantee,
// which is not a trade an unknown key gets to force.
func (s *Store) remember(hash string, identity auth.Identity, found bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, replacing := s.cache[hash]; !replacing && len(s.cache) >= keyCacheMaxEntries {
		if !found {
			return
		}
		s.evictNegative()
	}
	if !found {
		identity = auth.Identity{}
	}
	s.cache[hash] = entry{identity: identity, expiresAt: s.now().Add(keyCacheTTL)}
}

// evictNegative drops one negative entry — map iteration order, so "arbitrary"
// means arbitrary. A cache holding nothing but positives grows by one rather
// than evicting a key that the next Postgres outage would then 401: the bound
// exists to stop unknown tokens filling memory, and the positive set is bounded
// by how many keys the customers issued.
func (s *Store) evictNegative() {
	for hash, e := range s.cache {
		if e.identity.WorkspaceID == "" {
			delete(s.cache, hash)
			return
		}
	}
}

// refreshState re-reads a workspace's state when its entry is missing or due,
// and does nothing otherwise. A failed read is dropped rather than cached or
// retried: the entry that is already there keeps serving until it expires, and
// then the workspace reads back as the fail-open zero value. Quota is the one
// thing this package is allowed to forget under an outage.
func (s *Store) refreshState(ctx context.Context, workspaceID string) {
	if s.stateIsFresh(workspaceID) {
		return
	}

	state, err := s.fetchState(ctx, workspaceID)
	if err != nil {
		return
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.state[workspaceID] = stateEntry{state: state, expiresAt: s.now().Add(keyCacheTTL)}
}

func (s *Store) stateIsFresh(workspaceID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	e, ok := s.state[workspaceID]
	return ok && s.now().Before(e.expiresAt)
}

func (s *Store) queryIdentity(ctx context.Context, tokenHash string) (auth.Identity, bool, error) {
	var identity auth.Identity
	err := s.pool.QueryRow(ctx, lookupSQL, tokenHash).Scan(&identity.KeyID, &identity.WorkspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return auth.Identity{}, false, nil
	}
	if err != nil {
		return auth.Identity{}, false, fmt.Errorf("api key lookup: %w", err)
	}
	return identity, true, nil
}

// queryState is the two statements D164 allows on this path, in the order that
// matters: the quota verdict first, because it is the one that changes what the
// service does with the next request. The rows the second one returns are layered
// into a table here and not kept — the built table and the rows it was built from
// would be two representations of one fact, and only one of them can be the one
// the writer prices with (D174).
func (s *Store) queryState(ctx context.Context, workspaceID string) (State, error) {
	state := baseState()

	err := s.pool.QueryRow(ctx, overQuotaSQL, workspaceID).Scan(&state.OverQuota)
	// No row means no such workspace — nothing to be over the quota of.
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return State{}, fmt.Errorf("workspace quota lookup: %w", err)
	}

	rows, err := s.pool.Query(ctx, overridesSQL, workspaceID)
	if err != nil {
		return State{}, fmt.Errorf("pricing overrides lookup: %w", err)
	}
	defer rows.Close()
	var overrides []pricing.Rate
	for rows.Next() {
		var override pricing.Rate
		if err := rows.Scan(&override.Match, &override.InputPerMTok, &override.OutputPerMTok); err != nil {
			return State{}, fmt.Errorf("pricing overrides lookup: %w", err)
		}
		overrides = append(overrides, override)
	}
	if err := rows.Err(); err != nil {
		return State{}, fmt.Errorf("pricing overrides lookup: %w", err)
	}

	// A workspace with no rows gets pricing.Default back, not a copy of it.
	state.Prices = pricing.Default.WithOverrides(overrides)
	return state, nil
}

// hashToken is the D139 contract, one definition per language: SHA-256 over the
// UTF-8 bytes of the exact full token string, lowercase hex. The web app hashes
// the same way when it issues a key, which is the only thing that makes a stored
// row mean the same to both; the pinned cross-language vector is asserted in
// both suites.
func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
