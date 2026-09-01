package changes

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
)

var (
	// ErrStorage is Postgres refusing or being unreachable: the 503 (D495). A
	// 2xx is a committed row, so nothing here is ever answered 200-then-lost.
	ErrStorage = errors.New("changes: storage unavailable")
	// ErrUnknownKey is the credential's row being gone by the time the insert
	// ran (the keystore caches for 30s): the honest answer is the 401 the key
	// would get on its next request.
	ErrUnknownKey = errors.New("changes: the credential no longer exists")
	// ErrInvariant is the DDL refusing a document the validator passed — a
	// bug of ours, never the client's, answered 500 rather than 400.
	ErrInvariant = errors.New("changes: the store refused a validated document")
)

// Store is where a validated event goes. The receive package's handler talks
// to this; the real one is PGStore, the tests' one records.
type Store interface {
	// Insert writes the event under the identity's workspace and key and
	// returns the row's id. deduplicated reports that the workspace already
	// held the event's external_id, in which case id is the ORIGINAL row's and
	// nothing was written (D496: first write wins).
	Insert(ctx context.Context, identity auth.Identity, ev Event) (id string, deduplicated bool, err error)
}

// PGStore is the synchronous insert (D495): one statement, $n-bound, the
// workspace and key from the credential and never from the body.
type PGStore struct {
	pool *pgxpool.Pool
}

// NewPGStore binds the store to the process's one pool.
func NewPGStore(pool *pgxpool.Pool) *PGStore { return &PGStore{pool: pool} }

// The dedupe rides the partial UNIQUE index (0011): a conflicting external_id
// inserts nothing and returns no row, and the follow-up read fetches the
// original. Two statements rather than one CTE so the common path — no
// conflict — is a single round trip with the id coming straight back.
const (
	insertSQL = `
	INSERT INTO change_events
	    (id, workspace_id, key_id, kind, title, detail, who, service, ref, source, link_label, link_href, external_id, at)
	VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
	ON CONFLICT (workspace_id, external_id) WHERE external_id IS NOT NULL DO NOTHING
	RETURNING id`

	originalSQL = `SELECT id FROM change_events WHERE workspace_id = $1 AND external_id = $2`
)

func (s *PGStore) Insert(ctx context.Context, identity auth.Identity, ev Event) (string, bool, error) {
	var label, href *string
	if ev.Link != nil {
		label, href = &ev.Link.Label, &ev.Link.Href
	}
	// One retry covers the one race the two statements leave open: the
	// original row deleted (retention, a workspace wipe) between the conflict
	// and the read. The second attempt then inserts.
	for attempt := 0; attempt < 2; attempt++ {
		id := newID()
		err := s.pool.QueryRow(ctx, insertSQL,
			id, identity.WorkspaceID, identity.KeyID, ev.Kind, ev.Title, ev.Detail, ev.Who,
			ev.Service, ev.Ref, ev.Source, label, href, ev.ExternalID, ev.At).Scan(&id)
		if err == nil {
			return id, false, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", false, classify(err)
		}
		// No row came back: the partial UNIQUE fired. Only possible with an
		// external_id, so the read below always has one to bind.
		var original string
		err = s.pool.QueryRow(ctx, originalSQL, identity.WorkspaceID, ev.ExternalID).Scan(&original)
		if err == nil {
			return original, true, nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return "", false, classify(err)
		}
	}
	return "", false, fmt.Errorf("%w: the deduplicated row vanished twice", ErrStorage)
}

// classify maps a pgx error to the three sentinels the handler answers with.
// Everything that is not a known constraint is storage: a refused connection,
// a timeout, a closed pool, a statement the server would not run.
func classify(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "23503": // foreign_key_violation: the workspace or the key is gone
			return fmt.Errorf("%w: %s", ErrUnknownKey, pgErr.ConstraintName)
		case "23514": // check_violation: the validator and the DDL disagree
			return fmt.Errorf("%w: %s", ErrInvariant, pgErr.ConstraintName)
		}
	}
	return fmt.Errorf("%w: %v", ErrStorage, err)
}

// newID mirrors the alerts tier's id shape (`evt_<16 hex>`), so a change
// event is recognisable wherever its id turns up.
func newID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand failing is not a condition to degrade through: a
		// predictable id here would be a predictable row key in a
		// customer-visible table.
		panic("changes: crypto/rand failed: " + err.Error())
	}
	return "chg_" + hex.EncodeToString(b[:])
}
