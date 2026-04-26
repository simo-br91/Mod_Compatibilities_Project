package app

type NormalizePackRequest struct {
	ProjectID string
	SnapshotID string
}

type ResolveRequest struct {
	AnalysisID string
}

type ExplainConflictsRequest struct {
	AnalysisID string
}

// TODO: implement deterministic pack normalization and constraint solving in Phase 1.
type Service struct{}

func NewService() *Service {
	return &Service{}
}

