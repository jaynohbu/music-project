// Test builds embed the engine trial's audio; normal builds use app.json unchanged.
module.exports = ({ config }) => {
  if (process.env.EXPO_PUBLIC_ENGINE_TRIAL !== '1' && process.env.EXPO_PUBLIC_MIXER_DIAGNOSTIC !== '1') return config;
  return {
    ...config,
    plugins: config.plugins.map(plugin =>
      plugin === 'expo-asset' ? ['expo-asset', { assets: ['./engine-trial-audio'] }] : plugin),
  };
};
