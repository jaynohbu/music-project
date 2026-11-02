import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ConfirmationService } from './confirmation';
import { Job, LibraryService, Scene, SceneEntry, SceneSettings, ScenesService, errorMessage } from './services';
import { MixerPage } from './stem-pages';

async function allSongs(library: LibraryService): Promise<Job[]> {
  const songs: Job[] = [];
  let cursor: string | undefined;
  do {
    const page = await library.list(cursor);
    songs.push(...page.jobs.filter(job => job.type === 'stems' && job.status === 'completed'));
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return songs;
}

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <section class="card">
      <span class="eyebrow">YOUR SETS</span><h1>Scenes</h1>
      <p>Save split songs in order, with independent mixer settings for each entry.</p>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      @if (addingSong) { <p class="hint">Choose a scene for this song, or create a new scene.</p> }
      <form (ngSubmit)="create()">
        <label for="scene-name">New scene name</label>
        <input id="scene-name" name="name" [(ngModel)]="name" maxlength="200" required [disabled]="busy()">
        <button [disabled]="busy() || !name.trim()">Create scene</button>
      </form>
      @if (loading()) { <p role="status">Loading scenes...</p> }
      @if (!loading() && !scenes().length) { <p>No scenes yet. Create one, then add songs from Music.</p> }
      <ul class="library">
        @for (scene of scenes(); track scene.id) {
          <li>
            <div class="section-heading">
              <div><h2><a [routerLink]="['/scenes', scene.id]">{{ scene.name }}</a></h2>
                <p class="hint">{{ scene.entries.length }} songs</p></div>
              <div class="scene-actions">
                @if (addingSong) {
                  <button type="button" (click)="add(scene)" [disabled]="busy()">Add to this scene</button>
                }
                <a [routerLink]="['/scenes', scene.id]">Open</a>
                <button type="button" class="secondary" (click)="remove(scene)" [disabled]="busy()">Delete scene</button>
              </div>
            </div>
          </li>
        }
      </ul>
    </section>
  `,
})
export class ScenesPage implements OnInit {
  private readonly service = inject(ScenesService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly confirm = inject(ConfirmationService);
  readonly scenes = signal<Scene[]>([]);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly loading = signal(true);
  name = '';
  addingSong = this.route.snapshot.queryParamMap.get('song');
  async ngOnInit(): Promise<void> {
    try { this.scenes.set((await this.service.list()).scenes); }
    catch (error) { this.error.set(errorMessage(error)); }
    finally { this.loading.set(false); }
  }
  async create(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true); this.error.set('');
    try {
      let { scene } = await this.service.create(this.name.trim());
      this.scenes.update(items => [scene, ...items]);
      this.name = '';
      if (this.addingSong) {
        scene = (await this.service.update(scene.id, scene.revision, { entries: [
          { id: crypto.randomUUID(), jobId: this.addingSong },
        ] })).scene;
      }
      await this.router.navigate(['/scenes', scene.id]);
    } catch (error) { this.error.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }
  async add(scene: Scene): Promise<void> {
    if (!this.addingSong || this.busy()) return;
    this.busy.set(true); this.error.set('');
    try {
      await this.service.update(scene.id, scene.revision, { entries: [
        ...scene.entries, { id: crypto.randomUUID(), jobId: this.addingSong },
      ] });
      await this.router.navigate(['/scenes', scene.id]);
    } catch (error) { this.error.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }
  async remove(scene: Scene): Promise<void> {
    if (!await this.confirm.confirm('Delete scene?', `Delete "${scene.name}"? Your music files will not be deleted.`, 'Delete scene')) return;
    this.busy.set(true);
    try {
      await this.service.remove(scene.id);
      this.scenes.update(items => items.filter(item => item.id !== scene.id));
    } catch (error) { this.error.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }
}

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink, MixerPage],
  template: `
    <section class="card scene-editor">
      <div class="section-heading"><h1>{{ scene()?.name || 'Scene' }}</h1><a routerLink="/scenes">All scenes</a></div>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      @if (scene(); as scene) {
        <label for="edit-scene-name">Scene name</label>
        <input id="edit-scene-name" [ngModel]="scene.name" (ngModelChange)="rename($event)" maxlength="200">
        <div class="scene-actions">
          <span role="status" class="hint">{{ saveStatus() }}</span>
          @if (saveError()) {
            <button type="button" (click)="retrySave()">Retry save</button>
            <button type="button" class="secondary" (click)="reload()">Reload saved scene</button>
          }
          <button type="button" (click)="openPicker()">Add songs</button>
        </div>
        @if (saveError()) { <p class="error" role="alert">{{ saveError() }}</p> }
        <p class="hint">Drag songs up or down to reorder. Settings and scene titles save automatically.
          Loop repeats the current song; turn it off to continue to the next.</p>
        <ol class="scene-song-list" (dragover)="dragOver($event)" (drop)="drop($event)">
          @for (entry of scene.entries; track entry.id; let i = $index) {
            <li [class.current]="activeId() === entry.id" [attr.data-entry]="entry.id"
              [class.dragging]="draggedId === entry.id">
              <button type="button" class="drag-handle secondary" draggable="true"
                (dragstart)="dragStart(entry.id, $event)" (dragend)="endDrag()"
                [attr.aria-label]="'Drag ' + (i + 1) + '. ' + title(entry)">↕</button>
              <div class="scene-entry-name">
                <button type="button" class="song-select" (click)="select(entry.id)"
                  [attr.aria-label]="'Load ' + (i + 1) + '. ' + title(entry)">
                  {{ i + 1 }}. {{ title(entry) }}
                </button>
                <label [for]="'scene-title-' + entry.id">Scene song title</label>
                <input [id]="'scene-title-' + entry.id" [ngModel]="entry.title ?? title(entry)"
                  (ngModelChange)="renameEntry(entry.id, $event)" maxlength="200">
              </div>
              <div class="scene-actions">
                <button type="button" class="secondary" (click)="move(entry.id, -1)" [disabled]="i === 0"
                  [attr.aria-label]="'Move ' + (i + 1) + '. ' + title(entry) + ' up'">↑</button>
                <button type="button" class="secondary" (click)="move(entry.id, 1)" [disabled]="i === scene.entries.length - 1"
                  [attr.aria-label]="'Move ' + (i + 1) + '. ' + title(entry) + ' down'">↓</button>
                <button type="button" class="secondary" (click)="removeEntry(entry.id)">Remove</button>
              </div>
            </li>
          }
        </ol>
        @if (!scene.entries.length) { <p>This scene is empty. Add songs to get started.</p> }
        @if (activeEntry(); as active) {
          <div class="scene-actions">
            @if (playbackError()) {
              <p class="error" role="alert">{{ playbackError() }}</p>
              <button type="button" (click)="retryPlayback()">Retry playback</button>
              <button type="button" class="secondary" (click)="next(true)"
                [disabled]="activeIndex() >= scene.entries.length - 1">Skip song</button>
            }
          </div>
          @for (entry of [active]; track entry.id) {
            <app-stem-mixer [sceneEntry]="entry" [sceneTitle]="(activeIndex() + 1) + '. ' + title(entry)"
              [hasPrevious]="activeIndex() > 0" [hasNext]="activeIndex() < scene.entries.length - 1"
              (previousSong)="previous()" (nextSong)="next(false)"
              (settingsChanged)="settings(entry.id, $event)" (sceneTitleChanged)="renameEntry(entry.id, $event)"
              (songEnded)="next(true)" (audioReady)="ready()" (audioFailed)="failed($event)"></app-stem-mixer>
          }
        }
      } @else if (!error()) { <p role="status">Loading scene...</p> }
    </section>
    <dialog #picker class="app-dialog song-picker" aria-labelledby="song-picker-title">
      <h2 id="song-picker-title">Add split songs</h2>
      <p>Only completed songs from your private Music library can be added.</p>
      @for (song of songs(); track song.jobId) {
        <label class="picker-choice"><input type="checkbox" [checked]="selected.has(song.jobId)"
          (change)="choose(song.jobId, $event)"> {{ song.title }} @if (song.author) { — {{ song.author }} }</label>
      }
      @if (!songs().length) { <p>No completed split songs. <a routerLink="/split" (click)="closePicker()">Upload a song</a>.</p> }
      <div class="dialog-actions">
        <button type="button" class="secondary" (click)="closePicker()">Cancel</button>
        <button type="button" (click)="addSongs()" [disabled]="!selected.size">Add selected songs</button>
      </div>
    </dialog>
  `,
})
export class ScenePage implements OnInit, OnDestroy {
  private readonly service = inject(ScenesService);
  private readonly library = inject(LibraryService);
  private readonly route = inject(ActivatedRoute);
  private readonly confirm = inject(ConfirmationService);
  @ViewChild('picker') picker?: ElementRef<HTMLDialogElement>;
  @ViewChild(MixerPage) mixer?: MixerPage;
  readonly scene = signal<Scene | null>(null);
  readonly songs = signal<Job[]>([]);
  readonly error = signal('');
  readonly saveError = signal('');
  readonly saveStatus = signal('Saved');
  readonly activeId = signal('');
  readonly playbackError = signal('');
  selected = new Set<string>();
  draggedId = '';
  private revision = 0;
  private edits = 0;
  private savedEdits = 0;
  private saving?: Promise<boolean>;
  private timer?: ReturnType<typeof setTimeout>;
  private autoPlay = false;
  private destroyed = false;
  private dragY = 0;
  private dragFrame = 0;
  private readonly id = this.route.snapshot.paramMap.get('sceneId')!;

  async ngOnInit(): Promise<void> {
    try {
      const [result, songs] = await Promise.all([this.service.get(this.id), allSongs(this.library)]);
      if (this.destroyed) return;
      this.scene.set(result.scene); this.revision = result.scene.revision;
      this.songs.set(songs); this.activeId.set(result.scene.entries[0]?.id ?? '');
    } catch (error) { this.error.set(errorMessage(error)); }
  }
  title(entry: SceneEntry): string {
    return entry.title || this.songs().find(song => song.jobId === entry.jobId)?.title || 'Unavailable song';
  }
  activeEntry(): SceneEntry | undefined { return this.scene()?.entries.find(entry => entry.id === this.activeId()); }
  activeIndex(): number { return this.scene()?.entries.findIndex(entry => entry.id === this.activeId()) ?? -1; }
  private change(update: (scene: Scene) => Scene): void {
    this.scene.update(scene => scene ? update(scene) : scene);
    this.edits++; this.saveStatus.set('Unsaved changes');
    clearTimeout(this.timer);
    if (!this.saveError()) this.timer = setTimeout(() => { void this.flush(); }, 600);
  }
  rename(name: string): void { this.change(scene => ({ ...scene, name })); }
  renameEntry(id: string, title: string): void {
    this.change(scene => ({ ...scene, entries: scene.entries.map(entry =>
      entry.id === id ? { ...entry, title: title.trim() ? title : undefined } : entry) }));
  }
  settings(id: string, settings: SceneSettings): void {
    const current = this.scene()?.entries.find(entry => entry.id === id);
    if (!current || JSON.stringify(current.settings) === JSON.stringify(settings)) return;
    this.change(scene => ({ ...scene, entries: scene.entries.map(entry => entry.id === id ? { ...entry, settings } : entry) }));
  }
  async flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.saving) return this.saving;
    this.saving = this.saveLoop();
    try { return await this.saving; } finally { this.saving = undefined; }
  }
  private async saveLoop(): Promise<boolean> {
    while (this.savedEdits < this.edits && !this.destroyed) {
      const scene = this.scene();
      if (!scene) return false;
      const version = this.edits;
      this.saveStatus.set('Saving...');
      try {
        const result = await this.service.update(this.id, this.revision, { name: scene.name, entries: scene.entries });
        this.revision = result.scene.revision;
        this.savedEdits = version;
        this.saveError.set('');
      } catch (error) {
        this.saveError.set(errorMessage(error)); this.saveStatus.set('Save failed — Retry');
        return false;
      }
    }
    this.saveStatus.set('Saved');
    return true;
  }
  retrySave(): void { this.saveError.set(''); void this.flush(); }
  async reload(): Promise<void> {
    if (!await this.confirm.confirm('Reload saved scene?', 'This discards unsaved scene changes and stops playback.', 'Reload')) return;
    this.mixer?.stop(); this.autoPlay = false;
    try {
      const { scene } = await this.service.get(this.id);
      this.activeId.set('');
      this.scene.set(scene); this.revision = scene.revision;
      this.savedEdits = this.edits; this.saveError.set(''); this.saveStatus.set('Saved');
      setTimeout(() => this.activeId.set(scene.entries[0]?.id ?? ''), 0);
    } catch (error) { this.error.set(errorMessage(error)); }
  }
  async canLeave(): Promise<boolean> {
    if (await this.flush()) return true;
    return this.confirm.confirm('Leave without saving?', 'Some scene changes could not be saved. Stay and retry, or leave and discard those changes.', 'Leave');
  }
  select(id: string, play = false): void {
    if (this.activeId() === id) { if (play) void this.mixer?.play(); return; }
    this.mixer?.stop(); this.autoPlay = play; this.playbackError.set(''); this.activeId.set(id);
  }
  previous(): void {
    const entry = this.scene()?.entries[this.activeIndex() - 1];
    if (entry) this.select(entry.id);
  }
  next(play: boolean): void {
    const entry = this.scene()?.entries[this.activeIndex() + 1];
    if (entry) this.select(entry.id, play);
    else { this.autoPlay = false; this.saveStatus.set(this.savedEdits === this.edits ? 'Saved · Scene finished' : 'Unsaved changes'); }
  }
  ready(): void { if (this.autoPlay) { this.autoPlay = false; void this.mixer?.play(); } }
  failed(message: string): void { this.autoPlay = false; this.playbackError.set(message); }
  async retryPlayback(): Promise<void> {
    this.playbackError.set('');
    await this.mixer?.retryLoadAndRenew();
    if (this.mixer?.canPlay()) await this.mixer.play();
  }
  move(id: string, delta: number): void {
    const entries = [...(this.scene()?.entries ?? [])], from = entries.findIndex(entry => entry.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= entries.length) return;
    const [entry] = entries.splice(from, 1); entries.splice(to, 0, entry);
    this.change(scene => ({ ...scene, entries }));
  }
  async removeEntry(id: string): Promise<void> {
    const entry = this.scene()?.entries.find(item => item.id === id);
    if (!entry || !await this.confirm.confirm('Remove song from scene?', `Remove "${this.title(entry)}" and its scene settings? The original music is not deleted.`, 'Remove song')) return;
    const index = this.activeIndex();
    if (this.activeId() === id) this.mixer?.stop();
    this.change(scene => ({ ...scene, entries: scene.entries.filter(item => item.id !== id) }));
    if (this.activeId() === id) {
      this.autoPlay = false;
      this.playbackError.set('');
      this.activeId.set(this.scene()?.entries[Math.max(0, Math.min(index, (this.scene()?.entries.length ?? 1) - 1))]?.id ?? '');
    }
  }
  async openPicker(): Promise<void> {
    try { this.songs.set(await allSongs(this.library)); this.selected.clear(); this.picker?.nativeElement.showModal(); }
    catch (error) { this.error.set(errorMessage(error)); }
  }
  closePicker(): void { this.picker?.nativeElement.close(); }
  choose(id: string, event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    if (event.target.checked) this.selected.add(id); else this.selected.delete(id);
  }
  addSongs(): void {
    const entries = this.songs().filter(song => this.selected.has(song.jobId)).map(song => ({ id: crypto.randomUUID(), jobId: song.jobId }));
    if ((this.scene()?.entries.length ?? 0) + entries.length > 99) {
      this.error.set('A scene can contain up to 99 songs.'); this.closePicker(); return;
    }
    this.change(scene => ({ ...scene, entries: [...scene.entries, ...entries] }));
    if (!this.activeId()) this.activeId.set(entries[0]?.id ?? '');
    this.closePicker();
  }
  dragStart(id: string, event: DragEvent): void {
    this.draggedId = id;
    this.dragY = event.clientY;
    event.dataTransfer?.setData('text/plain', id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    const scroll = () => {
      if (!this.draggedId) return;
      if (this.dragY < 90) window.scrollBy(0, -14);
      else if (this.dragY > window.innerHeight - 90) window.scrollBy(0, 14);
      this.dragFrame = requestAnimationFrame(scroll);
    };
    this.dragFrame = requestAnimationFrame(scroll);
  }
  @HostListener('document:dragover', ['$event'])
  dragOver(event: DragEvent): void { if (this.draggedId) { event.preventDefault(); this.dragY = event.clientY; } }
  @HostListener('document:visibilitychange')
  saveWhenHidden(): void { if (document.visibilityState === 'hidden') void this.flush(); }
  drop(event: DragEvent): void {
    event.preventDefault();
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-entry]') : null;
    const entries = [...(this.scene()?.entries ?? [])];
    const from = entries.findIndex(entry => entry.id === this.draggedId);
    const to = entries.findIndex(entry => entry.id === target?.dataset['entry']);
    if (from >= 0 && to >= 0 && from !== to) {
      const [entry] = entries.splice(from, 1); entries.splice(to, 0, entry);
      this.change(scene => ({ ...scene, entries }));
    }
    this.endDrag();
  }
  endDrag(): void { this.draggedId = ''; cancelAnimationFrame(this.dragFrame); }
  ngOnDestroy(): void { this.destroyed = true; clearTimeout(this.timer); this.endDrag(); }
}
