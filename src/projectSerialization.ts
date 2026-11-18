import type {ChartHistory} from './history';
import type {Project} from './presentation';

/** Store repeated revision sources once while leaving in-memory history unchanged. */
export function packHistories(histories:ChartHistory[]):{histories:unknown[];historySources:string[]} {
  const historySources:string[]=[];
  const indexes=new Map<string,number>();
  const intern=(source:string)=>{let index=indexes.get(source);if(index===undefined){index=historySources.length;indexes.set(source,index);historySources.push(source);}return index;};
  const packed=histories.map(history=>({...history,revisions:history.revisions.map(revision=>{
    const {source,labelSource,...state}=revision.state;
    return {...revision,state:{...state,...(source===undefined?{}:{sourceRef:intern(source)}),...(labelSource===undefined?{}:{labelSourceRef:intern(labelSource)})}};
  })}));
  return {histories:packed,historySources};
}
export function serializeProject(project:Project,pretty=false):string {
  const histories=[...(project.history?[project.history]:[]),...(project.sourceHistory??[]).map(archive=>archive.history)];
  const packed=packHistories(histories);let index=0;
  const output={...project,...(project.history?{history:packed.histories[index++]}:{}),
    ...(project.sourceHistory?{sourceHistory:project.sourceHistory.map(archive=>({...archive,history:packed.histories[index++]}))}:{}),
    ...(packed.historySources.length?{historySources:packed.historySources}:{})};
  const contents=JSON.stringify(output,null,pretty?2:undefined);
  if(new TextEncoder().encode(contents).length>16*1024*1024)throw new Error('Project is larger than 16 MB. Keep a project copy before adding more history.');
  return contents;
}
