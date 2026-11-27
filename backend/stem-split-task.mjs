// The split container's entry: it only separates songs (Dockerfile.split). Lyrics, chords, scores and cleanups
// run in the analysis container (Dockerfile.stems, stem-task.mjs).
import { createStemWorker } from './stem-worker.mjs';

try {
  await createStemWorker()(JSON.parse(process.env.STEM_JOB));
} catch (error) {
  console.error('Split task could not finish recording its outcome', { name: error.name });
  process.exitCode = 1;
}
