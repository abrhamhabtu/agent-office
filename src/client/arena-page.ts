import { mountArena } from './trading/arena';

// The Arena on a page of its own: /arena. The same console the office opens, with nothing of the office
// around it, so it can be watched on a second screen or lifted out into its own app. It needs the office's
// sign-in: a visitor who isn't signed in is sent to the door first.
void fetch('/api/trading/arena', { credentials: 'same-origin' }).then((res) => {
  if (res.status === 401 || res.status === 403) return location.replace(`/login?next=${encodeURIComponent('/arena')}`);
  mountArena(document.getElementById('arena')!, { league: new URLSearchParams(location.search).get('league') === 'crypto' ? 'crypto' : undefined });
});
