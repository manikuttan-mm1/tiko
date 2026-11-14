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
| Right-click Tiko | Opens the same menu right next to Tiko (Sounds and voice, Productivity, Play, Settings and Turn Tiko off). Every entry mirrors the tile menu. |
| Arrow → menu | **Sounds and voice** at the top. Below it, collapsible sections (click one to open it): **Productivity**, **Play** (Moonwalk, Magic show, I'm watching you, Coffee run, Play ball, Follow me, Stop playing, Robot pet, Hide and seek, Surprise me now), **Settings** (which also holds the Activity level and the Nudges switches). A status line sits at the bottom |
| Arrow → **Sounds and voice** | Mutes or unmutes all sounds and speech |
| Arrow → **Productivity** | Focus 25 min (shows the minutes left and stops it while one runs), Timer 10 min (or scroll over Tiko; reads "Stop timer (N min left)" while one runs), Stand-up summary now (opens the stand-up card; see Meeting card), Daily wrap now (copies it), Check uncommitted work now, Remind me to take a break in 30 min (once set it reads "Cancel break reminder (in N min)"; click again to cancel) |
| Arrow → **Show above windows** | On (default): it walks on top of your windows and stays visible, fullscreen windows included (video, slides, F11). It sits in the shell's layer just above windows and hides in the Activities overview. Off: it lives on the wallpaper behind them, just above the desktop icons |
| Arrow → **Play** | Moonwalk, Magic show, I'm watching you, Coffee run, Play ball, Follow me, Stop playing, Call the robot pet (reads "Send the robot pet home" while it is out; hidden when Keep the robot pet around is on), Hide and seek, and **Surprise me now**. Tricks from the menu only start when Tiko is free (not held, in a meeting, falling or fleeing) |
| Arrow → **Settings** | Show above windows, Hide while screen sharing, Chatty (talks about everything), Dress for the weather (wttr.in), Keep the robot pet around. Then an **Activity** heading: pick one level, Lazy, Low, Normal, High or Off (no tricks), with a dot on the current one. Then a **Nudges** heading: switches for Meeting reminders, Break reminders, Jira alerts and End-of-day check. The right-click menu on Tiko shows the same |
| Arrow → status line | What it's doing now, its energy, how many ledges it can see, and the last problem it recovered from |

Turning on **Do Not Disturb** makes it sit still and quiet ("Shh, quiet mode.") until you turn Do Not
Disturb off.

---

## Talking

With **Chatty** on (the default, in the tile menu), it comments on its tricks and reactions in speech
bubbles and its robot voice. With Chatty off, it only speaks up for things you need to know:
- reminders and alerts
- the focus countdown
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
  off never. **Lazy** keeps it in lazy mode (below) all the time.
- **Mood walk and ring light:** how it walks and the colour of its headphone rings show its mood.
  Lazy drags its feet and slouches (amber rings, slow pulse); Low takes small careful steps, head a
  little down, rocking gently (blue); Normal has a brisk springy step with a nod (teal); High hops
  along (bright cyan, quick pulse); Off still roams with the lazy walk, rings dark. Being tired
  (energy under 40) or badly hurt gives it the lazy walk whatever the level; a light bump or energy
  under 60 gives it the Low walk. Meetings, focus and headphones keep their own ring glow.
- **Lazy when you leave it alone:** a minute after you last played with it (clicked it, dragged it,
  or used its menu; typing does not count), it mostly lounges: only calm things (sitting, dozing, coffee,
  a book, headphones, fishing, a yawn), at least 40 seconds apart whatever the Activity level and nearly
  twice as long; most of the time it just sits or naps where it is (8–25 s at a go), and when it does
  move it is a short slow stroll. The status line at the bottom of the menu says "(lazy)" while it is. About one pick in sixteen is still a real
  trick. Any click or menu use wakes it up again.
- **Lazy things it does then:** strings up a hammock between two posts and sways in it; lies belly-up
  with a bubble going in and out; lies with its hands behind its head watching little clouds drift by
  ("That one looks like a sheep."); dozes off holding a cookie with crumbs on its face; a huge
  slow-motion yawn and stretch, then flops straight over onto its back; lies flicking a remote while
  its screen-face shows the channels (sky, colour bars, a bouncing ball: "Nothing good on."); sunbathes
  on a striped towel in shades, more often on sunny days ("Working on my tan. 😎"); and sits
  daydreaming with a thought bubble of a pizza, a beach or a charging battery. Too lazy to walk, it
  often rolls over and over along the floor to get where it is going. Bring your pointer close while
  it sits or dozes and it lifts one hand without getting up ("Hey."). More of the same: naps on a little
  pillow; wraps itself in a blanket burrito with only its eyes showing (they follow your pointer);
  dozes off fishing while the bobber twitches with a bite it sleeps through; leans on a fence post,
  chin in hand, staring into space; plugs itself into a socket and naps while a battery bar fills
  (it really recharges, and does this more when its energy is low); reads until the book slowly
  slides onto its face; lies blowing soap bubbles that float up and pop; snores with growing Zzz and
  a little whistle; and on very hot days (30°C or more) floats on an inflatable ring in a puddle pool.
  Poke it while it lounges and it often lifts one finger, "Five more minutes…", and rolls away from
  your pointer.
  When you have been away from the computer five minutes while it lounges, its face turns into a
  screensaver, a small "TIKO" drifting and bouncing around its screen, until you come back ("Oh!
  You're back."). Also: on a window ledge it drapes over the top with its arms dangling down the
  front; on the floor it pulls the bottom edge of the screen over itself like a blanket; it takes a
  few steps at quarter speed and gives up ("Too much effort."); a drone delivers a pizza and it eats
  it lying down; with music playing it lies there wiggling its feet to the beat; it watches a slow
  coffee drip fill a cup ("Finally."); it counts sheep hopping over a fence until it nods off; it
  rocks in a rocking chair with a cup of tea; and with the robot pet out, the two nap side by side.
- It never repeats one of its last three tricks, and each trick has its own cooldown.
- Rides are the most likely pick.
- When tired it only picks quiet tricks: coffee, book, doze, sit, wave, look and yawn.

### More tricks

| Kind | Tricks |
|---|---|
| Walking styles | Walks backwards (steps run in reverse so the planted foot pushes it back; short, high, careful steps, arms out for balance, a lean away from where it is going, a glance over its shoulder every couple of seconds, and its headphone rings blink amber like a reversing light), moonwalks (feet glide, the back heel lifts), ninja mode (black headband, runs and front-flips) |
| Physical | Skateboard kickflips (30% wipe-outs). From a window or icon top: slides down like a playground slide, or hangs upside down from the edge. Handstand walk. Jetpack test that runs out of fuel. Tarzan rope swing |
| Personality | Pointer detective with binoculars, fake sleeping with one eye peeking, cursor thief ("Your pointer is mine!": chases your pointer for up to 15 s, then leaps up to it and says "Got it!"; if the pointer is higher than a third of the screen it tops out with "Too high! …nope."), selfie with a flash and a peace sign, peekaboo, laugh attack, a smoke break, eating a banana (first a squeaky "BA-NA-NAAA! 🍌" in its own voice, a sound synthesised for Tiko in `sounds/banana.wav`, no film audio; whole at first, then peeled with the flaps hanging down as the fruit gets shorter) and tossing the peel, a cartoon pistol (aims with both hands, recoil, muzzle flash, "pew", and the bullet streaks across your screens until it's off the edge; one time in four a "BANG!" flag pops out instead) |
| Illusions | Freeze like a statue then spring up, see-through ghost, teleport in a smoke puff to the far corner, clone illusion |
| Interactive | **Click its head** to make it go boing. **Drop it right next to a window's side** and it sticks there (magnet mode), slides down the side faster and faster, and a short drop above the ground (or at the window's bottom corner) leaves the wall with one of 15 exits picked at random: backflip, double backflip, wall run, dive roll, corkscrew, superhero landing, tic-tac, lazy drop, cannonball or a "Ta-da!" landing, or, one time in four, one that goes wrong: a faceplant, a butt landing, slipping off, the magnet yanking it back onto the wall (*CLANG*, then a second try), or landing on its head ("I meant that."). None of them counts as a fall, so it never gets hurt. Heavy landings crack the ground and shake it. Trampoline bouncing |
| Banana peel | It tosses the peel over its shoulder in a tumbling arc, landing 1–3 body lengths away, and the peel stays for 4 minutes. It walks or rides past it a couple of times without noticing, then slips (or wipes out on its board or bike), lies flat for a moment, and comes round shy: "Hehe… nobody saw that, right?" |
| Refusals | Now and then a quick click gets "Nope. Not staying." with crossed arms, and then it gives in. The tile switch, Do Not Disturb, sleep and mute are always obeyed |

### Even more

| Skill | What it does |
|---|---|
| Music dancer | When a music player is playing (Spotify, Rhythmbox, Lollypop and similar, or music in a browser such as Spotify or YouTube Music on the web, read over MPRIS), it dances much more often, says the song when it changes (with Chatty on), and scrolls the title and artist across its screen while it dances |
| Movie night | When a video plays in any other player (YouTube or Netflix in a browser, VLC, mpv, Videos), a sofa slides in, it flops onto it with a striped popcorn bucket and munches while it watches, eyes on the video's window, even on another monitor (it finds the window by the video's title or the player's app; with no match it looks at the middle of its own monitor). The popcorn heap sinks as it eats and gets refilled when empty. Drag it while it is on the sofa and the sofa comes along; let go and it stays exactly there, anywhere on the screen, and goes on watching. Its beer stands capped on the armrest. The first time it reaches for it, it twists the cap off ("*pssht* Cheers!", the cap flies, it fizzes); each sip after that lowers the beer, sometimes with a burp ("…excuse me."), and an empty bottle is swapped for a fresh one. Now and then it also laughs or gasps, silently, so it never talks over the video. The title sets the mood: comedy, fails or pranks make it laugh more; horror or creepy ones make it cover its eyes and tremble ("I can't look!"); sad ones make it sniffle. While it watches, it also follows the loudness of what your speakers play (through `pw-record`, 8 kHz mono, only the volume of each tenth of a second is kept, nothing is stored or listened to): a sudden loud moment startles it, and two quiet minutes make it drowsy and slow on the popcorn. Without PipeWire it skips the sound cues. Typing while the video plays no longer pulls it off the sofa; keep typing for a few seconds and it holds a finger to its mouth: "Shhh! Movie on." (at most every 90 seconds). Pause and it freezes mid-kernel: "Hey, I was watching that!" After 90 minutes it dozes off with the bucket tipped over; it wakes after about 10 minutes, or at a loud moment ("Huh? What did I miss?"), and can doze again 45 minutes later. If it was set down in mid-air, it drops to the ground once the video ends. When the video stops it brushes off the crumbs and the sofa slides away; a pause longer than 4 minutes counts as stopped. Poke it, or a reminder pulls it off the sofa, and it waits 20 seconds before sitting back down. If a fullscreen video covers its monitor, it moves to another monitor, or hides until fullscreen ends when there is no other. It reads the player's play state and title, plus a few single pixels of the video window for scene reactions (see below). In a browser it tells them apart by the album: music sites like Spotify or YouTube Music send one (so it dances instead), videos do not |
| Long watching | A long viewing session builds up, all silent apart from speech bubbles. Every new episode (the tab title changes) chalks a tally mark on the sofa ("Next episode!", from the third "One more? …okay, one more."). Empty beer bottles and popcorn tubs pile up on the floor beside the sofa. At 20 minutes, then every 25, a big stretch. At 30 minutes a plaid blanket goes over its lap (pulled up to its chin when it dozes or a scene is spooky). At 45 minutes a bathroom break: it hops off, walks out of sight with the popcorn left on the seat, and comes back: "Did I miss anything?" From 60 minutes it gets tired: slower munching, half-closed eyes, a yawn every few minutes, and a cushion is added to its pillow fort every 30 minutes (up to six). At 75 minutes it rubs its eyes and puts on round glasses. At 2 hours a pizza box slides in along the floor and replaces the popcorn. At 3 hours a Couch Potato medal. From 30 minutes, every 6 to 11 minutes, one of: digging in the cushions (finds a coin, a sock or the remote), a leg cramp ("Ow, pins and needles!"), or scrolling a tiny phone with glances back at the video (also during quiet stretches). After midnight it makes one fridge run and comes back with milk and a cookie. If a session that began at night is still going after 5 am, the sun rises behind the sofa: "…it's morning." When a session longer than 30 minutes ends, it stretches and picks up the empties before the sofa slides away. Everything resets with the next session |
| Scene reactions | While it watches, it reads 8 single pixels of the video window about once a second (GNOME Shell's colour picker, `Shell.Screenshot.pick_color`; points under Tiko are skipped). Only brightness, main colour and how much the picture changed are kept; no image is saved and nothing leaves the machine. With the sound level it guesses the scene and reacts, at most every 20 seconds, and only when a guess holds for a few samples: a long dark scene, it hugs the blanket ("Brr, spooky."); a sudden bright flash, it shades its eyes ("Too bright!"); fast cuts with loud sound, fists up on the edge of its seat ("Go go go!"); lots of red with loud sound, it tenses ("Ooh!"); the sound swelling over a still picture, a hand on its heart ("Aww."); calm blue or green, hands behind its head ("*sigh* Pretty."); 20 seconds of still and quiet, it peers into the bucket ("Is anything happening?"); and after 20 minutes, a mostly black screen with text moving, it claps for the credits, once per episode. It cannot tell what actually happens in a scene, and a window covering the video gives wrong guesses |
| Weather outfit | Checks the weather every 30 min at wttr.in, which works out your area from the connection; nothing personal is sent. To pin a place, set `"weatherCity": "Kochi"` in `~/.config/desk-buddy.json` (only the city name is sent; the menu item then reads "Dress for the weather (Kochi)"). Rain or snow only counts when it is falling there: "Patchy rain nearby" or "possible" does not bring out the umbrella. Umbrella in the rain, shades on a sunny day, a red scarf below 12 °C. Off with "Dress for the weather" |
| Window cleaner | Sweeps a squeegee up and down the glass in front of you, leaving sparkles |
| Robot pet | A little robo-dog with a wagging tail that tags along for 3 minutes and fetches the ball in a ball game. It comes now and then on its own, or from "Call the robot pet" |
| Screenshot pose | When you open the screenshot tool or a new screenshot lands in Pictures/Screenshots, it strikes a peace-sign pose |
| Rocket | A rare surprise: hammers a rocket together, counts 3, 2, 1, blasts off out of sight, then parachutes back |
| Graffiti | Sprays a small heart or smiley on the wallpaper beside it, which fades away over about a minute |
| Window high-five | Drag a window right up to it and it gives the window a high-five |
| Bubble gum | Chews, blows a growing pink bubble, and it bursts all over its face with a pop (its own synthesised sound, `sounds/pop.wav`; then it's shy) |
| Paper plane | Folds a plane and throws it; the plane glides and bobs across your screens |
| Sneeze | "Ah… ah… ACHOO!" and it's blown backwards |
| Fishing | Casts into a little puddle, or from a window ledge drops the line over the edge (it fishes more often up there), and after a long wait reels in an old boot ("…a boot."), a wriggling fish ("A fish! 🐟") or, rarely, a spinning star ("A star?! ⭐") |

### Even more fun

| Skill | What it does |
|---|---|
| Juggling | A real three-ball cascade: one throw per beat, alternating hands, each ball arcing over its head from one hand to the other and caught, so the balls trace a figure 8; about one time in three it ends in a miss: it catches two balls, the third goes up too high and lands on its head with a thud and little stars ("Ow, my head!" right as it hits), bounces off to the floor, and it rubs its head |
| Guitar solo | When music is playing, it pulls out a little red guitar, strums and head-bangs, and finishes with a jump |
| Bedtime routine | At night (10 PM to 6 AM) the first nap in the corner starts with brushing its teeth, then striped pyjamas and a nightcap with a big stretch, then pulling a pink blanket up to its chin. It sleeps like that until woken |
| Keep the pet | Settings → **Keep the robot pet around** keeps the robo-dog with it all the time instead of 3-minute visits |

### Still more

| Skill | What it does |
|---|---|
| Snowball fight | In snow, or cold winter months: lobs three snowballs at your pointer (they just splat; nothing is hit) |
| Birthday party | When a calendar event today mentions "birthday": party hat, cake with candles and confetti, then it sings Happy Birthday line by line with the name from the event ("Asha's birthday" or "Birthday: Asha"; otherwise "friend") and blows out the candles. Repeats now and then that day |
| Rain | When the weather says rain it carries its umbrella, and now and then hops in a puddle with splashes ("Puddle!"). Drag it out from under the umbrella and the rain hits it; set down, it is soaked for 15 seconds: wet sheen, dripping, shivering, "Brrr! You got me soaked!" |
| Coffee run | Once on a weekday between 3 and 3:30 PM while you are at your desk, or from Play → Coffee run: "Coffee run!", it walks off the nearer screen edge, is gone a couple of seconds, comes back carrying a steaming mug, stops and sips ("Ahh. Coffee."), then sits down with it. On a window top it just has its coffee there |
| Lunch | Once a day between 1 and 1:30 PM, when it is free: sits at an open lunchbox with an apple and eats a sandwich bite by bite ("Lunch time! 🥪"), then dozes off: "Food coma… zzz" |
| Dance-off | Click it three times quickly. It crosses its arms: "Dance-off! Your turn: wiggle the mouse!" For 4.5 s it records your pointer moves, then dances them back (its body follows your recorded path, arms faster when you moved faster) and calls the winner. Barely moving loses |
| Pointer chase | Wiggle the mouse fast back and forth and it spots it ("Ooh! Something wiggly!"), runs after the pointer and leaps at it, the cursor-thief jump. At most every 90 seconds, never during movie night or focus |
| Pet fetch | During Play ball with the robot pet around, the pet picks the ball up in its mouth, trots it back and drops it at Tiko's feet; Tiko pats it: "Good boy!" Grab the ball and the pet lets go |
| Morning stretch | The first time you are active each day (after 5 AM): a big yawn with its arms up wide ("*yaaawn* Morning stretch!"), then jumping jacks ("One, two! One, two!"). Remembered in `~/.cache/desk-buddy-stretch`, so logging in again the same day does not repeat it |
| Friday | On Friday after 4 PM, once, and now and then after that: shades on and a weekend dance, "Weekend! 😎" |
| Slow-motion mime | White mime gloves; its hands copy your pointer's moves a beat late and in slow motion while it drifts after the pointer ("Mime time… 🤫") |
| Hide and seek | "Hide and seek! Count to ten…", then it is somewhere along the floor crouched behind a leafy bush, peeking out and ducking. Click it: "Found me! 🎉". Not found within a minute: "You didn't find me! Hehe." Also from Play → Hide and seek |
| Night owl | Still at the computer after 11 PM: every 20 minutes it holds up a "Go to bed!" sign, yawning ("Go to bed! 😴") |
| I'm watching you | A little scene, about 9 seconds. On the floor it first walks briskly off its nearer screen edge, then marches back in from that edge (a thud and a small shake on every step) and stops dead with its hands on its hips, glaring out at you (hot orange slanted eyes, heavy brows, a frown). Then, twice: a V of two fingers (a white cartoon glove) up at its eyes ("I'm watching…"), and a 🫵 (the pointing-at-you emoji) jabbed out beside its face, growing as it comes at you ("…YOU. 👉"). After that it backs out the way it came, still facing you, stepping backwards and flicking two fingers to its eyes now and then, peeks back in from the edge, hands on hips, for one more glare and a last two-finger flick to its eyes, and strolls back as if nothing happened. On a window top it does the scene where it stands. Now and then on its own, from Play → I'm watching you, and a few seconds after you hurt it badly ("Never do that again!") |
| Magic show | A top hat, a wand with sparkles, and something pops out, with a reaction to match: a **rabbit** (pleased), a **snake** ("SNAKE?!"; the snake tumbles out of the hat onto the floor and slithers off the other way across the screen, while Tiko runs off flat out with arms flailing, sweat flying and the odd scream, and sits down a few seconds later: "Phew… escaped!"), a **dove** (flies off, it waves: "Fly free!"), **flowers** (heart eyes: "Aww, for me?"), a **bomb** ("Uh oh…", BOOM, knocked out), an **empty hat** ("Huh? Empty?", a puff of smoke, "Tough crowd.") or **confetti** (it dances) |
| Kite | On windy days (wind from wttr.in): flies a red and teal diamond kite looping overhead |
| Pet tricks | With the robo-dog around: points, and the dog sits, rolls over and plays dead |
| Fort | Stacks six coloured blocks, hides behind them and peeks, then knocks them over |
| Sleepwalking | At night, now and then it gets up from its nap with its eyes shut and arms out, walks slowly, bonks into windows and turns round, then goes back to bed |
| Bug chase | Creeps after a tiny bug with a net and swipes with a thud and "Swoosh!": half the time it catches it (and lets it go), half the time the bug flies off and it grumbles "It got away!" |
| Hiccups | Hops with every "hic!"; click it to scare them away |
| Wall run | Runs at a nearby window side, up it, and backflips onto the top |
| Birthday | On a day with a "birthday" event in your calendar, it holds up a cake with flickering candles under falling confetti |
| Rain dance | When it's raining, it dances under its own little rain cloud |
| Mirror | Copies your pointer like a mime: moves the way you move, arms up when your pointer is high |
| Dumb things | Trips over nothing (then goes shy), chases a tail it doesn't have until it's dizzy, mimes an invisible wall, pulls a cross-eyed tongue-out face, waves at nobody and gets embarrassed |

**Rare surprises** come about once every 30 to 60 minutes, only while you're around, and never in
meetings, focus or Do Not Disturb. They are always on; trigger one any time with
Surprise me now.

| Surprise | What happens |
|---|---|
| UFO abduction | A saucer beams it up, then it parachutes back down |
| Rocket | Builds it, counts down from 3, blasts off and parachutes back |
| Clone army | Two copies stand beside it: one copies it, one mirrors it |
| Disco | A disco ball, coloured light beams and spots, and dancing |

**Secret tricks**, unlocked by counts kept locally in `~/.config/desk-buddy-stats.json` (there is no menu for them; they just start happening once unlocked):

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
| **Lift it up high** | The higher you lift it, the more scared it gets. From a third of the way up: "Eek, going up…", trembling, wide eyes with pinpoint pupils, legs kicking. Higher still it sweats, then cries with tears, and the crying gets louder and longer in three steps ("Uh oh… too high…", "Waaah! Put me down!", "HEEELP! TOO HIGH!"). Not while you carry it on the movie sofa |
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
| Over 70% | **Parachute**: the canopy unfurls from a bundle and already slows the fall, then pops open (a purple and teal dome with a vent and a scalloped hem, lines to its hands) and eases it down to a gentle glide over about a second. It swings under the canopy like a pendulum and drifts with it. The wind carries it: from wttr.in's wind (8 km/h or more) it drifts steadily the way the wind blows (about 6 px/s per km/h, up to 180), the canopy tilted into it ("Wheee, a breeze!"), and in a strong wind (15 km/h or more) gusts lift it back up so it can sail right across the screen ("Whoa, the wind!") and land somewhere else entirely; the screen edge stops it. It steers: when your pointer is below it, it pulls one toggle and banks the canopy to glide toward the pointer ("Steering to you!"), so you can guide it down. Near the ground it flares, both toggles down, which slows the last stretch and steadies the swing. On touchdown its knees bend, a puff of dust rolls out with a soft thud, the canopy sinks and drapes down behind it, then a wink and smirk: "Nailed it. Hehe." |
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
minutes, at 2:15 PM. The join link is on the card."). Everything stays in its speech bubble; the
only desktop notification it sends is the timer's "time's up".

| Nudge | When | What you see and hear |
|---|---|---|
| Meeting reminder | 5 min before a calendar meeting (10 min before a standup, see Meeting card) | Taps its watch, bell sound, "Sprint planning in 5 min" |
| Stand-up helper | On the stand-up card (see Meeting card) | A **Commits since yesterday** row (Friday on Mondays) with one chip per repo, e.g. "mmm ×5", busiest first, up to 3 on the heading line; all of them go into Copy update |
| Focus block | Hold the click for 1 s, or the tile menu (Focus 25 min) | Sits with glowing headphones, Do Not Disturb on, countdown in its bubble; then dances with the "complete" chime: "Focus done! Take 5." |
| Timer | Scroll the mouse wheel over Tiko's body: each notch up goes 1, 2, 3, 4, 5, then 10, 15, 20… min, and down goes back the same way (up to 3 h; a "⏱ N min" bubble shows the total). It starts 2 s after the last notch. Or Productivity → Timer 10 min | Tiko sets up a build site beside it, with a pile of pieces on its other side, and does one of 10 activities picked at random (tower, sandcastle, painting, plant, snowman, cake, train track, rocket, puzzle, card house). As each piece falls due it walks to the pile, picks one up, carries it over and puts it on (the last one lands at zero); longer timers get more detail: after the main pieces it adds one extra per 5 minutes, up to 6 (flowers and a cat by the tower, shells and a palm by the sandcastle, a sun and a house in the painting, bugs on the plant, a scarf and trees round the snowman, fruit and balloons on the cake, trees and a cow along the track, stars and a moon round the rocket, and so on). In between it keeps busy: works at the build, steps back to admire it ("Looking good!"), checks the pile, taps its watch, wipes its brow, and, while it isn't hurrying yet, sits down for a rest, has a glass of water or stretches. When a piece falls due it drops whatever it was doing ("Oh! Back to work."). Moved by hand, it sets up again where it lands. The countdown shows in its face screen instead of its eyes. Halfway it says "Better hurry up." (digits turn amber), at 75% "Hurry, hurry!" (faster hands, sweat drop), at 90% "Oh no oh no oh no!" (red blinking digits). Sounds: a chirp per scroll notch, a happy beep at the start, a pop as each piece lands, "whoa" on a mishap, a thud on cancel. Mishaps get likelier as it panics: the piece slips from its hands and rolls away (a block, a wave, a spill…) and it goes back to the pile for another; never the first or last one. At zero the finish plays (a flag, a signature, a bloom, carrot and hat, a candle, the train running, a 3-2-1 lift-off, a gold frame, a star), its normal eyes come back and it hops and flaps its arms in confetti: "Ta-da! Time's up! 🎉", then "Your N-minute timer is done! Yay!", with a desktop notification and a ring every 4 s until you click Tiko (at most 8). The finished build tumbles away 5 s after time's up. Scrolling a running timer changes its time (it starts from the time left, rounded up to the next step) and keeps the activity; scrolling to 0, or Stop timer in the menu, cancels it: the pieces tumble and fade, "Oops. Timer cancelled." Meetings and focus take priority; it goes back to building after. One timer at a time; whole minutes; it is not kept across a logout or a switch-off |
| Break reminder | 90 min of activity without 5 idle minutes; or "in 30 min" from the menu | Stretches: "90 min straight. Stretch break?" (at most every 10 min, never during meetings or focus) |
| Jira done | One of your sprint tickets moves to Done, or you move one to any status from the Jira menu | If Tiko is free, it walks to the spot under the Jira item in the top bar holding a small white card with the ticket key, and throws the card up into the item with visible effort (crouch, strained face, sweat drop, arm drawn back, a shaking hold, then the throw). Each time it picks one of 10 throws at random: clean toss, windmill, falls short, overshoot, third time lucky, "Hnnngh", jump shot, paper plane, tired worker and slam dunk. Some miss: the card lands on the floor, Tiko walks over, picks it up and tries again. Every status move made from the Jira menu gets a delivery, each with its own line and flash colour: Done says "M2P-1627 just moved to Done. Well done!" and glows green; In progress "On it! M2P-1627 is in progress."; review "Off to review: M2P-1627."; To do "Back to the pile: M2P-1627." (the Jira item picks blue, amber or grey for these). Moves made on the Jira site are still only noticed for Done. When the card goes in, the Jira menu moves the ticket to its new column (until then it stays where it was, marked "moving…"), the Jira item flashes for a second, Tiko hops and says a short line such as "Delivered!". If it is busy (asleep, focus, a meeting or Do Not Disturb, hidden for a screen share, switched off, held, playing, on the movie sofa, or doing anything more important than a dance), or the Jira item isn't in the top bar, it only says that move's line (e.g. "M2P-1627 just moved to Done. Well done!"). Grabbing it, a meeting or another reminder cuts a delivery short; the line is still shown. A move made from the Jira menu reaches Tiko at once; a move made elsewhere (on the Jira site) is noticed on its 5-second check of the Jira item's ticket list, after the Jira item's next refresh. Each move is announced once. Off with the **Jira alerts** switch |
| Jira alert | A ticket reassigned away from you | Frowns with red eyes and shows the ticket, with a warning sound (needs the Jira Sprint extension) |
| Morning briefing | Once a day, the first time you're active after 8 AM | "Good morning! You have 3 meetings today; the first is Sprint planning at 2:15 PM. 2 sprint tickets are still open. Weather: …" |
| Screen-share guard | You share or record your screen (Meet, Zoom, Slack, OBS, the screen recorder) | The buddy, its ball, pet, peel and cards hide and go silent, then come back when the share stops. Turn off **Hide while screen sharing** to keep it visible; each hide and return is logged as `desk-buddy: screen share/recording ...` in `journalctl --user -f -o cat /usr/bin/gnome-shell` |
| Meeting card | 5 min before a meeting; 10 min before a standup | A white card next to Tiko with the title, the start time, an "in N min" countdown, and **Join** (the link the meeting item found) and **Dismiss**. It always sits above windows and above Tiko itself (Tiko's drawing area, which includes the room for its speech bubble, overlaps the card's buttons and used to take their clicks), and it stops following Tiko while your pointer is on it. Buttons show a hand pointer and change colour on hover, and act on press. A meeting counts as a standup when its title contains "standup", "stand up", "stand-up" or "scrum" (any case). A standup's card is wider: a header with the title and start time, then **Yesterday** (what you moved on the last working day) and **Today** (in progress) as panels with a tinted heading, the item count and a chevron that folds the panel. Each ticket row shows its key in a blue pill, the title, and its status: a filled green pill with a tick when done, an outlined pill with a clock otherwise. The epic shows under a ticket when its parent is an epic (once per run of tickets in the same epic). Within each panel tickets are ordered Done, In review, In progress, To do; up to 3 show, and "View all N … items" opens the rest. **Blockers** (a status like Blocked or On Hold) is one line reading None, or a red panel when there are some; **Commits since yesterday** (Friday on Mondays) shows one chip per repo. **Copy update** copies everything (statuses, epics, commits) as bulleted text for Slack, to the clipboard and middle-click paste, and reads "Copied" for 2 s. **Productivity → Stand-up summary now** opens the same card at any time: for today's next stand-up if there is one, otherwise titled "Stand-up summary" with "Updated today at …", staying until you dismiss it. The lists come from the Jira Sprint extension, so the card shows "Loading…" until Jira answers; if that extension is missing or the request fails, it shows only the commits, or is a normal meeting card. It shows in focus mode too |
| Daily wrap | 7 PM, or Productivity → Daily wrap now | Today's meetings, commits per repo, Jira tickets you moved to Done today (whoever they are assigned to: any ticket whose status you changed today and that is Done now) and uncommitted repos, copied to the clipboard for Slack |
| End of day | 7 PM (or "Check uncommitted work now") | Lists repos and worktrees under your projects folder (`projectsDir`, default `~/Projects`) with uncommitted changes, or "All clean." |
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
| `~/.config/desk-buddy.json` | Which nudges are on, the activity level, and `projectsDir`: the folder scanned for git repos by the stand-up, end-of-day and daily-wrap features (default `~/Projects`, e.g. `{"projectsDir": "~/code"}`) |
| `~/.config/desk-buddy-stats.json` | Local counters for secret tricks (spins, focus blocks, days played, landings, games). Delete the file to start over |
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
- **Jira:** read from the running Jira Sprint extension, without its own network calls. The
  standup card asks that extension for its lists (`standupData`), which makes one Jira search
  for the Yesterday list. The Jira extension calls Tiko's `deliverTicket(key, summary)` when you
  move a ticket to Done from its menu.

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
