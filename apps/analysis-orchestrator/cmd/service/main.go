package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/modcompat/platform/apps/analysis-orchestrator/internal/app"
)

func decodeJSON(w http.ResponseWriter, r *http.Request, target interface{}) bool {
	if err := json.NewDecoder(r.Body).Decode(target); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, payload interface{}) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(payload)
}

func main() {
	svc := app.NewService()
	port := os.Getenv("ORCHESTRATOR_HTTP_PORT")
	if port == "" {
		port = "8080"
	}

	http.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]string{
			"service": "analysis-orchestrator",
			"status":  "phase8-ready",
		})
	})

	http.HandleFunc("/v1/analyses", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var command app.AnalysisCommand
		if !decodeJSON(w, r, &command) {
			return
		}

		response := svc.Create(command)
		w.WriteHeader(http.StatusAccepted)
		writeJSON(w, response)
	})

	http.HandleFunc("/v1/internal/analyses/upsert", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		var request app.UpsertAnalysisRequest
		if !decodeJSON(w, r, &request) {
			return
		}

		if err := svc.UpsertAnalysis(request); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}

		writeJSON(w, map[string]string{
			"analysisId": request.AnalysisID,
			"status":     "stored",
		})
	})

	http.HandleFunc("/v1/analyses/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		path := strings.TrimPrefix(r.URL.Path, "/v1/analyses/")
		parts := strings.Split(strings.Trim(path, "/"), "/")
		if len(parts) != 1 || parts[0] == "" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}

		result, err := svc.GetAnalysis(parts[0])
		if err != nil {
			http.Error(w, err.Error(), http.StatusNotFound)
			return
		}

		w.Header().Set("content-type", "application/json")
		_, _ = w.Write(result)
	})

	log.Printf("analysis-orchestrator listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
