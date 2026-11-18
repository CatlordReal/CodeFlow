import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import type { Edge, Node } from "@xyflow/react";
import type { FlowEdge, FlowGraph, FlowNode } from "./types";
import { nodeContentHeight } from "./textLayout";
import { flowShape } from "./simplify";

export type FlowNodeData = Record<string, unknown> & { flow: FlowNode };
export type CanvasNode = Node<FlowNodeData, "flowNode">;
export type RoutePoint = { x: number; y: number };
export type RouteBounds = RoutePoint & { width: number; height: number };
export type FlowEdgeData = Record<string, unknown> & {
  points: RoutePoint[];
  labelPosition: RoutePoint;
  sourceOrigin: RoutePoint;
  targetOrigin: RoutePoint;
  routingObstacles?: string[];
};
export type CanvasEdge = Edge<FlowEdgeData, "flowEdge">;
const elk = new ELK();
export const NODE_WIDTH = 288;
export function nodeHeight(node: FlowNode): number { return nodeContentHeight(node); }
export { edgeTypes } from "./FlowEdgePath";

type Side = "n" | "s" | "e" | "w";
const portId = (id: string, direction: "in" | "out", side: Side) => `${id}:${direction}:${side}`;

export async function layoutGraph(graph: FlowGraph, displayLabels: ReadonlyMap<string, string> = new Map()): Promise<{ nodes: CanvasNode[]; edges: CanvasEdge[] }> {
  if (!graph.nodes.length) return { nodes: [], edges: [] };
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const backedges = findBackedges(graph);
  const sides = new Map(graph.edges.map((edge) => {
    const source = byId.get(edge.source)!;
    const backward = backedges.has(edge.id);
    // Branch identity is structural; display labels can be renamed or hidden.
    // A loop exit may itself return to an enclosing loop, and a hidden body
    // may collapse the running branch into a self-edge.
    const isExit = flowShape(source) === "decision" && edge.label === "No";
    const isLoopBody = source.kind === "loop" && edge.label === "Yes";
    const sourceSide: Side = isExit ? "e" : backward && !isLoopBody ? "w" : "s";
    return [edge.id, { sourceSide, targetSide: backward ? "w" as Side : "n" as Side }];
  }));
  const result: ElkNode = await elk.layout({
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "84",
      "elk.spacing.edgeNode": "30",
      "elk.spacing.edgeEdge": "18",
      "elk.layered.spacing.nodeNodeBetweenLayers": "36",
      "elk.layered.spacing.edgeNodeBetweenLayers": "28",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.cycleBreaking.strategy": "DEPTH_FIRST",
      "elk.layered.mergeEdges": "false",
    },
    children: graph.nodes.map((node) => {
      const height = nodeHeight(node);
      const inset = flowShape(node) === "io" ? 12 : 0;
      const positions: Record<Side, RoutePoint> = { n: { x: NODE_WIDTH / 2, y: 0 }, s: { x: NODE_WIDTH / 2, y: height }, e: { x: NODE_WIDTH - inset, y: height / 2 }, w: { x: inset, y: height / 2 } };
      return {
        id: node.id, width: NODE_WIDTH, height,
        layoutOptions: {
          "elk.portConstraints": "FIXED_POS",
          ...(node.kind === "start" ? { "elk.layered.layering.layerConstraint": "FIRST" } : {}),
          ...(node.kind === "end" ? { "elk.layered.layering.layerConstraint": "LAST" } : {}),
        },
        ports: (["in", "out"] as const).flatMap((direction) => (["n", "s", "e", "w"] as const).map((side) => ({
          id: portId(node.id, direction, side), ...positions[side], width: 0, height: 0,
          layoutOptions: { "elk.port.side": ({ n: "NORTH", s: "SOUTH", e: "EAST", w: "WEST" })[side] },
        }))),
      };
    }),
    edges: [...graph.edges].sort((a, b) => Number(b.label === "Yes") - Number(a.label === "Yes")).map((edge) => ({
      id: edge.id,
      sources: [portId(edge.source, "out", sides.get(edge.id)!.sourceSide)],
      targets: [portId(edge.target, "in", sides.get(edge.id)!.targetSide)],
      layoutOptions: { "elk.layered.priority.direction": backedges.has(edge.id) ? "0" : "100" },
    })),
  });
  const nodes: CanvasNode[] = (result.children ?? []).flatMap((child) => {
    const flow = byId.get(child.id);
    if (!flow) return [];
    return [{ id: child.id, type: "flowNode", position: { x: child.x ?? 0, y: child.y ?? 0 }, data: { flow }, width: NODE_WIDTH, height: nodeHeight(flow) }];
  });
  const positions = new Map(nodes.map((node) => [node.id, node.position]));
  const nodeBounds = nodes.map((node): RouteBounds => ({ ...node.position, width: NODE_WIDTH, height: nodeHeight(node.data.flow) }));
  const routed = new Map((result.edges ?? []).map((edge) => [edge.id, edge]));
  const occupiedLabels: RouteBounds[] = [];
  const edges: CanvasEdge[] = graph.edges.map((edge) => {
    const sections = routed.get(edge.id)?.sections ?? [];
    const points = sections.flatMap((section) => [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]);
    const unique = points.filter((point, index) => !index || point.x !== points[index - 1].x || point.y !== points[index - 1].y);
    const label = displayLabels.get(edge.id) ?? edge.label;
    const labelPosition = routeLabelPosition(unique, label, nodeBounds, occupiedLabels);
    if (label.trim()) occupiedLabels.push(routeLabelBounds(labelPosition, label));
    return {
      id: edge.id, source: edge.source, target: edge.target, label: edge.label || undefined, type: "flowEdge",
      sourceHandle: `out-${sides.get(edge.id)!.sourceSide}`, targetHandle: `in-${sides.get(edge.id)!.targetSide}`,
      markerEnd: { type: "arrowclosed", width: 17, height: 17, color: "var(--flow-edge, var(--muted))" },
      style: { stroke: "var(--flow-edge, var(--muted))", strokeWidth: 1.8 },
      data: { points: unique, labelPosition, sourceOrigin: positions.get(edge.source)!, targetOrigin: positions.get(edge.target)! },
    };
  });
  return { nodes, edges };
}

function findBackedges(graph: FlowGraph): Set<string> {
  const outgoing = new Map<string, FlowEdge[]>();
  for (const edge of graph.edges) outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
  const visited = new Set<string>();
  const active = new Set<string>();
  const backward = new Set<string>();
  const visit = (id: string) => {
    visited.add(id); active.add(id);
    // Visit body branches before exits so nested loops retain their downward spine.
    const edges = [...(outgoing.get(id) ?? [])].sort((a, b) => Number(b.label === "Yes") - Number(a.label === "Yes"));
    for (const edge of edges) {
      if (active.has(edge.target)) backward.add(edge.id);
      else if (!visited.has(edge.target)) visit(edge.target);
    }
    active.delete(id);
  };
  for (const node of [...graph.nodes].sort((a, b) => Number(b.kind === "start") - Number(a.kind === "start"))) if (!visited.has(node.id)) visit(node.id);
  return backward;
}

export function routeLabelBounds(position: RoutePoint, label: string): RouteBounds {
  const characters = Array.from(label.replace(/\s+/g, " ")).length;
  return { x: position.x - (characters * 11 + 8) / 2, y: position.y - 10, width: characters * 11 + 8, height: 20 };
}

function boundsOverlap(left: RouteBounds, right: RouteBounds): boolean {
  return left.x < right.x + right.width && left.x + left.width > right.x
    && left.y < right.y + right.height && left.y + left.height > right.y;
}

export function routeLabelPosition(points: RoutePoint[], label = "", nodeBounds: readonly RouteBounds[] = [], occupiedLabels: readonly RouteBounds[] = []): RoutePoint {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 };
  const obstacles = [...nodeBounds, ...occupiedLabels];
  const sample = routeLabelBounds({ x: 0, y: 0 }, label);
  const candidates: { point: RoutePoint; segment: number; order: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], horizontal = a.y === b.y;
    const start = horizontal ? a.x : a.y, end = horizontal ? b.x : b.y;
    const low = Math.min(start, end), high = Math.max(start, end);
    if (low === high) continue;
    const values = [(start + end) / 2, start, end];
    for (const box of obstacles) {
      const half = horizontal ? sample.width / 2 : sample.height / 2;
      values.push((horizontal ? box.x : box.y) - half - 6, (horizontal ? box.x + box.width : box.y + box.height) + half + 6);
    }
    for (const value of values) {
      if (value < low || value > high) continue;
      candidates.push({ point: horizontal ? { x: value, y: a.y } : { x: a.x, y: value }, segment: i, order: Math.abs(value - (start + end) / 2) });
    }
  }
  const score = (candidate: typeof candidates[number]) => {
    const rect = routeLabelBounds(candidate.point, label);
    return obstacles.filter(box => boundsOverlap(rect, box)).length;
  };
  const ranked = candidates.map(candidate => ({ ...candidate, score: score(candidate) }));
  ranked.sort((a, b) => a.score - b.score || a.segment - b.segment || a.order - b.order);
  return ranked[0]?.point ?? points[0];
}

export function routePath(points: RoutePoint[]): string {
  return points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
}
