import unittest

from modcompat_ml import FeatureRow, PhaseFiveMlService


class PhaseFiveMlServiceTests(unittest.TestCase):
    def test_calibrate_finding_risk_is_deterministic(self) -> None:
        service = PhaseFiveMlService()

        result = service.calibrate_finding_risk(
            FeatureRow(
                finding_id="fnd_optifine",
                severity="critical",
                base_confidence=0.88,
                evidence_count=2,
                recommendation_coverage=1,
            )
        )

        self.assertEqual(result["finding_id"], "fnd_optifine")
        self.assertEqual(result["model_version"], "phase5-deterministic-v1")
        self.assertGreaterEqual(result["calibrated_confidence"], 0.9)

    def test_grounded_summary_references_findings(self) -> None:
        service = PhaseFiveMlService()

        summary = service.build_grounded_summary(
            "OptiFine is the primary risk",
            "The summary remains grounded in structured findings.",
            ["fnd_optifine", "fnd_dependency"],
        )

        self.assertEqual(summary["model_version"], "phase5-grounded-summary-v1")
        self.assertEqual(len(summary["citations"]), 2)


if __name__ == "__main__":
    unittest.main()
