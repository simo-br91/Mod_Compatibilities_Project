package app

import (
	"encoding/json"
	"errors"
)

type AnalysisCommand struct {
	AnalysisID     string          `json:"analysisId"`
	ProjectID      string          `json:"projectId"`
	WorkspaceID    string          `json:"workspaceId"`
	OrganizationID string          `json:"organizationId"`
	PackSnapshotID string          `json:"packSnapshotId"`
	Trigger        string          `json:"trigger"`
	AnalysisMode   string          `json:"analysisMode"`
	Request        json.RawMessage `json:"request,omitempty"`
}

type AcceptedAnalysis struct {
	AnalysisID     string `json:"analysisId"`
	Status         string `json:"status"`
	ProjectID      string `json:"projectId"`
	WorkspaceID    string `json:"workspaceId"`
	OrganizationID string `json:"organizationId"`
	PackSnapshotID string `json:"packSnapshotId"`
	Trigger        string `json:"trigger"`
	AnalysisMode   string `json:"analysisMode"`
}

type UpsertAnalysisRequest struct {
	AnalysisID string          `json:"analysisId"`
	Result     json.RawMessage `json:"result"`
}

type Service struct {
	commands map[string]AnalysisCommand
	results  map[string]json.RawMessage
}

func NewService() *Service {
	return &Service{
		commands: map[string]AnalysisCommand{},
		results:  map[string]json.RawMessage{},
	}
}

func (s *Service) Create(command AnalysisCommand) AcceptedAnalysis {
	s.commands[command.AnalysisID] = command
	return AcceptedAnalysis{
		AnalysisID:     command.AnalysisID,
		Status:         "accepted",
		ProjectID:      command.ProjectID,
		WorkspaceID:    command.WorkspaceID,
		OrganizationID: command.OrganizationID,
		PackSnapshotID: command.PackSnapshotID,
		Trigger:        command.Trigger,
		AnalysisMode:   command.AnalysisMode,
	}
}

func (s *Service) UpsertAnalysis(request UpsertAnalysisRequest) error {
	if request.AnalysisID == "" {
		return errors.New("analysisId is required")
	}
	if len(request.Result) == 0 {
		return errors.New("result is required")
	}

	s.results[request.AnalysisID] = request.Result
	return nil
}

func (s *Service) GetAnalysis(analysisID string) (json.RawMessage, error) {
	result, ok := s.results[analysisID]
	if !ok {
		return nil, errors.New("analysis result not found")
	}
	return result, nil
}
