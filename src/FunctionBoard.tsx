import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  applyNodeChanges,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import { createSvgDocument, svgPaletteFromCss, type SvgPalette } from "./exportSvg";
import { layoutGraph, type CanvasEdge, type CanvasNode } from "./layout";
import {
  hideGraphNodes,
  nodePresentationKey,
  presentGraph,
  presentLoopEdgeLabels,
  type CaptionSets,
  type ChartEdits,
  type ChartMode,
  type LoopOverrides,
} from "./presentation";
import { overviewGraph, simplifyGraph } from "./simplify";
import type { FunctionInfo } from "./types";
import "./FunctionBoard.css";

export type FunctionPosition = { x: number; y: number };

export type FunctionBoardProps = {
  source: string;
  functions: FunctionInfo[];
  mode: ChartMode;
  includeComments: boolean;
  highlightUnmodified?:boolean;
  loopDepth: number | null;
  loopOverrides: LoopOverrides;
  edits: ChartEdits;
  captions: CaptionSets;
  hiddenBoxes: Record<string, string[]>;
  showHiddenBoxes: boolean;
  positions: Record<string, FunctionPosition>;
  onPositions: (positions: Record<string, FunctionPosition>) => void;
  onOpenFunction: (id: string) => void;
  onExportReady?: (svg: string) => void;
};

type FunctionReference = { source: string; target: string; label: string };
type FunctionDiagram = { nodes: CanvasNode[]; edges: CanvasEdge[]; diagnostics: string[] };
type FunctionResult = { state: "loading" } | { state: "error"; message: string } | ({ state: "ready" } & FunctionDiagram);

type FunctionCardData = Record<string, unknown> & {
  info: FunctionInfo;
  svg: string;
  status: FunctionResult["state"];
  error?: string;
  diagnostics: string[];
  onOpen: (id: string) => void;
};

type FunctionCardNode = Node<FunctionCardData, "functionCard">;

const CARD_WIDTH = 320;
const CARD_HEIGHT = 420;
const COLUMN_GAP = 56;
const ROW_GAP = 62;

function initialPosition(index: number): FunctionPosition {
  return {
    x: (index % 3) * (CARD_WIDTH + COLUMN_GAP),
    y: Math.floor(index / 3) * (CARD_HEIGHT + ROW_GAP),
  };
}

function FunctionCard({ data }: NodeProps<FunctionCardNode>) {
  return (
    <article className="function-board-card" aria-label={`${data.info.name} flowchart`}>
      <Handle id="call-in-left" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="call-in-right" type="target" position={Position.Right} isConnectable={false} />
      <Handle id="call-out-left" type="source" position={Position.Left} isConnectable={false} />
      <Handle id="call-out-right" type="source" position={Position.Right} isConnectable={false} />
      <Handle id="call-in-top" type="target" position={Position.Top} isConnectable={false} />
      <Handle id="call-in-bottom" type="target" position={Position.Bottom} isConnectable={false} />
      <Handle id="call-out-top" type="source" position={Position.Top} isConnectable={false} />
      <Handle id="call-out-bottom" type="source" position={Position.Bottom} isConnectable={false} />
      <header>
        <div>
          <strong>{data.info.name}</strong>
          <span>Line {data.info.line}</span>
        </div>
        <button className="function-board-card__detail nodrag nopan" type="button" onClick={() => data.onOpen(data.info.id)}>Detail</button>
      </header>
      <div className="function-board-card__chart">
        {data.status === "ready" && data.svg
          ? <div className="function-board-card__svg" aria-hidden="true" dangerouslySetInnerHTML={{ __html: data.svg }} />
          : data.status === "error"
            ? <div className="function-board-card__message function-board-card__message--error"><strong>Chart unavailable</strong><span>{data.error}</span></div>
            : <div className="function-board-card__message"><span className="function-board-card__spinner" /><span>Analyzing…</span></div>}
      </div>
      <footer>{data.status === "ready" ? `${data.diagnostics.length ? `${data.diagnostics.length} note${data.diagnostics.length === 1 ? "" : "s"}` : "Ready"}` : data.status === "error" ? "Unsupported function" : "Queued"}</footer>
    </article>
  );
}

const nodeTypes = { functionCard: FunctionCard };

export default function FunctionBoard(props: FunctionBoardProps) {
  const {
    source, functions, mode, includeComments, highlightUnmodified, loopDepth, loopOverrides, edits, captions,
    hiddenBoxes, showHiddenBoxes, positions, onPositions, onOpenFunction, onExportReady,
  } = props;
  const [results, setResults] = useState<Record<string, FunctionResult>>({});
  const [references, setReferences] = useState<FunctionReference[]>([]);
  const [referenceError, setReferenceError] = useState("");
  const [paletteVersion, setPaletteVersion] = useState(0);
  const [boardNodes, setBoardNodes] = useState<FunctionCardNode[]>([]);
  const analysisGeneration = useRef(0);
  const referenceGeneration = useRef(0);
  const activeAnalyses = useRef(0);
  const analysisWaiters = useRef<Array<() => void>>([]);
  const previousPersistedPositions = useRef(positions);

  const acquireAnalysisSlot = useCallback(async (): Promise<() => void> => {
    const createRelease = () => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeAnalyses.current -= 1;
        analysisWaiters.current.shift()?.();
      };
    };
    if (activeAnalyses.current < 4) {
      activeAnalyses.current += 1;
      return createRelease();
    }
    return new Promise<() => void>((resolve) => {
      analysisWaiters.current.push(() => {
        activeAnalyses.current += 1;
        resolve(createRelease());
      });
    });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setPaletteVersion((version) => version + 1));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const generation = ++analysisGeneration.current;
    setResults(Object.fromEntries(functions.map((item) => [item.id, { state: "loading" } satisfies FunctionResult])));
    let nextIndex = 0;
    const analyzeOne = async (info: FunctionInfo): Promise<FunctionResult> => {
      try {
        const parsed = simplifyGraph(await api.analyzeCpp(source, info.id, true));
        const overview = overviewGraph(parsed, { depth: loopDepth, overrides: loopOverrides[info.id] ?? {} });
        const visible = hideGraphNodes(overview, hiddenBoxes[info.id] ?? [], showHiddenBoxes);
        const presented = {
          ...visible,
          nodes: visible.nodes.map((node) => {
            const key = nodePresentationKey(info.id, node, loopDepth);
            const presented=presentGraph({ ...visible, nodes: [node], edges: [] }, mode, includeComments, edits[key], captions[key]).nodes[0];
            return {...presented,unmodified:mode==='natural'&&highlightUnmodified&&edits[key]?.[node.id]?.natural===undefined&&captions[key]?.[node.id]===undefined};
          }),
        };
        const laidOut = await layoutGraph(presented);
        const labels = new Map(presentLoopEdgeLabels(presented).edges.map((edge) => [edge.id, edge.label]));
        const edges = laidOut.edges.map((edge) => ({ ...edge, label: labels.get(edge.id) || undefined }));
        return { state: "ready", nodes: laidOut.nodes, edges, diagnostics: presented.diagnostics };
      } catch (cause) {
        return { state: "error", message: errorMessage(cause) };
      }
    };
    const worker = async () => {
      while (generation === analysisGeneration.current) {
        const index = nextIndex++;
        if (index >= functions.length) return;
        const info = functions[index];
        const release = await acquireAnalysisSlot();
        if (generation !== analysisGeneration.current) {
          release();
          return;
        }
        let result: FunctionResult;
        try {
          result = await analyzeOne(info);
        } finally {
          release();
        }
        if (generation !== analysisGeneration.current) return;
        setResults((current) => ({ ...current, [info.id]: result }));
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, functions.length) }, () => worker()));
    return () => { if (analysisGeneration.current === generation) analysisGeneration.current += 1; };
  }, [source, functions, mode, includeComments, highlightUnmodified, loopDepth, loopOverrides, edits, captions, hiddenBoxes, showHiddenBoxes,highlightUnmodified, acquireAnalysisSlot]);

  useEffect(() => {
    const generation = ++referenceGeneration.current;
    setReferences([]);
    setReferenceError("");
    void api.functionReferences(source).then((next) => {
      if (generation === referenceGeneration.current) setReferences(next);
    }).catch((cause) => {
      if (generation === referenceGeneration.current) setReferenceError(errorMessage(cause));
    });
    return () => { if (referenceGeneration.current === generation) referenceGeneration.current += 1; };
  }, [source]);

  const palette = useMemo(() => {
    void paletteVersion;
    return svgPaletteFromCss();
  }, [paletteVersion]);

  const cards = useMemo(() => Object.fromEntries(functions.map((info) => {
    const result = results[info.id] ?? { state: "loading" };
    const svg = result.state === "ready" ? createSvgDocument(result.nodes, result.edges, mode, palette) : "";
    return [info.id, { info, result, svg }];
  })), [functions, results, mode, palette]);

  useEffect(() => {
    const priorPersistedPositions = previousPersistedPositions.current;
    previousPersistedPositions.current = positions;
    setBoardNodes((current) => {
      const existing = new Map(current.map((node) => [node.id, node]));
      const next: FunctionCardNode[] = functions.map((info, index) => {
        const card = cards[info.id];
        const result = card?.result ?? { state: "loading" };
        const previous = existing.get(info.id);
        const persisted = positions[info.id];
        const oldPersisted = priorPersistedPositions[info.id];
        const hadPersisted = Object.prototype.hasOwnProperty.call(priorPersistedPositions, info.id);
        const hasPersisted = Object.prototype.hasOwnProperty.call(positions, info.id);
        const externalPositionChanged = hasPersisted
          ? !hadPersisted || persisted.x !== oldPersisted.x || persisted.y !== oldPersisted.y
          : hadPersisted;
        return {
          id: info.id,
          type: "functionCard",
          position: externalPositionChanged ? persisted ?? initialPosition(index) : previous?.position ?? persisted ?? initialPosition(index),
          width: CARD_WIDTH,
          height: CARD_HEIGHT,
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
          data: {
            info,
            svg: card?.svg ?? "",
            status: result.state,
            error: result.state === "error" ? result.message : undefined,
            diagnostics: result.state === "ready" ? result.diagnostics : [],
            onOpen: onOpenFunction,
          },
        };
      });
      return next;
    });
  }, [functions, cards, positions, onOpenFunction]);

  const boardEdges = useMemo<Edge[]>(() => buildReferenceEdges(references, functions,boardNodes), [references, functions,boardNodes]);

  const onNodesChange = useCallback((changes: NodeChange<FunctionCardNode>[]) => {
    setBoardNodes((nodes) => applyNodeChanges(changes, nodes));
  }, []);

  const persistPositions = useCallback((_event: MouseEvent | TouchEvent, dragged: FunctionCardNode) => {
    const next: Record<string, FunctionPosition> = {};
    for (const node of boardNodes) next[node.id] = node.id === dragged.id ? dragged.position : node.position;
    onPositions(next);
  }, [boardNodes, onPositions]);

  useEffect(() => {
    if (!onExportReady) return;
    const timer = window.setTimeout(() => onExportReady(composeBoardSvg(boardNodes, boardEdges, palette)), 40);
    return () => window.clearTimeout(timer);
  }, [boardNodes, boardEdges, palette, onExportReady]);

  const readyCount = Object.values(results).filter((result) => result.state === "ready").length;
  const errorCount = Object.values(results).filter((result) => result.state === "error").length;

  return (
    <section className={`function-board mode-${mode}`} aria-label="All function flowcharts">
      {functions.length > 0 ? (
        <ReactFlow<FunctionCardNode>
          nodes={boardNodes}
          edges={boardEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={persistPositions}
          nodesConnectable={false}
          nodesDraggable
          fitView
          fitViewOptions={{ padding: 0.08 }}
          minZoom={0.12}
          maxZoom={1.4}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--line)" />
          <Controls showInteractive={false} position="bottom-right" />
          <MiniMap style={{width:120,height:78}} position="bottom-left" pannable zoomable nodeColor="var(--diagram-process-stroke)" maskColor="color-mix(in srgb, var(--panel) 72%, transparent)" />
        </ReactFlow>
      ) : <div className="function-board__empty"><strong>No functions found</strong><span>Open a C++ file containing at least one function.</span></div>}
      <div className="function-board__status" role="status" aria-live="polite">
        <span>{readyCount}/{functions.length} ready{errorCount ? ` · ${errorCount} unavailable` : ""}</span>
        {referenceError && <span title={referenceError}>Call links unavailable</span>}
      </div>
    </section>
  );
}

function buildReferenceEdges(references: FunctionReference[], functions: FunctionInfo[],nodes:FunctionCardNode[]): Edge[] {
  const ids = new Set(functions.map((item) => item.id));
  const names = new Map<string, string>();
  for (const item of functions) if (!names.has(item.name)) names.set(item.name, item.id);
  const resolve = (value: string) => ids.has(value) ? value : names.get(value);
  const grouped = new Map<string, { source: string; target: string; labels: Set<string> }>();
  for (const reference of references) {
    const source = resolve(reference.source);
    const target = resolve(reference.target);
    if (!source || !target) continue;
    const key = JSON.stringify([source, target]);
    const entry = grouped.get(key) ?? { source, target, labels: new Set<string>() };
    if (reference.label) entry.labels.add(reference.label);
    grouped.set(key, entry);
  }
  const positions=new Map(nodes.map(node=>[node.id,node.position]));
  const sides=(entry:{source:string;target:string})=>{const source=positions.get(entry.source)??{x:0,y:0},target=positions.get(entry.target)??{x:0,y:0};if(entry.source===entry.target)return ['right','bottom'];if(source.x===target.x)return source.y<=target.y?['bottom','top']:['top','bottom'];return source.x<target.x?['right','left']:['left','right'];};
  return [...grouped.values()].map((entry, index) => ({
    id: `function-call-${index}-${entry.source}-${entry.target}`,
    source: entry.source,
    target: entry.target,
    sourceHandle: "call-out-"+sides(entry)[0],
    targetHandle: "call-in-"+sides(entry)[1],
    label: [...entry.labels].join(", ") || "calls",
    type: entry.source===entry.target?"smoothstep":"bezier",
    markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: "var(--muted)" },
    style: { stroke: "var(--muted)", strokeWidth: 1.5, strokeDasharray: "7 6" },
    labelStyle: { fill: "var(--text)", fontSize: 10, fontWeight: 650 },
    labelBgStyle: { fill: "var(--panel)", fillOpacity: 0.92 },
    labelBgPadding: [5, 3],
    labelBgBorderRadius: 5,
  }));
}

function composeBoardSvg(nodes: FunctionCardNode[], edges: Edge[], palette: SvgPalette): string {
  if (!nodes.length) return "";
  const padding = 48;
  const minX = Math.min(...nodes.map((node) => node.position.x)) - padding;
  const minY = Math.min(...nodes.map((node) => node.position.y)) - padding;
  const maxX = Math.max(...nodes.map((node) => node.position.x + CARD_WIDTH)) + padding;
  const maxY = Math.max(...nodes.map((node) => node.position.y + CARD_HEIGHT)) + padding;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edgeMarkup = edges.flatMap((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) return [];
    const point=(node:FunctionCardNode,handle:string|undefined|null)=>{
      const side=handle?.split('-').at(-1);return {x:node.position.x+(side==='left'?0:side==='right'?CARD_WIDTH:CARD_WIDTH/2),y:node.position.y+(side==='top'?0:side==='bottom'?CARD_HEIGHT:CARD_HEIGHT/2)};
    };
    const from=point(source,edge.sourceHandle),to=point(target,edge.targetHandle);
    const sourceX=from.x,sourceY=from.y,targetX=to.x,targetY=to.y;
    const vertical=edge.sourceHandle?.endsWith('top')||edge.sourceHandle?.endsWith('bottom');
    const direction=vertical?(sourceY<=targetY?1:-1):(sourceX<=targetX?1:-1);
    const bend=Math.max(24,Math.abs(vertical?targetY-sourceY:targetX-sourceX)*.45);
    const path=source.id===target.id?`M ${sourceX} ${sourceY} C ${sourceX+32} ${sourceY}, ${sourceX+32} ${targetY+32}, ${targetX} ${targetY+32} L ${targetX} ${targetY}`:vertical?`M ${sourceX} ${sourceY} C ${sourceX} ${sourceY+direction*bend}, ${targetX} ${targetY-direction*bend}, ${targetX} ${targetY}`:`M ${sourceX} ${sourceY} C ${sourceX+direction*bend} ${sourceY}, ${targetX-direction*bend} ${targetY}, ${targetX} ${targetY}`;
    const label = String(edge.label ?? "");
    const self=source.id===target.id;
    const labelX=self?sourceX+26:(sourceX+targetX)/2,labelY=self?(sourceY+targetY)/2:(sourceY+targetY)/2-7;
    const shownLabel=self&&label.length>32?label.slice(0,29)+'…':label;
    return [`<path d="${path}" fill="none" stroke="${escapeXml(palette.edge)}" stroke-width="1.5" stroke-dasharray="7 6" marker-end="url(#board-arrow)"/>${label ? `<text x="${labelX}" y="${labelY}" ${self?`transform="rotate(90 ${labelX} ${labelY})"`:""} text-anchor="middle" class="call-label"><title>${escapeXml(label)}</title>${escapeXml(shownLabel)}</text>` : ""}`];
  }).join("");
  const cards = nodes.map((node, index) => {
    const { info, svg, status, error } = node.data;
    const x = node.position.x;
    const y = node.position.y;
    const nested = status === "ready" ? nestedSvg(svg, x + 12, y + 58, CARD_WIDTH - 24, CARD_HEIGHT - 76, `chart-arrow-${index}`) : `<text x="${x + CARD_WIDTH / 2}" y="${y + CARD_HEIGHT / 2}" text-anchor="middle" class="error">${escapeXml(error ?? "Analyzing…")}</text>`;
    return `<g><rect x="${x}" y="${y}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="14" fill="${escapeXml(palette.edgeLabelBackground)}" stroke="${escapeXml(palette.processStroke)}" stroke-width="1.4"/><path d="M ${x} ${y + 48} H ${x + CARD_WIDTH}" stroke="${escapeXml(palette.processStroke)}" stroke-opacity=".55"/><text x="${x + 15}" y="${y + 22}" class="title">${escapeXml(info.name)}</text><text x="${x + 15}" y="${y + 38}" class="line">Line ${info.line}</text>${nested}</g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX - minX}" height="${maxY - minY}" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}"><defs><marker id="board-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="${escapeXml(palette.edge)}"/></marker><style>.title{font:700 13px system-ui;fill:${escapeXml(palette.text)}}.line,.error{font:11px system-ui;fill:${escapeXml(palette.muted)}}.call-label{font:650 10px system-ui;fill:${escapeXml(palette.text)};paint-order:stroke;stroke:${escapeXml(palette.background)};stroke-width:5px}</style></defs><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${escapeXml(palette.background)}"/>${edgeMarkup}${cards}</svg>`;
}

function nestedSvg(svg: string, x: number, y: number, width: number, height: number, arrowId: string): string {
  const opening = /^<svg\b([^>]*)>/i.exec(svg);
  const viewBox = opening?.[1].match(/\bviewBox="([^"]+)"/i)?.[1];
  if (!opening || !viewBox) return "";
  const inner = svg.slice(opening[0].length).replace(/<\/svg>\s*$/i, "")
    .replaceAll('id="arrow"', `id="${arrowId}"`)
    .replaceAll("url(#arrow)", `url(#${arrowId})`);
  return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${escapeXml(viewBox)}" preserveAspectRatio="xMidYMid meet">${inner}</svg>`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character]!));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Analysis failed";
}
