package app

import "testing"

func TestCreateUpsertAndGetAnalysis(t *testing.T) {
	service := NewService()

	accepted := service.Create(AnalysisCommand{
		AnalysisID:     "ana_demo",
		ProjectID:      "prj_demo",
		WorkspaceID:    "wrk_demo",
		OrganizationID: "org_demo",
		PackSnapshotID: "snap_demo",
		Trigger:        "manual",
		AnalysisMode:   "standard",
	})

	if accepted.Status != "accepted" {
		t.Fatalf("expected accepted status, got %s", accepted.Status)
	}

	err := service.UpsertAnalysis(UpsertAnalysisRequest{
		AnalysisID: "ana_demo",
		Result:     []byte(`{"analysis":{"analysisId":"ana_demo","status":"completed"}}`),
	})
	if err != nil {
		t.Fatalf("expected upsert to succeed, got error: %v", err)
	}

	result, err := service.GetAnalysis("ana_demo")
	if err != nil {
		t.Fatalf("expected stored result, got error: %v", err)
	}

	if string(result) != `{"analysis":{"analysisId":"ana_demo","status":"completed"}}` {
		t.Fatalf("unexpected stored result: %s", string(result))
	}
}
