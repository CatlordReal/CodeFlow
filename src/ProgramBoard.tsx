import {
  Background, BackgroundVariant, Controls, Handle, MarkerType, MiniMap, Position, ReactFlow, applyNodeChanges,
  type Edge, type Node, type NodeChange, type NodeMouseHandler, type NodeProps, type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import AlignmentGuides from './AlignmentGuides';
import { positionedCanvas, snapBoxPosition, type AlignmentGuide } from './boxGeometry';
import { ProgramAnalysisCache } from './programAnalysisCache';
import { editorAwareCenter } from './viewport';
import FlowNodeCard from "./FlowNodeCard";
import { createSvgDocument, svgPaletteFromCss, type SvgPalette } from "./exportSvg";
import { edgeTypes, layoutGraph, NODE_WIDTH, nodeHeight, type CanvasEdge, type CanvasNode } from "./layout";
import {
  hideGraphNodes, nodePresentationKey, presentGraph, presentLoopEdgeLabels,
  type CaptionSets, type ChartEdits, type ChartMode, type LoopOverrides,
} from "./presentation";
import {
  arrangeProgramGroups, buildProgramCallEdges, composeProgramSvg, namespaceProgramDiagram, positionProgramEdges,
  isProgramEntry, programBounds, programGroupId, type ProgramDiagram, type ProgramPosition, type ProgramReference,
} from "./programLayout";
import { overviewGraph, simplifyGraph } from "./simplify";
import type { FlowGraph, FunctionInfo, SourceLanguage } from "./types";
import "./ProgramBoard.css";

export type ProgramSelection = { functionId: string; nodeId?: string };
export type ProgramBoardProps = {
  source: string;
  functions: FunctionInfo[];
  language?: SourceLanguage;
  mode: ChartMode;
  includeComments: boolean;
  showLoopLabels: boolean;
  loopDepth: number | null;
  loopOverrides: LoopOverrides;
  edits: ChartEdits;
  captions: CaptionSets;
  hiddenBoxes: Record<string, string[]>;
  showHiddenBoxes: boolean;
  highlightUnmodified?: boolean;
  positions: Record<string, ProgramPosition>;
  onPositions: (positions: Record<string, ProgramPosition>) => void;
  onBoxPosition: (functionId:string,node:CanvasNode,position:ProgramPosition)=>void;
  onSelect: (selection: ProgramSelection) => void;
  onClearSelection?: () => void;
  focusRequest?: number;
  selectedFunctionId?: string;
  selectedNodeId?: string;
  onExportReady?: (svg: string, render?: (palette:SvgPalette)=>string) => void;
};

type Result = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; diagram: ProgramDiagram };
type GroupData = Record<string, unknown> & { diagram: ProgramDiagram; state: Result["state"]; onSelect: (selection: ProgramSelection) => void };
type GroupNode = Node<GroupData, "programGroup">;
type BoardNode = GroupNode | CanvasNode;
const HEADER_HEIGHT = 56, GROUP_PADDING = 18, ERROR_WIDTH = 390, ERROR_HEIGHT = 210;

function ProgramGroup({ data }: NodeProps<GroupNode>) {
  const { diagram } = data, entry = isProgramEntry(diagram.info);
  return <article className="program-group" data-entry={entry || undefined}>
    {([Position.Top, Position.Right, Position.Bottom, Position.Left] as const).flatMap((position) => {
      const side = position.toLowerCase();
      return [
        <Handle key={`in-${side}`} id={`call-in-${side}`} type="target" position={position} isConnectable={false} />,
        <Handle key={`out-${side}`} id={`call-out-${side}`} type="source" position={position} isConnectable={false} />,
      ];
    })}
    <header onDoubleClick={() => data.onSelect({ functionId: diagram.info.id })}>
      <div><strong>{diagram.info.name}</strong><span>Function · line {diagram.info.line}</span></div>
      {entry && <b>Entry</b>}
    </header>
    {data.state === "loading" && <div className="program-group__message"><span className="program-group__spinner" />Analyzing…</div>}
    {data.state === "error" && <div className="program-group__message program-group__message--error"><strong>Chart unavailable</strong><span>{diagram.error}</span></div>}
  </article>;
}

const nodeTypes = { programGroup: ProgramGroup, flowNode: FlowNodeCard };

export default function ProgramBoard(props: ProgramBoardProps) {
  const {
    source, functions, language = "cpp", mode, includeComments, showLoopLabels, loopDepth, loopOverrides, edits, captions,
    hiddenBoxes, showHiddenBoxes, highlightUnmodified = false, positions, onPositions, onSelect, onClearSelection,
    selectedFunctionId, selectedNodeId, onExportReady, onBoxPosition, focusRequest,
  } = props;
  const [results, setResults] = useState<Record<string, Result>>({});
  const [references, setReferences] = useState<ProgramReference[]>([]);
  const [referenceState, setReferenceState] = useState<"loading" | "ready" | "error">("loading");
  const [referenceError, setReferenceError] = useState("");
  const [nodes, setNodes] = useState<BoardNode[]>([]);
  const [paletteVersion, setPaletteVersion] = useState(0);
  const [dragging, setDragging] = useState(false), [rendering, setRendering] = useState(true);
  const parsedCache = useRef(new ProgramAnalysisCache<FlowGraph>());
  const lastParseIdentity = useRef('');
  const onSelectRef = useRef(onSelect); onSelectRef.current = onSelect;
  const selectGroup = useCallback((selection: ProgramSelection) => onSelectRef.current(selection), []);
  const analysisGeneration = useRef(0), referenceGeneration = useRef(0);
  const activeAnalyses = useRef(0), analysisWaiters = useRef<Array<() => void>>([]);
  const flow = useRef<ReactFlowInstance<BoardNode> | null>(null), lastFittedMembership = useRef("");
  const members = useMemo(() => functions.map((info) => ({ info, id: programGroupId(info) })), [functions]);
  const membership = useMemo(() => functions.map((info) => info.identity ?? info.id).sort().join("\n"), [functions]);
  const parseIdentity = JSON.stringify([source, functions, language]);
  const analysisKey = JSON.stringify([source, functions, language, mode, includeComments, showLoopLabels, loopDepth, loopOverrides, edits, captions, hiddenBoxes, showHiddenBoxes, highlightUnmodified]);

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
    const observer = new MutationObserver(() => setPaletteVersion((value) => value + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const generation = ++analysisGeneration.current;
    onExportReady?.("");
    setRendering(true);
    if (lastParseIdentity.current !== parseIdentity) {
      lastParseIdentity.current = parseIdentity;
      setResults(Object.fromEntries(members.map((item) => [item.id, { state: "loading" } satisfies Result])));
    }
    let next = 0;
    const analyze = async (item: typeof members[number]): Promise<Result> => {
      try {
        const parsed = await parsedCache.current.use(parseIdentity, item.info.id, () => api.analyzeCpp(source, item.info.id, true, language).then(simplifyGraph));
        const overview = overviewGraph(parsed, { depth: loopDepth, overrides: loopOverrides[item.info.id] ?? {} });
        const visible = hideGraphNodes(overview, hiddenBoxes[item.info.id] ?? [], showHiddenBoxes);
        const presented = {
          ...visible,
          nodes: visible.nodes.map((node) => {
            const key = nodePresentationKey(item.info.id, node, loopDepth);
            const shown = presentGraph({ ...visible, nodes: [node], edges: [] }, mode, includeComments, edits[key], captions[key]).nodes[0];
            return { ...shown, unmodified: mode === "natural" && highlightUnmodified && edits[key]?.[node.id]?.natural === undefined && captions[key]?.[node.id] === undefined };
          }),
        };
        const labels = new Map(presentLoopEdgeLabels(presented,showLoopLabels).edges.map((edge) => [edge.id, edge.label]));
        const layout = await layoutGraph(presented, labels);
        const laidOut=positionedCanvas(layout.nodes,layout.edges,labels);
        const edges = laidOut.edges.map((edge) => ({ ...edge, label: labels.get(edge.id) || undefined }));
        const size = programBounds(laidOut.nodes);
        return { state: "ready", diagram: { id: item.id, info: item.info, width: size.width, height: size.height, nodes: laidOut.nodes, edges, position: positions[item.info.id] } };
      } catch (cause) {
        return { state: "error", message: cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Analysis failed" };
      }
    };
    const worker = async () => {
      while (generation === analysisGeneration.current) {
        const item = members[next++];
        if (!item) return;
        const release = await acquireAnalysisSlot();
        if (generation !== analysisGeneration.current) { release(); return; }
        let result: Result;
        try { result = await analyze(item); }
        finally { release(); }
        if (generation !== analysisGeneration.current) return;
        setResults((current) => ({ ...current, [item.id]: result }));
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, members.length) }, worker)).then(() => { if (generation === analysisGeneration.current) setRendering(false); });
    return () => { if (analysisGeneration.current === generation) analysisGeneration.current += 1; };
  }, [analysisKey, acquireAnalysisSlot]);

  useEffect(() => {
    const generation = ++referenceGeneration.current;
    setReferences([]); setReferenceState("loading"); setReferenceError(""); onExportReady?.("");
    void api.functionReferences(source, language).then((value) => {
      if (generation === referenceGeneration.current) { setReferences(value); setReferenceState("ready"); }
    }).catch((cause) => {
      if (generation === referenceGeneration.current) { setReferenceState("error"); setReferenceError(cause instanceof Error ? cause.message : String(cause)); }
    });
    return () => { if (referenceGeneration.current === generation) referenceGeneration.current += 1; };
  }, [source, language]);

  const diagrams = useMemo<ProgramDiagram[]>(() => members.map((item) => {
    const result = results[item.id];
    if (result?.state === "ready") return { ...result.diagram, position: positions[item.info.id] };
    return { id: item.id, info: item.info, width: ERROR_WIDTH, height: ERROR_HEIGHT, nodes: [], edges: [], error: result?.state === "error" ? result.message : undefined, position: positions[item.info.id] };
  }), [members, results, positions]);
  const allSettled = members.length > 0 && members.every((item) => ["ready", "error"].includes(results[item.id]?.state ?? ""));
  const calls = useMemo(() => buildProgramCallEdges(references, diagrams.filter((diagram) => !diagram.error && diagram.nodes.length)), [references, diagrams]);
  const arranged = useMemo(() => arrangeProgramGroups(diagrams, 72, 1800, calls), [diagrams, calls]);

  useEffect(() => {
    setNodes((current) => {
      const live = new Map(current.filter((node) => node.type === "programGroup").map((node) => [node.id, node.position]));
      return diagrams.flatMap((diagram): BoardNode[] => {
        const result = results[diagram.id] ?? { state: "loading" };
        const saved = positions[diagram.info.id];
        const position = saved ?? (allSettled ? arranged[diagram.id] : live.get(diagram.id) ?? arranged[diagram.id]);
        const group: GroupNode = { id: diagram.id, type: "programGroup", position, width: diagram.width, height: diagram.height, style: { width: diagram.width, height: diagram.height }, data: { diagram, state: result.state, onSelect: selectGroup }, selected: selectedFunctionId === diagram.info.id && !selectedNodeId, zIndex: 0 };
        if (result.state !== "ready") return [group];
        const namespaced = namespaceProgramDiagram(diagram.id, diagram.nodes, diagram.edges);
        const children = namespaced.nodes.map((node, index): CanvasNode => ({ ...node, position: { x: diagram.nodes[index].position.x + GROUP_PADDING, y: diagram.nodes[index].position.y + HEADER_HEIGHT }, parentId: diagram.id, draggable: true, selectable: true, selected: selectedFunctionId === diagram.info.id && selectedNodeId === diagram.nodes[index].data.flow.id, zIndex: 2 }));
        return [group, ...children];
      });
    });
  }, [diagrams, results, positions, arranged, allSettled, selectGroup, selectedFunctionId, selectedNodeId]);

  const [guides,setGuides]=useState<AlignmentGuide[]>([]);
  const liveDiagrams=useMemo(()=>diagrams.map(diagram=>{
    const children=diagram.nodes.map(node=>{
      const live=nodes.find(item=>item.id===`${diagram.id}/${node.id}`);
      if(!live)return node;
      const position={x:live.position.x-GROUP_PADDING,y:live.position.y-HEADER_HEIGHT};
      return {...node,data:{...node.data,flow:{...node.data.flow,position}}};
    });
    const positioned=positionedCanvas(children,diagram.edges);
    return {...diagram,nodes:positioned.nodes,edges:positioned.edges,...programBounds(positioned.nodes)};
  }),[diagrams,nodes]);
  const edges = useMemo<Edge[]>(() => {
    const groupPositions = new Map(nodes.filter((node) => node.type === "programGroup").map((node) => [node.id, node.position]));
    const inside = liveDiagrams.flatMap((diagram) => {
      const offset = groupPositions.get(diagram.id) ?? diagram.position ?? { x: 0, y: 0 };
      return positionProgramEdges(diagram.id, diagram.edges, offset, { x: GROUP_PADDING, y: HEADER_HEIGHT });
    });
    const cross = calls.map((call) => ({
      id: call.id, source: call.source, target: call.target,
      sourceHandle: call.source === call.sourceGroup ? "call-out-right" : "out-e",
      targetHandle: call.target === call.targetGroup ? "call-in-left" : "in-w",
      label: call.label, type: "smoothstep", markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: "var(--muted)" },
      style: { stroke: "var(--muted)", strokeWidth: 1.6, strokeDasharray: "8 6" },
      labelStyle: { fill: "var(--text)", fontSize: 10, fontWeight: 650 },
      labelBgStyle: { fill: "var(--panel)", fillOpacity: .94 }, labelBgPadding: [5, 3] as [number, number], zIndex: 3,
    }));
    return [...inside, ...cross];
  }, [liveDiagrams, calls, nodes]);

  const onNodesChange = useCallback((changes: NodeChange<BoardNode>[]) => setNodes((current) => applyNodeChanges(changes, current)), []);
  const persist = useCallback((_event: MouseEvent | TouchEvent, node: BoardNode) => {
    if (node.type !== "programGroup") return;
    const next = { ...positions };
    for (const item of nodes) if (item.type === "programGroup") next[item.data.diagram.info.id] = item.id === node.id ? node.position : item.position;
    onPositions(next);
  }, [nodes, positions, onPositions]);
  const dragBox=(_event:MouseEvent|TouchEvent,node:BoardNode)=>{
    if(node.type==='programGroup')return;
    const parent=nodes.find(item=>item.id===node.parentId);if(!parent)return;
    const siblings=nodes.filter((item):item is CanvasNode=>item.type==='flowNode').map(item=>{
      const group=nodes.find(group=>group.id===item.parentId);
      const position={x:item.position.x+(group?.position.x??0),y:item.position.y+(group?.position.y??0)};
      return {...item,position,data:{...item.data,flow:{...item.data.flow,position}}};
    });
    const world={x:parent.position.x+node.position.x,y:parent.position.y+node.position.y};
    const snapped=snapBoxPosition(siblings,node.id,world,flow.current?.getZoom()??1,'shiftKey' in _event&&_event.shiftKey);
    const position={x:Math.max(0,snapped.position.x-parent.position.x-GROUP_PADDING),y:Math.max(0,snapped.position.y-parent.position.y-HEADER_HEIGHT)};
    const relative={x:position.x+GROUP_PADDING,y:position.y+HEADER_HEIGHT};
    setNodes(current=>current.map(item=>item.id===node.id&&item.type==='flowNode'?{...item,position:relative,data:{...item.data,flow:{...node.data.flow,position}}}:item.id===parent.id&&item.type==='programGroup'?{...item,width:Math.max(item.width??0,relative.x+NODE_WIDTH+GROUP_PADDING),height:Math.max(item.height??0,relative.y+nodeHeight(node.data.flow)+GROUP_PADDING),style:{...item.style,width:Math.max(item.width??0,relative.x+NODE_WIDTH+GROUP_PADDING),height:Math.max(item.height??0,relative.y+nodeHeight(node.data.flow)+GROUP_PADDING)}}:item));
    setGuides(snapped.guides);return position;
  };
  const selectNode: NodeMouseHandler<BoardNode> = (_event,node)=>{
    if(node.type==='programGroup')return;
    const group=diagrams.find(item=>item.id===node.parentId);if(group)onSelect({functionId:group.info.id,nodeId:node.data.flow.id});
  };
  const lastCentered=useRef('');
  useEffect(()=>{
    const key=selectedFunctionId+'\0'+selectedNodeId+'\0'+focusRequest;
    if(!selectedNodeId){lastCentered.current='';return;}
    if(key===lastCentered.current)return;
    const node=nodes.find(item=>item.type==='flowNode'&&item.data.flow.id===selectedNodeId&&item.parentId===`program:${selectedFunctionId}`);
    const group=nodes.find(item=>item.id===node?.parentId);if(!node||node.type!=='flowNode'||!group)return;
    const frame=requestAnimationFrame(()=>{
      const canvas=document.querySelector('.program-board');const instance=flow.current;if(!canvas||!instance)return;
      lastCentered.current=key;
      const zoom=instance.getZoom();
      const point=editorAwareCenter({x:group.position.x+node.position.x+NODE_WIDTH/2,y:group.position.y+node.position.y+nodeHeight(node.data.flow)/2},canvas.getBoundingClientRect(),document.querySelector('.node-editor')?.getBoundingClientRect()??null,zoom);
      void instance.setCenter(point.x,point.y,{zoom,duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:150});
    });return()=>cancelAnimationFrame(frame);
  },[selectedFunctionId,selectedNodeId,nodes,focusRequest]);

  useEffect(() => {
    if (!allSettled || !flow.current || lastFittedMembership.current === membership) return;
    lastFittedMembership.current = membership;
    requestAnimationFrame(() => void flow.current?.fitView({ padding: .08, duration: 0 }));
  }, [allSettled, membership, nodes]);

  const palette = useMemo(() => { void paletteVersion; return svgPaletteFromCss(); }, [paletteVersion]);
  useEffect(() => {
    if (dragging || rendering || !onExportReady || !allSettled || referenceState !== "ready" || diagrams.some((diagram) => diagram.error)) { onExportReady?.(""); return; }
    const groupPositions = Object.fromEntries(nodes.filter((node) => node.type === "programGroup").map((node) => [node.id, node.position]));
    const render=(colors:SvgPalette)=>composeProgramSvg(liveDiagrams,calls,groupPositions,colors,(chartNodes,chartEdges,palette)=>createSvgDocument(chartNodes,chartEdges,mode,palette));
    onExportReady(render(palette),render);
  }, [dragging, rendering, allSettled, referenceState, liveDiagrams, calls, nodes, palette, mode, onExportReady]);

  const ready = Object.values(results).filter((result) => result.state === "ready").length;
  const errors = Object.values(results).filter((result) => result.state === "error").length;
  return <section className={`program-board mode-${mode}`} aria-label="Whole program flowchart">
    {members.length ? <ReactFlow<BoardNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={(instance) => { flow.current = instance; }} onNodesChange={onNodesChange} onNodeDragStart={()=>setDragging(true)} onNodeDrag={dragBox} onNodeDragStop={(event,node)=>{setDragging(false);if(node.type==='programGroup'){persist(event,node);return;}const position=dragBox(event,node);setGuides([]);const group=diagrams.find(item=>item.id===node.parentId);if(position&&group)onBoxPosition(group.info.id,node,position);}} onNodeClick={selectNode} onPaneClick={onClearSelection} nodesConnectable={false} nodesDraggable minZoom={.05} maxZoom={1.6} proOptions={{ hideAttribution: true }}>
      <AlignmentGuides guides={guides}/>
      <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="var(--line)" />
      <Controls showInteractive={false} position="bottom-right" />
      <MiniMap position="bottom-left" pannable zoomable nodeColor={(node) => node.type === "programGroup" ? (isProgramEntry((node as GroupNode).data.diagram.info) ? palette.terminatorStroke : palette.processStroke) : "transparent"} maskColor="color-mix(in srgb, var(--panel) 72%, transparent)" />
    </ReactFlow> : <div className="program-board__empty"><strong>No functions found</strong><span>Open code containing functions.</span></div>}
    <div className="program-board__status" role="status"><span>{ready}/{members.length} ready{errors ? ` · ${errors} unavailable` : ""}</span>{referenceState === "error" && <span title={referenceError}>Call links unavailable</span>}</div>
  </section>;
}
