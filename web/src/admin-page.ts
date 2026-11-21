import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { AdminService, AdminUser, errorMessage } from './services';
import { ConfirmationService } from './confirmation';

const minutes = (seconds: number) => seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
const size = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;

// The master admin's page: every user with their plan, songs, storage and time, and the actions on them.
@Component({
  standalone: true,
  template: `
    <section class="card admin-page">
      <div class="section-heading">
        <div><span class="eyebrow">MASTER ADMIN</span><h1>Users</h1></div>
        <div class="scene-actions">
          <input id="admin-search" type="search" placeholder="Search by email" [value]="query()" (input)="search($event)" aria-label="Search users by email">
          <button class="secondary" (click)="load()" [disabled]="busy()">Refresh</button>
        </div>
      </div>
      <p class="hint">Time is how long the app or site was open, and how long songs played; today is UTC.
        Opening an account shows the site as that user for up to an hour; every opening is logged.</p>
      @if (error()) { <p role="alert" class="error">{{ error() }}</p> }
      @if (busy() && !users().length) { <p role="status">Loading users...</p> }
      <div class="admin-table-wrap">
        <table class="admin-table">
          <thead><tr>
            <th scope="col">User</th><th scope="col">Status</th><th scope="col">Plan</th><th scope="col">Songs</th>
            <th scope="col">Storage</th><th scope="col">Splits this month</th><th scope="col">Today</th>
            <th scope="col">Last 7 days</th><th scope="col">Last active</th><th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr></thead>
          <tbody>
            @for (user of shown(); track user.id) {
              <tr [class.disabled]="!user.enabled">
                <th scope="row">{{ user.email }}<small>Joined {{ user.createdAt.slice(0, 10) }}</small></th>
                <td>{{ user.enabled ? 'Enabled' : 'Disabled' }}</td>
                <td>
                  <select [value]="user.plan" (change)="plan(user, $event)" [disabled]="working() === user.id" [attr.aria-label]="'Plan for ' + user.email">
                    <option value="free">Free</option><option value="premium">Premium</option>
                  </select>
                </td>
                <td>{{ user.songs }}/{{ user.songLimit }}</td>
                <td>{{ size(user.bytes) }}</td>
                <td>{{ user.splits }}/{{ user.splitLimit }}</td>
                <td>{{ minutes(user.today.open) }} open · {{ minutes(user.today.play) }} play</td>
                <td>{{ minutes(user.week.open) }} open · {{ minutes(user.week.play) }} play</td>
                <td>{{ user.lastActive ?? '—' }}</td>
                <td class="admin-actions">
                  <button class="secondary" (click)="toggle(user)" [disabled]="working() === user.id">{{ user.enabled ? 'Disable' : 'Enable' }}</button>
                  <button (click)="open(user)" [disabled]="working() === user.id || !user.enabled">Open as user</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    </section>
  `,
})
export class AdminPage implements OnInit {
  private readonly admin = inject(AdminService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmationService);
  readonly users = signal<AdminUser[]>([]);
  readonly query = signal('');
  readonly busy = signal(false);
  readonly working = signal<string | null>(null);
  readonly error = signal('');
  readonly minutes = minutes;
  readonly size = size;
  readonly shown = computed(() => {
    const query = this.query().trim().toLowerCase();
    return this.users().filter(user => !query || user.email.toLowerCase().includes(query));
  });

  ngOnInit(): void { void this.load(); }
  search(event: Event): void { this.query.set((event.target as HTMLInputElement).value); }

  async load(): Promise<void> {
    this.busy.set(true); this.error.set('');
    try { this.users.set((await this.admin.users()).sort((a, b) => a.email.localeCompare(b.email))); }
    catch (error) { this.error.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }

  private async act(user: AdminUser, action: () => Promise<void>, change: Partial<AdminUser>): Promise<void> {
    this.working.set(user.id); this.error.set('');
    try {
      await action();
      this.users.update(users => users.map(item => item.id === user.id ? { ...item, ...change } : item));
    } catch (error) { this.error.set(errorMessage(error)); }
    finally { this.working.set(null); }
  }

  async toggle(user: AdminUser): Promise<void> {
    if (user.enabled && !await this.confirm.confirm('Disable this user?',
      `${user.email} will be signed out on every device and cannot sign in until enabled again.`, 'Disable')) return;
    await this.act(user, () => this.admin.setEnabled(user.id, !user.enabled), { enabled: !user.enabled });
  }

  async plan(user: AdminUser, event: Event): Promise<void> {
    const plan = (event.target as HTMLSelectElement).value as AdminUser['plan'];
    await this.act(user, () => this.admin.setPlan(user.id, plan), { plan });
    void this.load();
  }

  async open(user: AdminUser): Promise<void> {
    if (!await this.confirm.confirm('Open as this user?',
      `You will see and act as ${user.email} for up to an hour. Their songs and scenes can be changed or deleted. This is logged.`, 'Open')) return;
    this.working.set(user.id); this.error.set('');
    try {
      await this.admin.open(user.id);
      await this.router.navigateByUrl('/list');
    } catch (error) { this.error.set(errorMessage(error)); }
    finally { this.working.set(null); }
  }
}
