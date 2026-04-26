package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func seededRecommendationSet() RecommendationSet {
	return RecommendationSet{
		RecommendationSetID: "rset_ana_demo",
		AnalysisID:          "ana_demo",
		TenantID:            "org_demo",
		SchemaVersion:       1,
		GenerationStrategy:  "deterministic-phase4-v1",
		Items: []Recommendation{
			{
				RecommendationID: "rec_ana_demo_1",
				Kind:             "replacement",
				Rank:             1,
				Confidence:       0.89,
				Summary:          "Replace OptiFine with a known compatible alternative.",
				FindingIDs:       []string{"fnd_conflict"},
			},
			{
				RecommendationID: "rec_ana_demo_2",
				Kind:             "remediation_plan",
				Rank:             2,
				Confidence:       0.97,
				Summary:          "Add the required dependency before rerunning the analysis.",
				FindingIDs:       []string{"fnd_dependency"},
			},
		},
		Bundles: []RecommendationBundle{
			{
				BundleID:                  "rbd_ana_demo_minimal",
				RecommendationSetID:       "rset_ana_demo",
				Strategy:                  "minimal_unblock",
				RecommendationIDs:         []string{"rec_ana_demo_1"},
				Summary:                   "Minimal unblock plan.",
				Rationale:                 "Target the highest-priority incompatibility first.",
				MigrationCost:             "medium",
				ExpectedCompatibilityGain: 0.84,
				CreatedAt:                 "2026-04-07T00:00:00.000Z",
			},
		},
		Summary: RecommendationSetSummary{
			RecommendationCount:    2,
			BundleCount:            1,
			UnresolvedFindingCount: 0,
		},
		CreatedAt: "2026-04-07T00:00:00.000Z",
	}
}

func TestUpsertAndGetRecommendationSet(t *testing.T) {
	service := NewService("")
	input := seededRecommendationSet()

	service.UpsertRecommendationSet(UpsertRecommendationSetRequest{
		RecommendationSet: input,
	})

	result, err := service.GetRecommendationSet("ana_demo")
	if err != nil {
		t.Fatalf("expected recommendation set, got error: %v", err)
	}

	if result.RecommendationSetID != input.RecommendationSetID {
		t.Fatalf("expected recommendation set id %s, got %s", input.RecommendationSetID, result.RecommendationSetID)
	}
}

func TestFeedbackAndOutcomeUpdateStatuses(t *testing.T) {
	service := NewService("")
	service.UpsertRecommendationSet(UpsertRecommendationSetRequest{
		RecommendationSet: seededRecommendationSet(),
	})

	feedback, err := service.SubmitFeedback("ana_demo", "rec_ana_demo_1", SubmitRecommendationFeedbackRequest{
		FeedbackType: "accepted",
		CreatedBy:    "usr_demo",
	})
	if err != nil {
		t.Fatalf("expected feedback to succeed, got error: %v", err)
	}

	if feedback.FeedbackType != "accepted" {
		t.Fatalf("expected accepted feedback, got %s", feedback.FeedbackType)
	}

	outcome, err := service.RecordOutcome("rset_ana_demo", RecordRecommendationOutcomeRequest{
		Status:                   "validated",
		AppliedRecommendationIDs: []string{"rec_ana_demo_1"},
		ValidationSummary:        "Validated in pack retest.",
		CreatedBy:                "usr_demo",
	})
	if err != nil {
		t.Fatalf("expected outcome to succeed, got error: %v", err)
	}

	if outcome.Status != "validated" {
		t.Fatalf("expected validated outcome, got %s", outcome.Status)
	}

	recommendationSet, err := service.GetRecommendationSet("ana_demo")
	if err != nil {
		t.Fatalf("expected recommendation set after outcome, got error: %v", err)
	}

	if recommendationSet.Items[0].Status == nil || *recommendationSet.Items[0].Status != "applied" {
		t.Fatalf("expected first recommendation status to be applied")
	}
}

func TestLazyHydrationFromOrchestrator(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		if r.URL.Path != "/v1/internal/analyses/ana_remote/recommendation-context" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}

		_ = json.NewEncoder(w).Encode(GenerateRecommendationsRequest{
			AnalysisID: "ana_remote",
			TenantID:   "org_demo",
			Snapshot: PackSnapshot{
				PackSnapshotID: "snap_remote",
				Environment: AnalysisEnvironment{
					MinecraftVersion: "1.21.1",
					Loader:           "fabric",
					JavaVersion:      "21",
					Side:             "both",
				},
				Mods: []PackMod{
					{
						CanonicalProjectID: stringPtr("cp_optifine"),
					},
				},
			},
			Findings: []Finding{
				{
					FindingID:  "fnd_remote",
					Type:       "declared_incompatibility",
					Severity:   "critical",
					Confidence: 1,
					Title:      "OptiFine conflicts with the Fabric rendering stack",
					Subjects: []FindingSubject{
						{
							ProjectID: "cp_optifine",
						},
					},
				},
			},
			Projects: []CatalogProject{
				{
					ProjectID:                        "cp_optifine",
					DisplayName:                      "OptiFine",
					RecommendedReplacementProjectIDs: []string{"cp_sodium"},
				},
				{
					ProjectID:   "cp_sodium",
					DisplayName: "Sodium",
				},
			},
			Versions: []CatalogVersion{
				{
					VersionID:         "ver_sodium",
					ProjectID:         "cp_sodium",
					VersionLabel:      "0.6.0+mc1.21.1",
					Loaders:           []string{"fabric"},
					MinecraftVersions: []string{"1.21.1"},
				},
			},
		})
	}))
	defer server.Close()

	service := NewService(server.URL)

	recommendationSet, err := service.GetRecommendationSet("ana_remote")
	if err != nil {
		t.Fatalf("expected recommendation set from orchestrator hydration, got error: %v", err)
	}

	if recommendationSet.AnalysisID != "ana_remote" {
		t.Fatalf("expected analysis id ana_remote, got %s", recommendationSet.AnalysisID)
	}

	if recommendationSet.TenantID != "org_demo" {
		t.Fatalf("expected tenant id org_demo, got %s", recommendationSet.TenantID)
	}

	if len(recommendationSet.Items) == 0 {
		t.Fatalf("expected generated recommendations after hydration")
	}

	if _, err := service.GetRecommendationSet("ana_remote"); err != nil {
		t.Fatalf("expected cached recommendation set on second read, got error: %v", err)
	}

	if requestCount != 1 {
		t.Fatalf("expected one orchestrator hydration request, got %d", requestCount)
	}
}

func stringPtr(value string) *string {
	return &value
}
