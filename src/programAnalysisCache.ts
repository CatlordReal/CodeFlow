/** Reuse parsing while presentation changes; discard entries when source identity changes. */
export class ProgramAnalysisCache<T> {
  private identity = '';
  private entries = new Map<string, Promise<T>>();

  use(identity: string, id: string, load: () => Promise<T>): Promise<T> {
    if (identity !== this.identity) { this.identity = identity; this.entries = new Map(); }
    const entries = this.entries;
    let pending = entries.get(id);
    if (!pending) {
      pending = load();
      entries.set(id, pending);
      const current = pending;
      void current.catch(() => { if (entries.get(id) === current) entries.delete(id); });
    }
    return pending;
  }
}
