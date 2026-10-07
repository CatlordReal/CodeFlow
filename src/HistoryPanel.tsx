import {ReactFlow,Background,Controls,type Node,type Edge} from '@xyflow/react';
import type {ChartHistory} from './history';
export default function HistoryPanel({history,onSelect,onClose}:{history:ChartHistory;onSelect:(id:string)=>void;onClose:()=>void}){
 const depth=new Map<string,number>(),rows=new Map<number,number>();
 const nodes:Node[]=history.revisions.map(revision=>{const level=revision.parent?(depth.get(revision.parent)??0)+1:0;depth.set(revision.id,level);const row=rows.get(level)??0;rows.set(level,row+1);return{id:revision.id,position:{x:level*180,y:row*85},data:{label:revision.name},style:{background:revision.id===history.active?'var(--accent-soft)':'var(--panel-2)',color:'var(--text)',border:'1px solid var(--line-strong)'}};});
 const edges:Edge[]=history.revisions.filter(r=>r.parent).map(r=>({id:r.id,source:r.parent!,target:r.id,style:{stroke:'var(--accent)'}}));
 return <aside className="history-panel" aria-label="Chart history"><header><strong>Chart history</strong><button className="button" onClick={onClose}>Close</button></header><div><ReactFlow nodes={nodes} edges={edges} nodesDraggable={false} nodesConnectable={false} onNodeClick={(_,node)=>onSelect(node.id)} fitView minZoom={0.1} proOptions={{hideAttribution:true}}><Background/><Controls showInteractive={false}/></ReactFlow></div></aside>;
}
