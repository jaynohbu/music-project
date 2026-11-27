import { THEMES, ThemeService, type ThemeId } from './themes';
import { Component, effect, inject, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { CanActivateFn, Router, RouterLink, RouterLinkActive, RouterOutlet, provideRouter, withHashLocation } from '@angular/router';
import { ActivityService, AuthService, CONFIG, Config, errorMessage } from './services';
import { ListPage, LoginPage } from './pages';
import { MixerPage, SplitPage } from './stem-pages';
import { ForgotPasswordPage, RegisterPage } from './account-pages';
import { ConfirmationDialog } from './confirmation';
import { ScenePage, ScenesPage } from './scene-pages';
import { AdminPage } from './admin-page';

const authenticated: CanActivateFn = () =>
  inject(AuthService).signedIn() || inject(Router).createUrlTree(['/login']);
const anonymous: CanActivateFn = () =>
  !inject(AuthService).signedIn() || inject(Router).createUrlTree(['/list']);
const admin: CanActivateFn = () =>
  inject(AuthService).isAdmin() || inject(Router).createUrlTree(['/list']);

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ConfirmationDialog],
  template: `
    @if (auth.viewing()) {
      <div class="viewing-banner" role="status">
        <span>Viewing as <strong>{{ auth.viewing() }}</strong>. Changes here are made to their account.</span>
        <button (click)="exitViewing()">Exit</button>
      </div>
    }
    @if (!uploadScreen()) {
    <header>
      <a class="brand" routerLink="/list" aria-label="Sorituh home">
        <img src="/sorituh-mark.svg" width="40" height="40" alt="">
        <span>Sorituh<small>The foundation of sound</small></span>
      </a>
      @if (auth.signedIn()) {
        <nav aria-label="Main navigation">
          <a routerLink="/list" routerLinkActive="active">Music</a>
          <a routerLink="/scenes" routerLinkActive="active">Scenes</a>
          @if (auth.isAdmin()) { <a routerLink="/admin" routerLinkActive="active">Admin</a> }
          <label class="theme-picker"><span>Theme</span>
            <select [value]="themes.theme()" (change)="pickTheme($event)" aria-label="Theme">
              @for (item of themeList; track item.id) { <option [value]="item.id">{{ item.name }}</option> }
            </select>
          </label>
          @if (!auth.viewing()) { <button class="secondary" (click)="logout()" [disabled]="busy()">Log out</button> }
        </nav>
      }
    </header>
    }
    <main>
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      @if (auth.signedIn() && auth.notice()) { <p class="error" role="alert">{{ auth.notice() }}</p> }
      <router-outlet />
    </main>
    @if (!uploadScreen()) { <footer>Sorituh · The foundation of sound. Your music, privately stored. · <a href="/accompaniment/CREDITS.txt" target="_blank" rel="noopener">Sound credits</a></footer> }
    <app-confirmation />
  `,
})
class AppComponent {
  readonly auth = inject(AuthService);
  readonly themes = inject(ThemeService);
  readonly themeList = THEMES;
  pickTheme(event: Event): void { this.themes.apply((event.target as HTMLSelectElement).value as ThemeId); }
  private readonly router = inject(Router);
  readonly error = signal('');
  readonly busy = signal(false);
  readonly uploadScreen = signal(false);
  constructor() {
    inject(ActivityService).start();
    // A viewed account's hour ending returns the admin to the Admin page.
    let previouslyViewing = this.auth.viewing();
    effect(() => {
      const viewing = this.auth.viewing();
      if (previouslyViewing && !viewing && this.auth.isAdmin()) void this.router.navigateByUrl('/admin');
      previouslyViewing = viewing;
    });
    this.router.events.subscribe(() => this.uploadScreen.set(this.router.url.split('?')[0] === '/split'));
    let previouslySignedIn = this.auth.signedIn();
    effect(() => {
      const signedIn = this.auth.signedIn();
      if (previouslySignedIn && !signedIn) void this.router.navigateByUrl('/login');
      previouslySignedIn = signedIn;
    });
  }
  exitViewing(): void { this.auth.stopViewing(); }
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
        { path: 'split', component: SplitPage, canActivate: [authenticated], canDeactivate: [(page: SplitPage) => page.canLeave()] },
        { path: 'mixer/:jobId', component: MixerPage, canActivate: [authenticated] },
        // Loaded when first opened: it brings the spectrogram, score reading and alignment.
        { path: 'spectrum/:jobId', loadComponent: () => import('./spectrum-page').then(page => page.SpectrumPage), canActivate: [authenticated] },
        { path: 'list', component: ListPage, canActivate: [authenticated] },
        { path: 'scenes', component: ScenesPage, canActivate: [authenticated] },
        { path: 'admin', component: AdminPage, canActivate: [authenticated, admin] },
        { path: 'scenes/:sceneId', component: ScenePage, canActivate: [authenticated],
          canDeactivate: [(page: ScenePage) => page.canLeave()] },
        { path: '', redirectTo: 'list', pathMatch: 'full' },
        { path: '**', redirectTo: 'list' },
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
