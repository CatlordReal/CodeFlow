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
// Search the orthogonal visibility grid only when the simple routes collide.
// Coordinates outside each obstacle provide clearance and allow multiple turns.
function detour(a: RoutePoint, b: RoutePoint, bounds: RouteBounds[]): RoutePoint[] | null {
  const xs = [...new Set([a.x, b.x, ...bounds.flatMap(box => [box.x - 24, box.x, box.x + box.width, box.x + box.width + 24])])].sort((x, y) => x - y);
  const ys = [...new Set([a.y, b.y, ...bounds.flatMap(box => [box.y - 24, box.y, box.y + box.height, box.y + box.height + 24])])].sort((x, y) => x - y);
  const width = xs.length, start = ys.indexOf(a.y) * width + xs.indexOf(a.x), goal = ys.indexOf(b.y) * width + xs.indexOf(b.x);
  const point = (id: number): RoutePoint => ({ x: xs[id % width], y: ys[Math.floor(id / width)] });
  const inside = (p: RoutePoint) => bounds.some(box => p.x > box.x && p.x < box.x + box.width && p.y > box.y && p.y < box.y + box.height);
  if (inside(a) || inside(b)) return null;
  type Entry = { id: number; cost: number; priority: number };
  const heap: Entry[] = [];
  const push = (entry: Entry) => {
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) { const parent = Math.floor((i - 1) / 2); if (heap[parent].priority <= entry.priority) break; heap[i] = heap[parent]; i = parent; }
    heap[i] = entry;
  };
  const pop = (): Entry => {
    const first = heap[0], last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].priority < heap[child].priority) child++;
        if (heap[child].priority >= last.priority) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  const costs = new Map<number, number>([[start, 0]]), previous = new Map<number, number>();
  push({ id: start, cost: 0, priority: Math.abs(a.x - b.x) + Math.abs(a.y - b.y) });
  while (heap.length) {
    const current = pop();
    if (current.cost !== costs.get(current.id)) continue;
    if (current.id === goal) {
      const path: RoutePoint[] = [];
      for (let id = goal;; id = previous.get(id)!) { path.push(point(id)); if (id === start) break; }
      return path.reverse();
    }
    const x = current.id % width, y = Math.floor(current.id / width), from = point(current.id);
    const neighbors = [x > 0 ? current.id - 1 : -1, x + 1 < width ? current.id + 1 : -1, y > 0 ? current.id - width : -1, y + 1 < ys.length ? current.id + width : -1];
    for (const id of neighbors) {
      if (id < 0) continue;
      const to = point(id);
      if (bounds.some(box => segmentHits(from, to, box))) continue;
      const cost = current.cost + Math.abs(from.x - to.x) + Math.abs(from.y - to.y);
      if (cost >= (costs.get(id) ?? Infinity)) continue;
      costs.set(id, cost); previous.set(id, current.id);
      push({ id, cost, priority: cost + Math.abs(to.x - b.x) + Math.abs(to.y - b.y) });
    }
  }
  return null;
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
    return { hits, length, bends: points.length };
  };
  const compare = (left: ReturnType<typeof score>, right: ReturnType<typeof score>) => left.hits - right.hits || left.length - right.length || left.bends - right.bends;
  const best = paths.map(points => ({ points, score: score(points) })).sort((left, right) => compare(left.score, right.score))[0];
  if (best.score.hits > 0) {
    const alternate = detour(a, b, bounds);
    if (alternate) {
      const points = clean([start, ...alternate, end]);
      if (compare(score(points), best.score) < 0) return points;
    }
  }
  return best.points;
}

/** Apply saved positions and reroute edges affected by moved endpoints or obstacles. */
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
    const obstaclesOnRoute = movedObstacles.filter(obstacle => obstacle.id !== edge.source && obstacle.id !== edge.target && data.points.some((point, i) => i > 0 && segmentHits(data.points[i - 1], point, obstacle.bounds)));
    // Remember obstacles that forced a detour so moving them away reshapes the edge too.
    const routingObstacles = new Set([...(data.routingObstacles ?? []), ...obstaclesOnRoute.map(obstacle => obstacle.id)]);
    const obstacleMoved = movedObstacles.some(obstacle => routingObstacles.has(obstacle.id));
    const needsRoute = moved(source.position, data.sourceOrigin) || moved(target.position, data.targetOrigin) || obstacleMoved;
    const points = needsRoute ? route(source, target, side(edge.sourceHandle, 's'), side(edge.targetHandle, 'n'), bounds) : data.points;
    const label = displayLabels.get(edge.id) ?? String(edge.label ?? '');
    const labelPosition = routeLabelPosition(points, label, bounds, occupiedLabels);
    if (label.trim()) occupiedLabels.push(routeLabelBounds(labelPosition, label));
    if (!needsRoute && labelPosition.x === data.labelPosition.x && labelPosition.y === data.labelPosition.y) return edge;
    return { ...edge, data: { ...data, points, labelPosition, sourceOrigin: { ...source.position }, targetOrigin: { ...target.position }, routingObstacles: [...routingObstacles] } };
  }) };
}
