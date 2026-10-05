import type { Edge } from "@xyflow/react";
import type { CanvasNode, FlowEdgeData, RoutePoint } from "./layout";
import { NODE_WIDTH, nodeHeight, routePath } from "./layout";
import { COMMENT_LINE_HEIGHT, LABEL_LINE_HEIGHT, nodeTextLayout } from "./textLayout";
import { flowShape } from "./simplify";
import type { FlowEdge } from "./types";

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!));
export function svgDocumentName(name: string): string { return name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "flowchart"; }

/** Export the same symbols, labels, and orthogonal routes displayed on the canvas. */
export function createSvgDocument(nodes: CanvasNode[], edges: (Edge | FlowEdge)[], mode: "code" | "natural" = "code"): string {
  if (!nodes.length) return "";
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const route = (edge: Edge | FlowEdge): RoutePoint[] => {
    const data = "data" in edge ? edge.data as FlowEdgeData | undefined : undefined;
    if (data?.points.length) return data.points;
    const source = byId.get(edge.source), target = byId.get(edge.target);
    if (!source || !target) return [];
    const sourcePoint = { x: source.position.x + NODE_WIDTH / 2, y: source.position.y + nodeHeight(source.data.flow) };
    const targetPoint = { x: target.position.x + NODE_WIDTH / 2, y: target.position.y };
    if (targetPoint.y <= sourcePoint.y) {
      const outsideX = Math.min(...nodes.map((node) => node.position.x)) - 30;
      return [sourcePoint, { x: sourcePoint.x, y: sourcePoint.y + 24 }, { x: outsideX, y: sourcePoint.y + 24 }, { x: outsideX, y: targetPoint.y - 24 }, { x: targetPoint.x, y: targetPoint.y - 24 }, targetPoint];
    }
    const middleY = (sourcePoint.y + targetPoint.y) / 2;
    return [sourcePoint, { x: sourcePoint.x, y: middleY }, { x: targetPoint.x, y: middleY }, targetPoint];
  };
  const routes = edges.map((edge) => ({ edge, points: route(edge) }));
  const allPoints = routes.flatMap(({ points }) => points);
  const minX = Math.min(...nodes.map((node) => node.position.x), ...allPoints.map((point) => point.x)) - 48;
  const minY = Math.min(...nodes.map((node) => node.position.y), ...allPoints.map((point) => point.y)) - 48;
  const maxX = Math.max(...nodes.map((node) => node.position.x + NODE_WIDTH), ...allPoints.map((point) => point.x)) + 48;
  const maxY = Math.max(...nodes.map((node) => node.position.y + nodeHeight(node.data.flow)), ...allPoints.map((point) => point.y)) + 48;
  const edgeMarkup = routes.map(({ edge, points }) => {
    if (!points.length) return "";
    const data = "data" in edge ? edge.data as FlowEdgeData | undefined : undefined;
    const labelAt = data?.labelPosition ?? { x: (points[0].x + points[1].x) / 2 + 18, y: (points[0].y + points[1].y) / 2 };
    const label = typeof edge.label === "string" && edge.label ? `<text x="${labelAt.x}" y="${labelAt.y + 4}" text-anchor="middle" class="edge-label">${esc(edge.label)}</text>` : "";
    return `<path d="${routePath(points)}" class="edge" marker-end="url(#arrow)"/>${label}`;
  }).join("");
  const nodeMarkup = nodes.map((node) => {
    const flow = node.data.flow, height = nodeHeight(flow), shape = flowShape(flow);
    const { x, y } = node.position;
    const { labelLines, commentLines, annotationLines } = nodeTextLayout(flow);
    const contentHeight = labelLines.length * LABEL_LINE_HEIGHT + (commentLines.length ? 10 + commentLines.length * COMMENT_LINE_HEIGHT : 0) + (annotationLines.length ? 10 + annotationLines.length * COMMENT_LINE_HEIGHT : 0);
    const top = y + (height - contentHeight) / 2;
    const text = (lines: string[], start: number, lineHeight: number, className: string) => lines.map((line, index) => `<text x="${x + NODE_WIDTH / 2}" y="${start + index * lineHeight + lineHeight * 0.76}" text-anchor="middle" class="${className}">${esc(line)}</text>`).join("");
    const labelMarkup = text(labelLines, top, LABEL_LINE_HEIGHT, "label");
    const commentsTop = top + labelLines.length * LABEL_LINE_HEIGHT + 10;
    const commentsMarkup = text(commentLines, commentsTop, COMMENT_LINE_HEIGHT, "comment");
    const annotationTop = top + labelLines.length * LABEL_LINE_HEIGHT + (commentLines.length ? commentLines.length * COMMENT_LINE_HEIGHT + 10 : 0) + 10;
    const annotationMarkup = text(annotationLines, annotationTop, COMMENT_LINE_HEIGHT, "annotation");
    let outline: string;
    if (shape === "decision") outline = `<polygon points="${x + NODE_WIDTH / 2},${y + 1} ${x + NODE_WIDTH - 1},${y + height / 2} ${x + NODE_WIDTH / 2},${y + height - 1} ${x + 1},${y + height / 2}"/>`;
    else if (shape === "io") outline = `<polygon points="${x + 24},${y + 1} ${x + NODE_WIDTH - 1},${y + 1} ${x + NODE_WIDTH - 24},${y + height - 1} ${x + 1},${y + height - 1}"/>`;
    else if (shape === "terminator") outline = `<ellipse cx="${x + NODE_WIDTH / 2}" cy="${y + height / 2}" rx="${NODE_WIDTH / 2 - 1}" ry="${height / 2 - 1}"/>`;
    else outline = `<rect x="${x + 1}" y="${y + 1}" width="${NODE_WIDTH - 2}" height="${height - 2}"/>${shape === "subprocess" ? `<path d="M ${x + 12} ${y + 1} V ${y + height - 1} M ${x + NODE_WIDTH - 12} ${y + 1} V ${y + height - 1}" fill="none" stroke="#68775e" stroke-width="1.6"/>` : ""}`;
    return `<g class="node node-${shape}"><title>Line ${flow.line}</title>${outline}${labelMarkup}${commentsMarkup}${annotationMarkup}</g>`;
  }).join("");
  const labelFont = mode === "natural" ? "500 16px system-ui,sans-serif" : "500 12px ui-monospace,monospace";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX - minX}" height="${maxY - minY}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#59634f"/></marker><style>.edge{fill:none;stroke:#59634f;stroke-width:1.8}.edge-label{font:600 11px system-ui;fill:#313a2d;paint-order:stroke;stroke:#fff;stroke-width:5px}.node>rect,.node>polygon,.node>ellipse{fill:#fff;stroke:#68775e;stroke-width:1.6}.label{font:${labelFont};fill:#1b2118}.comment,.annotation{font:11px system-ui;fill:#59634f}.comment{font-style:italic}</style></defs><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="#fff"/>${edgeMarkup}${nodeMarkup}</svg>`;
}
