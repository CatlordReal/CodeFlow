import { useEffect, useRef, type KeyboardEvent } from "react";
import "./ChartTools.css";

export type ChartToolsProps = {
  localAIActive: boolean;
  localAIDisabled: boolean;
  highlightUnmodified: boolean;
  showHiddenBoxes: boolean;
  canUndo: boolean;
  historyOpen: boolean;
  onToggleLocalAI: () => void;
  onHighlightUnmodifiedChange: (value: boolean) => void;
  onShowHiddenBoxesChange: (value: boolean) => void;
  onUndo: () => void;
  onToggleHistory: () => void;
  onAlternate: () => void;
  onResetChart: () => void;
};

export default function ChartTools({
  localAIActive,
  localAIDisabled,
  highlightUnmodified,
  showHiddenBoxes,
  canUndo,
  historyOpen,
  onToggleLocalAI,
  onHighlightUnmodifiedChange,
  onShowHiddenBoxesChange,
  onUndo,
  onToggleHistory,
  onAlternate,
  onResetChart,
}: ChartToolsProps) {
  const toolsRef = useRef<HTMLDetailsElement>(null);

  const close = (restoreFocus = false) => {
    if (!toolsRef.current) return;
    toolsRef.current.open = false;
    if (restoreFocus) toolsRef.current.querySelector<HTMLElement>(":scope > summary")?.focus();
  };
  const run = (action: () => void) => {
    close();
    action();
  };

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!toolsRef.current?.contains(event.target as Node)) close();
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDetailsElement>) => {
    if (event.key !== "Escape" || !toolsRef.current?.open) return;
    event.preventDefault();
    close(true);
  };

  return (
    <details className="chart-tools" ref={toolsRef} onKeyDown={handleKeyDown}>
      <summary className="button" aria-label="Chart tools">
        Tools
        <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m8 10 4 4 4-4" /></svg>
      </summary>
      <div className="chart-tools__menu" aria-label="Chart tools">
        <button disabled={localAIDisabled} aria-pressed={localAIActive} onClick={() => run(onToggleLocalAI)}>Local AI</button>
        <button aria-pressed={highlightUnmodified} onClick={() => onHighlightUnmodifiedChange(!highlightUnmodified)}>Highlight unmodified labels</button>
        <label className="chart-tools__check">
          <input type="checkbox" checked={showHiddenBoxes} onChange={(event) => onShowHiddenBoxesChange(event.target.checked)} />
          <span>Show hidden boxes</span>
        </label>
        <span className="chart-tools__divider" />
        <button disabled={!canUndo} onClick={() => run(onUndo)}>Undo</button>
        <button aria-pressed={historyOpen} onClick={() => run(onToggleHistory)}>History</button>
        <button onClick={() => run(onAlternate)}>Alternate</button>
        <button onClick={() => run(onResetChart)}>Reset chart</button>
      </div>
    </details>
  );
}

export { ChartTools };
