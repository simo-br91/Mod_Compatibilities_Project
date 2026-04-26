package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/modcompat/platform/apps/graph/internal/app"
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
	store, err := buildGraphStoreFromEnv()
	if err != nil {
		log.Fatalf("graph store configuration failed: %v", err)
	}

	service := app.NewService(strings.TrimSpace(os.Getenv("ORCHESTRATOR_SERVICE_URL")), store)
	replay := newReplayCache()
	port := os.Getenv("GRAPH_HTTP_PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, requestContext{RequestID: "healthz", TraceID: "healthz"}, map[string]string{
			"service": "graph",
			"status":  "phase8-ready",
		})
	})

	http.HandleFunc("/v1/internal/graph/upsert", func(w http.ResponseWriter, r *http.Request) {
		context := buildRequestContext(r)
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, context, "method_not_allowed", "method not allowed", false)
			return
		}
		idempotencyKey := getIdempotencyKey(r)
		if idempotencyKey == "" {
			writeError(w, http.StatusBadRequest, context, "idempotency_key_required", "x-idempotency-key header is required for graph write requests.", false)
			return
		}
		if replayed, ok := replay.responses["graph-upsert:"+idempotencyKey]; ok {
			writeRawJSON(w, http.StatusOK, context, replayed)
			return
		}

		var request app.UpsertGraphRequest
		if !decodeJSON(w, r, &request) {
			return
		}

		snapshot, err := service.UpsertGraph(request)
		if err != nil {
			writeError(w, http.StatusInternalServerError, context, "graph_persist_failed", err.Error(), true)
			return
		}
		payload, err := json.Marshal(snapshot)
		if err != nil {
			writeError(w, http.StatusInternalServerError, context, "response_encode_failed", err.Error(), true)
			return
		}
		replay.responses["graph-upsert:"+idempotencyKey] = payload
		writeRawJSON(w, http.StatusOK, context, payload)
	})

	http.HandleFunc("/v1/internal/graph/snapshot", func(w http.ResponseWriter, r *http.Request) {
		context := buildRequestContext(r)
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, context, "method_not_allowed", "method not allowed", false)
			return
		}

		response, err := service.GetGraph(r.URL.Query().Get("analysis_id"))
		if err != nil {
			writeError(w, http.StatusNotFound, context, "graph_not_found", err.Error(), false)
			return
		}

		writeJSON(w, http.StatusOK, context, response)
	})

	http.HandleFunc("/v1/internal/graph/neighborhood", func(w http.ResponseWriter, r *http.Request) {
		context := buildRequestContext(r)
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, context, "method_not_allowed", "method not allowed", false)
			return
		}

		depth := 1
		if rawDepth := r.URL.Query().Get("depth"); rawDepth != "" {
			if parsed, err := strconv.Atoi(rawDepth); err == nil {
				depth = parsed
			}
		}

		response, err := service.GetNeighborhood(app.NeighborhoodRequest{
			AnalysisID: r.URL.Query().Get("analysis_id"),
			NodeID:     r.URL.Query().Get("node_id"),
			Depth:      depth,
		})
		if err != nil {
			writeError(w, http.StatusNotFound, context, "neighborhood_not_found", err.Error(), false)
			return
		}

		writeJSON(w, http.StatusOK, context, response)
	})

	http.HandleFunc("/v1/internal/graph/explanations", func(w http.ResponseWriter, r *http.Request) {
		context := buildRequestContext(r)
		switch r.Method {
		case http.MethodPost:
			idempotencyKey := getIdempotencyKey(r)
			if idempotencyKey == "" {
				writeError(w, http.StatusBadRequest, context, "idempotency_key_required", "x-idempotency-key header is required for graph write requests.", false)
				return
			}
			if replayed, ok := replay.responses["graph-explanation:"+idempotencyKey]; ok {
				writeRawJSON(w, http.StatusOK, context, replayed)
				return
			}

			var request struct {
				AnalysisID string          `json:"analysis_id"`
				FindingID  string          `json:"finding_id"`
				Nodes      []app.GraphNode `json:"nodes"`
				Edges      []app.GraphEdge `json:"edges"`
			}
			if !decodeJSON(w, r, &request) {
				return
			}

			response, err := service.UpsertExplanation(
				app.ExplanationRequest{
					AnalysisID: request.AnalysisID,
					FindingID:  request.FindingID,
				},
				request.Nodes,
				request.Edges,
			)
			if err != nil {
				writeError(w, http.StatusInternalServerError, context, "explanation_persist_failed", err.Error(), true)
				return
			}
			payload, err := json.Marshal(response)
			if err != nil {
				writeError(w, http.StatusInternalServerError, context, "response_encode_failed", err.Error(), true)
				return
			}
			replay.responses["graph-explanation:"+idempotencyKey] = payload
			writeRawJSON(w, http.StatusOK, context, payload)
		case http.MethodGet:
			response, err := service.Explain(app.ExplanationRequest{
				AnalysisID: r.URL.Query().Get("analysis_id"),
				FindingID:  r.URL.Query().Get("finding_id"),
			})
			if err != nil {
				writeError(w, http.StatusNotFound, context, "explanation_not_found", err.Error(), false)
				return
			}
			writeJSON(w, http.StatusOK, context, response)
		default:
			writeError(w, http.StatusMethodNotAllowed, context, "method_not_allowed", "method not allowed", false)
		}
	})

	log.Printf("graph listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}

func buildGraphStoreFromEnv() (*app.Neo4jGraphStore, error) {
	rawURL := strings.TrimSpace(os.Getenv("NEO4J_HTTP_URL"))
	if rawURL == "" {
		rawURL = strings.TrimSpace(os.Getenv("NEO4J_URI"))
	}
	if rawURL == "" {
		rawURL = strings.TrimSpace(os.Getenv("NEO4J_URL"))
	}
	if rawURL == "" {
		return nil, nil
	}

	return app.NewNeo4jGraphStore(
		rawURL,
		strings.TrimSpace(os.Getenv("NEO4J_USERNAME")),
		os.Getenv("NEO4J_PASSWORD"),
		nil,
	)
}
