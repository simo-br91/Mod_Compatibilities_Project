FROM eclipse-temurin:21-jdk-jammy AS build

WORKDIR /src

COPY apps/artifact-analysis/src/main/java/com/modcompat/artifactanalysis/ArtifactAnalysisBoundary.java ./
COPY apps/artifact-analysis/src/main/java/com/modcompat/artifactanalysis/ArtifactAnalysisServer.java ./

RUN javac --release 21 -d /out ArtifactAnalysisBoundary.java ArtifactAnalysisServer.java

FROM eclipse-temurin:21-jre-jammy

WORKDIR /app

COPY --from=build /out /app/classes

EXPOSE 9090

ENTRYPOINT ["java", "-cp", "/app/classes", "com.modcompat.artifactanalysis.ArtifactAnalysisServer"]
