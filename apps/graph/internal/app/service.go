package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type GraphNode struct {
	NodeID   string                 `json:"node_id"`
	NodeType string                 `json:"node_type"`
	Label    string                 `json:"label"`
	Props    map[string]interface{} `json:"properties,omitempty"`
}

type GraphEdge struct {
	EdgeID   string                 `json:"edge_id"`
	EdgeType string                 `json:"edge_type"`
	SourceID string                 `json:"source_id"`
	TargetID string                 `json:"target_id"`
	Weight   float64                `json:"weight,omitempty"`
	Props    map[string]interface{} `json:"properties,omitempty"`
}

type UpsertGraphRequest struct {
	AnalysisID string      `json:"analysis_id"`
	Nodes      []GraphNode `json:"nodes"`
	Edges      []GraphEdge `json:"edges"`
}

type NeighborhoodRequest struct {
	AnalysisID string `json:"analysis_id"`
	NodeID     string `json:"node_id"`
	Depth      int    `json:"depth"`
}

type ExplanationRequest struct {
	AnalysisID string `json:"analysis_id"`
	FindingID  string `json:"finding_id"`
}

type ExplanationPath struct {
	PathID     string      `json:"path_id"`
	AnalysisID string      `json:"analysis_id"`
	FindingID  string      `json:"finding_id"`
	Summary    string      `json:"summary"`
	Nodes      []GraphNode `json:"nodes"`
	Edges      []GraphEdge `json:"edges"`
}

type GraphSnapshot struct {
	AnalysisID string      `json:"analysis_id"`
	Nodes      []GraphNode `json:"nodes"`
	Edges      []GraphEdge `json:"edges"`
}

type NeighborhoodResponse struct {
	AnalysisID   string      `json:"analysis_id"`
	CenterNodeID string      `json:"center_node_id"`
	Depth        int         `json:"depth"`
	Nodes        []GraphNode `json:"nodes"`
	Edges        []GraphEdge `json:"edges"`
}

type graphContextResponse struct {
	AnalysisID   string                   `json:"analysisId"`
	Snapshot     graphContextSnapshot     `json:"snapshot"`
	Findings     []graphContextFinding    `json:"findings"`
	Artifacts    []graphContextArtifact   `json:"artifacts"`
	Projects     []graphContextProject    `json:"projects"`
	Versions     []graphContextVersion    `json:"versions"`
	Dependencies []graphContextDependency `json:"dependencies"`
}

type graphContextSnapshot struct {
	PackSnapshotID string                 `json:"packSnapshotId"`
	Environment    map[string]interface{} `json:"environment"`
	Mods           []graphContextMod      `json:"mods"`
}

type graphContextMod struct {
	Name               string `json:"name"`
	Version            string `json:"version,omitempty"`
	CanonicalProjectID string `json:"canonicalProjectId,omitempty"`
	CanonicalVersionID string `json:"canonicalVersionId,omitempty"`
}

type graphContextFinding struct {
	FindingID string                       `json:"findingId"`
	Title     string                       `json:"title"`
	Subjects  []graphContextFindingSubject `json:"subjects"`
}

type graphContextFindingSubject struct {
	ProjectID string `json:"projectId"`
	VersionID string `json:"versionId,omitempty"`
}

type graphContextArtifact struct {
	ArtifactAnalysisID string                         `json:"artifactAnalysisId"`
	ProjectID          string                         `json:"projectId"`
	VersionID          string                         `json:"versionId,omitempty"`
	Metadata           graphContextArtifactMetadata   `json:"metadata"`
	MixinTargets       []graphContextTargetDescriptor `json:"mixinTargets"`
	ClassTargets       []graphContextTargetDescriptor `json:"classTargets"`
	ResourceTargets    []graphContextTargetDescriptor `json:"resourceTargets"`
	EmbeddedLibraries  []graphContextEmbeddedLibrary  `json:"embeddedLibraries"`
}

type graphContextArtifactMetadata struct {
	ArtifactID       string   `json:"artifactId"`
	Name             string   `json:"name"`
	Version          string   `json:"version,omitempty"`
	LoaderHints      []string `json:"loaderHints"`
	MixinConfigFiles []string `json:"mixinConfigFiles"`
}

type graphContextTargetDescriptor struct {
	OwnerArtifactID string `json:"ownerArtifactId"`
	Target          string `json:"target"`
}

type graphContextEmbeddedLibrary struct {
	OwnerArtifactID string   `json:"ownerArtifactId"`
	Coordinates     string   `json:"coordinates"`
	PackageHints    []string `json:"packageHints"`
}

type graphContextProject struct {
	ProjectID   string `json:"projectId"`
	DisplayName string `json:"displayName"`
}

type graphContextVersion struct {
	VersionID    string `json:"versionId"`
	VersionLabel string `json:"versionLabel"`
}

type graphContextDependency struct {
	VersionID           string `json:"versionId"`
	DependencyProjectID string `json:"dependencyProjectId"`
	RelationType        string `json:"relationType"`
}

type graphPersistenceStore interface {
	SaveGraph(snapshot GraphSnapshot) error
	LoadGraph(analysisID string) (GraphSnapshot, bool, error)
	SaveExplanation(path ExplanationPath) error
	LoadExplanation(analysisID string, findingID string) (ExplanationPath, bool, error)
}

type Service struct {
	graphs              map[string]GraphSnapshot
	explanations        map[string]map[string]ExplanationPath
	orchestratorBaseURL string
	httpClient          *http.Client
	store               graphPersistenceStore
}

func NewService(orchestratorBaseURL string, store graphPersistenceStore) *Service {
	return &Service{
		graphs:              map[string]GraphSnapshot{},
		explanations:        map[string]map[string]ExplanationPath{},
		orchestratorBaseURL: strings.TrimSpace(orchestratorBaseURL),
		httpClient:          http.DefaultClient,
		store:               store,
	}
}

func (s *Service) UpsertGraph(request UpsertGraphRequest) (GraphSnapshot, error) {
	snapshot := GraphSnapshot{
		AnalysisID: request.AnalysisID,
		Nodes:      request.Nodes,
		Edges:      request.Edges,
	}
	s.graphs[request.AnalysisID] = snapshot
	if s.store != nil {
		if err := s.store.SaveGraph(snapshot); err != nil {
			return GraphSnapshot{}, err
		}
	}
	return snapshot, nil
}

func (s *Service) GetGraph(analysisID string) (GraphSnapshot, error) {
	if snapshot, ok := s.graphs[analysisID]; ok {
		return snapshot, nil
	}

	if s.store != nil {
		snapshot, found, err := s.store.LoadGraph(analysisID)
		if err != nil {
			return GraphSnapshot{}, err
		}
		if found {
			s.graphs[analysisID] = snapshot
			return snapshot, nil
		}
	}

	if err := s.ensureDerivedGraph(analysisID); err != nil {
		return GraphSnapshot{}, err
	}

	snapshot, ok := s.graphs[analysisID]
	if !ok {
		return GraphSnapshot{}, errors.New("analysis graph not found")
	}

	return snapshot, nil
}

func (s *Service) UpsertExplanation(
	request ExplanationRequest,
	nodes []GraphNode,
	edges []GraphEdge,
) (ExplanationPath, error) {
	if _, ok := s.explanations[request.AnalysisID]; !ok {
		s.explanations[request.AnalysisID] = map[string]ExplanationPath{}
	}

	path := ExplanationPath{
		PathID:     fmt.Sprintf("exp_%s", request.FindingID),
		AnalysisID: request.AnalysisID,
		FindingID:  request.FindingID,
		Summary:    fmt.Sprintf("Explanation path for %s", request.FindingID),
		Nodes:      nodes,
		Edges:      edges,
	}
	s.explanations[request.AnalysisID][request.FindingID] = path
	if s.store != nil {
		if err := s.store.SaveExplanation(path); err != nil {
			return ExplanationPath{}, err
		}
	}
	return path, nil
}

func (s *Service) GetNeighborhood(request NeighborhoodRequest) (NeighborhoodResponse, error) {
	if err := s.ensureDerivedGraph(request.AnalysisID); err != nil {
		return NeighborhoodResponse{}, err
	}

	snapshot, ok := s.graphs[request.AnalysisID]
	if !ok {
		return NeighborhoodResponse{}, errors.New("analysis graph not found")
	}

	if request.Depth <= 0 {
		request.Depth = 1
	}

	visited := map[string]bool{request.NodeID: true}
	frontier := map[string]bool{request.NodeID: true}

	for i := 0; i < request.Depth; i++ {
		next := map[string]bool{}
		for _, edge := range snapshot.Edges {
			if frontier[edge.SourceID] && !visited[edge.TargetID] {
				visited[edge.TargetID] = true
				next[edge.TargetID] = true
			}
			if frontier[edge.TargetID] && !visited[edge.SourceID] {
				visited[edge.SourceID] = true
				next[edge.SourceID] = true
			}
		}
		frontier = next
	}

	nodes := []GraphNode{}
	for _, node := range snapshot.Nodes {
		if visited[node.NodeID] {
			nodes = append(nodes, node)
		}
	}

	edges := []GraphEdge{}
	for _, edge := range snapshot.Edges {
		if visited[edge.SourceID] && visited[edge.TargetID] {
			edges = append(edges, edge)
		}
	}

	return NeighborhoodResponse{
		AnalysisID:   request.AnalysisID,
		CenterNodeID: request.NodeID,
		Depth:        request.Depth,
		Nodes:        nodes,
		Edges:        edges,
	}, nil
}

func (s *Service) Explain(request ExplanationRequest) (ExplanationPath, error) {
	explanations, ok := s.explanations[request.AnalysisID]
	if ok {
		path, found := explanations[request.FindingID]
		if found {
			return path, nil
		}
	}

	if s.store != nil {
		path, found, err := s.store.LoadExplanation(request.AnalysisID, request.FindingID)
		if err != nil {
			return ExplanationPath{}, err
		}
		if found {
			s.cacheExplanation(path)
			return path, nil
		}
	}

	if err := s.ensureDerivedGraph(request.AnalysisID); err != nil {
		return ExplanationPath{}, err
	}

	explanations, ok = s.explanations[request.AnalysisID]
	if !ok {
		return ExplanationPath{}, errors.New("analysis explanations not found")
	}

	path, found := explanations[request.FindingID]
	if !found {
		return ExplanationPath{}, errors.New("finding explanation not found")
	}

	return path, nil
}

func (s *Service) ensureDerivedGraph(analysisID string) error {
	if _, ok := s.graphs[analysisID]; ok {
		if _, explanationsReady := s.explanations[analysisID]; explanationsReady {
			return nil
		}
	}

	if s.orchestratorBaseURL == "" {
		return errors.New("analysis graph not found")
	}

	context, err := s.fetchGraphContext(analysisID)
	if err != nil {
		return err
	}

	snapshot, explanations := deriveGraph(context)
	s.graphs[analysisID] = snapshot
	s.explanations[analysisID] = explanations
	if s.store != nil {
		if err := s.store.SaveGraph(snapshot); err != nil {
			return err
		}
		for _, path := range explanations {
			if err := s.store.SaveExplanation(path); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Service) cacheExplanation(path ExplanationPath) {
	if _, ok := s.explanations[path.AnalysisID]; !ok {
		s.explanations[path.AnalysisID] = map[string]ExplanationPath{}
	}
	s.explanations[path.AnalysisID][path.FindingID] = path
}

func (s *Service) fetchGraphContext(analysisID string) (graphContextResponse, error) {
	requestURL, err := url.Parse(s.orchestratorBaseURL)
	if err != nil {
		return graphContextResponse{}, fmt.Errorf("invalid orchestrator URL: %w", err)
	}

	requestURL.Path = strings.TrimRight(requestURL.Path, "/") + "/v1/internal/analyses/" + url.PathEscape(analysisID) + "/graph-context"
	response, err := s.httpClient.Get(requestURL.String())
	if err != nil {
		return graphContextResponse{}, fmt.Errorf("graph context fetch failed: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return graphContextResponse{}, fmt.Errorf("graph context fetch failed with status %d", response.StatusCode)
	}

	var payload graphContextResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return graphContextResponse{}, fmt.Errorf("graph context decode failed: %w", err)
	}

	return payload, nil
}

func deriveGraph(context graphContextResponse) (GraphSnapshot, map[string]ExplanationPath) {
	projectLabels := map[string]string{}
	for _, project := range context.Projects {
		projectLabels[project.ProjectID] = project.DisplayName
	}

	versionLabels := map[string]string{}
	for _, version := range context.Versions {
		versionLabels[version.VersionID] = version.VersionLabel
	}

	nodes := []GraphNode{}
	nodeIDs := map[string]bool{}
	addNode := func(node GraphNode) {
		if nodeIDs[node.NodeID] {
			return
		}
		nodeIDs[node.NodeID] = true
		nodes = append(nodes, node)
	}

	edges := []GraphEdge{}
	edgeIndex := 0
	addEdge := func(edgeType string, sourceID string, targetID string, weight float64) {
		edgeIndex += 1
		edges = append(edges, GraphEdge{
			EdgeID:   fmt.Sprintf("ged_%s_%d", context.AnalysisID, edgeIndex),
			EdgeType: edgeType,
			SourceID: sourceID,
			TargetID: targetID,
			Weight:   weight,
		})
	}

	addNode(GraphNode{
		NodeID:   context.Snapshot.PackSnapshotID,
		NodeType: "pack_snapshot",
		Label:    context.Snapshot.PackSnapshotID,
		Props: map[string]interface{}{
			"environment": context.Snapshot.Environment,
		},
	})

	versionIDsInSnapshot := map[string]bool{}
	for _, mod := range context.Snapshot.Mods {
		if mod.CanonicalProjectID == "" {
			continue
		}

		projectLabel := projectLabels[mod.CanonicalProjectID]
		if projectLabel == "" {
			projectLabel = mod.CanonicalProjectID
		}
		addNode(GraphNode{
			NodeID:   mod.CanonicalProjectID,
			NodeType: "project",
			Label:    projectLabel,
		})
		addEdge("contains", context.Snapshot.PackSnapshotID, mod.CanonicalProjectID, 1)

		if mod.CanonicalVersionID == "" {
			continue
		}

		versionLabel := versionLabels[mod.CanonicalVersionID]
		if versionLabel == "" {
			versionLabel = mod.CanonicalVersionID
			if mod.Version != "" {
				versionLabel = mod.Version
			}
		}
		addNode(GraphNode{
			NodeID:   mod.CanonicalVersionID,
			NodeType: "version",
			Label:    versionLabel,
		})
		addEdge("resolved_to", mod.CanonicalProjectID, mod.CanonicalVersionID, 1)
		versionIDsInSnapshot[mod.CanonicalVersionID] = true
	}

	for _, dependency := range context.Dependencies {
		if !versionIDsInSnapshot[dependency.VersionID] {
			continue
		}

		projectLabel := projectLabels[dependency.DependencyProjectID]
		if projectLabel == "" {
			projectLabel = dependency.DependencyProjectID
		}
		addNode(GraphNode{
			NodeID:   dependency.DependencyProjectID,
			NodeType: "project",
			Label:    projectLabel,
		})
		addEdge(dependency.RelationType, dependency.VersionID, dependency.DependencyProjectID, 0.9)
	}

	for _, artifact := range context.Artifacts {
		projectLabel := projectLabels[artifact.ProjectID]
		if projectLabel == "" {
			projectLabel = artifact.ProjectID
		}
		addNode(GraphNode{
			NodeID:   artifact.ProjectID,
			NodeType: "project",
			Label:    projectLabel,
		})
		addNode(GraphNode{
			NodeID:   artifact.Metadata.ArtifactID,
			NodeType: "artifact",
			Label:    artifact.Metadata.Name,
		})
		addEdge("backs_project", artifact.ProjectID, artifact.Metadata.ArtifactID, 1)

		for _, target := range artifact.MixinTargets {
			addNode(GraphNode{
				NodeID:   target.Target,
				NodeType: "mixin_target",
				Label:    target.Target,
			})
			addEdge("targets", artifact.Metadata.ArtifactID, target.Target, 0.8)
		}
		for _, target := range artifact.ClassTargets {
			addNode(GraphNode{
				NodeID:   target.Target,
				NodeType: "class_target",
				Label:    target.Target,
			})
			addEdge("targets", artifact.Metadata.ArtifactID, target.Target, 0.8)
		}
		for _, target := range artifact.ResourceTargets {
			addNode(GraphNode{
				NodeID:   target.Target,
				NodeType: "resource_target",
				Label:    target.Target,
			})
			addEdge("targets", artifact.Metadata.ArtifactID, target.Target, 0.8)
		}
		for _, library := range artifact.EmbeddedLibraries {
			addNode(GraphNode{
				NodeID:   library.Coordinates,
				NodeType: "embedded_library",
				Label:    library.Coordinates,
			})
			addEdge("embeds", artifact.Metadata.ArtifactID, library.Coordinates, 0.85)
		}
	}

	snapshot := GraphSnapshot{
		AnalysisID: context.AnalysisID,
		Nodes:      nodes,
		Edges:      edges,
	}

	explanations := map[string]ExplanationPath{}
	for _, finding := range context.Findings {
		subjectIDs := map[string]bool{}
		for _, subject := range finding.Subjects {
			subjectIDs[subject.ProjectID] = true
			if subject.VersionID != "" {
				subjectIDs[subject.VersionID] = true
			}
		}

		pathNodes := []GraphNode{}
		pathNodeIDs := map[string]bool{}
		for _, node := range nodes {
			if subjectIDs[node.NodeID] {
				pathNodes = append(pathNodes, node)
				pathNodeIDs[node.NodeID] = true
			}
		}

		pathEdges := []GraphEdge{}
		for _, edge := range edges {
			if pathNodeIDs[edge.SourceID] || pathNodeIDs[edge.TargetID] {
				pathEdges = append(pathEdges, edge)
			}
		}

		explanations[finding.FindingID] = ExplanationPath{
			PathID:     fmt.Sprintf("exp_%s", finding.FindingID),
			AnalysisID: context.AnalysisID,
			FindingID:  finding.FindingID,
			Summary:    fmt.Sprintf("Explanation path for %s", finding.Title),
			Nodes:      pathNodes,
			Edges:      pathEdges,
		}
	}

	return snapshot, explanations
}
