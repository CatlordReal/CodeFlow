import type { CanvasEdge, CanvasNode, RouteBounds, RoutePoint } from './layout';
import { NODE_WIDTH, nodeHeight, routeLabelBounds, routeLabelPosition } from './layout';
import { flowShape } from './simplify';

export type AlignmentGuide = { axis: 'x' | 'y'; value: number; from: number; to: number };

function size(node: CanvasNode) {
  return { width: node.width ?? NODE_WIDTH, height: node.height ?? nodeHeight(node.data.flow) };
}

/** Snap corresponding edges or centers within seven screen pixels. */
export function snapBoxPosition(nodes: readonly CanvasNode[], movingId: string, position: RoutePoint, zoom: number, bypass = false): { position: RoutePoint; guides: AlignmentGuide[] } {
  const moving = nodes.find(node => node.id === movingId);
  if (!moving || bypass) return { position: { ...position }, guides: [] };
  const dimensions = size(moving), threshold = 7 / (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  const result = { ...position }, guides: AlignmentGuide[] = [];
  for (const axis of ['x', 'y'] as const) {
    const dimension = axis === 'x' ? 'width' : 'height';
    const otherAxis = axis === 'x' ? 'y' : 'x';
    const otherDimension = axis === 'x' ? 'height' : 'width';
    const candidates: { delta: number; value: number; from: number; to: number; id: string; anchor: number; targetAnchor: number }[] = [];
    for (const node of nodes) {
      if (node.id === movingId) continue;
      const target = node.data.flow.position ?? node.position, targetSize = size(node);
      for (const anchor of [0, 0.5, 1]) for (const targetAnchor of [0, 0.5, 1]) {
        const value = target[axis] + targetSize[dimension] * targetAnchor;
        const delta = value - (position[axis] + dimensions[dimension] * anchor);
        if (Math.abs(delta) <= threshold) candidates.push({ delta, value, from: Math.min(position[otherAxis], target[otherAxis]), to: Math.max(position[otherAxis] + dimensions[otherDimension], target[otherAxis] + targetSize[otherDimension]), id: node.id, anchor, targetAnchor });
      }
    }
    candidates.sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta) || Number(a.anchor !== a.targetAnchor) - Number(b.anchor !== b.targetAnchor) || a.id.localeCompare(b.id) || a.anchor - b.anchor || a.targetAnchor - b.targetAnchor);
    const best = candidates[0];
    if (best) { result[axis] += best.delta; guides.push({ axis, value: best.value, from: best.from, to: best.to }); }
  }
  return { position: result, guides };
}

type Side = 'n' | 's' | 'e' | 'w';
const vectors: Record<Side, RoutePoint> = { n: {x: 0, y: -1}, s: {x: 0, y: 1}, e: {x: 1, y: 0}, w: {x: -1, y: 0} };
function side(handle: string | null | undefined, fallback: Side): Side {
  const value = handle?.split('-').pop();
  return value === 'n' || value === 's' || value === 'e' || value === 'w' ? value : fallback;
}
function port(node: CanvasNode, direction: Side): RoutePoint {
  const { width, height } = size(node), { x, y } = node.position;
  const inset = flowShape(node.data.flow) === 'io' ? 12 : 0;
  return direction === 'n' ? {x: x + width / 2, y} : direction === 's' ? {x: x + width / 2, y: y + height} : direction === 'e' ? {x: x + width - inset, y: y + height / 2} : {x: x + inset, y: y + height / 2};
}
function segmentHits(a: RoutePoint, b: RoutePoint, box: RouteBounds): boolean {
  if (a.x === b.x) return a.x > box.x && a.x < box.x + box.width && Math.max(a.y, b.y) > box.y && Math.min(a.y, b.y) < box.y + box.height;
  if (a.y === b.y) return a.y > box.y && a.y < box.y + box.height && Math.max(a.x, b.x) > box.x && Math.min(a.x, b.x) < box.x + box.width;
  return true;
}
function clean(points: RoutePoint[]): RoutePoint[] {
  return points.filter((p, i) => !i || p.x !== points[i-1].x || p.y !== points[i-1].y).filter((p, i, all) => i === 0 || i === all.length - 1 || !((all[i-1].x === p.x && p.x === all[i+1].x && (p.y - all[i-1].y) * (all[i+1].y - p.y) >= 0) || (all[i-1].y === p.y && p.y === all[i+1].y && (p.x - all[i-1].x) * (all[i+1].x - p.x) >= 0)));
}
function route(source: CanvasNode, target: CanvasNode, sourceSide: Side, targetSide: Side, bounds: RouteBounds[]): RoutePoint[] {
  const start = port(source, sourceSide), end = port(target, targetSide), distance = 24;
  const a = {x: start.x + vectors[sourceSide].x * distance, y: start.y + vectors[sourceSide].y * distance};
  const b = {x: end.x + vectors[targetSide].x * distance, y: end.y + vectors[targetSide].y * distance};
  const xs = [(a.x + b.x) / 2, ...bounds.flatMap(box => [box.x - 24, box.x + box.width + 24])];
  const ys = [(a.y + b.y) / 2, ...bounds.flatMap(box => [box.y - 24, box.y + box.height + 24])];
  const paths = [
    [start, a, {x: b.x, y: a.y}, b, end],
    [start, a, {x: a.x, y: b.y}, b, end],
    ...xs.map(x => [start, a, {x, y: a.y}, {x, y: b.y}, b, end]),
    ...ys.map(y => [start, a, {x: a.x, y}, {x: b.x, y}, b, end]),
  ].map(clean);
  const score = (points: RoutePoint[]) => {
    let hits = 0, length = 0;
    for (let i = 1; i < points.length; i++) {
      length += Math.abs(points[i].x - points[i-1].x) + Math.abs(points[i].y - points[i-1].y);
      for (const box of bounds) if (segmentHits(points[i-1], points[i], box)) hits++;
    }
    return hits * 1_000_000 + length + points.length * 10;
  };
  return paths.map(points => ({ points, score: score(points) })).sort((left, right) => left.score - right.score)[0].points;
}

/** Apply saved positions and reroute only edges whose endpoints moved. */
export function positionedCanvas(nodes: readonly CanvasNode[], edges: readonly CanvasEdge[], displayLabels: ReadonlyMap<string, string> = new Map(), movedNodeIds: ReadonlySet<string> = new Set()): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const positioned = nodes.map(node => ({ ...node, position: node.data.flow.position ?? node.position }));
  const byId = new Map(positioned.map(node => [node.id, node]));
  const bounds = positioned.map(node => ({ ...node.position, ...size(node) }));
  const moved = (position: RoutePoint, origin: RoutePoint) => position.x !== origin.x || position.y !== origin.y;
  const movedObstacles = positioned.filter((node, i) => movedNodeIds.has(node.id) || moved(node.position, nodes[i].position)).map(node => ({ id: node.id, bounds: { ...node.position, ...size(node) } }));
  const occupiedLabels: RouteBounds[] = [];
  return { nodes: positioned, edges: edges.map(edge => {
    const source = byId.get(edge.source), target = byId.get(edge.target), data = edge.data;
    if (!source || !target || !data) return edge;
    const obstructed = movedObstacles.some(obstacle => obstacle.id !== edge.source && obstacle.id !== edge.target && data.points.some((point, i) => i > 0 && segmentHits(data.points[i - 1], point, obstacle.bounds)));
    const needsRoute = moved(source.position, data.sourceOrigin) || moved(target.position, data.targetOrigin) || obstructed;
    const points = needsRoute ? route(source, target, side(edge.sourceHandle, 's'), side(edge.targetHandle, 'n'), bounds) : data.points;
    const label = displayLabels.get(edge.id) ?? String(edge.label ?? '');
    const labelPosition = routeLabelPosition(points, label, bounds, occupiedLabels);
    if (label.trim()) occupiedLabels.push(routeLabelBounds(labelPosition, label));
    if (!needsRoute && labelPosition.x === data.labelPosition.x && labelPosition.y === data.labelPosition.y) return edge;
    return { ...edge, data: { ...data, points, labelPosition, sourceOrigin: { ...source.position }, targetOrigin: { ...target.position } } };
  }) };
}
