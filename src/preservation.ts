import type {ChartState} from './history';
import type {FlowGraph, FlowNode, FunctionInfo} from './types';
import {overviewIdentityNodes} from './simplify';

export type FunctionMapping = {
  before:string;
  after:string;
  detail:Map<string,string>;
  overview:Map<string,string>;
  loops:Map<string,string>;
  overviewSourceIds?:Set<string>;
  overviewTargetIds?:Set<string>;
};

/** Never transfer a caption to different code merely because its box number matches. */
function identity(node:FlowNode, header:boolean):string {
  const code=header && node.kind==='loop' ? node.header_identity : node.source_identity;
  return JSON.stringify([node.kind,node.shape,code??node.label]);
}
function matchNodes(before:FlowNode[],after:FlowNode[],header:boolean,unchanged=false):Map<string,string>{
  if(unchanged && before.length===after.length)return new Map(before.map((node,index)=>[node.id,after[index].id]));
  const groups=(nodes:FlowNode[])=>{
    const result=new Map<string,FlowNode[]>();
    for(const node of nodes){const key=identity(node,header);result.set(key,[...(result.get(key)??[]),node]);}
    return result;
  };
  const old=groups(before),next=groups(after),mapping=new Map<string,string>();
  for(const [key,nodes] of old){const matches=next.get(key);if(!matches||matches.length!==1||nodes.length!==1)continue;
    // Repeated identical steps have no safe identity; do not guess which note belongs where.
    nodes.forEach((node,index)=>mapping.set(node.id,matches[index].id));
  }
  return mapping;
}
export function matchFunctions(before:FunctionInfo[],after:FunctionInfo[]):[FunctionInfo,FunctionInfo][]{
  const used=new Set<string>(),pairs:[FunctionInfo,FunctionInfo][]=[];
  for(const previous of before){
    let matches=after.filter(item=>!used.has(item.id)&&previous.identity&&item.identity===previous.identity);
    if(matches.length!==1){const name=previous.qualified_name??previous.name;
      if(before.filter(item=>(item.qualified_name??item.name)===name).length!==1)continue;
      matches=after.filter(item=>!used.has(item.id)&&(item.qualified_name??item.name)===name);
    }
    if(matches.length===1){used.add(matches[0].id);pairs.push([previous,matches[0]]);}
  }
  return pairs;
}
export function mapFunction(before:string,after:string,oldGraph:FlowGraph,newGraph:FlowGraph):FunctionMapping{
  const signature=(graph:FlowGraph)=>{const indexes=new Map(graph.nodes.map((node,index)=>[node.id,index]));return JSON.stringify([graph.nodes.map(node=>identity(node,false)),graph.edges.map(edge=>[indexes.get(edge.source),indexes.get(edge.target),edge.label])]);};
  const unchanged=signature(oldGraph)===signature(newGraph);
  const oldOverview=overviewIdentityNodes(oldGraph),newOverview=overviewIdentityNodes(newGraph);
  return {before,after,detail:matchNodes(oldGraph.nodes,newGraph.nodes,true,unchanged),
    overview:matchNodes(oldOverview,newOverview,false,unchanged),
    loops:matchNodes(oldGraph.nodes.filter(n=>n.kind==='loop'),newGraph.nodes.filter(n=>n.kind==='loop'),true,unchanged),
    overviewSourceIds:new Set(oldOverview.map(node=>node.id)),overviewTargetIds:new Set(newOverview.map(node=>node.id))};
}
export function remapChart(state:ChartState,mappings:FunctionMapping[]):ChartState{
  const edits:ChartState['edits']={},captions:ChartState['captions']={},loopOverrides:ChartState['loopOverrides']={},hiddenBoxes:ChartState['hiddenBoxes']={},functionPositions:ChartState['functionPositions']={};
  for(const mapping of mappings){
    for(const view of ['detail','overview'] as const){const oldKey=`${mapping.before}:${view}`,newKey=`${mapping.after}:${view}`;
      for(const [oldId,newId] of mapping[view]){
        if(state.edits[oldKey]?.[oldId]) (edits[newKey]??={})[newId]=state.edits[oldKey][oldId];
        if(state.captions[oldKey]?.[oldId]!==undefined) (captions[newKey]??={})[newId]=state.captions[oldKey][oldId];
      }
    }
    for(const [oldId,newId] of mapping.loops)if(state.loopOverrides[mapping.before]?.[oldId]!==undefined)(loopOverrides[mapping.after]??={})[newId]=state.loopOverrides[mapping.before][oldId];
    const hidden=(state.hiddenBoxes[mapping.before]??[]).flatMap(id=>{
      if(mapping.overviewSourceIds?.has(id))return mapping.overview.has(id)?[mapping.overview.get(id)!]:[];
      const target=mapping.detail.get(id);
      return target&&!mapping.overviewTargetIds?.has(target)?[target]:[];
    });
    if(hidden.length)hiddenBoxes[mapping.after]=hidden;
    if(state.functionPositions[mapping.before])functionPositions[mapping.after]=state.functionPositions[mapping.before];
  }
  return {...state,edits,captions,loopOverrides,hiddenBoxes,functionPositions};
}

/** Keep the other parser's records when only the active source language is reanalyzed. */
export function remapChartForLanguage(state:ChartState,mappings:FunctionMapping[],language:'cpp'|'csharp'):ChartState {
  const next=remapChart(state,mappings);
  const inactive=(id:string)=>language==='cpp'?id.startsWith('cs:'):!id.startsWith('cs:');
  for(const field of ['edits','captions','loopOverrides','hiddenBoxes','functionPositions'] as const) {
    Object.assign(next[field],Object.fromEntries(Object.entries(state[field]).filter(([id])=>inactive(id))));
  }
  return next;
}

/** Restore records from the same source and revision; current mapped records take precedence. */
export function restoreArchivedHistory(
  current: import('./history').ChartHistory,
  archive: { source: string; language: 'cpp' | 'csharp'; history: import('./history').ChartHistory },
  source: string,
  language: 'cpp' | 'csharp',
): import('./history').ChartHistory {
  if (archive.source !== source || archive.language !== language) return current;
  const oldRevisions = new Map(archive.history.revisions.map(revision => [revision.id, revision.state]));
  const mergeRecords = <T>(oldRecords: Record<string, Record<string, T>>, records: Record<string, Record<string, T>>) => {
    const result = { ...oldRecords };
    for (const [key, values] of Object.entries(records)) result[key] = { ...result[key], ...values };
    return result;
  };
  return { ...current, revisions: current.revisions.map(revision => {
    const saved = oldRevisions.get(revision.id);
    if (!saved) return revision;
    const state = revision.state;
    return { ...revision, state: { ...state,
      edits: mergeRecords(saved.edits, state.edits),
      captions: mergeRecords(saved.captions, state.captions),
      loopOverrides: mergeRecords(saved.loopOverrides, state.loopOverrides),
      hiddenBoxes: { ...saved.hiddenBoxes, ...state.hiddenBoxes },
      functionPositions: { ...saved.functionPositions, ...state.functionPositions },
    } };
  }) };
}

/** Preserve the newest source snapshot and fit older snapshots within the project byte budget. */
export function retainSourceHistory(
  project: import('./presentation').Project,
  latest: import('./presentation').SourceHistoryArchive,
): { archives: import('./presentation').SourceHistoryArchive[]; trimmed: number } {
  const budget = 16 * 1024 * 1024 - 256 * 1024;
  const encoder = new TextEncoder();
  const fits = (archives: import('./presentation').SourceHistoryArchive[]) =>
    encoder.encode(JSON.stringify({ ...project, sourceHistory: archives }, null, 2)).length <= budget;
  const archives = [latest];
  if (!fits(archives)) throw new Error('Cannot preserve this source change safely. Undo the source edit or save a project copy first.');
  let trimmed = 0;
  const seen = new Set([JSON.stringify([latest.source, latest.language])]);
  for (const archive of project.sourceHistory ?? []) {
    const key = JSON.stringify([archive.source, archive.language]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (archives.length < 10 && fits([...archives, archive])) archives.push(archive);
    else trimmed++;
  }
  return { archives, trimmed };
}
