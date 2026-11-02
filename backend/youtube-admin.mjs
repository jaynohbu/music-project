import { pathToFileURL } from 'node:url';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { CognitoIdentityProviderClient, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectTaggingCommand, PutObjectTaggingCommand } from '@aws-sdk/client-s3';
import { YOUTUBE_OWNER_EMAIL } from './youtube-access.mjs';

export async function restrictLegacyYoutube({ database, storage, table, bucket, owner }) {
  if (!owner || owner === 'disabled') throw new Error('Resolve the designated YouTube owner before revoking links.');
  let start, blocked = 0, missing = 0;
  do {
    const page = await database.send(new ScanCommand({
      TableName: table, ExclusiveStartKey: start, ConsistentRead: true,
      FilterExpression: 'userId <> :owner AND (attribute_not_exists(#type) OR #type = :youtube)',
      ExpressionAttributeNames: { '#type': 'type' },
      ExpressionAttributeValues: { ':owner': owner, ':youtube': 'youtube' },
    }));
    for (const job of page.Items ?? []) {
      if (!job.key) continue;
      if (job.key !== `users/${job.userId}/${job.jobId}.wav`) {
        throw new Error('Unexpected legacy YouTube storage key; review before revoking access.');
      }
      let existing;
      try {
        existing = await storage.send(new GetObjectTaggingCommand({ Bucket: bucket, Key: job.key }));
      } catch (error) {
        if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
        missing++;
        continue;
      }
      const tags = (existing.TagSet ?? []).filter(tag => tag.Key !== 'sorituh-youtube-access');
      tags.push({ Key: 'sorituh-youtube-access', Value: 'blocked' });
      await storage.send(new PutObjectTaggingCommand({
        Bucket: bucket, Key: job.key, Tagging: { TagSet: tags },
      }));
      blocked++;
    }
    start = page.LastEvaluatedKey;
  } while (start);
  return { blocked, missing };
}

async function main() {
  const [action, stack = 'youtube-audio-library'] = process.argv.slice(2);
  if (!['owner', 'revoke'].includes(action)) throw new Error('Usage: node backend/youtube-admin.mjs owner|revoke [stack]');
  const config = { region: 'us-west-2' };
  const result = await new CloudFormationClient(config).send(new DescribeStacksCommand({ StackName: stack }));
  const output = name => {
    const value = result.Stacks[0].Outputs.find(item => item.OutputKey === name)?.OutputValue;
    if (!value) throw new Error(`Missing stack output: ${name}`);
    return value;
  };
  const user = await new CognitoIdentityProviderClient(config).send(new AdminGetUserCommand({
    UserPoolId: output('UserPoolId'), Username: YOUTUBE_OWNER_EMAIL,
  }));
  const attribute = name => user.UserAttributes.find(item => item.Name === name)?.Value;
  const owner = attribute('sub');
  if (!owner || attribute('email')?.toLowerCase() !== YOUTUBE_OWNER_EMAIL || !user.Enabled) {
    throw new Error('The designated YouTube account must exist and be enabled.');
  }
  if (action === 'owner') { console.log(owner); return; }
  const configured = output('YoutubeOwnerSubject');
  if (configured !== owner) throw new Error('Deploy the designated owner restriction before revoking legacy media.');
  const counts = await restrictLegacyYoutube({
    database: DynamoDBDocumentClient.from(new DynamoDBClient(config)), storage: new S3Client(config),
    table: output('JobsTableName'), bucket: output('AudioBucketName'), owner,
  });
  console.log(`Legacy YouTube links blocked: ${counts.blocked}; already-missing files: ${counts.missing}. Original uploaded stems are unchanged.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
