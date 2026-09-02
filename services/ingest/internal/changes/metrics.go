package changes

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// The refusal reasons the ops counter is labelled with (D497). Four values,
// fixed here so the label set cannot grow from a call site.
const (
	RefusedRateLimited = "rate_limited"
	RefusedStorage     = "storage"
)

// RateCapMessage is the 429 body's one sentence; the drive asserts it.
const RateCapMessage = "change events are capped at 60 per minute per workspace"

var (
	accepted = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "obstack_ingest_changes_accepted_total",
		Help: "Change events written to change_events, by kind.",
	}, []string{"kind"})

	refused = promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "obstack_ingest_changes_refused_total",
		Help: "POST /v1/changes requests refused after auth: decode (unreadable or non-JSON), invalid (a well-formed document outside the contract), rate_limited (the per-workspace cap), storage (Postgres refused or was unreachable — the 503 path).",
	}, []string{"reason"})

	deduplicated = promauto.NewCounter(prometheus.CounterOpts{
		Name: "obstack_ingest_changes_deduplicated_total",
		Help: "Posts answered with an existing row because their external_id was already held by the workspace (D496).",
	})
)

// Accepted counts one written event.
func Accepted(kind string) { accepted.WithLabelValues(kind).Inc() }

// Refused counts one refusal under its reason.
func Refused(reason string) { refused.WithLabelValues(reason).Inc() }

// Deduplicated counts one dedupe answer.
func Deduplicated() { deduplicated.Inc() }
