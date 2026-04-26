package com.modcompat.artifactanalysis;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;

/**
 * Long-lived HTTP service wrapper around {@link ArtifactAnalysisBoundary}.
 *
 * <p>Starts a minimal HTTP server (JDK built-in, no external dependencies) and
 * exposes two endpoints:
 *
 * <ul>
 *   <li>{@code GET  /healthz} – liveness check; returns {@code {"status":"ok"}}
 *   <li>{@code POST /v1/artifact-analysis/analyze} – accepts the same
 *       tab-delimited payload as {@code ArtifactAnalysisBoundary} stdin and
 *       returns the same tab-delimited output as the response body
 * </ul>
 *
 * <p>Controlled by the {@code ARTIFACT_ANALYSIS_HTTP_PORT} environment variable
 * (default: {@code 9090}).
 *
 * <p>This replaces the one-shot subprocess invocation in
 * {@code ArtifactAnalysisService.runJvmBoundary()} once the orchestrator
 * pipeline is ready for async service calls.
 */
public final class ArtifactAnalysisServer {

    private ArtifactAnalysisServer() {}

    public static void main(String[] args) throws IOException {
        int port = resolvePort();
        HttpServer server = HttpServer.create(new InetSocketAddress(port), /*backlog*/ 16);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());

        server.createContext("/healthz", ArtifactAnalysisServer::handleHealthz);
        server.createContext("/v1/artifact-analysis/analyze", ArtifactAnalysisServer::handleAnalyze);

        server.start();
        System.out.printf(
                "[artifact-analysis-server] Listening on port %d%n" +
                "[artifact-analysis-server] POST /v1/artifact-analysis/analyze%n" +
                "[artifact-analysis-server] GET  /healthz%n",
                port);
    }

    // -------------------------------------------------------------------------
    // Handlers
    // -------------------------------------------------------------------------

    private static void handleHealthz(HttpExchange exchange) throws IOException {
        if (!"GET".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendResponse(exchange, 405, "text/plain", "Method Not Allowed");
            return;
        }
        sendResponse(exchange, 200, "application/json",
                "{\"service\":\"artifact-analysis\",\"status\":\"ok\"}");
    }

    private static void handleAnalyze(HttpExchange exchange) throws IOException {
        if (!"POST".equalsIgnoreCase(exchange.getRequestMethod())) {
            sendResponse(exchange, 405, "text/plain", "Method Not Allowed");
            return;
        }

        String requestId = headerOrDefault(exchange, "x-request-id", "unknown");
        String traceId   = headerOrDefault(exchange, "x-trace-id", requestId);

        String body;
        try {
            body = readBody(exchange.getRequestBody());
        } catch (IOException e) {
            sendErrorJson(exchange, 400, requestId, traceId,
                    "invalid_request", "Failed to read request body: " + e.getMessage(), false);
            return;
        }

        if (body.isBlank()) {
            sendErrorJson(exchange, 400, requestId, traceId,
                    "request_body_required", "Request body must not be empty.", false);
            return;
        }

        String result;
        try {
            result = ArtifactAnalysisBoundary.processInput(body);
        } catch (Exception e) {
            sendErrorJson(exchange, 500, requestId, traceId,
                    "analysis_failed", "Artifact analysis failed: " + e.getMessage(), true);
            return;
        }

        exchange.getResponseHeaders().set("content-type", "text/plain; charset=utf-8");
        exchange.getResponseHeaders().set("x-request-id", requestId);
        exchange.getResponseHeaders().set("x-trace-id", traceId);
        byte[] responseBytes = result.getBytes(StandardCharsets.UTF_8);
        exchange.sendResponseHeaders(200, responseBytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(responseBytes);
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static int resolvePort() {
        String envPort = System.getenv("ARTIFACT_ANALYSIS_HTTP_PORT");
        if (envPort != null && !envPort.isBlank()) {
            try {
                return Integer.parseInt(envPort.trim());
            } catch (NumberFormatException ignored) {
            }
        }
        return 9090;
    }

    private static String readBody(InputStream is) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = is.read(chunk)) != -1) {
            buffer.write(chunk, 0, read);
        }
        return buffer.toString(StandardCharsets.UTF_8);
    }

    private static String headerOrDefault(HttpExchange exchange, String name, String defaultValue) {
        String value = exchange.getRequestHeaders().getFirst(name);
        return (value != null && !value.isBlank()) ? value.trim() : defaultValue;
    }

    private static void sendResponse(HttpExchange exchange, int status,
                                     String contentType, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().set("content-type", contentType + "; charset=utf-8");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = exchange.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static void sendErrorJson(HttpExchange exchange, int status,
                                      String requestId, String traceId,
                                      String code, String message, boolean retryable)
            throws IOException {
        String json = String.format(
                "{\"error\":{\"code\":%s,\"message\":%s,\"retryable\":%s," +
                "\"requestId\":%s,\"traceId\":%s}}",
                jsonString(code), jsonString(message), retryable,
                jsonString(requestId), jsonString(traceId));
        exchange.getResponseHeaders().set("x-request-id", requestId);
        exchange.getResponseHeaders().set("x-trace-id", traceId);
        sendResponse(exchange, status, "application/json", json);
    }

    private static String jsonString(String value) {
        if (value == null) return "null";
        return "\"" + value
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t")
                + "\"";
    }
}
