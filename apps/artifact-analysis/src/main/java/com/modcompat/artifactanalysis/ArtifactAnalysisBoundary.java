package com.modcompat.artifactanalysis;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

public final class ArtifactAnalysisBoundary {
    private static final class ArtifactRecord {
        final String artifactId;
        final String name;
        final List<String> mixinTargets = new ArrayList<>();
        final List<String> classTargets = new ArrayList<>();
        final List<String> resourceTargets = new ArrayList<>();
        final List<LibraryRecord> libraries = new ArrayList<>();

        ArtifactRecord(String artifactId, String name) {
            this.artifactId = artifactId;
            this.name = name;
        }
    }

    private static final class LibraryRecord {
        final String coordinates;
        final List<String> packageHints;

        LibraryRecord(String coordinates, List<String> packageHints) {
            this.coordinates = coordinates;
            this.packageHints = packageHints;
        }
    }

    public static void main(String[] args) throws Exception {
        BufferedReader stdinReader = new BufferedReader(
                new InputStreamReader(System.in, StandardCharsets.UTF_8));
        StringBuilder sb = new StringBuilder();
        String line;
        while ((line = stdinReader.readLine()) != null) {
            sb.append(line).append('\n');
        }
        System.out.print(processInput(sb.toString()));
    }

    /**
     * Process a tab-delimited artifact input string and return the
     * tab-delimited overlap/divergence output string.
     * Exposed as a package-accessible static so {@link ArtifactAnalysisServer}
     * can reuse it for HTTP requests without re-spawning the process.
     */
    static String processInput(String input) throws Exception {
        Map<String, ArtifactRecord> artifacts = readArtifactsFromString(input);
        List<String> output = new ArrayList<>();

        emitOverlap(output, "mixin_overlap", collectOverlaps(artifacts, "mixin"));
        emitOverlap(output, "class_overlap", collectOverlaps(artifacts, "class"));
        emitOverlap(output, "resource_collision", collectOverlaps(artifacts, "resource"));
        emitDivergence(output, collectDivergences(artifacts));

        StringBuilder sb = new StringBuilder();
        for (String line : output) {
            sb.append(line).append('\n');
        }
        return sb.toString();
    }

    private static Map<String, ArtifactRecord> readArtifactsFromString(String input) throws Exception {
        BufferedReader reader = new BufferedReader(
                new java.io.StringReader(input));
        Map<String, ArtifactRecord> artifacts = new LinkedHashMap<>();
        String line;
        while ((line = reader.readLine()) != null) {
            if (line.isBlank()) {
                continue;
            }
            String[] rawFields = line.split("\t", -1);
            String[] fields = new String[rawFields.length];
            for (int index = 0; index < rawFields.length; index++) {
                fields[index] = decode(rawFields[index]);
            }

            String kind = field(fields, 0);
            String artifactId = field(fields, 1);
            if (artifactId.isEmpty()) {
                continue;
            }

            switch (kind) {
                case "artifact" -> artifacts.put(artifactId, new ArtifactRecord(artifactId, field(fields, 4)));
                case "mixin" -> artifacts.computeIfAbsent(artifactId, id -> new ArtifactRecord(id, id)).mixinTargets.add(field(fields, 2));
                case "class" -> artifacts.computeIfAbsent(artifactId, id -> new ArtifactRecord(id, id)).classTargets.add(field(fields, 2));
                case "resource" -> artifacts.computeIfAbsent(artifactId, id -> new ArtifactRecord(id, id)).resourceTargets.add(field(fields, 2));
                case "library" -> artifacts.computeIfAbsent(artifactId, id -> new ArtifactRecord(id, id)).libraries.add(
                    new LibraryRecord(
                        field(fields, 2),
                        splitList(field(fields, 3))
                    )
                );
                default -> {
                }
            }
        }
        return artifacts;
    }

    private static Map<String, List<String>> collectOverlaps(Map<String, ArtifactRecord> artifacts, String targetKind) {
        Map<String, List<String>> ownersByTarget = new LinkedHashMap<>();
        for (ArtifactRecord artifact : artifacts.values()) {
            List<String> targets = switch (targetKind) {
                case "mixin" -> artifact.mixinTargets;
                case "class" -> artifact.classTargets;
                case "resource" -> artifact.resourceTargets;
                default -> List.of();
            };

            for (String target : targets) {
                ownersByTarget.computeIfAbsent(target, ignored -> new ArrayList<>()).add(artifact.artifactId);
            }
        }
        return ownersByTarget;
    }

    private static Map<String, List<String>> collectDivergences(Map<String, ArtifactRecord> artifacts) {
        Map<String, List<String>> coordinatesByPackage = new LinkedHashMap<>();
        for (ArtifactRecord artifact : artifacts.values()) {
            for (LibraryRecord library : artifact.libraries) {
                for (String packageHint : library.packageHints) {
                    coordinatesByPackage
                        .computeIfAbsent(packageHint, ignored -> new ArrayList<>())
                        .add(artifact.artifactId + "=" + library.coordinates);
                }
            }
        }
        return coordinatesByPackage;
    }

    private static void emitOverlap(List<String> output, String type, Map<String, List<String>> overlaps) {
        for (Map.Entry<String, List<String>> entry : overlaps.entrySet()) {
            if (entry.getValue().size() < 2) {
                continue;
            }
            output.add(
                encode("overlap") + "\t" +
                encode(type) + "\t" +
                encode(entry.getKey()) + "\t" +
                encode(String.join(";", entry.getValue()))
            );
        }
    }

    private static void emitDivergence(List<String> output, Map<String, List<String>> divergences) {
        for (Map.Entry<String, List<String>> entry : divergences.entrySet()) {
            Set<String> uniqueCoordinates = new LinkedHashSet<>();
            for (String item : entry.getValue()) {
                String[] parts = item.split("=", 2);
                if (parts.length == 2) {
                    uniqueCoordinates.add(parts[1]);
                }
            }
            if (uniqueCoordinates.size() < 2) {
                continue;
            }
            output.add(
                encode("divergence") + "\t" +
                encode(entry.getKey()) + "\t" +
                encode(String.join(";", entry.getValue()))
            );
        }
    }

    private static List<String> splitList(String raw) {
        if (raw == null || raw.isEmpty()) {
            return List.of();
        }
        String[] values = raw.split(";");
        List<String> result = new ArrayList<>();
        for (String value : values) {
            if (!value.isBlank()) {
                result.add(value);
            }
        }
        return result;
    }

    private static String field(String[] fields, int index) {
        return index < fields.length ? fields[index] : "";
    }

    private static String encode(String value) {
        return java.net.URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static String decode(String value) {
        return URLDecoder.decode(value, StandardCharsets.UTF_8);
    }
}
