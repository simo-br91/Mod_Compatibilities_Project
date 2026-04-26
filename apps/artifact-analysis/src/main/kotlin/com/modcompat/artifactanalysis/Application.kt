package com.modcompat.artifactanalysis

data class ArtifactFixture(
    val artifactId: String,
    val metadata: Map<String, String>,
    val mixinTargets: List<String>,
    val classTargets: List<String>,
    val resourceTargets: List<String>,
    val embeddedLibraries: List<String>
)

data class ArtifactAnalysisReport(
    val artifacts: List<Map<String, Any>>,
    val overlaps: List<Map<String, Any>>,
    val embeddedLibraryDivergence: List<Map<String, Any>>
)

private val fixtureCatalog = listOf(
    ArtifactFixture(
        artifactId = "artifact_sodium_121",
        metadata = mapOf("name" to "Sodium", "version" to "0.6.0+mc1.21.1", "loader" to "fabric"),
        mixinTargets = listOf("net.minecraft.client.render.WorldRenderer"),
        classTargets = listOf("me.jellysquid.mods.sodium.client.SodiumClientMod", "org.lwjgl.system.MemoryUtil"),
        resourceTargets = listOf("assets/minecraft/shaders/core/rendertype_solid.json"),
        embeddedLibraries = listOf("org.lwjgl:lwjgl:3.3.3")
    ),
    ArtifactFixture(
        artifactId = "artifact_optifine_120",
        metadata = mapOf("name" to "OptiFine", "version" to "HD_U_I6", "loader" to "forge"),
        mixinTargets = listOf("net.minecraft.client.render.WorldRenderer"),
        classTargets = listOf("net.optifine.Config", "org.lwjgl.system.MemoryUtil"),
        resourceTargets = listOf("assets/minecraft/shaders/core/rendertype_solid.json"),
        embeddedLibraries = listOf("org.lwjgl:lwjgl:3.2.2")
    ),
    ArtifactFixture(
        artifactId = "artifact_modmenu_121",
        metadata = mapOf("name" to "Mod Menu", "version" to "11.0.2", "loader" to "fabric"),
        mixinTargets = emptyList(),
        classTargets = listOf("com.terraformersmc.modmenu.ModMenu"),
        resourceTargets = listOf("assets/modmenu/icon.png"),
        embeddedLibraries = emptyList()
    )
)

fun analyzeArtifacts(artifactIds: List<String>): ArtifactAnalysisReport {
    val selected = fixtureCatalog.filter { artifactIds.isEmpty() || artifactIds.contains(it.artifactId) }

    val overlapGroups = mutableMapOf<String, MutableList<String>>()
    selected.forEach { fixture ->
        (fixture.mixinTargets + fixture.classTargets + fixture.resourceTargets).forEach { target ->
            overlapGroups.getOrPut(target) { mutableListOf() }.add(fixture.artifactId)
        }
    }

    val embeddedByGroup = mutableMapOf<String, MutableList<String>>()
    selected.forEach { fixture ->
        fixture.embeddedLibraries.forEach { coordinates ->
            val packageGroup = coordinates.substringBeforeLast(":")
            embeddedByGroup.getOrPut(packageGroup) { mutableListOf() }.add(coordinates)
        }
    }

    return ArtifactAnalysisReport(
        artifacts = selected.map { fixture ->
            mapOf(
                "artifact_id" to fixture.artifactId,
                "metadata" to fixture.metadata,
                "mixin_targets" to fixture.mixinTargets,
                "class_targets" to fixture.classTargets,
                "resource_targets" to fixture.resourceTargets,
                "embedded_libraries" to fixture.embeddedLibraries
            )
        },
        overlaps = overlapGroups
            .filterValues { it.size > 1 }
            .map { (target, owners) ->
                mapOf(
                    "target" to target,
                    "owners" to owners,
                    "kind" to when {
                        target.endsWith(".json") -> "resource_collision"
                        target.contains("net.minecraft") -> "mixin_overlap"
                        else -> "class_overlap"
                    }
                )
            },
        embeddedLibraryDivergence = embeddedByGroup
            .filterValues { it.toSet().size > 1 }
            .map { (group, coordinates) ->
                mapOf(
                    "package_group" to group,
                    "coordinates" to coordinates.distinct(),
                    "kind" to "embedded_library_divergence"
                )
            }
    )
}

fun main(args: Array<String>) {
    val report = analyzeArtifacts(args.toList())
    println(
        mapOf(
            "service" to "artifact-analysis",
            "status" to "phase2-ready",
            "report" to report
        )
    )
}
