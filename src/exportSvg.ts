import type { CanvasNode } from "./layout";
import { NODE_WIDTH, nodeHeight } from "./layout";
import { COMMENT_LINE_HEIGHT, LABEL_LINE_HEIGHT, nodeTextLayout } from "./textLayout";
import type { FlowEdge } from "./types";

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
}[char]!));

export function svgDocumentName(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "flowchart";
}

export function createSvgDocument(nodes: CanvasNode[], edges: FlowEdge[]): string {
  if (nodes.length === 0) return "";
  const minX = Math.min(...nodes.map((node) => node.position.x)) - 48;
  const minY = Math.min(...nodes.map((node) => node.position.y)) - 48;
  const maxX = Math.max(...nodes.map((node) => node.position.x + NODE_WIDTH)) + 48;
  const maxY = Math.max(...nodes.map((node) => node.position.y + nodeHeight(node.data.flow))) + 48;
  const byId = new Map(nodes.map((node) => [node.id, node]));

  const edgeMarkup = edges.flatMap((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) return [];
    const sourceX = source.position.x + NODE_WIDTH / 2;
    const sourceY = source.position.y + nodeHeight(source.data.flow);
    const targetX = target.position.x + NODE_WIDTH / 2;
    const targetY = target.position.y;
    const middleY = sourceY + (targetY - sourceY) / 2;
    const path = `M ${sourceX} ${sourceY} L ${sourceX} ${middleY} L ${targetX} ${middleY} L ${targetX} ${targetY}`;
    const label = edge.label ? `<text x="${(sourceX + targetX) / 2}" y="${middleY - 7}" text-anchor="middle" class="edge-label">${esc(edge.label)}</text>` : "";
    return [`<path d="${path}" class="edge" marker-end="url(#arrow)"/>${label}`];
  }).join("");

  const nodeMarkup = nodes.map((node) => {
    const flow = node.data.flow;
    const height = nodeHeight(flow);
    const { labelLines, commentLines } = nodeTextLayout(flow);
    const text = labelLines.map((line, index) => `<text x="${node.position.x + 18}" y="${node.position.y + 50 + index * LABEL_LINE_HEIGHT}" class="label">${esc(line)}</text>`).join("");
    const commentStart = node.position.y + 50 + labelLines.length * LABEL_LINE_HEIGHT + 18;
    const commentText = commentLines.map((line, index) => `<text x="${node.position.x + 18}" y="${commentStart + index * COMMENT_LINE_HEIGHT}" class="comment">${esc(line)}</text>`).join("");
    return `<g><rect x="${node.position.x}" y="${node.position.y}" width="${NODE_WIDTH}" height="${height}" rx="14" class="node node-${esc(flow.kind)}"/><text x="${node.position.x + 18}" y="${node.position.y + 23}" class="meta">${esc(flow.kind.toUpperCase())} · LINE ${flow.line}</text>${text}${commentText}</g>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX - minX}" height="${maxY - minY}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#77866a"/></marker><style>.edge{fill:none;stroke:#77866a;stroke-width:1.7}.edge-label{font:600 11px system-ui;fill:#59634f}.node{fill:#fbfcf8;stroke:#bdc9b1;stroke-width:1.4}.node-decision{fill:#f5f8ee;stroke:#96aa7d}.node-return,.node-throw{fill:#faf4ec;stroke:#c5a47c}.meta{font:700 10px system-ui;letter-spacing:1px;fill:#6c7962}.label{font:600 13px ui-monospace,monospace;fill:#1b2118}.comment{font:italic 11px system-ui;fill:#697062}.edge-label{paint-order:stroke;stroke:#fff;stroke-width:5px}</style></defs><rect x="${minX}" y="${minY}" width="100%" height="100%" fill="#f4f6ef"/>${edgeMarkup}${nodeMarkup}</svg>`;
}
