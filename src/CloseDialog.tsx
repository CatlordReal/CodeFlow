import { useId, useLayoutEffect, useRef } from 'react';

export type CloseChoice = 'save' | 'discard' | 'cancel';

export function CloseDialog({ onChoose }: { onChoose: (choice: CloseChoice) => void }) {
  const backdropRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const chooseRef = useRef(onChoose);
  chooseRef.current = onChoose;
  const titleId = useId();
  const descriptionId = useId();

  useLayoutEffect(() => {
    const backdrop = backdropRef.current;
    if (!backdrop) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const isolated: { element: HTMLElement; inert: boolean }[] = [];
    let current: HTMLElement | null = backdrop;
    while (current?.parentElement) {
      const parent: HTMLElement = current.parentElement;
      for (const sibling of parent.children) {
        if (sibling !== current && sibling instanceof HTMLElement) {
          isolated.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      current = parent;
      if (current === document.body) break;
    }
    cancelRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        chooseRef.current('cancel');
      } else if (event.key === 'Tab') {
        const buttons = Array.from(backdrop.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.shiftKey ? (index <= 0 ? buttons.length - 1 : index - 1) : (index < 0 || index === buttons.length - 1 ? 0 : index + 1);
        event.preventDefault();
        buttons[next].focus();
      }
    };
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      for (const { element, inert } of isolated) element.inert = inert;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div ref={backdropRef} className="dialog-backdrop close-dialog-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onChoose('cancel'); }}>
      <section className="update-dialog close-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <div className="update-dialog__content">
          <h2 id={titleId}>Save changes?</h2>
          <p id={descriptionId}>Save your project before closing, or close without saving your changes.</p>
          <div className="update-dialog__actions">
            <button ref={cancelRef} className="button" onClick={() => onChoose('cancel')}>Cancel</button>
            <button className="button" onClick={() => onChoose('discard')}>Close without saving</button>
            <button className="button button--primary" onClick={() => onChoose('save')}>Save</button>
          </div>
        </div>
      </section>
    </div>
  );
}
