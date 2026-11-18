import type {ChartHistory} from './history';
import type { FlowGraph, FlowNode, SourceLanguage, ChartView } from './types';

export type ChartMode = 'code' | 'natural';
export type NodeEdit = { code?: string; natural?: string; annotation?: string; flagged?: boolean; flaggedForUpdate?: boolean; loopContinueLabel?: string; loopExitLabel?: string; trueLabel?: string; falseLabel?: string; position?: {x:number;y:number} };
export type ChartEdits = Record<string, Record<string, NodeEdit>>;
export type CaptionSets = Record<string, Record<string, string>>;

export function naturalLabel(node: FlowNode): string {
  if (node.kind === 'start') return 'Start';
  if (node.kind === 'end') return 'End';
  if (node.shape === 'subprocess') return loopCaption(node.label);
  if (node.kind === 'return') return node.label.replace(/^return\s*/, 'Return ').replace(/;$/, '').trim();
  if (node.kind === 'loop') return loopCaption(node.label);
  if (node.kind === 'throw') return node.label.replace(/^throw\s*/, 'Throw ').replace(/;$/, '').trim();
  if (node.shape === 'decision' || node.kind === 'decision') {
    return 'Is ' + node.label.replace(/^if\s*\((.*)\)$/, '$1').replace(/;$/, '') + ' true?';
  }
  // Keep uncertain operations exact until the user asks AI to paraphrase.
  return node.label.replace(/;(?=\s*$)/gm, '').trim();
}

export function presentGraph(graph: FlowGraph, mode: ChartMode, comments: boolean,
  edits: Record<string, NodeEdit> = {}, captions: Record<string, string> = {}): FlowGraph {
  return { ...graph, nodes: graph.nodes.map(node => ({
    ...node,
    original_label: node.original_label ?? node.label,
    label: edits[node.id]?.[mode] ?? (mode === 'natural' ? captions[node.id] ?? naturalLabel(node) : node.label),
    annotation: edits[node.id]?.annotation ?? '',
    flagged: edits[node.id]?.flagged ?? false,
    flaggedForUpdate: edits[node.id]?.flaggedForUpdate ?? false,
    loopContinueLabel: edits[node.id]?.loopContinueLabel,
    loopExitLabel: edits[node.id]?.loopExitLabel,
    trueLabel: edits[node.id]?.trueLabel,
    falseLabel: edits[node.id]?.falseLabel,
    position: edits[node.id]?.position,
    comments: comments ? node.comments : [],
  })) };
}

/** Replace structural loop branch labels without mutating analyzer output. */
export function presentLoopEdgeLabels(graph: FlowGraph, showLabels = true): FlowGraph {
  const sources = new Map(graph.nodes.map(node => [node.id, node]));
  return {
    ...graph,
    edges: graph.edges.map(edge => {
      const node = sources.get(edge.source);
      if (node?.kind === 'loop') {
        if (!showLabels) return { ...edge, label: '' };
        if (edge.label === 'Yes') return { ...edge, label: node.loopContinueLabel ?? 'Running' };
        if (edge.label === 'No') return { ...edge, label: node.loopExitLabel ?? 'Done' };
      }
      if (node?.kind === 'decision') {
        if (edge.label === 'Yes') return { ...edge, label: node.trueLabel ?? 'True' };
        if (edge.label === 'No') return { ...edge, label: node.falseLabel ?? 'False' };
      }
      return edge;
    }),
  };
}

export type LoopOverrides = Record<string, Record<string, boolean>>;
export function nodePresentationKey(functionId: string, node: FlowNode, depth: number | null): string {
  return functionId + ((node.loop_id ? !node.loop_collapsed : depth === null) ? ':detail' : ':overview');
}

export type SourceHistoryArchive = { source: string; language: SourceLanguage; history: ChartHistory };
export type Project = { format: 'codeflow'; version: 1; source: string; fileName: string; language?: SourceLanguage; view?: ChartView; mode: ChartMode; edits: ChartEdits; captions: CaptionSets; expandLoops: boolean; includeComments: boolean; showLoopLabels?: boolean; loopDepth: number | null; loopOverrides: LoopOverrides; hiddenBoxes: Record<string,string[]>; showHiddenBoxes: boolean; functionPositions: Record<string,{x:number;y:number}>; history?: ChartHistory; sourceHistory?: SourceHistoryArchive[]; labelSource?:string };
export function readProject(text: string): Project {
  if (new TextEncoder().encode(text).length > 16 * 1024 * 1024) throw new Error('Project is larger than 16 MB.');
  const value = JSON.parse(text);
  if (value?.format !== 'codeflow' || value.version !== 1 || typeof value.source !== 'string'
    || new TextEncoder().encode(value.source).length > 2 * 1024 * 1024
    || typeof value.fileName !== 'string' || !value.fileName.trim() || value.fileName.length > 240 || /[\x00-\x1f]/.test(value.fileName) || !['code','natural'].includes(value.mode)) throw new Error('Invalid CodeFlow project.');
  if(value.historySources!==undefined && (!Array.isArray(value.historySources) || value.historySources.some((source:unknown)=>typeof source!=='string' || new TextEncoder().encode(source).length>2*1024*1024))) throw new Error('Invalid history source pool.');
  value.language ??= 'cpp'; value.view ??= 'function';
  if(!['cpp','csharp'].includes(value.language) || !['function','file','program'].includes(value.view)) throw new Error('Invalid project language or view.');
  const records = (input: unknown, captions: boolean) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid project edits.');
    const validKey = (key: string) => key.length > 0 && key.length <= 160 && !/[\x00-\x1f]/.test(key) && !['__proto__','constructor','prototype'].includes(key);
    for (const [functionKey,set] of Object.entries(input)) {
      if(!validKey(functionKey)) throw new Error('Invalid function key.');
      if (!set || typeof set !== 'object' || Array.isArray(set)) throw new Error('Invalid function edits.');
      for (const [nodeKey,item] of Object.entries(set)) {
        if(!validKey(nodeKey)) throw new Error('Invalid node key.');
        if (captions) {
          if (typeof item !== 'string' || item.length > 500) throw new Error('Invalid saved caption.');
        } else {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid node edit.');
          for (const [key, label] of Object.entries(item)) {
            if (key === 'position') {
              const p = label as {x?:unknown;y?:unknown} | null;
              if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).some(k => k !== 'x' && k !== 'y') || typeof p.x !== 'number' || typeof p.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y) || Math.abs(p.x) > 10000000 || Math.abs(p.y) > 10000000) throw new Error('Invalid node position.');
              continue;
            }
            if (key==='flagged' || key==='flaggedForUpdate' ? typeof label !== 'boolean' : (!['code','natural','annotation','loopContinueLabel','loopExitLabel','trueLabel','falseLabel'].includes(key) || typeof label !== 'string' || label.length > 2000)) throw new Error('Invalid node text.');
          }
        }
      }
    }
  };
  value.labelSource ??= value.source;
  if(typeof value.labelSource!=='string'||new TextEncoder().encode(value.labelSource).length>2*1024*1024)throw new Error('Invalid label source.');
  records(value.edits, false); records(value.captions, true);
  if (value.expandLoops === undefined) value.expandLoops = false;
  if (value.includeComments === undefined) value.includeComments = false;
  if (value.showLoopLabels === undefined) value.showLoopLabels = true;
  if (typeof value.showLoopLabels !== 'boolean') throw new Error('Invalid loop-label option.');
  if(typeof value.expandLoops!=='boolean' || typeof value.includeComments!=='boolean') throw new Error('Invalid project view options.');
  if (value.loopDepth === undefined) value.loopDepth = value.expandLoops ? null : 0;
  if (value.loopDepth !== null && (!Number.isInteger(value.loopDepth) || value.loopDepth < 0 || value.loopDepth > 100)) throw new Error('Invalid loop depth.');
  value.loopOverrides ??= {};
  if (!value.loopOverrides || typeof value.loopOverrides !== 'object' || Array.isArray(value.loopOverrides)) throw new Error('Invalid loop overrides.');
  const validLoopKey = (key: string) => key.length > 0 && key.length <= 160 && !/[\x00-\x1f]/.test(key) && !['__proto__','constructor','prototype'].includes(key);
  for (const [functionKey, overrides] of Object.entries(value.loopOverrides)) {
    if (!validLoopKey(functionKey) || !overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('Invalid loop overrides.');
    for (const [loopKey, expanded] of Object.entries(overrides)) if (!validLoopKey(loopKey) || typeof expanded !== 'boolean') throw new Error('Invalid loop override.');
  }
  value.hiddenBoxes ??= {};value.showHiddenBoxes ??= false;
  if (!value.hiddenBoxes || typeof value.hiddenBoxes !== 'object' || Array.isArray(value.hiddenBoxes) || typeof value.showHiddenBoxes !== 'boolean') throw new Error('Invalid hidden-box options.');
  for (const [key, ids] of Object.entries(value.hiddenBoxes)) if (!validLoopKey(key) || !Array.isArray(ids) || ids.length>10000 || ids.some(id=>typeof id!=='string'||!validLoopKey(id))) throw new Error('Invalid hidden boxes.');
  value.functionPositions ??= {};
  if (!value.functionPositions || typeof value.functionPositions !== 'object' || Array.isArray(value.functionPositions)) throw new Error('Invalid function positions.');
  for (const [id,position] of Object.entries(value.functionPositions)) {
    const p=position as {x:number;y:number};if(!validLoopKey(id)||!p||typeof p!=='object'||!Number.isFinite(p.x)||!Number.isFinite(p.y)||Math.abs(p.x)>10000000||Math.abs(p.y)>10000000)throw new Error('Invalid function position.');
  }
  if(value.history!==undefined){
    const h=value.history;if(!h||!Array.isArray(h.revisions)||!h.revisions.length||h.revisions.length>500||!Number.isSafeInteger(h.next)||h.next<1)throw new Error('Invalid chart history.');
    const ids=new Set<string>();let largest=-1;
    for(const revision of h.revisions){
      if(!revision||!validLoopKey(revision.id)||ids.has(revision.id)||typeof revision.name!=='string'||revision.name.length>120||(revision.parent!==null&&!ids.has(revision.parent)))throw new Error('Invalid chart revision.');
      ids.add(revision.id);const number=/^revision-(\d+)$/.exec(revision.id);if(number)largest=Math.max(largest,Number(number[1]));
      if(!revision.state||typeof revision.state!=='object'||Array.isArray(revision.state))throw new Error('Invalid chart revision state.');
      const state=revision.state;
      const resolve=(key:'source'|'labelSource',fallback:string)=>{
        const refKey=key==='source'?'sourceRef':'labelSourceRef';
        if(refKey in state){
          if(key in state || !Array.isArray(value.historySources) || !Number.isSafeInteger(state[refKey]) || state[refKey]<0 || state[refKey]>=value.historySources.length)throw new Error('Invalid history source reference.');
          return value.historySources[state[refKey]] as string;
        }
        if(key in state && (typeof state[key]!=='string' || new TextEncoder().encode(state[key]).length>2*1024*1024))throw new Error('Invalid revision source.');
        return state[key] ?? fallback;
      };
      const source=resolve('source',value.source),labelSource=resolve('labelSource',value.labelSource);
      if('language' in state && !['cpp','csharp'].includes(state.language))throw new Error('Invalid revision language.');
      const {source: _source,labelSource: _labelSource,sourceRef: _sourceRef,labelSourceRef: _labelSourceRef,...chartState}=state;
      const validated=readProject(JSON.stringify({format:'codeflow',version:1,source:'',labelSource:'',language:value.language,fileName:'history.cpp',includeComments:value.includeComments,showLoopLabels:value.showLoopLabels,...chartState,history:undefined,sourceHistory:undefined}));
      revision.state={source,labelSource,language:validated.language,mode:validated.mode,edits:validated.edits,captions:validated.captions,loopDepth:validated.loopDepth,loopOverrides:validated.loopOverrides,hiddenBoxes:validated.hiddenBoxes,showHiddenBoxes:validated.showHiddenBoxes,includeComments:validated.includeComments,showLoopLabels:validated.showLoopLabels??true,functionPositions:validated.functionPositions};
    }
    if(!ids.has(h.active)||h.next<=largest)throw new Error('Invalid active chart revision.');
  }
  if (value.sourceHistory !== undefined) {
    if (!Array.isArray(value.sourceHistory) || value.sourceHistory.length > 10) throw new Error('Invalid source history.');
    for (const archive of value.sourceHistory) {
      if (!archive || typeof archive !== 'object' || Array.isArray(archive) || typeof archive.source !== 'string'
        || new TextEncoder().encode(archive.source).length > 2 * 1024 * 1024
        || !['cpp', 'csharp'].includes(archive.language) || !archive.history) throw new Error('Invalid source history.');
      const validated = readProject(JSON.stringify({ ...value, source: archive.source, labelSource: archive.source,
        language: archive.language, history: archive.history, sourceHistory: undefined }));
      archive.history = validated.history;
    }
  }
  value.expandLoops = value.loopDepth === null;
  delete value.historySources;
  return value as Project;
}

export function loopCaption(label: string): string {
  const each = /^foreach\s*\(.*?\b(\w+)\s+in\s+(.+)\)$/.exec(label);
  if(each) return `For each ${each[1]} in ${each[2]}`;
  const range = /^for\s*\(.*?\b(\w+)\s*:\s*(.+)\)$/.exec(label);
  if (range) return `For each ${range[1]} in ${range[2]}`;
  const count = /^for\s*\([^;]*?\b(\w+)\s*=\s*([^;]+);\s*([^;]+);\s*(.*?)\)$/.exec(label);
  if (count) return `Loop ${count[1]} from ${count[2]} while ${count[3]}`;
  return label.replace(/^while\s*\((.*)\)$/, 'Repeat while $1').replace(/^do\b/, 'Repeat');
}

/** Hide visual steps without changing the stored parser graph or source. */
export function hideGraphNodes(graph: FlowGraph, hiddenIds: string[], showHidden: boolean): FlowGraph {
  const hidden=new Set(hiddenIds.filter(id=>graph.nodes.some(node=>node.id===id && !['start','end','return','throw'].includes(node.kind))));
  if(showHidden)return {...graph,nodes:graph.nodes.map(node=>({...node,hidden:hidden.has(node.id)}))};
  const nodes=graph.nodes.filter(node=>!hidden.has(node.id));
  const outgoing=new Map<string,typeof graph.edges>();for(const edge of graph.edges)outgoing.set(edge.source,[...(outgoing.get(edge.source)??[]),edge]);
  const edges:typeof graph.edges=[];const seen=new Set<string>();
  for(const node of nodes){
    const walk=(id:string,label:string,visited:Set<string>,throughLoop:boolean)=>{
      if(!hidden.has(id)){if(throughLoop && id===node.id)return;const key=JSON.stringify([node.id,id,label]);if(!seen.has(key)){seen.add(key);edges.push({id:`visible-${edges.length}`,source:node.id,target:id,label});}return;}
      if(visited.has(id))return;const nextVisited=new Set(visited).add(id);
      const step=graph.nodes.find(n=>n.id===id)!;
      const loop=step.kind==='loop';
      const fromLoopBody=loop && node.start_byte>=step.start_byte && node.start_byte<step.end_byte;
      for(const edge of outgoing.get(id)??[]){
        if(loop && fromLoopBody && (edge.label==='Yes' || edge.label==='Repeat'))continue;
        const prior=loop && (label==='Repeat' || label==='Continue')?'':label;
        walk(edge.target,prior,nextVisited,throughLoop||loop);
      }
    };
    for(const edge of outgoing.get(node.id)??[])walk(edge.target,edge.label,new Set(),false);
  }
  return {...graph,nodes,edges};
}
