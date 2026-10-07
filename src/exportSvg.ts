import type { Edge } from "@xyflow/react";
import type { CanvasNode, FlowEdgeData, RoutePoint } from "./layout";
import { NODE_WIDTH, nodeHeight, routePath } from "./layout";
import { COMMENT_LINE_HEIGHT, LABEL_LINE_HEIGHT, nodeTextLayout, markerHeight } from "./textLayout";
import { flowShape } from "./simplify";
import type { FlowEdge } from "./types";

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[char]!));
export function svgDocumentName(name: string): string { return name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "flowchart"; }

export type SvgPalette = {
  background: string;
  edgeLabelBackground: string;
  text: string;
  muted: string;
  edge: string;
  processFill: string;
  processStroke: string;
  decisionFill: string;
  decisionStroke: string;
  ioFill: string;
  ioStroke: string;
  terminatorFill: string;
  terminatorStroke: string;
  subprocessFill: string;
  subprocessStroke: string;
};

const defaultPalette: SvgPalette = {
  background: "#fff", edgeLabelBackground: "#fff", text: "#1b2118", muted: "#59634f", edge: "#59634f",
  processFill: "#fff", processStroke: "#68775e", decisionFill: "#fff", decisionStroke: "#68775e",
  ioFill: "#fff", ioStroke: "#68775e", terminatorFill: "#fff", terminatorStroke: "#68775e",
  subprocessFill: "#fff", subprocessStroke: "#68775e",
};

/** Snapshot active CSS theme colors for deterministic SVG and PNG exports. */
export function svgPaletteFromCss(root: Element = document.documentElement): SvgPalette {
  const style = getComputedStyle(root);
  const read = (token: string, fallback: string) => style.getPropertyValue(token).trim() || fallback;
  return {
    background: read("--bg", defaultPalette.background),
    edgeLabelBackground: read("--panel", defaultPalette.edgeLabelBackground),
    text: read("--text", defaultPalette.text),
    muted: read("--muted", defaultPalette.muted),
    edge: read("--line-strong", defaultPalette.edge),
    processFill: read("--diagram-process-fill", defaultPalette.processFill),
    processStroke: read("--diagram-process-stroke", defaultPalette.processStroke),
    decisionFill: read("--diagram-decision-fill", defaultPalette.decisionFill),
    decisionStroke: read("--diagram-decision-stroke", defaultPalette.decisionStroke),
    ioFill: read("--diagram-io-fill", defaultPalette.ioFill),
    ioStroke: read("--diagram-io-stroke", defaultPalette.ioStroke),
    terminatorFill: read("--diagram-terminator-fill", defaultPalette.terminatorFill),
    terminatorStroke: read("--diagram-terminator-stroke", defaultPalette.terminatorStroke),
    subprocessFill: read("--diagram-subprocess-fill", defaultPalette.subprocessFill),
    subprocessStroke: read("--diagram-subprocess-stroke", defaultPalette.subprocessStroke),
  };
}

/** Export the same symbols, labels, and orthogonal routes displayed on the canvas. */
export function createSvgDocument(nodes: CanvasNode[], edges: (Edge | FlowEdge)[], mode: "code" | "natural" = "code", palette: SvgPalette = defaultPalette): string {
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
    const isLoop = flow.kind === "loop" || flow.loop_collapsed === true;
    const visual = flow as typeof flow & { flagged?: boolean; unmodified?: boolean };
    const { x, y } = node.position;
    const { labelLines, commentLines, annotationLines } = nodeTextLayout(flow);
    const contentHeight = labelLines.length * LABEL_LINE_HEIGHT + (commentLines.length ? 10 + commentLines.length * COMMENT_LINE_HEIGHT : 0) + (annotationLines.length ? 10 + annotationLines.length * COMMENT_LINE_HEIGHT : 0);
    const top = y + (height - contentHeight + markerHeight(flow)) / 2;
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
    else outline = `<rect x="${x + 1}" y="${y + 1}" width="${NODE_WIDTH - 2}" height="${height - 2}"/>${shape === "subprocess" ? `<path d="M ${x + 12} ${y + 1} V ${y + height - 1} M ${x + NODE_WIDTH - 12} ${y + 1} V ${y + height - 1}" fill="none" stroke="${esc(palette.subprocessStroke)}" stroke-width="1.6"/>` : ""}`;
    const loopMarker = isLoop ? `<g class="loop-marker"><rect x="${x + NODE_WIDTH / 2 - 22}" y="${y + 7}" width="44" height="16" rx="8"/><text x="${x + NODE_WIDTH / 2}" y="${y + 18}" text-anchor="middle">LOOP</text></g>` : "";
    const flagMarker = visual.flagged ? `<g class="flag-marker"><rect x="${x + NODE_WIDTH - 55}" y="${y + 7}" width="44" height="16" rx="8"/><text x="${x + NODE_WIDTH - 33}" y="${y + 18}" text-anchor="middle">FLAG</text></g>` : "";
    const stateClass = `${visual.unmodified ? " node-unmodified" : ""}${visual.flagged ? " node-flagged" : ""}`;
    const stateTitle = `${visual.flagged ? " · Flagged for removal" : ""}${visual.unmodified ? " · Unmodified label" : ""}`;
    return `<g class="node node-${shape}${isLoop ? " node-loop" : ""}${stateClass}"><title>Line ${flow.line}${stateTitle}</title>${outline}${loopMarker}${flagMarker}${labelMarkup}${commentsMarkup}${annotationMarkup}</g>`;
  }).join("");
  const labelFont = mode === "natural" ? "500 16px system-ui,sans-serif" : "500 12px ui-monospace,monospace";
  const shapeStyle = ([
    ["process", palette.processFill, palette.processStroke], ["decision", palette.decisionFill, palette.decisionStroke],
    ["io", palette.ioFill, palette.ioStroke], ["terminator", palette.terminatorFill, palette.terminatorStroke],
    ["subprocess", palette.subprocessFill, palette.subprocessStroke],
  ] as const).map(([shape, fill, stroke]) => {
    return `.node-${shape}>rect,.node-${shape}>polygon,.node-${shape}>ellipse{fill:${esc(fill)};stroke:${esc(stroke)};stroke-width:1.6}.node-${shape} .loop-marker rect{fill:${esc(fill)};stroke:${esc(stroke)}}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX - minX}" height="${maxY - minY}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${esc(palette.edge)}"/></marker><style>.edge{fill:none;stroke:${esc(palette.edge)};stroke-width:1.8}.edge-label{font:600 11px system-ui;fill:${esc(palette.text)};paint-order:stroke;stroke:${esc(palette.edgeLabelBackground)};stroke-width:5px}${shapeStyle}.node-loop>rect,.node-loop>polygon,.node-loop>ellipse{stroke-width:2.2}.node-unmodified>rect,.node-unmodified>polygon,.node-unmodified>ellipse{stroke-dasharray:7 4}.loop-marker rect{stroke-width:1}.loop-marker text{font:700 9px system-ui;letter-spacing:.7px;fill:${esc(palette.text)}}.flag-marker rect{fill:${esc(palette.terminatorFill)};stroke:${esc(palette.terminatorStroke)};stroke-width:1}.flag-marker text{font:700 9px system-ui;letter-spacing:.7px;fill:${esc(palette.text)}}.label{font:${labelFont};fill:${esc(palette.text)}}.comment,.annotation{font:11px system-ui;fill:${esc(palette.muted)}}.comment{font-style:italic}</style></defs><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${esc(palette.background)}"/>${edgeMarkup}${nodeMarkup}</svg>`;
}

/** Render exported SVG through browser canvas without changing graph geometry. */
export async function createPngDataUrl(svg: string, scale = 2): Promise<string> {
  const width = Number(/\bwidth="([\d.]+)"/.exec(svg)?.[1]);
  const height = Number(/\bheight="([\d.]+)"/.exec(svg)?.[1]);
  if (!svg || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || !Number.isFinite(scale) || scale <= 0) {
    throw new Error("Cannot export an invalid SVG as PNG.");
  }
  const pixelWidth = Math.ceil(width * scale), pixelHeight = Math.ceil(height * scale);
  if (pixelWidth > 16384 || pixelHeight > 16384 || pixelWidth * pixelHeight > 32_000_000) {
    throw new Error("PNG export exceeds the 32 megapixel canvas limit.");
  }
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Browser could not render the flowchart SVG."));
      image.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Browser canvas is unavailable.");
    context.drawImage(image, 0, 0, pixelWidth, pixelHeight);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}
