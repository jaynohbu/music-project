// Diagnostic and engine-trial profiles bypass sign-in with bundled test audio.
// Normal builds load the app in src/app.
if (process.env.EXPO_PUBLIC_MIXER_DIAGNOSTIC === '1') {
  const { registerRootComponent } = require('expo');
  registerRootComponent(require('./src/engine-trial/MixerDiagnostic').default);
} else if (process.env.EXPO_PUBLIC_ENGINE_TRIAL === '1') {
  const { registerRootComponent } = require('expo');
  registerRootComponent(require('./src/engine-trial/EngineTrial').default);
} else {
  require('expo-router/entry');
}
