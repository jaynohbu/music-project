import { useEffect } from 'react';
import { AppState } from 'react-native';
import { reportActivity } from './api';
import { Mixer } from './player';

// Time a user spends in the app and playing songs, counted every few seconds while the app is in front
// and sent about once a minute; the master admin sees it per day (backend/admin-api.mjs).
const TICK_SECONDS = 15;
const SEND_SECONDS = 60;

export function useActivity(signedIn: boolean) {
  useEffect(() => {
    if (!signedIn) return;
    let open = 0, play = 0;
    const send = () => {
      if (!open) return;
      const report = [Math.min(open, 120), Math.min(play, 120)] as const;
      open = 0; play = 0;
      reportActivity(...report).catch(() => {});
    };
    const timer = setInterval(() => {
      if (AppState.currentState !== 'active') return;
      open += TICK_SECONDS;
      if (Mixer.anyPlaying) play += TICK_SECONDS;
      if (open >= SEND_SECONDS) send();
    }, TICK_SECONDS * 1000);
    const subscription = AppState.addEventListener('change', next => { if (next !== 'active') send(); });
    return () => { clearInterval(timer); subscription.remove(); send(); };
  }, [signedIn]);
}
