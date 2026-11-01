import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { ChordEvent, Instrument, PlayingStyle } from './accompaniment-audio';
import type { Region } from './accompaniment-regions';

export interface Config {
  region: string;
  userPoolId: string;
  clientId: string;
  apiBaseUrl: string;
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
  }
}

export interface Job {
  jobId: string;
  createdAt: string;
  type?: 'youtube' | 'stems';
  sourceUrl?: string;
  status: 'uploading' | 'queued' | 'processing' | 'completed' | 'failed';
  title?: string;
  duration?: number;
  stems?: Partial<Record<StemName, StemFile>>;
  generatedStems?: GeneratedStem[];
  error?: string;
  errorCode?: string;
  failureStage?: string;
  playUrl?: string;
  downloadUrl?: string;
}

export const STEM_NAMES = ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other'] as const;
export type StemName = typeof STEM_NAMES[number];
export interface StemFile { playUrl: string; downloadUrl: string }
export interface AccompanimentSettings {
  requestId: string;
  instrument: Instrument;
  style: PlayingStyle;
  tempo: number;
  sources: StemName[];
  chords: ChordEvent[];
  regions: Region[];
  seed: number;
}
export interface GeneratedStem extends StemFile {
  id: string;
  title: string;
  instrument: Instrument;
  style: PlayingStyle;
  tempo: number;
  sources: StemName[];
  chords: ChordEvent[];
  regions?: Region[];
  createdAt: string;
}
export interface AccompanimentUpload {
  accompaniment: { id: string } | GeneratedStem;
  upload?: { url: string; fields: Record<string, string> };
}
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
    return firstValueFrom(this.http.post<{ job: Job }>(
      `${this.config.apiBaseUrl}/jobs`, { url },
      { headers: { Authorization: `Bearer ${token}` } },
    ));
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

  async createAccompaniment(jobId: string, settings: AccompanimentSettings): Promise<AccompanimentUpload> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.post<AccompanimentUpload>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/accompaniments`, settings,
      { headers: { Authorization: `Bearer ${token}` } },
    ));
  }

  async completeAccompaniment(jobId: string, id: string): Promise<{ accompaniment: GeneratedStem }> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.post<{ accompaniment: GeneratedStem }>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/accompaniments/${encodeURIComponent(id)}/complete`, {},
      { headers: { Authorization: `Bearer ${token}` } },
    ));
  }

  async deleteAccompaniment(jobId: string, id: string): Promise<void> {
    const token = await this.auth.token();
    await firstValueFrom(this.http.delete(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/accompaniments/${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    ));
  }
}
