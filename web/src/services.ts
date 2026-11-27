import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { EffectSettings } from './stem-effects';

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

const VIEWING_KEY = 'sorituh-viewing';
const ADMIN_SESSION_KEY = 'sorituh-admin-session';

// The groups in an ID token, read without checking it: the API checks every request itself.
function tokenGroups(idToken: string): string[] {
  try {
    const payload = JSON.parse(atob(idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Array.isArray(payload['cognito:groups']) ? payload['cognito:groups'] : [];
  } catch { return []; }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(CONFIG);
  readonly signedIn = signal(false);
  readonly notice = signal('');
  // An admin (Cognito group `admins`) sees the Admin page; `viewing` is the user whose account an admin has opened.
  readonly isAdmin = signal(false);
  readonly viewing = signal<string | null>(null);
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
        this.viewing.set(sessionStorage.getItem(VIEWING_KEY));
        this.isAdmin.set(!this.viewing() && tokenGroups(value.idToken).includes('admins'));
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
    this.isAdmin.set(tokenGroups(tokens.IdToken).includes('admins'));
    this.notice.set('');
    this.signedIn.set(true);
  }

  // Opens the site as a user for an admin. Their tokens last an hour and cannot be refreshed; the admin's own
  // session waits in this tab and comes back on Exit.
  startViewing(session: { idToken: string; accessToken: string; expiresIn: number }, email: string): void {
    if (!this.session || this.viewing()) return;
    sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(this.session));
    this.session = { idToken: session.idToken, accessToken: session.accessToken, refreshToken: '', expiresAt: Date.now() + session.expiresIn * 1000 };
    sessionStorage.setItem('youtube-session', JSON.stringify(this.session));
    sessionStorage.setItem(VIEWING_KEY, email);
    this.viewing.set(email);
    this.isAdmin.set(false);
  }

  stopViewing(notice = ''): void {
    const saved = sessionStorage.getItem(ADMIN_SESSION_KEY);
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    sessionStorage.removeItem(VIEWING_KEY);
    this.viewing.set(null);
    if (!saved) { this.clear(); return; }
    this.session = JSON.parse(saved) as Session;
    sessionStorage.setItem('youtube-session', saved);
    this.isAdmin.set(tokenGroups(this.session.idToken).includes('admins'));
    this.notice.set(notice);
  }

  async token(): Promise<string> {
    if (!this.session) throw new Error('Sign in to continue.');
    if (this.session.expiresAt > Date.now() + 60000) return this.session.idToken;
    // A viewed account's hour is up: return to the admin rather than refreshing someone else's session.
    if (this.viewing()) {
      this.stopViewing(`Your hour viewing ${this.viewing()} ended.`);
      throw new Error('The time to view this account ended.');
    }
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
    // Never sign the viewed user out of their own devices; logging out here only leaves their account.
    if (this.viewing()) { this.stopViewing(); return; }
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
    this.isAdmin.set(false);
    this.viewing.set(null);
    sessionStorage.removeItem(VIEWING_KEY);
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    this.challenge = undefined;
    sessionStorage.removeItem('youtube-session');
    this.notice.set('');
    this.signedIn.set(false);
  }
}

export interface Job {
  jobId: string;
  createdAt: string;
  type?: 'stems';
  status: 'uploading' | 'queued' | 'processing' | 'completed' | 'failed' | 'deleting';
  title?: string;
  author?: string;
  duration?: number;
  stems?: Partial<Record<StemName, StemFile>>;
  // The song's own score (an uploaded score's MusicXML) and the sound its notes were extracted as, when it has them.
  score?: { title: string; savedAt: string; url: string; extractedAt?: string; extractedUrl?: string };
  // Every score the song has, by part: the Harmonic one (also `score`), the bass and the drums.
  scores?: Partial<Record<ScorePartName, { title: string; savedAt: string; url: string }>>;
  restorations?: Restoration[];
  lyrics?: Lyrics;
  harmony?: Harmony;
  error?: string;
  errorCode?: string;
  failureStage?: string;
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
  // The app's live-input mix for this entry. The website has no live input and passes it through unchanged.
  live?: Record<string, number | boolean>;
  // The key change in semitones.
  transpose?: number;
  // Parts played live from the Harmonic score, with their style, sound and mix.
  accompaniment?: SceneAccompaniment[];
}
export interface SceneAccompaniment {
  kind: 'guitar-rhythm' | 'keys-rhythm' | 'guitar-melody' | 'keys-melody' | 'guitar-notes' | 'keys-notes' | 'bass-notes' | 'drums-notes';
  style: string; sound: number; volume: number; muted: boolean;
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

// Four stems (Demucs htdemucs); guitars, keys and the rest are in other. Six before 2026-11-21.
export const STEM_NAMES = ['vocals', 'bass', 'drums', 'other'] as const;
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
// `stale`: from an older analysis version, shown until a new run finishes. `previous`: the last finished result,
// shown while this one runs.
// fromScore: the Harmonic score comes from an uploaded score aligned with the stems, not from the analysis.
export type ScorePartName = 'other' | 'bass' | 'drums';
export interface ScoreLaid { title: string; measures: number; notes: number; heard?: number; correctedBars: number; family?: 'guitar' | 'keys'; scoreSavedAt?: string }
export interface Harmony extends Lyrics {
  stems?: Record<string, RegeneratedPart | undefined>; stale?: boolean; previous?: Lyrics;
  // parts: each score laid (results from before the bass and drum scores have the Harmonic one only, at the top).
  fromScore?: ScoreLaid & { parts?: Partial<Record<ScorePartName, ScoreLaid>> };
  // Set while (and after) the song's score is laid on it by the server.
  scoring?: boolean;
}
export interface LyricWord { start: number; end: number; text: string }
export interface LyricLine { start: number; end: number; words: LyricWord[] }
export type DrumName = 'kick' | 'snare' | 'tom' | 'hihat' | 'cymbal';
export interface DrumHit { unit: number; drum: DrumName }
export interface HarmonyPart {
  chords: { start: number; name: string }[];
  notes: HarmonyNote[];
  hits?: DrumHit[];
  // Set on the ensemble part: the other stem (guitars, keys and the rest) heard as one.
  key?: string;
  // The ensemble's line under the melody (a counter-melody or the top of the accompaniment).
  second?: HarmonyNote[];
  // Set on the ensemble part: its repeated passages (bar numbers from the first bar) and what their vote changed.
  // shifts: how many semitones each playing is moved from the first (a riff played on the fourth).
  repeats?: { family: number; bars: number; members: number[]; shifts?: number[] }[];
  corrections?: { added: number; removed: { unit: number; pitch: number; length: number }[] };
  // Set on a part made from an uploaded score: its sung line (the part given to the vocals), at its written places.
  melody?: HarmonyNote[];
}
// start and end: as played, in song seconds (unit and length: as written on the grid); confidence: how surely the
// note was heard, 0 to 1; velocity: how loud it was played, 1 to 127; voted: added by the vote among repeated passages.
export interface HarmonyNote {
  start: number; end: number; pitch: number; unit: number; length: number; confidence?: number; velocity?: number; voted?: boolean;
}
export interface HarmonyGrid { beats: number[]; firstBar: number }
export const HARMONY_STEMS: readonly string[] = ['other', 'bass', 'drums'];
export const ENSEMBLE_STEMS: readonly string[] = ['other'];
// The ensemble is found with the whole song; only bass and drums can be redone on their own.
export const REGENERATED_STEMS: readonly string[] = ['other', 'bass', 'drums'];
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

  async list(cursor?: string): Promise<JobPage> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.get<JobPage>(
      `${this.config.apiBaseUrl}/jobs`,
      { headers: { Authorization: `Bearer ${token}` }, params: cursor ? { cursor } : {} },
    ));
  }
}

export interface Usage {
  plan: 'free' | 'premium'; month: string;
  splits: { used: number; limit: number }; songs: { used: number; limit: number };
}

@Injectable({ providedIn: 'root' })
export class StemsService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly config = inject(CONFIG);

  // Splits used this month and songs stored, against the plan's limits; the app shows the same.
  async usage(): Promise<Usage> {
    const token = await this.auth.token();
    return (await firstValueFrom(this.http.get<{ usage: Usage }>(`${this.config.apiBaseUrl}/stems/usage`,
      { headers: { Authorization: `Bearer ${token}` } }))).usage;
  }

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

  // A score PDF (or image) read into MusicXML by the ScoreReader (backend/score-api.mjs): uploaded, read (only the
  // pages asked for, or all), and waited for; returns the compressed MusicXML and how many scores it was read as.
  async readScore(file: File, pages: string, progress: (message: string) => void): Promise<{ mxl: Uint8Array; scores: number }> {
    const headers = async () => ({ Authorization: `Bearer ${await this.auth.token()}` });
    const { id, upload } = await firstValueFrom(this.http.post<{ id: string; upload: { url: string; fields: Record<string, string> } }>(
      `${this.config.apiBaseUrl}/scores`, { bytes: file.size }, { headers: await headers() }));
    progress('Uploading the score…');
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
    form.append('file', file, file.name);
    const sent = await fetch(upload.url, { method: 'POST', body: form });
    if (!sent.ok) throw new Error(`The upload failed (HTTP ${sent.status}).`);
    await firstValueFrom(this.http.post(`${this.config.apiBaseUrl}/scores/${id}/read`, { pages }, { headers: await headers() }));
    const started = Date.now();
    // Audiveris takes ten seconds or more a page, and a while to start.
    for (;;) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const status = await firstValueFrom(this.http.get<{ status: string; message?: string; scores?: number; url?: string }>(
        `${this.config.apiBaseUrl}/scores/${id}`, { headers: await headers() }));
      if (status.status === 'failed') throw new Error(status.message ?? 'The score could not be read.');
      if (status.status === 'completed' && status.url) {
        const response = await fetch(status.url);
        if (!response.ok) throw new Error(`The read score could not be fetched (HTTP ${response.status}).`);
        return { mxl: new Uint8Array(await response.arrayBuffer()), scores: status.scores ?? 1 };
      }
      const seconds = Math.round((Date.now() - started) / 1000);
      if (seconds > 16 * 60) throw new Error('Reading the score took too long.');
      progress(`Reading the score… ${seconds} s (about ten seconds a page)`);
    }
  }

  // The song's own score: its MusicXML saved with it, removed, and the extracted sound uploaded (backend/song-score.mjs).
  async saveSongScore(jobId: string, title: string, musicxml: string, part: ScorePartName = 'other'): Promise<{ score: NonNullable<Job['score']> }> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.post<{ score: NonNullable<Job['score']> }>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/score${part === 'other' ? '' : `/${part}`}`, { title, musicxml },
      { headers: { Authorization: `Bearer ${token}` } }));
  }

  async removeSongScore(jobId: string): Promise<void> {
    const token = await this.auth.token();
    await firstValueFrom(this.http.delete(`${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/score`,
      { headers: { Authorization: `Bearer ${token}` } }));
  }

  async uploadExtracted(jobId: string, wav: Blob): Promise<void> {
    const token = await this.auth.token();
    const { upload } = await firstValueFrom(this.http.post<{ upload: { url: string; fields: Record<string, string> } }>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/score/extracted`, { bytes: wav.size },
      { headers: { Authorization: `Bearer ${token}` } }));
    const form = new FormData();
    for (const [key, value] of Object.entries(upload.fields)) form.append(key, value);
    form.append('file', wav, 'extracted.wav');
    const sent = await fetch(upload.url, { method: 'POST', body: form });
    if (!sent.ok) throw new Error(`The extracted sound could not be uploaded (HTTP ${sent.status}).`);
  }

  // The song's harmony result made from an uploaded score (score-align.ts harmonyFromScore), or back to the analysis.
  async saveScoreHarmony(jobId: string, document: object): Promise<{ harmony: Harmony }> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.post<{ harmony: Harmony }>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/harmony`, { fromScore: document },
      { headers: { Authorization: `Bearer ${token}` } }));
  }

  // The song's chords & notes from its own score, laid on it by the server (when it has its analysis).
  async useSongScore(jobId: string): Promise<{ harmony: Harmony }> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.post<{ harmony: Harmony }>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/harmony`, { useScore: true },
      { headers: { Authorization: `Bearer ${token}` } }));
  }

  async useAnalysedHarmony(jobId: string): Promise<{ harmony: Harmony }> {
    const token = await this.auth.token();
    return firstValueFrom(this.http.post<{ harmony: Harmony }>(
      `${this.config.apiBaseUrl}/stems/jobs/${encodeURIComponent(jobId)}/harmony`, { useAnalysis: true },
      { headers: { Authorization: `Bearer ${token}` } }));
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

export interface AdminUser {
  id: string; email: string; enabled: boolean; status: string; createdAt: string;
  plan: 'free' | 'premium'; songs: number; songLimit: number; splits: number; splitLimit: number; bytes: number;
  today: { open: number; play: number }; week: { open: number; play: number }; lastActive: string | null;
}

// The master admin's calls (backend/admin-api.mjs); the API refuses them for anyone else.
@Injectable({ providedIn: 'root' })
export class AdminService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly config = inject(CONFIG);

  private async headers() { return { Authorization: `Bearer ${await this.auth.token()}` }; }

  async users(): Promise<AdminUser[]> {
    return (await firstValueFrom(this.http.get<{ users: AdminUser[] }>(`${this.config.apiBaseUrl}/admin/users`,
      { headers: await this.headers() }))).users;
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await firstValueFrom(this.http.post(`${this.config.apiBaseUrl}/admin/users/${id}/enabled`, { enabled }, { headers: await this.headers() }));
  }
  async setPlan(id: string, plan: 'free' | 'premium'): Promise<void> {
    await firstValueFrom(this.http.post(`${this.config.apiBaseUrl}/admin/users/${id}/plan`, { plan }, { headers: await this.headers() }));
  }
  async open(id: string): Promise<void> {
    const opened = await firstValueFrom(this.http.post<{ email: string; session: { idToken: string; accessToken: string; expiresIn: number } }>(
      `${this.config.apiBaseUrl}/admin/users/${id}/session`, {}, { headers: await this.headers() }));
    this.auth.startViewing(opened.session, opened.email);
  }
}

// Time on the website, sent each minute: open while the page is visible, play while a song plays. Not counted
// while an admin views someone else's account.
@Injectable({ providedIn: 'root' })
export class ActivityService {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly config = inject(CONFIG);
  private open = 0;
  private play = 0;
  private players = 0;
  private started = false;

  // Each mixer reports when it starts and stops playing.
  playing(now: boolean): void { this.players = Math.max(0, this.players + (now ? 1 : -1)); }

  start(): void {
    if (this.started) return;
    this.started = true;
    const STEP = 15;
    setInterval(() => {
      if (!this.auth.signedIn() || this.auth.viewing() || document.visibilityState !== 'visible') return;
      this.open += STEP;
      if (this.players > 0) this.play += STEP;
      if (this.open >= 60) void this.send();
    }, STEP * 1000);
  }

  private async send(): Promise<void> {
    const body = { open: Math.min(this.open, 120), play: Math.min(this.play, 120) };
    this.open = 0; this.play = 0;
    try {
      await firstValueFrom(this.http.post(`${this.config.apiBaseUrl}/activity`, body,
        { headers: { Authorization: `Bearer ${await this.auth.token()}` } }));
    } catch { /* A missed minute is not worth bothering the user about. */ }
  }
}
