import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { t } from './i18n';

export const API_URL = 'https://api.tunesbasis.com/api';
const COGNITO_URL = 'https://cognito-idp.us-west-2.amazonaws.com/';
const CLIENT_ID = '1uehn7q7u8lg474q16o52h2cv5';
const EMAIL_KEY = 'sorituh.email';
const PASSWORD_KEY = 'sorituh.password';
const DEVICE_KEY = 'sorituh.device';

// Same shape the website keeps under its `youtube-session` storage key.
export interface Session {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

// The password was rejected, as opposed to the network or service failing.
export class RejectedError extends Error {}

export const savedEmail = () => SecureStore.getItemAsync(EMAIL_KEY);

export async function savedLogin(): Promise<{ email: string; password: string } | null> {
  const [email, password] = await Promise.all([
    SecureStore.getItemAsync(EMAIL_KEY), SecureStore.getItemAsync(PASSWORD_KEY),
  ]);
  return email && password ? { email, password } : null;
}

export const forgetPassword = () => SecureStore.deleteItemAsync(PASSWORD_KEY);

async function cognito(target: string, body: object) {
  const response = await fetch(COGNITO_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (String(result.__type).endsWith('NotAuthorizedException')) {
      throw new RejectedError(result.message ?? t('auth.rejected'));
    }
    throw new Error(result.message ?? t('auth.failed'));
  }
  return result;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const result = await cognito('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH', ClientId: CLIENT_ID,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  const tokens = result.AuthenticationResult;
  if (!tokens?.IdToken || !tokens.AccessToken || !tokens.RefreshToken) {
    throw new Error(t('auth.noSession'));
  }
  return {
    idToken: tokens.IdToken, accessToken: tokens.AccessToken, refreshToken: tokens.RefreshToken,
    expiresAt: Date.now() + tokens.ExpiresIn * 1000,
  };
}

// Cognito returns no new refresh token here, so the old one is kept, as on the website.
export async function refresh(session: Session): Promise<Session> {
  const result = await cognito('InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: CLIENT_ID,
    AuthParameters: { REFRESH_TOKEN: session.refreshToken },
  });
  const tokens = result.AuthenticationResult;
  if (!tokens?.IdToken || !tokens.AccessToken) throw new Error(t('auth.noSession'));
  return {
    idToken: tokens.IdToken, accessToken: tokens.AccessToken,
    refreshToken: tokens.RefreshToken ?? session.refreshToken,
    expiresAt: Date.now() + tokens.ExpiresIn * 1000,
  };
}

// Ends every session of this account. A failure is ignored, since the saved password
// is removed anyway and the device signs in again without a code.
export async function signOut(session: Session) {
  await cognito('GlobalSignOut', { AccessToken: session.accessToken }).catch(() => {});
  await forgetPassword();
}

async function devicePassword(deviceId: string): Promise<string> {
  const salt = Array.from(Crypto.getRandomBytes(32), byte => byte.toString(16).padStart(2, '0')).join('');
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256, `${deviceId}:${salt}`,
  );
  return `${digest}aA1!`;
}

// Must survive a reinstall. Android's ID does; on iOS the vendor ID can change but
// the Keychain is kept, so a generated ID is stored there.
async function deviceIdentifier(): Promise<string> {
  if (Platform.OS === 'android') return Application.getAndroidId();
  let id = await SecureStore.getItemAsync(DEVICE_KEY);
  if (!id) {
    id = Crypto.randomUUID();
    await SecureStore.setItemAsync(DEVICE_KEY, id);
  }
  return id;
}

// Creates the account, or gives this device a new password if it has used the
// account before. A device new to an existing account also needs the emailed code.
export async function signInDevice(email: string, code?: string): Promise<Session | null> {
  const deviceId = await deviceIdentifier();
  const password = await devicePassword(deviceId);
  const session = await fetch(`${API_URL}/accounts/session`, { method: 'POST' });
  const sessionBody = await session.json();
  if (!session.ok) throw new Error(sessionBody.message ?? t('auth.unavailable'));
  const response = await fetch(`${API_URL}/accounts/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Account-Session': sessionBody.token },
    body: JSON.stringify({ email, deviceId, password, code }),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message ?? t('auth.unavailable'));
  await SecureStore.setItemAsync(EMAIL_KEY, email);
  if (result.status !== 'ready') return null;
  await SecureStore.setItemAsync(PASSWORD_KEY, password);
  return signIn(email, password);
}
