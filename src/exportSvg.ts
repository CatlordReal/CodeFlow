import type { Edge } from "@xyflow/react";
import type { CanvasNode, FlowEdgeData, RoutePoint } from "./layout";
import { NODE_WIDTH, nodeHeight, routeLabelBounds, routePath } from "./layout";
import { COMMENT_LINE_HEIGHT, LABEL_LINE_HEIGHT, LOOP_BADGE_HEIGHT, LOOP_BADGE_WIDTH, LOOP_ICON_PATH, loopBadgeTop, nodeTextLayout, nodeContentOffset } from "./textLayout";
import { flowShape } from "./simplify";
import type { FlowEdge } from "./types";
import type { AppTheme } from "./themes";

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

/** Resolve export colors without changing the active application theme. */
export function svgPaletteFromTheme(theme: AppTheme): SvgPalette {
  return {
    background: theme.colors.bg,
    edgeLabelBackground: theme.colors.panel,
    text: theme.colors.text,
    muted: theme.colors.muted,
    edge: theme.colors.lineStrong,
    ...theme.diagram,
  };
}

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
  const labelPosition = (edge: Edge | FlowEdge, points: RoutePoint[]): RoutePoint => {
    const data = "data" in edge ? edge.data as FlowEdgeData | undefined : undefined;
    const next = points[1] ?? points[0];
    return data?.labelPosition ?? { x: (points[0].x + next.x) / 2 + 18, y: (points[0].y + next.y) / 2 };
  };
  const labelBounds = routes.flatMap(({edge,points}) => typeof edge.label === "string" && edge.label.trim() && points.length >= 2 ? [routeLabelBounds(labelPosition(edge,points),edge.label)] : []);
  const allPoints = [...routes.flatMap(({ points }) => points), ...labelBounds.flatMap(bounds => [{x:bounds.x,y:bounds.y},{x:bounds.x+bounds.width,y:bounds.y+bounds.height}])];
  const minX = Math.min(...nodes.map((node) => node.position.x), ...allPoints.map((point) => point.x)) - 48;
  const minY = Math.min(...nodes.map((node) => node.position.y), ...allPoints.map((point) => point.y)) - 48;
  const maxX = Math.max(...nodes.map((node) => node.position.x + NODE_WIDTH), ...allPoints.map((point) => point.x)) + 48;
  const maxY = Math.max(...nodes.map((node) => node.position.y + nodeHeight(node.data.flow)), ...allPoints.map((point) => point.y)) + 48;
  const edgeMarkup = routes.map(({ edge, points }) => {
    if (!points.length) return "";
    const labelAt = labelPosition(edge,points);
    const label = typeof edge.label === "string" && edge.label.trim() ? `<g class="cf-edge-label"><text x="${labelAt.x}" y="${labelAt.y + 4}" text-anchor="middle" class="cf-edge-label-halo">${esc(edge.label)}</text><text x="${labelAt.x}" y="${labelAt.y + 4}" text-anchor="middle" class="cf-edge-label-text">${esc(edge.label)}</text></g>` : "";
    return `<path d="${routePath(points)}" class="cf-edge" marker-end="url(#arrow)"/>${label}`;
  }).join("");
  const nodeMarkup = nodes.map((node) => {
    const flow = node.data.flow, height = nodeHeight(flow), shape = flowShape(flow);
    const isLoop = flow.kind === "loop" || flow.loop_collapsed === true;
    const { x, y } = node.position;
    const { labelLines, commentLines, annotationLines } = nodeTextLayout(flow);
    const contentHeight = labelLines.length * LABEL_LINE_HEIGHT + (commentLines.length ? 10 + commentLines.length * COMMENT_LINE_HEIGHT : 0) + (annotationLines.length ? 10 + annotationLines.length * COMMENT_LINE_HEIGHT : 0);
    const top = y + (height - contentHeight) / 2 + nodeContentOffset({ ...flow, flagged: false, flaggedForUpdate: false });
    const text = (lines: string[], start: number, lineHeight: number, className: string) => lines.map((line, index) => `<text x="${x + NODE_WIDTH / 2}" y="${start + index * lineHeight + lineHeight * 0.76}" text-anchor="middle" class="${className}">${esc(line)}</text>`).join("");
    const labelMarkup = text(labelLines, top, LABEL_LINE_HEIGHT, "cf-label");
    const commentsTop = top + labelLines.length * LABEL_LINE_HEIGHT + 10;
    const commentsMarkup = text(commentLines, commentsTop, COMMENT_LINE_HEIGHT, "cf-comment");
    const annotationTop = top + labelLines.length * LABEL_LINE_HEIGHT + (commentLines.length ? commentLines.length * COMMENT_LINE_HEIGHT + 10 : 0) + 10;
    const annotationMarkup = text(annotationLines, annotationTop, COMMENT_LINE_HEIGHT, "cf-annotation");
    let outline: string;
    if (shape === "decision") outline = `<polygon points="${x + NODE_WIDTH / 2},${y + 1} ${x + NODE_WIDTH - 1},${y + height / 2} ${x + NODE_WIDTH / 2},${y + height - 1} ${x + 1},${y + height / 2}"/>`;
    else if (shape === "io") outline = `<polygon points="${x + 24},${y + 1} ${x + NODE_WIDTH - 1},${y + 1} ${x + NODE_WIDTH - 24},${y + height - 1} ${x + 1},${y + height - 1}"/>`;
    else if (shape === "terminator") outline = `<ellipse cx="${x + NODE_WIDTH / 2}" cy="${y + height / 2}" rx="${NODE_WIDTH / 2 - 1}" ry="${height / 2 - 1}"/>`;
    else outline = `<rect x="${x + 1}" y="${y + 1}" width="${NODE_WIDTH - 2}" height="${height - 2}"/>${shape === "subprocess" ? `<path d="M ${x + 12} ${y + 1} V ${y + height - 1} M ${x + NODE_WIDTH - 12} ${y + 1} V ${y + height - 1}" fill="none" stroke="${esc(palette.subprocessStroke)}" stroke-width="1.6"/>` : ""}`;
    const badgeX = x + (NODE_WIDTH - LOOP_BADGE_WIDTH) / 2, badgeY = y + loopBadgeTop(flow);
    const loopMarker = isLoop ? `<g class="cf-loop-marker"><rect x="${badgeX}" y="${badgeY}" width="${LOOP_BADGE_WIDTH}" height="${LOOP_BADGE_HEIGHT}" rx="8"/><path d="${LOOP_ICON_PATH}" transform="translate(${badgeX + 11} ${badgeY + 3})"/><text x="${badgeX + 24}" y="${badgeY + 12}">LOOP</text></g>` : "";
    const stateClass = flow.unmodified ? " cf-node-unmodified" : "";
    const stateTitle = flow.unmodified ? " · Unmodified label" : "";
    return `<g class="cf-node cf-node-${shape}${isLoop ? " cf-node-loop" : ""}${stateClass}"><title>Line ${flow.line}${stateTitle}</title>${outline}${loopMarker}${labelMarkup}${commentsMarkup}${annotationMarkup}</g>`;
  }).join("");
  const labelFont = mode === "natural" ? "500 16px system-ui,sans-serif" : "500 12px ui-monospace,monospace";
  const shapeStyle = ([
    ["process", palette.processFill, palette.processStroke], ["decision", palette.decisionFill, palette.decisionStroke],
    ["io", palette.ioFill, palette.ioStroke], ["terminator", palette.terminatorFill, palette.terminatorStroke],
    ["subprocess", palette.subprocessFill, palette.subprocessStroke],
  ] as const).map(([shape, fill, stroke]) => {
    return `.cf-node-${shape}>rect,.cf-node-${shape}>polygon,.cf-node-${shape}>ellipse{fill:${esc(fill)};stroke:${esc(stroke)};stroke-width:1.6}.cf-node-${shape} .cf-loop-marker rect{fill:${esc(fill)};stroke:${esc(stroke)}}`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX - minX}" height="${maxY - minY}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${esc(palette.edge)}"/></marker><style>.cf-edge{fill:none;stroke:${esc(palette.edge)};stroke-width:1.8}.cf-edge-label{font:600 11px system-ui,sans-serif}.cf-edge-label-halo{fill:none;stroke:${esc(palette.edgeLabelBackground)};stroke-width:5px;stroke-linejoin:round}.cf-edge-label-text{fill:${esc(palette.text)};stroke:none}${shapeStyle}.cf-node-loop>rect,.cf-node-loop>polygon,.cf-node-loop>ellipse{stroke-width:2.2}.cf-node-unmodified>rect,.cf-node-unmodified>polygon,.cf-node-unmodified>ellipse{stroke-dasharray:7 4}.cf-loop-marker rect{stroke-width:1}.cf-loop-marker path{fill:none;stroke:${esc(palette.text)};stroke-width:1.3;stroke-linecap:round;stroke-linejoin:round}.cf-loop-marker text{font:700 9px system-ui;letter-spacing:.7px;fill:${esc(palette.text)}}.cf-label{font:${labelFont};fill:${esc(palette.text)}}.cf-comment,.cf-annotation{font:11px system-ui;fill:${esc(palette.muted)}}.cf-comment{font-style:italic}</style></defs><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${esc(palette.background)}"/>${edgeMarkup}${nodeMarkup}</svg>`;
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
