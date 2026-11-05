const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const names = ['vocals', 'guitar', 'bass', 'piano', 'drums', 'other'];

function fixture() {
  const contexts = [], shows = [], notifications = new Map(), events = new Map();
  let eventId = 0;
  globalThis.AudioEventEmitter = {
    addAudioEventListener: (name, callback) => { const id = String(++eventId); events.set(id, { name, callback }); return id; },
    removeAudioEventListener: (_, id) => events.delete(id),
  };
  class Param {
    value = 1;
    cancelScheduledValues() {}
    setValueAtTime(value) { this.value = value; }
    linearRampToValueAtTime(value) { this.value = value; }
    setTargetAtTime(value) { this.value = value; }
  }
  class Node {
    connections = [];
    gain = new Param(); frequency = new Param(); Q = new Param(); pan = new Param();
    connect(target) {
      if (target.isConvolver && !target.buffer) throw new Error('Native convolver connected without an initialized impulse buffer');
      this.connections.push(target);
    }
    disconnect(target) { this.connections = target ? this.connections.filter(node => node !== target) : []; }
  }
  class Context {
    state = 'suspended'; currentTime = 0; sampleRate = 44100;
    destination = new Node(); nodes = []; files = []; failResume = false; badDuration = false;
    context = { createFileSource: ({ source, playbackRate, preservesPitch }) => {
      const file = { source, duration: source.includes('bad') ? 0 : source.includes('take') ? 60 : 240, currentTime: 0, starts: [], disposed: false,
        rate: playbackRate, preservesPitch, paused: 0,
        pause() { this.paused++; }, seekToTime(value) { this.currentTime = value; },
        start(when) { this.starts.push(when); }, disconnect() {}, volume: 1,
      };
      this.files.push(file); return file;
    } };
    constructor() { contexts.push(this); }
    make() { const node = new Node(); this.nodes.push(node); return node; }
    createGain() { return this.make(); }
    createBiquadFilter() { return this.make(); }
    createStereoPanner() { return this.make(); }
    createWaveShaper() { return this.make(); }
    createConvolver() { const node = this.make(); node.isConvolver = true; return node; }
    createBuffer(channels, length) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { getChannelData: channel => data[channel] };
    }
    createWorkletProcessingNode(process) { const node = this.make(); node.process = process; return node; }
    async resume() { if (this.failResume) throw new Error('Audio resume refused'); this.state = 'running'; }
    async close() { this.state = 'closed'; }
  }
  class Source {
    constructor(context, native) { this.native = native; }
    getFileSourceNode() { return this.native; }
    getDuration() { return this.native.duration; }
    getCurrentTime() { return this.native.currentTime; }
    pause() { this.native.pause(); }
    seekToTime(value) { this.native.seekToTime(value); }
    setVolume(value) { this.native.volume = value; }
    setPlaybackRate(value) { this.native.rate = value; }
    play() {}
    dispose() { this.native.disposed = true; }
  }
  // The native registry crashes on overlapping calls; record the worst overlap.
  const overlap = { active: 0, max: 0, calls: [] };
  const native = async (name, change) => {
    overlap.calls.push(name);
    overlap.active++; overlap.max = Math.max(overlap.max, overlap.active);
    await new Promise(resolve => setTimeout(resolve, 1));
    change(); overlap.active--;
  };
  const constructed = setup => class {
    constructor(context, options = {}) {
      const node = context.make(); node.options = options;
      if (options.gain !== undefined) node.gain.value = options.gain;
      setup?.(node);
      return node;
    }
  };
  const audio = {
    AudioContext: Context, MediaElementAudioSourceNode: Node,
    GainNode: constructed(), BiquadFilterNode: constructed(), StereoPannerNode: constructed(), WaveShaperNode: constructed(),
    ConvolverNode: constructed(node => { node.isConvolver = true; }),
    AudioManager: { setAudioSessionOptions() {}, observeAudioInterruptions() {},
      addSystemEventListener: () => ({ remove() {} }) },
    PlaybackNotificationManager: {
      addEventListener: (name, handler) => { notifications.set(name, handler); return { remove: () => notifications.delete(name) }; },
      enableControl: () => native('enable', () => {}), show: options => native('show', () => { shows.push(options); }), hide: () => native('hide', () => {}),
    },
  };
  const mocks = {
    'react-native-audio-api': audio,
    'react-native-audio-api/lib/module/Audio/AudioFileSourceNode': { AudioFileSourceNode: Source },
    'react-native-worklets': { createSynchronizable: value => ({ getDirty: () => value, setBlocking: next => { value = next; } }) },
    './api': { STEM_NAMES: names },
  };
  const loaded = new Map();
  function load(file) {
    if (loaded.has(file)) return loaded.get(file);
    const source = fs.readFileSync(path.join(__dirname, '../src', `${file}.ts`), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const module = { exports: {} };
    loaded.set(file, module.exports);
    const dependency = name => Object.hasOwn(mocks, name) ? mocks[name] : name.startsWith('./') ? load(name.slice(2)) : require(name);
    new Function('require', 'module', 'exports', code)(dependency, module, module.exports);
    return module.exports;
  }
  return { load, mocks, Context, contexts, shows, overlap, events, notifications, paths: Object.fromEntries(names.map(name => [name, `/audio/${name}.m4a`])) };
}

test('all nine effects have web ranges, real routing and smoothed controls', () => {
  const f = fixture(), { createEffects, applyEffects, defaults, EFFECT_CONTROLS } = f.load('effects');
  const context = new f.Context(), nodes = createEffects(context);
  assert.ok(nodes.convolver.buffer, 'Reverb must be initialized before any connection, even at the default zero send');
  const initialImpulse = nodes.convolver.buffer;
  assert.equal(EFFECT_CONTROLS.length, 9);
  assert.deepEqual(EFFECT_CONTROLS.map(control => [control.key, control.min, control.max, control.step]), [
    ['volume', 0, 100, 1], ['preGain', 0, 200, 1], ['compression', 0, 100, 1], ['distortion', 0, 100, 1],
    ['bass', -12, 12, .5], ['mid', -12, 12, .5], ['treble', -12, 12, .5], ['pan', -100, 100, 1], ['reverb', 0, 100, 1],
  ]);
  assert.deepEqual(defaults(), { volume: 80, preGain: 100, compression: 0, distortion: 0, bass: 0, mid: 0, treble: 0, pan: 0, reverb: 0 });
  assert.equal(nodes.input.connections.length, 2);
  applyEffects(context, nodes, { ...defaults(), preGain: 150, compression: 75, distortion: 40, bass: 6, mid: -3, treble: 2, pan: -50, reverb: 60 }, false);
  assert.equal(nodes.preGain.gain.value, 1.5);
  assert.equal(nodes.compression.getDirty(), 75);
  assert.equal(nodes.distortionDry.gain.value, .6);
  assert.equal(nodes.distortionWet.gain.value, .4);
  assert.equal(nodes.bass.gain.value, 6); assert.equal(nodes.mid.gain.value, -3); assert.equal(nodes.treble.gain.value, 2);
  assert.equal(nodes.pan.pan.value, -.5); assert.equal(nodes.send.gain.value, .6); assert.equal(nodes.reverbWet.gain.value, .3);
  assert.ok(nodes.convolver.buffer);
  assert.equal(nodes.convolver.buffer, initialImpulse, 'Dragging Reverb must not replace the live native impulse');
  applyEffects(context, nodes, defaults(), true);
  assert.equal(nodes.dry.gain.value, 1); assert.equal(nodes.wet.gain.value, 0); assert.equal(nodes.send.gain.value, 0);
});

test('every mixing node is explicit stereo so native fan-out cannot silence a stem', async () => {
  const f = fixture(), { createEffects } = f.load('effects');
  const context = new f.Context(), nodes = createEffects(context);
  f.load('effects').applyEffects(context, nodes, { ...f.load('effects').defaults(), compression: 50 }, false);
  for (const node of context.nodes) {
    if (node.process) {
      assert.deepEqual(node.connections, [nodes.compressed], 'The worklet must feed exactly one explicit node');
    } else {
      assert.equal(node.options?.channelCountMode, 'explicit', 'Default "max" nodes process in place and share stale buffers');
      assert.equal(node.options.channelCount, 2);
    }
  }
  assert.equal(nodes.dry.gain.value, 0); assert.equal(nodes.distortionWet.gain.value, 0); assert.equal(nodes.send.gain.value, 0);
  await f.load('player').Mixer.create(f.paths, 'Explicit');
  const mixer = f.contexts.at(-1);
  assert.ok(mixer.nodes.every(node => node.process || node.options?.channelCountMode === 'explicit'));
});

test('idle compressor worklet and reverb convolver stay out of the audio graph', async () => {
  const f = fixture(), { createEffects, applyEffects, defaults } = f.load('effects');
  const context = new f.Context(), nodes = createEffects(context);
  const linked = () => ({
    compressor: nodes.preGain.connections.includes(nodes.compressor) && nodes.compressor.connections.includes(nodes.compressed),
    direct: nodes.preGain.connections.includes(nodes.compressed),
    reverb: nodes.send.connections.includes(nodes.convolver) && nodes.convolver.connections.includes(nodes.reverbWet),
  });
  assert.deepEqual(linked(), { compressor: false, direct: true, reverb: false }, 'Defaults must not run the worklet or convolver');
  applyEffects(context, nodes, { ...defaults(), compression: 40, reverb: 30 }, false);
  assert.deepEqual(linked(), { compressor: true, direct: false, reverb: true });
  applyEffects(context, nodes, { ...defaults(), compression: 40, reverb: 30 }, true);
  assert.equal(linked().compressor, false, 'Bypass unlinks the compressor');
  assert.equal(linked().reverb, true, 'The reverb tail fades before it is unlinked');
  applyEffects(context, nodes, { ...defaults(), reverb: 30 }, false);
  assert.equal(linked().reverb, true, 'Turning reverb back on cancels the pending unlink');
  applyEffects(context, nodes, defaults(), false);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(linked(), { compressor: false, direct: true, reverb: false });
});

test('lock-screen control calls never overlap in the native registry', async () => {
  const f = fixture(), { Mixer } = f.load('player');
  const mixer = await Mixer.create(f.paths, 'Serial');
  await mixer.play(); await mixer.pause(); mixer.setTitle('Renamed');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(f.shows.map(show => [show.title, show.state]), [['Serial', 'playing'], ['Renamed', 'paused'], ['Renamed', 'paused']]);
  await mixer.play(); mixer.setTitle('Late'); await mixer.close();
  assert.equal(f.overlap.calls.at(-1), 'hide', 'No show may run after close hides the controls');
  assert.ok(!f.shows.some(show => show.title === 'Late'));
  await Mixer.create(f.paths, 'Next');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(f.overlap.max, 1);
});

test('compression never amplifies and links both stereo channels', async () => {
  const f = fixture(), { compressionGain, createEffects, applyEffects, defaults } = f.load('effects');
  for (const amount of [0, 25, 75, 100]) for (const peak of [0, .001, .1, .5, 1, 2]) {
    assert.ok(compressionGain(peak, amount) > 0 && compressionGain(peak, amount) <= 1);
  }
  const mixer = await f.load('player').Mixer.create(f.paths, 'Stereo');
  const context = f.contexts[0], start = context.nodes.length;
  const nodes = createEffects(context);
  applyEffects(context, nodes, { ...defaults(), compression: 100 }, false);
  const compressor = context.nodes.slice(start).find(node => node.process);
  const left = new Float32Array(8192).fill(.5), right = new Float32Array(8192).fill(.125);
  const outputs = [new Float32Array(left.length), new Float32Array(left.length)];
  compressor.process([left, right], outputs, left.length);
  assert.ok(outputs[0].at(-1) < .5);
  assert.equal(outputs[1].at(-1) / outputs[0].at(-1), .25);
  await mixer.close();
});

test('Play schedules every original/cleaned source together; routing switches and mute/solo work', async () => {
  const f = fixture(), { Mixer } = f.load('player');
  const mixer = await Mixer.create(f.paths, 'Song', '', { vocals: '/audio/cleaned.m4a' });
  await mixer.play();
  const context = f.contexts[0];
  assert.equal(context.files.length, 7);
  assert.ok(context.files.every(source => source.starts[0] === .2));
  assert.equal(mixer.isPlaying, true);
  mixer.setChannel('vocals', { useCleaned: true, volume: .5, preGain: 150, solo: true });
  assert.equal(mixer.channel('vocals').useCleaned, true);
  assert.equal(mixer.hasCleaned('guitar'), false);
  assert.equal(mixer.stems.vocals.originalGain.gain.value, 0);
  assert.equal(mixer.stems.vocals.cleanedGain.gain.value, 1);
  assert.equal(mixer.stems.vocals.gain.gain.value, .5);
  assert.ok(names.filter(name => name !== 'vocals').every(name => mixer.stems[name].gain.gain.value === 0));
  mixer.setChannel('vocals', { muted: true }); assert.equal(mixer.stems.vocals.gain.gain.value, 0);
  mixer.setTitle('2. Renamed scene song'); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.shows.at(-1).title, '2. Renamed scene song');
  await mixer.stop();
  assert.equal(mixer.isPlaying, false); assert.equal(mixer.position, 0);
  await mixer.close();
  assert.ok(context.files.every(source => source.disposed));
  assert.equal(f.events.size, 0);
});

test('Play failure is visible, rejects to the screen, and the operation queue recovers', async () => {
  const f = fixture(), mixer = await f.load('player').Mixer.create(f.paths, 'Failure');
  f.contexts[0].failResume = true;
  await assert.rejects(mixer.play(), /Audio resume refused/);
  assert.equal(mixer.error, 'Audio resume refused');
  assert.equal(mixer.isPlaying, false);
  f.contexts[0].failResume = false;
  await mixer.play(); assert.equal(mixer.isPlaying, true); assert.equal(mixer.error, '');
  await mixer.close();
});

test('natural completion emits once; Stop and Pause do not advance Scenes', async () => {
  const f = fixture(), mixer = await f.load('player').Mixer.create(f.paths, 'Sequence');
  let ended = 0;
  mixer.onEnded(() => ended++);
  await mixer.play(); await mixer.pause(); await mixer.stop();
  assert.equal(ended, 0);
  await mixer.play();
  f.contexts[0].currentTime = 241;
  mixer.tick(); mixer.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ended, 1); assert.equal(mixer.isPlaying, false);
  mixer.tick(); assert.equal(ended, 1);
  await mixer.close();
});

test('loop restarts the selected section without advancing the Scene', async () => {
  const f = fixture(), mixer = await f.load('player').Mixer.create(f.paths, 'Loop');
  let ended = 0; mixer.onEnded(() => ended++);
  mixer.setSection(10, 20); mixer.setLoop(true);
  await mixer.play();
  f.contexts[0].currentTime = 11;
  mixer.tick();
  await new Promise(resolve => setImmediate(resolve));
  mixer.setLoop(false);
  await new Promise(resolve => setTimeout(resolve, 550));
  assert.equal(ended, 0); assert.equal(mixer.isPlaying, true);
  assert.ok(f.contexts[0].files.every(source => source.starts.length === 2));
  await mixer.close();
});

test('invalid duration closes partially initialized sources and context', async () => {
  const f = fixture(), paths = { ...f.paths, vocals: '/audio/bad.m4a' };
  await assert.rejects(f.load('player').Mixer.create(paths, 'Broken'), /could not be read/);
  assert.equal(f.contexts[0].state, 'closed');
  assert.ok(f.contexts[0].files.every(source => source.disposed));
  assert.equal(f.events.size, 0);
});

test('closing during Play prevents scheduled starts and releases native listeners', async () => {
  const f = fixture(), mixer = await f.load('player').Mixer.create(f.paths, 'Close while starting');
  const playing = mixer.play();
  await new Promise(resolve => setImmediate(resolve));
  const closed = mixer.close();
  await Promise.all([playing, closed]);
  assert.ok(f.contexts[0].files.every(source => source.starts.length === 0 && source.disposed));
  assert.equal(f.events.size, 0); assert.equal(mixer.isPlaying, false);
});

test('stems stretch to a new speed with pitch kept, and the position follows the speed', async () => {
  const f = fixture(), mixer = await f.load('player').Mixer.create(f.paths, 'Rate');
  const context = f.contexts.at(-1);
  assert.ok(context.files.every(file => file.preservesPitch && file.rate === 1));
  await mixer.play();
  context.currentTime = 2.2; // two seconds after the scheduled start
  assert.ok(Math.abs(mixer.position - 2) < 1e-9);
  mixer.setRate(1.2);
  assert.ok(context.files.every(file => file.rate === 1.2));
  context.currentTime = 4.2;
  assert.ok(Math.abs(mixer.position - 4.4) < 1e-9, `${mixer.position}`);
  mixer.setRate(9);
  assert.equal(mixer.rate, 1.3, 'speed stays in the follow range');
  await mixer.close();
});

test('a take plays from the matching point and the stems follow its tempo log', async () => {
  const f = fixture(), mixer = await f.load('player').Mixer.create(f.paths, 'Take');
  const context = f.contexts.at(-1);
  // Recorded with the band starting 0.5 s in, at normal speed until 10 s, then 10% faster.
  const points = [{ at: 0.5, pos: 0, rate: 1 }, { at: 10, pos: 9.5, rate: 1.1 }];
  await mixer.attachTake({ path: '/audio/take.m4a', duration: 60, latency: 0.03, points, volume: 0.8, muted: false });
  assert.ok(mixer.hasTake);
  await mixer.seek(20);
  await mixer.play();
  const take = context.files.find(file => file.source.includes('take'));
  const expected = 10 + (20 - 9.5) / 1.1 + 0.03;
  assert.ok(Math.abs(take.currentTime - expected) < 1e-9, `take seeked to ${take.currentTime}`);
  assert.equal(take.rate, 1, 'the recording itself is never stretched');
  assert.ok(context.files.filter(file => !file.source.includes('take')).every(file => Math.abs(file.rate - 1.1) < 1e-9));
  assert.deepEqual(take.starts, [context.files[0].starts.at(-1)]);
  // Back at the top, the take starts where the band came in during the recording.
  await mixer.seek(0);
  const early = context.files.filter(file => file.source.includes('take')).at(-1);
  assert.notEqual(early, take, 'a take source is reopened on every start');
  assert.ok(take.disposed);
  assert.ok(Math.abs(early.currentTime - 0.53) < 1e-9, `${early.currentTime}`);
  assert.equal(mixer.rate, 1);
  mixer.setTakeLevel({ muted: true });
  assert.deepEqual(mixer.takeLevel, { volume: 0.8, muted: true });
  await mixer.removeTake();
  assert.ok(!mixer.hasTake);
  assert.ok(early.disposed);
  assert.equal(mixer.rate, 1);
  await mixer.close();
});

test('the stem a live take replaces is silent without changing its channel', async () => {
  const f = fixture(), mixer = await f.load('player').Mixer.create(f.paths, 'Replace');
  mixer.setChannel('bass', { volume: .7 });
  mixer.setReplacedStem('bass');
  assert.equal(mixer.replacedStem, 'bass');
  assert.equal(mixer.stems.bass.gain.gain.value, 0);
  assert.equal(mixer.channels.bass.muted, false);
  assert.equal(mixer.channels.bass.volume, .7);
  assert.equal(mixer.stems.guitar.gain.gain.value, .8);
  mixer.setReplacedStem(null);
  assert.equal(mixer.stems.bass.gain.gain.value, .7);
  await mixer.close();
});

test('stalled native audio produces a visible error instead of pretending to Play', async () => {
  const f = fixture(), mixer = await f.load('player').Mixer.create(f.paths, 'Stall');
  await mixer.play();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 2500;
    mixer.tick(); // the first check after a start only takes a baseline
    Date.now = () => realNow() + 5000;
    mixer.tick();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(mixer.error, /Audio did not advance/);
    assert.equal(mixer.isPlaying, false);
  } finally { Date.now = realNow; await mixer.close(); }
});

function cacheFixture() {
  const f = fixture(), disk = new Map(), tasks = [];
  let inFlight = 0, deletedWhileDownloading = false, fail = false;
  const uri = (...pieces) => pieces.map(piece => typeof piece === 'string' ? piece : piece.uri).join('/').replace(/\/+/g, '/');
  class Directory {
    constructor(...pieces) { this.uri = uri(...pieces); }
    get name() { return this.uri.split('/').at(-1); }
    get exists() { return disk.has(this.uri); }
    create() { disk.set(this.uri, { directory: true }); }
    list() {
      return [...disk.keys()].filter(key => key.startsWith(`${this.uri}/`) && !key.slice(this.uri.length + 1).includes('/'))
        .map(key => disk.get(key).directory ? new Directory(key) : new File(key));
    }
    delete() {
      if (this.name.startsWith('.download-') && inFlight) deletedWhileDownloading = true;
      for (const key of disk.keys()) if (key === this.uri || key.startsWith(`${this.uri}/`)) disk.delete(key);
    }
    rename(name) {
      const next = uri(this.uri.slice(0, this.uri.lastIndexOf('/')), name);
      for (const [key, data] of [...disk.entries()]) if (key === this.uri || key.startsWith(`${this.uri}/`)) {
        disk.set(next + key.slice(this.uri.length), data); disk.delete(key);
      }
      this.uri = next;
    }
  }
  class File {
    constructor(...pieces) { this.uri = uri(...pieces); }
    get exists() { return disk.has(this.uri); }
    get size() { return BigInt(disk.get(this.uri)?.bytes ?? 0); }
    textSync() { return disk.get(this.uri).text; }
    write(text) { disk.set(this.uri, { text, bytes: text.length }); }
    static createDownloadTask(url, file, options) {
      tasks.push(url);
      return { downloadAsync: async () => {
        inFlight++;
        try {
          await new Promise(resolve => setTimeout(resolve, fail && url.includes('vocals') ? 1 : 15));
          if (fail && url.includes('vocals')) throw new Error('Download refused');
          disk.set(file.uri, { bytes: 10000 });
          options.onProgress({ bytesWritten: 10000n, totalBytes: 10000n });
          return file;
        } finally { inFlight--; }
      } };
    }
  }
  const song = { jobId: 'song', status: 'completed', duration: 240, playVersion: 'aac-256k',
    stems: Object.fromEntries(names.map(name => [name, { playUrl: `https://example.invalid/${name}.m4a` }])) };
  f.mocks['expo-file-system'] = { Directory, File, Paths: { document: '/docs', availableDiskSpace: 10000000000n } };
  f.mocks['./api'] = { STEM_NAMES: names, getSong: async () => song, toNumber: Number };
  return { ...f, disk, tasks, song, cache: f.load('cache'), fail: () => { fail = true; },
    deletedWhileDownloading: () => deletedWhileDownloading };
}

test('cache deduplicates simultaneous downloads and reference-counts open songs', async () => {
  const f = cacheFixture(), progress = [];
  const firstHold = f.cache.holdSong('song'), secondHold = f.cache.holdSong('song');
  await Promise.all([f.cache.songFiles(f.song, () => {}), f.cache.songFiles(f.song, value => progress.push(value))]);
  assert.equal(f.tasks.length, 6); assert.ok(progress.includes(1));
  firstHold(); f.cache.forgetSong('song'); assert.equal(f.cache.cacheSize().songs, 1);
  secondHold(); f.cache.forgetSong('song'); assert.equal(f.cache.cacheSize().songs, 0);
});

test('missing cached files are downloaded again rather than handed to the audio engine', async () => {
  const f = cacheFixture(), release = f.cache.holdSong('song');
  await f.cache.songFiles(f.song, () => {});
  f.disk.delete('/docs/songs/song/guitar.m4a');
  await f.cache.songFiles(f.song, () => {});
  assert.equal(f.tasks.length, 12); assert.ok(f.disk.has('/docs/songs/song/guitar.m4a'));
  release();
});

test('failed downloads settle every task before deleting their temporary folder', async () => {
  const f = cacheFixture(); f.fail();
  await assert.rejects(f.cache.songFiles(f.song, () => {}), /Download refused/);
  assert.equal(f.deletedWhileDownloading(), false);
  assert.equal(f.cache.cacheSize().songs, 0);
  assert.ok(![...f.disk.keys()].some(key => key.includes('.download-')));
});

test('scene snapshots use percentages, preserve every effect and clamp source duration', async () => {
  const f = fixture(), { Mixer } = f.load('player'), { snapshot, restore } = f.load('mixer-settings');
  const mixer = await Mixer.create(f.paths, 'Snapshot', '', {}, 239.95);
  mixer.setVolume(.45); mixer.setChannel('vocals', { volume: .65, preGain: 175, compression: 35, distortion: 15, pan: 65, reverb: 50, bass: -6, mid: 5, treble: -4, bypassed: true, solo: true });
  mixer.setSection(20, 240); mixer.setLoop(true);
  const first = snapshot(mixer);
  assert.equal(first.masterVolume, 45); assert.equal(first.tracks.vocals.volume, 65);
  assert.equal(first.sectionEnd, 239.95);
  mixer.reset(); restore(mixer, first);
  assert.deepEqual(snapshot(mixer), first);
  mixer.setChannel('vocals', { bass: 1 });
  assert.equal(first.tracks.vocals.bass, -6);
  const { sceneSettings } = await import('../../backend/scene-api.mjs');
  assert.deepEqual(sceneSettings(first, 239.95), first);
  await mixer.close();
});

test('autosave serializes in-flight edits and uses the returned revision', async () => {
  const { SceneStore } = fixture().load('scene-store');
  const requests = [];
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const store = new SceneStore({ id: 'scene', name: 'A', revision: 1, entries: [] }, async (id, revision, patch) => {
    requests.push({ revision, patch });
    if (requests.length === 1) await first;
    return { id, revision: revision + 1, ...patch };
  }, () => {});
  store.update(scene => ({ ...scene, name: 'B' }));
  const saved = store.flush();
  store.update(scene => ({ ...scene, name: 'C' }));
  release(); assert.equal(await saved, true);
  assert.deepEqual(requests.map(request => [request.revision, request.patch.name]), [[1, 'B'], [2, 'C']]);
  assert.equal(store.dirty, false); assert.equal(store.status, 'saved');
});

test('autosave conflict keeps local edits and revision for explicit retry/reload', async () => {
  const { SceneStore } = fixture().load('scene-store');
  let fail = true;
  const revisions = [];
  const store = new SceneStore({ id: 'scene', name: 'A', revision: 4, entries: [] }, async (id, revision, patch) => {
    revisions.push(revision);
    if (fail) throw new Error('Scene changed on another device. Reload it.');
    return { id, revision: revision + 1, ...patch };
  }, () => {});
  store.update(scene => ({ ...scene, name: 'Local' }));
  assert.equal(await store.flush(), false);
  assert.equal(store.dirty, true); assert.equal(store.scene.name, 'Local'); assert.match(store.error, /another device/);
  fail = false; assert.equal(await store.flush(), true); assert.deepEqual(revisions, [4, 4]);
  store.update(scene => ({ ...scene, name: 'Discard' }));
  store.reload({ id: 'scene', name: 'Server', revision: 10, entries: [] });
  assert.equal(store.scene.name, 'Server'); assert.equal(store.dirty, false);
});

test('discarding failed edits prevents unmount cleanup from saving them again', async () => {
  const { SceneStore } = fixture().load('scene-store');
  let writes = 0;
  const store = new SceneStore({ id: 'scene', name: 'A', revision: 1, entries: [] }, async () => {
    writes++; throw new Error('Save failed');
  }, () => {});
  store.update(scene => ({ ...scene, name: 'Discard me' }));
  assert.equal(await store.flush(), false);
  store.discard();
  assert.equal(await store.flush(), true);
  assert.equal(writes, 1); assert.equal(store.dirty, false);
});
