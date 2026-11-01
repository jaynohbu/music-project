import { Component, effect, inject, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { CanActivateFn, Router, RouterLink, RouterLinkActive, RouterOutlet, provideRouter, withHashLocation } from '@angular/router';
import { AuthService, CONFIG, Config, errorMessage } from './services';
import { ListPage, LoginPage, UploadPage } from './pages';
import { ForgotPasswordPage, RegisterPage } from './account-pages';

const authenticated: CanActivateFn = () =>
  inject(AuthService).signedIn() || inject(Router).createUrlTree(['/login']);
const anonymous: CanActivateFn = () =>
  !inject(AuthService).signedIn() || inject(Router).createUrlTree(['/upload']);

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <header>
      <a class="brand" routerLink="/upload">Audio Library</a>
      @if (auth.signedIn()) {
        <nav aria-label="Main navigation">
          <a routerLink="/upload" routerLinkActive="active">Upload</a>
          <a routerLink="/list" routerLinkActive="active">List</a>
          <button class="secondary" (click)="logout()" [disabled]="busy()">Log out</button>
        </nav>
      }
    </header>
    <main>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      <router-outlet />
    </main>
    <footer>Private storage. On-demand conversion. No GPU required.</footer>
  `,
})
class AppComponent {
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  readonly error = signal('');
  readonly busy = signal(false);
  constructor() {
    let previouslySignedIn = this.auth.signedIn();
    effect(() => {
      const signedIn = this.auth.signedIn();
      if (previouslySignedIn && !signedIn) void this.router.navigateByUrl('/login');
      previouslySignedIn = signedIn;
    });
  }
  async logout(): Promise<void> {
    this.busy.set(true);
    let message = '';
    try {
      await this.auth.logout();
    } catch (error) {
      message = `Signed out locally, but server sign-out failed: ${errorMessage(error)}`;
    } finally {
      await this.router.navigateByUrl('/login');
      this.error.set(message);
      this.busy.set(false);
    }
  }
}

async function start(): Promise<void> {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to load site configuration.');
  const value: unknown = await response.json();
  if (typeof value !== 'object' || value === null ||
      !('region' in value) || value.region !== 'us-west-2' ||
      !('userPoolId' in value) || typeof value.userPoolId !== 'string' ||
      !value.userPoolId.startsWith('us-west-2_') ||
      !('clientId' in value) || typeof value.clientId !== 'string' || !value.clientId ||
      !('apiBaseUrl' in value) || typeof value.apiBaseUrl !== 'string') {
    throw new Error('Invalid site configuration. Deploy the generated config.json first.');
  }
  const config: Config = {
    region: value.region, userPoolId: value.userPoolId,
    clientId: value.clientId, apiBaseUrl: value.apiBaseUrl.replace(/\/$/, ''),
  };
  await bootstrapApplication(AppComponent, {
    providers: [
      provideHttpClient(), { provide: CONFIG, useValue: config },
      provideRouter([
        { path: 'login', component: LoginPage, canActivate: [anonymous] },
        { path: 'register', component: RegisterPage, canActivate: [anonymous] },
        { path: 'forgot-password', component: ForgotPasswordPage, canActivate: [anonymous] },
        { path: 'upload', component: UploadPage, canActivate: [authenticated] },
        { path: 'list', component: ListPage, canActivate: [authenticated] },
        { path: '', redirectTo: 'upload', pathMatch: 'full' },
        { path: '**', redirectTo: 'upload' },
      ], withHashLocation()),
    ],
  });
}
void start().catch(error => {
  console.error('Application startup failed', error);
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.textContent = errorMessage(error);
  document.body.replaceChildren(message);
});
