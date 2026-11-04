import type { Scene } from './api';

export class SceneStore {
  private edits = 0;
  private saved = 0;
  private revision: number;
  private saving: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  status = 'Saved';
  error = '';
  constructor(public scene: Scene,
    private readonly write: (id: string, revision: number, patch: { name: string; entries: Scene['entries'] }) => Promise<Scene>,
    private readonly changed: () => void) { this.revision = scene.revision; }
  update(update: (scene: Scene) => Scene) {
    this.scene = update(this.scene);
    this.edits++;
    this.status = 'Unsaved changes';
    this.changed();
    if (this.timer) clearTimeout(this.timer);
    if (!this.error) this.timer = setTimeout(() => { void this.flush(); }, 600);
  }
  get dirty() { return this.edits !== this.saved; }
  async flush(): Promise<boolean> {
    if (this.timer) clearTimeout(this.timer);
    if (this.saving) return this.saving;
    this.saving = this.saveLoop();
    try { return await this.saving; } finally { this.saving = null; }
  }
  private async saveLoop() {
    while (this.dirty) {
      const version = this.edits, snapshot = this.scene;
      this.status = 'Saving…'; this.changed();
      try {
        const result = await this.write(snapshot.id, this.revision, { name: snapshot.name, entries: snapshot.entries });
        this.revision = result.revision; this.saved = version; this.error = '';
      } catch (error) {
        this.error = error instanceof Error ? error.message : 'Could not save this scene.';
        this.status = 'Save failed'; this.changed(); return false;
      }
    }
    this.status = 'Saved'; this.changed(); return true;
  }
  reload(scene: Scene) {
    if (this.timer) clearTimeout(this.timer);
    this.scene = scene; this.revision = scene.revision; this.saved = this.edits;
    this.status = 'Saved'; this.error = ''; this.changed();
  }
  discard() {
    if (this.timer) clearTimeout(this.timer);
    this.saved = this.edits;
  }
}
