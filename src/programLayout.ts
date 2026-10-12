import type { Edge } from "@xyflow/react";
import type { SvgPalette } from "./exportSvg";
import type { CanvasEdge, CanvasNode } from "./layout";
import { NODE_WIDTH, nodeHeight } from "./layout";
import type { FunctionInfo } from "./types";

export type ProgramReference = { source: string; target: string; label: string; start_byte?: number; end_byte?: number };
export type ProgramPosition = { x: number; y: number };
export type ProgramGroupLayout = { id: string; info: FunctionInfo; width: number; height: number; position?: ProgramPosition };
export type ProgramDiagram = ProgramGroupLayout & { nodes: CanvasNode[]; edges: CanvasEdge[]; error?: string };
export type ProgramCallEdge = { id: string; source: string; target: string; label: string; sourceGroup: string; targetGroup: string };

export function programGroupId(info: FunctionInfo): string { return `program:${info.id}`; }
export function isProgramEntry(info: FunctionInfo): boolean { return info.name === "main" || info.name === "Main" || info.id === "cs:top"; }

export function namespaceProgramDiagram(groupId: string, nodes: CanvasNode[], edges: CanvasEdge[]): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const prefix = `${groupId}/`;
  return {
    nodes: nodes.map((node) => ({ ...node, id: prefix + node.id })),
    edges: edges.map((edge) => ({ ...edge, id: prefix + edge.id, source: prefix + edge.source, target: prefix + edge.target })),
  };
}

/** Main first, then shelf rows sized from actual diagrams. Explicit positions remain untouched. */
export function arrangeProgramGroups(groups: ProgramGroupLayout[], gap = 72, maxRowWidth = 1800, calls: ProgramCallEdge[] = []): Record<string, ProgramPosition> {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const outgoing = new Map<string, string[]>();
  for (const call of calls) if (byId.has(call.sourceGroup) && byId.has(call.targetGroup)) outgoing.set(call.sourceGroup, [...(outgoing.get(call.sourceGroup) ?? []), call.targetGroup]);
  const ranked: ProgramGroupLayout[] = [], visited = new Set<string>();
  const queue = groups.filter((group) => isProgramEntry(group.info)).sort((a, b) => a.info.line - b.info.line);
  while (queue.length) {
    const group = queue.shift()!;
    if (visited.has(group.id)) continue;
    visited.add(group.id); ranked.push(group);
    const targets = [...new Set(outgoing.get(group.id) ?? [])].map((id) => byId.get(id)!).filter(Boolean).sort((a, b) => a.info.line - b.info.line);
    queue.push(...targets);
  }
  const ordered = [...ranked, ...groups.filter((group) => !visited.has(group.id)).sort((a, b) => a.info.line - b.info.line)];
  const output: Record<string, ProgramPosition> = {};
  const placed = groups.filter((group) => group.position).map((group) => ({ group, position: group.position! }));
  for (const { group, position } of placed) output[group.id] = position;
  let x = 0, y = 0;
  for (const group of ordered) {
    if (group.position) continue;
    for (;;) {
      if (x > 0 && x + group.width > maxRowWidth) {
        x = 0;
        y = Math.max(y + gap, ...placed.map((item) => item.position.y + item.group.height + gap));
      }
      const collision = placed.find((item) => x < item.position.x + item.group.width + gap && x + group.width + gap > item.position.x && y < item.position.y + item.group.height + gap && y + group.height + gap > item.position.y);
      if (!collision) break;
      x = collision.position.x + collision.group.width + gap;
    }
    output[group.id] = { x, y };
    placed.push({ group, position: output[group.id] });
    x += group.width + gap;
  }
  return output;
}

function exactFunction(groups: ProgramDiagram[], value: string): ProgramDiagram | undefined {
  const candidates = groups.filter((group) => [group.info.id, group.info.identity, group.info.qualified_name, group.info.name].includes(value));
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Resolve only analyzer references. Never infer call targets from source text. */
export function buildProgramCallEdges(references: ProgramReference[], groups: ProgramDiagram[]): ProgramCallEdge[] {
  const output: ProgramCallEdge[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const source = exactFunction(groups, reference.source), target = exactFunction(groups, reference.target);
    if (!source || !target) continue;
    const hasRange = Number.isFinite(reference.start_byte) && Number.isFinite(reference.end_byte) && reference.end_byte! >= reference.start_byte!;
    const containing = hasRange ? source.nodes.filter((node) => node.data.flow.start_byte <= reference.start_byte! && node.data.flow.end_byte >= reference.end_byte!).sort((a, b) => (a.data.flow.end_byte - a.data.flow.start_byte) - (b.data.flow.end_byte - b.data.flow.start_byte)) : [];
    const sourceNode = containing.length && (containing.length === 1 || containing[0].data.flow.end_byte - containing[0].data.flow.start_byte < containing[1].data.flow.end_byte - containing[1].data.flow.start_byte) ? containing[0] : undefined;
    const sourceId = sourceNode ? `${source.id}/${sourceNode.id}` : source.id;
    const targetStart = target.nodes.find((node) => node.data.flow.kind === "start") ?? target.nodes[0];
    const targetId = targetStart ? `${target.id}/${targetStart.id}` : target.id;
    const key = JSON.stringify([sourceId, targetId, reference.label]);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ id: `program-call-${output.length}`, source: sourceId, target: targetId, label: `calls ${reference.label || target.info.name}`, sourceGroup: source.id, targetGroup: target.id });
  }
  return output;
}

export function programBounds(nodes: CanvasNode[]): { width: number; height: number } {
  if (!nodes.length) return { width: 360, height: 190 };
  return { width: Math.max(...nodes.map((node) => node.position.x + NODE_WIDTH)) + 36, height: Math.max(...nodes.map((node) => node.position.y + nodeHeight(node.data.flow))) + 78 };
}

const escapeXml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character]!));

export function composeProgramSvg(groups: ProgramDiagram[], calls: ProgramCallEdge[], positions: Record<string, ProgramPosition>, palette: SvgPalette, renderDiagram: (nodes: CanvasNode[], edges: Edge[], palette: SvgPalette) => string): string {
  if (!groups.length || groups.some((group) => group.error)) return "";
  const padding = 48;
  const minX = Math.min(...groups.map((group) => positions[group.id]?.x ?? 0)) - padding;
  const minY = Math.min(...groups.map((group) => positions[group.id]?.y ?? 0)) - padding;
  const maxX = Math.max(...groups.map((group) => (positions[group.id]?.x ?? 0) + group.width)) + padding;
  const maxY = Math.max(...groups.map((group) => (positions[group.id]?.y ?? 0) + group.height)) + padding;
  const byId = new Map(groups.map((group) => [group.id, group]));
  const links = calls.map((call) => {
    const source = byId.get(call.sourceGroup), target = byId.get(call.targetGroup);
    if (!source || !target) return "";
    const a = positions[source.id] ?? { x: 0, y: 0 }, b = positions[target.id] ?? { x: 0, y: 0 };
    const sourceNodeId = call.source.startsWith(`${source.id}/`) ? call.source.slice(source.id.length + 1) : "";
    const targetNodeId = call.target.startsWith(`${target.id}/`) ? call.target.slice(target.id.length + 1) : "";
    const sourceNode = source.nodes.find((node) => node.id === sourceNodeId), targetNode = target.nodes.find((node) => node.id === targetNodeId);
    const x1 = sourceNode ? a.x + 18 + sourceNode.position.x + NODE_WIDTH : a.x + source.width;
    const y1 = sourceNode ? a.y + 56 + sourceNode.position.y + nodeHeight(sourceNode.data.flow) / 2 : a.y + source.height / 2;
    const x2 = targetNode ? b.x + 18 + targetNode.position.x : b.x;
    const y2 = targetNode ? b.y + 56 + targetNode.position.y + nodeHeight(targetNode.data.flow) / 2 : b.y + target.height / 2;
    const bend = Math.max(42, Math.abs(x2 - x1) / 2);
    return `<path d="M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}" class="call" marker-end="url(#program-call-arrow)"/><text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 8}" text-anchor="middle" class="call-label">${escapeXml(call.label)}</text>`;
  }).join("");
  const charts = groups.map((group, index) => {
    const position = positions[group.id] ?? { x: 0, y: 0 };
    const svg = renderDiagram(group.nodes, group.edges, palette);
    const opening = /^<svg\b([^>]*)>/i.exec(svg), viewBox = opening?.[1].match(/\bviewBox="([^"]+)"/i)?.[1];
    const inner = opening && viewBox ? svg.slice(opening[0].length).replace(/<\/svg>\s*$/i, "").replace(/(<\/defs>)<rect\b[^>]*\/>/, "$1").replaceAll('id="arrow"', `id="program-arrow-${index}"`).replaceAll("url(#arrow)", `url(#program-arrow-${index})`) : "";
    const box = viewBox?.split(/\s+/).map(Number);
    const chart = inner && box?.length === 4 && box.every(Number.isFinite) ? `<svg x="${position.x + 18 + box[0]}" y="${position.y + 56 + box[1]}" width="${box[2]}" height="${box[3]}" viewBox="${escapeXml(viewBox!)}">${inner}</svg>` : "";
    const badge = isProgramEntry(group.info) ? `<text x="${position.x + group.width - 18}" y="${position.y + 29}" text-anchor="end" class="badge">ENTRY</text>` : "";
    return `<g><rect x="${position.x}" y="${position.y}" width="${group.width}" height="${group.height}" rx="14" class="group"/><text x="${position.x + 16}" y="${position.y + 23}" class="title">${escapeXml(group.info.name)}</text><text x="${position.x + 16}" y="${position.y + 41}" class="path">Line ${group.info.line}</text>${badge}${chart}</g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX - minX}" height="${maxY - minY}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}"><defs><marker id="program-call-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${escapeXml(palette.edge)}"/></marker><style>.group{fill:${escapeXml(palette.edgeLabelBackground)};stroke:${escapeXml(palette.processStroke)};stroke-width:1.5}.title{font:700 14px system-ui;fill:${escapeXml(palette.text)}}.path{font:10px system-ui;fill:${escapeXml(palette.muted)}}.badge{font:800 9px system-ui;fill:${escapeXml(palette.terminatorStroke)}}.call{fill:none;stroke:${escapeXml(palette.edge)};stroke-width:1.6;stroke-dasharray:8 6}.call-label{font:650 10px system-ui;fill:${escapeXml(palette.text)};paint-order:stroke;stroke:${escapeXml(palette.background)};stroke-width:5px}</style></defs><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${escapeXml(palette.background)}"/>${charts}${links}</svg>`;
}
