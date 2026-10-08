export type CloseRecoverySnapshot = {
  contents: string;
  projectToken: string | null;
  dirty: boolean;
  sourceDirty: boolean;
  projectDirty: boolean;
};

type CloseDependencies = {
  recoveryReady: () => boolean;
  snapshot: () => CloseRecoverySnapshot;
  confirm: () => Promise<boolean>;
  saveRecovery: (snapshot: CloseRecoverySnapshot) => Promise<void>;
  destroy: () => Promise<void>;
  showError: (message: string) => void;
};

function sameSnapshot(left: CloseRecoverySnapshot, right: CloseRecoverySnapshot): boolean {
  return left.contents === right.contents
    && left.projectToken === right.projectToken
    && left.dirty === right.dirty
    && left.sourceDirty === right.sourceDirty
    && left.projectDirty === right.projectDirty;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "Unknown error";
}

export function createDesktopCloseHandler(dependencies: CloseDependencies): () => Promise<void> {
  let closing = false;

  return async () => {
    if (closing) return;
    if (!dependencies.recoveryReady()) {
      dependencies.showError("Recovery is still loading. Close again when it finishes.");
      return;
    }

    closing = true;
    try {
      const initial = dependencies.snapshot();
      if ((initial.dirty || initial.projectDirty) && !await dependencies.confirm()) return;

      let saved = dependencies.snapshot();
      while (true) {
        await dependencies.saveRecovery(saved);
        const latest = dependencies.snapshot();
        if (sameSnapshot(saved, latest)) break;
        saved = latest;
      }

      await dependencies.destroy();
    } catch (cause) {
      dependencies.showError(`CodeFlow could not close: ${errorMessage(cause)}`);
    } finally {
      closing = false;
    }
  };
}
