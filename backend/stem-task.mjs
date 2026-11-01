import { createStemWorker } from './stem-worker.mjs';

try {
  await createStemWorker()(JSON.parse(process.env.STEM_JOB));
} catch (error) {
  console.error('Stem task could not finish recording its outcome', { name: error.name });
  process.exitCode = 1;
}
