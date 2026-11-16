import { useCallback, useEffect, useRef, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

type Props = { onError?: (message: string) => void };

export default function FullscreenControl({ onError }: Props) {
  const [fullscreen, setFullscreen] = useState(false);
  const busy = useRef(false);
  const report = useRef(onError);
  report.current = onError;
  const desktop = '__TAURI_INTERNALS__' in window;

  const toggle = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      if (desktop) {
        const appWindow = getCurrentWindow();
        const next = !(await appWindow.isFullscreen());
        await appWindow.setFullscreen(next);
        setFullscreen(next);
      } else if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch (error) {
      report.current?.(`Fullscreen failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy.current = false;
    }
  }, [desktop]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== 'F11' || event.repeat || event.defaultPrevented) return;
      event.preventDefault();
      void toggle();
    };
    window.addEventListener('keydown', keydown);
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      if (desktop) void getCurrentWindow().isFullscreen().then(value => { if (!cancelled) setFullscreen(value); }).catch(() => {});
      else setFullscreen(!!document.fullscreenElement);
    };
    sync();
    if (desktop) {
      void getCurrentWindow().onResized(sync).then(stop => { if (cancelled) stop(); else unlisten = stop; }).catch(() => {});
    } else document.addEventListener('fullscreenchange', sync);
    return () => {
      cancelled = true;
      unlisten?.();
      window.removeEventListener('keydown', keydown);
      document.removeEventListener('fullscreenchange', sync);
    };
  }, [desktop, toggle]);

  const label = fullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
  return <button type="button" className="icon-button" aria-label={label} title={`${label} (F11)`} onClick={() => void toggle()}>
    <svg aria-hidden="true" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {fullscreen ? <path d="M4 9h5V4M20 9h-5V4M4 15h5v5M20 15h-5v5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
    </svg>
  </button>;
}
