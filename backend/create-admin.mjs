#!/usr/bin/env node
// Creates or updates the master admin from the repository's .env file (never committed):
//   SORITUH_ADMIN_EMAIL=...   SORITUH_ADMIN_PASSWORD=...   (12+ characters, upper and lower case, a number, a symbol)
// The admin is an ordinary user in the pool's `admins` group, so it signs in on the website with that password
// and needs no device. Run with AWS credentials: AWS_REGION=us-west-2 node backend/create-admin.mjs
import { readFileSync } from 'node:fs';
import {
  AdminAddUserToGroupCommand, AdminCreateUserCommand, AdminSetUserPasswordCommand, CognitoIdentityProviderClient,
  UsernameExistsException,
} from '@aws-sdk/client-cognito-identity-provider';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')
  .map(line => /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line)).filter(Boolean).map(([, key, value]) => [key, value.replace(/^["']|["']$/g, '')]));
const email = env.SORITUH_ADMIN_EMAIL?.toLowerCase(), password = env.SORITUH_ADMIN_PASSWORD;
if (!email || !password) throw new Error('Set SORITUH_ADMIN_EMAIL and SORITUH_ADMIN_PASSWORD in .env.');

const stack = process.env.STACK ?? 'youtube-audio-library';
const outputs = (await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: stack }))).Stacks[0].Outputs;
const UserPoolId = outputs.find(output => output.OutputKey === 'UserPoolId').OutputValue;
const cognito = new CognitoIdentityProviderClient({});
try {
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId, Username: email, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'email_verified', Value: 'true' }],
  }));
  console.log(`Created ${email}.`);
} catch (error) {
  if (!(error instanceof UsernameExistsException)) throw error;
  console.log(`${email} already exists; updating its password and group.`);
}
await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId, Username: email, Password: password, Permanent: true }));
await cognito.send(new AdminAddUserToGroupCommand({ UserPoolId, Username: email, GroupName: 'admins' }));
console.log(`${email} is an admin. Sign in on the website with this password.`);
