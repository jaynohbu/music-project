const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// A tiny hook renderer: enough to run the console components and drive their PanResponder handlers.
function harness() {
  let hooks = [], index = 0, render = () => {};
  const react = {
    useState(initial) {
      const slot = index++;
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
      return [hooks[slot], next => { hooks[slot] = typeof next === 'function' ? next(hooks[slot]) : next; render(); }];
    },
    useRef(initial) { const slot = index++; if (!(slot in hooks)) hooks[slot] = { current: initial }; return hooks[slot]; },
    useLayoutEffect(effect) { index++; effect(); },
  };
  const element = (type, props) => typeof type === 'function' ? type(props) : { type, props };
  const native = {
    PanResponder: { create: config => ({ panHandlers: { responder: config } }) },
    StyleSheet: { create: styles => styles, absoluteFill: {} },
    View: 'View', Text: 'Text', Pressable: 'Pressable',
  };
  const source = fs.readFileSync(path.join(__dirname, '../src/mixer-console.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  const palette = new Proxy({}, { get: () => '#123456' });
  const theme = { useStyles: make => make(palette), useTheme: () => palette };
  const mocks = { react, 'react-native': native, 'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'Fragment' }, './theme': theme };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code)(name => mocks[name], module, module.exports);
  return {
    ...module.exports,
    mount(component, props) {
      let tree;
      render = () => { index = 0; tree = component(props()); };
      render();
      return { get tree() { return tree; }, rerender: render };
    },
  };
}

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) { for (const child of tree) { const found = find(child, predicate); if (found) return found; } return null; }
  if (tree.props && predicate(tree.props)) return tree;
  return find(tree.props?.children, predicate);
}
const byLabel = label => props => props.accessibilityLabel === label;
const drag = (node, grant, moves, release) => {
  const responder = node.props.responder;
  const start = { nativeEvent: grant };
  if (!responder.onStartShouldSetPanResponder(start)) {
    assert.equal(responder.onMoveShouldSetPanResponder(start, { dx: 20, dy: 2 }), true, 'Sideways drags are claimed');
  }
  assert.equal(responder.onPanResponderTerminationRequest(), false, 'A ScrollView must not steal a fader drag');
  responder.onPanResponderGrant(start, { dx: 0, dy: 0 });
  for (const move of moves) responder.onPanResponderMove({ nativeEvent: {} }, move);
  if (release) responder.onPanResponderRelease({ nativeEvent: {} }, release);
};

test('vertical channel fader maps touch to web range, snaps to step and clamps', () => {
  const h = harness(), changes = [];
  let value = 0;
  const view = h.mount(h.ChannelStrip, () => ({ label: 'Bass', display: `${value} dB`, value, min: -12, max: 12, step: .5,
    note: 'dB', onChange: next => { changes.push(next); value = next; } }));
  const fader = find(view.tree, byLabel('Bass'));
  assert.equal(fader.props.accessibilityRole, 'adjustable');
  const thumb = () => fader.props.children[1].props.style[1].top;
  assert.equal(thumb(), 63, 'Centre value sits halfway along the 126pt travel');
  const responder = fader.props.responder;
  assert.equal(responder.onStartShouldSetPanResponder({ nativeEvent: { locationY: 12 } }), false,
    'Touching the track away from the knob lets the page scroll');
  assert.equal(responder.onMoveShouldSetPanResponder({ nativeEvent: {} }, { dx: 0, dy: 40 }), false);
  // Dragging the knob up to the top reaches the maximum, and down past the bottom the minimum.
  drag(fader, { locationY: 75 }, [{ dx: 0, dy: -63 }, { dx: 0, dy: 0 }, { dx: 0, dy: 500 }]);
  assert.deepEqual(changes, [12, 0, -12]);
  changes.length = 0;
  drag(fader, { locationY: 75 }, [{ dx: 0, dy: -10 }]);
  assert.ok(changes.every(next => Number.isInteger(next * 2)), `Values snap to 0.5 dB: ${changes}`);
  view.rerender();
  assert.ok(find(view.tree, byLabel('Bass')).props.children[1].props.style[1].top < 63, 'Thumb moves up for a higher value');
});

test('bypassed faders ignore drags', () => {
  const h = harness(), changes = [];
  const view = h.mount(h.ChannelStrip, () => ({ label: 'Reverb', display: '0%', value: 0, min: 0, max: 100, step: 1,
    disabled: true, note: 'Bypassed', onChange: next => changes.push(next) }));
  const fader = find(view.tree, byLabel('Reverb'));
  assert.equal(fader.props.responder.onStartShouldSetPanResponder({ nativeEvent: { locationY: 138 } }), false);
  fader.props.responder.onPanResponderMove({ nativeEvent: {} }, { dx: 0, dy: -40 });
  assert.deepEqual(changes, []);
});

test('master fader is horizontal 0-100', () => {
  const h = harness(), changes = [];
  const view = h.mount(h.MasterFader, () => ({ value: 80, onChange: next => changes.push(next) }));
  const master = find(view.tree, byLabel('Master volume'));
  master.props.onLayout({ nativeEvent: { layout: { width: 224 } } });
  const responder = find(view.tree, byLabel('Master volume')).props.responder;
  assert.equal(responder.onStartShouldSetPanResponder({ nativeEvent: {} }), false, 'A vertical swipe over the master scrolls the page');
  assert.equal(responder.onMoveShouldSetPanResponder({ nativeEvent: {} }, { dx: 3, dy: 30 }), false);
  drag(find(view.tree, byLabel('Master volume')), { locationX: 12 }, [{ dx: 100, dy: 0 }, { dx: 900, dy: 0 }]);
  assert.deepEqual(changes, [0, 50, 100]);
});

test('S/E arrow markers keep a valid interval and the playhead seeks only on release', () => {
  const h = harness(), sections = [], seeks = [];
  let start = 20, end = 80;
  const view = h.mount(h.Timeline, () => ({ label: 'Vocals', duration: 100, start, end, position: 30,
    onSection: (a, b) => { sections.push([a, b]); start = a; end = b; }, onSeek: time => seeks.push(time), onReset() {} }));
  find(view.tree, props => !!props.onLayout).props.onLayout({ nativeEvent: { layout: { width: 200 } } });
  const startMarker = find(view.tree, byLabel('Vocals start marker'));
  const endMarker = find(view.tree, byLabel('Vocals end marker'));
  assert.equal(startMarker.props.style[1].left, 40 - 22, 'S arrow is centred on 20s');
  assert.equal(find(startMarker, props => props.children === 'S').props.children, 'S');
  drag(startMarker, {}, [{ dx: 20, dy: 0 }]);
  assert.deepEqual(sections.at(-1), [30, 80]);
  drag(startMarker, {}, [{ dx: 400, dy: 0 }]);
  assert.ok(sections.at(-1)[0] < sections.at(-1)[1], 'Start cannot pass the end');
  view.rerender();
  drag(find(view.tree, byLabel('Vocals end marker')), {}, [{ dx: -1000, dy: 0 }]);
  assert.ok(sections.at(-1)[1] > sections.at(-1)[0], 'End cannot pass the start');
  assert.ok(endMarker);

  start = 20; end = 80; view.rerender();
  const timeline = find(view.tree, byLabel('Vocals timeline; drag to scrub all stems'));
  assert.equal(timeline.props.responder.onStartShouldSetPanResponder({ nativeEvent: {} }), false);
  assert.equal(timeline.props.responder.onMoveShouldSetPanResponder({ nativeEvent: {} }, { dx: 2, dy: 25 }), false,
    'Vertical swipes over the timeline scroll the page');
  drag(timeline, { locationX: 100 }, [{ dx: 20, dy: 0 }]);
  assert.deepEqual(seeks, [], 'Scrubbing previews without restarting the audio');
  view.rerender();
  assert.equal(find(view.tree, props => props.children?.[0] === 'Playing ')?.props.children[1], '60.00');
  timeline.props.responder.onPanResponderRelease({ nativeEvent: {} }, { dx: 300, dy: 0 });
  assert.deepEqual(seeks, [80], 'Release seeks once, clamped to the interval');
});
