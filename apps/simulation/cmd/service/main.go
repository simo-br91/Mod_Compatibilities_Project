package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/modcompat/platform/apps/simulation/internal/app"
)

type requestContext struct {
	RequestID string
	TraceID   string
}

type serviceErrorPayload struct {
	Error struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
		RequestID string `json:"requestId"`
		TraceID   string `json:"traceId"`
	} `json:"error"`
}

type replayCache struct {
	responses map[string]json.RawMessage
}

func newReplayCache() *replayCache {
	return &replayCache{
		responses: map[string]json.RawMessage{},
	}
}

func buildRequestContext(r *http.Request) requestContext {
	requestID := strings.TrimSpace(r.Header.Get("x-request-id"))
	if requestID == "" {
		requestID = fmt.Sprintf("req-%d", os.Getpid())
	}
	traceID := strings.TrimSpace(r.Header.Get("x-trace-id"))
	if traceID == "" {
		traceID = requestID
	}
	return requestContext{RequestID: requestID, TraceID: traceID}
}

func getIdempotencyKey(r *http.Request) string {
	return strings.TrimSpace(r.Header.Get("x-idempotency-key"))
}

func decodeJSON(w http.ResponseWriter, r *http.Request, target interface{}) bool {
	if err := json.NewDecoder(r.Body).Decode(target); err != nil {
		writeError(w, http.StatusBadRequest, buildRequestContext(r), "invalid_json", err.Error(), false)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, statusCode int, context requestContext, payload interface{}) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("x-request-id", context.RequestID)
	w.Header().Set("x-trace-id", context.TraceID)
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, statusCode int, context requestContext, code string, message string, retryable bool) {
	payload := serviceErrorPayload{}
	payload.Error.Code = code
	payload.Error.Message = message
	payload.Error.Retryable = retryable
	payload.Error.RequestID = context.RequestID
	payload.Error.TraceID = context.TraceID
	writeJSON(w, statusCode, context, payload)
}

func writeRawJSON(w http.ResponseWriter, statusCode int, context requestContext, payload []byte) {
	w.Header().Set("content-type", "application/json")
	w.Header().Set("x-request-id", context.RequestID)
	w.Header().Set("x-trace-id", context.TraceID)
	w.WriteHeader(statusCode)
	_, _ = w.Write(payload)
}

func main() {
	service := app.NewService(os.Getenv("ORCHESTRATOR_SERVICE_URL"))
	replay := newReplayCache()
	port := os.Getenv("SIMULATION_HTTP_PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, requestContext{RequestID: "healthz", TraceID: "healthz"}, map[string]string{
			"service": "simulation",
			"status":  "phase8-ready",
		})
	})

	http.HandleFunc("/v1/internal/simulation/runs", func(w http.ResponseWriter, r *http.Request) {
		context := buildRequestContext(r)
		switch r.Method {
		case http.MethodPost:
			idempotencyKey := getIdempotencyKey(r)
			if idempotencyKey == "" {
				writeError(w, http.StatusBadRequest, context, "idempotency_key_required", "x-idempotency-key header is required for simulation write requests.", false)
				return
			}
			if replayed, ok := replay.responses["simulation-run:"+idempotencyKey]; ok {
				writeRawJSON(w, http.StatusOK, context, replayed)
				return
			}

			var request app.UpsertSimulationRunRequest
			if !decodeJSON(w, r, &request) {
				return
			}

			response := service.UpsertSimulationRun(request)
			payload, err := json.Marshal(response)
			if err != nil {
				writeError(w, http.StatusInternalServerError, context, "response_encode_failed", err.Error(), true)
				return
			}
			replay.responses["simulation-run:"+idempotencyKey] = payload
			writeRawJSON(w, http.StatusOK, context, payload)
		case http.MethodGet:
			analysisID := r.URL.Query().Get("analysis_id")
			response, err := service.GetRun(analysisID)
			if err != nil {
				writeError(w, http.StatusNotFound, context, "simulation_run_not_found", err.Error(), false)
				return
			}
			writeJSON(w, http.StatusOK, context, response)
		default:
			writeError(w, http.StatusMethodNotAllowed, context, "method_not_allowed", "method not allowed", false)
		}
	})

	http.HandleFunc("/v1/analyses/", func(w http.ResponseWriter, r *http.Request) {
		context := buildRequestContext(r)
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, context, "method_not_allowed", "method not allowed", false)
			return
		}

		path := strings.TrimPrefix(r.URL.Path, "/v1/analyses/")
		parts := strings.Split(strings.Trim(path, "/"), "/")
		if len(parts) != 2 || parts[1] != "simulation" {
			writeError(w, http.StatusNotFound, context, "route_not_found", "not found", false)
			return
		}

		response, err := service.GetRun(parts[0])
		if err != nil {
			writeError(w, http.StatusNotFound, context, "simulation_run_not_found", err.Error(), false)
			return
		}

		writeJSON(w, http.StatusOK, context, response)
	})

	log.Printf("simulation listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
