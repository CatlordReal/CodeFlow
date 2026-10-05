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
import { analyzeCpp, inspectCpp, saveDocument } from "./api";
import FlowNodeCard from "./FlowNodeCard";
import { createSvgDocument, svgDocumentName } from "./exportSvg";
import { edgeTypes, layoutGraph, type CanvasNode } from "./layout";
import { formatUpdaterError } from "./update";
import ThemePicker from "./ThemePicker";
import LocalAI from "./LocalAI";
import { overviewGraph, simplifyGraph } from "./simplify";
import { presentGraph, readProject, type ChartMode, type ChartEdits, type CaptionSets, type Project } from "./presentation";
import "./editing.css";
import { SAMPLE_CPP } from "./sample";
import type { FlowGraph, FunctionInfo } from "./types";

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
  const [expandLoops, setExpandLoops] = useState(false);
  const [mode, setMode] = useState<ChartMode>('natural');
  const [edits, setEdits] = useState<ChartEdits>({});
  const [captions, setCaptions] = useState<CaptionSets>({});
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
  const sourceRef = useRef(source);
  const saveRequest = useRef(0);
  const isDesktop = "__TAURI_INTERNALS__" in window;
  sourceRef.current = source;
  const projectRef = useRef<Project>({format:'codeflow',version:1,source,fileName,mode,edits,captions,expandLoops,includeComments});
  projectRef.current = {format:'codeflow',version:1,source,fileName,mode,edits,captions,expandLoops,includeComments};
  useEffect(() => {
    if(isDesktop) return;
    const warn = (event: BeforeUnloadEvent) => { if(isDirty || projectDirty) {event.preventDefault();event.returnValue='';} };
    window.addEventListener('beforeunload',warn); return ()=>window.removeEventListener('beforeunload',warn);
  },[isDirty,projectDirty,isDesktop]);
  useEffect(() => {
    if(!isDesktop || (!isDirty && !projectDirty)) return;
    let disposed=false; let unlisten: (()=>void) | undefined;
    void import('@tauri-apps/api/window').then(({getCurrentWindow})=>getCurrentWindow().onCloseRequested(event=>{
      if(!window.confirm('Close CodeFlow with unsaved work? Save a project first to keep source, captions and notes.')) event.preventDefault();
    })).then(remove=>{if(disposed) remove();else unlisten=remove;}).catch(()=>undefined);
    return ()=>{disposed=true;unlisten?.();};
  },[isDirty,projectDirty,isDesktop]);

  useEffect(() => {
    const request = ++inspectRequest.current;
    setIsInspecting(true);
    setInspectedSource("");
    const timer = window.setTimeout(async () => {
      try {
        const found = await inspectCpp(source);
        if (request !== inspectRequest.current) return;
        setFunctions(found);
        setSelectedFunction((current) => found.some((item) => item.id === current) ? current : (found[0]?.id ?? ""));
        setInspectedSource(source);
        setError("");
      } catch (cause) {
        if (request !== inspectRequest.current) return;
        setFunctions([]);
        setSelectedFunction("");
        setInspectedSource(source);
        setError(readError(cause));
      } finally {
        if (request === inspectRequest.current) setIsInspecting(false);
      }
    }, 260);
    return () => window.clearTimeout(timer);
  }, [source]);

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

  const viewGraph = useMemo(() => graphSource !== source || graphFunction !== selectedFunction ? {nodes:[],edges:[],diagnostics:[]} : expandLoops ? graph : overviewGraph(graph), [graph,expandLoops,graphSource,graphFunction,source,selectedFunction]);
  const editKey = selectedFunction + (expandLoops ? ':detail' : ':overview');
  const displayedGraph = useMemo(() => presentGraph(viewGraph, mode, includeComments, edits[editKey], captions[editKey]), [viewGraph, mode, includeComments, edits, captions, editKey]);
  useEffect(() => {
    const request = ++layoutRequest.current;
    if (!displayedGraph.nodes.length) { setCanvasNodes([]); setCanvasEdges([]); return; }
    void layoutGraph(displayedGraph).then(result => {
      if (request !== layoutRequest.current) return;
      setCanvasNodes(result.nodes); setCanvasEdges(result.edges);
      window.setTimeout(() => void flowRef.current?.fitView({padding:0.12,duration:0}), 60);
    }).catch(cause => { if(request===layoutRequest.current) setError(readError(cause)); });
    return () => { layoutRequest.current++; };
  }, [displayedGraph]);
  const selectedNode = displayedGraph.nodes.find(node => node.id === selectedNodeId);
  const graphKey = source + '\0' + editKey;
  const editNode = (field: 'code' | 'natural' | 'annotation', text: string) => {
    setEdits(current => ({...current, [editKey]: {...current[editKey], [selectedNodeId]: {...current[editKey]?.[selectedNodeId], [field]: text}}}));
    setProjectDirty(true);
  };
  const changeSource = (text: string) => {
    if ((Object.keys(edits).length || Object.keys(captions).length) && !window.confirm('Changing C++ resets diagram captions and notes. Save your project first if needed. Continue?')) return;
    openRequest.current++;
    setEdits({}); setCaptions({}); setSelectedNodeId(''); setSource(text); setIsDirty(true); setProjectDirty(true);
  };
  const saveProject = async () => {
    const project: Project = {format:'codeflow',version:1,source,fileName,mode,edits,captions,expandLoops,includeComments};
    const snapshot = JSON.stringify(project, null, 2);
    try {
      if(await saveDocument(fileName.replace(/\.[^.]+$/, '')+'.codeflow', snapshot, 'codeflow')) {
        if(JSON.stringify(projectRef.current, null, 2)===snapshot) {setProjectDirty(false);setIsDirty(false);}
        setDocumentStatus({kind:'success',message:'Project saved with captions and notes.'});
      }
    } catch(cause) { setDocumentStatus({kind:'error',message:readError(cause)}); }
  };

  const selectedName = functions.find((item) => item.id === selectedFunction)?.name ?? "flowchart";
  const lineCount = useMemo(() => source.split("\n").length, [source]);

  const openFile = useCallback(async (file?: File) => {
    if (!file) return;
    try {
      if ((isDirty || projectDirty) && !window.confirm('Replace this document? Save source or project first to keep unsaved work.')) return;
      if(file.size > 16 * 1024 * 1024) throw new Error('File is larger than 16 MB.');
      const request = ++openRequest.current;
      const before = projectRef.current;
      const contents = await file.text();
      if(request !== openRequest.current) return;
      const now = projectRef.current;
      if(before.source!==now.source || before.fileName!==now.fileName || before.edits!==now.edits || before.captions!==now.captions || before.mode!==now.mode || before.expandLoops!==now.expandLoops || before.includeComments!==now.includeComments) {
        setDocumentStatus({kind:'info',message:'Open canceled because the document changed.'}); return;
      }
      saveRequest.current += 1;
      if(file.name.endsWith('.codeflow')) {
        const project = readProject(contents);
        setSource(project.source); setFileName(project.fileName); setMode(project.mode); setExpandLoops(project.expandLoops); setIncludeComments(project.includeComments);
        setEdits(project.edits); setCaptions(project.captions);
      } else {
        if(new TextEncoder().encode(contents).length > 2 * 1024 * 1024) throw new Error('C++ source must be smaller than 2 MB.');
        setSource(contents); setFileName(file.name); setEdits({}); setCaptions({});
      }
      setProjectDirty(false); setSelectedNodeId('');
      setIsDirty(false);
      setSelectedLine(null);
      setError("");
    } catch (cause) {
      setError(readError(cause));
    }
  }, [isDirty, projectDirty]);

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
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "o") {
        event.preventDefault();
        fileInputRef.current?.click();
      }
      if (event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveSource();
      }
      if (event.key === "Enter") {
        event.preventDefault();
        setRefreshKey((value) => value + 1);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveSource, showUpdateDialog]);

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
    if (gutterRef.current) gutterRef.current.scrollTop = editor.scrollTop;
  }, [source]);

  const onNodeClick: NodeMouseHandler<CanvasNode> = useCallback((_event, node) => {setSelectedNodeId(node.id); revealNode(node);}, [revealNode]);

  const exportGraph = useCallback(async () => {
    const svg = createSvgDocument(canvasNodes, canvasEdges, mode);
    if (!svg) return;
    try {
      const saved = await saveDocument(svgDocumentName(selectedName), svg, "svg");
      setDocumentStatus(saved
        ? { kind: "success", message: "Flowchart exported." }
        : { kind: "info", message: "Export canceled." });
    } catch (cause) {
      setDocumentStatus({ kind: "error", message: `Export failed: ${readError(cause)}` });
    }
  }, [canvasNodes, canvasEdges, selectedName, mode]);

  const statusText = error
    ? error
    : isInspecting || isAnalyzing
      ? "Analyzing C++…"
      : functions.length === 0
        ? "No functions found"
        : `${viewGraph.nodes.length} boxes · ${viewGraph.edges.length} paths`;

  return (
    <main className={`app-shell mode-${mode}`}>
      <header className="topbar" data-tauri-drag-region>
        <div className="brand" aria-label="CodeFlow">
          <span className="brand__mark"><span /> <span /> <span /></span>
          <span>CodeFlow</span>
          <span className="brand__language">C++</span>
        </div>
        <div className="toolbar">
          <ThemePicker />
          <input
            ref={fileInputRef}
            className="visually-hidden"
            type="file"
            accept=".codeflow,.cpp,.cc,.cxx,.h,.hh,.hpp,.hxx,text/plain"
            onChange={(event) => void openFile(event.target.files?.[0])}
          />
          <button className="button" onClick={() => fileInputRef.current?.click()} title="Open file (Ctrl/⌘ O)">
            <Icon name="file" /> <span>Open</span>
          </button>
          <button className="button" onClick={() => void saveSource()} title="Save source (Ctrl/⌘ S)">
            <Icon name="save" /> <span>Save C++</span>
          </button>
          <button className="button" onClick={()=>void saveProject()}>Save project</button>
          <button className="button button--icon" onClick={() => setRefreshKey((value) => value + 1)} title="Analyze (Ctrl/⌘ Enter)" aria-label="Analyze again">
            <Icon name="refresh" />
          </button>
          <button
            className="button button--primary"
            disabled={canvasNodes.length === 0}
            onClick={() => void exportGraph()}
          >
            <Icon name="export" /> <span>Export SVG</span>
          </button>
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
            <div className="file-name"><span className="file-name__dot" />{fileName}{isDirty || projectDirty ? " *" : ""}</div>
            <span className="panel__hint">Drop or paste C++</span>
          </div>
          <div className="editor-wrap">
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
              onChange={(event) => changeSource(event.target.value)}
              onScroll={(event) => { if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop; }}
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
            <label>Labels <select aria-label="Label mode" value={mode} onChange={e=>{setMode(e.target.value as ChartMode);setProjectDirty(true);}}><option value="natural">Natural language</option><option value="code">Code</option></select></label>
            <button className="button" onClick={()=>setShowAI(current=>!current)}>Local AI</button>
            <label><input type="checkbox" checked={expandLoops} onChange={e=>{setExpandLoops(e.target.checked);setSelectedNodeId('');setProjectDirty(true);}}/> Expand loops</label>
            <span>Click a box to edit or annotate</span>
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
            {canvasNodes.length > 0 ? (
              <ReactFlow<CanvasNode>
                nodes={canvasNodes}
                edges={canvasEdges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onInit={(instance) => { flowRef.current = instance; }}
                onNodeClick={onNodeClick}
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
                  pannable
                  zoomable
                  nodeColor="var(--line-strong)"
                  maskColor="var(--panel)"
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
          </div>

          <div className={`chart-status ${error ? "chart-status--error" : ""}`}>
            <span className={`status-dot ${isInspecting || isAnalyzing ? "is-busy" : ""}`} />
            <span>{statusText}</span>
            {graph.diagnostics.length > 0 && !error && <span className="diagnostic" title={graph.diagnostics.join("\n")}>{graph.diagnostics[0]}</span>}
          </div>
        </section>
      </section>

      {showAI && <LocalAI graph={viewGraph} source={source} graphKey={graphKey} onClose={()=>setShowAI(false)} onCaptions={(next,key)=>{
        if(key!==graphKey) return;
        setCaptions(current=>({...current,[editKey]:next}));setMode('natural');setProjectDirty(true);
      }}/>}
      {selectedNode && !showAI && <aside className="node-editor" aria-label="Edit flowchart box">
        <header><strong>Box · line {selectedNode.line}</strong><button className="button" onClick={()=>setSelectedNodeId('')}>Close</button></header>
        <label>{mode==='code'?'Code label':'Natural language label'}<textarea aria-label="Box label" maxLength={2000} value={selectedNode.label} onChange={e=>editNode(mode,e.target.value)}/></label>
        <label>Annotation<textarea aria-label="Box annotation" maxLength={2000} value={selectedNode.annotation ?? ''} onChange={e=>editNode('annotation',e.target.value)}/></label>
        <details><summary>Original C++</summary><pre>{source.slice(byteToStringIndex(source,selectedNode.start_byte),byteToStringIndex(source,selectedNode.end_byte))}</pre></details>
        <button className="button" onClick={()=>{setEdits(current=>{const next={...current,[editKey]:{...current[editKey]}};delete next[editKey][selectedNodeId];return next;});setProjectDirty(true);}}>Reset box</button>
      </aside>}
      {showUpdateDialog && availableUpdate && (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) dismissUpdate(); }}>
          <section ref={updateDialogRef} tabIndex={-1} className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title" aria-describedby="update-warning">
            <div className="update-dialog__icon"><Icon name="update" /></div>
            <div className="update-dialog__content">
              <span className="update-dialog__eyebrow">Update available</span>
              <h2 id="update-title">CodeFlow {availableUpdate.version}</h2>
              <p>Installed version: {availableUpdate.currentVersion}</p>
              {availableUpdate.body && <div className="release-notes">{availableUpdate.body}</div>}
              <p className="update-warning" id="update-warning"><strong>Save your project first.</strong> Installing closes CodeFlow, then starts the updated app.</p>
              {(isDirty || projectDirty) && <p className="unsaved-warning">Unsaved edits detected. Save a project to keep diagram captions and notes.</p>}
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
