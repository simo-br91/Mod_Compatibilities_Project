package app

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type stubGraphStore struct {
	graphs       map[string]GraphSnapshot
	explanations map[string]map[string]ExplanationPath
}

func newStubGraphStore() *stubGraphStore {
	return &stubGraphStore{
		graphs:       map[string]GraphSnapshot{},
		explanations: map[string]map[string]ExplanationPath{},
	}
}

func (s *stubGraphStore) SaveGraph(snapshot GraphSnapshot) error {
	s.graphs[snapshot.AnalysisID] = snapshot
	return nil
}

func (s *stubGraphStore) LoadGraph(analysisID string) (GraphSnapshot, bool, error) {
	snapshot, ok := s.graphs[analysisID]
	return snapshot, ok, nil
}

func (s *stubGraphStore) SaveExplanation(path ExplanationPath) error {
	if _, ok := s.explanations[path.AnalysisID]; !ok {
		s.explanations[path.AnalysisID] = map[string]ExplanationPath{}
	}
	s.explanations[path.AnalysisID][path.FindingID] = path
	return nil
}

func (s *stubGraphStore) LoadExplanation(analysisID string, findingID string) (ExplanationPath, bool, error) {
	explanations, ok := s.explanations[analysisID]
	if !ok {
		return ExplanationPath{}, false, nil
	}
	path, found := explanations[findingID]
	return path, found, nil
}

func TestNeighborhoodAndExplanation(t *testing.T) {
	service := NewService("", nil)
	if _, err := service.UpsertGraph(UpsertGraphRequest{
		AnalysisID: "ana_demo",
		Nodes: []GraphNode{
			{NodeID: "snap_demo", NodeType: "pack_snapshot", Label: "snapshot"},
			{NodeID: "cp_sodium", NodeType: "project", Label: "Sodium"},
			{NodeID: "ver_sodium", NodeType: "version", Label: "0.6.0"},
		},
		Edges: []GraphEdge{
			{EdgeID: "e1", EdgeType: "contains", SourceID: "snap_demo", TargetID: "cp_sodium"},
			{EdgeID: "e2", EdgeType: "resolved_to", SourceID: "cp_sodium", TargetID: "ver_sodium"},
		},
	}); err != nil {
		t.Fatalf("expected graph upsert to succeed, got error: %v", err)
	}

	path, err := service.UpsertExplanation(
		ExplanationRequest{AnalysisID: "ana_demo", FindingID: "fnd_demo"},
		[]GraphNode{{NodeID: "cp_sodium", NodeType: "project", Label: "Sodium"}},
		[]GraphEdge{{EdgeID: "e2", EdgeType: "resolved_to", SourceID: "cp_sodium", TargetID: "ver_sodium"}},
	)
	if err != nil {
		t.Fatalf("expected explanation upsert to succeed, got error: %v", err)
	}

	snapshot, err := service.GetGraph("ana_demo")
	if err != nil {
		t.Fatalf("expected graph snapshot, got error: %v", err)
	}
	if len(snapshot.Nodes) != 3 {
		t.Fatalf("expected 3 graph nodes, got %d", len(snapshot.Nodes))
	}

	neighborhood, err := service.GetNeighborhood(NeighborhoodRequest{
		AnalysisID: "ana_demo",
		NodeID:     "snap_demo",
		Depth:      2,
	})
	if err != nil {
		t.Fatalf("expected neighborhood, got error: %v", err)
	}
	if len(neighborhood.Nodes) != 3 {
		t.Fatalf("expected 3 nodes, got %d", len(neighborhood.Nodes))
	}

	explanation, err := service.Explain(ExplanationRequest{
		AnalysisID: "ana_demo",
		FindingID:  "fnd_demo",
	})
	if err != nil {
		t.Fatalf("expected explanation, got error: %v", err)
	}
	if explanation.PathID != path.PathID {
		t.Fatalf("expected explanation path %s, got %s", path.PathID, explanation.PathID)
	}
}

func TestLazyDerivationFromOrchestratorContext(t *testing.T) {
	orchestrator := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/internal/analyses/ana_remote/graph-context" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{
			"analysisId":"ana_remote",
			"snapshot":{
				"packSnapshotId":"snap_remote",
				"environment":{
					"minecraftVersion":"1.21.1",
					"loader":"fabric",
					"javaVersion":"21",
					"side":"both"
				},
				"mods":[
					{
						"name":"sodium",
						"version":"0.6.0+mc1.21.1",
						"canonicalProjectId":"cp_sodium",
						"canonicalVersionId":"ver_sodium_121"
					}
				]
			},
			"findings":[
				{
					"findingId":"fnd_remote",
					"title":"Sodium mismatch",
					"subjects":[
						{
							"projectId":"cp_sodium",
							"versionId":"ver_sodium_121"
						}
					]
				}
			],
			"artifacts":[
				{
					"artifactAnalysisId":"aar_remote",
					"projectId":"cp_sodium",
					"versionId":"ver_sodium_121",
					"metadata":{
						"artifactId":"artifact_sodium_121",
						"name":"Sodium",
						"version":"0.6.0+mc1.21.1",
						"loaderHints":["fabric"],
						"mixinConfigFiles":["sodium.mixins.json"]
					},
					"mixinTargets":[
						{
							"ownerArtifactId":"artifact_sodium_121",
							"target":"net.minecraft.client.render.WorldRenderer"
						}
					],
					"classTargets":[],
					"resourceTargets":[],
					"embeddedLibraries":[]
				}
			],
			"projects":[
				{
					"projectId":"cp_sodium",
					"displayName":"Sodium"
				}
			],
			"versions":[
				{
					"versionId":"ver_sodium_121",
					"versionLabel":"0.6.0+mc1.21.1"
				}
			],
			"dependencies":[]
		}`))
	}))
	defer orchestrator.Close()

	store := newStubGraphStore()
	service := NewService(orchestrator.URL, store)
	service.httpClient = orchestrator.Client()

	snapshot, err := service.GetGraph("ana_remote")
	if err != nil {
		t.Fatalf("expected derived graph snapshot, got error: %v", err)
	}
	if len(snapshot.Nodes) < 4 {
		t.Fatalf("expected derived graph nodes, got %d", len(snapshot.Nodes))
	}
	if _, ok := store.graphs["ana_remote"]; !ok {
		t.Fatalf("expected derived graph to be persisted")
	}

	explanation, err := service.Explain(ExplanationRequest{
		AnalysisID: "ana_remote",
		FindingID:  "fnd_remote",
	})
	if err != nil {
		t.Fatalf("expected derived explanation, got error: %v", err)
	}
	if explanation.PathID != "exp_fnd_remote" {
		t.Fatalf("expected derived explanation path exp_fnd_remote, got %s", explanation.PathID)
	}
}

func TestLoadsPersistedGraphAndExplanation(t *testing.T) {
	store := newStubGraphStore()
	store.graphs["ana_saved"] = GraphSnapshot{
		AnalysisID: "ana_saved",
		Nodes: []GraphNode{
			{NodeID: "cp_saved", NodeType: "project", Label: "Saved Project"},
		},
	}
	store.explanations["ana_saved"] = map[string]ExplanationPath{
		"fnd_saved": {
			PathID:     "exp_fnd_saved",
			AnalysisID: "ana_saved",
			FindingID:  "fnd_saved",
			Summary:    "Saved explanation",
			Nodes:      []GraphNode{{NodeID: "cp_saved", NodeType: "project", Label: "Saved Project"}},
		},
	}

	service := NewService("", store)

	snapshot, err := service.GetGraph("ana_saved")
	if err != nil {
		t.Fatalf("expected persisted graph snapshot, got error: %v", err)
	}
	if len(snapshot.Nodes) != 1 || snapshot.Nodes[0].NodeID != "cp_saved" {
		t.Fatalf("expected persisted graph node cp_saved, got %+v", snapshot.Nodes)
	}

	explanation, err := service.Explain(ExplanationRequest{
		AnalysisID: "ana_saved",
		FindingID:  "fnd_saved",
	})
	if err != nil {
		t.Fatalf("expected persisted explanation, got error: %v", err)
	}
	if explanation.PathID != "exp_fnd_saved" {
		t.Fatalf("expected persisted explanation path exp_fnd_saved, got %s", explanation.PathID)
	}
}

func TestPropagatesStoreFailuresOnWrite(t *testing.T) {
	service := NewService("", failingGraphStore{})

	if _, err := service.UpsertGraph(UpsertGraphRequest{AnalysisID: "ana_fail"}); err == nil {
		t.Fatalf("expected graph store failure")
	}

	if _, err := service.UpsertExplanation(
		ExplanationRequest{AnalysisID: "ana_fail", FindingID: "fnd_fail"},
		nil,
		nil,
	); err == nil {
		t.Fatalf("expected explanation store failure")
	}
}

type failingGraphStore struct{}

func (failingGraphStore) SaveGraph(GraphSnapshot) error {
	return errors.New("save graph failed")
}

func (failingGraphStore) LoadGraph(string) (GraphSnapshot, bool, error) {
	return GraphSnapshot{}, false, nil
}

func (failingGraphStore) SaveExplanation(ExplanationPath) error {
	return errors.New("save explanation failed")
}

func (failingGraphStore) LoadExplanation(string, string) (ExplanationPath, bool, error) {
	return ExplanationPath{}, false, nil
}
