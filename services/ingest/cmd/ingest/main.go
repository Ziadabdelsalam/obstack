// Command ingest is the obstack telemetry ingest service. It owns the
// ClickHouse schema — applied at boot from the embedded migrations — and serves
// the OTLP receivers alongside an admin endpoint carrying /healthz and /metrics.
package main

import (
	"context"
	"errors"
	"fmt"
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

	if err := run(); err != nil {
		slog.Error("ingest stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	metrics.Init(cfg.WorkspaceIDs())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Migrations run before anything is served: a process that cannot own the
	// schema has no business reporting healthy.
	migrateCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	applied, err := migrate.Run(migrateCtx, cfg.ClickHouseDSN, migrations.FS)
	if err != nil {
		return fmt.Errorf("schema migrations: %w", err)
	}
	if len(applied) == 0 {
		slog.Info("schema already up to date")
	} else {
		slog.Info("schema migrations applied", "versions", applied)
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
