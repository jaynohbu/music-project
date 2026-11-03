import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
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
  imports: [DatePipe, RouterLink],
  template: `
    <section class="card">
      <div class="section-heading">
        <div><span class="eyebrow">YOUR SPLIT SONGS</span><h1>Music</h1></div>
        <div class="scene-actions"><a class="button-link" routerLink="/split">Upload &amp; split</a>
          <button class="secondary" (click)="refresh()" [disabled]="busy()">Refresh</button></div>
      </div>
      <p class="hint">Jobs refresh every 5 seconds while this page is open.
        Failed jobs disappear 10 minutes after failure.</p>
      @if (error()) { <p role="alert" class="error">{{ error() }}</p> }
      @if (busy() && !jobs().length) { <p role="status">Loading your library...</p> }
      @if (!busy() && !jobs().length && !error()) {
        <div class="empty"><h2>No files yet</h2><p>Your music will appear here.</p>
          <a routerLink="/split">Upload audio to split</a></div>
      }
      <ul class="library">
        @for (job of jobs(); track job.jobId) {
          <li>
            <div class="file-heading">
              <h2>{{ job.title || 'Untitled song' }}</h2>
              <span class="badge" [class.failed]="job.status === 'failed'">{{ job.status }}</span>
            </div>
            <p class="hint">{{ job.createdAt | date:'medium' }}</p>
            @if (job.author) { <p class="hint">By {{ job.author }}</p> }
            <p class="hint">Six-stem audio separation</p>
            @if (job.status === 'completed') {
              <a class="download" [routerLink]="['/mixer', job.jobId]">Open stem mixer</a>
              <a class="download" routerLink="/scenes" [queryParams]="{song: job.jobId}">Add to scene</a>
            }
            @if (job.status === 'completed' || job.status === 'failed' || job.status === 'deleting') {
              <button type="button" class="secondary" (click)="deleteSong(job)" [disabled]="busy()">Delete song</button>
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
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, 5000);
  }
  ngOnDestroy(): void {
    this.destroyed = true;
    clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const jobs: Job[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < this.loadedPages; i++) {
        const page = await this.library.list(cursor ?? undefined);
        jobs.push(...page.jobs);
        cursor = page.cursor;
        if (!cursor || this.destroyed) break;
      }
      if (!this.destroyed) {
        this.jobs.set([...new Map(jobs.map(job => [job.jobId, job])).values()]);
        this.cursor.set(cursor);
        this.error.set('');
      }
    } catch (error) {
      if (!this.destroyed) this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  async loadMore(): Promise<void> {
    const cursor = this.cursor();
    if (!cursor || this.busy()) return;
    this.busy.set(true);
    try {
      const page = await this.library.list(cursor);
      if (!this.destroyed) {
        const existing = new Set(this.jobs().map(job => job.jobId));
        this.jobs.update(jobs => [...jobs, ...page.jobs.filter(job => !existing.has(job.jobId))]);
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
}
