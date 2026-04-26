package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

type AnalysisEnvironment struct {
	MinecraftVersion string `json:"minecraftVersion"`
	Loader           string `json:"loader"`
	JavaVersion      string `json:"javaVersion"`
	Side             string `json:"side"`
}

type FindingSubject struct {
	ProjectID string  `json:"projectId"`
	VersionID *string `json:"versionId,omitempty"`
	Relation  *string `json:"relation,omitempty"`
}

type EvidenceRef struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type FindingProvenance struct {
	Kind string `json:"kind"`
}

type Finding struct {
	FindingID          string              `json:"findingId"`
	Type               string              `json:"type"`
	Severity           string              `json:"severity"`
	Confidence         float64             `json:"confidence"`
	Title              string              `json:"title"`
	Evidence           []EvidenceRef       `json:"evidence"`
	Subjects           []FindingSubject    `json:"subjects"`
	Provenance         []FindingProvenance `json:"provenance,omitempty"`
	Explanation        *string             `json:"explanation,omitempty"`
	Summary            *string             `json:"summary,omitempty"`
	RecommendedActions []string            `json:"recommendedActions,omitempty"`
}

type PackMod struct {
	CanonicalProjectID *string `json:"canonicalProjectId,omitempty"`
	CanonicalVersionID *string `json:"canonicalVersionId,omitempty"`
}

type PackSnapshot struct {
	PackSnapshotID string              `json:"packSnapshotId"`
	Environment    AnalysisEnvironment `json:"environment"`
	Mods           []PackMod           `json:"mods"`
}

type CatalogProject struct {
	ProjectID                        string   `json:"projectId"`
	DisplayName                      string   `json:"displayName"`
	RecommendedReplacementProjectIDs []string `json:"recommendedReplacementProjectIds,omitempty"`
}

type CatalogVersion struct {
	VersionID         string   `json:"versionId"`
	ProjectID         string   `json:"projectId"`
	VersionLabel      string   `json:"versionLabel"`
	Loaders           []string `json:"loaders"`
	MinecraftVersions []string `json:"minecraftVersions"`
}

type candidateProject struct {
	projectID string
	versionID *string
}

type GenerateRecommendationsRequest struct {
	AnalysisID string           `json:"analysisId"`
	TenantID   string           `json:"tenantId,omitempty"`
	Snapshot   PackSnapshot     `json:"snapshot"`
	Findings   []Finding        `json:"findings"`
	Projects   []CatalogProject `json:"projects"`
	Versions   []CatalogVersion `json:"versions"`
}

type RecommendationStep struct {
	StepID    string  `json:"stepId"`
	Action    string  `json:"action"`
	ProjectID *string `json:"projectId,omitempty"`
	VersionID *string `json:"versionId,omitempty"`
	Summary   string  `json:"summary"`
}

type Recommendation struct {
	RecommendationID          string               `json:"recommendationId"`
	Kind                      string               `json:"kind"`
	Rank                      int                  `json:"rank"`
	Confidence                float64              `json:"confidence"`
	Summary                   string               `json:"summary"`
	Rationale                 *string              `json:"rationale,omitempty"`
	Status                    *string              `json:"status,omitempty"`
	FindingIDs                []string             `json:"findingIds,omitempty"`
	MigrationCost             *string              `json:"migrationCost,omitempty"`
	ExpectedCompatibilityGain *float64             `json:"expectedCompatibilityGain,omitempty"`
	Steps                     []RecommendationStep `json:"steps,omitempty"`
}

type RecommendationBundle struct {
	BundleID                  string   `json:"bundleId"`
	RecommendationSetID       string   `json:"recommendationSetId"`
	Strategy                  string   `json:"strategy"`
	RecommendationIDs         []string `json:"recommendationIds"`
	Summary                   string   `json:"summary"`
	Rationale                 string   `json:"rationale"`
	MigrationCost             string   `json:"migrationCost"`
	ExpectedCompatibilityGain float64  `json:"expectedCompatibilityGain"`
	CreatedAt                 string   `json:"createdAt"`
}

type RecommendationSetSummary struct {
	RecommendationCount    int     `json:"recommendationCount"`
	BundleCount            int     `json:"bundleCount"`
	UnresolvedFindingCount int     `json:"unresolvedFindingCount"`
	MinimalUnblockBundleID *string `json:"minimalUnblockBundleId,omitempty"`
	StabilityFirstBundleID *string `json:"stabilityFirstBundleId,omitempty"`
}

type RecommendationSet struct {
	RecommendationSetID string                   `json:"recommendationSetId"`
	AnalysisID          string                   `json:"analysisId"`
	TenantID            string                   `json:"tenantId"`
	SchemaVersion       int                      `json:"schemaVersion"`
	GenerationStrategy  string                   `json:"generationStrategy"`
	Items               []Recommendation         `json:"items"`
	Bundles             []RecommendationBundle   `json:"bundles"`
	Summary             RecommendationSetSummary `json:"summary"`
	CreatedAt           string                   `json:"createdAt"`
}

type UpsertRecommendationSetRequest struct {
	RecommendationSet RecommendationSet `json:"recommendationSet"`
}

type RecommendationFeedback struct {
	FeedbackID          string  `json:"feedbackId"`
	RecommendationSetID string  `json:"recommendationSetId"`
	RecommendationID    string  `json:"recommendationId"`
	FeedbackType        string  `json:"feedbackType"`
	Note                *string `json:"note,omitempty"`
	CreatedBy           string  `json:"createdBy"`
	TenantID            string  `json:"tenantId"`
	SchemaVersion       int     `json:"schemaVersion"`
	CreatedAt           string  `json:"createdAt"`
}

type SubmitRecommendationFeedbackRequest struct {
	FeedbackType string  `json:"feedbackType"`
	Note         *string `json:"note,omitempty"`
	CreatedBy    string  `json:"createdBy"`
}

type RecommendationOutcome struct {
	OutcomeID                string   `json:"outcomeId"`
	RecommendationSetID      string   `json:"recommendationSetId"`
	Status                   string   `json:"status"`
	AppliedRecommendationIDs []string `json:"appliedRecommendationIds"`
	ValidationSummary        string   `json:"validationSummary"`
	CreatedBy                string   `json:"createdBy"`
	TenantID                 string   `json:"tenantId"`
	SchemaVersion            int      `json:"schemaVersion"`
	CreatedAt                string   `json:"createdAt"`
}

type RecordRecommendationOutcomeRequest struct {
	Status                   string   `json:"status"`
	AppliedRecommendationIDs []string `json:"appliedRecommendationIds"`
	ValidationSummary        string   `json:"validationSummary"`
	CreatedBy                string   `json:"createdBy"`
}

type Service struct {
	recommendationSets     map[string]RecommendationSet
	recommendationToSet    map[string]string
	recommendationFeedback map[string][]RecommendationFeedback
	recommendationOutcomes map[string][]RecommendationOutcome
	orchestratorBaseURL    string
	httpClient             *http.Client
	idCounter              int
}

func NewService(orchestratorBaseURL string) *Service {
	return &Service{
		recommendationSets:     map[string]RecommendationSet{},
		recommendationToSet:    map[string]string{},
		recommendationFeedback: map[string][]RecommendationFeedback{},
		recommendationOutcomes: map[string][]RecommendationOutcome{},
		orchestratorBaseURL:    strings.TrimSpace(orchestratorBaseURL),
		httpClient:             http.DefaultClient,
	}
}

func (s *Service) GenerateRecommendationSet(request GenerateRecommendationsRequest) RecommendationSet {
	recommendations := []Recommendation{}
	findings := append([]Finding{}, request.Findings...)
	slices.SortFunc(findings, compareFindingsForRecommendation)

	for _, finding := range findings {
		recommendations = append(recommendations, s.generateForFinding(request.Snapshot, request.Projects, request.Versions, finding)...)
	}

	if len(recommendations) == 0 && len(request.Snapshot.Mods) > 0 {
		recommendations = append(recommendations, s.createHealthyPackRecommendation(request.Snapshot, migrationCostForHealthy(request.Findings)))
	}

	slices.SortFunc(recommendations, compareRecommendations)
	for index := range recommendations {
		recommendations[index].Rank = index + 1
	}

	recommendationSetID := s.nextID("rset")
	unresolvedFindingCount := 0
	for _, finding := range request.Findings {
		matched := false
		for _, recommendation := range recommendations {
			if slices.Contains(recommendation.FindingIDs, finding.FindingID) {
				matched = true
				break
			}
		}
		if !matched {
			unresolvedFindingCount++
		}
	}

	bundles := s.createBundles(recommendationSetID, recommendations, request.Findings)
	recommendationSet := RecommendationSet{
		RecommendationSetID: recommendationSetID,
		AnalysisID:          request.AnalysisID,
		TenantID:            request.TenantID,
		SchemaVersion:       1,
		GenerationStrategy:  "go-phase8-service-owned-v1",
		Items:               recommendations,
		Bundles:             bundles,
		Summary: RecommendationSetSummary{
			RecommendationCount:    len(recommendations),
			BundleCount:            len(bundles),
			UnresolvedFindingCount: unresolvedFindingCount,
			MinimalUnblockBundleID: findBundleID(bundles, "minimal_unblock"),
			StabilityFirstBundleID: findBundleID(bundles, "stability_first"),
		},
		CreatedAt: nowString(),
	}

	s.storeRecommendationSet(recommendationSet)
	return recommendationSet
}

func (s *Service) UpsertRecommendationSet(request UpsertRecommendationSetRequest) RecommendationSet {
	recommendationSet := request.RecommendationSet
	s.storeRecommendationSet(recommendationSet)
	return recommendationSet
}

func (s *Service) GetRecommendationSet(analysisID string) (RecommendationSet, error) {
	if err := s.ensureHydratedRecommendationSet(analysisID); err != nil {
		return RecommendationSet{}, err
	}

	recommendationSet, ok := s.recommendationSets[analysisID]
	if !ok {
		return RecommendationSet{}, errors.New("recommendation set not found")
	}
	return recommendationSet, nil
}

func (s *Service) SubmitFeedback(analysisID string, recommendationID string, request SubmitRecommendationFeedbackRequest) (RecommendationFeedback, error) {
	recommendationSet, err := s.GetRecommendationSet(analysisID)
	if err != nil {
		return RecommendationFeedback{}, err
	}

	feedbackID := fmt.Sprintf("rfb_%s_%d", recommendationID, len(s.recommendationFeedback[recommendationSet.RecommendationSetID])+1)
	feedback := RecommendationFeedback{
		FeedbackID:          feedbackID,
		RecommendationSetID: recommendationSet.RecommendationSetID,
		RecommendationID:    recommendationID,
		FeedbackType:        request.FeedbackType,
		Note:                request.Note,
		CreatedBy:           request.CreatedBy,
		TenantID:            recommendationSet.TenantID,
		SchemaVersion:       1,
		CreatedAt:           recommendationSet.CreatedAt,
	}

	s.recommendationFeedback[recommendationSet.RecommendationSetID] = append(
		s.recommendationFeedback[recommendationSet.RecommendationSetID],
		feedback,
	)

	status := ""
	switch request.FeedbackType {
	case "accepted":
		status = "accepted"
	case "dismissed":
		status = "dismissed"
	}
	if status != "" {
		s.updateRecommendationStatus(analysisID, recommendationID, status)
	}

	return feedback, nil
}

func (s *Service) RecordOutcome(recommendationSetID string, request RecordRecommendationOutcomeRequest) (RecommendationOutcome, error) {
	analysisID, recommendationSet, err := s.findRecommendationSetByID(recommendationSetID)
	if err != nil {
		return RecommendationOutcome{}, err
	}

	outcomeID := fmt.Sprintf("rot_%s_%d", recommendationSetID, len(s.recommendationOutcomes[recommendationSetID])+1)
	outcome := RecommendationOutcome{
		OutcomeID:                outcomeID,
		RecommendationSetID:      recommendationSetID,
		Status:                   request.Status,
		AppliedRecommendationIDs: request.AppliedRecommendationIDs,
		ValidationSummary:        request.ValidationSummary,
		CreatedBy:                request.CreatedBy,
		TenantID:                 recommendationSet.TenantID,
		SchemaVersion:            1,
		CreatedAt:                recommendationSet.CreatedAt,
	}

	s.recommendationOutcomes[recommendationSetID] = append(
		s.recommendationOutcomes[recommendationSetID],
		outcome,
	)

	if request.Status == "validated" {
		for _, recommendationID := range request.AppliedRecommendationIDs {
			s.updateRecommendationStatus(analysisID, recommendationID, "applied")
		}
	}

	return outcome, nil
}

func (s *Service) ensureHydratedRecommendationSet(analysisID string) error {
	if _, ok := s.recommendationSets[analysisID]; ok {
		return nil
	}

	if s.orchestratorBaseURL == "" {
		return errors.New("recommendation set not found")
	}

	context, err := s.fetchRecommendationContext(analysisID)
	if err != nil {
		return err
	}

	s.GenerateRecommendationSet(context)
	return nil
}

func (s *Service) fetchRecommendationContext(analysisID string) (GenerateRecommendationsRequest, error) {
	requestURL, err := url.Parse(s.orchestratorBaseURL)
	if err != nil {
		return GenerateRecommendationsRequest{}, fmt.Errorf("invalid orchestrator URL: %w", err)
	}

	requestURL.Path = strings.TrimRight(requestURL.Path, "/") + "/v1/internal/analyses/" + url.PathEscape(analysisID) + "/recommendation-context"
	response, err := s.httpClient.Get(requestURL.String())
	if err != nil {
		return GenerateRecommendationsRequest{}, fmt.Errorf("recommendation context fetch failed: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode != http.StatusOK {
		return GenerateRecommendationsRequest{}, fmt.Errorf("recommendation context fetch failed with status %d", response.StatusCode)
	}

	var payload GenerateRecommendationsRequest
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return GenerateRecommendationsRequest{}, fmt.Errorf("recommendation context decode failed: %w", err)
	}

	return payload, nil
}

func (s *Service) storeRecommendationSet(recommendationSet RecommendationSet) {
	s.recommendationSets[recommendationSet.AnalysisID] = recommendationSet
	for _, item := range recommendationSet.Items {
		s.recommendationToSet[item.RecommendationID] = recommendationSet.AnalysisID
	}
}

func (s *Service) findRecommendationSetByID(recommendationSetID string) (string, RecommendationSet, error) {
	for analysisID, recommendationSet := range s.recommendationSets {
		if recommendationSet.RecommendationSetID == recommendationSetID {
			return analysisID, recommendationSet, nil
		}
	}

	return "", RecommendationSet{}, errors.New("recommendation set not found")
}

func (s *Service) updateRecommendationStatus(analysisID string, recommendationID string, status string) {
	recommendationSet, ok := s.recommendationSets[analysisID]
	if !ok {
		return
	}

	for index, item := range recommendationSet.Items {
		if item.RecommendationID == recommendationID {
			item.Status = &status
			recommendationSet.Items[index] = item
			break
		}
	}

	s.recommendationSets[analysisID] = recommendationSet
}

func (s *Service) generateForFinding(snapshot PackSnapshot, projects []CatalogProject, versions []CatalogVersion, finding Finding) []Recommendation {
	switch finding.Type {
	case "declared_incompatibility", "community_verified_incompatibility", "loader_mismatch", "minecraft_version_mismatch", "java_version_mismatch":
		return s.buildReplacementRecommendations(snapshot, projects, versions, finding)
	case "missing_dependency":
		return s.buildDependencyRecommendation(projects, versions, finding)
	case "mixin_overlap", "resource_collision", "embedded_library_divergence", "class_overlap":
		return []Recommendation{s.buildStabilityPlan(projects, finding)}
	default:
		return []Recommendation{}
	}
}

func (s *Service) buildReplacementRecommendations(snapshot PackSnapshot, projects []CatalogProject, versions []CatalogVersion, finding Finding) []Recommendation {
	primary := primarySubject(finding.Subjects)
	if primary == nil || primary.ProjectID == "" {
		return []Recommendation{}
	}

	project := findProject(projects, primary.ProjectID)
	if project == nil || len(project.RecommendedReplacementProjectIDs) == 0 {
		return []Recommendation{}
	}

	candidates := []candidateProject{}
	for _, projectID := range project.RecommendedReplacementProjectIDs {
		versionID := findBestVersion(projectID, versions, snapshot.Environment)
		candidates = append(candidates, candidateProject{projectID: projectID, versionID: versionID})
	}

	summary := fmt.Sprintf(
		"Replace %s with %s to keep the pack aligned with %s %s.",
		projectLabel(projects, primary.ProjectID),
		joinProjectLabels(projects, candidates),
		snapshot.Environment.Loader,
		snapshot.Environment.MinecraftVersion,
	)
	rationale := "The replacement set is derived from the canonical project mapping and the existing evidence-backed compatibility findings."
	status := "proposed"
	migrationCost := "low"
	if finding.Severity == "critical" || len(candidates) > 1 {
		migrationCost = "medium"
	}
	gain := expectedGainForSeverity(finding.Severity, 0.84)
	recommendationKind := "replacement"
	if len(candidates) > 1 {
		recommendationKind = "bundle"
	}

	steps := []RecommendationStep{
		{
			StepID:    s.nextID("step"),
			Action:    "remove_mod",
			ProjectID: &primary.ProjectID,
			VersionID: primary.VersionID,
			Summary:   fmt.Sprintf("Remove %s from the pack snapshot.", projectLabel(projects, primary.ProjectID)),
		},
	}
	for _, candidate := range candidates {
		projectID := candidate.projectID
		summary := fmt.Sprintf("Add %s", projectLabel(projects, projectID))
		if candidate.versionID != nil {
			summary += " " + versionLabel(versions, *candidate.versionID)
		}
		summary += "."
		steps = append(steps, RecommendationStep{
			StepID:    s.nextID("step"),
			Action:    "add_mod",
			ProjectID: &projectID,
			VersionID: candidate.versionID,
			Summary:   summary,
		})
	}
	steps = append(steps, s.verifyStep("Rerun the analysis to confirm the incompatibility is gone."))

	return []Recommendation{
		{
			RecommendationID:          s.nextID("rec"),
			Kind:                      recommendationKind,
			Rank:                      0,
			Confidence:                clamp(round4(finding.Confidence*0.9 + recommendationConfidenceBoost(finding))),
			Summary:                   summary,
			Rationale:                 &rationale,
			Status:                    &status,
			FindingIDs:                []string{finding.FindingID},
			MigrationCost:             &migrationCost,
			ExpectedCompatibilityGain: &gain,
			Steps:                     steps,
		},
	}
}

func (s *Service) buildDependencyRecommendation(projects []CatalogProject, versions []CatalogVersion, finding Finding) []Recommendation {
	var dependency *FindingSubject
	for index := range finding.Subjects {
		if finding.Subjects[index].Relation != nil && *finding.Subjects[index].Relation == "secondary" {
			dependency = &finding.Subjects[index]
			break
		}
	}
	if dependency == nil {
		return []Recommendation{}
	}

	rationale := "The dependency comes directly from resolved version metadata and is required for deterministic compatibility checks."
	status := "proposed"
	migrationCost := "low"
	gain := expectedGainForSeverity(finding.Severity, 0.75)
	steps := []RecommendationStep{
		{
			StepID:    s.nextID("step"),
			Action:    "add_mod",
			ProjectID: &dependency.ProjectID,
			VersionID: dependency.VersionID,
			Summary:   fmt.Sprintf("Add %s to the pack.", projectLabel(projects, dependency.ProjectID)),
		},
		s.verifyStep("Rerun the analysis to confirm the missing dependency finding resolves."),
	}

	return []Recommendation{
		{
			RecommendationID:          s.nextID("rec"),
			Kind:                      "remediation_plan",
			Rank:                      0,
			Confidence:                clamp(round4(finding.Confidence * 0.96)),
			Summary:                   fmt.Sprintf("Add %s before rerunning the analysis.", projectLabel(projects, dependency.ProjectID)),
			Rationale:                 &rationale,
			Status:                    &status,
			FindingIDs:                []string{finding.FindingID},
			MigrationCost:             &migrationCost,
			ExpectedCompatibilityGain: &gain,
			Steps:                     steps,
		},
	}
}

func (s *Service) buildStabilityPlan(projects []CatalogProject, finding Finding) Recommendation {
	labels := []string{}
	for _, subject := range finding.Subjects {
		if subject.Relation != nil && *subject.Relation == "secondary" {
			continue
		}
		labels = append(labels, projectLabel(projects, subject.ProjectID))
	}
	rationale := "This plan keeps the current mod lineup as intact as possible while sequencing deterministic validation after each risky overlap."
	status := "proposed"
	migrationCost := "medium"
	gain := expectedGainForSeverity(finding.Severity, 0.68)

	return Recommendation{
		RecommendationID:          s.nextID("rec"),
		Kind:                      "remediation_plan",
		Rank:                      0,
		Confidence:                clamp(round4(finding.Confidence * 0.9)),
		Summary:                   fmt.Sprintf("Stability-first remediation for %s: isolate the overlapping targets and retest.", joinLabels(labels)),
		Rationale:                 &rationale,
		Status:                    &status,
		FindingIDs:                []string{finding.FindingID},
		MigrationCost:             &migrationCost,
		ExpectedCompatibilityGain: &gain,
		Steps: []RecommendationStep{
			{
				StepID:  s.nextID("step"),
				Action:  "retest_finding",
				Summary: fmt.Sprintf("Verify the overlap described by %s with only the affected projects enabled.", finding.Title),
			},
			{
				StepID:  s.nextID("step"),
				Action:  "verify_pack",
				Summary: "Capture a fresh snapshot after choosing which artifact path to keep.",
			},
		},
	}
}

func (s *Service) createHealthyPackRecommendation(snapshot PackSnapshot, migrationCost string) Recommendation {
	rationale := "No deterministic violations required an immediate replacement or remediation bundle."
	status := "proposed"
	gain := 0.2
	return Recommendation{
		RecommendationID:          s.nextID("rec"),
		Kind:                      "remediation_plan",
		Rank:                      0,
		Confidence:                0.6,
		Summary:                   fmt.Sprintf("The pack is structurally healthy for deterministic checks on %s %s. Capture a new snapshot after any catalog, rule, or evidence update.", snapshot.Environment.Loader, snapshot.Environment.MinecraftVersion),
		Rationale:                 &rationale,
		Status:                    &status,
		FindingIDs:                []string{},
		MigrationCost:             &migrationCost,
		ExpectedCompatibilityGain: &gain,
		Steps: []RecommendationStep{
			s.verifyStep("Rerun the analysis after the next catalog, rule, or evidence refresh."),
		},
	}
}

func (s *Service) createBundles(recommendationSetID string, recommendations []Recommendation, findings []Finding) []RecommendationBundle {
	minimalUnblockIDs := []string{}
	for _, recommendation := range recommendations {
		linkedHighSeverity := false
		for _, finding := range findings {
			if slices.Contains(recommendation.FindingIDs, finding.FindingID) &&
				(finding.Severity == "critical" || finding.Severity == "high") {
				linkedHighSeverity = true
				break
			}
		}
		if linkedHighSeverity {
			minimalUnblockIDs = append(minimalUnblockIDs, recommendation.RecommendationID)
		}
	}
	if len(minimalUnblockIDs) > 3 {
		minimalUnblockIDs = minimalUnblockIDs[:3]
	}

	stabilityFirstIDs := []string{}
	for _, recommendation := range recommendations {
		stabilityFirstIDs = append(stabilityFirstIDs, recommendation.RecommendationID)
	}
	if len(minimalUnblockIDs) == 0 && len(stabilityFirstIDs) > 0 {
		minimalUnblockIDs = stabilityFirstIDs[:1]
	}

	minimalBundle := RecommendationBundle{
		BundleID:                  s.nextID("rbd"),
		RecommendationSetID:       recommendationSetID,
		Strategy:                  "minimal_unblock",
		RecommendationIDs:         minimalUnblockIDs,
		Summary:                   bundleSummary("minimal_unblock", recommendations, minimalUnblockIDs),
		Rationale:                 "Targets the smallest set of actions needed to remove the highest-severity blockers first.",
		MigrationCost:             bundleMigrationCost(recommendations, minimalUnblockIDs),
		ExpectedCompatibilityGain: bundleGain(recommendations, minimalUnblockIDs),
		CreatedAt:                 nowString(),
	}

	stabilityBundle := RecommendationBundle{
		BundleID:                  s.nextID("rbd"),
		RecommendationSetID:       recommendationSetID,
		Strategy:                  "stability_first",
		RecommendationIDs:         stabilityFirstIDs,
		Summary:                   bundleSummary("stability_first", recommendations, stabilityFirstIDs),
		Rationale:                 "Sequences the full deterministic remediation path so the pack can converge toward a more stable baseline.",
		MigrationCost:             bundleMigrationCost(recommendations, stabilityFirstIDs),
		ExpectedCompatibilityGain: bundleGain(recommendations, stabilityFirstIDs),
		CreatedAt:                 nowString(),
	}

	return []RecommendationBundle{minimalBundle, stabilityBundle}
}

func (s *Service) verifyStep(summary string) RecommendationStep {
	return RecommendationStep{
		StepID:  s.nextID("step"),
		Action:  "verify_pack",
		Summary: summary,
	}
}

func (s *Service) nextID(prefix string) string {
	s.idCounter++
	return fmt.Sprintf("%s_%06d", prefix, s.idCounter)
}

func compareFindingsForRecommendation(left, right Finding) int {
	return severityWeight(right.Severity) - severityWeight(left.Severity)
}

func compareRecommendations(left, right Recommendation) int {
	leftGain := 0.0
	rightGain := 0.0
	if left.ExpectedCompatibilityGain != nil {
		leftGain = *left.ExpectedCompatibilityGain
	}
	if right.ExpectedCompatibilityGain != nil {
		rightGain = *right.ExpectedCompatibilityGain
	}
	if rightGain != leftGain {
		if rightGain > leftGain {
			return 1
		}
		return -1
	}

	if right.Confidence != left.Confidence {
		if right.Confidence > left.Confidence {
			return 1
		}
		return -1
	}

	return migrationCostWeight(valueOrDefault(left.MigrationCost, "unknown")) -
		migrationCostWeight(valueOrDefault(right.MigrationCost, "unknown"))
}

func recommendationConfidenceBoost(finding Finding) float64 {
	for _, provenance := range finding.Provenance {
		if provenance.Kind == "evidence" {
			return 0.08
		}
	}
	return 0.04
}

func expectedGainForSeverity(severity string, baseline float64) float64 {
	multiplier := 0.65
	switch severity {
	case "critical":
		multiplier = 1
	case "high":
		multiplier = 0.94
	case "medium":
		multiplier = 0.82
	}
	return round4(baseline * multiplier)
}

func bundleMigrationCost(recommendations []Recommendation, recommendationIDs []string) string {
	weight := 1
	for _, recommendation := range recommendations {
		if slices.Contains(recommendationIDs, recommendation.RecommendationID) {
			weight = max(weight, migrationCostWeight(valueOrDefault(recommendation.MigrationCost, "unknown")))
		}
	}
	switch weight {
	case 3:
		return "high"
	case 2:
		return "medium"
	default:
		return "low"
	}
}

func bundleGain(recommendations []Recommendation, recommendationIDs []string) float64 {
	total := 0.0
	count := 0.0
	for _, recommendation := range recommendations {
		if slices.Contains(recommendationIDs, recommendation.RecommendationID) && recommendation.ExpectedCompatibilityGain != nil {
			total += *recommendation.ExpectedCompatibilityGain
			count++
		}
	}
	if count == 0 {
		return 0
	}
	return round4(total / count)
}

func migrationCostWeight(cost string) int {
	switch cost {
	case "low":
		return 1
	case "medium":
		return 2
	case "high":
		return 3
	default:
		return 4
	}
}

func severityWeight(severity string) int {
	switch severity {
	case "critical":
		return 5
	case "high":
		return 4
	case "medium":
		return 3
	case "low":
		return 2
	default:
		return 1
	}
}

func primarySubject(subjects []FindingSubject) *FindingSubject {
	for index := range subjects {
		if subjects[index].Relation == nil || *subjects[index].Relation != "secondary" {
			return &subjects[index]
		}
	}
	if len(subjects) == 0 {
		return nil
	}
	return &subjects[0]
}

func findProject(projects []CatalogProject, projectID string) *CatalogProject {
	for index := range projects {
		if projects[index].ProjectID == projectID {
			return &projects[index]
		}
	}
	return nil
}

func findBestVersion(projectID string, versions []CatalogVersion, environment AnalysisEnvironment) *string {
	for _, version := range versions {
		if version.ProjectID == projectID &&
			slices.Contains(version.Loaders, environment.Loader) &&
			slices.Contains(version.MinecraftVersions, environment.MinecraftVersion) {
			return &version.VersionID
		}
	}
	return nil
}

func projectLabel(projects []CatalogProject, projectID string) string {
	project := findProject(projects, projectID)
	if project == nil || project.DisplayName == "" {
		return projectID
	}
	return project.DisplayName
}

func versionLabel(versions []CatalogVersion, versionID string) string {
	for _, version := range versions {
		if version.VersionID == versionID {
			return version.VersionLabel
		}
	}
	return versionID
}

func joinProjectLabels(projects []CatalogProject, candidates []candidateProject) string {
	labels := []string{}
	for _, candidate := range candidates {
		labels = append(labels, projectLabel(projects, candidate.projectID))
	}
	return joinLabels(labels)
}

func joinLabels(labels []string) string {
	if len(labels) == 0 {
		return "the selected mods"
	}
	if len(labels) == 1 {
		return labels[0]
	}
	return strings.Join(labels[:len(labels)-1], " + ") + " + " + labels[len(labels)-1]
}

func bundleSummary(strategy string, recommendations []Recommendation, recommendationIDs []string) string {
	summaries := []string{}
	for _, recommendation := range recommendations {
		if slices.Contains(recommendationIDs, recommendation.RecommendationID) {
			summaries = append(summaries, recommendation.Summary)
		}
		if len(summaries) == 2 {
			break
		}
	}
	joined := ""
	for index, summary := range summaries {
		if index > 0 {
			joined += " Then "
		}
		joined += summary
	}
	if strategy == "minimal_unblock" {
		return "Minimal unblock plan: " + joined
	}
	if len(recommendationIDs) > 2 {
		return "Stability-first plan: " + joined + " Then continue with the remaining deterministic remediation items."
	}
	return "Stability-first plan: " + joined
}

func findBundleID(bundles []RecommendationBundle, strategy string) *string {
	for _, bundle := range bundles {
		if bundle.Strategy == strategy {
			return &bundle.BundleID
		}
	}
	return nil
}

func round4(value float64) float64 {
	return float64(int(value*10000+0.5)) / 10000
}

func clamp(value float64) float64 {
	if value < 0 {
		return 0
	}
	if value > 1 {
		return 1
	}
	return value
}

func valueOrDefault(value *string, fallback string) string {
	if value == nil || *value == "" {
		return fallback
	}
	return *value
}

func migrationCostForHealthy(findings []Finding) string {
	if len(findings) > 0 {
		return "medium"
	}
	return "low"
}

func nowString() string {
	return time.Now().UTC().Format(time.RFC3339)
}
