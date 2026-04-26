package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type Observation struct {
	ObservationID    string   `json:"observationId"`
	Kind             string   `json:"kind"`
	Status           string   `json:"status"`
	Summary          string   `json:"summary"`
	FindingTypes     []string `json:"findingTypes"`
	CrashSignatureID *string  `json:"crashSignatureId,omitempty"`
}

type Result struct {
	SimulationRunID string        `json:"simulationRunId"`
	AnalysisID      string        `json:"analysisId"`
	PackSnapshotID  string        `json:"packSnapshotId"`
	RecipeID        string        `json:"recipeId"`
	Status          string        `json:"status"`
	Summary         string        `json:"summary"`
	Observations    []Observation `json:"observations"`
	TenantID        string        `json:"tenantId"`
	SchemaVersion   int           `json:"schemaVersion"`
	CreatedAt       string        `json:"createdAt"`
}

type UpsertSimulationRunRequest struct {
	SimulationRun Result `json:"simulationRun"`
}

type Service struct {
	runs                map[string]Result
	orchestratorBaseURL string
	httpClient          *http.Client
}

func NewService(orchestratorBaseURL string) *Service {
	return &Service{
		runs:                map[string]Result{},
		orchestratorBaseURL: strings.TrimSpace(orchestratorBaseURL),
		httpClient:          http.DefaultClient,
	}
}

func (s *Service) UpsertSimulationRun(request UpsertSimulationRunRequest) Result {
	s.runs[request.SimulationRun.AnalysisID] = request.SimulationRun
	return request.SimulationRun
}

func (s *Service) GetRun(analysisID string) (Result, error) {
	if err := s.ensureHydratedRun(analysisID); err != nil {
		return Result{}, err
	}

	run, ok := s.runs[analysisID]
	if !ok {
		return Result{}, errors.New("simulation run not found")
	}

	return run, nil
}

func (s *Service) ensureHydratedRun(analysisID string) error {
	if _, ok := s.runs[analysisID]; ok {
		return nil
	}

	if s.orchestratorBaseURL == "" {
		return errors.New("simulation run not found")
	}

	run, err := s.fetchSimulationRun(analysisID)
	if err != nil {
		return err
	}

	s.runs[analysisID] = run
	return nil
}

func (s *Service) fetchSimulationRun(analysisID string) (Result, error) {
	requestURL, err := url.Parse(s.orchestratorBaseURL)
	if err != nil {
		return Result{}, fmt.Errorf("invalid orchestrator URL: %w", err)
	}

	requestURL.Path = strings.TrimRight(requestURL.Path, "/") + "/v1/internal/analyses/" + url.PathEscape(analysisID) + "/simulation-run"
	response, err := s.httpClient.Get(requestURL.String())
	if err != nil {
		return Result{}, fmt.Errorf("simulation run fetch failed: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return Result{}, fmt.Errorf("simulation run fetch failed with status %d", response.StatusCode)
	}

	var payload struct {
		SimulationRun Result `json:"simulationRun"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return Result{}, fmt.Errorf("simulation run decode failed: %w", err)
	}

	return payload.SimulationRun, nil
}
