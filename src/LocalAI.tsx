import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import type { FlowGraph } from './types';

type Decision = 'pending' | 'accepted' | 'declined';
type Draft = {
  captions: Record<string, string>;
  decisions: Record<string, Decision>;
  graphKey: string;
  proposalKey: string;
  source: string;
};

type Props = {
  graph: FlowGraph;
  source: string;
  graphKey: string;
  proposalKey: string;
  onCaptions: (captions: Record<string, string>, key: string) => void;
  onClose: () => void;
};

export default function LocalAI({ graph, source, graphKey, proposalKey, onCaptions, onClose }: Props) {
  const hasSteps = graph.nodes.some(node => ['process', 'io'].includes(node.kind));
  const [model, setModel] = useState('qwen2.5:0.5b');
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState('Checking local Ollama…');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const active = useRef(true);
  const generation = useRef(0);
  const generating = useRef(false);
  const context = useRef({ graphKey, proposalKey, source });
  const previousContext = useRef({ graphKey, proposalKey, source });
  context.current = { graphKey, proposalKey, source };

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      generation.current += 1;
    };
  }, []);

  useEffect(() => {
    const previous = previousContext.current;
    previousContext.current = { graphKey, proposalKey, source };
    if (previous.graphKey === graphKey && previous.proposalKey === proposalKey && previous.source === source) return;
    generation.current += 1;
    if (generating.current) {
      generating.current = false;
      setBusy(false);
    }
    setDraft(current => current ? null : current);
    setStatus('Chart labels changed. Generate new proposals.');
  }, [graphKey, proposalKey, source]);

  const message = (cause: unknown) => typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : 'Local AI request failed.';

  async function refresh() {
    try {
      if (!('__TAURI_INTERNALS__' in window)) throw new Error('Local AI runs in the desktop app.');
      const found = await invoke<string[]>('ai_models');
      if (active.current) {
        setModels(found);
        setStatus(found.length ? 'Local models ready.' : 'Download a model to begin.');
      }
    } catch (cause) {
      if (active.current) setStatus(message(cause));
    }
  }

  async function download() {
    setBusy(true);
    setStatus('Downloading model through Ollama. Interrupted downloads resume; one checksum mismatch retries automatically.');
    try {
      await invoke('ai_download', { model });
      if (active.current) await refresh();
    } catch (cause) {
      if (active.current) setStatus(message(cause));
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function generate() {
    const request = ++generation.current;
    const requestContext = { graphKey, proposalKey, source };
    generating.current = true;
    setBusy(true);
    setDraft(null);
    setStatus('Writing captions locally…');
    try {
      const nodes = graph.nodes
        .filter(node => ['process', 'io'].includes(node.kind))
        .map(node => ({
          id: node.id,
          code: node.shape === 'subprocess'
            ? new TextDecoder().decode(new TextEncoder().encode(source).slice(node.start_byte, node.end_byte))
            : node.original_label ?? node.label,
          kind: node.kind,
        }));
      const captions = await invoke<Record<string, string>>('ai_captions', { model, nodes });
      const latest = context.current;
      if (!active.current || request !== generation.current || latest.graphKey !== requestContext.graphKey || latest.proposalKey !== requestContext.proposalKey || latest.source !== requestContext.source) return;
      const decisions = Object.fromEntries(Object.keys(captions).map(id => [id, 'pending' as const]));
      setDraft({ captions, decisions, ...requestContext });
      setStatus('Review each proposal. Only accepted captions are applied.');
    } catch (cause) {
      if (active.current && request === generation.current) setStatus(message(cause));
    } finally {
      if (active.current && request === generation.current) {
        generating.current = false;
        setBusy(false);
      }
    }
  }

  function decide(id: string, decision: Decision) {
    setDraft(current => current ? { ...current, decisions: { ...current.decisions, [id]: decision } } : null);
  }

  function decideAll(decision: Decision) {
    setDraft(current => current ? {
      ...current,
      decisions: Object.fromEntries(Object.keys(current.captions).map(id => [id, decision])),
    } : null);
  }

  function applyAccepted() {
    if (!draft || draft.graphKey !== graphKey || draft.proposalKey !== proposalKey || draft.source !== source) return;
    const accepted = Object.fromEntries(Object.entries(draft.captions)
      .filter(([id, caption]) => draft.decisions[id] === 'accepted' && caption.trim())
      .map(([id, caption]) => [id, caption.trim()]));
    const count = Object.keys(accepted).length;
    if (!count) return;
    onCaptions(accepted, draft.graphKey);
    setDraft(null);
    setStatus(`${count} accepted caption${count === 1 ? '' : 's'} applied.`);
  }

  const reviewNodes = draft ? graph.nodes.filter(node => draft.captions[node.id] !== undefined) : [];
  const acceptedCount = draft ? reviewNodes.filter(node => draft.decisions[node.id] === 'accepted' && draft.captions[node.id].trim()).length : 0;

  return <section className="ai-panel" aria-label="Local AI captions">
    <header><h2>Local AI</h2><button className="button" onClick={onClose}>Close</button></header>
    <p>Requires <a href="https://ollama.com/download" target="_blank" rel="noreferrer">Ollama</a> running on this computer. Code stays local. Model download needs internet.</p>
    <label>Model <select value={model} disabled={busy} onChange={event => setModel(event.target.value)}>
      <option value="qwen2.5:0.5b">Qwen 0.5B · 398 MB · small</option>
      <option value="qwen3.5:4b">Qwen 3.5 4B · larger model</option>
      <option value="qwen2.5:3b">Qwen 3B · 1.9 GB · better captions</option>
    </select></label>
    <div className="ai-actions">
      <button className="button" disabled={busy} onClick={() => void refresh()}>Refresh</button>
      <button className="button" disabled={busy || models.includes(model)} onClick={() => void download()}>Download model</button>
      <button className="button button--primary" disabled={busy || !models.includes(model) || !hasSteps} onClick={() => void generate()}>Paraphrase</button>
    </div>
    <p role="status">{status}</p>
    {draft && <>
      <div className="caption-bulk-actions" aria-label="Caption review actions">
        <button className="button" onClick={() => decideAll('accepted')}>Accept all</button>
        <button className="button" onClick={() => decideAll('declined')}>Decline all</button>
      </div>
      <ul className="caption-review">
        {reviewNodes.map(node => <li key={node.id} className={`caption-proposal caption-proposal--${draft.decisions[node.id]}`}>
          <div className="caption-comparison">
            <div><strong>Existing</strong><code>{node.label}</code></div>
            <label><strong>Proposed</strong><textarea maxLength={180} aria-label={`Proposed caption for line ${node.line}`} value={draft.captions[node.id]} onChange={event => setDraft(current => current ? { ...current, captions: { ...current.captions, [node.id]: event.target.value }, decisions: { ...current.decisions, [node.id]: 'pending' } } : null)} /></label>
          </div>
          <div className="caption-decision" aria-label={`Review caption for line ${node.line}`}>
            <span>{draft.decisions[node.id] === 'accepted' ? 'Accepted' : draft.decisions[node.id] === 'declined' ? 'Declined' : 'Review needed'}</span>
            <button className="button" aria-pressed={draft.decisions[node.id] === 'accepted'} onClick={() => decide(node.id, 'accepted')}>Accept</button>
            <button className="button" aria-pressed={draft.decisions[node.id] === 'declined'} onClick={() => decide(node.id, 'declined')}>Decline</button>
          </div>
        </li>)}
      </ul>
      <button className="button button--primary" disabled={!acceptedCount} onClick={applyAccepted}>Apply accepted ({acceptedCount})</button>
    </>}
  </section>;
}
