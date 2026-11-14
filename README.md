# Tiko

A small EMO-style robot pet for GNOME Shell 50 (Wayland). It walks along the bottom of your screens
(above your windows by default, or on the wallpaper behind them), uses your windows and desktop
icons as its playground, reacts to how you treat it, and
nudges you through the workday.

Built 13–14 Nov 2026. Extension id `tiko@manikuttan-mm1`.

> **Changes need a login:** GNOME on Wayland only loads changed code at login. After editing
> `extension.js`, run `gnome-session-quit --logout --no-prompt` and log back in.


## Install

```bash
git clone git@github.com:manikuttan-mm1/tiko.git ~/Github/tiko
ln -s ~/Github/tiko ~/.local/share/gnome-shell/extensions/tiko@manikuttan-mm1
gnome-extensions enable tiko@manikuttan-mm1   # takes effect after you log out and back in (Wayland)
```

Requires GNOME Shell 50 (Wayland). Optional extras it uses when present:
- `meet-join@local`, for meeting links on the meeting card
- `jira-sprint@local`, for Jira alerts and the daily wrap
- `git`, for stand-up notes and uncommitted-work checks

Settings and data still live under the old name, so an existing setup keeps working:
- `~/.config/desk-buddy.json`: settings
- `~/.config/desk-buddy-stats.json`: secret-trick counters
- `~/.config/desk-buddy/sounds/`: your own sounds
- `~/.cache/desk-buddy-*`: markers

---

## Look

- **Head:** square, with a silver rim, a dark shell, a black screen, two glowing cyan square eyes and a
  small camera dot.
- **Headphones:** purple with teal tips. The ear rings glow in meetings and focus.
- **Limbs:** short, chunky legs with purple-striped feet, and small arms with round hands.
- **Speech bubble:** wraps onto up to 4 lines, and it also speaks the text aloud.

## Switching it on, off and quiet

Open the top-right system menu (Quick Settings) and find the **Tiko** tile.

| Control | What it does |
|---|---|
| Click the tile | Turns the buddy on or off (kept across logins) |
| Right-click Tiko | Opens the same menu right next to Tiko (Sounds and voice, Productivity, Play, Settings, Nudges, Secret tricks, and Turn Tiko off). Every entry mirrors the tile menu |
| Arrow → menu | **Sounds and voice** at the top. Below it, collapsible sections (click one to open it): **Productivity**, **Play** (Moonwalk, Walk backwards, Play ball, Follow me, Stop playing, Robot pet, Surprise me), **Settings**, **Nudges**, **Secret tricks**. A status line sits at the bottom |
| Arrow → **Sounds and voice** | Mutes or unmutes all sounds and speech |
| Arrow → **Productivity** | Focus 25 min, Focus 50 min, Stand-up summary now, Check uncommitted work now, Remind me to take a break in 30 min |
| Arrow → **Show above windows** | On (default): it walks on top of your windows and stays visible, fullscreen windows included (video, slides, F11). It sits in the shell's layer just above windows and hides in the Activities overview. Off: it lives on the wallpaper behind them, just above the desktop icons |
| Arrow → **Play** | Play ball, Follow me, Stop playing, **Activity** level (low / normal / high / off; click to cycle), **Surprise me now**, **Rare surprises** switch, **Secret tricks** (click to list) and **Reset secret tricks** |
| Arrow → **Nudges** | Switches for Meeting reminders, Break reminders, Jira alerts and End-of-day check |
| Arrow → status line | What it's doing now, its energy, how many ledges it can see, and the last problem it recovered from |

Turning on **Do Not Disturb** makes it sit still and quiet ("Shh, quiet mode.") until you turn Do Not
Disturb off.

---

## Talking

With **Chatty** on (the default, in the tile menu), it comments on its tricks and reactions in speech
bubbles and its robot voice. With Chatty off, it only speaks up for things you need to know:
- reminders and alerts
- the focus countdown
- the stand-up summary
- unlocks
- game instructions
- answers to your menu choices

Sounds and voice can be muted separately.

## Getting around

It wanders rather than pacing edge to edge:
- It picks a random spot, sometimes close and sometimes far, and walks there at a pace it chooses
  each time.
- Now and then it changes its mind halfway.
- When it arrives it might look around, sit for a moment, turn back, or head off somewhere new.
- Tricks run a little shorter or longer each time, rides head either way, and the gaps between tricks
  vary, so it rarely does the same thing the same way twice.

| Situation | Behaviour |
|---|---|
| Walking | EMO waddle: short straight legs, small flat-footed steps, body rocking, arms swinging |
| Running | Sometimes "Zoom!": faster, bigger steps, leaning forward |
| Window edge up to ~220 px | Climbs it hand over hand |
| Window edge up to ~520 px | Flies up with jets |
| Taller window | Walks on behind it |
| Window you move | Rides along on top of it |
| Window bottom just above its head | Ducks under it |
| Edge of a window | Hops down |
| Desktop folder or file icon | Crouches and tries to jump on. It usually misses at first ("Hup!… nope", "Hmph! One more time…") and always makes it by the third try ("Made it! King of bck!"). Jumping back down uses the landing rules below, by the icon's height |
| Screen edges | Turns around at the outer edges of all your monitors together. It walks from one monitor onto the next, and every monitor's floor and windows count as terrain |

**Rides:** about a third of its tricks are a skateboard ("Skate time!") or bike ("Ring ring!") ride
at 2.6–3× walking speed. It wipes out when it rides into a window edge, and 45% of the time when a
ride ends. The ride flies off and it reacts one of four ways:

| Reaction | Look |
|---|---|
| Cry | Squeezed eyes, streaming tears, rubbing its eyes: "Waaah… my knee!" |
| Shy | Blush, eyes looking away, hands on cheeks: "Hehe… nobody saw that, right?" |
| Laugh | `^ ^` eyes, open mouth, holding its belly: "Hahaha! Again!" |
| Angry | Red eyes, angry brows, steam: "Stupid wheels!" |

**Other tricks**: dance with music notes, wave "Hi!", sit, jump, turn around, watch your pointer,
heart eyes ("I like it here with you."), and everyday things:

| Activity | Look |
|---|---|
| Coffee | Sits and sips from a steaming cup, eyes closed on each sip |
| Book | Sits and reads an open purple book, turning pages |
| Polish | Wipes its own screen with a teal cloth, with a little sparkle |
| Headphones | Holds its ear cups, rings glowing, humming a tune |
| Doze | Nods off for a few seconds, then "Huh? I'm awake!" |

**How often and which tricks:**
- How often depends on the Activity level: low every 20–35 s, normal every 8–16 s, high every 4–8 s,
  off never.
- It never repeats one of its last three tricks, and each trick has its own cooldown.
- Rides are the most likely pick.
- When tired it only picks quiet tricks: coffee, book, doze, sit, wave, look and yawn.

### More tricks

| Kind | Tricks |
|---|---|
| Walking styles | Walks backwards, moonwalks (feet glide, the back heel lifts), ninja mode (black headband, runs and front-flips) |
| Physical | Skateboard kickflips (30% wipe-outs). From a window or icon top: slides down like a playground slide, or hangs upside down from the edge. Handstand walk. Jetpack test that runs out of fuel. Tarzan rope swing |
| Personality | Pointer detective with binoculars, fake sleeping with one eye peeking, cursor thief (lunges at your pointer and misses), selfie with a flash and a peace sign, peekaboo, laugh attack, a smoke break, eating a banana and tossing the peel, a cartoon pistol (aims with both hands, recoil, muzzle flash, "pew", and the bullet streaks across your screens until it's off the edge; one time in four a "BANG!" flag pops out instead) |
| Illusions | Freeze like a statue then spring up, see-through ghost, teleport in a smoke puff to the far corner, clone illusion |
| Interactive | **Click its head** to make it go boing. **Drop it right next to a window's side** and it sticks there (magnet mode), slides down a little, then drops off. Heavy landings crack the ground and shake it. Trampoline bouncing |
| Banana peel | It tosses the peel over its shoulder in a tumbling arc, landing 1–3 body lengths away, and the peel stays for 4 minutes. It walks or rides past it a couple of times without noticing, then slips (or wipes out on its board or bike), lies flat for a moment, and comes round shy: "Hehe… nobody saw that, right?" |
| Refusals | Now and then a quick click gets "Nope. Not staying." with crossed arms, and then it gives in. The tile switch, Do Not Disturb, sleep and mute are always obeyed |

### Even more

| Skill | What it does |
|---|---|
| Music dancer | When any media player is playing (Spotify, YouTube in a browser, and so on, read over MPRIS), it dances much more often, says the song when it changes (with Chatty on), and scrolls the title and artist across its screen while it dances |
| Weather outfit | Checks the weather every 30 min at wttr.in, which works out your area from the connection; nothing personal is sent. Umbrella in the rain, shades on a sunny day, a red scarf below 12 °C. Off with "Dress for the weather" |
| Window cleaner | Sweeps a squeegee up and down the glass in front of you, leaving sparkles |
| Robot pet | A little robo-dog with a wagging tail that tags along for 3 minutes and fetches the ball in a ball game. It comes now and then on its own, or from "Call the robot pet" |
| Screenshot pose | When you open the screenshot tool or a new screenshot lands in Pictures/Screenshots, it strikes a peace-sign pose |
| Rocket | A rare surprise: hammers a rocket together, counts 3, 2, 1, blasts off out of sight, then parachutes back |
| Graffiti | Sprays a small heart or smiley on the wallpaper beside it, which fades away over about a minute |
| Window high-five | Drag a window right up to it and it gives the window a high-five |
| Bubble gum | Chews, blows a growing pink bubble, and it pops all over its face (then it's shy) |
| Paper plane | Folds a plane and throws it; the plane glides and bobs across your screens |
| Sneeze | "Ah… ah… ACHOO!" and it's blown backwards |
| Fishing | Casts into a little puddle and, after a long wait, reels in an old boot |

### Even more fun

| Skill | What it does |
|---|---|
| Juggling | Three coloured balls looping over its head; about one time in three a ball comes down on its head ("Ow, my head!") |
| Guitar solo | When music is playing, it pulls out a little red guitar, strums and head-bangs, and finishes with a jump |
| Bedtime routine | At night (10 PM to 6 AM) the first nap in the corner starts with brushing its teeth, then striped pyjamas and a nightcap with a big stretch, then pulling a pink blanket up to its chin. It sleeps like that until woken |
| Keep the pet | Settings → **Keep the robot pet around** keeps the robo-dog with it all the time instead of 3-minute visits |

### Still more

| Skill | What it does |
|---|---|
| Snowball fight | In snow, or cold winter months: lobs three snowballs at your pointer (they just splat; nothing is hit) |
| Magic show | A top hat, a wand with sparkles, and a white rabbit popping out |
| Kite | On windy days (wind from wttr.in): flies a red and teal diamond kite looping overhead |
| Pet tricks | With the robo-dog around: points, and the dog sits, rolls over and plays dead |
| Fort | Stacks six coloured blocks, hides behind them and peeks, then knocks them over |
| Sleepwalking | At night, now and then it gets up from its nap with its eyes shut and arms out, walks slowly, bonks into windows and turns round, then goes back to bed |
| Bug chase | Creeps after a tiny bug with a net and swipes: half the time it catches it (and lets it go), half the time the bug flies off |
| Hiccups | Hops with every "hic!"; click it to scare them away |
| Wall run | Runs at a nearby window side, up it, and backflips onto the top |
| Birthday | On a day with a "birthday" event in your calendar, it holds up a cake with flickering candles under falling confetti |
| Rain dance | When it's raining, it dances under its own little rain cloud |
| Mirror | Copies your pointer like a mime: moves the way you move, arms up when your pointer is high |
| Dumb things | Trips over nothing (then goes shy), chases a tail it doesn't have until it's dizzy, mimes an invisible wall, pulls a cross-eyed tongue-out face, waves at nobody and gets embarrassed |

**Rare surprises** come about once every 30 to 60 minutes, only while you're around, and never in
meetings, focus or Do Not Disturb. Turn them off with the Rare surprises switch, or trigger one with
Surprise me now.

| Surprise | What happens |
|---|---|
| UFO abduction | A saucer beams it up, then it parachutes back down |
| Rocket | Builds it, counts down from 3, blasts off and parachutes back |
| Clone army | Two copies stand beside it: one copies it, one mirrors it |
| Disco | A disco ball, coloured light beams and spots, and dancing |

**Secret tricks**, unlocked by counts kept locally in `~/.config/desk-buddy-stats.json`:

| Unlock | Reward |
|---|---|
| Spin it 5 times | Dizzy dance trick |
| Finish 10 focus blocks | Focus done becomes a disco |
| Cursor thief 3 times | It hunts your pointer more often |
| Play with it on 7 different days | A party hat |
| 5 clean throw landings | It flips in the air before landing ("Ta-da!") |
| Play ball 3 times | Golden ball |

### Toys
- **Play ball:** a ball appears. It runs after it and kicks it ("Kick!", "Goal!"), and the ball
  bounces off windows and the screen edges. You can pick up and throw the ball yourself ("Fetch!").
  The game lasts about a minute, longer while you keep throwing, and ends early if it gets tired:
  "Good game!"
- **Follow me:** it follows your pointer around for 20 s.
- **Pausing:** games pause during meetings and Do Not Disturb, and stop when focus starts.

**Napping:** after 90 s without interaction it walks to the nearest bottom corner and sleeps (Zzz).
Click it to wake it up.

---

## Playing with it

| You | It |
|---|---|
| **Click** | Stops and stays where it is ("OK, staying here."): it waits with arms crossed, tapping a foot, its eyes following your pointer; after 20 s it sits down looking bored; after a minute it lies down and sleeps right there. It stays parked there even after reminders, meetings, naps or being dropped; only your next click ("Off I go!"), a menu walk or a game sends it off. A click while it sleeps just wakes it (still parked) |
| **Hold the click for 1 s** | Starts or stops a 25-minute focus block |
| **Drag** | You lift it; it dangles and waves |
| **Lift it into the top 40% of the screen** | Gets scared: trembles, tall wide eyes, "Too high! Put me down!!" |
| **Spin it while holding** | Spiral eyes. 1 turn: dizzy. 2 turns: dizzy, then wobbly. 3 or more turns: knocked out (lies flat, X eyes, stars), then "Whoa… what happened?" |
| **Swing and let go** | You throw it: it tumbles through the air, bounces off the sides ("Bonk!") and ceiling ("Ow, ceiling!") |
| **Drop it below the screen** | Stays out of sight ~2.5 s, then hands grab the edge and it hauls itself up with squeezed eyes, gritted teeth and a sweat drop: "Phew! Made it." |
| **Grab a hand or foot and pull** | The limb stretches like rubber, getting thinner and sagging (see below). It works while it's parked too, from crossed arms or sitting. Pull outward, away from its body, to stretch; drag any other way to lift it. It stays parked wherever you put it |

### Stretching a limb

| How far you pull | Face and words |
|---|---|
| Up to ~25 px | Giggle: "Hehe, that tickles!" |
| 25–55 px | Strain, `> <` eyes: "Hey, careful with that!" |
| Past 55 px | **Crying**, growing with the pull: more, faster and bigger tears, a wider wailing mouth, harder sobbing shakes, and louder cries: a sniffle, then a sob, then a loud wail (`cry1`–`cry3`). "Sniff… that hurts." becomes "Waaah! Stop pulling!" becomes "WAAAAAH!! Let go!!" (full at about 170 px). Ease back and it calms down the same way |

When you let go, the limb springs back with a boing. It then reacts to the hardest pull:

| Hardest pull | Reaction |
|---|---|
| Gentle | Laughs: "Hehe, again!" |
| Medium | Angry: "Hey! Let go of me!" |
| Hard | Cries, with a plaster |
| Extreme | Angry, "Never do that again!", limps |

### Landing from a drop or throw

The height counts from where you let go (for a drop) or from the highest point of its flight (for a
throw) down to where it lands.

| Fall (share of screen height) | Landing |
|---|---|
| Over 70% | **Parachute** in purple and teal; sways down, then a wink and smirk: "Nailed it. Hehe." |
| 55–70% | **Arms and legs pop off** with its "ouch" shout (the minion sound), bounce around with sparks, then hop back and snap on with a boop. It sits ("All back together… ouch.") and limps |
| 35–55% | **Hurt**: dizzy, crossed plasters, a tear, limping slowly for 20 s, no tricks |
| 15–35% | **Bump**: "Ouch!" and one plaster |
| Under 15% | Fine |

A fast sideways landing adds up to one step of injury ("Skidded…").

---

## Typing along

When you type, it sits down with a tiny laptop and types along, hands tapping and eyes on its screen.
When you stop, it gets up and carries on.

| While you type | It does |
|---|---|
| Fast | Sparks fly off its keys |
| Very fast for 3 s or more | The keyboard catches fire |
| Over 20 s in a row | **Hacker mode**: dark sunglasses, a green screen and green code raining down around it |
| 10 minutes straight | It takes a coffee break, a hint for you too |

It never reads your keys. It only notices that the session keeps registering input while the mouse
stays put (from GNOME's idle monitor and the pointer position), which can only be the keyboard.
Typing also counts as you being around, so it won't wander off to nap. It doesn't type along during
meetings, focus, games or rides, or while it's busy with something more important.

## Energy

- **Using and restoring:** walking, running, riding, climbing, dancing and jumping use energy; sitting
  and sleeping restore it.

| Energy | Effect |
|---|---|
| Below 40% | Walks slower, droopy eyes, yawns ("*yaaawn*"), sits instead of running or riding, misses more icon jumps; a battery appears above its head |
| Below 12% | Sits down: "So tired… need a rest." |
| Below 5% | Walks off to nap: "Battery empty… nap time." While it sleeps, the battery charges with a lightning bolt |

---

## Workday nudges

It talks like a personal assistant: friendly, full sentences ("Heads up: Sprint planning starts in 5
minutes, at 2:15 PM. The join link is on the card."). Everything stays in its speech bubble; it
sends no desktop notifications.

| Nudge | When | What you see and hear |
|---|---|---|
| Meeting reminder | 5 min before a calendar meeting | Taps its watch, bell sound, "Sprint planning in 5 min" |
| Stand-up helper | Before "Daily Scrum" or any "stand-up" | "For stand-up: mmm ×5, msq-enablement ×3 commits" (since the last working day; Friday on Mondays) |
| Focus block | Hold the click for 1 s, or the tile menu (25 or 50 min) | Sits with glowing headphones, Do Not Disturb on, countdown in its bubble; then dances with the "complete" chime: "Focus done! Take 5." |
| Break reminder | 90 min of activity without 5 idle minutes; or "in 30 min" from the menu | Stretches: "90 min straight. Stretch break?" (at most every 10 min, never during meetings or focus) |
| Jira done | One of your sprint tickets moves to Done | Dances: "M2P-1627 is Done! Nice work." |
| Jira alert | A ticket reassigned away from you | Frowns with red eyes and shows the ticket, with a warning sound (needs the Jira Sprint extension) |
| Morning briefing | Once a day, the first time you're active after 8 AM (or Productivity → Brief me on today) | "Good morning! You have 3 meetings today; the first is Sprint planning at 2:15 PM. 2 sprint tickets are still open. Weather: …" |
| What's next? | Productivity → What's next? | Your next meeting and how soon it is (or "you're in X until…"), open sprint tickets, and whether focus is on |
| Screen-share guard | You share or record your screen (Meet, Zoom, Slack, OBS, the screen recorder) | The buddy, its ball, pet, peel and cards hide and go silent, then come back when the share stops |
| Meeting card | 5 min before a meeting | A small card next to it with the title, the start time and **Join** (the link the meeting item found), or Dismiss. It disappears 2 min after the start |
| Pomodoro | Productivity → Pomodoro | 4 rounds of 25 min focus with 5-min breaks (counted down in its bubble), then a 15-min long break. Stop it from the same menu item, or by stopping focus |
| Daily wrap | 7 PM, or Productivity → Daily wrap now | Today's meetings, commits per repo, Jira tickets done today and uncommitted repos, copied to the clipboard for Slack |
| End of day | 7 PM (or "Check uncommitted work now") | Lists repos and worktrees under `~/msquaredclub/Projects` with uncommitted changes, or "All clean." |
| Meetings and Do Not Disturb | While a meeting runs or Do Not Disturb is on | Sits quietly; a click makes it wave |

---

## Sound and voice

- **Sounds:** a tiny, giggly, high-pitched gibberish voice, like a little gang of excited minions. It's
  two speech-synthesiser voices saying short silly words or sing-song nonsense, mixed slightly
  apart and sped up about 1.8×, saved as `sounds/<event>-voice.wav`. They're original words, not
  clips from any film.

  | Event | Line |
  |---|---|
  | wake | "Heyyy! Haha!" |
  | click | "Hoop!" |
  | fall | "Waaaaaah!" |
  | bump | "Oofa!" |
  | hurt | "Owie owie!" |
  | happy | "Yayyy! Hehehehe!" |
  | reminder | "Ey! Ey! Lookie lookie!" |
  | alert | "Uh ohhh!" |
  | shy | "Hihihi." |
  | pistol | "Pew pew pew!" |
  | focus done | "Tadaaa! Woohoo!" |
  | screenshot | "Cheeeese!" |

  For anything without a voice clip it falls back to Kenney's CC0 recordings (`<event>.ogg`), then
  the generated beeps (`<event>.wav`).
- **Voice:** when it "talks" it says one of ten nonsense phrases in the same tiny voice
  ("pibabo la yeti! hehe", "kola ge?" and so on): always for important messages, and on most everyday
  bubbles.
- **Your own sounds:** files in `~/.config/desk-buddy/sounds/<event>.ogg` or `.wav` replace the
  built-in ones (see `README.txt` there).
  - The current set is cut from five Pixabay clips by freesound_community (Pixabay Content License):
    "minion voice.wav", "Minion1", "Tiny creatures babbling", "08-CaidaMinion" and "07-GritoMinion".
    `SOURCES.txt` there lists which clip each sound came from.
  - Delete that folder's files to go back to the built-in voice.
- **Quiet:** silent under Do Not Disturb, and when the **Sounds and voice** switch is off. No sound
  effects while you touch, drag or stretch it, or for 4 s after you let go, except falling and
  crying: dropping it, throwing it, its parachute, and crying or getting hurt still make their sounds.

## Files

| Path | Purpose |
|---|---|
| `extension.js` | All behaviour and drawing (Cairo) |
| `metadata.json` | Extension metadata (GNOME 50) |
| `sounds/*.wav` | Robot sound effects |
| `~/.cache/desk-buddy-off` | Exists while you've switched it off |
| `~/.cache/desk-buddy-mute` | Exists while sounds and voice are off |
| `~/.cache/desk-buddy-focus-dnd` | Exists while a focus block has Do Not Disturb on; restored at the next login if you logged out mid-focus |
| `~/.config/desk-buddy.json` | Which nudges are on, the activity level, and whether rare surprises are on |
| `~/.config/desk-buddy-stats.json` | Local counters for secret tricks (spins, focus blocks, days played, landings, games). Reset from the menu |
| `~/.cache/meet-join-dnd` | Set by the meeting extension during meetings; the buddy reads it |

## How it fits into GNOME

- **Priorities:** every mode has one. Your hands (holding, throwing, stretching) win, then physics
  (falls and crashes), then injuries, then meetings and focus, then your clicks, then nudges, then
  games, then tricks, then walking. A nudge or trick never interrupts something more important; it
  only speaks instead.
- **Saving work:**
  - Window geometry is re-read every 250 ms, or every frame while it stands on a window, and right
    away when windows, the workspace or the monitors change.
  - It draws at 20 fps while moving, about 7 fps in calm modes (sit, coffee, book, doze, staying,
    meetings, focus) and about 4 fps asleep. Nothing is redrawn while it's hidden (overview, screen
    share, switched off). On 14 Nov 2026 it measured about 14% of one core at 30 fps.
  - Periodic checks run on the clock, not on frame counts.
- **Recovery:** any error during a frame, or an invalid position, puts it back on the ground standing,
  with nothing half-finished. The reason shows in the tile menu's status line, and it's logged at most
  once a minute.
- **Monitors:** every monitor's floor and windows are terrain, and it can cross between monitors.
  When a monitor is added, removed or resized, its cached geometry is dropped and it's put back on
  the ground. Desktop icons are only read on the primary monitor.
- **Tricks along a path** (hanging, sliding, swinging, the UFO, teleporting, magnet mode) always
  finish before a meeting or focus takes over, so it never stops mid-air.

- **The actor:** a small, buddy-sized drawing area in `global.window_group`, just above the wallpaper
  and the desktop-icons windows and below normal windows. It moves every frame (about 30 fps), so it
  never blocks clicks on the rest of the desktop.
- **Stacking:** GNOME's window list leaves out the desktop-icons windows ("Desktop Icons 1/2"), and
  Mutter re-sorts window actors, so it rechecks its stacking place twice a second.
- **Terrain:** the bottom of the work area (clear of the dock), the top edges of the windows on the
  primary monitor, and Desktop icons. Icon positions come from each file's
  `metadata::nautilus-icon-position`. The Home icon has no stored position, so it can't be targeted.
- **Calendar:** read from the shell's own event source, the same one the clock drop-down uses.
- **Jira:** read from the running Jira Sprint extension, without its own network calls.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Change not showing | Log out and back in |
| Clicks don't reach it | Check `journalctl -b \| grep desk-buddy`; it must sit above the "Desktop Icons" windows |
| It lands beside an icon, not on it | The icon positions are logged once per login (`journalctl -b \| grep "desk-buddy: desktop icons"`); compare them with the screen |
| Too noisy | Tile arrow → Sounds and voice off, or turn on Do Not Disturb |
| Misbehaving | Turn the tile off, or `gnome-extensions disable tiko@manikuttan-mm1` |
| Errors | `journalctl -b -o cat \| grep -A5 "JS ERROR"` |

Interactive browser prototype: https://claude.ai/artifact/FN3jWjaDgnE4jAazQF2N6z


## Credits

- **Interface sounds:** Kenney, "Interface Sounds" (CC0), https://kenney.nl. Licence in
  `sounds/Kenney-License.txt`.
- **Other bundled sounds:** generated for this project.
- **Your own sounds:** files you put in `~/.config/desk-buddy/sounds/` are yours and are not part of
  this repo.
