// Command ingest is the obstack telemetry ingest service. It owns two schemas —
// ClickHouse's telemetry tables and Postgres' workspaces and saved views, each
// applied at boot from its own embedded migrations, or by the `migrate` and
// `pg-migrate` subcommands where a deployment needs one runner rather than one
// per replica — and serves the OTLP receivers alongside an admin endpoint
// carrying /healthz and /metrics.
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

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/alerting"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/auth"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/config"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/keystore"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/metering"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/migrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/notify"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pgmigrate"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/pricing"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/receive"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/retention"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/internal/write"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/migrations"
	"github.com/Ziadabdelsalam/observer-stack/services/ingest/pgmigrations"
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

	// `ingest migrate` and `ingest pg-migrate` are the one-shots a Helm
	// pre-install/pre-upgrade Job or an initContainer runs: apply, log, exit. One
	// runner by construction, which is the whole reason neither needs a lock.
	// They are separate commands rather than one because the two stores fail
	// separately, are granted separately, and a Job that only owns one of them
	// should carry only that one's DSN.
	if len(os.Args) > 1 && os.Args[1] == "migrate" {
		if err := runMigrate(); err != nil {
			slog.Error("migrate stopped", "error", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "pg-migrate" {
		if err := runPGMigrate(); err != nil {
			slog.Error("pg-migrate stopped", "error", err)
			os.Exit(1)
		}
		return
	}

	// A typo must not boot a server. argv stops being developer-typed the moment
	// it is a chart's values, and `ingest migrat` falling through to run() either
	// binds the OTLP ports for a Job that was meant to exit, or fails demanding
	// the ClickHouse DSN that a Postgres-only Job deliberately does not carry —
	// sending the operator after a missing secret instead of a missing letter.
	if len(os.Args) > 1 {
		fmt.Fprintf(os.Stderr, "unknown command %q; valid commands: migrate, pg-migrate, healthcheck\n", os.Args[1])
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
// serving traffic, and a one-shot that applies DDL and exits should not be able
// to fail on a listen address it never binds.
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
	logSchema(storeClickHouse, applied)
	return nil
}

// The Postgres half of the environment. It is read here rather than added to
// config.Config because it is needed by two commands with different jobs — the
// `pg-migrate` one-shot, which applies the schema and exits, and the serving
// process, which since M3 also reads its API keys from Postgres (D98) and
// therefore cannot boot without it. Keeping it out of Config is what lets the
// one-shot skip a validator built for serving traffic.
const (
	envPostgresDSN         = "OBSTACK_POSTGRES_DSN"
	envPostgresDSNPassword = "OBSTACK_POSTGRES_DSN_PASSWORD"
	envPGMigrateOnBoot     = "OBSTACK_PG_MIGRATE_ON_BOOT"
)

// postgresDSN reads the DSN and, per D275, layers a password onto it from
// envPostgresDSNPassword when the chart set one — the same
// config.InjectDSNPassword split LoadDSN uses for the ClickHouse DSN, so the
// two stores' `existingSecret` paths cannot drift in how the password gets
// from a `secretKeyRef` into the connection string. Unset is a no-op: the
// chart's own (non-`existingSecret`) Secret still renders the password
// straight into OBSTACK_POSTGRES_DSN.
func postgresDSN() (string, error) {
	dsn := os.Getenv(envPostgresDSN)
	if dsn == "" {
		return "", fmt.Errorf("%s is required", envPostgresDSN)
	}
	return config.InjectDSNPassword(dsn, envPostgresDSNPassword)
}

// pgMigrateOnBoot is OBSTACK_MIGRATE_ON_BOOT's counterpart for the Postgres set,
// and reads through the same helper on purpose: the two flags decide the same
// thing about two stores, so a value one of them refuses must not be a value the
// other coerces. Unset means true — compose and every single-node self-hoster,
// where the serving container is the only migration runner there is.
func pgMigrateOnBoot() (bool, error) {
	return config.EnvBool(envPGMigrateOnBoot, true)
}

// runPGMigrate applies the Postgres schema and exits — the `ingest migrate`
// shape, against the other store.
func runPGMigrate() error {
	dsn, err := postgresDSN()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, migrateTimeout)
	defer cancel()

	applied, err := pgmigrate.Run(ctx, dsn, pgmigrations.FS)
	if err != nil {
		return fmt.Errorf("postgres migrations: %w", err)
	}
	logSchema(storePostgres, applied)
	return nil
}

// shutdownTimeout is the app-level grace period (D263): the deadline
// receiver.Shutdown and writer.Close share on the way out, generous enough
// for a clean final flush and inside the chart's 45s
// terminationGracePeriodSeconds and compose's matching stop_grace_period
// (D278, superseding D263.3/.4's 30s — 45 covers this deadline plus the one
// in-flight retry attempt Close cannot abort, ≤40s, and still leaves margin
// for receiver drain and admin shutdown).
const shutdownTimeout = 10 * time.Second

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	pgDSN, err := postgresDSN()
	if err != nil {
		return err
	}
	pgOnBoot, err := pgMigrateOnBoot()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Both schemas are settled before anything is served: a process that cannot
	// own the schema has no business reporting healthy. Postgres is no longer
	// only a schema this process owns on someone else's behalf — the api_keys
	// rows it applies below are what every export authenticates against (D98),
	// so a migration that never ran is now a 401 for every client rather than
	// only a web surface that 500s.
	migrateCtx, cancel := context.WithTimeout(ctx, migrateTimeout)
	defer cancel()
	if err := ensureSchema(migrateCtx, cfg, migrations.FS, migrate.Pending); err != nil {
		return err
	}
	if err := ensurePGSchema(migrateCtx, pgDSN, pgOnBoot, pgmigrations.FS, pgmigrate.Pending); err != nil {
		return err
	}

	connectCtx, cancelConnect := context.WithTimeout(ctx, 30*time.Second)
	defer cancelConnect()

	// One Postgres pool for the process (D164e). The key store resolves keys
	// through it and the metering flusher writes counts through it, so the two
	// contend for one connection budget an operator can size rather than for two
	// nobody added up. It connects and pings here because there is no keyless
	// mode to fall back to: with the env key map deleted, a process that cannot
	// reach Postgres at boot would 401 every export it accepted. Once it is
	// serving, a Postgres that goes away is survivable — see internal/keystore
	// for what stays true and what degrades.
	pool, err := openPostgres(connectCtx, pgDSN)
	if err != nil {
		return err
	}
	defer pool.Close()

	keys := keystore.New(pool)

	// The writer connects and pings before anything is bound: an ingest that
	// cannot reach ClickHouse should fail to boot, not accept exports it will
	// only drop (D23 makes those drops invisible to the client).
	writer, err := write.New(connectCtx, write.Config{
		DSN:    cfg.ClickHouseDSN,
		Prices: pricesFor(keys),
	})
	if err != nil {
		return err
	}

	// The retention sweep (D252) reads plans from the one pool and deletes past
	// each tier on its own cold-path ClickHouse connection. It fails boot like
	// the writer does: a process claiming to own retention must be able to
	// enforce it.
	sweeper, err := retention.New(connectCtx, retention.Config{
		DSN:  cfg.ClickHouseDSN,
		Pool: pool,
	})
	if err != nil {
		return err
	}
	sweepCtx, stopSweep := context.WithCancel(context.Background())
	sweepStopped := make(chan struct{})
	go func() {
		defer close(sweepStopped)
		sweeper.Run(sweepCtx)
	}()
	stopSweeper := func() {
		stopSweep()
		<-sweepStopped
		sweeper.Close()
	}

	// The meter accumulates in memory and flushes on its own interval; the
	// receive path only ever adds to a map (D166), so a Postgres that goes away
	// costs the ledger rows, never an export.
	meter := metering.New(pool)
	meterCtx, stopMeter := context.WithCancel(context.Background())
	meterStopped := make(chan struct{})
	go func() {
		defer close(meterStopped)
		meter.Run(meterCtx)
	}()

	// Boot did not used to be able to fail past this point, and now it can:
	// the alerting engine reads config and dials ClickHouse below. unwindBoot
	// stops whatever is already running, in the SAME order the shutdown path
	// uses, so a failed boot leaves nothing spinning against a pool the
	// deferred Close is about to take away. stopAlerting is nil until the two
	// loops exist, which is exactly the window this has to survive.
	var stopAlerting func()
	unwindBoot := func() {
		stopMeter()
		<-meterStopped
		if stopAlerting != nil {
			stopAlerting()
		}
		stopSweeper()
		closeCtx, cancelClose := context.WithTimeout(context.Background(), shutdownTimeout)
		writer.Close(closeCtx)
		cancelClose()
	}

	// The alerting engine is two loops on one cancel (D477/D490): the evaluator
	// claims due rules every 60s and writes transitions as pending events, and
	// the deliverer drains those events every 5s through the notifier. They
	// share nothing but the pool and the shutdown signal — a wedged endpoint
	// cannot stall evaluation, and a slow evaluation cannot delay a delivery.
	//
	// The egress policy is resolved HERE, at boot, and propagated like any
	// other configuration error (D492): a malformed
	// OBSTACK_NOTIFIER_ALLOW_PRIVATE must fail the process, not the first
	// delivery that reads it.
	notifyPolicy, err := notify.PolicyFromEnv()
	if err != nil {
		unwindBoot()
		return err
	}
	slog.Info("notifier egress policy",
		"allow_private", notifyPolicy.AllowPrivate, "env", notify.EnvAllowPrivate)

	// Like the sweeper, the evaluator connects and pings before anything is
	// bound: a process that claims to evaluate alerts must be able to read the
	// telemetry they are about.
	evaluator, err := alerting.New(connectCtx, alerting.Config{
		DSN:  cfg.ClickHouseDSN,
		Pool: pool,
	})
	if err != nil {
		unwindBoot()
		return err
	}
	alertCtx, stopAlerts := context.WithCancel(context.Background())
	evalStopped := make(chan struct{})
	go func() {
		defer close(evalStopped)
		evaluator.Run(alertCtx)
	}()
	deliverer := alerting.NewDeliverer(pool, notify.New(notifyPolicy))
	deliverStopped := make(chan struct{})
	go func() {
		defer close(deliverStopped)
		deliverer.Run(alertCtx)
	}()
	stopAlerting = func() {
		stopAlerts()
		<-evalStopped
		<-deliverStopped
		evaluator.Close()
	}

	receiver := receive.New(receive.Config{
		GRPCAddr: cfg.OTLPGRPCAddr,
		HTTPAddr: cfg.OTLPHTTPAddr,
		Auth:     auth.New(keys),
		Consumer: writer,
		// Both are non-blocking cache reads (D164c): the quota verdict decides
		// whether this export is sampled, and neither may put Postgres in the
		// hot path. Ingest reads our own ledger and never calls Polar (D110).
		OverQuota: func(workspaceID string) bool { return keys.State(workspaceID).OverQuota },
		Meter:     meter,
		// D287: empty leaves the bearer key as the drain route's only
		// credential. Which posture we booted in is logged below rather than
		// left for an operator to infer from a request that did or did not get
		// refused.
		VercelDrainSecret: cfg.VercelDrainSecret,
	})
	slog.Info("vercel drain signature verification",
		"enabled", cfg.VercelDrainSecret != "", "env", config.EnvVercelDrainSecret)
	if err := receiver.Start(); err != nil {
		unwindBoot()
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

	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancelShutdown()
	// Order matters: stop taking exports, then flush what is buffered, and only
	// then drop /metrics — the last flush is worth watching. The meter stops
	// after the receivers so the counts of the last exports in flight are in it,
	// and before the pool it flushes through.
	if err := receiver.Shutdown(shutdownCtx); err != nil {
		slog.Error("otlp shutdown", "error", err)
	}
	// writer.Close shares this same ctx (D263): whatever receiver.Shutdown just
	// spent is gone from the writer's budget too, and the final flush's retry
	// loop never sleeps past what is left of it.
	if err := writer.Close(shutdownCtx); err != nil {
		slog.Error("writer close", "error", err)
	}
	stopMeter()
	<-meterStopped
	// The two alerting loops stop claiming before the pool they claim through
	// closes (the deferred pool.Close above runs last), which is the whole
	// ordering rule the sweeper established. Neither holds anything back: an
	// in-flight tick is abandoned with its context and rolls back whole, so a
	// half-evaluated tick never commits and a pending event stays pending for
	// the next process to claim — which is exactly what the durable row is for
	// (D490).
	stopAlerting()
	// The sweep stops last of the background loops and holds nothing back: an
	// in-flight DELETE is abandoned with its context (D252), and retention is
	// re-established whole on the next process's first sweep.
	stopSweeper()
	if err := admin.Shutdown(shutdownCtx); err != nil && runErr == nil {
		runErr = err
	}
	return runErr
}

// pricesFor is the D167 seam between the cache and the write path: the table a
// workspace's spans are costed with is whatever the keystore built on its last
// refresh, handed over as it is. It builds nothing (D174) — the D108 overrides
// were layered in once, thirty seconds' worth of exports ago, and doing it here
// would put a sort on the path of every export instead. A workspace the cache
// has never read prices off the embedded list, which is fail-open: an outage of
// ours prices telemetry at list price rather than not at all.
func pricesFor(keys *keystore.Store) func(workspaceID string) *pricing.Table {
	return func(workspaceID string) *pricing.Table { return keys.State(workspaceID).Prices }
}

// openPostgres builds the process's pool. The DSN is parsed before dialing so a
// malformed one is reported as the configuration mistake it is, naming the
// variable to go fix — the shape internal/pgmigrate already reports Postgres
// problems in.
func openPostgres(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse %s: %w", envPostgresDSN, err)
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("connect postgres: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping postgres: %w", err)
	}
	return pool, nil
}

// pendingVersions is the schema check ensureSchema and ensurePGSchema run when
// they are not the ones applying — migrate.Pending and pgmigrate.Pending share
// it because the two sets are the same class. It is injected rather than called
// directly so the refusal path — the single safety property this whole mode
// exists to provide — is unit testable with no database to point at. Every
// integration test in this service skips when there is none, and a guarantee
// that only holds when someone remembered to start one is not a guarantee.
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
		logSchema(storeClickHouse, applied)
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
	slog.Info("schema verified", "store", storeClickHouse, "migrate_on_boot", false)
	return nil
}

// ensurePGSchema is ensureSchema against the other store, down to the refusal:
// OBSTACK_PG_MIGRATE_ON_BOOT=false means the `ingest pg-migrate` Job applies,
// not that this process serves against whatever it finds.
func ensurePGSchema(ctx context.Context, dsn string, migrateOnBoot bool, fsys fs.FS, pending pendingVersions) error {
	if migrateOnBoot {
		applied, err := pgmigrate.Run(ctx, dsn, fsys)
		if err != nil {
			return fmt.Errorf("postgres migrations: %w", err)
		}
		logSchema(storePostgres, applied)
		return nil
	}

	unapplied, err := pending(ctx, dsn, fsys)
	if err != nil {
		return fmt.Errorf("postgres schema check: %w", err)
	}
	if len(unapplied) > 0 {
		return fmt.Errorf("postgres migrations %s unapplied and %s is false; run `ingest pg-migrate` first",
			strings.Join(unapplied, ", "), envPGMigrateOnBoot)
	}
	slog.Info("schema verified", "store", storePostgres, "pg_migrate_on_boot", false)
	return nil
}

// Two schemas mean two sets of otherwise identical log lines, so every one of
// them carries the store it is about (D112). The message text is unchanged from
// when there was only one store — the runbooks grep it.
const (
	storeClickHouse = "clickhouse"
	storePostgres   = "postgres"
)

func logSchema(store string, applied []string) {
	if len(applied) == 0 {
		slog.Info("schema already up to date", "store", store)
	} else {
		slog.Info("schema migrations applied", "store", store, "versions", applied)
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
