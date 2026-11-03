import { registerRootComponent } from 'expo';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(
  process.env.EXPO_PUBLIC_ENGINE_TRIAL === '1'
    ? require('./src/engine-trial/EngineTrial').default
    : require('./App').default,
);
