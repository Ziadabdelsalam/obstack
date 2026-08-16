// Command ingest is the obstack telemetry ingest service. It owns the ClickHouse
// schema — applied at boot from the embedded migrations, or by the `migrate`
// subcommand where a deployment needs one runner rather than one per replica —
// and serves the OTLP receivers alongside an admin endpoint carrying /healthz
// and /metrics.
package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/config"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metrics"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/migrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/receive"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/write"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/migrations"
)

func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, nil)))

	// The image is distroless and carries no curl, so the binary probes its own
	// /healthz for the compose healthcheck.
	if len(os.Args) > 1 && os.Args[1] == "healthcheck" {
		if err := probeHealth(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	// `ingest migrate` is the one-shot a Helm pre-install/pre-upgrade Job or an
	// initContainer runs: apply, log, exit. One runner by construction, which is
	// the whole reason migrate needs no lock.
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		if err := runMigrate(); err != nil {
			slog.Error("migrate stopped", "error", err)
			os.Exit(1)
		}
		return
	}

	// A typo must not boot a server. argv stops being developer-typed the moment
	// it is a chart's values, and `ingest migrat` falling through to run() either
	// binds the OTLP ports for a Job that was meant to exit, or fails demanding
	// the OBSTACK_API_KEYS that Job deliberately does not carry — sending the
	// operator after a missing secret instead of a missing letter.
	if len(os.Args) > 1 {
		fmt.Fprintf(os.Stderr, "unknown command %q; valid commands: migrate, healthcheck\n", os.Args[1])
		os.Exit(2)
	}

	if err := run(); err != nil {
		slog.Error("ingest stopped", "error", err)
		os.Exit(1)
	}
}

// migrateTimeout bounds the schema work wherever it runs. Generous enough for
// the CREATEs against a cold server, short enough that a wedged migration fails
// the Job rather than stalling a rollout behind it.
const migrateTimeout = 2 * time.Minute

// runMigrate applies the schema and exits. It reads CLICKHOUSE_DSN directly
// instead of calling config.Load: everything else Load validates belongs to
// serving traffic, and requiring the API keys here would put them in the
// environment of a process that never authenticates anything.
func runMigrate() error {
	dsn, err := config.LoadDSN()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, migrateTimeout)
	defer cancel()

	applied, err := migrate.Run(ctx, dsn, migrations.FS)
	if err != nil {
		return fmt.Errorf("schema migrations: %w", err)
	}
	logSchema(applied)
	return nil
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	metrics.Init(cfg.WorkspaceIDs())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// The schema is settled before anything is served: a process that cannot own
	// the schema has no business reporting healthy.
	migrateCtx, cancel := context.WithTimeout(ctx, migrateTimeout)
	defer cancel()
	if err := ensureSchema(migrateCtx, cfg, migrations.FS, migrate.Pending); err != nil {
		return err
	}

	// The writer connects and pings before anything is bound: an ingest that
	// cannot reach ClickHouse should fail to boot, not accept exports it will
	// only drop (D23 makes those drops invisible to the client).
	connectCtx, cancelConnect := context.WithTimeout(ctx, 30*time.Second)
	defer cancelConnect()
	writer, err := write.New(connectCtx, write.Config{DSN: cfg.ClickHouseDSN})
	if err != nil {
		return err
	}

	receiver := receive.New(receive.Config{
		GRPCAddr: cfg.OTLPGRPCAddr,
		HTTPAddr: cfg.OTLPHTTPAddr,
		Auth:     auth.New(cfg.APIKeys),
		Consumer: writer,
	})
	if err := receiver.Start(); err != nil {
		writer.Close()
		return err
	}

	admin := &http.Server{
		Addr:              cfg.AdminAddr,
		Handler:           adminHandler(),
		ReadHeaderTimeout: 5 * time.Second,
	}
	errs := make(chan error, 1)
	go func() {
		slog.Info("admin listening", "addr", cfg.AdminAddr)
		if err := admin.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errs <- fmt.Errorf("admin server: %w", err)
		}
	}()

	var runErr error
	select {
	case runErr = <-errs:
	case runErr = <-receiver.Err():
	case <-ctx.Done():
		slog.Info("shutting down")
	}

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancelShutdown()
	// Order matters: stop taking exports, then flush what is buffered, and only
	// then drop /metrics — the last flush is worth watching.
	if err := receiver.Shutdown(shutdownCtx); err != nil {
		slog.Error("otlp shutdown", "error", err)
	}
	if err := writer.Close(); err != nil {
		slog.Error("writer close", "error", err)
	}
	if err := admin.Shutdown(shutdownCtx); err != nil && runErr == nil {
		runErr = err
	}
	return runErr
}

// pendingVersions is the schema check ensureSchema runs when it is not the one
// applying. It is injected rather than called directly so the refusal path —
// the single safety property this whole mode exists to provide — is unit
// testable with no ClickHouse to point at. Every integration test in this
// service skips when there is no database, and a guarantee that only holds when
// someone remembered to start one is not a guarantee.
type pendingVersions func(context.Context, string, fs.FS) ([]string, error)

// ensureSchema settles the schema question before the process serves anything.
// The invariant holds under both answers — nothing serves against a schema this
// binary does not recognise — and only who applies moves: with
// OBSTACK_MIGRATE_ON_BOOT=false that is the `migrate` subcommand, so a
// Deployment's replicas cannot race each other on DDL, and these pods are left
// verifying — read-only, holding no DDL grant. A chart that forgets its
// migration Job then crash-loops naming the versions it is missing, rather than
// quietly serving a half-migrated schema.
func ensureSchema(ctx context.Context, cfg config.Config, fsys fs.FS, pending pendingVersions) error {
	if cfg.MigrateOnBoot {
		applied, err := migrate.Run(ctx, cfg.ClickHouseDSN, fsys)
		if err != nil {
			return fmt.Errorf("schema migrations: %w", err)
		}
		logSchema(applied)
		return nil
	}

	unapplied, err := pending(ctx, cfg.ClickHouseDSN, fsys)
	if err != nil {
		return fmt.Errorf("schema check: %w", err)
	}
	if len(unapplied) > 0 {
		return fmt.Errorf("schema migrations %s unapplied and OBSTACK_MIGRATE_ON_BOOT is false; run `ingest migrate` first",
			strings.Join(unapplied, ", "))
	}
	slog.Info("schema verified", "migrate_on_boot", false)
	return nil
}

func logSchema(applied []string) {
	if len(applied) == 0 {
		slog.Info("schema already up to date")
	} else {
		slog.Info("schema migrations applied", "versions", applied)
	}
}

func adminHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		fmt.Fprintln(w, "ok")
	})
	mux.Handle("GET /metrics", promhttp.Handler())
	return mux
}

func probeHealth() error {
	addr := os.Getenv("OBSTACK_ADMIN_ADDR")
	if addr == "" {
		addr = config.DefaultAdminAddr
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("OBSTACK_ADMIN_ADDR %q: %w", addr, err)
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	url := fmt.Sprintf("http://%s/healthz", net.JoinHostPort(host, port))

	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned %s", url, strings.ToLower(resp.Status))
	}
	return nil
}
