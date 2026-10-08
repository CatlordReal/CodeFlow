import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type NodeMouseHandler,
  type ReactFlowInstance,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { analyzeCpp, inspectCpp, openDocument, openRecentProject, recentProjects, readRecovery, saveRecovery, saveDocument, saveProjectDocument, type RecentProject } from "./api";
import FlowNodeCard from "./FlowNodeCard";
import { createPngDataUrl, createSvgDocument, svgPaletteFromCss, svgDocumentName } from "./exportSvg";
import { edgeTypes, layoutGraph, type CanvasNode } from "./layout";
import { formatUpdaterError } from "./update";
import ThemePicker from "./ThemePicker";
import LocalAI from "./LocalAI";
import { analyzeLoops, overviewGraph, simplifyGraph } from "./simplify";
import { hideGraphNodes, nodePresentationKey, presentGraph, presentLoopEdgeLabels, readProject, type ChartMode, type ChartEdits, type CaptionSets, type LoopOverrides, type Project } from "./presentation";
import "./editing.css";
import {defaultChartState,useChartHistory} from "./history";
import HistoryPanel from "./HistoryPanel";
import FunctionBoard from "./FunctionBoard";
import {mapFunction,matchFunctions,remapChart,type FunctionMapping} from './preservation';
import type {ChartState} from './history';
import { SAMPLE_CPP } from "./sample";
import type { FlowGraph, FunctionInfo } from "./types";
import { createDesktopCloseHandler } from "./close";

const nodeTypes = { flowNode: FlowNodeCard };

type UpdateStatus = {
  kind: "idle" | "checking" | "current" | "available" | "downloading" | "installing" | "error" | "desktop";
  message: string;
  progress?: number;
};

type DocumentStatus = { kind: "idle" | "success" | "info" | "error"; message: string };

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
  const [source, setSource] = useState(SAMPLE_CPP);
  const [fileName, setFileName] = useState("untitled.cpp");
  const [isDirty, setIsDirty] = useState(true);
  const [functions, setFunctions] = useState<FunctionInfo[]>([]);
  const [selectedFunction, setSelectedFunction] = useState("");
  const [inspectedSource, setInspectedSource] = useState("");
  const [includeComments, setIncludeComments] = useState(false);
  const {state:chart,history,change,load:loadHistory,select:selectRevision,reset:resetChart,alternate:createAlternate,remap:remapHistory,markSaved}=useChartHistory();
  const {loopDepth,loopOverrides,mode,edits,captions,hiddenBoxes,showHiddenBoxes,functionPositions}=chart;
  const expandLoops=loopDepth===null;
  const setLoopDepth=(value:number|null)=>change('loopDepth',value,'Loop depth');
  const setLoopOverrides=(value:LoopOverrides|((v:LoopOverrides)=>LoopOverrides))=>change('loopOverrides',value,'Loop expansion');
  const setMode=(value:ChartMode)=>change('mode',value,'Label mode');
  const setEdits=(value:ChartEdits|((v:ChartEdits)=>ChartEdits))=>change('edits',value,'Edit box',`edit:${selectedFunction}:${selectedNodeId}`);
  const setCaptions=(value:CaptionSets|((v:CaptionSets)=>CaptionSets))=>change('captions',value,'AI captions');
  const [showHistory,setShowHistory]=useState(false);
  const [fileView,setFileView]=useState(false);
  const [highlightUnmodified,setHighlightUnmodified]=useState(false);
  const [boardSvg,setBoardSvg]=useState('');
  const baseline=useRef<{source:string;functions:FunctionInfo[];session:number}|null>(null);
  const labelLibrary=useRef<{source:string;functions:FunctionInfo[];state:ChartState}[]>([]);
  const chartRef=useRef(chart);chartRef.current=chart;
  const libraryLoaded=useRef(false);
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
  const [showAI, setShowAI] = useState(false);
  const [projectDirty, setProjectDirty] = useState(false);
  const layoutRequest = useRef(0);
  const [graphSource, setGraphSource] = useState('');
  const [graphFunction, setGraphFunction] = useState('');
  const openRequest = useRef(0);
  const [graph, setGraph] = useState<FlowGraph>({ nodes: [], edges: [], diagnostics: [] });
  const [canvasNodes, setCanvasNodes] = useState<CanvasNode[]>([]);
  const [canvasEdges, setCanvasEdges] = useState<Edge[]>([]);
  const [isInspecting, setIsInspecting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState("");
  const [selectedLine, setSelectedLine] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ kind: "idle", message: "" });
  const [availableUpdate, setAvailableUpdate] = useState<{ currentVersion: string; version: string; body?: string } | null>(null);
  const [showUpdateDialog, setShowUpdateDialog] = useState(false);
  const [documentStatus, setDocumentStatus] = useState<DocumentStatus>({ kind: "idle", message: "" });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const flowRef = useRef<ReactFlowInstance<CanvasNode> | null>(null);
  const inspectRequest = useRef(0);
  const analyzeRequest = useRef(0);
  const updateRef = useRef<Update | null>(null);
  const updateDialogRef = useRef<HTMLElement>(null);
  const closeHandlerRef = useRef<(() => Promise<void>) | null>(null);
  const sourceRef = useRef(source);
  const saveRequest = useRef(0);
  const replaceSource=useCallback((text:string)=>{inspectRequest.current++;analyzeRequest.current++;layoutRequest.current++;sourceRef.current=text;setSource(text);},[]);
  const isDesktop = "__TAURI_INTERNALS__" in window;
  sourceRef.current = source;dirtyRef.current=isDirty||projectDirty;sourceDirtyRef.current=isDirty;projectDirtyRef.current=projectDirty;recoveryReadyRef.current=recoveryReady;
  const projectRef = useRef<Project>({format:'codeflow',version:1,source,fileName,mode,edits,captions,expandLoops,includeComments,loopDepth,loopOverrides,hiddenBoxes,showHiddenBoxes,functionPositions,history});
  projectRef.current = {format:'codeflow',version:1,source,fileName,mode,edits,captions,expandLoops,includeComments,loopDepth,loopOverrides,hiddenBoxes,showHiddenBoxes,functionPositions,history,labelSource:baseline.current?.session===documentSession.current?baseline.current.source:source};
  useEffect(()=>{document.documentElement.style.setProperty('--surface-opacity',`${100-transparency}%`);try{localStorage.setItem('codeflow.transparency',String(transparency));}catch{}},[transparency]);
  useEffect(()=>{if(documentStatus.kind!=='success')return;const timer=window.setTimeout(()=>setDocumentStatus({kind:'idle',message:''}),3000);return()=>clearTimeout(timer);},[documentStatus]);
  useEffect(()=>{void recentProjects().then(setRecent).catch(()=>undefined);},[]);
  useEffect(()=>{let active=true;const session=documentSession.current;void readRecovery().then(opened=>{
    if(!active||!opened||documentSession.current!==session)return;const project=readProject(opened.contents);return inspectCpp(project.labelSource??project.source).then(savedFunctions=>{if(!active||documentSession.current!==session)return;baseline.current={source:project.labelSource??project.source,functions:savedFunctions,session};projectToken.current=opened.projectToken??null;
    replaceSource(project.source);setFileName(project.fileName);setIncludeComments(project.includeComments);
    loadHistory({mode:project.mode,edits:project.edits,captions:project.captions,loopDepth:project.loopDepth,loopOverrides:project.loopOverrides,hiddenBoxes:project.hiddenBoxes,showHiddenBoxes:project.showHiddenBoxes,functionPositions:project.functionPositions},project.history);setIsDirty(opened.sourceDirty??opened.dirty??true);setProjectDirty(opened.projectDirty??opened.dirty??true);});
  }).catch(cause=>{if(active){recoveryError.current=false;setDocumentStatus({kind:'error',message:`Recovery could not be opened: ${readError(cause)}`});}}).finally(()=>{if(active)setRecoveryReady(true);});return()=>{active=false;};},[loadHistory]);
  useEffect(()=>{if(!recoveryReady||recoveryError.current)return;const timer=window.setTimeout(()=>{void saveRecovery(JSON.stringify(projectRef.current),projectToken.current,dirtyRef.current,sourceDirtyRef.current,projectDirtyRef.current).catch(cause=>setDocumentStatus({kind:'error',message:`Recovery save failed: ${readError(cause)}`}));},700);return()=>clearTimeout(timer);},[source,fileName,mode,edits,captions,loopDepth,loopOverrides,hiddenBoxes,showHiddenBoxes,functionPositions,history,includeComments,isDirty,projectDirty,recoveryReady]);

  useEffect(() => {
    if(isDesktop) return;
    const warn = (event: BeforeUnloadEvent) => { if(isDirty || projectDirty) {event.preventDefault();event.returnValue='';} };
    window.addEventListener('beforeunload',warn); return ()=>window.removeEventListener('beforeunload',warn);
  },[isDirty,projectDirty,isDesktop]);
  useEffect(() => {
    if(!isDesktop) return;
    let disposed=false; let unlisten: (()=>void) | undefined;
    void Promise.all([import('@tauri-apps/api/window'),import('@tauri-apps/plugin-dialog')]).then(([{getCurrentWindow},{confirm}])=>{
      const appWindow=getCurrentWindow();
      closeHandlerRef.current=createDesktopCloseHandler({
        recoveryReady:()=>recoveryReadyRef.current,
        snapshot:()=>({contents:JSON.stringify(projectRef.current),projectToken:projectToken.current,dirty:dirtyRef.current,sourceDirty:sourceDirtyRef.current,projectDirty:projectDirtyRef.current}),
        confirm:()=>confirm('Close with unsaved work? Recovery will keep source, captions and notes.',{title:'Close CodeFlow',kind:'warning',okLabel:'Close',cancelLabel:'Keep open'}),
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
    const request = ++inspectRequest.current;
    const session=documentSession.current;
    setIsInspecting(true);
    setInspectedSource("");
    const timer = window.setTimeout(async () => {
      try {
        const found = await inspectCpp(source);
        if (request !== inspectRequest.current || sourceRef.current!==source || documentSession.current!==session) return;
        const previous=baseline.current;
        const sameDocument=previous?.session===documentSession.current;
        let selectedMatch:string|undefined;
        if(found.length && previous && previous.source!==source && sameDocument){
          const oldState=chartRef.current;
          const pairs=matchFunctions(previous.functions,found);
          const mappings:FunctionMapping[]=[];
          let valid=true;
          try{
            const editedFunctions=new Set((projectRef.current.history?.revisions.map(revision=>revision.state)??[oldState]).flatMap(state=>[...Object.keys(state.edits),...Object.keys(state.captions)].map(key=>key.replace(/:(?:overview|detail)$/,''))).concat(...(projectRef.current.history?.revisions.map(revision=>[...Object.keys(revision.state.loopOverrides),...Object.keys(revision.state.hiddenBoxes)])??[])));
            for(const [oldFunction,newFunction] of pairs){
              if(!editedFunctions.has(oldFunction.id)){mappings.push({before:oldFunction.id,after:newFunction.id,detail:new Map(),overview:new Map(),loops:new Map()});continue;}
              const [oldGraph,newGraph]=await Promise.all([analyzeCpp(previous.source,oldFunction.id,true),analyzeCpp(source,newFunction.id,true)]);
              mappings.push(mapFunction(oldFunction.id,newFunction.id,simplifyGraph(oldGraph),simplifyGraph(newGraph)));
            }
          }catch{valid=false;}
          if(request!==inspectRequest.current||sourceRef.current!==source||documentSession.current!==session)return;
          if(valid){
            labelLibrary.current=[{...previous,state:oldState},...labelLibrary.current].slice(0,10);
            remapHistory(state=>remapChart(state,mappings));
            selectedMatch=pairs.find(([oldFunction])=>oldFunction.id===selectedFunction)?.[1].id;
          }else{
            // Keep last valid identities while incomplete typing cannot be analyzed.
            setFunctions(found);setInspectedSource(source);return;
          }
        }
        if(found.length){
          // Recent projects are an app-owned, local label library; never send source externally.
          if(!libraryLoaded.current && isDesktop){
            libraryLoaded.current=true;
            for(const item of (await recentProjects()).slice(0,5))try{
              const project=readProject((await openRecentProject(item.id)).contents);
              if(!Object.keys(project.edits).length&&!Object.keys(project.captions).length)continue;
              const savedSource=project.labelSource??project.source;const savedFunctions=await inspectCpp(savedSource);
              labelLibrary.current.push({source:savedSource,functions:savedFunctions,state:{mode:project.mode,edits:project.edits,captions:project.captions,loopDepth:project.loopDepth,loopOverrides:project.loopOverrides,hiddenBoxes:project.hiddenBoxes,showHiddenBoxes:project.showHiddenBoxes,functionPositions:project.functionPositions}});
            }catch{/* A missing recent project must not block editing. */}
          }
          const candidates=labelLibrary.current;
          for(const candidate of candidates){
            const pairs=matchFunctions(candidate.functions,found).filter(([item])=>Object.keys(candidate.state.edits).some(key=>key.startsWith(item.id+':'))||Object.keys(candidate.state.captions).some(key=>key.startsWith(item.id+':')));if(!pairs.length)continue;
            try{
              const mappings:FunctionMapping[]=[];
              for(const [oldFunction,newFunction] of pairs){const [oldGraph,newGraph]=await Promise.all([analyzeCpp(candidate.source,oldFunction.id,true),analyzeCpp(source,newFunction.id,true)]);mappings.push(mapFunction(oldFunction.id,newFunction.id,simplifyGraph(oldGraph),simplifyGraph(newGraph)));}
              if(request!==inspectRequest.current||sourceRef.current!==source||documentSession.current!==session)return;
              const reused=remapChart(candidate.state,mappings);
              if(!Object.keys(reused.edits).length&&!Object.keys(reused.captions).length)continue;
              remapHistory(state=>({...state,edits:mergeNodeRecords(reused.edits,state.edits),captions:mergeNodeRecords(reused.captions,state.captions)}));
              if(Object.keys(reused.edits).length||Object.keys(reused.captions).length)setDocumentStatus({kind:'success',message:'Matching code labels restored.'});
            }catch{/* Try the next saved version if this code is incomplete. */}
          }
        }
        if(request!==inspectRequest.current||sourceRef.current!==source||documentSession.current!==session)return;
        if(found.length)baseline.current={source,functions:found,session:documentSession.current};
        setFunctions(found);
        if(selectedMatch)setSelectedFunction(selectedMatch);
        else setSelectedFunction((current) => found.some((item) => item.id === current) ? current : (found[0]?.id ?? ""));
        setInspectedSource(source);
        setError("");
      } catch (cause) {
        if (request !== inspectRequest.current || sourceRef.current!==source || documentSession.current!==session) return;
        setFunctions([]);
        setSelectedFunction("");
        setInspectedSource(source);
        setError(readError(cause));
      } finally {
        if (request === inspectRequest.current) setIsInspecting(false);
      }
    }, 260);
    return () => window.clearTimeout(timer);
  }, [source,recoveryReady]);

  useEffect(() => {
    const request = ++analyzeRequest.current;
    if (inspectedSource !== source || !selectedFunction) {
      setIsAnalyzing(false);
      setGraph({ nodes: [], edges: [], diagnostics: [] });
      setCanvasNodes([]);
      setCanvasEdges([]);
      return;
    }
    setIsAnalyzing(true);
    void (async () => {
      try {
        const nextGraph = simplifyGraph(await analyzeCpp(source, selectedFunction, true));
        if (request !== analyzeRequest.current) return;
        setGraph(nextGraph); setGraphSource(source); setGraphFunction(selectedFunction);

        setError("");
        window.setTimeout(() => void flowRef.current?.fitView({ padding: 0.18, duration: 350 }), 30);
      } catch (cause) {
        if (request !== analyzeRequest.current) return;
        setError(readError(cause));
        setGraph({ nodes: [], edges: [], diagnostics: [] });
        setCanvasNodes([]);
        setCanvasEdges([]);
      } finally {
        if (request === analyzeRequest.current) setIsAnalyzing(false);
      }
    })();
  }, [source, inspectedSource, selectedFunction, refreshKey]);

  const loops = useMemo(() => analyzeLoops(graph), [graph]);
  const expandedGraph = useMemo(() => graphSource !== source || graphFunction !== selectedFunction ? {nodes:[],edges:[],diagnostics:[]} : overviewGraph(graph, {depth:loopDepth,overrides:loopOverrides[selectedFunction] ?? {}}), [graph,loopDepth,loopOverrides,graphSource,graphFunction,source,selectedFunction]);
  const viewGraph=useMemo(()=>hideGraphNodes(expandedGraph,hiddenBoxes[selectedFunction]??[],showHiddenBoxes),[expandedGraph,hiddenBoxes,selectedFunction,showHiddenBoxes]);
  const displayedGraph = useMemo(() => ({...viewGraph,nodes:viewGraph.nodes.map(node=> {
    const key = nodePresentationKey(selectedFunction,node,loopDepth);
    const presented=presentGraph({...viewGraph,nodes:[node]},mode,includeComments,edits[key],captions[key]).nodes[0];
    return {...presented,unmodified:mode==='natural'&&highlightUnmodified&&edits[key]?.[node.id]?.natural===undefined&&captions[key]?.[node.id]===undefined};
  })}), [viewGraph,mode,includeComments,edits,captions,selectedFunction,loopDepth,highlightUnmodified]);
  const fitKey=source+'\0'+selectedFunction+'\0'+JSON.stringify([loopDepth,loopOverrides[selectedFunction]??{},hiddenBoxes[selectedFunction]??[],showHiddenBoxes]);
  const lastFitKey=useRef('');
  useEffect(() => {
    const request = ++layoutRequest.current;
    if (!displayedGraph.nodes.length) { setCanvasNodes([]); setCanvasEdges([]); return; }
    void layoutGraph(displayedGraph).then(result => {
      if (request !== layoutRequest.current) return;
      const labels=new Map(presentLoopEdgeLabels(viewGraph).edges.map(edge=>[edge.id,edge.label]));
      setCanvasNodes(result.nodes); setCanvasEdges(result.edges.map(edge=>({...edge,label:labels.get(edge.id)??edge.label})));
      if(lastFitKey.current!==fitKey){lastFitKey.current=fitKey;window.setTimeout(()=>void flowRef.current?.fitView({padding:0.12,duration:0}),60);}
    }).catch(cause => { if(request===layoutRequest.current) setError(readError(cause)); });
    return () => { layoutRequest.current++; };
  }, [displayedGraph,fitKey]);
  const selectedNode = displayedGraph.nodes.find(node => node.id === selectedNodeId);
  const graphKey = source + '\0' + selectedFunction + '\0' + JSON.stringify([loopDepth,loopOverrides[selectedFunction] ?? {},hiddenBoxes[selectedFunction]??[],showHiddenBoxes]);
  const editKey = selectedNode ? nodePresentationKey(selectedFunction,selectedNode,loopDepth) : selectedFunction + ':overview';
  const editNode = (field: 'code' | 'natural' | 'annotation', text: string) => {
    setEdits(current => ({...current, [editKey]: {...current[editKey], [selectedNodeId]: {...current[editKey]?.[selectedNodeId], [field]: text}}}));
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
    setSelectedNodeId('');setSelectedLine(null);replaceSource(text); setIsDirty(true); setProjectDirty(true);
  };
  const saveProject = async (saveAs=false) => {
    if(savingProject.current)return;savingProject.current=true;
    const session=documentSession.current;const snapshot=JSON.stringify(projectRef.current,null,2);
    try {
      const saved=await saveProjectDocument(fileName.replace(/\.[^.]+$/,'')+'.codeflow',snapshot,saveAs?null:projectToken.current);
      if(saved.saved){
        if(session===documentSession.current){projectToken.current=saved.projectToken??projectToken.current;const unchanged=JSON.stringify(projectRef.current,null,2)===snapshot;if(unchanged){setProjectDirty(false);setIsDirty(false);}markSaved();await saveRecovery(JSON.stringify(projectRef.current),projectToken.current,!unchanged,!unchanged&&sourceDirtyRef.current,!unchanged&&projectDirtyRef.current);}
        setDocumentStatus({kind:saved.warning?'info':'success',message:saved.warning??'Project saved.'});void recentProjects().then(setRecent).catch(()=>undefined);
      }
    } catch(cause){setDocumentStatus({kind:'error',message:readError(cause)});}finally{savingProject.current=false;}
  };
  const newProject=()=>{
    if((isDirty||projectDirty)&&!window.confirm('Start a new project? Save unsaved work first.'))return;
    if(baseline.current)labelLibrary.current=[{...baseline.current,state:chartRef.current},...labelLibrary.current].slice(0,10);
    documentSession.current++;openRequest.current++;saveRequest.current++;projectToken.current=null;recoveryError.current=false;
    replaceSource('');setFileName('untitled.cpp');loadHistory(defaultChartState());setIsDirty(false);setProjectDirty(false);setSelectedNodeId('');setSelectedLine(null);setDocumentStatus({kind:'idle',message:''});
  };

  const selectedName = functions.find((item) => item.id === selectedFunction)?.name ?? "flowchart";
  const lineCount = useMemo(() => source.split("\n").length, [source]);

  const openFile = useCallback(async (file?: File, token:string|null=null, confirmed=false) => {
    if (!file) return;
    try {
      if (!confirmed && (isDirty || projectDirty) && !window.confirm('Replace this document? Save source or project first to keep unsaved work.')) return;
      if(file.size > 16 * 1024 * 1024) throw new Error('File is larger than 16 MB.');
      const request = ++openRequest.current;
      const before = projectRef.current;
      const contents = await file.text();
      if(request !== openRequest.current) return;
      const now = projectRef.current;
      if(before.source!==now.source || before.fileName!==now.fileName || before.edits!==now.edits || before.captions!==now.captions || before.mode!==now.mode || before.loopDepth!==now.loopDepth || before.loopOverrides!==now.loopOverrides || before.hiddenBoxes!==now.hiddenBoxes || before.showHiddenBoxes!==now.showHiddenBoxes || before.functionPositions!==now.functionPositions || before.history!==now.history || before.includeComments!==now.includeComments) {
        setDocumentStatus({kind:'info',message:'Open canceled because the document changed.'}); return;
      }
      inspectRequest.current++;analyzeRequest.current++;
      saveRequest.current += 1;
      if(file.name.endsWith('.codeflow')) {
        const project = readProject(contents);
        const savedFunctions=await inspectCpp(project.labelSource??project.source);if(request!==openRequest.current||JSON.stringify(projectRef.current)!==JSON.stringify(before))return;
        baseline.current={source:project.labelSource??project.source,functions:savedFunctions,session:documentSession.current+1};
        replaceSource(project.source);setFileName(project.fileName);setIncludeComments(project.includeComments);
        loadHistory({mode:project.mode,edits:project.edits,captions:project.captions,loopDepth:project.loopDepth,loopOverrides:project.loopOverrides,hiddenBoxes:project.hiddenBoxes,showHiddenBoxes:project.showHiddenBoxes,functionPositions:project.functionPositions},project.history);
      } else {
        if(new TextEncoder().encode(contents).length > 2 * 1024 * 1024) throw new Error('C++ source must be smaller than 2 MB.');
        replaceSource(contents);setFileName(file.name);loadHistory(defaultChartState());
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
    if((isDirty||projectDirty)&&!window.confirm('Replace this document? Save unsaved work first.'))return;
    const snapshot=JSON.stringify(projectRef.current);const request=++openRequest.current;
    try{const opened=id?await openRecentProject(id):await openDocument();if(!opened)return;
      if(request!==openRequest.current||JSON.stringify(projectRef.current)!==snapshot){setDocumentStatus({kind:'info',message:'Open canceled because the document changed.'});return;}
      await openFile(new File([opened.contents],opened.name),opened.projectToken??null,true);if(opened.warning)setDocumentStatus({kind:'info',message:opened.warning});void recentProjects().then(setRecent).catch(()=>undefined);
    }catch(cause){setDocumentStatus({kind:'error',message:readError(cause)});}
  };

  const saveSource = useCallback(async (): Promise<boolean> => {
    const cleanName = fileName.replace(/\s*\*$/, "") || "untitled.cpp";
    const contents = source;
    const request = ++saveRequest.current;
    try {
      const saved = await saveDocument(cleanName, contents, "cpp");
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
  }, [fileName, source]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (showUpdateDialog) return;
      if(!recoveryReady)return;
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
  }, [saveProject,openChooser,showUpdateDialog,recoveryReady]);

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
      await saveRecovery(JSON.stringify(projectRef.current),projectToken.current,dirtyRef.current,sourceDirtyRef.current,projectDirtyRef.current);
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
      await saveRecovery(JSON.stringify(projectRef.current),projectToken.current,dirtyRef.current,sourceDirtyRef.current,projectDirtyRef.current);
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
    if(node.id!==selectedNodeId){const flow=flowRef.current;if(flow){const zoom=flow.getZoom();void flow.setCenter(node.position.x+(node.width??288)/2,node.position.y+(node.height??80)/2,{zoom,duration:150});}}
    setSelectedNodeId(node.id);revealNode(node);
  },[revealNode,selectedNodeId]);
  const clearSelection=()=>{setSelectedNodeId('');setSelectedLine(null);const editor=textareaRef.current;if(editor)editor.setSelectionRange(editor.selectionEnd,editor.selectionEnd);};
  const highlightStart=selectedNode?source.slice(0,byteToStringIndex(source,selectedNode.start_byte)).split('\n').length-1:0;
  const highlightLines=selectedNode?Math.max(1,source.slice(byteToStringIndex(source,selectedNode.start_byte),byteToStringIndex(source,selectedNode.end_byte)).split('\n').length):0;

  const exportGraph = useCallback(async (format:'svg'|'png'='svg') => {
    const svg = fileView ? boardSvg : createSvgDocument(canvasNodes, canvasEdges, mode,svgPaletteFromCss());
    if (!svg) return;
    try {
      const saved = await saveDocument(svgDocumentName(selectedName),format==='png'?await createPngDataUrl(svg):svg,format);
      setDocumentStatus(saved
        ? { kind: "success", message: "Flowchart exported." }
        : { kind: "info", message: "Export canceled." });
    } catch (cause) {
      setDocumentStatus({ kind: "error", message: `Export failed: ${readError(cause)}` });
    }
  }, [canvasNodes, canvasEdges, selectedName, mode,fileView,boardSvg]);

  const statusText = error
    ? error
    : isInspecting || isAnalyzing
      ? "Analyzing C++…"
      : functions.length === 0
        ? "No functions found"
        : `${viewGraph.nodes.length} boxes · ${viewGraph.edges.length} paths`;

  return (
    <main inert={!recoveryReady} className={`app-shell mode-${mode}`}>
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" aria-label="CodeFlow">
          <span className="brand__mark"><span /> <span /> <span /></span>
          <span>CodeFlow</span>
          <span className="brand__language">C++</span>
        </div>
        <div className="toolbar">
          <ThemePicker />
          <label className="transparency-control" title="Window background transparency"><span>Transparency</span><input aria-label="Transparency" type="range" min="0" max="80" value={transparency} onChange={e=>setTransparency(Number(e.target.value))}/><output>{transparency}%</output></label>
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".codeflow,.cpp,.cc,.cxx,.h,.hh,.hpp,.hxx,text/plain"
            onChange={(event) => void openFile(event.target.files?.[0])}
          />
          <button className="button" disabled={!recoveryReady} onClick={newProject}>New project</button>
          <button className="button" disabled={!recoveryReady} onClick={() => void openChooser()} title="Open file (Ctrl/⌘ O)">
            <Icon name="file" /> <span>Open</span>
          </button>
          <details className="recent-menu"><summary className="button">Recent projects</summary><div>{recent.length?recent.map(item=><button className="button" key={item.id} disabled={!recoveryReady} onClick={event=>{event.currentTarget.closest('details')!.open=false;void openChooser(item.id);}}>{item.name}</button>):<span>No recent projects</span>}</div></details>
          <button className="button" onClick={() => void saveSource()} title="Save C++ source">
            <Icon name="save" /> <span>Save C++</span>
          </button>
          <button className="button" onClick={()=>void saveProject()} title="Save project (Ctrl/⌘ S)">Save project</button>
          <button className="button" onClick={()=>void saveProject(true)}>Save as</button>
          <button className="button button--icon" onClick={() => setRefreshKey((value) => value + 1)} title="Analyze (Ctrl/⌘ Enter)" aria-label="Analyze again">
            <Icon name="refresh" />
          </button>
          <button
            className="button button--primary"
            disabled={fileView?!boardSvg:canvasNodes.length===0}
            onClick={() => void exportGraph()}
          >
            <Icon name="export" /> <span>Export SVG</span>
          </button>
          <button className="button" disabled={fileView?!boardSvg:!canvasNodes.length} onClick={()=>void exportGraph('png')}>Export PNG</button>
          <button className="button button--icon" disabled={updateStatus.kind === "checking" || updateStatus.kind === "downloading" || updateStatus.kind === "installing"} onClick={() => void checkForUpdates()} title="Check for updates" aria-label="Check for updates">
            <Icon name="update" />
          </button>
        </div>
      </header>

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
        <aside className={`document-banner document-banner--${documentStatus.kind}`} role={documentStatus.kind === "error" ? "alert" : "status"} aria-live="polite">
          <span>{documentStatus.message}</span>
          <button className="icon-button" aria-label="Dismiss save status" onClick={() => setDocumentStatus({ kind: "idle", message: "" })}><Icon name="close" /></button>
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
            <div className="file-name"><span className="file-name__dot" /><input aria-label="C++ filename" value={fileName} maxLength={240} onChange={e=>{setFileName(e.target.value);setProjectDirty(true);}} onBlur={()=>{if(!fileName.trim())setFileName('untitled.cpp');}}/>{isDirty || projectDirty ? " *" : ""}</div>
            <span className="panel__hint">Drop or paste C++</span>
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
              aria-label="C++ source code"
              value={source}
              spellCheck={false}
              disabled={!recoveryReady}
              onChange={(event) => changeSource(event.target.value)}
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
            <label>View <select aria-label="Chart view" value={fileView?'file':'function'} onChange={event=>{setFileView(event.target.value==='file');setShowAI(false);clearSelection();}}><option value="function">Function</option><option value="file">File map</option></select></label>
            <label>Labels <select aria-label="Label mode" value={mode} onChange={e=>{setMode(e.target.value as ChartMode);setProjectDirty(true);}}><option value="natural">Natural language</option><option value="code">Code</option></select></label>
            <button className="button" onClick={()=>setShowAI(current=>!current)} disabled={fileView}>Local AI</button>
            <button className="button" aria-pressed={highlightUnmodified} onClick={()=>setHighlightUnmodified(value=>!value)}>Highlight unmodified labels</button>
            <label>Loop depth <select aria-label="Loop expansion depth" value={loopDepth ?? 'all'} onChange={e=>{setLoopDepth(e.target.value==='all'?null:Number(e.target.value));setLoopOverrides({});setProjectDirty(true);}}>
              <option value="0">0 · overview</option>
              {Array.from({length:Math.max(3,loopDepth ?? 0,...loops.map(loop=>loop.depth+1))},(_,i)=><option key={i+1} value={i+1}>{i+1}</option>)}
              <option value="all">All</option>
            </select></label>
            <label><input type="checkbox" checked={showHiddenBoxes} onChange={e=>{change('showHiddenBoxes',e.target.checked,'Show hidden boxes');setProjectDirty(true);}}/> Show hidden boxes</label>
            <button className="button" disabled={!history.revisions.find(r=>r.id===history.active)?.parent} onClick={()=>{selectRevision(history.revisions.find(r=>r.id===history.active)!.parent!);setProjectDirty(true);}}>Undo</button>
            <button className="button" onClick={()=>setShowHistory(v=>!v)}>History</button>
            <button className="button" onClick={()=>{createAlternate();setProjectDirty(true);}}>Alternate</button>
            <button className="button" onClick={()=>{resetChart();setSelectedNodeId('');setProjectDirty(true);}}>Reset chart</button>
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
              <input type="checkbox" checked={includeComments} onChange={(event) => {setIncludeComments(event.target.checked);setProjectDirty(true);}} />
              <span className="toggle__track"><span /></span>
              <span>Comments</span>
            </label>
          </div>

          <div className="chart-canvas">
            {fileView && inspectedSource===source && functions.length ? <FunctionBoard source={source} functions={functions} mode={mode} highlightUnmodified={highlightUnmodified} includeComments={includeComments} loopDepth={loopDepth} loopOverrides={loopOverrides} edits={edits} captions={captions} hiddenBoxes={hiddenBoxes} showHiddenBoxes={showHiddenBoxes} positions={functionPositions} onPositions={next=>{change('functionPositions',next,'Arrange functions');setProjectDirty(true);}} onOpenFunction={id=>{setSelectedFunction(id);setFileView(false);clearSelection();}} onExportReady={setBoardSvg}/> : canvasNodes.length > 0 ? (
              <ReactFlow<CanvasNode>
                nodes={canvasNodes}
                edges={canvasEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onInit={(instance) => { flowRef.current = instance; }}
                onNodeClick={onNodeClick}
                onPaneClick={clearSelection}
                fitView
                fitViewOptions={{ padding: 0.18 }}
                minZoom={0.18}
                maxZoom={1.8}
                nodesDraggable={false}
                nodesConnectable={false}
                elementsSelectable
                proOptions={{ hideAttribution: true }}
              >
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
                <strong>{error ? "Couldn’t build chart" : "Add a C++ function"}</strong>
                <span>{error || "Open a file or paste source to see its control flow."}</span>
              </div>
            )}
            {(isInspecting || isAnalyzing) && <div className="analysis-progress"><span /></div>}
      {showAI && <LocalAI graph={displayedGraph} source={source} graphKey={graphKey} proposalKey={JSON.stringify(displayedGraph.nodes.map(node=>[node.id,node.label]))} onClose={()=>setShowAI(false)} onCaptions={(next,key)=>{
        if(key!==graphKey) return;
        setEdits(current=>{const result={...current};for(const node of viewGraph.nodes){if(next[node.id]===undefined)continue;const key=nodePresentationKey(selectedFunction,node,loopDepth);result[key]={...result[key],[node.id]:{...result[key]?.[node.id],natural:next[node.id]}};}return result;});setMode('natural');setProjectDirty(true);
      }}/>}
      {selectedNode && !showAI && <aside className="node-editor" aria-label="Edit flowchart box">
        <header><strong>Box · line {selectedNode.line}</strong><button className="button" onClick={clearSelection}>Close</button></header>
        {selectedNode.loop_id && <div className="loop-actions">
          <strong>Loop level {(selectedNode.loop_depth ?? 0)+1}</strong>
          {selectedNode.loop_can_collapse ? <button className="button" onClick={()=>setLoopExpansion(selectedNode.loop_id!,!!selectedNode.loop_collapsed)}>{selectedNode.loop_collapsed?'Expand this loop':'Collapse this loop'}</button> : <span>Terminal paths require this loop to stay expanded.</span>}
          {loopOverrides[selectedFunction]?.[selectedNode.loop_id]!==undefined && <button className="button" onClick={()=>setLoopExpansion(selectedNode.loop_id!,undefined)}>Follow global depth</button>}
        </div>}
        <label>{mode==='code'?'Code label':'Natural language label'}<textarea aria-label="Box label" maxLength={2000} value={selectedNode.label} onChange={e=>editNode(mode,e.target.value)}/></label>
        <label className="flag-box"><input type="checkbox" checked={selectedNode.flagged??false} onChange={event=>{setEdits(current=>({...current,[editKey]:{...current[editKey],[selectedNodeId]:{...current[editKey]?.[selectedNodeId],flagged:event.target.checked}}}));setProjectDirty(true);}}/> Flag for removal</label>
        <label>Annotation<textarea aria-label="Box annotation" maxLength={2000} value={selectedNode.annotation ?? ''} onChange={e=>editNode('annotation',e.target.value)}/></label>
        <details><summary>Original C++</summary><pre>{source.slice(byteToStringIndex(source,selectedNode.start_byte),byteToStringIndex(source,selectedNode.end_byte))}</pre></details>
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
