// Turn a spoken or typed sentence ("volume 20", "open netflix", "switch to HDMI 2")
// into an intent object. Pure function: no TV access, easy to test.

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, half: 0.5,
};

// "set volume to twenty" -> "set volume to 20". Only replaces a number word that
// follows something numeric-ish, so "go to netflix" keeps its "to".
function wordsToDigits(s) {
  return s.replace(/\b(volume|channel|by|to|in|after|for|hdmi|down|up|left|right) (zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/g,
    (_, w, n) => `${w} ${NUMBER_WORDS[n]}`);
}

export function normalize(text) {
  let s = String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[“”"'’.,!?]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(hey |ok |okay )?(tv |lg )?/, '').replace(/^(please |can you |could you )+/, '').replace(/( please| now)$/, '').trim();
  return wordsToDigits(s);
}

const n = (v, d = 1) => (v == null || v === '' ? d : Number(v));

export function parseCommand(text) {
  const s = normalize(text);
  if (!s) return null;
  let m;

  // Volume
  if ((m = s.match(/^(?:set |change |put |turn )?(?:the )?volume (?:to |at )?(\d{1,3})(?: percent)?$/))) return { type: 'volume', value: Number(m[1]) };
  if ((m = s.match(/^(?:turn (?:the )?volume up|volume up|louder|increase (?:the )?volume|turn it up)(?: by (\d+))?$/))) return { type: 'volumeStep', dir: 'up', n: n(m[1]) };
  if ((m = s.match(/^(?:turn (?:the )?volume down|volume down|quieter|softer|lower (?:the )?volume|decrease (?:the )?volume|turn it down)(?: by (\d+))?$/))) return { type: 'volumeStep', dir: 'down', n: n(m[1]) };
  if (/^(unmute|sound on|turn (?:the )?sound on)$/.test(s)) return { type: 'mute', on: false };
  if (/^(mute|silence|sound off|turn (?:the )?sound off)$/.test(s)) return { type: 'mute', on: true };

  // Sleep timer (before power off, so "turn off in 30 minutes" lands here)
  if (/^(cancel|stop|turn off) (?:the )?sleep(?: timer)?$/.test(s)) return { type: 'sleep', minutes: 0 };
  if ((m = s.match(/^(?:sleep|sleep timer|(?:turn|switch) (?:the )?(?:tv )?off|power off)(?: timer)? (?:in |after |for )?(\d+(?:\.\d+)?|0\.5) ?(m|min|mins|minutes?|h|hr|hrs|hours?)$/))) {
    const minutes = /^h/.test(m[2]) ? Number(m[1]) * 60 : Number(m[1]);
    return { type: 'sleep', minutes };
  }

  // Power / screen
  if (/^(?:turn |switch )?(?:the )?screen off$|^turn off (?:the )?screen$/.test(s)) return { type: 'screen', on: false };
  if (/^(?:turn |switch )?(?:the )?screen on$|^turn on (?:the )?screen$/.test(s)) return { type: 'screen', on: true };
  if (/^((turn|switch) (the )?(tv )?off|(turn|switch) off( the)?( tv)?|power off|shut ?down|off|good ?night)$/.test(s)) return { type: 'power', on: false };
  if (/^((turn|switch) (the )?(tv )?on|(turn|switch) on( the)?( tv)?|power on|wake( up)?|on)$/.test(s)) return { type: 'power', on: true };

  // Media
  if (/^(pause|hold on|wait)$/.test(s)) return { type: 'media', action: 'pause' };
  if (/^(play|resume|continue|unpause)$/.test(s)) return { type: 'media', action: 'play' };
  if (/^stop$/.test(s)) return { type: 'media', action: 'stop' };
  if (/^(rewind|go back 10 seconds)$/.test(s)) return { type: 'media', action: 'rewind' };
  if (/^(fast ?forward|forward|skip)$/.test(s)) return { type: 'media', action: 'forward' };

  // Channels
  if (/^(channel up|next channel)$/.test(s)) return { type: 'channel', dir: 'up' };
  if (/^(channel down|previous channel|last channel)$/.test(s)) return { type: 'channel', dir: 'down' };
  if ((m = s.match(/^(?:go to |switch to |change to |put on )?channel (\d{1,4})$/))) return { type: 'channelNumber', number: m[1] };

  // Navigation keys
  if (/^(go )?home$/.test(s)) return { type: 'button', name: 'HOME', n: 1 };
  if (/^(go )?back$/.test(s)) return { type: 'button', name: 'BACK', n: 1 };
  if (/^exit$/.test(s)) return { type: 'button', name: 'EXIT', n: 1 };
  if (/^(ok|okay|select|enter|click)$/.test(s)) return { type: 'button', name: 'ENTER', n: 1 };
  if (/^(settings|menu)$/.test(s)) return { type: 'button', name: 'MENU', n: 1 };
  if ((m = s.match(/^(?:go |move )?(up|down|left|right)(?: (\d{1,2}))?(?: times?)?$/))) return { type: 'button', name: m[1].toUpperCase(), n: n(m[2]) };

  // Typing
  if ((m = s.match(/^(?:type|write|enter text) (.+)$/))) return { type: 'type', text: m[1] };

  // Inputs
  if ((m = s.match(/^(?:switch to |change to |go to |input |source |open )?(hdmi|av|component|usb) ?(\d)?$/))) return { type: 'input', query: m[1] + (m[2] || '') };
  if (/^(?:switch to |go to |open |watch )?(live tv|tv channels|antenna|cable)$/.test(s)) return { type: 'launch', query: 'live tv' };

  // Apps
  if ((m = s.match(/^(?:open|launch|start|run|play|go to|show|watch|switch to|put on) (.+?)(?: app)?$/))) return { type: 'launchOrInput', query: m[1] };

  // Anything else: maybe it's just an app or input name ("netflix", "hdmi 2")
  return { type: 'launchOrInput', query: s.replace(/ app$/, ''), guess: true };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Exact, then prefix, then substring match over a few fields.
export function pick(list, query, fields) {
  const q = norm(query);
  if (!q) return null;
  return list.find((x) => fields.some((f) => norm(x[f]) === q))
    || list.find((x) => fields.some((f) => norm(x[f]).startsWith(q)))
    || list.find((x) => fields.some((f) => norm(x[f]).includes(q)))
    || null;
}
