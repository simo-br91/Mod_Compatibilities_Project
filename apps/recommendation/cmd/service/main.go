package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/modcompat/platform/apps/recommendation/internal/app"
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
	service := app.NewService(strings.TrimSpace(os.Getenv("ORCHESTRATOR_SERVICE_URL")))
	replay := newReplayCache()
	port := os.Getenv("RECOMMENDATION_HTTP_PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, requestContext{RequestID: "healthz", TraceID: "healthz"}, map[string]string{
			"service": "recommendation",
			"status":  "phase8-ready",
		})
	})

	http.HandleFunc("/v1/internal/recommendations/sets", func(w http.ResponseWriter, r *http.Request) {
		context := buildRequestContext(r)
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, context, "method_not_allowed", "method not allowed", false)
			return
		}
		idempotencyKey := getIdempotencyKey(r)
		if idempotencyKey == "" {
			writeError(w, http.StatusBadRequest, context, "idempotency_key_required", "x-idempotency-key header is required for recommendation write requests.", false)
			return
		}
		if replayed, ok := replay.responses["recommendation-set:"+idempotencyKey]; ok {
			writeRawJSON(w, http.StatusOK, context, replayed)
			return
		}

		var request app.UpsertRecommendationSetRequest
		if !decodeJSON(w, r, &request) {
			return
		}

		response := service.UpsertRecommendationSet(request)
		payload, err := json.Marshal(response)
		if err != nil {
			writeError(w, http.StatusInternalServerError, context, "response_encode_failed", err.Error(), true)
			return
		}
		replay.responses["recommendation-set:"+idempotencyKey] = payload
		writeRawJSON(w, http.StatusOK, context, payload)
	})

	http.HandleFunc("/v1/internal/recommendations/generate", func(w http.ResponseWriter, r *http.Request) {
		context := buildRequestContext(r)
		if r.Method != http.MethodPost {
			writeError(w, http.StatusMethodNotAllowed, context, "method_not_allowed", "method not allowed", false)
			return
		}
		idempotencyKey := getIdempotencyKey(r)
		if idempotencyKey == "" {
			writeError(w, http.StatusBadRequest, context, "idempotency_key_required", "x-idempotency-key header is required for recommendation write requests.", false)
			return
		}
		if replayed, ok := replay.responses["recommendation-generate:"+idempotencyKey]; ok {
			writeRawJSON(w, http.StatusOK, context, replayed)
			return
		}

		var request app.GenerateRecommendationsRequest
		if !decodeJSON(w, r, &request) {
			return
		}

		response := service.GenerateRecommendationSet(request)
		payload, err := json.Marshal(response)
		if err != nil {
			writeError(w, http.StatusInternalServerError, context, "response_encode_failed", err.Error(), true)
			return
		}
		replay.responses["recommendation-generate:"+idempotencyKey] = payload
		writeRawJSON(w, http.StatusOK, context, payload)
	})

	http.HandleFunc("/v1/analyses/", func(w http.ResponseWriter, r *http.Request) {
		context := buildRequestContext(r)
		if r.Method != http.MethodGet {
			writeError(w, http.StatusMethodNotAllowed, context, "method_not_allowed", "method not allowed", false)
			return
		}

		path := strings.TrimPrefix(r.URL.Path, "/v1/analyses/")
		parts := strings.Split(strings.Trim(path, "/"), "/")
		if len(parts) != 2 || parts[1] != "recommendations" {
			writeError(w, http.StatusNotFound, context, "route_not_found", "not found", false)
			return
		}

		recommendationSet, err := service.GetRecommendationSet(parts[0])
		if err != nil {
			writeError(w, http.StatusNotFound, context, "recommendation_set_not_found", err.Error(), false)
			return
		}

		writeJSON(w, http.StatusOK, context, recommendationSet)
	})

	http.HandleFunc("/v1/recommendations/", func(w http.ResponseWriter, r *http.Request) {
		context := buildRequestContext(r)
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/feedback") {
			writeError(w, http.StatusMethodNotAllowed, context, "method_not_allowed", "method not allowed", false)
			return
		}

		path := strings.TrimPrefix(r.URL.Path, "/v1/recommendations/")
		recommendationID := strings.TrimSuffix(path, "/feedback")
		analysisID := r.URL.Query().Get("analysis_id")
		if analysisID == "" || recommendationID == "" {
			writeError(w, http.StatusBadRequest, context, "analysis_and_recommendation_required", "analysis_id and recommendationId are required", false)
			return
		}
		idempotencyKey := getIdempotencyKey(r)
		if idempotencyKey == "" {
			writeError(w, http.StatusBadRequest, context, "idempotency_key_required", "x-idempotency-key header is required for recommendation write requests.", false)
			return
		}
		if replayed, ok := replay.responses["recommendation-feedback:"+idempotencyKey]; ok {
			writeRawJSON(w, http.StatusCreated, context, replayed)
			return
		}

		var request app.SubmitRecommendationFeedbackRequest
		if !decodeJSON(w, r, &request) {
			return
		}

		response, err := service.SubmitFeedback(analysisID, recommendationID, request)
		if err != nil {
			writeError(w, http.StatusNotFound, context, "recommendation_not_found", err.Error(), false)
			return
		}

		payload, err := json.Marshal(response)
		if err != nil {
			writeError(w, http.StatusInternalServerError, context, "response_encode_failed", err.Error(), true)
			return
		}
		replay.responses["recommendation-feedback:"+idempotencyKey] = payload
		writeRawJSON(w, http.StatusCreated, context, payload)
	})

	http.HandleFunc("/v1/recommendation-sets/", func(w http.ResponseWriter, r *http.Request) {
		context := buildRequestContext(r)
		if r.Method != http.MethodPost || !strings.HasSuffix(r.URL.Path, "/outcomes") {
			writeError(w, http.StatusMethodNotAllowed, context, "method_not_allowed", "method not allowed", false)
			return
		}

		path := strings.TrimPrefix(r.URL.Path, "/v1/recommendation-sets/")
		recommendationSetID := strings.TrimSuffix(path, "/outcomes")
		if recommendationSetID == "" {
			writeError(w, http.StatusBadRequest, context, "recommendation_set_required", "recommendationSetId is required", false)
			return
		}
		idempotencyKey := getIdempotencyKey(r)
		if idempotencyKey == "" {
			writeError(w, http.StatusBadRequest, context, "idempotency_key_required", "x-idempotency-key header is required for recommendation write requests.", false)
			return
		}
		if replayed, ok := replay.responses["recommendation-outcome:"+idempotencyKey]; ok {
			writeRawJSON(w, http.StatusCreated, context, replayed)
			return
		}

		var request app.RecordRecommendationOutcomeRequest
		if !decodeJSON(w, r, &request) {
			return
		}

		response, err := service.RecordOutcome(recommendationSetID, request)
		if err != nil {
			writeError(w, http.StatusNotFound, context, "recommendation_set_not_found", err.Error(), false)
			return
		}

		payload, err := json.Marshal(response)
		if err != nil {
			writeError(w, http.StatusInternalServerError, context, "response_encode_failed", err.Error(), true)
			return
		}
		replay.responses["recommendation-outcome:"+idempotencyKey] = payload
		writeRawJSON(w, http.StatusCreated, context, payload)
	})

	log.Printf("recommendation listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
