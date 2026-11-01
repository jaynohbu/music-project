import { Component, Injectable, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CONFIG, errorMessage } from './services';

interface TemporarySession { token: string; expiresAt: number; expiresIn: number }
interface AccountReply { message: string }

@Injectable()
export class AccountSession implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly config = inject(CONFIG);
  private session?: TemporarySession;
  private timer?: ReturnType<typeof setTimeout>;
  private destroyed = false;
  readonly ready = signal(false);
  readonly error = signal('');
  readonly expiresAt = signal(0);

  async start(): Promise<void> {
    this.ready.set(false);
    this.error.set('');
    try {
      const session = await firstValueFrom(this.http.post<TemporarySession>(
        `${this.config.apiBaseUrl}/accounts/session`, {},
      ));
      if (!session.token || session.expiresIn !== 300 || !Number.isFinite(session.expiresAt)) {
        throw new Error('Invalid temporary session response.');
      }
      if (this.destroyed) return;
      this.session = session;
      this.expiresAt.set(session.expiresAt);
      // Use server-issued lifetime so browser clock skew does not extend the session.
      this.timer = setTimeout(() => this.restart(), session.expiresIn * 1000);
      this.ready.set(true);
    } catch (error) {
      if (!this.destroyed) this.error.set(errorMessage(error));
    }
  }

  async request(action: string, body: object): Promise<AccountReply> {
    if (!this.session || !this.ready()) throw new Error('Start a temporary session first.');
    try {
      return await firstValueFrom(this.http.post<AccountReply>(
        `${this.config.apiBaseUrl}/accounts/${action}`, body,
        { headers: { 'X-Account-Session': this.session.token } },
      ));
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401) this.restart();
      throw error;
    }
  }

  restart(): void {
    this.ready.set(false);
    window.location.reload();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.session = undefined;
    clearTimeout(this.timer);
  }
}

@Component({
  standalone: true,
  imports: [FormsModule, RouterLink],
  providers: [AccountSession],
  template: `
    <section class="card narrow">
      <h1>Register</h1>
      <p>Request an account. An administrator must enable it before you can sign in.</p>
      <p class="hint">Your email is marked verified by the administrator workflow,
        without a verification email. Use only your own email address.</p>
      <form (ngSubmit)="submit()">
        <label for="register-email">Email</label>
        <input id="register-email" type="email" name="email" autocomplete="email"
          [(ngModel)]="email" required maxlength="254" [disabled]="busy() || !session.ready()">
        @if (error() || session.error()) {
          <p class="error" role="alert">{{ error() || session.error() }}</p>
        }
        @if (success()) { <p class="success" role="status">{{ success() }}</p> }
        <button type="submit" [disabled]="busy() || !session.ready() || !email || !!success()">
          {{ busy() ? 'Registering...' : 'Request account' }}
        </button>
      </form>
      @if (session.error()) {
        <button class="secondary" (click)="session.restart()">Restart session</button>
      }
      <p class="hint">This session expires after five minutes. The page will reload
        and clear the form automatically. Do not submit again while registration is pending.</p>
      <a routerLink="/login">Back to sign in</a>
    </section>
  `,
})
export class RegisterPage implements OnInit {
  readonly session = inject(AccountSession);
  email = '';
  readonly busy = signal(false);
  readonly error = signal('');
  readonly success = signal('');
  ngOnInit(): void { void this.session.start(); }
  async submit(): Promise<void> {
    if (this.busy() || this.success()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await this.session.request('register', { email: this.email });
      this.success.set(result.message);
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
  providers: [AccountSession],
  template: `
    <section class="card narrow">
      <h1>Reset password</h1>
      <p>{{ sent() ? 'Enter the code from your email and choose a new password.' : 'Enter your email to receive a reset code.' }}</p>
      <form (ngSubmit)="submit()">
        <label for="reset-email">Email</label>
        <input id="reset-email" type="email" name="email" autocomplete="email"
          [(ngModel)]="email" required [disabled]="sent() || busy() || !session.ready()">
        @if (sent() && !done()) {
          <label for="reset-code">Six-digit reset code</label>
          <input id="reset-code" name="code" inputmode="numeric" autocomplete="one-time-code"
            pattern="[0-9]{6}" maxlength="6" [(ngModel)]="code" required [disabled]="busy()">
          <label for="reset-password">New password</label>
          <input id="reset-password" name="password" type="password" autocomplete="new-password"
            minlength="12" maxlength="256" [(ngModel)]="password" required [disabled]="busy()">
          <label for="reset-confirm">Confirm password</label>
          <input id="reset-confirm" name="confirmation" type="password" autocomplete="new-password"
            [(ngModel)]="confirmation" required [disabled]="busy()">
          <p class="hint">At least 12 characters with uppercase, lowercase, a number and a symbol.</p>
        }
        @if (error() || session.error()) {
          <p class="error" role="alert">{{ error() || session.error() }}</p>
        }
        @if (message()) { <p class="success" role="status">{{ message() }}</p> }
        @if (!done()) {
          <button type="submit" [disabled]="busy() || !session.ready() || !email">
            {{ busy() ? 'Please wait...' : sent() ? 'Save new password' : 'Send reset code' }}
          </button>
        }
      </form>
      @if (sent() && !done()) {
        <button class="secondary" (click)="resend()" [disabled]="busy() || !session.ready()">Resend code</button>
      }
      @if (session.error()) {
        <button class="secondary" (click)="session.restart()">Restart session</button>
      }
      <p class="hint">This session expires after five minutes and the page reloads.
        Password reset does not enable a disabled account.</p>
      <a routerLink="/login">Back to sign in</a>
    </section>
  `,
})
export class ForgotPasswordPage implements OnInit {
  readonly session = inject(AccountSession);
  email = '';
  code = '';
  password = '';
  confirmation = '';
  readonly sent = signal(false);
  readonly done = signal(false);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly message = signal('');
  ngOnInit(): void { void this.session.start(); }

  async submit(): Promise<void> {
    if (this.busy() || this.done()) return;
    if (this.sent() && this.password !== this.confirmation) {
      this.error.set('Passwords do not match.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const result = this.sent()
        ? await this.session.request('confirm-password', {
          email: this.email, code: this.code, password: this.password,
        })
        : await this.session.request('forgot-password', { email: this.email });
      this.message.set(result.message);
      if (this.sent()) {
        this.done.set(true);
        this.code = this.password = this.confirmation = '';
      } else this.sent.set(true);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  async resend(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.message.set('');
    try {
      const result = await this.session.request('forgot-password', { email: this.email });
      this.message.set(result.message);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
