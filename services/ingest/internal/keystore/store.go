// Package keystore resolves API keys against Postgres, which is the one
// authority for them (D98): OBSTACK_API_KEYS is deleted and no second lookup
// path exists. A token resolves by the SHA-256 of its exact string against
// api_keys.token_hash — the same contract the web app hashes with at issue time
// — and the token's shape is never inspected, so the seeded `ok_dev_local` dev
// row and an issued `ok_live_…` resolve through identical code (D139).
//
// Lookups are cached read-through, positive and negative alike, for
// keyCacheTTL. A Postgres round trip per export would make the control plane a
// dependency of the data path, and ingest is never the customer's outage
// (PRD §9). The cost is stated rather than hidden: a revoked key keeps working
// for up to keyCacheTTL.
//
// When Postgres is unreachable the cache keeps serving what it already resolved,
// expired or not — an outage of ours is not evidence that a customer's key was
// revoked. The honest limit of that fallback: Postgres down + cold cache ⇒ valid
// keys 401 until Postgres returns.
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
)

const (
	// keyCacheTTL bounds how stale an answer can be. Positive and negative
	// entries share it, and a hit does not extend it: refreshing on hit would
	// mean a busy key is never re-read, so the busiest key in the system would
	// be the last one to notice its own revocation. Revocation is therefore
	// honored within keyCacheTTL rather than instantly, and the product says so
	// where keys are revoked.
	keyCacheTTL = 30 * time.Second

	// keyCacheMaxEntries bounds the cache as a whole. Unknown tokens are
	// attacker-chosen and unbounded, so a cache with no bound is a memory
	// exhaustion channel; see remember for which entry class the bound protects.
	keyCacheMaxEntries = 10_000

	// lookupTimeout bounds one round trip. The auth seam carries no request
	// context — both transports authenticate before they read a body — so the
	// query gets its own deadline; without one a wedged Postgres would hold
	// exports open instead of falling through to the cache.
	lookupTimeout = 3 * time.Second
)

// The lookup, whole: one indexed equality on token_hash — its UNIQUE is that
// index — with revoked rows excluded in the same predicate, so a revoked key and
// an unknown one come back identically. The D6 posture at the SQL level.
const lookupSQL = `SELECT workspace_id FROM api_keys WHERE token_hash = $1 AND revoked_at IS NULL`

// Store resolves tokens and caches what it resolved. It satisfies auth.Resolver.
type Store struct {
	pool *pgxpool.Pool

	// lookup is one Postgres round trip, a field rather than a direct call so
	// the cache semantics — which decide who is authorised while Postgres is
	// unreachable — are testable with no database to point at.
	lookup lookupFunc
	// now is the clock, likewise: a 30 s TTL is not a thing a test can wait out.
	now func() time.Time

	mu    sync.Mutex
	cache map[string]entry
}

// lookupFunc reports the workspace a live key's hash names, with found false
// when no unrevoked row matches. A false found is an answer; an error is the
// absence of one.
type lookupFunc func(ctx context.Context, tokenHash string) (workspaceID string, found bool, err error)

// entry is one cached answer. An empty workspaceID is a negative entry — a
// token Postgres had no live row for.
type entry struct {
	workspaceID string
	expiresAt   time.Time
}

// Open connects the pool and proves it works before returning. With the env key
// map deleted there is no keyless serving mode left, so a process that cannot
// reach the key store fails loudly at boot rather than 401ing every export it
// was about to accept (D95(e)).
func Open(ctx context.Context, dsn string) (*Store, error) {
	// Parsed before dialing so a malformed DSN is reported as the configuration
	// mistake it is, naming the variable to go fix — the shape internal/pgmigrate
	// already reports Postgres problems in.
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse OBSTACK_POSTGRES_DSN: %w", err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}

	s := newStore(nil)
	s.pool = pool
	s.lookup = s.queryWorkspace
	return s, nil
}

func newStore(lookup lookupFunc) *Store {
	return &Store{lookup: lookup, now: time.Now, cache: map[string]entry{}}
}

// Close releases the pool.
func (s *Store) Close() {
	if s.pool != nil {
		s.pool.Close()
	}
}

// Workspace resolves a bearer token to the workspace it writes into. Every
// failure — unknown, revoked, and a Postgres it could not reach with nothing
// cached — is the same auth.ErrUnauthorized, because distinguishable answers
// would turn the endpoint into a key-probing oracle (D6).
func (s *Store) Workspace(token string) (string, error) {
	hash := hashToken(token)

	cached, ok := s.cached(hash)
	if ok && s.now().Before(cached.expiresAt) {
		if cached.workspaceID == "" {
			return "", auth.ErrUnauthorized
		}
		return cached.workspaceID, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), lookupTimeout)
	defer cancel()

	workspaceID, found, err := s.lookup(ctx, hash)
	if err != nil {
		// Fail-static. An entry already resolved keeps resolving, expired or
		// not, and is never evicted here: our outage is not evidence about the
		// customer's key. A negative or absent entry stays a 401 — answering
		// with a workspace nobody ever read out of Postgres is not staleness,
		// it is invention.
		if ok && cached.workspaceID != "" {
			return cached.workspaceID, nil
		}
		return "", auth.ErrUnauthorized
	}

	s.remember(hash, workspaceID, found)
	if !found {
		return "", auth.ErrUnauthorized
	}
	return workspaceID, nil
}

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
func (s *Store) remember(hash, workspaceID string, found bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if _, replacing := s.cache[hash]; !replacing && len(s.cache) >= keyCacheMaxEntries {
		if !found {
			return
		}
		s.evictNegative()
	}
	s.cache[hash] = entry{workspaceID: workspaceID, expiresAt: s.now().Add(keyCacheTTL)}
}

// evictNegative drops one negative entry — map iteration order, so "arbitrary"
// means arbitrary. A cache holding nothing but positives grows by one rather
// than evicting a key that the next Postgres outage would then 401: the bound
// exists to stop unknown tokens filling memory, and the positive set is bounded
// by how many keys the customers issued.
func (s *Store) evictNegative() {
	for hash, e := range s.cache {
		if e.workspaceID == "" {
			delete(s.cache, hash)
			return
		}
	}
}

func (s *Store) queryWorkspace(ctx context.Context, tokenHash string) (string, bool, error) {
	var workspaceID string
	err := s.pool.QueryRow(ctx, lookupSQL, tokenHash).Scan(&workspaceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("api key lookup: %w", err)
	}
	return workspaceID, true, nil
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
