import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import type { FlowGraph } from './types';

type Props = { graph: FlowGraph; source: string; graphKey: string; onCaptions: (captions: Record<string,string>, key: string) => void; onClose: () => void };
export default function LocalAI({ graph, source, graphKey, onCaptions, onClose }: Props) {
  const hasSteps = graph.nodes.some(n=>['process','io'].includes(n.kind));
  const [model,setModel] = useState('qwen2.5:0.5b');
  const [models,setModels] = useState<string[]>([]);
  const [status,setStatus] = useState('Checking local Ollama…');
  const [busy,setBusy] = useState(false);
  const [draft,setDraft] = useState<{captions: Record<string,string>; key:string} | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; void refresh(); return () => { active.current = false; }; }, []);
  const message = (cause: unknown) => typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : 'Local AI request failed.';
  async function refresh() {
    try {
      if (!('__TAURI_INTERNALS__' in window)) throw new Error('Local AI runs in the desktop app.');
      const found = await invoke<string[]>('ai_models');
      if (active.current) { setModels(found); setStatus(found.length ? 'Local models ready.' : 'Download a model to begin.'); }
    } catch(cause) { if(active.current) setStatus(message(cause)); }
  }
  async function download() {
    setBusy(true); setStatus('Downloading model through Ollama. Retry resumes interrupted downloads.');
    try { await invoke('ai_download',{model}); if(active.current) await refresh(); }
    catch(cause) { if(active.current) setStatus(message(cause)); }
    finally { if(active.current) setBusy(false); }
  }
  async function generate() {
    setBusy(true); setDraft(null); setStatus('Writing captions locally…');
    try {
      const nodes = graph.nodes.filter(n => ['process','io'].includes(n.kind)).map(n => ({id:n.id,code:n.shape === 'subprocess' ? new TextDecoder().decode(new TextEncoder().encode(source).slice(n.start_byte,n.end_byte)) : n.original_label ?? n.label,kind:n.kind}));
      const captions = await invoke<Record<string,string>>('ai_captions',{model,nodes});
      if(active.current) { setDraft({captions,key:graphKey}); setStatus('Review every draft against the code; AI can miss details. Decision tests and paths stay exact.'); }
    } catch(cause) { if(active.current) setStatus(message(cause)); }
    finally { if(active.current) setBusy(false); }
  }
  return <section className="ai-panel" aria-label="Local AI captions">
    <header><h2>Local AI</h2><button className="button" onClick={onClose}>Close</button></header>
    <p>Requires <a href="https://ollama.com/download" target="_blank" rel="noreferrer">Ollama</a> running on this computer. Code stays local. Model download needs internet.</p>
    <label>Model <select value={model} disabled={busy} onChange={e=>setModel(e.target.value)}>
      <option value="qwen2.5:0.5b">Qwen 0.5B · 398 MB · small</option>
      <option value="qwen3.5:4b">Qwen 3.5 4B · larger model</option>
      <option value="qwen2.5:3b">Qwen 3B · 1.9 GB · better captions</option>
    </select></label>
    <div className="ai-actions"><button className="button" disabled={busy} onClick={()=>void refresh()}>Refresh</button>
      <button className="button" disabled={busy || models.includes(model)} onClick={()=>void download()}>Download model</button>
      <button className="button button--primary" disabled={busy || !models.includes(model) || !hasSteps} onClick={()=>void generate()}>Paraphrase</button></div>
    <p role="status">{status}</p>
    {draft && <><div className="caption-review">{graph.nodes.filter(n=>draft.captions[n.id]).map(n=><label key={n.id}><code>{n.label}</code><textarea maxLength={180} aria-label={`Caption for line ${n.line}`} value={draft.captions[n.id]} onChange={e=>setDraft({...draft,captions:{...draft.captions,[n.id]:e.target.value}})}/></label>)}</div>
      <button className="button button--primary" disabled={draft.key!==graphKey || Object.values(draft.captions).some(s=>!s.trim())} onClick={()=>{onCaptions(draft.captions,draft.key);onClose();}}>Apply captions</button>
      {draft.key!==graphKey && <p>Source or function changed. Generate new captions.</p>}</>}
  </section>;
}
