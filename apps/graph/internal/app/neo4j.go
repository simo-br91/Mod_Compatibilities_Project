package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type Neo4jGraphStore struct {
	baseURL    string
	username   string
	password   string
	httpClient *http.Client
}

type neo4jStatement struct {
	Statement  string                 `json:"statement"`
	Parameters map[string]interface{} `json:"parameters,omitempty"`
}

type neo4jRequest struct {
	Statements []neo4jStatement `json:"statements"`
}

type neo4jResponse struct {
	Results []neo4jResult `json:"results"`
	Errors []struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
}

type neo4jResult struct {
	Data []neo4jResultData `json:"data"`
}

type neo4jResultData struct {
	Row []json.RawMessage `json:"row"`
}

type neo4jStoredNode struct {
	NodeID         string `json:"node_id"`
	NodeType       string `json:"node_type"`
	Label          string `json:"label"`
	PropertiesJSON string `json:"properties_json"`
}

type neo4jStoredEdge struct {
	EdgeID         string  `json:"edge_id"`
	EdgeType       string  `json:"edge_type"`
	SourceID       string  `json:"source_id"`
	TargetID       string  `json:"target_id"`
	Weight         float64 `json:"weight"`
	PropertiesJSON string  `json:"properties_json"`
}

func NewNeo4jGraphStore(
	rawURL string,
	username string,
	password string,
	httpClient *http.Client,
) (*Neo4jGraphStore, error) {
	baseURL, err := deriveNeo4jHTTPBaseURL(rawURL)
	if err != nil {
		return nil, err
	}

	client := httpClient
	if client == nil {
		client = http.DefaultClient
	}

	return &Neo4jGraphStore{
		baseURL:    baseURL,
		username:   strings.TrimSpace(username),
		password:   password,
		httpClient: client,
	}, nil
}

func (s *Neo4jGraphStore) SaveGraph(snapshot GraphSnapshot) error {
	nodes := make([]map[string]interface{}, 0, len(snapshot.Nodes))
	for _, node := range snapshot.Nodes {
		nodes = append(nodes, map[string]interface{}{
			"node_id":         node.NodeID,
			"node_type":       node.NodeType,
			"label":           node.Label,
			"properties_json": encodeJSON(node.Props),
		})
	}

	edges := make([]map[string]interface{}, 0, len(snapshot.Edges))
	for _, edge := range snapshot.Edges {
		edges = append(edges, map[string]interface{}{
			"edge_id":         edge.EdgeID,
			"edge_type":       edge.EdgeType,
			"source_id":       edge.SourceID,
			"target_id":       edge.TargetID,
			"weight":          edge.Weight,
			"properties_json": encodeJSON(edge.Props),
		})
	}

	_, err := s.execute([]neo4jStatement{
		{
			Statement: `
				MERGE (a:Analysis {analysis_id: $analysis_id})
				WITH a
				OPTIONAL MATCH (a)-[:HAS_NODE]->(n:GraphNode {analysis_id: $analysis_id})
				DETACH DELETE n
			`,
			Parameters: map[string]interface{}{
				"analysis_id": snapshot.AnalysisID,
			},
		},
		{
			Statement: `
				MERGE (a:Analysis {analysis_id: $analysis_id})
				WITH a
				UNWIND $nodes AS node
				MERGE (n:GraphNode {analysis_id: $analysis_id, node_id: node.node_id})
				SET
					n.node_type = node.node_type,
					n.label = node.label,
					n.properties_json = node.properties_json
				MERGE (a)-[:HAS_NODE]->(n)
			`,
			Parameters: map[string]interface{}{
				"analysis_id": snapshot.AnalysisID,
				"nodes":       nodes,
			},
		},
		{
			Statement: `
				UNWIND $edges AS edge
				MATCH (src:GraphNode {analysis_id: $analysis_id, node_id: edge.source_id})
				MATCH (dst:GraphNode {analysis_id: $analysis_id, node_id: edge.target_id})
				MERGE (src)-[r:CONNECTED_TO {analysis_id: $analysis_id, edge_id: edge.edge_id}]->(dst)
				SET
					r.edge_type = edge.edge_type,
					r.weight = edge.weight,
					r.properties_json = edge.properties_json
			`,
			Parameters: map[string]interface{}{
				"analysis_id": snapshot.AnalysisID,
				"edges":       edges,
			},
		},
	})
	return err
}

func (s *Neo4jGraphStore) LoadGraph(analysisID string) (GraphSnapshot, bool, error) {
	results, err := s.execute([]neo4jStatement{
		{
			Statement: `
				MATCH (a:Analysis {analysis_id: $analysis_id})
				OPTIONAL MATCH (a)-[:HAS_NODE]->(n:GraphNode {analysis_id: $analysis_id})
				RETURN collect(DISTINCT {
					node_id: n.node_id,
					node_type: n.node_type,
					label: n.label,
					properties_json: n.properties_json
				}) AS nodes
			`,
			Parameters: map[string]interface{}{
				"analysis_id": analysisID,
			},
		},
		{
			Statement: `
				MATCH (:Analysis {analysis_id: $analysis_id})
				OPTIONAL MATCH (src:GraphNode {analysis_id: $analysis_id})-[r:CONNECTED_TO {analysis_id: $analysis_id}]->(dst:GraphNode {analysis_id: $analysis_id})
				RETURN collect(DISTINCT {
					edge_id: r.edge_id,
					edge_type: r.edge_type,
					source_id: src.node_id,
					target_id: dst.node_id,
					weight: r.weight,
					properties_json: r.properties_json
				}) AS edges
			`,
			Parameters: map[string]interface{}{
				"analysis_id": analysisID,
			},
		},
	})
	if err != nil {
		return GraphSnapshot{}, false, err
	}
	if len(results) < 2 || len(results[0].Data) == 0 {
		return GraphSnapshot{}, false, nil
	}

	var storedNodes []neo4jStoredNode
	if len(results[0].Data[0].Row) > 0 {
		if err := json.Unmarshal(results[0].Data[0].Row[0], &storedNodes); err != nil {
			return GraphSnapshot{}, false, err
		}
	}

	var storedEdges []neo4jStoredEdge
	if len(results[1].Data) > 0 && len(results[1].Data[0].Row) > 0 {
		if err := json.Unmarshal(results[1].Data[0].Row[0], &storedEdges); err != nil {
			return GraphSnapshot{}, false, err
		}
	}

	nodes := make([]GraphNode, 0, len(storedNodes))
	for _, node := range storedNodes {
		if strings.TrimSpace(node.NodeID) == "" {
			continue
		}
		nodes = append(nodes, GraphNode{
			NodeID:   node.NodeID,
			NodeType: node.NodeType,
			Label:    node.Label,
			Props:    decodeJSONMap(node.PropertiesJSON),
		})
	}

	edges := make([]GraphEdge, 0, len(storedEdges))
	for _, edge := range storedEdges {
		if strings.TrimSpace(edge.EdgeID) == "" {
			continue
		}
		edges = append(edges, GraphEdge{
			EdgeID:   edge.EdgeID,
			EdgeType: edge.EdgeType,
			SourceID: edge.SourceID,
			TargetID: edge.TargetID,
			Weight:   edge.Weight,
			Props:    decodeJSONMap(edge.PropertiesJSON),
		})
	}

	return GraphSnapshot{
		AnalysisID: analysisID,
		Nodes:      nodes,
		Edges:      edges,
	}, true, nil
}

func (s *Neo4jGraphStore) SaveExplanation(path ExplanationPath) error {
	_, err := s.execute([]neo4jStatement{
		{
			Statement: `
				MERGE (a:Analysis {analysis_id: $analysis_id})
				MERGE (e:ExplanationPath {analysis_id: $analysis_id, finding_id: $finding_id})
				SET
					e.path_id = $path_id,
					e.summary = $summary,
					e.nodes_json = $nodes_json,
					e.edges_json = $edges_json
				MERGE (a)-[:HAS_EXPLANATION]->(e)
			`,
			Parameters: map[string]interface{}{
				"analysis_id": path.AnalysisID,
				"finding_id":  path.FindingID,
				"path_id":     path.PathID,
				"summary":     path.Summary,
				"nodes_json":  encodeJSON(path.Nodes),
				"edges_json":  encodeJSON(path.Edges),
			},
		},
	})
	return err
}

func (s *Neo4jGraphStore) LoadExplanation(
	analysisID string,
	findingID string,
) (ExplanationPath, bool, error) {
	results, err := s.execute([]neo4jStatement{
		{
			Statement: `
				MATCH (:Analysis {analysis_id: $analysis_id})-[:HAS_EXPLANATION]->(e:ExplanationPath {
					analysis_id: $analysis_id,
					finding_id: $finding_id
				})
				RETURN e.path_id, e.summary, e.nodes_json, e.edges_json
			`,
			Parameters: map[string]interface{}{
				"analysis_id": analysisID,
				"finding_id":  findingID,
			},
		},
	})
	if err != nil {
		return ExplanationPath{}, false, err
	}
	if len(results) == 0 || len(results[0].Data) == 0 || len(results[0].Data[0].Row) < 4 {
		return ExplanationPath{}, false, nil
	}

	row := results[0].Data[0].Row
	var pathID string
	var summary string
	var nodesJSON string
	var edgesJSON string

	if err := json.Unmarshal(row[0], &pathID); err != nil {
		return ExplanationPath{}, false, err
	}
	if err := json.Unmarshal(row[1], &summary); err != nil {
		return ExplanationPath{}, false, err
	}
	if err := json.Unmarshal(row[2], &nodesJSON); err != nil {
		return ExplanationPath{}, false, err
	}
	if err := json.Unmarshal(row[3], &edgesJSON); err != nil {
		return ExplanationPath{}, false, err
	}

	var nodes []GraphNode
	if err := decodeJSONString(nodesJSON, &nodes); err != nil {
		return ExplanationPath{}, false, err
	}

	var edges []GraphEdge
	if err := decodeJSONString(edgesJSON, &edges); err != nil {
		return ExplanationPath{}, false, err
	}

	return ExplanationPath{
		PathID:     pathID,
		AnalysisID: analysisID,
		FindingID:  findingID,
		Summary:    summary,
		Nodes:      nodes,
		Edges:      edges,
	}, true, nil
}

func (s *Neo4jGraphStore) execute(statements []neo4jStatement) ([]neo4jResult, error) {
	body, err := json.Marshal(neo4jRequest{Statements: statements})
	if err != nil {
		return nil, err
	}

	request, err := http.NewRequest(
		http.MethodPost,
		s.baseURL+"/db/neo4j/tx/commit",
		bytes.NewReader(body),
	)
	if err != nil {
		return nil, err
	}
	request.Header.Set("accept", "application/json")
	request.Header.Set("content-type", "application/json")
	if s.username != "" {
		request.SetBasicAuth(s.username, s.password)
	}

	response, err := s.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	var payload neo4jResponse
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		return nil, err
	}

	if response.StatusCode >= 400 {
		return nil, fmt.Errorf("neo4j request failed with status %d", response.StatusCode)
	}
	if len(payload.Errors) > 0 {
		return nil, fmt.Errorf("neo4j query failed: %s", payload.Errors[0].Message)
	}

	return payload.Results, nil
}

func deriveNeo4jHTTPBaseURL(rawURL string) (string, error) {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return "", fmt.Errorf("neo4j URL is required")
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", err
	}

	switch parsed.Scheme {
	case "http", "https":
		return strings.TrimRight(parsed.String(), "/"), nil
	case "bolt", "neo4j":
		parsed.Scheme = "http"
	case "bolt+s", "bolt+ssc", "neo4j+s", "neo4j+ssc":
		parsed.Scheme = "https"
	default:
		return "", fmt.Errorf("unsupported neo4j scheme %q", parsed.Scheme)
	}

	host := parsed.Hostname()
	port := parsed.Port()
	if port == "" {
		if parsed.Scheme == "https" {
			port = "7473"
		} else {
			port = "7474"
		}
	} else if port == "7687" {
		if parsed.Scheme == "https" {
			port = "7473"
		} else {
			port = "7474"
		}
	}

	parsed.Host = host + ":" + port
	parsed.Path = ""
	parsed.RawPath = ""
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/"), nil
}

func encodeJSON(value interface{}) string {
	if value == nil {
		return "{}"
	}

	payload, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(payload)
}

func decodeJSONMap(raw string) map[string]interface{} {
	if strings.TrimSpace(raw) == "" || strings.TrimSpace(raw) == "{}" {
		return nil
	}

	var value map[string]interface{}
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return nil
	}
	if len(value) == 0 {
		return nil
	}
	return value
}

func decodeJSONString(raw string, target interface{}) error {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		trimmed = "[]"
	}
	return json.Unmarshal([]byte(trimmed), target)
}
