"use client";

import { useEffect, useState } from "react";
import { getGraph, getGraphNeighborhood, explainFinding, ApiError } from "@/lib/api";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardHeader } from "@/components/ui/card";
import type { GraphSnapshot, GraphNode, GraphEdge } from "@modcompat/domain-models";

export default function GraphPage({
  params,
}: {
  params: { projectId: string; analysisId: string };
}) {
  const [graph, setGraph] = useState<GraphSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [neighbourhood, setNeighbourhood] = useState<{ nodes: GraphNode[]; edges: GraphEdge[] } | null>(null);

  useEffect(() => {
    getGraph(params.analysisId)
      .then((r) => setGraph(r.graph))
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [params.analysisId]);

  async function handleNodeClick(node: GraphNode) {
    setSelectedNode(node);
    setNeighbourhood(null);
    try {
      const res = await getGraphNeighborhood(params.analysisId, node.nodeId, 2);
      setNeighbourhood(res.neighborhood);
    } catch {
      // ignore
    }
  }

  if (loading) {
    return <div className="flex justify-center py-12"><Spinner size="lg" /></div>;
  }

  if (error) {
    return <div className="p-8 text-sm text-red-600">{error}</div>;
  }

  if (!graph) {
    return <div className="p-8 text-sm text-gray-500">No graph available for this analysis.</div>;
  }

  const nodeTypeColour: Record<string, string> = {
    mod: "bg-indigo-100 text-indigo-800 border-indigo-200",
    finding: "bg-red-100 text-red-800 border-red-200",
    version: "bg-green-100 text-green-800 border-green-200",
    artifact: "bg-yellow-100 text-yellow-800 border-yellow-200",
  };

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-xl font-semibold text-gray-900">Dependency Graph</h1>

      <div className="grid grid-cols-2 gap-2 text-xs text-gray-500 mb-2">
        <span>{graph.nodes.length} nodes</span>
        <span>{graph.edges.length} edges</span>
      </div>

      <div className="flex gap-6">
        {/* Node list */}
        <div className="w-72 shrink-0">
          <Card>
            <CardHeader title="Nodes" subtitle="Click to inspect neighbourhood" />
            <div className="space-y-1 max-h-96 overflow-y-auto">
              {graph.nodes.slice(0, 50).map((node) => (
                <button
                  key={node.nodeId}
                  onClick={() => handleNodeClick(node)}
                  className={`w-full text-left px-3 py-2 rounded-lg border text-xs transition-colors hover:opacity-80 ${
                    nodeTypeColour[node.nodeType] ?? "bg-gray-100 text-gray-700 border-gray-200"
                  } ${selectedNode?.nodeId === node.nodeId ? "ring-2 ring-indigo-500" : ""}`}
                >
                  <p className="font-medium truncate">{node.label}</p>
                  <p className="text-gray-500">{node.nodeType}</p>
                </button>
              ))}
              {graph.nodes.length > 50 && (
                <p className="text-xs text-gray-400 px-3 py-1">+{graph.nodes.length - 50} more</p>
              )}
            </div>
          </Card>
        </div>

        {/* Edge list / neighbourhood */}
        <div className="flex-1">
          {selectedNode ? (
            <Card>
              <CardHeader title={`Neighbourhood: ${selectedNode.label}`} subtitle={selectedNode.nodeType} />
              {!neighbourhood ? (
                <div className="flex justify-center py-4"><Spinner /></div>
              ) : (
                <div className="space-y-4">
                  {neighbourhood.edges.length === 0 ? (
                    <p className="text-xs text-gray-500">No edges in neighbourhood.</p>
                  ) : (
                    <div className="space-y-1">
                      {neighbourhood.edges.map((edge) => (
                        <div key={edge.edgeId} className="flex items-center gap-2 text-xs text-gray-700">
                          <span className="font-mono text-gray-500 truncate max-w-[120px]">{edge.sourceId}</span>
                          <span className="text-indigo-500 shrink-0">—{edge.edgeType}→</span>
                          <span className="font-mono text-gray-500 truncate max-w-[120px]">{edge.targetId}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </Card>
          ) : (
            <Card>
              <CardHeader title="All edges" />
              <div className="space-y-1 max-h-96 overflow-y-auto">
                {graph.edges.slice(0, 100).map((edge) => (
                  <div key={edge.edgeId} className="flex items-center gap-2 text-xs text-gray-700">
                    <span className="font-mono text-gray-500 truncate max-w-[140px]">{edge.sourceId}</span>
                    <span className="text-indigo-500 shrink-0">—{edge.edgeType}→</span>
                    <span className="font-mono text-gray-500 truncate max-w-[140px]">{edge.targetId}</span>
                  </div>
                ))}
                {graph.edges.length > 100 && (
                  <p className="text-xs text-gray-400">+{graph.edges.length - 100} more</p>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
