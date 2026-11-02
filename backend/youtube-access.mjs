export const YOUTUBE_OWNER_EMAIL = 'nohjiyoung@hotmail.com';

export function canUseYoutube(userId) {
  const owner = process.env.YOUTUBE_OWNER_SUB;
  return !!owner && owner !== 'disabled' && userId === owner;
}
