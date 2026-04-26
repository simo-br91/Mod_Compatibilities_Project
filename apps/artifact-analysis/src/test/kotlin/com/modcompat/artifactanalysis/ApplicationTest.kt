package com.modcompat.artifactanalysis

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ApplicationTest {
    @Test
    fun detectsOverlapAndEmbeddedLibraryDivergence() {
        val report = analyzeArtifacts(listOf("artifact_sodium_121", "artifact_optifine_120"))

        assertEquals(2, report.artifacts.size)
        assertTrue(report.overlaps.any { it["kind"] == "mixin_overlap" })
        assertTrue(report.embeddedLibraryDivergence.any { it["kind"] == "embedded_library_divergence" })
    }
}
