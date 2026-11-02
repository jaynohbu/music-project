import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { EffectSettings } from './stem-effects';

export interface Config {
  region: string;
  userPoolId: string;
  clientId: string;
  apiBaseUrl: string;
  youtubeOwnerSubject?: string;
}
export const CONFIG = new InjectionToken<Config>('runtime configuration');

interface Tokens {
  IdToken: string;
  AccessToken: string;
  RefreshToken?: string;
  ExpiresIn: number;
}
interface AuthResult {
  AuthenticationResult?: Tokens;
  ChallengeName?: string;
  Session?: string;
  ChallengeParameters?: Record<string, string>;
}
interface Session {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const body: unknown = error.error;
    if (typeof body === 'object' && body !== null && 'message' in body &&
        typeof body.message === 'string') return body.message;
    if (error.status === 0) return 'Unable to reach the service. Check your connection.';
    if (error.status === 401) return 'Your session expired. Sign in again.';
    if (error.status === 429) return 'Too many requests. Please wait and try again.';
  }
  return error instanceof Error ? error.message : 'Request failed. Please try again.';
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(CONFIG);
  readonly signedIn = signal(false);
  readonly youtubeAllowed = signal(false);
  readonly notice = signal('');
  private session: Session | null = null;
  private refreshing?: Promise<string>;
  private challenge?: { session: string; username: string };

  constructor() {
    const stored = sessionStorage.getItem('youtube-session');
    if (stored) {
      try {
        const value: unknown = JSON.parse(stored);
        if (typeof value !== 'object' || value === null ||
            !('idToken' in value) || typeof value.idToken !== 'string' ||
            !('accessToken' in value) || typeof value.accessToken !== 'string' ||
            !('refreshToken' in value) || typeof value.refreshToken !== 'string' ||
            !('expiresAt' in value) || typeof value.expiresAt !== 'number') {
          throw new Error('Invalid saved session');
        }
        this.session = {
          idToken: value.idToken, accessToken: value.accessToken,
          refreshToken: value.refreshToken, expiresAt: value.expiresAt,
        };
        this.signedIn.set(true);
        this.updateYoutubeAccess(value.idToken);
      } catch (error) {
        console.warn('Discarding invalid saved session', error);
        sessionStorage.removeItem('youtube-session');
      }
    }
  }

  private request<T>(action: string, body: object): Promise<T> {
    return firstValueFrom(this.http.post<T>(
      `https://cognito-idp.${this.config.region}.amazonaws.com/`, body,
      { headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
      } },
    ));
  }

  private updateYoutubeAccess(token: string): void {
    try {
      const payload: unknown = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      this.youtubeAllowed.set(!!this.config.youtubeOwnerSubject && this.config.youtubeOwnerSubject !== 'disabled' &&
        typeof payload === 'object' && payload !== null && 'sub' in payload &&
        payload.sub === this.config.youtubeOwnerSubject);
    } catch (error) {
      console.warn('Unable to read account display permissions', error);
      this.youtubeAllowed.set(false);
    }
  }

  async login(username: string, password: string): Promise<boolean> {
    const result = await this.request<AuthResult>('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH', ClientId: this.config.clientId,
      AuthParameters: { USERNAME: username.trim(), PASSWORD: password },
    });
    if (result.ChallengeName === 'NEW_PASSWORD_REQUIRED' && result.Session) {
      const required: unknown = JSON.parse(result.ChallengeParameters?.['requiredAttributes'] ?? '[]');
      if (Array.isArray(required) && required.length) {
        throw new Error('Your account requires additional attributes. Ask your administrator to complete your account.');
      }
      this.challenge = { session: result.Session, username: username.trim() };
      return false;
    }
    this.accept(result);
    return true;
  }

  async setPassword(password: string): Promise<void> {
    if (!this.challenge) throw new Error('Sign in again before setting your password.');
    const result = await this.request<AuthResult>('RespondToAuthChallenge', {
      ClientId: this.config.clientId, ChallengeName: 'NEW_PASSWORD_REQUIRED',
      Session: this.challenge.session,
      ChallengeResponses: { USERNAME: this.challenge.username, NEW_PASSWORD: password },
    });
    this.accept(result);
    this.challenge = undefined;
  }

  private accept(result: AuthResult): void {
    const tokens = result.AuthenticationResult;
    if (!tokens?.IdToken || !tokens.AccessToken) {
      throw new Error(`Sign-in requires ${result.ChallengeName ?? 'an unsupported response'}. Contact your administrator.`);
    }
    const refreshToken = tokens.RefreshToken ?? this.session?.refreshToken;
    if (!refreshToken) throw new Error('Sign-in did not return a refresh token.');
    this.session = {
      idToken: tokens.IdToken, accessToken: tokens.AccessToken, refreshToken,
      expiresAt: Date.now() + tokens.ExpiresIn * 1000,
    };
    sessionStorage.setItem('youtube-session', JSON.stringify(this.session));
    this.notice.set('');
    this.signedIn.set(true);
    this.updateYoutubeAccess(tokens.IdToken);
  }

  async token(): Promise<string> {
    if (!this.session) throw new Error('Sign in to continue.');
    if (this.session.expiresAt > Date.now() + 60000) return this.session.idToken;
    if (!this.refreshing) {
      this.refreshing = this.refresh().finally(() => { this.refreshing = undefined; });
    }
    return this.refreshing;
  }

  private async refresh(): Promise<string> {
    try {
      const result = await this.request<AuthResult>('InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: this.config.clientId,
        AuthParameters: { REFRESH_TOKEN: this.session!.refreshToken },
      });
      this.accept(result);
      return this.session!.idToken;
    } catch (error) {
      console.error('Session refresh failed', error);
      this.clear();
      this.notice.set('Your session expired. Sign in again.');
      throw new Error('Your session expired. Sign in again.');
    }
  }

  async logout(): Promise<void> {
    try {
      if (this.session) {
        await this.token();
        await this.request('GlobalSignOut', { AccessToken: this.session!.accessToken });
      }
    } finally {
      this.clear();
    }
  }

  private clear(): void {
    this.session = null;
    this.challenge = undefined;
    sessionStorage.removeItem('youtube-session');
    this.notice.set('');
    this.signedIn.set(false);
    this.youtubeAllowed.set(false);
  }
}

export interface Job {
  jobId: string;
  createdAt: string;
  type?: 'youtube' | 'stems';
  sourceUrl?: string;
  status: 'uploading' | 'queued' | 'processing' | 'completed' | 'failed' | 'deleting';
  title?: string;
  author?: string;
  duration?: number;
  stems?: Partial<Record<StemName, StemFile>>;
  restorations?: Restoration[];
  lyrics?: Lyrics;
  harmony?: Harmony;
  error?: string;
  errorCode?: string;
  failureStage?: string;
  playUrl?: string;
  downloadUrl?: string;
}

export interface SceneTrackSettings extends EffectSettings {
  muted: boolean;
  solo: boolean;
  bypassed: boolean;
  useCleaned: boolean;
}
export interface SceneSettings {
  masterVolume: number;
  sectionStart: number;
  sectionEnd: number;
  loop: boolean;
  tracks: Record<string, SceneTrackSettings>;
}
export interface SceneEntry {
  id: string;
  jobId: string;
  title?: string;
  settings?: SceneSettings;
}
export interface Scene {
  id: string;
  name: string;
  entries: SceneEntry[];
  revision: number;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class ScenesService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly config = inject(CONFIG);
  private async headers(): Promise<{ Authorization: string }> {
    return { Authorization: `Bearer ${await this.auth.token()}` };
  }
  async list(): Promise<{ scenes: Scene[] }> {
    return firstValueFrom(this.http.get<{ scenes: Scene[] }>(`${this.config.apiBaseUrl}/scenes`, { headers: await this.headers() }));
  }
  async get(id: string): Promise<{ scene: Scene }> {
    return firstValueFrom(this.http.get<{ scene: Scene }>(`${this.config.apiBaseUrl}/scenes/${encodeURIComponent(id)}`, { headers: await this.headers() }));
  }
  async create(name: string): Promise<{ scene: Scene }> {
    return firstValueFrom(this.http.post<{ scene: Scene }>(`${this.config.apiBaseUrl}/scenes`, { name }, { headers: await this.headers() }));
  }
  async update(id: string, revision: number, patch: { name?: string; entries?: SceneEntry[] }): Promise<{ scene: Scene }> {
    return firstValueFrom(this.http.patch<{ scene: Scene }>(`${this.config.apiBaseUrl}/scenes/${encodeURIComponent(id)}`,
      { ...patch, revision }, { headers: await this.headers() }));
  }
  async remove(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`${this.config.apiBaseUrl}/scenes/${encodeURIComponent(id)}`, { headers: await this.headers() }));
  }
}

export const STEM_NAMES = ['vocals', 'guitar', 'bass', 'piano', 'drums', 'other'] as const;
export type StemName = typeof STEM_NAMES[number];
export interface StemFile { playUrl: string; downloadUrl: string }
export interface Restoration extends Partial<StemFile> {
  id: string;
  title: string;
  stem: StemName;
  references: StemName[];
  strength: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  error?: string;
  createdAt: string;
}
export interface Lyrics {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  url?: string;
  error?: string;
}
export interface RegeneratedPart extends Lyrics { resultId?: string }
export interface Harmony extends Lyrics { stems?: Record<string, RegeneratedPart | undefined> }
export interface LyricWord { start: number; end: number; text: string }
export interface LyricLine { start: number; end: number; words: LyricWord[] }
export type DrumName = 'kick' | 'snare' | 'tom' | 'hihat' | 'cymbal';
export interface DrumHit { unit: number; drum: DrumName }
export interface BarPattern { unit: number; label: string }
export interface HarmonyPart {
  chords: { start: number; name: string }[];
  notes: HarmonyNote[];
  hits?: DrumHit[];
  patterns?: BarPattern[];
}
export interface HarmonyNote { start: number; end: number; pitch: number; unit: number; length: number }
export interface HarmonyGrid { beats: number[]; firstBar: number }
export const HARMONY_STEMS: readonly string[] = ['guitar', 'piano', 'other', 'bass', 'drums'];
export interface StemUploadRequest {
  job: Job;
  upload: { url: string; fields: Record<string, string> };
}
export interface JobPage { jobs: Job[]; cursor: string | null }

@Injectable({ providedIn: 'root' })
export class LibraryService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly config = inject(CONFIG);

  async create(url: string): Promise<{ job: Job }> {
    const token = await this.auth.token();
    try {
      return await firstValueFrom(this.http.post<{ job: Job }>(
      'http://127.0.0.1:3001/api/jobs', { url },
      { headers: { Authorization: `Bearer ${token}` } },
    ));
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 0) {
        throw new Error('Cannot reach the local conversion service at http://127.0.0.1:3001. Start the local service on this computer and allow local-network access in your browser.');
      }
      throw error;
    }
  }

  async list(cursor?: string): Promise<JobPage> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.get<JobPage>(
      `${this.config.apiBaseUrl}/jobs`,
      { headers: { Authorization: `Bearer ${token}` }, params: cursor ? { cursor } : {} },
    ));
  }
}

@Injectable({ providedIn: 'root' })
export class StemsService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly config = inject(CONFIG);

  async remove(jobId: string): Promise<void> {
    const token = await this.auth.token();
    try {
      await firstValueFrom(this.http.delete(`${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}`,
      { headers: { Authorization: `Bearer ${token}` } }));
    } catch (error) {
      if (!(error instanceof HttpErrorResponse) || error.status !== 404) throw error;
    }
  }

  async updateMetadata(jobId: string, title: string, author: string): Promise<{ metadata: { title: string; author: string } }> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.patch<{ metadata: { title: string; author: string } }>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}`,
      { title, author }, { headers: { Authorization: `Bearer ${token}` } },
    ));
  }

  async createUpload(fileName: string, bytes: number, title: string): Promise<StemUploadRequest> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.post<StemUploadRequest>(
      `${this.config.apiBaseUrl}/stems/uploads`,
      { fileName, bytes, title },
      { headers: { Authorization: `Bearer ${token}` } },
    ));
  }

  async complete(jobId: string): Promise<{ job: Job }> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.post<{ job: Job }>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/complete`,
      {},
      { headers: { Authorization: `Bearer ${token}` } },
    ));
  }

  async getJob(jobId: string): Promise<{ job: Job }> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.get<{ job: Job }>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ));
  }

  async createRestoration(jobId: string, stem: StemName): Promise<{ restoration: Restoration }> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.post<{ restoration: Restoration }>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/restorations`,
      { stem, references: STEM_NAMES.filter(name => name !== stem) },
      { headers: { Authorization: `Bearer ${token}` } },
    ));
  }

  // With a part, redoes only that stem, from its cleaned version if asked.
  async createHarmony(jobId: string, part?: { stem: string; cleaned: boolean }): Promise<{ harmony: Lyrics }> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.post<{ harmony: Lyrics }>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/harmony`,
      part ?? {},
      { headers: { Authorization: `Bearer ${token}` } },
    ));
  }

  async saveLyrics(jobId: string, lines: LyricLine[]): Promise<{ lyrics: Lyrics }> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.post<{ lyrics: Lyrics }>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/lyrics`,
      { lines },
      { headers: { Authorization: `Bearer ${token}` } },
    ));
  }

  async createLyrics(jobId: string): Promise<{ lyrics: Lyrics }> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.post<{ lyrics: Lyrics }>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/lyrics`,
      {},
      { headers: { Authorization: `Bearer ${token}` } },
    ));
  }
}
