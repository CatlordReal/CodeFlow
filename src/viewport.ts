export type FunctionViewportState = {
  source: string;
  functionId: string;
  loopDepth: number | null;
  loopOverrides: Record<string, boolean>;
  hiddenNodeIds: string[];
  showHiddenNodes: boolean;
};

export function functionViewportFitKey({
  source,
  functionId,
  loopDepth,
  loopOverrides,
}: FunctionViewportState): string {
  return source + "\0" + functionId + "\0" + JSON.stringify([loopDepth, loopOverrides]);
}

type Bounds = { left: number; top: number; width: number; height: number };

/** Center a point in the visible area to the left of an overlapping editor. */
export function editorAwareCenter(
  point: { x: number; y: number }, canvasBounds: Bounds, editorBounds: Bounds | null, zoom: number,
): { x: number; y: number } {
  const x = Number.isFinite(point.x) ? point.x : 0;
  const y = Number.isFinite(point.y) ? point.y : 0;
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const valid = (bounds: Bounds) => [bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)
    && bounds.width > 0 && bounds.height > 0;
  if (!valid(canvasBounds) || !editorBounds || !valid(editorBounds)) return { x, y };
  const canvasRight = canvasBounds.left + canvasBounds.width;
  const canvasBottom = canvasBounds.top + canvasBounds.height;
  const editorRight = editorBounds.left + editorBounds.width;
  const editorBottom = editorBounds.top + editorBounds.height;
  if (editorBounds.left >= canvasRight || editorRight <= canvasBounds.left
    || editorBounds.top >= canvasBottom || editorBottom <= canvasBounds.top) return { x, y };
  const freeWidth = Math.max(0, Math.min(canvasBounds.width, editorBounds.left - canvasBounds.left));
  if (freeWidth < 64) return { x, y };
  return { x: x + (canvasBounds.width - freeWidth) / (2 * scale), y };
}
