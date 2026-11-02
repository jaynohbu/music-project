import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService, Job, LibraryService, ScenesService, StemsService, errorMessage } from './services';
import { ConfirmationService } from './confirmation';

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <section class="card narrow">
      <h1>{{ newPassword() ? 'Set your password' : 'Welcome back' }}</h1>
      <p>Sign in to your private audio library.</p>
      <form (ngSubmit)="submit()">
        @if (!newPassword()) {
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="username"
            [(ngModel)]="email" required [disabled]="busy()">
        }
        <label for="password">{{ newPassword() ? 'New password' : 'Password' }}</label>
        <input id="password" name="password" type="password"
          [attr.autocomplete]="newPassword() ? 'new-password' : 'current-password'"
          [(ngModel)]="password" required [disabled]="busy()">
        @if (newPassword()) {
          <p class="hint">Use at least 12 characters with uppercase, lowercase, a number and a symbol.</p>
        }
        @if (error() || auth.notice()) {
          <p role="alert" class="error">{{ error() || auth.notice() }}</p>
        }
        <button type="submit" [disabled]="busy() || !password || (!newPassword() && !email)">
          {{ busy() ? 'Signing in...' : newPassword() ? 'Save password' : 'Sign in' }}
        </button>
      </form>
      <p><a routerLink="/register">Register</a> &middot;
        <a routerLink="/forgot-password">Forgot password?</a></p>
      <p class="hint">New accounts must be enabled by an administrator before sign-in.</p>
    </section>
  `,
})
export class LoginPage {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  email = '';
  password = '';
  readonly newPassword = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      if (this.newPassword()) await this.auth.setPassword(this.password);
      else if (!await this.auth.login(this.email, this.password)) {
        this.newPassword.set(true);
        this.password = '';
        return;
      }
      this.password = '';
      await this.router.navigateByUrl('/list');
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <section class="card">
      <span class="eyebrow">YOUR AUDIO LIBRARY</span>
      <h1>Turn a video into audio</h1>
      <p class="hint">Conversion runs on this computer using http://127.0.0.1:3001.
        Start the local service first and allow local-network access if your browser asks.
        Your library and converted audio are still saved in AWS.</p>
      <a routerLink="/youtube-files">Your YouTube files</a>
      <p>Paste a YouTube video URL. We will extract an MP3 file and save it privately.</p>
      <form (ngSubmit)="submit()">
        <label for="url">YouTube video URL</label>
        <input id="url" name="url" type="url" placeholder="https://www.youtube.com/watch?v=..."
          [(ngModel)]="url" required [disabled]="busy()">
        <p class="hint">CPU-only conversion. Videos must be non-live and under 10 minutes.
          Only submit content you own or have permission to download.</p>
        @if (error()) { <p role="alert" class="error">{{ error() }}</p> }
        @if (accepted()) {
          <p role="status" class="success">Conversion queued. Open the list to follow progress.</p>
          <a routerLink="/youtube-files">View your YouTube files</a>
        }
        <button type="submit" [disabled]="busy() || !url.trim()">
          {{ busy() ? 'Submitting...' : 'Convert and save' }}
        </button>
      </form>
    </section>
  `,
})
export class UploadPage {
  private readonly library = inject(LibraryService);
  url = '';
  readonly busy = signal(false);
  readonly error = signal('');
  readonly accepted = signal(false);

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.accepted.set(false);
    try {
      await this.library.create(this.url.trim());
      this.accepted.set(true);
      this.url = '';
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  standalone: true,
  imports: [DatePipe, RouterLink],
  template: `
    <section class="card">
      <div class="section-heading">
        <div><span class="eyebrow">{{ youtubeView ? 'YOUR CONVERSIONS' : 'YOUR SPLIT SONGS' }}</span><h1>{{ youtubeView ? 'YouTube files' : 'Music' }}</h1></div>
        <div class="scene-actions"><a class="button-link" routerLink="/split">Upload &amp; split</a>
          <button class="secondary" (click)="refresh()" [disabled]="busy()">Refresh</button></div>
      </div>
      <p class="hint">Jobs refresh every 5 seconds while this page is open.
        Failed jobs disappear 10 minutes after failure.
        Playback and download links expire after one hour; refresh to renew them.</p>
      @if (error()) { <p role="alert" class="error">{{ error() }}</p> }
      @if (busy() && !jobs().length) { <p role="status">Loading your library...</p> }
      @if (!busy() && !jobs().length && !error()) {
        <div class="empty"><h2>No files yet</h2><p>Your music will appear here.</p>
          @if (auth.youtubeAllowed()) { <a routerLink="/upload">Convert a video</a> · }
          <a routerLink="/split">Upload audio to split</a></div>
      }
      <ul class="library">
        @for (job of jobs(); track job.jobId) {
          <li>
            <div class="file-heading">
              <h2>{{ job.title || 'YouTube conversion' }}</h2>
              <span class="badge" [class.failed]="job.status === 'failed'">{{ job.status }}</span>
            </div>
            <p class="hint">{{ job.createdAt | date:'medium' }}</p>
            @if (job.author) { <p class="hint">By {{ job.author }}</p> }
            @if (job.type === 'stems') {
              <p class="hint">Six-stem audio separation</p>
              @if (job.status === 'completed') {
                <a class="download" [routerLink]="['/mixer', job.jobId]">Open stem mixer</a>
                <a class="download" routerLink="/scenes" [queryParams]="{song: job.jobId}">Add to scene</a>
              }
              @if (job.status === 'completed' || job.status === 'failed' || job.status === 'deleting') {
                <button type="button" class="secondary" (click)="deleteSong(job)" [disabled]="busy()">Delete song</button>
              }
            } @else {
              @if (job.sourceUrl) {
                <a [href]="job.sourceUrl" target="_blank" rel="noopener noreferrer">Original video</a>
              }
              @if (job.status === 'completed' && job.playUrl && job.downloadUrl) {
                <audio controls preload="none" [src]="job.playUrl" (error)="playbackError()"></audio>
                <a class="download" [href]="job.downloadUrl">Download audio</a>
              }
            }
            @if (job.error) { <p class="error">{{ job.error }}</p> }
            @if (job.errorCode) {
              <p class="hint">Reason: {{ job.errorCode }} · Stage: {{ job.failureStage || 'conversion' }}</p>
            }
          </li>
        }
      </ul>
      @if (cursor()) {
        <button class="secondary" (click)="loadMore()" [disabled]="busy()">Load more</button>
      }
    </section>
  `,
})
export class ListPage implements OnInit, OnDestroy {
  readonly youtubeView = inject(ActivatedRoute).snapshot.data['youtube'] === true;
  readonly auth = inject(AuthService);
  private readonly library = inject(LibraryService);
  private readonly stems = inject(StemsService);
  private readonly scenes = inject(ScenesService);
  private readonly confirm = inject(ConfirmationService);
  private timer?: ReturnType<typeof setInterval>;
  private destroyed = false;
  private loadedPages = 1;
  readonly jobs = signal<Job[]>([]);
  readonly cursor = signal<string | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');

  async deleteSong(job: Job): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const { scenes } = await this.scenes.list();
      const used = scenes.filter(scene => scene.entries.some(entry => entry.jobId === job.jobId));
      const detail = used.length ? ` It will also be removed from these scenes: ${used.map(scene => scene.name).join(', ')}.` : '';
      if (!await this.confirm.confirm('Permanently delete song?',
        `Delete "${job.title}" and all its stems, cleaned audio, lyrics and analysis?${detail} This cannot be undone.`, 'Delete song')) return;
      await this.stems.remove(job.jobId);
      this.jobs.update(items => items.filter(item => item.jobId !== job.jobId));
    } catch (error) { this.error.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }

  ngOnInit(): void {
    void this.refresh(false);
    this.timer = setInterval(() => { void this.refresh(false); }, 5000);
  }
  ngOnDestroy(): void {
    this.destroyed = true;
    clearInterval(this.timer);
  }

  async refresh(forceRenew = true): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const jobs: Job[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < this.loadedPages; i++) {
        const page = await this.library.list(cursor ?? undefined);
        jobs.push(...page.jobs.filter(job => this.youtubeView ? job.type !== 'stems' : job.type === 'stems'));
        cursor = page.cursor;
        if (!cursor || this.destroyed) break;
      }
      if (!this.destroyed) {
        // Preserve playing elements and their URLs until renewal is necessary.
        const old = new Map(this.jobs().map(job => [job.jobId, job]));
        const renew = forceRenew || Date.now() - this.linksRefreshedAt > 45 * 60 * 1000;
        this.jobs.set([...new Map(jobs.map(job => [job.jobId, job])).values()].map(job => {
          const previous = old.get(job.jobId);
          return !renew && previous?.playUrl && job.status === 'completed'
            ? { ...job, playUrl: previous.playUrl, downloadUrl: previous.downloadUrl } : job;
        }));
        if (renew) this.linksRefreshedAt = Date.now();
        this.cursor.set(cursor);
        this.error.set('');
      }
    } catch (error) {
      if (!this.destroyed) this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
  private linksRefreshedAt = Date.now();

  async loadMore(): Promise<void> {
    const cursor = this.cursor();
    if (!cursor || this.busy()) return;
    this.busy.set(true);
    try {
      const page = await this.library.list(cursor);
      if (!this.destroyed) {
        const existing = new Set(this.jobs().map(job => job.jobId));
        this.jobs.update(jobs => [...jobs, ...page.jobs.filter(job =>
          !existing.has(job.jobId) && (this.youtubeView ? job.type !== 'stems' : job.type === 'stems'))]);
        this.cursor.set(page.cursor);
        this.loadedPages++;
        this.error.set('');
      }
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
  playbackError(): void {
    this.linksRefreshedAt = 0;
    this.error.set('Playback failed. Refresh to renew the link, then try again.');
  }
}
