from __future__ import annotations

from dataclasses import dataclass


def clamp(value: float) -> float:
    return max(0.0, min(1.0, round(value, 4)))


@dataclass(slots=True)
class FeatureRow:
    finding_id: str
    severity: str
    base_confidence: float
    evidence_count: int
    recommendation_coverage: int


@dataclass(slots=True)
class PhaseFiveMlService:
    service_name: str = "ml"
    risk_model_version: str = "phase5-deterministic-v1"
    summary_model_version: str = "phase5-grounded-summary-v1"

    def summarize_capabilities(self) -> dict[str, object]:
        return {
            "service": self.service_name,
            "status": "phase5-deterministic",
            "capabilities": [
                "feature_pipeline",
                "offline_dataset_generation",
                "finding_risk_calibration",
                "grounded_pack_review_summary",
            ],
            "models": [
                self.risk_model_version,
                self.summary_model_version,
            ],
        }

    def calibrate_finding_risk(self, row: FeatureRow) -> dict[str, object]:
        severity_weight = {
            "critical": 1.0,
            "high": 0.9,
            "medium": 0.75,
            "low": 0.55,
            "info": 0.4,
        }.get(row.severity, 0.4)
        calibrated_confidence = clamp(
            row.base_confidence
            + (row.evidence_count * 0.03)
            + (row.recommendation_coverage * 0.02)
            + ((severity_weight - 0.4) * 0.1)
        )

        return {
            "finding_id": row.finding_id,
            "model_version": self.risk_model_version,
            "calibrated_confidence": calibrated_confidence,
            "predicted_risk_score": clamp((calibrated_confidence + severity_weight) / 2),
        }

    def build_grounded_summary(
        self, headline: str, overview: str, finding_ids: list[str]
    ) -> dict[str, object]:
        return {
            "model_version": self.summary_model_version,
            "headline": headline,
            "overview": overview,
            "citations": [{"citation_type": "finding", "target_id": finding_id} for finding_id in finding_ids],
        }
