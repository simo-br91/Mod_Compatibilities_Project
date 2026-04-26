package app

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func seededSimulationRun() Result {
	return Result{
		SimulationRunID: "sim_ana_demo",
		AnalysisID:      "ana_demo",
		PackSnapshotID:  "snap_demo",
		RecipeID:        "rcp_client_startup_v1",
		Status:          "failed",
		Summary:         "1 deterministic simulation checks failed.",
		Observations: []Observation{
			{
				ObservationID: "obs_1",
				Kind:          "smoke_test",
				Status:        "passed",
				Summary:       "Executed recipe client-startup-smoke with deterministic replay steps.",
				FindingTypes:  []string{},
			},
			{
				ObservationID: "obs_2",
				Kind:          "startup",
				Status:        "failed",
				Summary:       "Client startup smoke test reproduced a render transformer conflict.",
				FindingTypes:  []string{"declared_incompatibility"},
			},
		},
		TenantID:      "org_demo",
		SchemaVersion: 1,
		CreatedAt:     "2026-04-07T00:00:00.000Z",
	}
}

func TestUpsertAndGetSimulationRun(t *testing.T) {
	service := NewService("")
	run := seededSimulationRun()

	service.UpsertSimulationRun(UpsertSimulationRunRequest{
		SimulationRun: run,
	})

	result, err := service.GetRun("ana_demo")
	if err != nil {
		t.Fatalf("expected simulation run, got error: %v", err)
	}

	if result.SimulationRunID != run.SimulationRunID {
		t.Fatalf("expected simulation run id %s, got %s", run.SimulationRunID, result.SimulationRunID)
	}

	if len(result.Observations) != 2 {
		t.Fatalf("expected 2 observations, got %d", len(result.Observations))
	}
}

func TestLazyHydrationFromOrchestrator(t *testing.T) {
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/internal/analyses/ana_remote/simulation-run" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{
			"simulationRun": {
				"simulationRunId": "sim_ana_remote",
				"analysisId": "ana_remote",
				"packSnapshotId": "snap_remote",
				"recipeId": "rcp_client_startup_v1",
				"status": "failed",
				"summary": "1 deterministic simulation checks failed.",
				"observations": [
					{
						"observationId": "obs_remote_1",
						"kind": "smoke_test",
						"status": "passed",
						"summary": "Executed recipe client-startup-smoke with deterministic replay steps.",
						"findingTypes": []
					},
					{
						"observationId": "obs_remote_2",
						"kind": "startup",
						"status": "failed",
						"summary": "Client startup smoke test reproduced a render transformer conflict.",
						"findingTypes": ["declared_incompatibility"]
					}
				],
				"tenantId": "org_demo",
				"schemaVersion": 1,
				"createdAt": "2026-04-07T00:00:00.000Z"
			}
		}`))
	}))
	defer orchestrator.Close()

	service := NewService(orchestrator.URL)
	service.httpClient = orchestrator.Client()

	result, err := service.GetRun("ana_remote")
	if err != nil {
		t.Fatalf("expected hydrated simulation run, got error: %v", err)
	}

	if result.SimulationRunID != "sim_ana_remote" {
		t.Fatalf("expected hydrated simulation run id sim_ana_remote, got %s", result.SimulationRunID)
	}

	if len(result.Observations) != 2 {
		t.Fatalf("expected 2 observations, got %d", len(result.Observations))
	}
}
