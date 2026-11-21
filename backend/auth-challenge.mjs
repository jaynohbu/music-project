import { randomBytes, timingSafeEqual } from 'node:crypto';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { challengeAnswer } from './admin-api.mjs';

// Cognito's custom sign-in, used only by the admin API to open the website as a user (admin-api.mjs).
// Only the server-only impersonation client allows CUSTOM_AUTH (the public client does not), and the answer
// is an HMAC with a secret that only Lambda can read, so nobody without the secret can pass it. The client ID
// is not checked here: the user pool would then depend on itself through this function.
const secrets = new SecretsManagerClient({});
let secret;

export function createHandler({ store = secrets } = {}) {
  return async event => {
    switch (event.triggerSource) {
      case 'DefineAuthChallenge_Authentication': {
        const sessions = event.request.session ?? [];
        const last = sessions.at(-1);
        if (sessions.length > 1 || (last && last.challengeName !== 'CUSTOM_CHALLENGE')) {
          event.response.failAuthentication = true;
          event.response.issueTokens = false;
        } else if (last?.challengeResult) {
          event.response.issueTokens = true;
          event.response.failAuthentication = false;
        } else if (last) {
          event.response.failAuthentication = true;
          event.response.issueTokens = false;
        } else {
          event.response.challengeName = 'CUSTOM_CHALLENGE';
          event.response.issueTokens = false;
          event.response.failAuthentication = false;
        }
        return event;
      }
      case 'CreateAuthChallenge_Authentication': {
        const nonce = randomBytes(32).toString('hex');
        event.response.publicChallengeParameters = { nonce };
        event.response.privateChallengeParameters = { nonce };
        event.response.challengeMetadata = 'ADMIN_SESSION';
        return event;
      }
      case 'VerifyAuthChallengeResponse_Authentication': {
        secret ??= (await store.send(new GetSecretValueCommand({ SecretId: process.env.IMPERSONATION_SECRET }))).SecretString;
        const expected = Buffer.from(challengeAnswer(secret, event.request.privateChallengeParameters.nonce, event.userName));
        const given = Buffer.from(String(event.request.challengeAnswer ?? ''));
        event.response.answerCorrect = given.length === expected.length && timingSafeEqual(given, expected);
        return event;
      }
      default:
        return event;
    }
  };
}

export const handler = createHandler();
