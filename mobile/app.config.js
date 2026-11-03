// Engine trial builds (EXPO_PUBLIC_ENGINE_TRIAL=1) embed the test audio from
// src/engine-trial/push-test-audio.sh, so an iPhone can read it from the app bundle.
// Other builds use app.json unchanged.
module.exports = ({ config }) => {
  if (process.env.EXPO_PUBLIC_ENGINE_TRIAL !== '1') return config;
  return {
    ...config,
    plugins: config.plugins.map(plugin =>
      plugin === 'expo-asset' ? ['expo-asset', { assets: ['./engine-trial-audio'] }] : plugin),
  };
};
