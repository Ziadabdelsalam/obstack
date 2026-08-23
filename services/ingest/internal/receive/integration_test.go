package receive_test

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/migrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/receive"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/write"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/migrations"
)

// The launch receivers end to end, against a real ClickHouse: the vendors'
// captured payloads POSTed over HTTP to a real receiver wired to the real
// batch writer, asserted as rows in obstack.logs.
//
// This is the bar D254 set for S4.2 — real local requests, not activation
// claims. It is what makes "the mapping rides the existing log write path"
// something the suite knows rather than something the code comments say: the
// records here pass through the same consume path, the same writer and the same
// schema every OTLP export does.
//
// The compose stack from deploy/compose by default, overridable for CI; without
// a reachable server it skips, the standing convention.
const defaultReceiveDSN = "clickhouse://obstack_ingest:obstack_ingest_dev@127.0.0.1:9000/obstack"

func receiveTestDSN() string {
	if dsn := os.Getenv("OBSTACK_TEST_CLICKHOUSE_DSN"); dsn != "" {
		return dsn
	}
	return defaultReceiveDSN
}

// connectReceiveClickHouse probes against `default` — the database migrate.Run
// itself boots against, since `obstack` does not exist until the migrations
// create it — then applies the schema and returns an assertion connection.
func connectReceiveClickHouse(t *testing.T) driver.Conn {
	t.Helper()

	opts, err := clickhouse.ParseDSN(receiveTestDSN())
	if err != nil {
		t.Fatalf("parse test DSN: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	probeOpts := *opts
	probeOpts.Auth.Database = "default"
	probe, err := clickhouse.Open(&probeOpts)
	if err != nil {
		t.Fatalf("open clickhouse: %v", err)
	}
	if err := probe.Ping(ctx); err != nil {
		probe.Close()
		t.Skipf("no ClickHouse at %s (%v); start deploy/compose to run the receiver integration tests", receiveTestDSN(), err)
	}
	probe.Close()

	if _, err := migrate.Run(ctx, receiveTestDSN(), migrations.FS); err != nil {
		t.Fatalf("apply schema: %v", err)
	}

	conn, err := clickhouse.Open(opts)
	if err != nil {
		t.Fatalf("open clickhouse: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

// startWritingServer wires a receiver to the REAL batch writer, so what these
// tests exercise is the production path and not a recorder standing in for it.
func startWritingServer(t *testing.T, workspace string) *receive.Server {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	writer, err := write.New(ctx, write.Config{
		DSN: receiveTestDSN(),
		// Short, so a test waiting for the timer does not wait a second.
		FlushInterval: 100 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("new writer: %v", err)
	}
	t.Cleanup(func() {
		closeCtx, cancelClose := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancelClose()
		if err := writer.Close(closeCtx); err != nil {
			t.Errorf("writer close: %v", err)
		}
	})

	srv := receive.New(receive.Config{
		GRPCAddr: "127.0.0.1:0",
		HTTPAddr: "127.0.0.1:0",
		Auth:     auth.New(testResolver{testKey: workspace}),
		Consumer: writer,
	})
	if err := srv.Start(); err != nil {
		t.Fatalf("start receivers: %v", err)
	}
	t.Cleanup(func() {
		shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancelShutdown()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			t.Errorf("shutdown: %v", err)
		}
	})
	return srv
}

// freshenTimestamps rewrites the fixtures' `timestamp` values to now.
//
// The fixtures keep the vendors' published payloads verbatim, and those
// payloads are dated 2019 — older than the 90-day outer TTL migration 0004
// applies, so ClickHouse drops those rows while forming the part and the
// mapping would look broken when it is the retention bound doing exactly its
// job (measured 2026-08-23: rows past a table TTL never reach a part, no merge
// involved). Only the instant moves; every other byte of the payload, including
// the trace context these tests assert on, is the vendor's own.
func freshenTimestamps(body []byte, at time.Time) []byte {
	ms := at.UnixMilli()
	return timestampPattern.ReplaceAll(body, []byte(fmt.Sprintf(`"timestamp":%d`, ms)))
}

// Matches `"timestamp": 1573817187330` in both the spaced and compact spellings
// the two encodings use.
var timestampPattern = regexp.MustCompile(`"timestamp":\s*\d+`)

// newReceiveWorkspace gives each test its own workspace id — the leading
// ordering-key column — and cleans its rows up afterwards.
func newReceiveWorkspace(t *testing.T, conn driver.Conn) string {
	t.Helper()
	workspace := fmt.Sprintf("ws_recv_%d", time.Now().UnixNano())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := conn.Exec(ctx,
			"ALTER TABLE obstack.logs DELETE WHERE workspace_id = ?", workspace); err != nil {
			t.Logf("cleanup for %s: %v", workspace, err)
		}
	})
	return workspace
}

// awaitLogRows polls for the batcher's flush rather than sleeping for it.
func awaitLogRows(t *testing.T, conn driver.Conn, workspace string, want uint64) uint64 {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var count uint64
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		row := conn.QueryRow(ctx, "SELECT count() FROM obstack.logs WHERE workspace_id = ?", workspace)
		if err := row.Scan(&count); err != nil {
			t.Fatalf("count logs for %s: %v", workspace, err)
		}
		if count >= want {
			return count
		}
		time.Sleep(200 * time.Millisecond)
	}
	return count
}

func TestVercelDrainLandsRowsInClickHouse(t *testing.T) {
	conn := connectReceiveClickHouse(t)
	workspace := newReceiveWorkspace(t, conn)
	srv := startWritingServer(t, workspace)

	resp := post(t, srv, httpRequest{
		path:        vercelPath,
		contentType: contentTypeJSON,
		body:        freshenTimestamps(vercelFixture(t, "logs.ndjson"), time.Now()),
		bearer:      "Bearer " + testKey,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	if got := awaitLogRows(t, conn, workspace, 2); got != 2 {
		t.Fatalf("landed %d rows in obstack.logs, want the fixture's 2", got)
	}

	// The trace context the payload measurably carried is on the row, so a
	// drain-delivered line joins the trace it belongs to — the whole point of
	// extracting it (D254).
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var traced uint64
	row := conn.QueryRow(ctx,
		"SELECT count() FROM obstack.logs WHERE workspace_id = ? AND trace_id = ?",
		workspace, "1b02cd14bb8642fd092bc23f54c7ffcd")
	if err := row.Scan(&traced); err != nil {
		t.Fatalf("count traced rows: %v", err)
	}
	if traced != 1 {
		t.Errorf("%d rows carry the payload's trace id, want exactly the lambda line", traced)
	}

	// And the line that carried none landed trace-less rather than being joined
	// to something invented.
	var traceless uint64
	row = conn.QueryRow(ctx,
		"SELECT count() FROM obstack.logs WHERE workspace_id = ? AND trace_id = ''", workspace)
	if err := row.Scan(&traceless); err != nil {
		t.Fatalf("count trace-less rows: %v", err)
	}
	if traceless != 1 {
		t.Errorf("%d rows landed trace-less, want the build line", traceless)
	}
}

func TestCloudWatchLandsRowsInClickHouse(t *testing.T) {
	conn := connectReceiveClickHouse(t)
	workspace := newReceiveWorkspace(t, conn)
	srv := startWritingServer(t, workspace)

	resp := post(t, srv, httpRequest{
		path:        cloudWatchPath,
		contentType: contentTypeJSON,
		body:        freshenTimestamps(cloudWatchFixture(t, "data-message.json"), time.Now()),
		bearer:      "Bearer " + testKey,
	})
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}

	if got := awaitLogRows(t, conn, workspace, 3); got != 3 {
		t.Fatalf("landed %d rows in obstack.logs, want the fixture's 3", got)
	}

	// Service resolution survives the round trip: the log group is what these
	// rows group by in the product.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var service string
	row := conn.QueryRow(ctx,
		"SELECT any(service) FROM obstack.logs WHERE workspace_id = ?", workspace)
	if err := row.Scan(&service); err != nil {
		t.Fatalf("read service: %v", err)
	}
	if service != "CloudTrail" {
		t.Errorf("service = %q, want the log group's name", service)
	}
}
