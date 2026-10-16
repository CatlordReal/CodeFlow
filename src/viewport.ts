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
