import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
  type NodeChange,
  type Edge,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { analyzeCpp, inspectCpp, openDocument, openRecentProject, recentProjects, readRecovery, saveRecovery, saveDocument, saveProjectDocument, type RecentProject, discardRecovery, resumeRecovery, revealLastExport } from "./api";
import FlowNodeCard from "./FlowNodeCard";
import { createPngDataUrl, createSvgDocument, svgPaletteFromCss, svgPaletteFromTheme, type SvgPalette, svgDocumentName } from "./exportSvg";
import { edgeTypes, layoutGraph, type CanvasNode, type CanvasEdge } from "./layout";
import { formatUpdaterError } from "./update";
import AppToolbar from "./AppToolbar";
import ChartTools from "./ChartTools";
import ProgramBoard from "./ProgramBoard";
import LocalAI from "./LocalAI";
import { analyzeLoops, overviewGraph, simplifyGraph } from "./simplify";
import { hideGraphNodes, nodePresentationKey, presentGraph, presentLoopEdgeLabels, readProject, type ChartMode, type ChartEdits, type CaptionSets, type LoopOverrides, type Project, type SourceHistoryArchive } from "./presentation";
import "./editing.css";
import {defaultChartState,useChartHistory,historyShortcut,historyTarget} from "./history";
import HistoryPanel from "./HistoryPanel";
import FunctionBoard from "./FunctionBoard";
import {mapFunction,matchFunctions,remapChart,remapChartForLanguage,retainSourceHistory,type FunctionMapping} from './preservation';
import type {ChartState} from './history';
import { SAMPLE_CPP } from "./sample";
import type { FlowGraph, FunctionInfo, SourceLanguage, ChartView } from "./types";
import { createDesktopCloseHandler } from "./close";
import { CloseDialog, type CloseChoice } from "./CloseDialog";
import { serializeProject } from "./projectSerialization";
import { editorAwareCenter, functionViewportFitKey } from "./viewport";

import AlignmentGuides from './AlignmentGuides';
import { positionedCanvas, snapBoxPosition, type AlignmentGuide } from './boxGeometry';
import { THEMES, type ThemeId } from './themes';
import { functionAtByte, nodeAtByte } from './sourceNavigation';

const nodeTypes = { flowNode: FlowNodeCard };

type UpdateStatus = {
  kind: "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error" | "desktop";
  message: string;
  progress?: number;
};

type DocumentStatus = { kind: "idle" | "success" | "info" | "error"; message: string; action?: 'reveal-export' };

function Icon({ name }: { name: "file" | "export" | "refresh" | "save" | "update" | "close" }) {
  const paths = {
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></>,
    export: <><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></>,
    refresh: <><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 4v5h5"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 20v-5h-5"/></>,
    save: <><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></>,
    update: <><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

export default function App() {
  const {state:chart,history,change,changeFields,load:loadHistory,select:selectRevision,navigate:navigateHistory,reset:resetChart,alternate:createAlternate,transformHistory,markSaved,error:historyError,clearError:clearHistoryError}=useChartHistory({...defaultChartState(),source:SAMPLE_CPP,labelSource:SAMPLE_CPP,language:'cpp'});
  const source=chart.source??SAMPLE_CPP;
  const language=chart.language??'cpp';
  const [fileName, setFileName] = useState("untitled.cpp");
  const [isDirty, setIsDirty] = useState(true);
  const [functions, setFunctions] = useState<FunctionInfo[]>([]);
  const [selectedFunction, setSelectedFunction] = useState("");
  const [inspectedSource, setInspectedSource] = useState("");
  const [inspectedLanguage,setInspectedLanguage]=useState<SourceLanguage>('cpp');
  const [pendingInspection,setPendingInspection]=useState<{request:number;session:number;source:string;language:SourceLanguage;functions:FunctionInfo[];pairs:[FunctionInfo,FunctionInfo][]}|null>(null);
  const [exportTransparent,setExportTransparent]=useState(false);
  const [exportTheme,setExportTheme]=useState<ThemeId | 'current'>('current');
  const {loopDepth,loopOverrides,mode,edits,captions,hiddenBoxes,showHiddenBoxes,functionPositions,includeComments,showLoopLabels}=chart;
  const expandLoops=loopDepth===null;
  const setLoopOverrides=(value:LoopOverrides|((v:LoopOverrides)=>LoopOverrides))=>change('loopOverrides',value,'Loop expansion');
  const setMode=(value:ChartMode)=>change('mode',value,'Label mode');
  const setEdits=(value:ChartEdits|((v:ChartEdits)=>ChartEdits),field?:string)=>change('edits',value,'Edit box',field?`edit:${selectedFunction}:${selectedNodeId}:${field}`:undefined);
  const setCaptions=(value:CaptionSets|((v:CaptionSets)=>CaptionSets))=>change('captions',value,'AI captions');
  const [showHistory,setShowHistory]=useState(false);
  const [chartView,setChartView]=useState<ChartView>('function');
  const fileView=chartView==='file', boardView=chartView!=='function';
  const [highlightUnmodified,setHighlightUnmodified]=useState(false);
  const [boardSvg,setBoardSvg]=useState('');
  const boardRenderer=useRef<((palette:SvgPalette)=>string)|null>(null);
  const onBoardExport=useCallback((svg:string,render?: (palette:SvgPalette)=>string)=>{boardRenderer.current=render??null;setBoardSvg(svg);},[]);
  const sourceHistory=useRef<SourceHistoryArchive[]>([]);
  const baseline=useRef<{source:string;language:SourceLanguage;functions:FunctionInfo[];session:number}|null>(null);
  const labelLibrary=useRef<{source:string;language:SourceLanguage;functions:FunctionInfo[];state:ChartState}[]>([]);
  const chartRef=useRef(chart);chartRef.current=chart;
  const libraryLoaded=useRef(false);
  const pastedSource=useRef(false);
  const projectToken=useRef<string|null>(null),documentSession=useRef(0),savingProject=useRef(false);
  const [recoveryReady,setRecoveryReady]=useState(false);
  const recoveryReadyRef=useRef(false);
  const recoveryError=useRef(false);
  const dirtyRef=useRef(true);
  const sourceDirtyRef=useRef(true),projectDirtyRef=useRef(false);
  const [recent,setRecent]=useState<RecentProject[]>([]);
  const [sourceScrollTop,setSourceScrollTop]=useState(0);
  const [transparency,setTransparency]=useState(()=>{try{return Math.min(80,Math.max(0,Number(localStorage.getItem('codeflow.transparency'))||0));}catch{return 0;}});
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const selectedNodeRef=useRef(selectedNodeId);selectedNodeRef.current=selectedNodeId;
  const [showAI, setShowAI] = useState(false);
  const [projectDirty, setProjectDirty] = useState(false);
  const layoutRequest = useRef(0);
  const draggingBox = useRef(false);
  const [layoutEpoch,setLayoutEpoch]=useState(0);
  const [graphSource, setGraphSource] = useState('');
  const [graphLanguage,setGraphLanguage]=useState<SourceLanguage>('cpp');
  const [graphFunction, setGraphFunction] = useState('');
  const openRequest = useRef(0);
  const [graph, setGraph] = useState<FlowGraph>({ nodes: [], edges: [], diagnostics: [] });
  const [canvasNodes, setCanvasNodes] = useState<CanvasNode[]>([]);
  const [canvasEdges, setCanvasEdges] = useState<CanvasEdge[]>([]);
  const [alignmentGuides,setAlignmentGuides]=useState<AlignmentGuide[]>([]);
  const liveCanvas=useRef({nodes:canvasNodes,edges:canvasEdges});liveCanvas.current={nodes:canvasNodes,edges:canvasEdges};
  const [sourceFocusRequest,setSourceFocusRequest]=useState(0);
  const pendingCode=useRef<{source:string;functionId?:string;byte:number}|null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ kind: "idle", message: "" });
  const [availableUpdate, setAvailableUpdate] = useState<{ currentVersion: string; version: string; body?: string } | null>(null);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [documentStatus, setDocumentStatus] = useState<DocumentStatus>({ kind: "idle", message: "" });
  useEffect(()=>{if(historyError){setDocumentStatus({kind:'error',message:historyError});clearHistoryError();}},[historyError,clearHistoryError]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const flowRef = useRef<ReactFlowInstance<CanvasNode> | null>(null);
  const inspectRequest = useRef(0);
  const analyzeRequest = useRef(0);
  const updateRef = useRef<Update | null>(null);
  const updateDialogRef = useRef<HTMLElement>(null);
  const closeHandlerRef = useRef<(() => Promise<void>) | null>(null);
  const [closeChoiceOpen,setCloseChoiceOpen]=useState(false);
  const closeChoice=useRef<((choice:CloseChoice)=>void)|null>(null);
  const saveForClose=useRef<()=>Promise<boolean>>(async()=>false);
  const finishCloseChoice=(choice:CloseChoice)=>{const resolve=closeChoice.current;closeChoice.current=null;setCloseChoiceOpen(false);resolve?.(choice);};
  const sourceRef = useRef(source);
  const saveRequest = useRef(0);
  const replaceSource=useCallback((text:string)=>{inspectRequest.current++;analyzeRequest.current++;layoutRequest.current++;sourceRef.current=text;},[]);
  const isDesktop = "__TAURI_INTERNALS__" in window;
  sourceRef.current = source;dirtyRef.current=isDirty||projectDirty;sourceDirtyRef.current=isDirty;projectDirtyRef.current=projectDirty;recoveryReadyRef.current=recoveryReady;
  const projectRef = useRef<Project>({format:'codeflow',version:1,source,fileName,language,view:chartView,mode,edits,captions,expandLoops,includeComments,showLoopLabels,loopDepth,loopOverrides,hiddenBoxes,showHiddenBoxes,functionPositions,history});
  projectRef.current = {format:'codeflow',version:1,source,fileName,language,view:chartView,mode,edits,captions,expandLoops,includeComments,showLoopLabels,loopDepth,loopOverrides,hiddenBoxes,showHiddenBoxes,functionPositions,history,sourceHistory:sourceHistory.current,labelSource:chart.labelSource??source};
  useEffect(()=>{document.documentElement.style.setProperty('--surface-opacity',`${100-transparency}%`);try{localStorage.setItem('codeflow.transparency',String(transparency));}catch{}},[transparency]);
  useEffect(()=>{if(documentStatus.kind!=='success')return;const timer=window.setTimeout(()=>setDocumentStatus({kind:'idle',message:''}),3000);return()=>clearTimeout(timer);},[documentStatus]);
  useEffect(()=>{void recentProjects().then(setRecent).catch(()=>undefined);},[]);
  useEffect(()=>{let active=true;const session=documentSession.current;void readRecovery().then(opened=>{
    if(!active||!opened||documentSession.current!==session)return;const project=readProject(opened.contents);return inspectCpp(project.labelSource??project.source,project.language).catch(()=>[]).then(savedFunctions=>{if(!active||documentSession.current!==session)return;baseline.current={source:project.labelSource??project.source,language:project.language??'cpp',functions:savedFunctions,session};projectToken.current=opened.projectToken??null;setFunctions(savedFunctions);setInspectedSource(project.labelSource??project.source);setInspectedLanguage(project.language??'cpp');setSelectedFunction(savedFunctions[0]?.id??'');
    replaceSource(project.source);setFileName(project.fileName);setChartView(project.view??'function');sourceHistory.current=project.sourceHistory??[];
    loadHistory({source:project.source,labelSource:project.labelSource??project.source,language:project.language??'cpp',mode:project.mode,edits:project.edits,captions:project.captions,loopDepth:project.loopDepth,loopOverrides:project.loopOverrides,hiddenBoxes:project.hiddenBoxes,showHiddenBoxes:project.showHiddenBoxes,includeComments:project.includeComments,showLoopLabels:project.showLoopLabels??true,functionPositions:project.functionPositions},project.history);setIsDirty(opened.sourceDirty??opened.dirty??true);setProjectDirty(opened.projectDirty??opened.dirty??true);});
  }).catch(cause=>{if(active){recoveryError.current=true;setDocumentStatus({kind:'error',message:`Recovery could not be opened: ${readError(cause)}. Open a project or start a new one before autosave resumes.`});}}).finally(()=>{if(active)setRecoveryReady(true);});return()=>{active=false;};},[loadHistory]);
  useEffect(()=>{if(!recoveryReady||recoveryError.current)return;const timer=window.setTimeout(()=>{try{void saveRecovery(serializeProject(projectRef.current),projectToken.current,dirtyRef.current,sourceDirtyRef.current,projectDirtyRef.current).catch(cause=>setDocumentStatus({kind:'error',message:`Recovery save failed: ${readError(cause)}`}));}catch(cause){setDocumentStatus({kind:'error',message:`Recovery save failed: ${readError(cause)}`});}},700);return()=>clearTimeout(timer);},[source,fileName,mode,edits,captions,loopDepth,loopOverrides,hiddenBoxes,showHiddenBoxes,functionPositions,history,includeComments,showLoopLabels,isDirty,projectDirty,recoveryReady,language,chartView]);

  useEffect(() => {
    if(isDesktop) return;
    const warn = (event: BeforeUnloadEvent) => { if(isDirty || projectDirty) {event.preventDefault();event.returnValue='';} };
    window.addEventListener('beforeunload',warn); return ()=>window.removeEventListener('beforeunload',warn);
  },[isDirty,projectDirty,isDesktop]);
  useEffect(() => {
    if(!isDesktop) return;
    let disposed=false; let unlisten: (()=>void) | undefined;
    void import('@tauri-apps/api/window').then(({getCurrentWindow})=>{
      const appWindow=getCurrentWindow();
      closeHandlerRef.current=createDesktopCloseHandler({
        recoveryReady:()=>recoveryReadyRef.current,
        snapshot:()=>({contents:serializeProject(projectRef.current),projectToken:projectToken.current,dirty:dirtyRef.current,sourceDirty:sourceDirtyRef.current,projectDirty:projectDirtyRef.current}),
        choose:()=>new Promise<CloseChoice>(resolve=>{closeChoice.current=resolve;setCloseChoiceOpen(true);}),
        save:()=>saveForClose.current(),
        discardRecovery, resumeRecovery,
        saveRecovery:snapshot=>saveRecovery(snapshot.contents,snapshot.projectToken,snapshot.dirty,snapshot.sourceDirty,snapshot.projectDirty),
        destroy:()=>appWindow.destroy(),
        showError:message=>setDocumentStatus({kind:'error',message}),
      });
      return appWindow.onCloseRequested(event=>{event.preventDefault();void closeHandlerRef.current?.();});
    }).then(remove=>{if(disposed) remove();else unlisten=remove;}).catch(cause=>setDocumentStatus({kind:'error',message:`Close handler could not start: ${readError(cause)}`}));
    return ()=>{disposed=true;closeHandlerRef.current=null;unlisten?.();};
  },[isDesktop]);

  useEffect(() => {
    if(!recoveryReady)return;
    analyzeRequest.current++;layoutRequest.current++;
    if((chart.labelSource??source)===source&&((inspectedSource===source&&inspectedLanguage===language)||(pendingInspection?.source===source&&pendingInspection.language===language))){setError('');setIsInspecting(false);return;}
    const request=++inspectRequest.current, session=documentSession.current;
    setIsInspecting(true);
    setSelectedNodeId('');setSelectedLine(null);
    const timer=window.setTimeout(async()=>{
      const valid=()=>request===inspectRequest.current&&sourceRef.current===source&&documentSession.current===session;
      try {
        const found=await inspectCpp(source,language);
        if(!valid())return;
        const state=chartRef.current, previousSource=state.labelSource??source;
        let previousBasisValid=true;
        let previousFunctions=found;
        if(previousSource!==source){
          try{previousFunctions=await inspectCpp(previousSource,language);}
          catch{previousBasisValid=false;previousFunctions=await inspectCpp(previousSource,language,true);}
        }
        if(!valid())return;
        const pairs=matchFunctions(previousFunctions,found);
        const mappings:FunctionMapping[]=[];
        let recalledEdits:ChartEdits={}, recalledCaptions:CaptionSets={};
        if(previousSource!==source){
          const edited=new Set([...Object.keys(state.edits),...Object.keys(state.captions)].map(key=>key.replace(/:(?:overview|detail)$/,''))
            .concat(Object.keys(state.loopOverrides),Object.keys(state.hiddenBoxes),Object.keys(state.functionPositions)));
          for(const [before,after] of pairs){
            if(!edited.has(before.id)){mappings.push({before:before.id,after:after.id,detail:new Map(),overview:new Map(),loops:new Map()});continue;}
            try {
              const [oldGraph,newGraph]=await Promise.all([analyzeCpp(previousSource,before.id,true,language),analyzeCpp(source,after.id,true,language)]);
              mappings.push(mapFunction(before.id,after.id,simplifyGraph(oldGraph),simplifyGraph(newGraph)));
            }catch{
              // An unsupported function must not stop other valid functions from updating.
              mappings.push({before:before.id,after:after.id,detail:new Map(),overview:new Map(),loops:new Map()});
            }
          }
          if(!valid())return;
          labelLibrary.current=[{source:previousSource,language,functions:previousFunctions,state},...labelLibrary.current].slice(0,10);

        }
        // Reuse captions from prior projects only on a fresh document, never overwrite undo snapshots.
        if(!libraryLoaded.current&&isDesktop){
          libraryLoaded.current=true;
          for(const item of (await recentProjects()).slice(0,5))try{
            const project=readProject((await openRecentProject(item.id)).contents);
            if((project.language??'cpp')!==language||(!Object.keys(project.edits).length&&!Object.keys(project.captions).length))continue;
            const savedSource=project.labelSource??project.source, savedFunctions=await inspectCpp(savedSource,language);
            labelLibrary.current.push({source:savedSource,language,functions:savedFunctions,state:{...defaultChartState(),...project,source:savedSource,labelSource:savedSource,language}});
          }catch{/* Missing projects must not block source editing. */}
        }
        if(!valid())return;
        if(pastedSource.current){
          pastedSource.current=false;
          for(const candidate of labelLibrary.current.filter(item=>item.language===language&&item.source!==source)){
            const matches=matchFunctions(candidate.functions,found).filter(([item])=>Object.keys(candidate.state.edits).some(key=>key.startsWith(item.id+':'))||Object.keys(candidate.state.captions).some(key=>key.startsWith(item.id+':')));
            if(!matches.length)continue;
            try{
              const reusedMappings:FunctionMapping[]=[];
              for(const [before,after] of matches){
                const [oldGraph,newGraph]=await Promise.all([analyzeCpp(candidate.source,before.id,true,language),analyzeCpp(source,after.id,true,language)]);
                reusedMappings.push(mapFunction(before.id,after.id,simplifyGraph(oldGraph),simplifyGraph(newGraph)));
              }
              if(!valid())return;
              const reused=remapChart(candidate.state,reusedMappings);
              recalledEdits=mergeNodeRecords(reused.edits,recalledEdits);recalledCaptions=mergeNodeRecords(reused.captions,recalledCaptions);
            }catch{/* A candidate must not block valid source inspection. */}
          }
        }
        if(!valid())return;
        if(!previousBasisValid&&projectRef.current.history){
          // Keep all unmatched legacy records under their original source, never on unrelated new IDs.
          const retained=retainSourceHistory(projectRef.current,{source:previousSource,language,history:projectRef.current.history});
          sourceHistory.current=retained.archives;
          setDocumentStatus({kind:'info',message:'Original labels retained in source history while the repaired chart updates.'});
        }
        setPendingInspection({request,session,source,language,functions:found,pairs});
        if(previousSource!==source||Object.keys(recalledEdits).length||Object.keys(recalledCaptions).length)transformHistory(current=>({...current,revisions:current.revisions.map(revision=>{
          if(revision.id!==current.active||revision.state.source!==source)return revision;
          const basis=revision.state.labelSource??source;
          if(basis!==previousSource&&basis!==source)return revision;
          const mapped=basis===source?revision.state:remapChartForLanguage(revision.state,mappings,language);
          return {...revision,state:{...mapped,source,labelSource:source,language,edits:mergeNodeRecords(recalledEdits,mapped.edits),captions:mergeNodeRecords(recalledCaptions,mapped.captions)}};
        })}));
      }catch(cause){
        if(valid())setError(`${readError(cause)} Showing the last valid chart.`);
      }finally{if(request===inspectRequest.current)setIsInspecting(false);}
    },260);
    return()=>window.clearTimeout(timer);
  },[source,recoveryReady,language,chart.labelSource]);

  useEffect(()=>{
    if(!pendingInspection)return;
    const pending=pendingInspection;
    if(pending.request!==inspectRequest.current||pending.session!==documentSession.current||pending.source!==source||pending.language!==language){setPendingInspection(null);return;}
    if((chart.labelSource??source)!==pending.source){
      if(historyError){setError(`${historyError} Showing the last valid chart.`);setPendingInspection(null);}
      return;
    }
    baseline.current={source:pending.source,language:pending.language,functions:pending.functions,session:pending.session};
    setFunctions(pending.functions);
    setSelectedFunction(current=>pending.pairs.find(([before])=>before.id===current)?.[1].id??(pending.functions.some(item=>item.id===current)?current:pending.functions[0]?.id??''));
    setInspectedSource(pending.source);setInspectedLanguage(pending.language);setError('');setPendingInspection(null);
  },[pendingInspection,source,language,chart.labelSource,historyError]);

  useEffect(() => {
    const request = ++analyzeRequest.current;
    if (!selectedFunction) {
      setIsAnalyzing(false);
      if(inspectedSource===source&&!selectedFunction){setGraph({nodes:[],edges:[],diagnostics:[]});setGraphSource(source);setGraphFunction('');}
      return;
    }
    setIsAnalyzing(true);
    void (async () => {
      try {
        const nextGraph = simplifyGraph(await analyzeCpp(inspectedSource, selectedFunction, true,inspectedLanguage));
        if (request !== analyzeRequest.current) return;
        setGraph(nextGraph); setGraphSource(inspectedSource);setGraphLanguage(inspectedLanguage);setGraphFunction(selectedFunction);

        setError("");

      } catch (cause) {
        if (request !== analyzeRequest.current) return;
        setError(`${readError(cause)} Showing the last valid chart.`);

      } finally {
        if (request === analyzeRequest.current) setIsAnalyzing(false);
      }
    })();
  }, [inspectedSource, inspectedLanguage, selectedFunction, refreshKey]);

  const presentationSource=boardView?inspectedSource:graphSource;
  const presentedState=useRef(chart);
  if((chart.labelSource??source)===presentationSource&&(chart.language??'cpp')===(boardView?inspectedLanguage:graphLanguage))presentedState.current=chart;
  const shown=presentedState.current;
  const loops = useMemo(() => analyzeLoops(graph), [graph]);
  const expandedGraph=useMemo(()=>overviewGraph(graph,{depth:shown.loopDepth,overrides:shown.loopOverrides[graphFunction]??{}}),[graph,shown.loopDepth,shown.loopOverrides,graphFunction]);
  const viewGraph=useMemo(()=>hideGraphNodes(expandedGraph,shown.hiddenBoxes[graphFunction]??[],shown.showHiddenBoxes),[expandedGraph,shown.hiddenBoxes,graphFunction,shown.showHiddenBoxes]);
  const displayedGraph=useMemo(()=>({...viewGraph,nodes:viewGraph.nodes.map(node=>{
    const key=nodePresentationKey(graphFunction,node,shown.loopDepth);
    const presented=presentGraph({...viewGraph,nodes:[node]},shown.mode,shown.includeComments,shown.edits[key],shown.captions[key]).nodes[0];
    return {...presented,unmodified:shown.mode==='natural'&&highlightUnmodified&&shown.edits[key]?.[node.id]?.natural===undefined&&shown.captions[key]?.[node.id]===undefined};
  })}),[viewGraph,shown,graphFunction,highlightUnmodified]);
  const fitKey=functionViewportFitKey({source:graphSource,functionId:graphFunction,loopDepth:shown.loopDepth,loopOverrides:shown.loopOverrides[graphFunction]??{},hiddenNodeIds:shown.hiddenBoxes[graphFunction]??[],showHiddenNodes:shown.showHiddenBoxes});
  const lastFitKey=useRef('');
  useEffect(() => {
    const request = ++layoutRequest.current;
    if (draggingBox.current) return;
    if (!displayedGraph.nodes.length) { setCanvasNodes([]); setCanvasEdges([]); return; }
    const labels=new Map(presentLoopEdgeLabels(displayedGraph,showLoopLabels).edges.map(edge=>[edge.id,edge.label]));
    void layoutGraph(displayedGraph,labels).then(layout => {
      const result=positionedCanvas(layout.nodes,layout.edges,labels);
      if (request !== layoutRequest.current) return;
      setCanvasNodes(result.nodes.map(node=>({...node,selected:node.id===selectedNodeRef.current}))); setCanvasEdges(result.edges.map(edge=>({...edge,label:labels.get(edge.id)??edge.label})));
      if(lastFitKey.current!==fitKey){lastFitKey.current=fitKey;window.setTimeout(()=>{if(request===layoutRequest.current&&!draggingBox.current)void flowRef.current?.fitView({padding:0.12,duration:0});},60);}
    }).catch(cause => { if(request===layoutRequest.current) setError(readError(cause)); });
    return () => { layoutRequest.current++; };
  }, [displayedGraph,fitKey,showLoopLabels,layoutEpoch]);
  useEffect(()=>setCanvasNodes(nodes=>nodes.map(node=>({...node,selected:node.id===selectedNodeId}))),[selectedNodeId]);
  const selectedNode = displayedGraph.nodes.find(node => node.id === selectedNodeId);
  const graphKey = source + '\0' + selectedFunction + '\0' + JSON.stringify([loopDepth,loopOverrides[selectedFunction] ?? {},hiddenBoxes[selectedFunction]??[],showHiddenBoxes]);
  const editKey = selectedNode ? nodePresentationKey(selectedFunction,selectedNode,loopDepth) : selectedFunction + ':overview';
  const editNode = (field: 'code' | 'natural' | 'annotation', text: string) => {
    setEdits(current => ({...current, [editKey]: {...current[editKey], [selectedNodeId]: {...current[editKey]?.[selectedNodeId], [field]: text}}}),field);
    setProjectDirty(true);
  };
  const setLoopExpansion = (id: string, expanded: boolean | undefined) => {
    setLoopOverrides(current=>{
      const next={...(current[selectedFunction] ?? {})};
      if(expanded===false) {
        const header=graph.nodes.find(node=>node.id===id);
        if(header) for(const node of graph.nodes) if(node.id!==id && node.start_byte>=header.start_byte && node.end_byte<=header.end_byte) delete next[node.id];
      }
      if(expanded===undefined) delete next[id];else next[id]=expanded;
      return {...current,[selectedFunction]:next};
    });setProjectDirty(true);
  };
  const changeSource = (text: string) => {
    openRequest.current++;
    setSelectedNodeId('');setSelectedLine(null);change('source',text,'Edit source','source');setIsDirty(true);setProjectDirty(true);
  };
  const saveProject = async (saveAs=false) => {
    if(savingProject.current)return false;savingProject.current=true;
    const session=documentSession.current;
    try {
      const snapshot=serializeProject(projectRef.current,true);
      const saved=await saveProjectDocument(fileName.replace(/\.[^.]+$/,'')+'.codeflow',snapshot,saveAs?null:projectToken.current);
      if(saved.saved){
        if(session===documentSession.current){projectToken.current=saved.projectToken??projectToken.current;const unchanged=serializeProject(projectRef.current,true)===snapshot;if(unchanged){setProjectDirty(false);setIsDirty(false);dirtyRef.current=false;sourceDirtyRef.current=false;projectDirtyRef.current=false;}markSaved();await saveRecovery(serializeProject(projectRef.current),projectToken.current,!unchanged,!unchanged&&sourceDirtyRef.current,!unchanged&&projectDirtyRef.current);}
        setDocumentStatus({kind:saved.warning?'info':'success',message:saved.warning??'Project saved.'});void recentProjects().then(setRecent).catch(()=>undefined);return session===documentSession.current;
      }
    } catch(cause){setDocumentStatus({kind:'error',message:readError(cause)});}finally{savingProject.current=false;}
    return false;
  };
  saveForClose.current=()=>saveProject();
  const confirmReplace=async(message:string)=>isDesktop?(await import('@tauri-apps/plugin-dialog')).confirm(message,{title:'CodeFlow',kind:'warning'}):window.confirm(message);
  const newProject=async()=>{
    if((isDirty||projectDirty)&&!await confirmReplace('Start a new project? Save unsaved work first.'))return;
    if(baseline.current)labelLibrary.current=[{...baseline.current,state:chartRef.current},...labelLibrary.current].slice(0,10);
    sourceHistory.current=[];documentSession.current++;openRequest.current++;saveRequest.current++;projectToken.current=null;recoveryError.current=false;
    replaceSource('');setFileName(language==='cpp'?'untitled.cpp':'untitled.cs');setChartView('function');loadHistory({...defaultChartState(),source:'',labelSource:'',language});setFunctions([]);setSelectedFunction('');setInspectedSource('');setGraph({nodes:[],edges:[],diagnostics:[]});setGraphSource('');setGraphFunction('');setIsDirty(false);setProjectDirty(false);setSelectedNodeId('');setSelectedLine(null);setDocumentStatus({kind:'idle',message:''});
  };

  const selectedName = functions.find((item) => item.id === selectedFunction)?.name ?? "flowchart";
  const lineCount = useMemo(() => source.split("\n").length, [source]);

  const openFile = useCallback(async (file?: File, token:string|null=null, confirmed=false) => {
    if (!file) return;
    try {
      if (!confirmed && (isDirty || projectDirty) && !await confirmReplace('Replace this document? Save source or project first to keep unsaved work.')) return;
      if(file.size > 16 * 1024 * 1024) throw new Error('File is larger than 16 MB.');
      const request = ++openRequest.current;
      const before = projectRef.current;
      const session = documentSession.current;
      const contents = await file.text();
      if(request !== openRequest.current || session !== documentSession.current) return;
      const now = projectRef.current;
      if(before.language!==now.language || before.view!==now.view || before.source!==now.source || before.fileName!==now.fileName || before.edits!==now.edits || before.captions!==now.captions || before.mode!==now.mode || before.loopDepth!==now.loopDepth || before.loopOverrides!==now.loopOverrides || before.hiddenBoxes!==now.hiddenBoxes || before.showHiddenBoxes!==now.showHiddenBoxes || before.functionPositions!==now.functionPositions || before.history!==now.history || before.includeComments!==now.includeComments || before.showLoopLabels!==now.showLoopLabels) {
        setDocumentStatus({kind:'info',message:'Open canceled because the document changed.'}); return;
      }
      inspectRequest.current++;analyzeRequest.current++;
      saveRequest.current += 1;
      if(file.name.endsWith('.codeflow')) {
        const project = readProject(contents);
        const savedFunctions=await inspectCpp(project.labelSource??project.source,project.language).catch(()=>[]);if(request!==openRequest.current||serializeProject(projectRef.current)!==serializeProject(before))return;
        baseline.current={source:project.labelSource??project.source,language:project.language??'cpp',functions:savedFunctions,session:documentSession.current+1};setFunctions(savedFunctions);setInspectedSource(project.labelSource??project.source);setInspectedLanguage(project.language??'cpp');setSelectedFunction(savedFunctions[0]?.id??'');
        replaceSource(project.source);setFileName(project.fileName);setChartView(project.view??'function');sourceHistory.current=project.sourceHistory??[];
        loadHistory({source:project.source,labelSource:project.labelSource??project.source,language:project.language??'cpp',mode:project.mode,edits:project.edits,captions:project.captions,loopDepth:project.loopDepth,loopOverrides:project.loopOverrides,hiddenBoxes:project.hiddenBoxes,showHiddenBoxes:project.showHiddenBoxes,includeComments:project.includeComments,showLoopLabels:project.showLoopLabels??true,functionPositions:project.functionPositions},project.history);
      } else {
        if(new TextEncoder().encode(contents).length > 2 * 1024 * 1024) throw new Error('Source must be smaller than 2 MB.');
        sourceHistory.current=[];replaceSource(contents);setFileName(file.name);setChartView('function');loadHistory({...defaultChartState(),source:contents,labelSource:contents,language:/\.cs$/i.test(file.name)?'csharp':'cpp'});setFunctions([]);setSelectedFunction('');setInspectedSource('');setGraph({nodes:[],edges:[],diagnostics:[]});setGraphSource('');setGraphFunction('');baseline.current=null;
      }
      documentSession.current++;projectToken.current=token;recoveryError.current=false;
      setProjectDirty(false); setSelectedNodeId('');
      setIsDirty(false);
      setSelectedLine(null);
      setError("");
    } catch (cause) {
      setError(readError(cause));
    }
  }, [isDirty, projectDirty,loadHistory]);
  const openChooser=async(id?:string)=>{
    if(!isDesktop){fileInputRef.current?.click();return;}
    if((isDirty||projectDirty)&&!await confirmReplace('Replace this document? Save unsaved work first.'))return;
    const snapshot=serializeProject(projectRef.current);const request=++openRequest.current;
    try{const opened=id?await openRecentProject(id):await openDocument();if(!opened)return;
      if(request!==openRequest.current||serializeProject(projectRef.current)!==snapshot){setDocumentStatus({kind:'info',message:'Open canceled because the document changed.'});return;}
      await openFile(new File([opened.contents],opened.name),opened.projectToken??null,true);if(opened.warning)setDocumentStatus({kind:'info',message:opened.warning});void recentProjects().then(setRecent).catch(()=>undefined);
    }catch(cause){setDocumentStatus({kind:'error',message:readError(cause)});}
  };

  const saveSource = useCallback(async (): Promise<boolean> => {
    const cleanName = fileName.replace(/\s*\*$/, "") || (language==='cpp'?"untitled.cpp":"untitled.cs");
    const contents = source;
    const request = ++saveRequest.current;
    try {
      const saved = await saveDocument(cleanName, contents, language==='cpp'?"cpp":"cs");
      if (request !== saveRequest.current) return saved;
      if (!saved) {
        setDocumentStatus({ kind: "info", message: "Save canceled." });
        return false;
      }
      const savedCurrentSource = sourceRef.current === contents;
      if (savedCurrentSource) {
        setFileName(cleanName);
        setIsDirty(false);
      }
      setDocumentStatus({
        kind: "success",
        message: savedCurrentSource ? "Source saved." : "Source saved; newer edits remain unsaved.",
      });
      return true;
    } catch (cause) {
      if (request !== saveRequest.current) return false;
      setDocumentStatus({ kind: "error", message: `Save failed: ${readError(cause)}` });
      return false;
    }
  }, [fileName, source,language]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (showUpdateDialog||closeChoiceOpen) return;
      if(!recoveryReady)return;
      const direction=historyShortcut(event,event.target);
      if(direction){event.preventDefault();if(historyTarget(history,direction)){navigateHistory(direction);setProjectDirty(true);}return;}
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase()==='y' && event.target instanceof Element && event.target.closest('textarea, input:not([type]), input[type="text"]')) {
        event.preventDefault();
        document.execCommand('redo');
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        void openChooser();
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveProject();
      }
      if (event.key === "Enter") {
        event.preventDefault();
        setRefreshKey((value) => value + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveProject,openChooser,showUpdateDialog,recoveryReady,navigateHistory,history,closeChoiceOpen]);

  const checkForUpdates = useCallback(async () => {
    if (!isDesktop) {
      setUpdateStatus({ kind: "desktop", message: "Updates are available in the desktop app only." });
      return;
    }
    setUpdateStatus({ kind: "checking", message: "Checking for updates…" });
    try {
      if (updateRef.current) await updateRef.current.close();
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check({ timeout: 20_000 });
      updateRef.current = update;
      if (!update) {
        setAvailableUpdate(null);
        setUpdateStatus({ kind: "current", message: "CodeFlow is up to date." });
        return;
      }
      setAvailableUpdate({ currentVersion: update.currentVersion, version: update.version, body: update.body });
      setUpdateStatus({ kind: "available", message: `Version ${update.version} is available.` });
      setShowUpdateDialog(true);
    } catch (cause) {
      updateRef.current = null;
      setUpdateStatus({ kind: "error", message: `Update check failed: ${formatUpdaterError(cause)}` });
    }
  }, [isDesktop]);

  const dismissUpdate = useCallback(() => {
    setShowUpdateDialog(false);
    setAvailableUpdate(null);
    setUpdateStatus({ kind: "idle", message: "" });
    const update = updateRef.current;
    updateRef.current = null;
    if (update) void update.close();
  }, []);

  useEffect(() => {
    if (!showUpdateDialog) return;
    const dialog = updateDialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.requestAnimationFrame(() => dialog?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismissUpdate();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [dismissUpdate, showUpdateDialog]);

  const installUpdate = useCallback(async () => {
    const update = updateRef.current;
    if (!update) return;
    setShowUpdateDialog(false);
    let downloaded = 0;
    let total: number | undefined;
    setUpdateStatus({ kind: "downloading", message: `Downloading version ${update.version}…`, progress: 0 });
    try {
      await saveRecovery(serializeProject(projectRef.current),projectToken.current,dirtyRef.current,sourceDirtyRef.current,projectDirtyRef.current);
      await update.download((event) => {
        if (event.event === "Started") total = event.data.contentLength;
        if (event.event === "Progress") downloaded += event.data.chunkLength;
        if (event.event === "Finished") {
          setUpdateStatus({ kind: "installing", message: "Installing update…" });
          return;
        }
        const progress = total && total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : undefined;
        setUpdateStatus({ kind: "downloading", message: progress === undefined ? "Downloading update…" : `Downloading update… ${progress}%`, progress });
      });
      setUpdateStatus({ kind: "installing", message: "Installing update…" });
      await saveRecovery(serializeProject(projectRef.current),projectToken.current,dirtyRef.current,sourceDirtyRef.current,projectDirtyRef.current);
      await update.install({ restartAfterInstall: true });
      updateRef.current = null;
      setUpdateStatus({ kind: "current", message: "Update installed. Restart CodeFlow if it stays open." });
    } catch (cause) {
      updateRef.current = null;
      void update.close().catch(() => undefined);
      setUpdateStatus({ kind: "error", message: `Update failed: ${formatUpdaterError(cause)}` });
    }
  }, []);

  const revealNode = useCallback((node: CanvasNode) => {
    const editor = textareaRef.current;
    if (!editor) return;
    const { flow } = node.data;
    const start = byteToStringIndex(source, flow.start_byte);
    const end = byteToStringIndex(source, flow.end_byte);
    setSelectedLine(flow.line);
    editor.focus();
    editor.setSelectionRange(start, Math.max(start, end));
    editor.scrollTop = Math.max(0, (flow.line - 1) * 22 - editor.clientHeight * 0.3);
    if (gutterRef.current) gutterRef.current.scrollTop = editor.scrollTop;setSourceScrollTop(editor.scrollTop);
  }, [source]);

  const onNodeClick: NodeMouseHandler<CanvasNode> = useCallback((_event,node)=>{
    setSelectedNodeId(node.id);revealNode(node);
  },[revealNode]);
  const lastCentered=useRef('');
  useEffect(()=>{
    if(chartView!=='function'||!selectedNodeId){lastCentered.current='';return;}
    const key=selectedFunction+'\0'+selectedNodeId+'\0'+sourceFocusRequest;
    const node=canvasNodes.find(item=>item.id===selectedNodeId);
    if(!node||lastCentered.current===key)return;
    const frame=requestAnimationFrame(()=>{
      const instance=flowRef.current,canvas=document.querySelector('.chart-canvas');
      if(!instance||!canvas)return;
      lastCentered.current=key;
      const zoom=instance.getZoom();
      const point=editorAwareCenter({x:node.position.x+(node.width??288)/2,y:node.position.y+(node.height??80)/2},canvas.getBoundingClientRect(),document.querySelector('.node-editor')?.getBoundingClientRect()??null,zoom);
      void instance.setCenter(point.x,point.y,{zoom,duration:window.matchMedia('(prefers-reduced-motion: reduce)').matches?0:150});
    });return()=>cancelAnimationFrame(frame);
  },[chartView,selectedFunction,selectedNodeId,canvasNodes,sourceFocusRequest]);
  const moveBox=(event:MouseEvent|TouchEvent,node:CanvasNode)=>{
    const current=liveCanvas.current;
    const snapped=snapBoxPosition(current.nodes,node.id,node.position,flowRef.current?.getZoom()??1,'shiftKey' in event&&event.shiftKey);
    const moved=current.nodes.map(item=>item.id===node.id?{...item,position:snapped.position,dragging:true,data:{...item.data,flow:{...item.data.flow,position:snapped.position}}}:item);
    const next=positionedCanvas(moved,current.edges,new Map(),new Set([node.id]));
    liveCanvas.current=next;setCanvasNodes(next.nodes);setCanvasEdges(next.edges);setAlignmentGuides(snapped.guides);
    return snapped.position;
  };
  const saveBoxPosition=(functionId:string,node:CanvasNode,position:{x:number;y:number})=>{
    const key=nodePresentationKey(functionId,node.data.flow,loopDepth);
    change('edits',current=>({...current,[key]:{...current[key],[node.data.flow.id]:{...current[key]?.[node.data.flow.id],position}}}),'Move box');setProjectDirty(true);
  };
  const clickCode=(editor:HTMLTextAreaElement)=>{
    if(editor.selectionStart!==editor.selectionEnd)return;
    const byte=new TextEncoder().encode(source.slice(0,editor.selectionStart)).length;
    pendingCode.current={source,byte};setSourceFocusRequest(value=>value+1);
  };
  useEffect(()=>{
    const pending=pendingCode.current;if(!pending)return;
    if(pending.source!==source){pendingCode.current=null;return;}
    if(inspectedSource!==source||inspectedLanguage!==language)return;
    const info=functionAtByte(functions,pending.byte);if(!info){pendingCode.current=null;return;}
    if(fileView)setChartView('function');
    if(selectedFunction!==info.id){setSelectedFunction(info.id);return;}
    if(graphSource!==source||graphFunction!==info.id)return;
    const node=nodeAtByte(displayedGraph.nodes,pending.byte);pendingCode.current=null;
    if(node){setSelectedNodeId(node.id);setSelectedLine(node.line);}
  },[source,sourceFocusRequest,functions,inspectedSource,inspectedLanguage,language,graphSource,graphFunction,selectedFunction,displayedGraph,fileView]);
  const lastProgramSelection=useRef('');
  useEffect(()=>{
    if(chartView!=='program'||!selectedNodeId){lastProgramSelection.current='';return;}
    const key=selectedFunction+'\0'+selectedNodeId;if(lastProgramSelection.current===key)return;
    const node=canvasNodes.find(item=>item.id===selectedNodeId);if(!node||graphFunction!==selectedFunction)return;
    lastProgramSelection.current=key;revealNode(node);
  },[chartView,selectedFunction,selectedNodeId,graphFunction,canvasNodes,revealNode]);
  const clearSelection=()=>{setSelectedNodeId('');setSelectedLine(null);const editor=textareaRef.current;if(editor)editor.setSelectionRange(editor.selectionEnd,editor.selectionEnd);};
  const highlightStart=selectedNode?source.slice(0,byteToStringIndex(source,selectedNode.start_byte)).split('\n').length-1:0;
  const highlightLines=selectedNode?Math.max(1,source.slice(byteToStringIndex(source,selectedNode.start_byte),byteToStringIndex(source,selectedNode.end_byte)).split('\n').length):0;

  const exportGraph = useCallback(async (format:'svg'|'png'='svg') => {
    const theme=THEMES.find(theme=>theme.id===exportTheme);
    const basePalette=theme?svgPaletteFromTheme(theme):svgPaletteFromCss();
    const palette={...basePalette,background:exportTransparent?'transparent':basePalette.background};
    if(boardView&&exportTransparent&&!boardRenderer.current)return;
    const svg = boardView ? (boardRenderer.current?.(palette)??boardSvg) : createSvgDocument(canvasNodes, canvasEdges, mode,palette);
    if (!svg) return;
    try {
      const saved = await saveDocument(svgDocumentName(selectedName),format==='png'?await createPngDataUrl(svg):svg,format);
      setDocumentStatus(saved
        ? { kind: "success", message: "Flowchart exported.", action: 'reveal-export' }
        : { kind: "info", message: "Export canceled." });
    } catch (cause) {
      setDocumentStatus({ kind: "error", message: `Export failed: ${readError(cause)}` });
    }
  }, [canvasNodes, canvasEdges, selectedName, mode,boardView,boardSvg,exportTheme,exportTransparent]);

  const revealExport=()=>void revealLastExport().catch(cause=>setDocumentStatus({kind:'error',message:`Could not show export: ${readError(cause)}`}));
  const statusText = error
    ? error
    : isInspecting || isAnalyzing
      ? `Analyzing ${language==='cpp'?'C++':'C#'}…`
      : functions.length === 0
        ? "No functions found"
        : boardView ? `${functions.length} functions` : `${viewGraph.nodes.length} boxes · ${viewGraph.edges.length} paths`;

  return (
    <main inert={!recoveryReady} className={`app-shell mode-${mode}`}>
      <AppToolbar language={language} onLanguageChange={next=>{
        if(next===language)return;
        setBoardSvg('');
        if(baseline.current)labelLibrary.current=[{...baseline.current,state:chartRef.current},...labelLibrary.current].slice(0,10);
        documentSession.current++;inspectRequest.current++;analyzeRequest.current++;baseline.current=null;libraryLoaded.current=false;
        changeFields({source,labelSource:source,language:next},'Source language');setFileName(name=>name.replace(/\.(?:cpp|cc|cxx|cs)$/i,next==='cpp'?'.cpp':'.cs'));
        setFunctions([]);setSelectedFunction('');setInspectedSource('');setShowAI(false);clearSelection();setProjectDirty(true);
      }} recentProjects={recent} onNewProject={()=>void newProject()} onOpen={()=>void openChooser()} onOpenRecent={id=>void openChooser(id)}
        onSaveSource={()=>void saveSource()} onSaveProject={()=>void saveProject()} onSaveAs={()=>void saveProject(true)}
        onAnalyze={()=>setRefreshKey(value=>value+1)} onExportSvg={()=>void exportGraph()} onExportPng={()=>void exportGraph('png')}
        onCheckUpdates={()=>void checkForUpdates()} transparency={transparency} onTransparencyChange={setTransparency}
        onFullscreenError={message=>setDocumentStatus({kind:'error',message})} exportTheme={exportTheme} onExportThemeChange={setExportTheme} exportTransparent={exportTransparent} onExportTransparentChange={setExportTransparent}
        recoveryReady={recoveryReady} exportReady={inspectedSource===source&&!isAnalyzing&&(boardView?!!boardSvg:graphSource===source&&graphFunction===selectedFunction&&canvasNodes.length>0)}
        updateBusy={['checking','downloading','installing'].includes(updateStatus.kind)}/>
      <input ref={fileInputRef} className="visually-hidden" type="file" accept=".codeflow,.cpp,.cc,.cxx,.h,.hh,.hpp,.hxx,.cs,text/plain" onChange={event=>void openFile(event.target.files?.[0])}/>


      {updateStatus.kind !== "idle" && (
        <aside className={`update-banner update-banner--${updateStatus.kind}`} role={updateStatus.kind === "error" ? "alert" : "status"} aria-live="polite">
          <div>
            <strong>{updateStatus.kind === "error" ? "Updater" : "CodeFlow update"}</strong>
            <span>{updateStatus.message}</span>
            {updateStatus.kind === "downloading" && <span className="update-progress"><span style={{ width: updateStatus.progress === undefined ? "32%" : `${updateStatus.progress}%` }} /></span>}
          </div>
          {updateStatus.kind === "available" && <button className="button" onClick={() => setShowUpdateDialog(true)}>Review</button>}
          {!["checking", "downloading", "installing"].includes(updateStatus.kind) && (
            <button className="icon-button" aria-label="Dismiss update status" onClick={updateStatus.kind === "available" ? dismissUpdate : () => setUpdateStatus({ kind: "idle", message: "" })}><Icon name="close" /></button>
          )}
        </aside>
      )}

      {documentStatus.kind !== "idle" && (
        <aside className={`document-banner document-banner--${documentStatus.kind}`} role={documentStatus.kind === "error" ? "alert" : "status"} aria-live="polite" onClick={documentStatus.action==='reveal-export'?revealExport:undefined}>
          {documentStatus.action==='reveal-export'?<button className="document-banner__action" onClick={event=>{event.stopPropagation();revealExport();}} title="Show exported file">{documentStatus.message}</button>:<span>{documentStatus.message}</span>}
          <button className="icon-button" aria-label="Dismiss save status" onClick={event=>{event.stopPropagation();setDocumentStatus({ kind: "idle", message: "" });}}><Icon name="close" /></button>
        </aside>
      )}

      <section className="workspace">
        <section
          className="panel source-panel"
          onDragOver={(event) => { event.preventDefault(); event.currentTarget.classList.add("is-dragging"); }}
          onDragLeave={(event) => event.currentTarget.classList.remove("is-dragging")}
          onDrop={(event) => {
            event.preventDefault();
            event.currentTarget.classList.remove("is-dragging");
            void openFile(event.dataTransfer.files[0]);
          }}
        >
          <div className="panel__header">
            <div className="file-name"><span className="file-name__dot" /><input aria-label={language==='cpp'?"C++ filename":"C# filename"} value={fileName} maxLength={240} onChange={e=>{setFileName(e.target.value);setProjectDirty(true);}} onBlur={()=>{if(!fileName.trim())setFileName(language==='cpp'?'untitled.cpp':'untitled.cs');}}/>{isDirty || projectDirty ? " *" : ""}</div>
            <span className="panel__hint">Drop or paste {language==='cpp'?'C++':'C#'}</span>
          </div>
          <div className="editor-wrap">
            {selectedNode && <div className="source-highlight" aria-hidden="true" style={{top:18+highlightStart*22-sourceScrollTop,height:highlightLines*22}}/>}
            <div className="line-numbers" ref={gutterRef} aria-hidden="true">
              {Array.from({ length: lineCount }, (_, index) => (
                <div className={selectedLine === index + 1 ? "is-selected" : ""} key={index + 1}>{index + 1}</div>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              aria-label={language==='cpp'?"C++ source code":"C# source code"}
              value={source}
              data-document-history
              spellCheck={false}
              disabled={!recoveryReady}
              onPaste={()=>{pastedSource.current=true;}}
              onChange={(event) => changeSource(event.target.value)}
              onClick={event=>clickCode(event.currentTarget)}
              onScroll={(event) => { if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;setSourceScrollTop(event.currentTarget.scrollTop); }}
            />
          </div>
          <div className="source-footer">
            {!isDesktop && <span className="desktop-update-note">Updates: desktop only</span>}
            {projectDirty && <span>Project unsaved</span>}
            <span>{lineCount} lines</span>
            <span>UTF-8</span>
          </div>
        </section>

        <section className="panel chart-panel">
          <div className="chart-options">
            <label>View <select aria-label="Chart view" value={chartView} onChange={event=>{boardRenderer.current=null;setChartView(event.target.value as ChartView);setBoardSvg('');setShowAI(false);clearSelection();setProjectDirty(true);}}><option value="function">Function</option><option value="file">File map</option><option value="program">Whole program</option></select></label>
            <label>Labels <select aria-label="Label mode" value={mode} onChange={e=>{setMode(e.target.value as ChartMode);setProjectDirty(true);}}><option value="natural">Natural language</option><option value="code">Code</option></select></label>
            <label>Loop depth <select aria-label="Loop expansion depth" value={loopDepth ?? 'all'} onChange={e=>{changeFields({loopDepth:e.target.value==='all'?null:Number(e.target.value),loopOverrides:{}},'Loop depth');setProjectDirty(true);}}>
              <option value="0">0 · overview</option>
              {Array.from({length:Math.max(3,loopDepth ?? 0,...loops.map(loop=>loop.depth+1))},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}
              <option value="all">All</option>
            </select></label>
            <ChartTools localAIActive={showAI} localAIDisabled={fileView} highlightUnmodified={highlightUnmodified} showLoopLabels={showLoopLabels}
              canUndo={!!history.revisions.find(r=>r.id===history.active)?.parent} historyOpen={showHistory}
              onToggleLocalAI={()=>setShowAI(value=>!value)} onHighlightUnmodifiedChange={setHighlightUnmodified}
              onShowLoopLabelsChange={value=>{change('showLoopLabels',value,'Loop labels');setProjectDirty(true);}}
              onUndo={()=>{navigateHistory('undo');setProjectDirty(true);}}
              onToggleHistory={()=>setShowHistory(value=>!value)} onAlternate={()=>{createAlternate();setProjectDirty(true);}}
              onResetChart={()=>{resetChart();clearSelection();setProjectDirty(true);}}/>
          </div>
          <div className="chart-toolbar">
            <label className="field">
              <span>Function</span>
              <select value={selectedFunction} onChange={(event) => {setSelectedFunction(event.target.value);setSelectedNodeId('');}} disabled={functions.length === 0}>
                {functions.length === 0 && <option value="">No functions</option>}
                {functions.map((item) => <option value={item.id} key={item.id}>{item.name} · line {item.line}</option>)}
              </select>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={includeComments} onChange={(event) => {change('includeComments',event.target.checked,'Comments');setProjectDirty(true);}} />
              <span className="toggle__track"><span /></span>
              <span>Comments</span>
            </label>
            <label className="toggle"><input aria-label="Show hidden boxes" type="checkbox" checked={showHiddenBoxes} onChange={event=>{change('showHiddenBoxes',event.target.checked,'Show hidden boxes');setProjectDirty(true);}}/><span className="toggle__track"><span/></span><span>Show hidden boxes</span></label>
          </div>

          <div className="chart-canvas" inert={inspectedSource!==source||inspectedLanguage!==language||isInspecting||isAnalyzing||(!boardView&&(graphSource!==source||graphFunction!==selectedFunction))} aria-busy={isInspecting||isAnalyzing}>
            {chartView==='program' && functions.length ? <ProgramBoard source={inspectedSource} language={inspectedLanguage} functions={functions} mode={shown.mode}
              includeComments={shown.includeComments} showLoopLabels={shown.showLoopLabels} loopDepth={shown.loopDepth} loopOverrides={shown.loopOverrides} edits={shown.edits} captions={shown.captions} hiddenBoxes={shown.hiddenBoxes} showHiddenBoxes={shown.showHiddenBoxes}
              highlightUnmodified={highlightUnmodified} positions={shown.functionPositions} onPositions={next=>{change('functionPositions',next,'Arrange program');setProjectDirty(true);}}
              onSelect={({functionId,nodeId})=>{setSelectedFunction(functionId);setSelectedNodeId(nodeId??'');setShowAI(false);if(!nodeId)setChartView('function');}}
              focusRequest={sourceFocusRequest} onBoxPosition={saveBoxPosition} selectedFunctionId={selectedFunction} selectedNodeId={selectedNodeId} onClearSelection={clearSelection}
              onExportReady={onBoardExport}/> : fileView && functions.length ? <FunctionBoard language={inspectedLanguage} source={inspectedSource} functions={functions} mode={shown.mode} highlightUnmodified={highlightUnmodified} includeComments={shown.includeComments} showLoopLabels={shown.showLoopLabels} loopDepth={shown.loopDepth} loopOverrides={shown.loopOverrides} edits={shown.edits} captions={shown.captions} hiddenBoxes={shown.hiddenBoxes} showHiddenBoxes={shown.showHiddenBoxes} positions={shown.functionPositions} onPositions={next=>{change('functionPositions',next,'Arrange functions');setProjectDirty(true);}} onOpenFunction={id=>{setSelectedFunction(id);setChartView('function');clearSelection();}} onExportReady={onBoardExport}/> : canvasNodes.length > 0 ? (
              <ReactFlow<CanvasNode>
                nodes={canvasNodes}
                edges={canvasEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onInit={(instance) => { flowRef.current = instance; }}
                onNodeClick={onNodeClick}
                onNodesChange={changes=>setCanvasNodes(nodes=>applyNodeChanges(changes.filter(change=>change.type!=='position'&&change.type!=='remove'),nodes))}
                onNodeDragStart={()=>{draggingBox.current=true;layoutRequest.current++;}}
                onNodeDrag={moveBox}
                onNodeDragStop={(event,node)=>{const position=moveBox(event,node);draggingBox.current=false;setLayoutEpoch(value=>value+1);setAlignmentGuides([]);setCanvasNodes(nodes=>nodes.map(item=>({...item,dragging:false})));saveBoxPosition(selectedFunction,node,position);}}
                onPaneClick={clearSelection}
                fitView
                fitViewOptions={{ padding: 0.18 }}
                minZoom={0.18}
                maxZoom={1.8}
                nodesDraggable
                nodesConnectable={false}
                elementsSelectable
                proOptions={{ hideAttribution: true }}
              >
                <AlignmentGuides guides={alignmentGuides}/>
                <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="var(--line)" />
                <Controls showInteractive={false} position="bottom-right" />
                <MiniMap
                  position="bottom-left"
                  style={{width:120,height:78}}
                  pannable
                  zoomable
                  nodeColor="var(--line-strong)"
                  maskColor="color-mix(in srgb, var(--panel) 70%, transparent)"
                  offsetScale={0}
                />
              </ReactFlow>
            ) : (
              <div className="empty-state">
                <div className="empty-state__glyph"><span /><span /><span /></div>
                <strong>{error ? "Couldn’t build chart" : "Add code"}</strong>
                <span>{error || "Open a file or paste source to see its control flow."}</span>
              </div>
            )}
            {(isInspecting || isAnalyzing) && <div className="analysis-progress"><span /></div>}
      {showAI && <LocalAI graph={displayedGraph} source={source} graphKey={graphKey} proposalKey={JSON.stringify(displayedGraph.nodes.map(node=>[node.id,node.label]))} onClose={()=>setShowAI(false)} onCaptions={(next,key)=>{
        if(key!==graphKey) return;
        setEdits(current=>{const result={...current};for(const node of viewGraph.nodes){if(next[node.id]===undefined)continue;const key=nodePresentationKey(selectedFunction,node,loopDepth);result[key]={...result[key],[node.id]:{...result[key]?.[node.id],natural:next[node.id]}};}return result;});setMode('natural');setProjectDirty(true);
      }}/>}
      {selectedNode && !showAI && <aside className="node-editor" aria-label="Edit flowchart box" data-chart-history>
        <header><strong>Box · line {selectedNode.line}</strong><button className="button" onClick={clearSelection}>Close</button></header>
        {selectedNode.loop_id && <div className="loop-actions">
          <strong>Loop level {(selectedNode.loop_depth ?? 0)+1}</strong>
          {selectedNode.loop_can_collapse ? <button className="button" onClick={()=>setLoopExpansion(selectedNode.loop_id!,!!selectedNode.loop_collapsed)}>{selectedNode.loop_collapsed?'Expand this loop':'Collapse this loop'}</button> : <span>Terminal paths require this loop to stay expanded.</span>}
          {loopOverrides[selectedFunction]?.[selectedNode.loop_id]!==undefined && <button className="button" onClick={()=>setLoopExpansion(selectedNode.loop_id!,undefined)}>Follow global depth</button>}
          {selectedNode.kind === 'loop' && <>
          <label>Looping arrow<input aria-label="Looping arrow label" maxLength={2000} value={selectedNode.loopContinueLabel??''} placeholder="Default" onChange={event=>{setEdits(current=>({...current,[editKey]:{...current[editKey],[selectedNodeId]:{...current[editKey]?.[selectedNodeId],loopContinueLabel:event.target.value||undefined}}}),'loopContinueLabel');setProjectDirty(true);}}/></label>
          <label>Exit arrow<input aria-label="Exit arrow label" maxLength={2000} value={selectedNode.loopExitLabel??''} placeholder="Default" onChange={event=>{setEdits(current=>({...current,[editKey]:{...current[editKey],[selectedNodeId]:{...current[editKey]?.[selectedNodeId],loopExitLabel:event.target.value||undefined}}}),'loopExitLabel');setProjectDirty(true);}}/></label>
          </>}
        </div>}
        {selectedNode.kind==='decision'&&<div className="loop-actions">
          <label>True arrow<input aria-label="True arrow label" maxLength={2000} value={selectedNode.trueLabel??''} placeholder="True" onChange={event=>{setEdits(current=>({...current,[editKey]:{...current[editKey],[selectedNodeId]:{...current[editKey]?.[selectedNodeId],trueLabel:event.target.value||undefined}}}),'trueLabel');setProjectDirty(true);}}/></label>
          <label>False arrow<input aria-label="False arrow label" maxLength={2000} value={selectedNode.falseLabel??''} placeholder="False" onChange={event=>{setEdits(current=>({...current,[editKey]:{...current[editKey],[selectedNodeId]:{...current[editKey]?.[selectedNodeId],falseLabel:event.target.value||undefined}}}),'falseLabel');setProjectDirty(true);}}/></label>
        </div>}
        <label>{mode==='code'?'Code label':'Natural language label'}<textarea aria-label="Box label" maxLength={2000} value={selectedNode.label} onChange={e=>editNode(mode,e.target.value)}/></label>
        <label className="flag-box"><input type="checkbox" checked={selectedNode.flagged??false} onChange={event=>{setEdits(current=>({...current,[editKey]:{...current[editKey],[selectedNodeId]:{...current[editKey]?.[selectedNodeId],flagged:event.target.checked}}}));setProjectDirty(true);}}/> Flag for removal</label>
        <label className="flag-box"><input type="checkbox" checked={selectedNode.flaggedForUpdate??false} onChange={event=>{setEdits(current=>({...current,[editKey]:{...current[editKey],[selectedNodeId]:{...current[editKey]?.[selectedNodeId],flaggedForUpdate:event.target.checked}}}));setProjectDirty(true);}}/> Flag for update</label>
        <label>Annotation<textarea aria-label="Box annotation" maxLength={2000} value={selectedNode.annotation ?? ''} onChange={e=>editNode('annotation',e.target.value)}/></label>
        <details><summary>Original {language==='cpp'?'C++':'C#'}</summary><pre>{source.slice(byteToStringIndex(source,selectedNode.start_byte),byteToStringIndex(source,selectedNode.end_byte))}</pre></details>
        {!['start','end','return','throw'].includes(selectedNode.kind) && <button className="button" onClick={()=>{change('hiddenBoxes',current=>{const list=current[selectedFunction]??[];return {...current,[selectedFunction]:list.includes(selectedNode.id)?list.filter(id=>id!==selectedNode.id):[...list,selectedNode.id]};},selectedNode.hidden?'Restore box':'Hide box');setProjectDirty(true);setSelectedNodeId('');}}>{selectedNode.hidden?'Restore box':'Hide box'}</button>}
        <button className="button" onClick={()=>{setEdits(current=>{const next={...current,[editKey]:{...current[editKey]}};delete next[editKey][selectedNodeId];return next;});setProjectDirty(true);}}>Reset box</button>
      </aside>}

          </div>

          <div className={`chart-status ${error ? "chart-status--error" : ""}`}>
            <span className={`status-dot ${isInspecting || isAnalyzing ? "is-busy" : ""}`} />
            <span>{statusText}</span>
            {graph.diagnostics.length > 0 && !error && <span className="diagnostic" title={graph.diagnostics.join("\n")}>{graph.diagnostics[0]}</span>}
          </div>
        </section>
      </section>

      {closeChoiceOpen && <CloseDialog onChoose={finishCloseChoice}/>}
      {showHistory && <HistoryPanel history={history} onSelect={id=>{selectRevision(id);setProjectDirty(true);}} onClose={()=>setShowHistory(false)}/>}
      {showUpdateDialog && availableUpdate && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) dismissUpdate(); }}>
          <section ref={updateDialogRef} tabIndex={-1} className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title" aria-describedby="update-warning">
            <div className="update-dialog__icon"><Icon name="update" /></div>
            <div className="update-dialog__content">
              <span className="update-dialog__eyebrow">Update available</span>
              <h2 id="update-title">CodeFlow {availableUpdate.version}</h2>
              <p>Installed version: {availableUpdate.currentVersion}</p>
              {availableUpdate.body && <div className="release-notes">{availableUpdate.body}</div>}
              <p className="update-warning" id="update-warning"><strong>Recovery is saved before installation.</strong> Installing closes CodeFlow, then restores this project in the updated app.</p>
              {(isDirty || projectDirty) && <p className="unsaved-warning">Unsaved edits will be included in the recovery copy.</p>}
              <div className="update-dialog__actions">
                <button className="button" onClick={dismissUpdate}>Not now</button>
                <button className="button" onClick={() => void saveProject()}><Icon name="save" /> Save project</button>
                <button className="button button--primary" onClick={() => void installUpdate()}><Icon name="update" /> Install update</button>
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function byteToStringIndex(source: string, byteOffset: number): number {
  const bytes = new TextEncoder().encode(source);
  return new TextDecoder().decode(bytes.slice(0, Math.max(0, Math.min(byteOffset, bytes.length)))).length;
}

function readError(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "Analysis failed";
}

function mergeNodeRecords<T>(saved:Record<string,Record<string,T>>,current:Record<string,Record<string,T>>):Record<string,Record<string,T>>{
 const result={...saved};for(const [key,nodes]of Object.entries(current)){
  result[key]={...result[key]};for(const [id,item]of Object.entries(nodes)){
   const savedItem=result[key][id];result[key][id]=typeof item==='object'&&item!==null&&typeof savedItem==='object'&&savedItem!==null?{...savedItem,...item}:item;
  }
 }return result;
}
