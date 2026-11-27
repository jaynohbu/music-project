import { createStemWorker } from './stem-worker.mjs';
import { createRestoreWorker, runStemTask } from './stem-restore.mjs';
import { createHarmonyWorker, createLyricsWorker } from './stem-analysis.mjs';
import { createRenderWorker } from './stem-render.mjs';

try {
  await runStemTask({
    separate: createStemWorker(), restore: createRestoreWorker(), recognize: createLyricsWorker(), harmonize: createHarmonyWorker(), render: createRenderWorker(),
  })(JSON.parse(process.env.STEM_JOB));
} catch (error) {
  console.error('Stem task could not finish recording its outcome', { name: error.name });
  process.exitCode = 1;
}
