import ELK from "elkjs/lib/elk.bundled.js";
import type { Edge, Node } from "@xyflow/react";
import type { FlowEdge, FlowGraph, FlowNode } from "./types";
import { nodeContentHeight } from "./textLayout";

export type FlowNodeData = Record<string, unknown> & {
  flow: FlowNode;
};

export type CanvasNode = Node<FlowNodeData, "flowNode">;

const elk = new ELK();
export const NODE_WIDTH = 256;

export function nodeHeight(node: FlowNode): number {
  return nodeContentHeight(node);
}

export async function layoutGraph(graph: FlowGraph): Promise<{ nodes: CanvasNode[]; edges: Edge[] }> {
  const result = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.spacing.nodeNode": "56",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    },
    children: graph.nodes.map((node) => ({
      id: node.id,
      width: NODE_WIDTH,
      height: nodeHeight(node),
    })),
    edges: graph.edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });

  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const nodes: CanvasNode[] = (result.children ?? []).flatMap((child) => {
    const flow = byId.get(child.id);
    if (!flow) return [];
    return [{
      id: child.id,
      type: "flowNode",
      position: { x: child.x ?? 0, y: child.y ?? 0 },
      data: { flow },
      width: NODE_WIDTH,
      height: nodeHeight(flow),
    }];
  });

  return { nodes, edges: graph.edges.map(toCanvasEdge) };
}

function toCanvasEdge(edge: FlowEdge): Edge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label || undefined,
    type: "smoothstep",
    animated: false,
    markerEnd: { type: "arrowclosed", width: 18, height: 18, color: "#90a17e" },
    style: { stroke: "#90a17e", strokeWidth: 1.7 },
    labelStyle: { fill: "#cbd8bd", fontSize: 11, fontWeight: 650 },
    labelBgStyle: { fill: "#161b14", fillOpacity: 0.94 },
    labelBgPadding: [6, 4],
    labelBgBorderRadius: 6,
  };
}
