// Tiko (formerly Desk Buddy): a small robot that lives on your desktop.
// It walks along the bottom of the work area and treats open windows as
// terrain: it climbs onto a window's top edge, rides along when that window is
// moved, ducks under a window bottom hanging just above its head, and flies up
// to ledges too tall to climb. Left alone it naps in the nearest bottom
// corner; a click wakes it, a drag lifts it. During a meeting (the meet-join
// Do Not Disturb marker exists) it sits quietly with glowing headphones.
//
// The actor is only buddy-sized and moves every frame, so it never blocks
// clicks on the desktop icons or anything else.
import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Soup from 'gi://Soup?version=3.0';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const S = 1.3;                        // drawing scale
const AW = 320, AH = 260, FOOT = 16;   // tall enough for a six-line speech bubble   // actor size; feet sit FOOT px above its bottom
const BW = 46, BH = 52;               // buddy size before scaling
const SPEED = 60, CLIMB = 70, FLY = 160, GRAV = 1100;
const CHUTE_SPEED = 110;               // glide descent, px/s
const CHUTE_UNFURL_MAX = 240;          // fall speed cap while the canopy opens
const CHUTE_UNFURL = 0.4, CHUTE_SWING = 1.6;   // seconds to open; swing rate (rad/s)
// Under the canopy it steers itself: toward your pointer when the pointer is
// below it (so you can guide it down), pulling one toggle to turn; near the
// ground it flares (both toggles down) to slow the last stretch.
const CHUTE_STEER = 75;                // px/s sideways at full toggle
const CHUTE_FLARE_PX = 60;             // unscaled px above the surface where the flare starts
// Grabbing a hand or foot: where they sit at rest (unscaled, origin between
// the feet), and how far a pull goes before it hurts.
const LIMBS = {
    armL: {base: [-25, -34], rest: [-28, -19], width: 5, kind: 'arm'},
    armR: {base: [25, -34], rest: [28, -19], width: 5, kind: 'arm'},
    legL: {base: [-8, -21.5], rest: [-8, -5], width: 11, kind: 'leg'},
    legR: {base: [8, -21.5], rest: [8, -5], width: 11, kind: 'leg'},
};
// Parked, the hands and feet sit elsewhere: arms crossed while it waits,
// hands down and feet forward once it sits. Grabs and spring-backs use these.
const LIMB_POSES = {
    waiting: {armL: [8, -28], armR: [-8, -31]},
    sitting: {armL: [-30, -6], armR: [30, -6], legL: [-11, -3], legR: [11, -3]},
};
// Pulling a limb: a giggle, then straining, then past CRY_FROM it cries,
// harder the further you pull (CRY_FULL is full sobbing) and calmer as you ease off.
const CRY_FROM = 55, CRY_FULL = 170;
const STRETCH_FEEL = [  // [up to px, face, line]
    [25, 'laugh', 'Hehe, that tickles!'], [CRY_FROM, 'emerge', 'Hey, careful with that!'], [Infinity, 'cry', ''],
];
const CRY_LINES = ['Sniff… that hurts.', 'Waaah! Stop pulling!', 'WAAAAAH!! Let go!!'];
// Throwing: a release faster than this (px/s) is a throw, not a drop.
const THROW_MIN_SPEED = 450, THROW_MAX_SPEED = 2600;              // parachute descent, px/s
const CHUTE_FROM = 0.7;               // dropped from higher than this share of the screen: parachute
// Lower drops are free falls; how far it fell (as a share of the screen
// height) decides the injury. Only drops by the user count, never its own hops.
const BUMP_FROM = 0.15, HURT_FROM = 0.35;
// Magnet mode (stuck to a window side): it slides down and jumps off with a
// flip once its feet are this many unscaled px above the surface below,
// about 1.6 of its own heights (the user asked for "a few metres" up).
const PARKOUR_FROM = 85, PARKOUR_SLIDE_MAX = 260;
const STUCK_REACH = 31;
// Magnet-mode exits are picked at random; this share of them go wrong.
const PARKOUR_FAIL_CHANCE = 0.25;   // unscaled px from b.x to its soles while turned onto a window side
// A drop this high (but below the parachute line) knocks its arms and legs
// off. Cartoon style: they bounce away, then hop back and snap on again.
const BREAK_FROM = 0.55, BREAK_SECS = 6, REJOIN_SECS = 2.2;
const LIMP_SECS = 20;
const MAX_CLIMB = 220, MAX_FLY = 520; // taller than MAX_FLY: walks on behind the window
const IDLE_MS = 90 * 1000;
// Lazy: two minutes after you last played with it (clicked, dragged or used
// its menu), it mostly lounges: only calm activities, further apart and longer,
// slow short strolls with long sits. Typing does not count as playing with it.
const LAZY_AFTER_MS = 60000;   // a minute after you last played with it
const JUGGLE_DROP_S = 1.1;   // the last stretch of a juggle that ends in a ball on the head
// "I'm watching you" timeline (s): stomp in, stop and stare, V at its eyes,
// point straight at you, then carry on the same way, leaning back to keep you in sight.
// "I'm watching you" timeline (seconds into the scene). It used to take a
// few slow steps where it stood and do each hand pose once, and neither the
// walk-in nor the gesture read clearly (user, 16 Nov 2026). Now it marches in
// from the screen edge, plants itself, then does eyes-then-you twice.
const WATCH_CYCLE = 1.2;                // one "my eyes… you" beat
const WATCH = {in: 2.6, stare: 3.3, eyes: 3.3, gesture: 3.3 + 2 * WATCH_CYCLE};   // then it walks off the edge, peeks back, and returns
const WATCH_IN_SPEED = 90;              // px/s marching in from the edge
const LAZY_ACTS = new Set(['coffee', 'book', 'doze', 'sit', 'look', 'phones', 'polish', 'yawn', 'fakesleep', 'fish', 'gum', 'smoke', 'banana', 'turn',
    'hammock', 'bellyup', 'clouds', 'snackbed', 'yawnflop', 'remote', 'sunbathe', 'daydream',
    'pillownap', 'burrito', 'lazyfish', 'lean', 'charging', 'sleepyread', 'bubbles', 'snore', 'pool',
    'drape', 'edgeblanket', 'pizza', 'lazydance', 'coffeedrip', 'sheep', 'rocking', 'petnap']);
// Lazy poses lying flat on its back (drawn turned on its side, like 'knocked').
const LIE_MODES = new Set(['hammock', 'bellyup', 'clouds', 'snackbed', 'remote', 'sunbathe', 'pillownap', 'burrito', 'bubbles', 'snore', 'pool',
    'drape', 'edgeblanket', 'lazydance', 'sheep', 'petnap']);
const isLying = b => LIE_MODES.has(b.mode) || (b.mode === 'pizza' && (b.pizzaT ?? 0) > 2.4);   // pizza: lies down once it has the box
// 20 fps while moving: smooth enough for a small robot, and about a third
// less work than 30 fps (measured 14 Nov 2026: ~14% of a core at 30 fps).
const FRAME_MS = 50;
const MEETING_MARKER = GLib.build_filenamev([GLib.get_user_cache_dir(), 'meet-join-dnd']);
// Exists while the user has switched the buddy off, so the choice survives a logout.
const OFF_MARKER = GLib.build_filenamev([GLib.get_user_cache_dir(), 'desk-buddy-off']);
const MUTE_MARKER = GLib.build_filenamev([GLib.get_user_cache_dir(), 'desk-buddy-mute']);
// Which nudges are on, chosen in the tile menu.
const PREFS_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'desk-buddy.json']);
const NUDGES = [
    ['meetings', 'Meeting reminders'], ['breaks', 'Break reminders'],
    ['jira', 'Jira alerts'], ['eod', 'End-of-day check'],
];
// Exists while a focus block has Do Not Disturb on, so a logout mid-focus
// still turns it back off next session.
const FOCUS_MARKER = GLib.build_filenamev([GLib.get_user_cache_dir(), 'desk-buddy-focus-dnd']);

// Productivity nudges.
const FOCUS_MIN = 25;
const FOCUS_HOLD_MS = 1000;           // press and hold this long to start or stop focus
const MEETING_WARN_MIN = 5;
// A standup gets its card earlier: the Yesterday/Today/Blockers body is
// meant to be read before you join, which five minutes rarely allows.
// The title rule is the user's decision (covers "Mynt Standup" and
// "Daily Scrum - Stand up").
const STANDUP_WARN_MIN = 10;
const STANDUP_RE = /stand[\s-]?up|scrum/i;
// Meeting and stand-up card colours: ink text, muted grey, indigo accent
// (and its hover shade), after the user's mock-up of 17 Nov 2026. (The Jira
// menu's dark theme was tried on this card and reverted the same day.)
const CARD = {ink: '#1f2328', muted: '#6b7280', accent: '#4f46e5', accentHot: '#4338ca'};
const STANDUP_MAX = 3;                // per group on the card (kept short so it fits); Copy update has them all
const BREAK_AFTER_MIN = 90, BREAK_IDLE_RESET_MIN = 5, BREAK_NAG_EVERY_MIN = 10;
const EOD_HOUR = 19;
// Folder scanned for git repos by the stand-up, end-of-day and daily-wrap
// features. Set "projectsDir" in desk-buddy.json; a leading ~ means home.
const DEFAULT_PROJECTS = '~/Projects';
const expandHome = p => p === '~' || p.startsWith('~/') ? GLib.get_home_dir() + p.slice(1) : p;
const RUN_SPEED = 2.3;
const TOUCH_QUIET_MS = 4000;   // no sound effects this long after you touch or throw it
const STAY_SIT_S = 20, STAY_SLEEP_S = 60;   // staying: waits, then sits, then sleeps

// Who may interrupt whom. A nudge or trick only takes over when the current
// mode's priority is not higher than its own; physics and your hands always win.
const PRIORITY = {
    held: 100, thrown: 100, stretched: 100, snapback: 95,
    fall: 90, jump: 90, chute: 90, chuteland: 90, watchingyou: 30, coffeerun: 25, party: 25, lunch: 20, splash: 20, danceoff: 30, stretch: 25, weekend: 20, mime: 25, hide: 30, nightowl: 25,
    hammock: 15, bellyup: 15, clouds: 15, snackbed: 15, yawnflop: 15, remote: 15, sunbathe: 15, daydream: 15, lazywave: 15, roll: 15,
    drape: 15, edgeblanket: 15, slowwalk: 15, pizza: 15, lazydance: 15, coffeedrip: 15, sheep: 15, rocking: 15, screensaver: 15, petnap: 15,
    pillownap: 15, burrito: 15, lazyfish: 15, lean: 15, charging: 15, sleepyread: 15, bubbles: 15, snore: 15, pool: 15, fivemore: 15, emerge: 90, tumble: 90, broken: 90, knocked: 90,
    climb: 85, fly: 85, prejump: 85,
    cry: 80, angry: 80, dizzy: 80, laugh: 75, shy: 75,
    meeting: 70, focus: 70,
    timer: 65, timerdone: 65,   // the scroll timer: above tricks and nudges, below meetings and focus
    stay: 60, poked: 60, wake: 60, tease: 60,
    watch: 40, alert: 40,
    // Above everyday tricks and the 'dance' reminder so they can't cut a
    // throw short; below every real reminder, meeting and focus, which end it.
    play: 30, deliver: 30,
    dance: 20, wave: 20, sit: 20, love: 20, look: 20, coffee: 20, book: 20, polish: 20, doze: 20, phones: 20,
    // tricks from section 17 of the upgrade suggestions
    smoke: 20, banana: 20, shoot: 20, typing: 20, clean: 20, gum: 20, plane: 20, sneeze: 20, fish: 20, paint: 20,
    highfive: 30, pose: 30, rocket: 88, juggle: 20, guitar: 25, bedtime: 15,
    tailchase: 20, mimewall: 20, derp: 20,
    snowball: 20, magic: 20, movie: 20, kite: 20, command: 20, fort: 20, hiccups: 25, cake: 20, raindance: 20,
    bugchase: 85, wallrun: 85, mirror: 30, hang: 85, slide: 85, jetfail: 85, tarzan: 85, ufo: 88, teleport: 85, stuck: 90, parkour: 90, handstand: 25,
    detective: 20, fakesleep: 20, selfie: 20, peek: 20, laughattack: 25, freeze: 20, ghost: 20,
    clones: 25, army: 25, disco: 25, rebel: 60, boing: 60, trampoline: 25, dizzydance: 20, acrobat: 90,
    sleep: 15, walk: 10, duck: 10,
};
// Scroll timer: the mouse wheel over Tiko sets whole minutes, 1 at a time up
// to 5, then in steps of 5 (user's choice, 19 Nov 2026)
// (up to 3 h); it starts 2 s after the last notch, and scrolling to 0
// cancels it. One timer at a time, gone after a logout. Agreed with the user
// on 19 Nov 2026 from the mock-up (claude.ai/artifact/K8FgddWrRzEDQYSLXwwYYF).
const TIMER_STEP = 5, TIMER_FINE = 5, TIMER_MAX = 180, TIMER_IDLE_MS = 2000;
// Hurry and panic come from the share of the time used up, not from how
// much is left to build: [share, level, arm speed, line].
const TIMER_PANIC = [[0.9, 3, 2.6, 'Oh no oh no oh no!'], [0.75, 2, 1.8, 'Hurry, hurry!'], [0.5, 1, 1.3, 'Better hurry up.']];
// The build site beside Tiko, in body units (scaled by S like Tiko).
const SITE_W = 120, SITE_H = 130, SITE_GY = 126, SITE_CX = 60;
const TIMER_SITE_OFF = 34, TIMER_PILE = 110;   // build spot to the site, and to the pile
// Breaks between pieces: where it goes (back: steps back from the build,
// aside: off to one side, pile: towards the pile, here: stays), for how long,
// and what it may say. calm ones are skipped once it is hurrying.
const TIMER_IDLE = [
    {kind: 'look', at: 'back', dur: 3, line: 'Looking good!'},
    {kind: 'look', at: 'pile', dur: 2.5, line: 'Enough pieces left?'},
    {kind: 'watch', at: 'here', dur: 2.5, line: 'How much time is left?'},
    {kind: 'wipe', at: 'here', dur: 2, line: 'Phew.'},
    {kind: 'work', at: 'here', dur: 0},
    {kind: 'rest', at: 'aside', dur: 6, line: 'A little rest.', calm: true},
    {kind: 'drink', at: 'aside', dur: 5, line: 'Water break! 💧', calm: true},
    {kind: 'stretch', at: 'here', dur: 3, line: 'Stretch!', calm: true},
];
// Longer timers get more detail: after its main pieces each activity adds
// one of these per 5 minutes ([emoji, x, y, size] on the site), up to all 6.
const TIMER_EXTRAS = {
    tower: [['🌼', 22, GY - 6, 8], ['🌼', 100, GY - 6, 8], ['🐈', 100, GY - 10, 11], ['🪜', 86, GY - 22, 14], ['🐦', 34, 40, 9], ['☁️', 96, 30, 11]],
    sand: [['🐚', 8, GY - 4, 8], ['🐚', 112, GY - 4, 8], ['🦀', 104, GY - 26, 9], ['⭐', 12, GY - 26, 7], ['🌴', 108, 50, 15], ['☀️', 16, 30, 11]],
    paint: [['☀️', 88, 42, 9], ['☁️', 44, 42, 9], ['🌳', 34, 74, 11], ['🏠', 62, 74, 11], ['🐦', 74, 50, 7], ['🌷', 90, 82, 7]],
    plant: [['🐞', CX + 9, 72, 7], ['🦋', CX - 24, 52, 9], ['🐝', CX + 24, 40, 8], ['🐌', 30, GY - 4, 8], ['🍄', 92, GY - 5, 9], ['☀️', 100, 22, 11]],
    snowman: [['🧣', CX, GY - 58, 10], ['❄️', 18, 30, 8], ['❄️', 102, 44, 8], ['🌲', 108, GY - 14, 14], ['🌲', 12, GY - 14, 12], ['🐧', 92, GY - 8, 10]],
    cake: [['🍓', CX - 12, GY - 62, 7], ['🍓', CX + 12, GY - 62, 7], ['🍒', CX - 24, GY - 48, 7], ['🍒', CX + 24, GY - 48, 7], ['🎈', 14, 40, 12], ['🎁', 106, GY - 8, 11]],
    train: [['🌲', 10, GY - 26, 12], ['🌲', 110, GY - 26, 12], ['🏠', 40, GY - 30, 12], ['🚦', 72, GY - 26, 10], ['🐄', 92, GY - 28, 10], ['☁️', 60, 40, 11]],
    rocket: [['⭐', 20, 30, 8], ['⭐', 100, 52, 8], ['🌙', 100, 22, 11], ['🛰️', 20, 72, 10], ['⭐', 30, 98, 6], ['🪐', 96, 92, 11]],
    puzzle: [['☕', 110, GY - 6, 9], ['🧩', 10, GY - 4, 8], ['🧩', 24, GY - 4, 8], ['📦', 104, 36, 10], ['🖍️', 14, 36, 9], ['🌟', 60, 30, 8]],
    cards: [['♥️', 12, GY - 8, 8], ['♠️', 108, GY - 8, 8], ['♦️', 12, GY - 30, 8], ['♣️', 108, GY - 30, 8], ['🎩', 18, 40, 11], ['🐇', 102, 40, 10]],
};
// What it carries from the pile to the build, per activity.
const TIMER_CARRY = {tower: '🟧', sand: '🪣', paint: '🖌️', plant: '🌱', snowman: '⚪', cake: '🍰', train: '🛤️', rocket: '🔩', puzzle: '🧩', cards: '🃏'};
const TP = [[0.96, 0.45, 0.35], [0.98, 0.78, 0.3], [0.4, 0.78, 0.55], [0.38, 0.62, 0.95], [0.72, 0.5, 0.9]];
const sitePath = (cr, pts) => { cr.moveTo(...pts[0]); for (const q of pts.slice(1)) cr.lineTo(...q); cr.closePath(); cr.fill(); };
const siteFlag = (cr, t, top) => {
    cr.setSourceRGBA(0.85, 0.85, 0.88, 1); cr.setLineWidth(1.5);
    cr.moveTo(SITE_CX, top); cr.lineTo(SITE_CX, top - 20); cr.stroke();
    cr.setSourceRGBA(0.95, 0.3, 0.3, 1); sitePath(cr, [[SITE_CX, top - 20], [SITE_CX + 14, top - 16 + Math.sin(t * 8) * 2], [SITE_CX, top - 12]]);
};
const GY = SITE_GY, CX = SITE_CX;
// One is picked at random per timer. Each piece lands as the time passes;
// the last lands at zero, then its finish plays. oops: [falling emoji, line].
const TIMER_ACTS = {
    tower: {intro: "Let's build a tower!", n: () => 6, oops: ['🟧', 'Whoa! A block slipped!'],
        piece: (cr, i) => { rgb(cr, TP[i % 5]); rr(cr, CX - 14 + (i % 2 ? 2 : -2), GY - 11 * (i + 1), 28, 10, 2); cr.fill(); },
        fin: (cr, t, n) => siteFlag(cr, t, GY - 11 * n)},
    sand: {intro: 'Sandcastle time!', n: () => 8, oops: ['🌊', 'A wave! Rebuilding...'],
        piece: (cr, i) => {
            const [x, y] = i < 4 ? [16 + i * 22, GY - 14] : i < 7 ? [27 + (i - 4) * 22, GY - 28] : [49, GY - 42];
            cr.setSourceRGBA(0.93, 0.8, 0.55, 1); rr(cr, x, y, 21, 13, 2); cr.fill();
            cr.setSourceRGBA(0.78, 0.63, 0.4, 1); cr.rectangle(x, y + 10, 21, 3); cr.fill();
        },
        fin: (cr, t) => siteFlag(cr, t, GY - 42)},
    paint: {intro: 'Painting a picture!', n: () => 8, oops: ['🎨', 'Oops, spilled the paint!'],
        base: cr => {
            cr.setSourceRGBA(0.6, 0.42, 0.25, 1); cr.setLineWidth(3);
            cr.moveTo(40, GY); cr.lineTo(52, 40); cr.moveTo(80, GY); cr.lineTo(68, 40); cr.stroke();
            cr.setSourceRGBA(0.98, 0.98, 0.96, 1); rr(cr, 20, 30, 80, 60, 2); cr.fill();
        },
        piece: (cr, i) => {
            const y0 = 40 + (i * 13) % 42; rgb(cr, TP[i % 5]); cr.setLineWidth(4);
            cr.moveTo(26, y0); cr.curveTo(45, y0 - 12, 70, y0 + 12, 94, y0 - 4); cr.stroke();
        },
        fin: cr => { cr.setSourceRGBA(0.2, 0.2, 0.25, 1); cr.selectFontFace('Sans', Cairo.FontSlant.ITALIC, Cairo.FontWeight.BOLD); cr.setFontSize(8); cr.moveTo(62, 86); cr.showText('– Tiko'); }},
    plant: {intro: 'Growing a plant!', n: () => 8, oops: ['💧', 'Too much water!'],
        base: cr => {
            cr.setSourceRGBA(0.75, 0.42, 0.28, 1); sitePath(cr, [[44, GY - 22], [76, GY - 22], [72, GY], [48, GY]]);
            cr.setSourceRGBA(0.35, 0.23, 0.15, 1); cr.rectangle(46, GY - 22, 28, 3); cr.fill();
        },
        piece: (cr, i) => {
            const y1 = GY - 22 - 9 * i, y2 = y1 - 9, sd = i % 2 ? 1 : -1;
            cr.setSourceRGBA(0.3, 0.68, 0.35, 1); cr.setLineWidth(2.5); cr.moveTo(CX, y1); cr.lineTo(CX, y2); cr.stroke();
            cr.save(); cr.translate(CX + sd * 7, y2 + 4); cr.scale(1.8, 1); cr.arc(0, 0, 3.5, 0, 2 * Math.PI); cr.restore(); cr.fill();
        },
        fin: (cr, t, n, em) => em('🌻', CX, GY - 22 - 9 * n - 6, 16)},
    snowman: {intro: "Let's build a snowman!", n: () => 6, oops: ['⚪', "It's rolling away!"],
        piece: (cr, i) => {
            const snow = (y, r) => { cr.setSourceRGBA(0.97, 0.98, 1, 1); cr.newSubPath(); cr.arc(CX, y, r, 0, 2 * Math.PI); cr.fill(); };
            const dot = (x, y) => { cr.setSourceRGBA(0.15, 0.15, 0.2, 1); cr.newSubPath(); cr.arc(x, y, 1.8, 0, 2 * Math.PI); cr.fill(); };
            if (i === 0) snow(GY - 18, 18); else if (i === 1) snow(GY - 46, 13); else if (i === 2) snow(GY - 68, 10);
            else if (i === 3) { dot(CX, GY - 50); dot(CX, GY - 42); } else if (i === 4) { dot(CX - 4, GY - 70); dot(CX + 4, GY - 70); }
            else { cr.setSourceRGBA(0.45, 0.3, 0.2, 1); cr.setLineWidth(2); cr.moveTo(CX - 12, GY - 48); cr.lineTo(CX - 28, GY - 60); cr.moveTo(CX + 12, GY - 48); cr.lineTo(CX + 28, GY - 60); cr.stroke(); }
        },
        fin: (cr, t, n, em) => { em('🥕', CX + 6, GY - 66, 8); em('🎩', CX, GY - 84, 13); }},
    cake: {intro: 'Baking a cake!', n: () => 5, oops: ['🍳', 'Dropped an egg!'],
        piece: (cr, i) => {
            if (i < 4) { const w = 72 - 12 * i; rgb(cr, [[0.98, 0.7, 0.78], [0.98, 0.92, 0.78], [0.55, 0.35, 0.25]][i % 3]); rr(cr, CX - w / 2, GY - 14 * (i + 1), w, 14, 3); cr.fill(); }
            else { cr.setSourceRGBA(1, 1, 1, 1); rr(cr, CX - 19, GY - 58, 38, 5, 2); cr.fill(); }
        },
        fin: (cr, t, n, em) => em('🕯️', CX, GY - 70, 12)},
    train: {intro: 'Building a train track!', n: () => 8, oops: ['🔧', 'Wonky track, fixing it!'],
        piece: (cr, i) => {
            const x0 = 4 + i * 14;
            cr.setSourceRGBA(0.55, 0.38, 0.25, 1); cr.rectangle(x0 + 5, GY - 10, 3, 10); cr.fill();
            cr.setSourceRGBA(0.7, 0.72, 0.76, 1); cr.setLineWidth(1.5);
            cr.moveTo(x0, GY - 8); cr.lineTo(x0 + 14, GY - 8); cr.moveTo(x0, GY - 3); cr.lineTo(x0 + 14, GY - 3); cr.stroke();
        },
        fin: (cr, t, n, em) => em('🚂', (t * 40) % 130 - 6, GY - 16, 15)},
    rocket: {intro: 'Building a rocket!', n: () => 7, oops: ['🔩', 'A bolt popped out!'],
        piece: (cr, i) => {
            if (i < 3) { cr.setSourceRGBA(0.85, 0.87, 0.9, 1); rr(cr, CX - 12, GY - 26 - 22 * i, 24, 22, 2); cr.fill(); }
            else if (i === 3) { cr.setSourceRGBA(0.38, 0.62, 0.95, 1); cr.newSubPath(); cr.arc(CX, GY - 56, 6, 0, 2 * Math.PI); cr.fill(); }
            else if (i === 4) { cr.setSourceRGBA(0.95, 0.35, 0.3, 1); sitePath(cr, [[CX - 12, GY - 70], [CX, GY - 92], [CX + 12, GY - 70]]); }
            else { const sd = i === 5 ? -1 : 1; cr.setSourceRGBA(0.95, 0.35, 0.3, 1); sitePath(cr, [[CX + sd * 12, GY - 24], [CX + sd * 22, GY - 4], [CX + sd * 12, GY - 8]]); }
        },
        lift: t => t < 3 ? 0 : (t - 3) ** 2 * 30,
        fin: (cr, t) => {
            if (t < 3) { cr.setSourceRGBA(1, 0.85, 0.3, 1); cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD); cr.setFontSize(14); cr.moveTo(CX + 22, GY - 70); cr.showText(String(3 - Math.floor(t))); return; }
            cr.setSourceRGBA(1, 0.6 + Math.random() * 0.3, 0.2, 1); sitePath(cr, [[CX - 8, GY - 4], [CX, GY + 14 + Math.random() * 8], [CX + 8, GY - 4]]);
        }},
    puzzle: {intro: 'Puzzle time!', n: () => 12, oops: ['🧩', 'Where did that piece go?'],
        base: cr => { cr.setSourceRGBA(0.6, 0.62, 0.68, 1); cr.setLineWidth(1); cr.rectangle(20, 52, 80, 60); cr.stroke(); },
        piece: (cr, i) => { rgb(cr, TP[(i * 3) % 5]); rr(cr, 21 + (i % 4) * 20, 53 + Math.floor(i / 4) * 20, 18, 18, 3); cr.fill(); },
        fin: (cr, t, n, em) => { cr.setSourceRGBA(0.95, 0.78, 0.25, 1); cr.setLineWidth(3); cr.rectangle(18, 50, 84, 64); cr.stroke(); em('✨', CX, 40 + Math.sin(t * 4) * 2, 12); }},
    cards: {intro: 'Building a card house!', n: () => 6, oops: ['🃏', 'Achoo! Wobbly cards!'],
        piece: (cr, i) => {
            const [px, base] = [[30, GY], [60, GY], [90, GY], [45, GY - 26], [75, GY - 26], [60, GY - 52]][i];
            cr.setSourceRGBA(0.3, 0.3, 0.38, 1); cr.setLineWidth(4); cr.moveTo(px - 10, base); cr.lineTo(px, base - 24); cr.lineTo(px + 10, base); cr.stroke();
            cr.setSourceRGBA(0.98, 0.98, 0.98, 1); cr.setLineWidth(2.5); cr.moveTo(px - 10, base); cr.lineTo(px, base - 24); cr.lineTo(px + 10, base); cr.stroke();
        },
        fin: (cr, t, n, em) => em('⭐', CX, GY - 86 + Math.sin(t * 4) * 2, 13)},
};

// Ticket delivery faces, borrowed from existing ones. strain is 'emerge':
// squeezed > < eyes, a gritted zigzag mouth and a sweat drop.
// What it says for a ticket moved from the Jira menu, by status group, and
// the bubble label when the Jira status name is missing.
const DELIVER_LINES = {
    done: key => `${key} just moved to Done. Well done!`,
    progress: key => `On it! ${key} is in progress.`,
    review: key => `Off to review: ${key}.`,
    todo: key => `Back to the pile: ${key}.`,
};
const DELIVER_LABEL = {progress: 'In progress', review: 'Review', todo: 'To do'};
const DELIVER_FACE = {strain: 'emerge', happy: 'dance', shock: 'fear', sad: 'staybored'};
// Calm modes redraw at a third of the rate.
const CALM = new Set(['sleep', 'stay', 'meeting', 'focus', 'sit', 'coffee', 'book', 'doze', 'smoke', 'banana', 'movie', 'lunch', 'hammock', 'bellyup', 'clouds', 'snackbed', 'remote', 'sunbathe', 'daydream',
    'pillownap', 'burrito', 'lazyfish', 'lean', 'charging', 'sleepyread', 'bubbles', 'snore', 'pool',
    'drape', 'edgeblanket', 'pizza', 'lazydance', 'coffeedrip', 'sheep', 'rocking', 'screensaver', 'petnap']);
// How often it does a trick on its own, by the activity level in the tile menu.
// 'lazy' keeps it lounging all the time (see _lazy()); its range is only a
// fallback, as lazy picks are spaced at least 40 s apart anyway.
const ACTIVITY = {off: null, lazy: [20000, 35000], low: [20000, 35000], normal: [8000, 16000], high: [4000, 8000]};
const ACTIVITY_ORDER = ['lazy', 'low', 'normal', 'high', 'off'];
const ACTIVITY_LABEL = {lazy: 'Lazy', low: 'Low', normal: 'Normal', high: 'High', off: 'Off (no tricks)'};
// Tricks that move it along a path; they run their own step.
const MOVING_TRICKS = new Set(['handstand', 'slide', 'hang', 'jetfail', 'tarzan', 'ufo', 'teleport', 'stuck', 'rocket',
    'bugchase', 'wallrun', 'mirror', 'parkour']);
// Weather for its outfit. wttr.in works out the place from the connection;
// nothing about you is sent. Checked every 30 minutes; switch off in the menu.
// Percent-encoded (%C|%t|%w): Soup.Message.new returns null for the raw
// form, which broke every weather check with "Argument msg may not be null".
const WEATHER_URL = 'https://wttr.in/?format=%25C%7C%25t%7C%25w';
// With "weatherCity" set in desk-buddy.json (e.g. "Kochi") it asks for that place;
// only the city name is sent. Unset, wttr.in guesses from the connection.
const weatherUrl = city => city ? `https://wttr.in/${encodeURIComponent(city)}?format=%25C%7C%25t%7C%25w` : WEATHER_URL;
const WEATHER_EVERY_MS = 30 * 60000;
// Media players treated as music (dance); every other player counts as a
// video (movie night). Matched against the MPRIS bus name, e.g. "spotify",
// "chromium.instance123", "firefox.instance_1_2", "vlc".
const MUSIC_PLAYERS = /spotify|rhythmbox|lollypop|amberol|audacious|clementine|strawberry|elisa|cmus|mpd|quodlibet|tauon|gnome[-_.]?music|shortwave|cantata|deadbeef|g4music|sayonara|ncspot|spotube|gsconnect|kdeconnect/i;
const MOVIE_DOZE_MIN = 90;   // dozes off on the sofa after this long
const MOVIE_DOZE_LEN_MIN = 10, MOVIE_REDOZE_MIN = 45;   // naps this long, then watches on and dozes again later
// Long watching, in minutes of one viewing session. Each stage happens once,
// except the stretch, which repeats.
const LW = {stretch: 20, stretchEvery: 25, blanket: 30, loo: 45, tired: 60, glasses: 75, pizza: 120, badge: 180, cushionFrom: 60, cushionEvery: 30, extrasFrom: 30};
// Faces for movie reactions.
const MOVIE_FACE = {laugh: 'laugh', gasp: 'poked', hide: 'peekhide', shh: 'smoke', sniffle: 'cry', stretch: 'mv_stretch', rub: 'mv_rub',
    dig: 'detective', cramp: 'mv_cramp', squint: 'mv_squint', action: 'mv_action', grit: 'mv_grit', cold: 'mv_cold', heart: 'love', calm: 'mv_calm', bored: 'mv_bored', clap: 'laugh', phone: 'mv_phone'};
const MOVIE_SAY = {laugh: 'Hahaha!', gasp: 'Whoa!', sip: '*sip* Ahh, cold beer.', open: '*pssht* Cheers!', hide: "I can't look!", sniffle: '*sniff*',
    squint: 'Too bright!', action: 'Go go go!', grit: 'Ooh!', cold: 'Brr, spooky.', heart: 'Aww.', calm: '*sigh* Pretty.', bored: 'Is anything happening?', clap: 'Bravo! *clap clap*'};
// The video's mood, guessed from its title only: it laughs more at comedy,
// hides its eyes at horror and sniffles at sad ones.
const MOVIE_MOODS = [
    ['funny', /funny|comedy|comedic|\bfails?\b|prank|meme|bloopers?|stand.?up|hilarious|\blol\b|sitcom|roast/i],
    ['scary', /horror|scary|creepy|haunted|\bghosts?\b|terrifying|paranormal|nightmare|thriller|zombie|jump.?scare/i],
    ['sad', /\bsad\b|emotional|tear.?jerker|heartbreaking|crying|tragic|farewell|tribute|in memory/i],
];
const MOVIE_REACTS = {
    funny: [['laugh', 6], ['gasp', 1], ['sip', 1]],
    scary: [['hide', 5], ['gasp', 2], ['sip', 1]],
    sad: [['sniffle', 5], ['sip', 1]],
    none: [['laugh', 1], ['gasp', 1], ['sip', 1]],
};
// Sound level while it watches: pw-record captures what the speakers play at
// 8 kHz mono, and only the loudness of each 0.1 s is kept; nothing is stored
// or listened to. A sudden loud moment startles it; two quiet minutes make it drowsy.
const LEVEL_CMD = ['pw-record', '-P', '{ stream.capture.sink=true }', '--rate', '8000', '--channels', '1', '--format', 's16', '-'];
const LOUD_JUMP = 0.22, LOUD_RATIO = 3, QUIET_LEVEL = 0.015, QUIET_DROWSY_MS = 2 * 60000;
// Rare surprises: about one every 30-60 minutes while you are around.
const RARE_MIN = 30, RARE_MAX = 60;
const STATS_PATH = GLib.build_filenamev([GLib.get_user_config_dir(), 'desk-buddy-stats.json']);
// Secret tricks: [id, name, unlocked when].
const UNLOCKS = [
    ['dizzydance', 'Dizzy dance', s => s.spins >= 5],
    ['celebration', 'Focus celebration', s => s.focus >= 10],
    ['hunter', 'Cursor hunter', s => s.cursor >= 3],
    ['costume', 'Party hat', s => s.days.length >= 7],
    ['acrobat', 'Acrobat landing', s => s.landings >= 5],
    ['goldball', 'Golden ball', s => s.games >= 3],
];


// Sound for entering each mode; only played when the mode changes.
const MODE_SOUND = {wake: 'beep', dance: 'happy', tease: 'happy', dizzy: 'whoa', broken: 'ouch', knocked: 'ouch',
    stay: 'chirp', watch: 'reminder', alert: 'alert', jump: 'chirp', chute: 'whoa', poked: 'thud', focus: 'chirp',
    tumble: 'whoa', cry: 'cry2', laugh: 'happy', shy: 'boop', angry: 'reminder', love: 'happy'};
const REACTIONS = {
    cry: 'Waaah… my knee!', shy: 'Hehe… nobody saw that, right?', laugh: 'Hahaha! Again!', angry: 'Stupid wheels!',
};

// On/off switch in Quick Settings, next to Wi-Fi, Bluetooth and the rest.
const BuddyIndicator = GObject.registerClass({GTypeName: 'DeskBuddyIndicator'},
    class BuddyIndicator extends QuickSettings.SystemIndicator {
        _init() {
            super._init();
            // One tile: click to switch the buddy on or off; its arrow opens a
            // menu with the sound and voice switch.
            this.toggle = new QuickSettings.QuickMenuToggle({
                title: 'Tiko',
                iconName: 'face-smile-symbolic',
                toggleMode: true,
                menuEnabled: true,
            });
            this.toggle.menu.setHeader('face-smile-symbolic', 'Tiko');
            this.soundSwitch = new PopupMenu.PopupSwitchMenuItem('Sounds and voice', true);
            this.toggle.menu.addMenuItem(this.soundSwitch);

            // The menu got too tall for the screen, so everything below the
            // sound switch lives in collapsible sections (each scrolls if needed).
            const section = (title, items) => {
                const sub = new PopupMenu.PopupSubMenuMenuItem(title);
                for (const i of items) sub.menu.addMenuItem(i);
                this.toggle.menu.addMenuItem(sub);
                return sub;
            };
            this.focus25 = new PopupMenu.PopupMenuItem('Focus 25 min');
            this.timerNow = new PopupMenu.PopupMenuItem('Timer 10 min (or scroll over Tiko)');
            this.standupNow = new PopupMenu.PopupMenuItem('Stand-up summary now');
            this.uncommittedNow = new PopupMenu.PopupMenuItem('Check uncommitted work now');
            this.breakNow = new PopupMenu.PopupMenuItem('Remind me to take a break in 30 min');
            this.wrapNow = new PopupMenu.PopupMenuItem('Daily wrap now (copies it)');
            this.playBall = new PopupMenu.PopupMenuItem('Play ball');
            this.followMe = new PopupMenu.PopupMenuItem('Follow me');
            this.stopPlay = new PopupMenu.PopupMenuItem('Stop playing');
            this.petNow = new PopupMenu.PopupMenuItem('Call the robot pet');
            this.surpriseNow = new PopupMenu.PopupMenuItem('Surprise me now');
            this.hideNow = new PopupMenu.PopupMenuItem('Hide and seek');
            this.moonwalkNow = new PopupMenu.PopupMenuItem('Moonwalk');
            this.magicNow = new PopupMenu.PopupMenuItem('Magic show');
            this.watchNow = new PopupMenu.PopupMenuItem("I'm watching you");
            this.coffeeNow = new PopupMenu.PopupMenuItem('Coffee run');
            this.onTopSwitch = new PopupMenu.PopupSwitchMenuItem('Show above windows', true);
            this.shareSwitch = new PopupMenu.PopupSwitchMenuItem('Hide while screen sharing', true);
            this.chattySwitch = new PopupMenu.PopupSwitchMenuItem('Chatty (talks about everything)', true);
            this.weatherSwitch = new PopupMenu.PopupSwitchMenuItem('Dress for the weather (wttr.in)', true);
            this.petSwitch = new PopupMenu.PopupSwitchMenuItem('Keep the robot pet around', false);
            // Activity is a pick-one list (dot on the current level) rather than a
            // single row you click to cycle, so you can see every level at once.
            this.activityItems = {};
            for (const key of ACTIVITY_ORDER) {
                this.activityItems[key] = new PopupMenu.PopupMenuItem(ACTIVITY_LABEL[key]);
                this.activityItems[key]._actKey = key;
            }
            this.nudgeSwitches = {};
            for (const [key, label] of NUDGES)
                this.nudgeSwitches[key] = new PopupMenu.PopupSwitchMenuItem(label, true);

            // One layout for both menus: the right-click menu mirrors this list,
            // so an item added or removed here changes both.
            this.sections = [
                ['Productivity', [this.focus25, this.timerNow, this.standupNow, this.wrapNow, this.uncommittedNow, this.breakNow]],
                ['Play', [this.moonwalkNow, this.magicNow, this.watchNow, this.coffeeNow, this.playBall, this.followMe, this.stopPlay, this.petNow,
                    this.hideNow, this.surpriseNow]],
                // Activity and Nudges are settings too, so they live inside
                // Settings under their own headings instead of being three
                // top-level sections (user, 16 Nov 2026).
                ['Settings', [this.onTopSwitch, this.shareSwitch, this.chattySwitch, this.weatherSwitch, this.petSwitch,
                    new PopupMenu.PopupSeparatorMenuItem('Activity'), ...Object.values(this.activityItems),
                    new PopupMenu.PopupSeparatorMenuItem('Nudges'), ...Object.values(this.nudgeSwitches)]],
            ];
            for (const [title, items] of this.sections) section(title, items);
            this.quickSettingsItems.push(this.toggle);
        }
    });

const C = {
    alert: [1, 0.42, 0.42],
    glow: [0.49, 0.94, 0.83], happy: [0.61, 0.94, 0.42], warn: [1, 0.72, 0.30],
    shell: [0.165, 0.176, 0.208], screen: [0.02, 0.027, 0.04], limb: [0.184, 0.196, 0.231],
    foot: [0.137, 0.149, 0.184], purple: [0.30, 0.255, 0.59], teal: [0.27, 0.84, 0.77],
    stripe: [0.35, 0.31, 0.69], hand: [0.29, 0.31, 0.38],
};

// How it walks and how its headphone rings glow, by mood (see _gaitMood()).
// The mood comes from the Activity level, but tiredness and injuries override
// it, so a tired or hurt Tiko drags along like a lazy one whatever the level.
// speed scales the walk; bob, stride and lift shape each step; slouch leans it
// forward, sway rocks it side to side, nod bobs the head on each stride.
// pulse is how fast the rings breathe (0 = steady).
const GAIT_LAZY = {speed: 0.55, bob: 0.3, stride: 4, lift: 0.8, slouch: 0.12, sway: 0, nod: 0, ring: [1, 0.70, 0.28], pulse: 0.8};
const GAIT = {
    lazy: GAIT_LAZY,
    low: {speed: 0.75, bob: 0.3, stride: 5, lift: 1.5, slouch: 0.05, sway: 0.06, nod: 0, ring: [0.42, 0.66, 1], pulse: 0},
    normal: {speed: 1, bob: 1.6, stride: 7, lift: 3, slouch: 0, sway: 0, nod: 0.045, ring: C.teal, pulse: 0},
    high: {speed: 1.3, bob: 6, stride: 8, lift: 4, slouch: 0, sway: 0, nod: 0, ring: [0.37, 0.96, 1], pulse: 6},
    off: {...GAIT_LAZY, ring: [0.17, 0.19, 0.22], pulse: 0},   // still roams, rings dark
};

function rr(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}
function rgb(cr, c, a = 1) { cr.setSourceRGBA(c[0], c[1], c[2], a); }

// The desktop-icons extension (DING) draws its icons in an ordinary-looking
// window titled "@!x,y;BDHF". It covers the whole screen, so the buddy must
// sit above it to be clickable, and it is never terrain.
// On this machine (GNOME 50, 13 Nov 2026) its windows are titled "Desktop Icons 1",
// "Desktop Icons 2", so match that too, and as a fallback any taskbar-less
// window that covers its whole monitor.
function isDesktopWindow(w) {
    const title = w.get_title() ?? '';
    if (w.get_window_type() === Meta.WindowType.DESKTOP || title.startsWith('@!') ||
        /^Desktop Icons\b/.test(title) || /ding/i.test(w.get_wm_class() ?? ''))
        return true;
    if (!w.is_skip_taskbar())
        return false;
    const r = w.get_frame_rect();
    const m = global.display.get_monitor_geometry(w.get_monitor());
    return r.width >= m.width - 2 && r.height >= m.height - 80;
}

// A clear green beer bottle standing on its base at the origin. The amber
// beer shows how much is left; capped until opened, then a foam line, and
// bubbles rising from the neck just after it is opened (fizz 1 → 0).
function drawBeer(cr, left = 1, open = false, fizz = 0) {
    cr.setSourceRGBA(0.55, 0.75, 0.5, 0.55); rr(cr, -3.5, -12, 7, 12, 1.8); cr.fill();
    rr(cr, -1.4, -18, 2.8, 7, 1); cr.fill();
    const top = -11 * Math.max(0, Math.min(1, left));
    if (left > 0.02) {
        cr.setSourceRGBA(0.93, 0.62, 0.12, 0.95); cr.rectangle(-2.8, top - 0.5, 5.6, -top); cr.fill();
        if (open) { cr.setSourceRGBA(1, 0.98, 0.9, 1); cr.rectangle(-2.8, top - 1.6, 5.6, 1.4); cr.fill(); }
    }
    cr.setSourceRGBA(0.97, 0.93, 0.8, 1); cr.rectangle(-3.5, -3.6, 7, 2.4); cr.fill();   // low label, so the level shows
    cr.setSourceRGBA(0.8, 0.2, 0.2, 1); cr.rectangle(-3.5, -2.9, 7, 0.8); cr.fill();
    if (!open) { cr.setSourceRGBA(0.85, 0.7, 0.2, 1); rr(cr, -1.8, -19.5, 3.6, 2, 0.6); cr.fill(); }
    cr.setSourceRGBA(1, 1, 1, 0.3); cr.rectangle(-2.6, -11, 1, 9); cr.fill();
    if (fizz > 0) {
        cr.setSourceRGBA(1, 1, 1, 0.85 * fizz);
        for (let k = 0; k < 4; k++) { cr.newSubPath(); cr.arc(Math.sin(k * 2.1) * 2, -20 - (1 - fizz) * 10 - k * 2.5, 0.8 + k * 0.2, 0, 2 * Math.PI); cr.fill(); }
    }
}

// A parachute canopy: a dome with a vent at the top and a scalloped hem,
// purple and teal gores, darker towards the hem. Hem centre at the origin;
// sx/sy scale it (unfurling, breathing, collapsing).
const CANOPY_R = 46, CANOPY_H = 32, CANOPY_GORES = 7;
function drawCanopy(cr, sx = 1, sy = 1, alpha = 1) {
    const R = CANOPY_R, H = CANOPY_H, n = CANOPY_GORES;
    cr.save(); cr.scale(Math.max(0.01, sx), Math.max(0.01, sy));
    const dome = () => {
        cr.newPath(); cr.moveTo(-R, 0);
        cr.curveTo(-R, -H * 1.1, -R * 0.45, -H * 1.35, 0, -H * 1.35);
        cr.curveTo(R * 0.45, -H * 1.35, R, -H * 1.1, R, 0);
        for (let i = n; i > 0; i--) {   // the hem, one upward scallop per gore
            const x0 = -R + (2 * R * i) / n, x1 = -R + (2 * R * (i - 1)) / n;
            cr.curveTo(x0 - (x0 - x1) * 0.3, -5, x1 + (x0 - x1) * 0.3, -5, x1, 0);
        }
        cr.closePath();
    };
    cr.pushGroup();
    dome(); cr.clip();
    rgb(cr, C.purple); cr.paint();
    rgb(cr, C.teal);
    for (let i = 1; i < n; i += 2) {
        const x0 = -R + (2 * R * i) / n, x1 = -R + (2 * R * (i + 1)) / n;
        cr.moveTo(0, -H * 1.35); cr.lineTo(x0 * 1.15, 2); cr.lineTo(x1 * 1.15, 2); cr.closePath(); cr.fill();
    }
    const shade = new Cairo.LinearGradient(0, -H * 1.35, 0, 0);
    shade.addColorStopRGBA(0, 1, 1, 1, 0.14); shade.addColorStopRGBA(0.55, 0, 0, 0, 0); shade.addColorStopRGBA(1, 0, 0, 0, 0.28);
    cr.setSource(shade); cr.paint();
    cr.setSourceRGBA(1, 1, 1, 0.22); cr.setLineWidth(3);   // shine on the left shoulder of the dome
    cr.newSubPath(); cr.arc(-R * 0.25, -H * 0.4, R * 0.62, Math.PI * 1.12, Math.PI * 1.42); cr.stroke();
    cr.setSourceRGBA(0.05, 0.05, 0.08, 0.6); cr.save(); cr.translate(0, -H * 1.3); cr.scale(1, 0.35);
    cr.newSubPath(); cr.arc(0, 0, 4, 0, 2 * Math.PI); cr.restore(); cr.fill();   // vent
    cr.popGroupToSource(); cr.paintWithAlpha(alpha);
    cr.restore();
}

// A white cartoon glove making a V: palm with folded fingers, a thumb, and
// index and middle fingers out (pointing along -y before `rot`). Tiko's own
// hands are plain balls, which cannot show two fingers clearly.
function drawGlove(cr, x, y, rot = 0, spread = 0.32, flen = 13) {
    cr.save(); cr.translate(x, y); cr.rotate(rot);
    const shape = (c, g) => {
        cr.setSourceRGBA(c[0], c[1], c[2], 1);
        for (const a of [-spread, spread]) { cr.save(); cr.rotate(a); rr(cr, -2.4 - g, -2 - flen - g, 4.8 + 2 * g, flen + 2 * g, 2.4 + g); cr.fill(); cr.restore(); }
        cr.save(); cr.rotate(-1.2); rr(cr, -2.2 - g, -9 - g, 4.4 + 2 * g, 8 + 2 * g, 2.2 + g); cr.fill(); cr.restore();   // thumb
        rr(cr, -5.5 - g, -4 - g, 11 + 2 * g, 10 + 2 * g, 4 + g); cr.fill();   // palm
    };
    shape([0.08, 0.08, 0.1], 1); shape([0.97, 0.97, 0.98], 0);
    cr.setSourceRGBA(0.08, 0.08, 0.1, 1); cr.setLineWidth(0.7);
    for (const k of [-1.56, 0, 1.56]) { cr.moveTo(-4, k + 1.5); cr.lineTo(4, k + 1.5); }   // folded finger creases
    cr.stroke();
    cr.restore();
}

// One popped kernel: a puffy cream cluster with a hint of yellow.
function drawKernel(cr, x, y, r = 1.6) {
    cr.setSourceRGBA(1, 0.97, 0.88, 1);
    for (const [dx, dy] of [[-0.7, 0], [0.7, -0.2], [0, -0.8], [0.1, 0.6]]) { cr.newSubPath(); cr.arc(x + dx * r, y + dy * r, r, 0, 2 * Math.PI); cr.fill(); }
    cr.setSourceRGBA(0.98, 0.82, 0.35, 1); cr.newSubPath(); cr.arc(x + 0.3 * r, y + 0.3 * r, r * 0.45, 0, 2 * Math.PI); cr.fill();
}

// A red-and-white striped popcorn bucket, base at the origin, heaped with
// popcorn that sinks as it gets eaten (left 1 → 0).
const POP_HEAP = [[-6, -1], [-2, -2], [2, -1.5], [6, -1], [-4, -4], [0, -5], [4, -4], [-2, -7], [2, -7.5], [0, -9.5]];
function drawPopcorn(cr, left = 1) {
    const n = Math.round(POP_HEAP.length * Math.max(0, Math.min(1, left)));
    const sink = (1 - Math.max(0, Math.min(1, left))) * 5;
    for (let i = 0; i < n; i++) drawKernel(cr, POP_HEAP[i][0], -16 + sink + POP_HEAP[i][1]);
    for (let k = 0; k < 5; k++) {
        const x0 = -9 + k * 3.6, x1 = x0 + 3.6, b0 = -6 + k * 2.4, b1 = b0 + 2.4;
        if (k % 2) cr.setSourceRGBA(0.97, 0.97, 0.95, 1); else cr.setSourceRGBA(0.88, 0.18, 0.2, 1);
        cr.moveTo(x0, -16); cr.lineTo(x1, -16); cr.lineTo(b1, 0); cr.lineTo(b0, 0); cr.closePath(); cr.fill();
    }
    cr.setSourceRGBA(0.88, 0.18, 0.2, 1); rr(cr, -9.5, -17, 19, 2, 1); cr.fill();
}

// Long-watching props. Each is drawn with its base or centre at the origin.
// An open pizza box with slices left (1 → 0).
function drawPizzaBox(cr, left = 1) {
    cr.setSourceRGBA(0.78, 0.6, 0.38, 1); rr(cr, -12, -5, 24, 5, 1); cr.fill();
    cr.setSourceRGBA(0.85, 0.68, 0.45, 1); cr.moveTo(-12, -5); cr.lineTo(-9, -15); cr.lineTo(15, -15); cr.lineTo(12, -5); cr.closePath(); cr.fill();   // lid, tipped back
    const n = Math.ceil(6 * Math.max(0, Math.min(1, left)));
    for (let i = 0; i < n; i++) {
        const a0 = -Math.PI / 2 + i * Math.PI / 3;
        cr.setSourceRGBA(0.95, 0.75, 0.3, 1); cr.moveTo(0, -3); cr.arc(0, -3, 9, a0, a0 + Math.PI / 3 - 0.08); cr.closePath(); cr.fill();
        cr.setSourceRGBA(0.8, 0.15, 0.12, 1); cr.newSubPath(); cr.arc(Math.cos(a0 + 0.5) * 5, -3 + Math.sin(a0 + 0.5) * 2.5, 1.2, 0, 2 * Math.PI); cr.fill();
    }
}
function drawSlice(cr) {
    cr.setSourceRGBA(0.95, 0.75, 0.3, 1); cr.moveTo(0, 4); cr.lineTo(-4, -6); cr.lineTo(4, -6); cr.closePath(); cr.fill();
    cr.setSourceRGBA(0.75, 0.5, 0.2, 1); rr(cr, -4.5, -7.5, 9, 2.2, 1); cr.fill();
    cr.setSourceRGBA(0.8, 0.15, 0.12, 1); cr.newSubPath(); cr.arc(0, -2.5, 1.2, 0, 2 * Math.PI); cr.fill();
}
function drawCookie(cr) {
    cr.setSourceRGBA(0.78, 0.55, 0.28, 1); cr.newSubPath(); cr.arc(0, 0, 3.2, 0, 2 * Math.PI); cr.fill();
    cr.setSourceRGBA(0.3, 0.18, 0.08, 1); for (const [cx, cy] of [[-1, -1], [1.2, 0.3], [-0.3, 1.4]]) { cr.newSubPath(); cr.arc(cx, cy, 0.6, 0, 2 * Math.PI); cr.fill(); }
}
function drawMilk(cr) {
    cr.setSourceRGBA(0.85, 0.9, 0.95, 0.5); rr(cr, -3.5, -11, 7, 11, 1.2); cr.fill();
    cr.setSourceRGBA(1, 1, 1, 0.95); rr(cr, -3, -8, 6, 7.5, 1); cr.fill();
}
function drawPhone(cr, t) {
    cr.setSourceRGBA(0.12, 0.13, 0.16, 1); rr(cr, -4, -7, 8, 13, 1.6); cr.fill();
    cr.setSourceRGBA(0.55, 0.8, 1, 0.9); rr(cr, -3, -6, 6, 10.5, 1); cr.fill();
    cr.setSourceRGBA(1, 1, 1, 0.8);
    for (let k = 0; k < 3; k++) { const yy = -5 + ((k * 3.5 + (-t * 5) % 10.5) + 10.5) % 10.5; if (yy < 4) { cr.rectangle(-2.2, yy, 4.4, 1); cr.fill(); } }   // scrolling
}
function drawFound(cr, item) {
    if (item === 'coin') { cr.setSourceRGBA(0.95, 0.78, 0.2, 1); cr.newSubPath(); cr.arc(0, 0, 3, 0, 2 * Math.PI); cr.fill(); cr.setSourceRGBA(1, 0.95, 0.6, 1); cr.newSubPath(); cr.arc(-0.8, -0.8, 1, 0, 2 * Math.PI); cr.fill(); }
    else if (item === 'sock') {
        cr.setSourceRGBA(0.95, 0.95, 0.95, 1); rr(cr, -2.5, -9, 5, 9, 1.5); cr.fill(); rr(cr, -2.5, -3, 8, 4, 2); cr.fill();
        cr.setSourceRGBA(0.85, 0.2, 0.25, 1); cr.rectangle(-2.5, -8, 5, 1.2); cr.fill(); cr.rectangle(-2.5, -6, 5, 1.2); cr.fill();
    } else {
        cr.setSourceRGBA(0.15, 0.15, 0.18, 1); rr(cr, -2.5, -10, 5, 13, 1.5); cr.fill();
        cr.setSourceRGBA(0.9, 0.25, 0.2, 1); cr.newSubPath(); cr.arc(0, -7.5, 1, 0, 2 * Math.PI); cr.fill();
        cr.setSourceRGBA(0.7, 0.7, 0.75, 1); for (let k = 0; k < 3; k++) { cr.newSubPath(); cr.arc(0, -4 + k * 2.4, 0.7, 0, 2 * Math.PI); cr.fill(); }
    }
}
// A plaid blanket draped over its lap: a turned-down hem along the top, soft
// folds, and a wavy fringed edge hanging over the front of the seat. x0/w
// span it, y0 is the top, y1 where it hangs to.
function drawBlanket(cr, x0, y0, w, y1) {
    const x1 = x0 + w, hgt = y1 - y0;
    const shape = () => {
        cr.newPath();
        cr.moveTo(x0 + 3, y0);
        cr.curveTo(x0 + w * 0.35, y0 - 2, x0 + w * 0.65, y0 - 2, x1 - 3, y0);   // over its knees
        cr.curveTo(x1 + 3, y0 + hgt * 0.3, x1 + 4, y0 + hgt * 0.7, x1 + 2, y1);   // spilling over the sides
        for (let i = 5; i >= 0; i--) {   // wavy bottom edge
            const px = x0 - 2 + (w + 4) * i / 6;
            cr.curveTo(px + (w + 4) / 12, y1 + (i % 2 ? 3 : -1), px + (w + 4) / 24, y1 + 1, px, y1);
        }
        cr.curveTo(x0 - 4, y0 + hgt * 0.7, x0 - 3, y0 + hgt * 0.3, x0 + 3, y0);
        cr.closePath();
    };
    cr.save(); shape(); cr.clip();
    cr.setSourceRGBA(0.16, 0.5, 0.56, 1); cr.paint();   // teal tartan
    cr.setSourceRGBA(0.1, 0.32, 0.38, 0.55);
    for (let gx = x0; gx < x1 + 4; gx += 9) { cr.rectangle(gx, y0 - 4, 3.5, hgt + 8); cr.fill(); }
    for (let gy = y0 + 4; gy < y1 + 4; gy += 9) { cr.rectangle(x0 - 6, gy, w + 12, 3.5); cr.fill(); }
    cr.setSourceRGBA(0.98, 0.86, 0.5, 0.75);
    for (let gx = x0 + 5; gx < x1 + 4; gx += 9) { cr.rectangle(gx, y0 - 4, 1, hgt + 8); cr.fill(); }
    for (let gy = y0 + 1; gy < y1 + 4; gy += 9) { cr.rectangle(x0 - 6, gy, w + 12, 1); cr.fill(); }
    cr.setSourceRGBA(0, 0, 0, 0.18); cr.setLineWidth(1.4);   // soft folds
    for (const fx of [0.3, 0.68]) { cr.moveTo(x0 + w * fx, y0 + 5); cr.curveTo(x0 + w * fx - 2, y0 + hgt * 0.5, x0 + w * fx + 2, y0 + hgt * 0.7, x0 + w * fx, y1 + 2); cr.stroke(); }
    cr.restore();
    // the turned-down hem along the top
    cr.setSourceRGBA(0.3, 0.66, 0.7, 1); rr(cr, x0 + 1, y0 - 2, w - 2, 4.5, 2.2); cr.fill();
    cr.setSourceRGBA(0.98, 0.86, 0.5, 0.9); cr.rectangle(x0 + 3, y0 - 0.2, w - 6, 0.9); cr.fill();
    shape(); cr.setSourceRGBA(0.07, 0.25, 0.3, 1); cr.setLineWidth(0.9); cr.stroke();
    // fringe
    cr.setSourceRGBA(0.98, 0.86, 0.5, 1); cr.setLineWidth(1);
    for (let fx = x0; fx <= x1; fx += 3.2) { const fy2 = y1 + (Math.round((fx - x0) / 3.2) % 2 ? 1.5 : 0.5); cr.moveTo(fx, fy2); cr.lineTo(fx + 0.3, fy2 + 3); }
    cr.stroke();
}

export default class DeskBuddyExtension extends Extension {
    enable() {
        this._indicator = new BuddyIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        this._indicator.toggle.checked = !GLib.file_test(OFF_MARKER, GLib.FileTest.EXISTS);
        this._indicator.toggle.connect('notify::checked', () => this._setOn(this._indicator.toggle.checked));
        this._indicator.soundSwitch.setToggleState(!GLib.file_test(MUTE_MARKER, GLib.FileTest.EXISTS));
        this._indicator.soundSwitch.connect('toggled', () => {
            try {
                if (this._indicator.soundSwitch.state)
                    Gio.File.new_for_path(MUTE_MARKER).delete(null);
                else
                    GLib.file_set_contents(MUTE_MARKER, '1');
            } catch {}
        });
        this._notif = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this._wireMenu();
        // A focus block cut short by a logout: turn Do Not Disturb back off.
        if (GLib.file_test(FOCUS_MARKER, GLib.FileTest.EXISTS))
            this._setFocusDnd(false);

        this._area = new St.DrawingArea({width: AW, height: AH, reactive: true});
        this._area.connect('repaint', a => this._paint(a));
        this._area.connect('button-press-event', (_a, ev) => this._press(ev));
        this._area.connect('motion-event', (_a, ev) => this._motion(ev));
        this._area.connect('button-release-event', () => this._release());
        this._area.connect('scroll-event', (_a, ev) => this._scroll(ev));   // the timer
        this._onTop = this._prefs?.onTop ?? true;
        this._fsMode = false;
        if (this._layer() === Main.layoutManager.uiGroup)
            Main.layoutManager.uiGroup.insert_child_above(this._area, global.top_window_group);
        else
            global.window_group.add_child(this._area);
        // Out of the way in the Activities overview.
        this._ovShowId = Main.overview.connect('showing', () => this._area?.hide());
        this._ovHideId = Main.overview.connect('hidden', () => { if (this._tickId && !this._sharing) this._area?.show(); });
        this._fsId = global.display.connect('in-fullscreen-changed', () => this._syncFullscreen());
        // Screen-share guard: every screen share or recording on Wayland (Meet,
        // Zoom, Slack, OBS, the screenshot recorder) is a remote-access handle.
        this._shares = new Set();
        this._raCtl = global.backend.get_remote_access_controller?.() ?? null;
        this._raId = this._raCtl?.connect('new-handle', (_c, handle) => {
            // Logged because a share started by a browser tab or Slack makes the
            // buddy vanish with no visible cause; the journal shows why.
            console.log(`desk-buddy: screen share/recording started (${handle.constructor.name}), hiding`);
            this._shares.add(handle);
            handle.connect('stopped', () => {
                console.log('desk-buddy: screen share/recording stopped');
                this._shares.delete(handle); this._syncShare();
            });
            this._syncShare();
        }) ?? 0;
        this._syncFullscreen();
        this._restackId = global.display.connect('restacked', () => { this._terrainDirty = true; this._placeInStack(); });
        this._wsId = global.workspace_manager.connect('active-workspace-changed', () => { this._terrainDirty = true; });
        // Monitor added, removed or resized: drop cached geometry and put it
        // back on the ground of the primary monitor.
        // Screenshots: the screenshot tool opening, or a new file in Pictures/Screenshots.
        this._shotUiId = Main.screenshotUI?.connect('notify::visible', () => {
            if (Main.screenshotUI.visible) this._onScreenshot();
        }) ?? 0;
        try {
            const shots = Gio.File.new_for_path(GLib.build_filenamev([
                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES), 'Screenshots']));
            this._shotMon = shots.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._shotMon.connect('changed', (_m, _f, _o, ev) => { if (ev === Gio.FileMonitorEvent.CREATED) this._onScreenshot(); });
        } catch { this._shotMon = null; }
        this._monId = Main.layoutManager.connect('monitors-changed', () => {
            this._terrainDirty = true; this._iconCache = null;
            if (this._b) this._safeReset('monitors changed');
        });
        this._placeInStack();

        const wa = this._workArea();
        this._b = {x: wa.x + 120, y: wa.y + wa.height, vx: 0, vy: 0, dir: 1, mode: 'walk', t: 0,
            squash: 1, actT: 0, home: false, held: false, on: null, target: 0};
        this._lastInteract = Date.now(); this._lastPlay = Date.now();   // lively for the first couple of minutes
        this._nextAct = Date.now() + 8000;
        this._pokes = [];
        this._bubble = {text: '', until: 0};
        this._press0 = null;
        this._focus = null;
        this._clickTimer = 0;
        this._reminded = new Set();
        this._jiraSeen = new Set();
        this._jiraStatus = new Map();
        this._recent = [];
        this._nextRare = Date.now() + 20 * 60000;
        this._fx = [];               // short-lived effect actors: paper planes, graffiti
        this._pet = null;
        this._music = null;
        this._weather = null;
        this._rectPrev = new Map();
        this._lastHighFive = 0;
        this._loadStats();
        this._cooldown = {};
        this._game = null;
        this._ball = null;
        this._activeSince = Date.now();
        this._lastBreakNag = 0;
        this._eodDay = null;
        this._tickId = 0;
        this._setOn(this._indicator.toggle.checked);
    }

    // Off hides the buddy and stops its clock entirely, so it costs nothing.
    _setOn(on) {
        try {
            if (on)
                Gio.File.new_for_path(OFF_MARKER).delete(null);
            else
                GLib.file_set_contents(OFF_MARKER, '1');
        } catch {}
        if (on && !this._tickId) {
            const wa = this._workArea();
            Object.assign(this._b, {x: wa.x + 120, y: wa.y + wa.height, vx: 0, vy: 0, mode: 'wake', actT: 1.6,
                home: false, held: false, on: null});
            this._say('Hi! I am back.', 1800);
            this._lastInteract = Date.now();
            this._last = GLib.get_monotonic_time();
            this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FRAME_MS, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
            if (!this._sharing) this._area.show();
        } else if (!on && this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
            this._area.hide();
            this._clearExtras();
        } else if (!on) {
            this._area.hide();
            this._clearExtras();
        }
    }

    // Switched off: nothing of its stays on screen (pet, ball, peel, bullets,
    // planes, graffiti, the meeting card), and no game carries on.
    _clearExtras() {
        this._ballGrab?.dismiss(); this._ballGrab = null;
        this._stopGame(false);
        this._removePeel();
        this._snake?.actor.destroy(); this._snake = null;
        this._pet?.actor.destroy(); this._pet = null;
        for (const q of this._bullets ?? []) q.actor.destroy();
        this._bullets = [];
        this._endDelivery(false);   // before the _fx sweep, which destroys its card
        this._killTimer();          // likewise; the sweep destroys its build site
        for (const f of this._fx ?? []) f.actor.destroy();
        this._fx = [];
        this._hideCard();
    }

    disable() {
        this._stopLevel(); this._shot = null; this._scene = null; this._videoBox = null;
        if (this._focus) this._setFocusDnd(false);
        this._focus = null;
        if (this._clickTimer) GLib.source_remove(this._clickTimer);
        this._clickTimer = 0;
        this._notif = null;
        if (this._tickId)
            GLib.source_remove(this._tickId);
        this._tickId = 0;
        this._indicator.quickSettingsItems.forEach(i => i.destroy());
        this._indicator.destroy();
        this._indicator = null;
        global.display.disconnect(this._restackId);
        global.workspace_manager.disconnect(this._wsId);
        Main.layoutManager.disconnect(this._monId);
        global.display.disconnect(this._fsId);
        if (this._raId) this._raCtl.disconnect(this._raId);
        this._shares?.clear();
        Main.overview.disconnect(this._ovShowId);
        Main.overview.disconnect(this._ovHideId);
        if (this._fsMode) { try { global.compositor.enable_unredirect(); } catch {} this._fsMode = false; }
        if (this._shotUiId) Main.screenshotUI.disconnect(this._shotUiId);
        this._shotMon?.cancel();
        this._shotMon = null;
        this._endDelivery(false);
        this._killTimer();
        for (const f of this._fx ?? []) f.actor.destroy();
        this._fx = [];
        this._hideCard();
        this._popup?.destroy();
        this._popup = null; this._popupMgr = null;
        this._menuAnchor?.destroy();
        this._menuAnchor = null;
        this._pet?.actor.destroy();
        this._pet = null;
        this._http?.abort();
        this._http = null;
        this._ballGrab?.dismiss();
        this._ballGrab = null;
        this._stopGame(false);
        this._removePeel();
        this._snake?.actor.destroy(); this._snake = null;
        for (const q of this._bullets ?? []) q.actor.destroy();
        this._bullets = [];
        this._grab?.dismiss();
        this._grab = null;
        this._area.destroy();
        this._area = null;
        this._b = null;
    }

    // Just above the wallpaper and the desktop-icons window, below every
    // normal window.
    _placeInStack() {
        if (!this._area || this._onTop || this._fsMode)
            return;   // above windows: nothing to keep in order
        // global.get_window_actors() leaves the desktop-icons windows out
        // (seen 14 Nov 2026), so walk the window group's children directly.
        let anchor = Main.layoutManager._backgroundGroup;
        for (const a of global.window_group.get_children()) {
            const w = a.get_meta_window?.();
            if (w && isDesktopWindow(w))
                anchor = a;
        }
        if (!anchor || anchor.get_parent() !== global.window_group)
            return;
        const kids = global.window_group.get_children();
        if (kids.indexOf(this._area) !== kids.indexOf(anchor) + 1)
            global.window_group.set_child_above_sibling(this._area, anchor);
        if (this._ball)
            global.window_group.set_child_above_sibling(this._ball.actor, this._area);
    }

    // The work area minus a visible dock on the left and a few pixels at the
    // bottom so the feet are not clipped by the screen edge.
    // The work area of the monitor it is on (primary until it has a position).
    _workArea() {
        let mon = Main.layoutManager.primaryIndex;
        const bx = this._b?.x;
        if (Number.isFinite(bx)) {
            const k = Main.layoutManager.monitors.findIndex(m => bx >= m.x && bx < m.x + m.width);
            if (k >= 0) mon = k;
        }
        return this._workAreaFor(mon);
    }

    _workAreaFor(mon) {
        const r = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(mon);
        let x = r.x, width = r.width;
        const dock = Main.uiGroup.get_children().find(a => a.name === 'dashtodockContainer');
        if (dock?.visible && dock.width < r.width / 3 && dock.x <= r.x + 4 && dock.x >= r.x - 4) {
            const right = dock.x + dock.width;
            if (right > x) { width -= right - x; x = right; }
        }
        return {x, y: r.y, width, height: r.height - 6};
    }

    // Ground plus the top edge of every visible window on the primary monitor.
    _terrain() {
        // Every monitor's floor is ground, and windows on every monitor are
        // terrain, so it can walk from one screen to the next.
        const wa = this._workArea();
        const ground = wa.y + wa.height;
        const surfaces = [];
        let ux0 = Infinity, ux1 = -Infinity;
        const monAreas = [];
        Main.layoutManager.monitors.forEach((_m, i) => {
            const a = this._workAreaFor(i);
            monAreas[i] = a;
            surfaces.push({x0: a.x, x1: a.x + a.width, top: a.y + a.height, id: null});
            ux0 = Math.min(ux0, a.x); ux1 = Math.max(ux1, a.x + a.width);
        });
        const bars = [], rects = [];
        const ws = global.workspace_manager.get_active_workspace();
        for (const a of global.get_window_actors()) {
            const w = a.get_meta_window();
            if (!w || w.minimized || !w.located_on_workspace(ws))
                continue;
            const type = w.get_window_type();
            if ((type !== Meta.WindowType.NORMAL && type !== Meta.WindowType.DIALOG) || isDesktopWindow(w))
                continue;
            const r = w.get_frame_rect();
            const wm = monAreas[w.get_monitor()] ?? wa;
            // A window flush with the top of its screen leaves no room to stand.
            if (r.y > wm.y + BH * S + 20 && r.y < wm.y + wm.height - 4)
                surfaces.push({x0: r.x, x1: r.x + r.width, top: r.y, id: w.get_id()});
            bars.push({x0: r.x, x1: r.x + r.width, bottom: r.y + r.height});
            rects.push({x0: r.x, x1: r.x + r.width, top: r.y, bottom: r.y + r.height, id: w.get_id()});
        }
        for (const ic of this._icons()) {
            if (ic.top > wa.y + BH * S + 20 && ic.top < ground - 4)
                surfaces.push(ic);
        }
        return {wa, ground, surfaces, bars, rects, ux0, ux1};
    }

    // Desktop folder and file icons, from the positions the desktop-icons
    // extension stores on each file (metadata::nautilus-icon-position,
    // relative to its own window). Standard size: a 120-px tile with the
    // 64-px icon centred near its top. The Home icon stores no position, so
    // it is not included. Re-read every 20 s.
    _icons() {
        const now = Date.now();
        if (this._iconCache && now - this._iconCache.at < 20000)
            return this._iconCache.list;
        const list = [];
        try {
            let ox = 0, oy = 0;
            const mon = global.display.get_monitor_geometry(Main.layoutManager.primaryIndex);
            for (const a of global.window_group.get_children()) {
                const w = a.get_meta_window?.();
                if (!w || !isDesktopWindow(w)) continue;
                const r = w.get_frame_rect();
                if (r.x >= mon.x - 2 && r.x < mon.x + mon.width) { ox = r.x; oy = r.y; break; }
            }
            const desk = Gio.File.new_for_path(GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DESKTOP));
            const en = desk.enumerate_children('standard::name,metadata::nautilus-icon-position', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = en.next_file(null))) {
                const pos = /^(-?\d+),(-?\d+)$/.exec(info.get_attribute_string('metadata::nautilus-icon-position') ?? '');
                if (!pos) continue;
                const x = ox + Number(pos[1]), y = oy + Number(pos[2]);
                list.push({x0: x + 28, x1: x + 92, top: y + 6, id: `icon:${info.get_name()}`, icon: true, name: info.get_name()});
            }
            en.close(null);
        } catch {}
        this._iconCache = {at: now, list};
        if (!this._iconLogged) {
            this._iconLogged = true;
            console.log(`desk-buddy: desktop icons ${JSON.stringify(list.map(i => [i.name, i.x0, i.top]))}`);
        }
        return list;
    }

    // Closest surface at or below the feet.
    _below(T, x, y) {
        let best = null;
        for (const s of T.surfaces) {
            if (x >= s.x0 && x <= s.x1 && s.top >= y - 2 && (best === null || s.top < best.top))
                best = s;
        }
        return best;
    }

    // Everyday chatter (tricks, reactions) shows only while "Chatty" is on in
    // the tile menu; things you need to know always show, via _note().
    _say(text, ms = 1800, speak = true, important = false) {
        if (!important && this._prefs?.chatty === false) return;
        this._bubble = {text, until: Date.now() + ms};
        // Important bubbles always babble; everyday ones most of the time.
        const touched = Date.now() - (this._lastTouch ?? 0) < TOUCH_QUIET_MS;
        if (speak && (important || (!touched && Math.random() < 0.7))) this._speak(text);
    }

    _note(text, ms = 3000, speak = true) { this._say(text, ms, speak, true); }

    // Says the bubble out loud in a robot voice. Same rules as the sounds:
    // off with the Buddy sounds toggle, silent under Do Not Disturb.
    // It "talks" in cute baby-bot babble (one of eight beep phrases), not words.
    _speak(text) {
        if (!this._indicator?.soundSwitch.state) return;
        if (this._notif && !this._notif.get_boolean('show-banners')) return;
        if (!/[a-z0-9]/i.test(text)) return;
        this._sound(`babble${1 + Math.floor(Math.random() * 10)}`);
    }
    _set(mode, secs = 0) {
        if (mode === 'chute' && this._b.mode !== 'chute') {
            Object.assign(this._b, {chuteAt: this._b.t, chuteJolt: false, chuteWindSaid: false, chuteSteer: 0, chuteFlare: 0, chuteSteerSaid: false});
        }
        if (this._b.mode !== mode && MODE_SOUND[mode]) this._sound(MODE_SOUND[mode]);
        if (mode === 'stay' && this._b.mode !== 'stay') this._b.stayStart = Date.now();
        this._b.mode = mode; this._b.actT = secs;
    }

    // Robot sounds. Off with the Buddy sounds toggle, and quiet while Do Not
    // Disturb is on (meetings, focus), except the focus-done chime.
    // A reminders-only rule was tried on 14 Nov 2026 and taken back the same
    // day at the user's request: every sound plays again. `essential` and
    // _remind's `_loud` flag are kept as markers of the must-hear sounds.
    _sound(name, essential = false) {
        void essential;
        if (!this._indicator?.soundSwitch.state || this._sharing) return;
        // Silent while you handle it: touching, dragging, stretching, throwing,
        // and the landing a few seconds after you let go.
        // Exceptions: falling ("whoa") and crying or getting hurt ("ouch") still
        // sound, so a drop, a throw or a hard pull is heard.
        if (Date.now() - (this._lastTouch ?? 0) < TOUCH_QUIET_MS && !name.startsWith('babble') &&
            name !== 'whoa' && name !== 'ouch' && !name.startsWith('cry')) return;
        if (this._notif && !this._notif.get_boolean('show-banners') && name !== 'happy' && name !== 'done') return;
        try {
            // Its little gibberish voice (sounds/<name>-voice.wav) first, then a
            // recorded effect (<name>.ogg), then the generated beep (<name>.wav).
            // Your own files in ~/.config/desk-buddy/sounds win over the built-in ones.
            const own = GLib.build_filenamev([GLib.get_user_config_dir(), 'desk-buddy', 'sounds']);
            const dir = GLib.build_filenamev([this.path, 'sounds']);
            const path = [[own, `${name}.ogg`], [own, `${name}.wav`],
                [dir, `${name}-voice.wav`], [dir, `${name}.ogg`], [dir, `${name}.wav`]]
                .map(([d, n]) => GLib.build_filenamev([d, n])).find(q => GLib.file_test(q, GLib.FileTest.EXISTS));
            if (!path) return;
            const f = Gio.File.new_for_path(path);
            // A sob is cancellable so letting go of it can cut the crying off
            // mid-sound (see _stopCrying); a long cry3 otherwise played on for
            // seconds after it was safe, e.g. while sliding in magnet mode.
            let cancel = null;
            if (name.startsWith('cry')) { this._crySound?.cancel(); cancel = this._crySound = new Gio.Cancellable(); }
            global.display.get_sound_player().play_from_file(f, 'Tiko', cancel);
        } catch {}
    }

    // 🫵 drawn through Pango so the colour emoji font renders in colour (the
    // Cairo toy text API can't). It grows with the jab, as if coming at you.
    _drawPointEmoji(cr, x, y, k) {
        if (!this._pointLayout) {
            this._pointLayout = PangoCairo.create_layout(cr);
            this._pointLayout.set_font_description(Pango.FontDescription.from_string('Noto Color Emoji 15'));
            this._pointLayout.set_text('🫵', -1);
        }
        const layout = this._pointLayout;
        PangoCairo.update_layout(cr, layout);
        const [, logical] = layout.get_pixel_extents();
        cr.save(); cr.translate(x, y); const z = 1 + 0.9 * k; cr.scale(z, z);
        cr.moveTo(-logical.width / 2, -logical.height / 2);
        PangoCairo.show_layout(cr, layout);
        cr.restore();
    }

    _stopCrying() {
        this._crySound?.cancel();
        this._crySound = null;
        this._b.scared = false;
    }

    _tick() {
        const b = this._b;
        // Calm modes run at a third of the frame rate; time-based physics
        // keeps everything moving at the right speed.
        const calm = CALM.has(b.mode) && !b.held && !this._press0 && !this._game && !this._ball && !this._bullets?.length;
        this._frame = (this._frame ?? 0) + 1;
        // Calm modes: about 7 fps; asleep, about 4 fps.
        if (calm && this._frame % (b.mode === 'sleep' ? 5 : 3) !== 0)
            return;
        const now = GLib.get_monotonic_time();
        const dt = Math.min(calm ? 0.3 : 0.08, (now - this._last) / 1e6);
        this._last = now;
        try {
            b.t += dt;
            // Window geometry is re-read every 400 ms, on every frame while it
            // stands on a window (so it rides along), and whenever the stack,
            // workspace or monitors change.
            const ms = Date.now();
            if (!this._T || this._terrainDirty || typeof b.on === 'number' || ms - (this._tT ?? 0) > 400) {
                this._T = this._terrain(); this._tT = ms; this._terrainDirty = false;
            }
            const T = this._T;
            // A grab, a reminder, a meeting or a reset took over mid-delivery.
            if (this._dv && (b.held || b.mode !== 'deliver' || this._sharing)) this._endDelivery(true);
            if (!b.held)
                this._step(T, dt);
            else if (!b.movieCarry)
                this._stepHeldFear(dt);
            if (this._ball)
                this._stepBall(T, dt);
            if (this._card)
                this._stepCard();
            if (this._bullets?.length)
                this._stepBullets(T, dt);
            if (this._peel)
                this._stepPeel(T, dt);
            if (b.fleeUntil || b.snakeAt)
                this._stepFlee();
            if (this._snake)
                this._stepSnake(T, dt);
            if (this._fx.length)
                this._fx = this._fx.filter(f => { const alive = f.step(dt, T); if (!alive) f.actor.destroy(); return alive; });
            if (this._pet)
                this._stepPet(T, dt);
            if (this._T === T && ms - (this._tHigh ?? 0) >= 250) { this._tHigh = ms; this._checkHighFive(T); }
            if (!Number.isFinite(b.x) || !Number.isFinite(b.y))
                throw new Error('position became invalid');
            const offOk = (b.wy?.offscreen && ['leave', 'scene', 'off', 'gone', 'peek', 'gone2', 'back'].includes(b.wy.phase)) ||
                (b.mode === 'coffeerun' && b.cr?.offscreen);
            if (!offOk) b.x = Math.max(T.ux0 + 20, Math.min(T.ux1 - 20, b.x));   // the watching-you exit leaves the screen
            if (this._area.visible) {
                // only move the actor when the pixel position changes
                const ax = Math.round(b.x - AW / 2), ay = Math.round(b.y - (AH - FOOT));
                if (ax !== this._ax || ay !== this._ay) { this._ax = ax; this._ay = ay; this._area.set_position(ax, ay); }
                this._area.queue_repaint();
            }
            // Mutter re-sorts window actors when it syncs the stack, which can
            // put the desktop-icons windows back on top of the buddy after the
            // 'restacked' handler ran, so the order is rechecked twice a second.
            if (ms - (this._tStack ?? 0) >= 500) { this._tStack = ms; this._placeInStack(); }
            if (ms - (this._tSec ?? 0) >= 1000) { this._tSec = ms; this._everySecond(); this._syncMovie(); }
            if (ms - (this._t5 ?? 0) >= 5000) { this._t5 = ms; this._every5s(); }
            if (ms - (this._tType ?? 0) >= 250) { this._tType = ms; this._checkTyping(); }
        } catch (e) {
            this._safeReset(e.message);
        }
    }

    // Typing, without reading a single key: the session keeps registering
    // input while the pointer stays put, which can only be the keyboard.
    _checkTyping() {
        let idle;
        try { idle = global.backend.get_core_idle_monitor().get_idletime(); } catch { return; }
        const [px, py] = global.get_pointer();
        const still = this._lastPtr && px === this._lastPtr[0] && py === this._lastPtr[1];
        // Wiggling the mouse fast (quick back-and-forth): it chases the pointer
        // and pounces on it (the cursor-thief leap), at most every 90 s.
        if (this._lastPtr) {
            const wdx = px - this._lastPtr[0], fast = Math.abs(wdx) > 220, flip = Math.sign(wdx) !== 0 && Math.sign(wdx) === -(this._wigSign ?? 0);
            this._wig = fast && flip ? (this._wig ?? 0) + 1 : Math.max(0, (this._wig ?? 0) - 0.5);
            if (fast) this._wigSign = Math.sign(wdx);
            const wb = this._b, nowW = Date.now();
            if (this._wig >= 4 && !this._game && !wb.held && wb.mode !== 'movie' && !this._focus && (PRIORITY[wb.mode] ?? 0) <= 20 && nowW > (this._chaseNext ?? 0)) {
                this._wig = 0; this._chaseNext = nowW + 90000;
                wb.home = false; wb.parked = false;
                this._game = {kind: 'follow', until: nowW + 8000, thief: true};
                this._say('Ooh! Something wiggly!', 1400);
            }
        }
        // Lazy wave: your pointer comes close while it lounges, it lifts a hand without getting up.
        {
            const lb = this._b, nowL = Date.now();
            if (!still && this._lazy() && ['sit', 'doze', 'daydream'].includes(lb.mode) && nowL > (this._lazyWaveNext ?? 0) &&
                Math.abs(px - lb.x) < 140 && Math.abs(py - (lb.y - 40 * S)) < 160) {
                this._lazyWaveNext = nowL + 40000;
                this._set('lazywave', 1.8); this._say('Hey.', 900, false);
            }
        }
        this._lastPtr = [px, py];
        const score = this._typeScore ?? 0;
        this._typeScore = idle < 350 && still ? Math.min(10, score + 1) : Math.max(0, score - (still ? 0.5 : 2));
        const b = this._b;
        const now = Date.now();
        // Movie night: typing never pulls it off the sofa. Keep typing for a few
        // seconds while the video plays and it shushes you, at most every 90 s.
        if (b.mode === 'movie') {
            const mv = b.movie;
            if (this._typeScore >= 6 && mv?.phase === 'watch' && !mv.doze && !mv.paused && !mv.react &&
                this._video?.status === 'Playing' && now > (mv.nextShh ?? 0)) {
                mv.nextShh = now + 90000;
                mv.react = {kind: 'shh', at: b.t, until: b.t + 2.5};
                this._say('Shhh! Movie on.', 1600, false);
            }
            if (this._typeScore >= 3) this._lastInteract = now;
            return;
        }
        if (this._typeScore >= 3) {
            this._lastInteract = now;   // you are here: no wandering off to nap
            if (b.mode !== 'typing' && !b.held && !b.ride && !this._game && (PRIORITY[b.mode] ?? 0) <= 20) {
                this._set('typing');
                b.typingSince = now;
            }
            // Fast for a few seconds in a row: the keyboard catches fire.
            b.fastSince = this._typeScore >= 9 ? (b.fastSince ?? now) : null;
            // Ten minutes of typing: it takes a coffee break for you.
            if (b.mode === 'typing' && now - (b.typingSince ?? now) > 10 * 60000) {
                this._set('coffee', 5); b.typingSince = null;
            }
        } else if (b.mode === 'typing' && this._typeScore <= 0.5) {
            this._set('walk'); b.typingSince = null; b.fastSince = null;
        }
    }

    // Held up high: it cries, louder and longer the higher it is (cry1-3,
    // the same sobs as a hard stretch), with a line for each new level.
    _stepHeldFear(dt) {
        const b = this._b, k = b.fearK ?? 0;
        const lvl = k < 0.3 ? 0 : k < 0.6 ? 1 : k < 0.85 ? 2 : 3;
        if (!lvl || (b.spin ?? 0) >= 1) { b.fearLvl = 0; b.fearSobT = 0; return; }
        b.fearSobT = (b.fearSobT ?? 0) - dt;
        if (lvl > (b.fearLvl ?? 0) || b.fearSobT <= 0) {
            if (lvl > (b.fearLvl ?? 0)) this._say(['', 'Uh oh… too high…', 'Waaah! Put me down!', 'HEEELP! TOO HIGH!'][lvl], 1800);
            this._sound(`cry${lvl}`);
            b.fearSobT = lvl === 3 ? 6.8 : lvl === 2 ? 2.5 : 1.7;   // each sob plays out before the next
        }
        b.fearLvl = lvl;
    }

    // Something went wrong (bad geometry, an unexpected error): put it back
    // on the ground, standing, with nothing half-finished, and remember why.
    _safeReset(reason) {
        const b = this._b;
        const wa = this._workArea();
        Object.assign(b, {x: Math.max(wa.x + 60, Math.min(wa.x + wa.width - 60, Number.isFinite(b.x) ? b.x : wa.x + 120)),
            y: wa.y + wa.height, vx: 0, vy: 0, held: false, on: null, limb: null, parts: null, loose: null,
            ride: null, spin: 0, spinAngle: 0, rise: 0, wait: 0});
        b.mode = 'walk'; b.actT = 0;
        this._T = null;
        const when = new Date().toLocaleTimeString();
        this._lastError = `${when}: ${reason}`;
        if (Date.now() - (this._lastErrorLog ?? 0) > 60000) {
            this._lastErrorLog = Date.now();
            console.error(`desk-buddy: recovered from: ${reason}`);
        }
    }

    _step(T, dt) {
        const b = this._b;
        this._updateEnergy(dt);
        // A grabbed limb wins over everything else (meetings, focus, walking).
        if (b.mode === 'stretched') {
            // sobbing sounds come faster the harder it cries
            if (b.stretchFace === 'cry') {
                b.sobT = (b.sobT ?? 0) - dt;
                if (b.sobT <= 0) {
                    const k = b.cryK ?? 0, lvl = k < 0.34 ? 1 : k < 0.67 ? 2 : 3;
                    this._sound(`cry${lvl}`);
                    b.sobT = lvl === 3 ? 6.8 : lvl === 2 ? 2.5 : 1.7;   // each cry plays out before the next
                }
            } else {
                b.sobT = 0;
            }
            return;
        }
        // Path tricks (hanging, sliding, swinging, the UFO…) finish before a
        // meeting or focus can take over, so it never stops mid-air.
        if (MOVING_TRICKS.has(b.mode)) { this._stepTrick(T, dt); return; }
        if (b.mode === 'snapback') {
            const L = LIMBS[b.limb.key];
            for (const k of [0, 1]) {
                const a = -180 * (b.limb.tip[k] - (b.limb.rest ?? L.rest)[k]) - 9 * b.limb.v[k];
                b.limb.v[k] += a * dt; b.limb.tip[k] += b.limb.v[k] * dt;
            }
            b.actT -= dt;
            if (b.actT > 0) return;
            const max = b.limb.max;
            b.limb = null;
            if (max < 25) { this._set('laugh', 2); this._say('Hehe, again!', 1800); }
            else if (max < 70) { this._set('angry', 2.4); this._say("Hey! Let go of me!", 2000); }
            else if (max < 120) { this._set('cry', 3); this._say('Owww… that hurt.', 2400); b.injury = {level: 1, until: Date.now() + 8000}; }
            else { this._set('angry', 3); this._say('Never do that again!', 2600); b.injury = {level: 2, until: Date.now() + 15000}; b.watchAfter = Date.now() + 3500; }
            return;
        }
        const half = BW * S / 2;
        // Meetings, and any Do Not Disturb the user turns on, make it sit still
        // and quiet. A focus block (its own Do Not Disturb) is handled below.
        const inMeeting = GLib.file_test(MEETING_MARKER, GLib.FileTest.EXISTS) ||
            (!this._focus && this._notif && !this._notif.get_boolean('show-banners'));

        // Fell below the ground (dropped past the bottom edge): dig back up.
        if (b.mode === 'emerge') {
            // stays down in the hole for a couple of seconds before climbing out
            if (b.wait > 0) { b.wait -= dt; return; }
            // Pulls itself up in heaves, slipping back a little between them.
            const heave = Math.max(0, Math.sin(b.t * 4));
            b.rise -= dt / 2.6 * (0.2 + heave * 1.8);
            if (b.rise <= 0) {
                b.rise = 0;
                this._set('sit', 1.6); this._say('Phew! Made it.', 1800); this._sound('boop');
            }
            return;
        }
        if (b.y > T.ground + 30) {
            b.y = T.ground; b.vy = 0; b.vx = 0; b.on = null; b.rise = 1; b.wait = 2.5;
            b.dropFrom = undefined;
            this._set('emerge'); this._bubble = {text: '', until: 0};   // no bubble while it's out of sight
            return;
        }

        // Riding a window: follow its top edge if it moves.
        if (b.on !== null && !['fall', 'jump', 'fly', 'climb', 'chute', 'thrown', 'parkour'].includes(b.mode)) {
            const s = T.surfaces.find(q => q.id === b.on);
            if (s && b.x >= s.x0 && b.x <= s.x1)
                b.y = s.top;
            else
                b.on = null;
        }

        // Thrown: flies, tumbling, bounces off the screen edges; the highest
        // point it reached decides parachute or injury, same rules as a drop.
        if (b.mode === 'thrown') {
            const prevY = b.y, wa = T.wa;
            b.vy += GRAV * dt; b.x += b.vx * dt; b.y += b.vy * dt;
            b.apex = Math.min(b.apex, b.y);
            b.spinAngle += b.vx * dt * 0.012;
            const left = T.ux0 + 22, right = T.ux1 - 22, top = wa.y + BH * S + 10;
            if (b.x < left || b.x > right) {
                b.x = b.x < left ? left : right; b.vx = -b.vx * 0.55;
                this._say('Bonk!', 700); this._sound('thud');
            }
            if (b.y < top) { b.y = top; b.vy = Math.abs(b.vy) * 0.4; this._say('Ow, ceiling!', 900); this._sound('thud'); }
            // Falling from high up: the parachute opens.
            if (b.vy > 0 && !b.chuteTried && T.ground - b.apex > wa.height * CHUTE_FROM && T.ground - b.y > wa.height * 0.3) {
                b.chuteTried = true; b.vx *= 0.3; b.spinAngle = 0;
                this._set('chute');
                return;
            }
            const s = this._below(T, b.x, prevY);
            if (s && b.y >= s.top && b.vy > 0) {
                const impact = Math.min(0.2, Math.abs(b.vx) / 6000);   // landing sideways at speed hurts more
                b.y = s.top; b.on = s.id; b.spinAngle = 0;
                const hv = b.vx; b.vx = 0; b.vy = 0;
                this._set('walk');
                if (Math.abs(hv) > 900) this._say('Skidded…', 900);
                const share = (s.top - b.apex) / wa.height + impact;
                this._landed(share);
                if (share < BUMP_FROM) {
                    this._stats.landings++; this._saveStats();
                    if (this._unlocked('acrobat')) { this._set('acrobat', 1); }
                }
                this._afterSpin();
            }
            return;
        }
        if (b.mode === 'fall' || b.mode === 'jump') {
            const prevY = b.y;
            b.vy += GRAV * dt; b.y += b.vy * dt; b.x += b.vx * dt;
            const s = this._below(T, b.x, prevY);
            if (s && b.y >= s.top && b.vy > 0) {
                b.y = s.top; b.vy = 0; b.vx = 0; b.on = s.id; this._set('walk');
                b.flip = false;
                if (b.kickflip) {
                    b.kickflip = false;
                    if (Math.random() < 0.3) { this._crash(); return; }
                    this._say('Nailed it!', 900);
                }
                if (b.jumpFor) {
                    const made = s.icon && b.jumpFor === 'icon';
                    if (made) {
                        this._set('dance', 2); this._say(`Made it! King of ${s.name}!`, 2400); b.iconTries = 0;
                    } else {
                        this._set('angry', 1.1);
                        this._say(b.iconTries >= 2 ? 'Hmph! One more time…' : 'Hup!… nope.', 1400);
                    }
                    b.jumpFor = null;
                }
                if (b.dropFrom !== undefined)
                    this._landed((s.top - b.dropFrom) / b.dropH);
                this._afterSpin();
                b.dropFrom = undefined;
            }
            return;
        }
        // Parachute: slow, swaying descent; on landing, pack it away and tease.
        if (b.mode === 'chute') {
            const prevY = b.y, since = b.t - (b.chuteAt ?? b.t);
            // It used to free-fall while unfurling and then snap to the glide
            // speed, which read as a very fast start (user, 16 Nov 2026). Now
            // the half-open canopy already drags, capping the fall, and once
            // open it eases down to the glide speed over about a second.
            if (since < CHUTE_UNFURL) {
                b.vy += GRAV * 0.5 * dt;
                if (b.vy > CHUTE_UNFURL_MAX) b.vy -= (b.vy - CHUTE_UNFURL_MAX) * Math.min(1, dt * 6);
            } else {
                b.chuteJolt = true;
                b.vy += (CHUTE_SPEED - b.vy) * Math.min(1, dt * 2.2);
            }
            // The wind carries it: a steady drift the way the wind blows (from
            // wttr.in, 6 px/s per km/h up to 180), and in a strong wind gusts
            // that lift it back up, so it can sail right across the screen.
            const wx2 = this._weather, wk = wx2?.windDir ? wx2.windKmh ?? 0 : 0;
            if (wk >= 8 && since > CHUTE_UNFURL) {
                b.x += wx2.windDir * Math.min(180, wk * 6) * dt;
                if (!b.chuteWindSaid) { b.chuteWindSaid = true; this._say(wk >= 15 ? 'Whoa, the wind!' : 'Wheee, a breeze!', 1400); }
                if (wk >= 15 && Math.random() < dt * 0.5) b.vy = Math.min(b.vy, -60 - Math.random() * 60);   // a gust lifts it
            }
            if (since > CHUTE_UNFURL && T) {
                // Steering: the toggles move smoothly toward where it wants to go.
                const [px, py] = global.get_pointer();
                const guide = px >= T.ux0 && px <= T.ux1 && py > b.y + 20;
                const want = guide ? Math.max(-1, Math.min(1, (px - b.x) / 120)) : 0;
                b.chuteSteer += (want - b.chuteSteer) * Math.min(1, dt * 3);
                b.x += b.chuteSteer * CHUTE_STEER * dt;
                if (guide && !b.chuteSteerSaid && Math.abs(want) > 0.35) { b.chuteSteerSaid = true; this._say('Steering to you!', 1300); }
                // Flare: the closer the surface below, the harder both toggles go down.
                const below = this._below(T, b.x, b.y);
                const gap = below ? below.top - b.y : Infinity;
                b.chuteFlare = Math.max(0, Math.min(1, 1 - gap / (CHUTE_FLARE_PX * S)));
                if (b.chuteFlare > 0) b.vy = Math.min(b.vy, CHUTE_SPEED * (1 - 0.65 * b.chuteFlare));
            }
            b.y += b.vy * dt;
            // drifts with the swing, further on a windy day
            b.x += Math.cos(since * CHUTE_SWING) * (this._weather?.windy ? 55 : 22) * dt;
            if (T) b.x = Math.max(T.ux0 + 30, Math.min(T.ux1 - 30, b.x));   // the screen edge stops the drift
            const s = this._below(T, b.x, prevY);
            if (s && b.y >= s.top) {
                b.y = s.top; b.vy = 0; b.on = s.id;
                // Touchdown: knees bend, a puff of dust, a soft thud.
                b.chuteDustUntil = Date.now() + 500;
                this._sound('thud');
                this._set('chuteland', 1.1);
                this._stats.landings++; this._saveStats();
                this._afterSpin();
            }
            return;
        }
        if (b.mode === 'climb' || b.mode === 'fly') {
            const rate = b.mode === 'climb' ? CLIMB : FLY;
            b.y = Math.max(b.target, b.y - rate * dt);
            if (b.y <= b.target) {
                b.x += b.dir * (half + 4);
                const s = this._below(T, b.x, b.y);
                b.on = s?.id ?? null;
                if (s) b.y = s.top;
                this._set('walk');
            }
            return;
        }

        // In a meeting it sits quietly, but still waves back when clicked.
        if (inMeeting && !b.home) {
            if (['wave', 'poked', 'dizzy'].includes(b.mode)) {
                b.actT -= dt;
                if (b.actT > 0)
                    return;
            }
            if (b.mode !== 'meeting') {
                this._set('meeting');
                this._say(GLib.file_test(MEETING_MARKER, GLib.FileTest.EXISTS) ? 'Shh, meeting.' : 'Shh, quiet mode.', 1500, false);
            }
            return;
        }
        if (b.mode === 'meeting') this._set('walk');

        // Focus block: sits with glowing headphones, still reacts briefly.
        if (this._focus && !b.home) {
            if (['wave', 'dance', 'watch', 'alert', 'wake', 'poked', 'dizzy', 'stay'].includes(b.mode)) {
                b.actT -= dt;
                if (b.actT > 0 || b.mode === 'stay') return;
            }
            if (b.mode !== 'focus') this._set('focus');
            return;
        }
        if (b.mode === 'focus') this._set('walk');

        // Scroll timer: it stays at its build site; quick reactions (a poke,
        // a wave) play out first. After a meeting or focus it comes back here.
        if (this._timerLive()) {
            if (b.mode !== 'timer') {
                if (['wave', 'dance', 'watch', 'alert', 'wake', 'poked', 'dizzy'].includes(b.mode) && (b.actT -= dt) > 0) return;
                this._set('timer');
            }
            this._timerWalk(dt);
            return;
        }
        if (b.mode === 'timer') this._set('walk');
        if (b.mode === 'timerdone') { b.actT -= dt; if (b.actT <= 0) this._set('walk'); return; }

        // After the meeting and focus checks, so either of them ends a delivery.
        if (b.mode === 'deliver') { this._stepDelivery(dt); return; }

        if (b.mode === 'prejump') {
            b.actT -= dt;
            if (b.actT > 0) return;
            const tgt = b.iconTarget;
            const height = Math.max(10, b.y - tgt.top + 6);
            const odds = (b.energy ?? 100) < 40 ? 0.15 : 0.4;
            const made = b.iconTries >= 3 || Math.random() < odds;
            b.vy = -Math.sqrt(2 * GRAV * height) * (made ? 1.12 : 0.72);
            b.vx = made ? b.dir * 75 : 0;
            b.on = null; b.jumpFor = made ? 'icon' : 'fail';
            b.energy = Math.max(0, (b.energy ?? 100) - 4);
            this._set('jump');
            return;
        }
        if (b.mode === 'broken')
            this._stepParts(dt);
        if (b.loose)
            this._stepLoose(dt);
        if (['sleep', 'stay', 'wake', 'dance', 'wave', 'sit', 'dizzy', 'poked', 'look', 'tease', 'knocked', 'broken', 'watch', 'alert', 'tumble', 'cry', 'shy', 'laugh', 'angry', 'love',
            'coffee', 'book', 'polish', 'doze', 'phones', 'detective', 'fakesleep', 'selfie', 'peek', 'laughattack',
            'freeze', 'ghost', 'clones', 'army', 'disco', 'rebel', 'boing', 'trampoline', 'dizzydance', 'acrobat', 'smoke', 'banana', 'shoot', 'typing', 'clean', 'gum', 'plane', 'sneeze', 'fish', 'paint',
            'highfive', 'pose', 'juggle', 'guitar', 'bedtime', 'snowball', 'magic', 'kite', 'command', 'fort', 'hiccups', 'cake',
            'raindance', 'tailchase', 'mimewall', 'derp', 'movie', 'chuteland', 'watchingyou', 'coffeerun', 'party', 'lunch', 'splash', 'danceoff', 'stretch', 'weekend', 'mime', 'hide', 'nightowl', 'hammock', 'bellyup', 'clouds', 'snackbed', 'yawnflop', 'remote', 'sunbathe', 'daydream', 'lazywave', 'roll', 'pillownap', 'burrito', 'lazyfish', 'lean', 'charging', 'sleepyread', 'bubbles', 'snore', 'pool', 'fivemore', 'drape', 'edgeblanket', 'slowwalk', 'pizza', 'lazydance', 'coffeedrip', 'sheep', 'rocking', 'screensaver', 'petnap'].includes(b.mode)) {
            if (b.mode === 'pizza') b.pizzaT = (b.pizzaT ?? 0) + dt;
            if (b.mode === 'slowwalk') {   // a few steps at quarter speed, then it gives up
                const T2 = this._T, nx = b.x + b.dir * 12 * dt;
                if (T2 && nx > T2.ux0 + 30 && nx < T2.ux1 - 30 && this._below(T2, nx, b.y - 4)?.top === b.y) { b.x = nx; b.dist = (b.dist ?? 0) + 12 * dt; }
                if (b.actT - dt <= 0) { this._set('sit', 8 + Math.random() * 6); this._say('Too much effort.', 1400, false); return; }
            }
            if (b.mode === 'coffeedrip' && b.actT - dt <= 0) { this._set('coffee', 6); this._say('Finally.', 1200, false); return; }
            if (b.mode === 'sheep') {   // counting until it nods off
                b.sheepT = (b.sheepT ?? 0) + dt;
                const n = Math.floor(b.sheepT / 2.6);
                if (n > (b.sheepN ?? 0) && n <= 5) { b.sheepN = n; this._say(n < 5 ? `${n}…` : 'zzz', 1200, false); }
            }
            if (b.mode === 'sleepyread' && !b.readDur) b.readDur = b.actT;   // the picker stretches durations; remember the real one
            if (b.mode === 'fivemore' && b.actT - dt <= 0) {   // ...and rolls away from you
                const away = Math.sign(b.x - global.get_pointer()[0]) || 1;
                b.rollTo = b.x + away * 90; b.rollAng = 0; this._set('roll', 30); return;
            }
            if (b.mode === 'roll') { this._stepRoll(dt); if (b.mode !== 'roll') return; }
            if (b.mode === 'yawnflop' && b.actT - dt <= 0) { this._set('bellyup', 12 + Math.random() * 10); return; }   // flops over and stays there
            if (b.mode === 'lazywave' && b.actT - dt <= 0) { this._set('sit', 6 + Math.random() * 6); return; }
            if (b.mode === 'mime') this._stepMime(dt);
            if (b.mode === 'watchingyou') this._stepWatching(dt);
            if (b.mode === 'coffeerun') this._stepCoffeeRun(dt);
            if (b.mode === 'hide' && b.actT - dt <= 0) { this._set('laugh', 2); this._say("You didn't find me! Hehe.", 2200); return; }
            if (b.mode === 'stretch' && !b.jacksSaid && b.actT < 3.4) { b.jacksSaid = true; this._say('One, two! One, two!', 1800); }
            if (b.mode === 'party') this._stepParty();
            if (b.mode === 'danceoff') { this._stepDanceoff(dt); if (b.mode !== 'danceoff') return; }
            if (b.mode === 'lunch' && b.actT - dt <= 0) { this._set('doze', 25); this._say('Food coma… zzz', 1800); return; }
            if (b.mode === 'chuteland' && b.actT - dt <= 0) { this._set('tease', 2.6); this._say('Nailed it. Hehe.', 2400); return; }
            if (b.mode === 'movie') { this._stepMovie(dt); return; }
            if (b.mode === 'tailchase') {
                // spins round and round after a tail it does not have
                b.flipT = (b.flipT ?? 0) + dt;
                if (b.flipT > 0.22) { b.flipT = 0; b.dir *= -1; }
                if (b.actT - dt <= 0) { this._set('dizzy', 1.8); this._say('Where did it go?', 1200); return; }
            }
            if (b.mode === 'snowball' && (b.throws ?? 0) < 3 && b.actT < 3.6 - b.throws * 1.1) { b.throws++; this._throwSnowball(); this._sound('chirp'); }
            if (b.mode === 'hiccups') {
                b.hicT = (b.hicT ?? 0) + dt;
                if (b.hicT > 0.9) { b.hicT = 0; b.hicAt = b.t; this._say('hic!', 500); this._sound('boop'); }
            }
            if (b.mode === 'fort' && b.actT - dt <= 0) { this._say('Crash!', 900); this._sound('thud'); }
            if (b.mode === 'magic' && b.actT < 1.2 && !b.rabbit) {
                b.rabbit = true;   // "something has come out of the hat"
                switch (b.magicItem) {
                case 'snake':   // stays put (world position) while it runs away
                    b.snakeAt = {x: b.x + b.dir * 26 * S, y: b.y, at: b.t};
                    this._sound('whoa'); this._say('SNAKE?!', 900); break;
                case 'dove': this._sound('chirp'); this._say('A dove!', 900); break;
                case 'flowers': this._sound('happy'); this._say('Aww, for me?', 1200); break;
                case 'bomb': this._sound('alert'); this._say('Uh oh…', 1000); break;
                case 'empty': this._sound('boop'); this._say('Huh? Empty?', 1100); break;
                case 'confetti': this._sound('happy'); this._say('Party!', 900); break;
                default: this._sound('done');
                }
            }
            if (b.mode === 'magic' && b.magicItem === 'snake' && b.rabbit && b.actT < 0.5) { b.magicItem = null; this._spawnSnake(); this._startFlee(); return; }
            if (b.mode === 'magic' && b.rabbit && b.actT - dt <= 0) {
                const item = b.magicItem; b.magicItem = null;
                if (item === 'dove') { this._set('wave', 1.6); this._say('Fly free!', 1100); return; }
                if (item === 'flowers') { this._set('love', 2.2); return; }
                if (item === 'bomb') { this._set('knocked', 2.2); this._say('BOOM! …ow.', 1400); this._sound('thud'); return; }
                if (item === 'empty') { this._set('look', 1.4); this._say('Tough crowd.', 1100); return; }
                if (item === 'confetti') { this._set('dance', 2.2); return; }
            }
            if (b.mode !== 'magic') b.rabbit = false;
            // The miss: in the last second one ball goes up too high and lands on
            // its head; the "Ow" comes at the moment it hits, not afterwards.
            if (b.mode === 'juggle' && b.dropBall && !b.dropHit && b.actT < JUGGLE_DROP_S * 0.4) {
                b.dropHit = true; this._sound('thud'); this._say('Ow, my head!', 1200);
            }
            if (b.mode === 'juggle' && b.actT - dt <= 0 && b.dropBall) {
                b.dropBall = false; b.dropHit = false; this._set('poked', 1);   // rubs its head a moment
                return;
            }
            if (b.mode === 'guitar' && b.actT - dt <= 0) {
                // big finish: a jump with the last chord
                b.vy = -380; b.vx = 0; b.on = null; this._set('jump'); this._sound('happy');
                return;
            }
            if (b.mode === 'bedtime' && b.actT - dt <= 0) {
                b.nightcap = true; this._set('sleep');
                return;
            }
            if (b.mode === 'plane' && !b.planeThrown && b.actT < 1) { b.planeThrown = true; this._throwPlane(); this._sound('chirp'); }
            if (b.mode === 'fish' && !b.caught && b.actT < 1.6) {
                b.caught = true;
                const r = Math.random(); b.catch = r < 0.35 ? 'boot' : r < 0.85 ? 'fish' : 'star';
                this._say({boot: '…a boot.', fish: 'A fish! 🐟', star: 'A star?! ⭐'}[b.catch], 1500);
                this._sound(b.catch === 'boot' ? 'boop' : 'happy');
            }
            if (b.mode === 'gum' && !b.popped && b.actT < 1.1) { b.popped = true; this._sound('pop'); }   // sounds/pop.wav: a synthesised bubble burst
            if (b.mode === 'sneeze' && b.actT - dt <= 0) {
                // ACHOO: blown backwards
                this._say('ACHOO!', 1000); this._sound('whoa');
                b.vx = -b.dir * 260; b.vy = -180; b.on = null; this._set('fall');
                return;
            }
            if (b.mode === 'shoot' && !b.fired && b.actT < 1.1) {
                // Aim, then fire: usually a bullet flies off across the screen;
                // one time in four a "BANG!" flag pops out of the barrel instead.
                b.fired = true;
                if (Math.random() < 0.25) { b.bangFlag = true; this._sound('boop'); }
                else { this._fireBullet(); this._sound('pew'); }
            }
            if (b.mode === 'banana' && b.actT - dt <= 0) {
                // tosses the peel on the ground behind it, then grins
                this._throwPeel();
                this._set('tease', 1.6);
                return;
            }
            if (b.actT - dt <= 0) {
                const end = {fakesleep: "I wasn't sleeping!", freeze: 'Gotcha!', ghost: '…boo.', acrobat: 'Ta-da!',
                    detective: 'Case closed.', laughattack: '…phew.'}[b.mode];
                if (end) this._say(end, 1400);
                if (b.mode === 'freeze') { b.vy = -320; b.vx = 0; b.on = null; this._set('jump'); return; }
            if (b.mode === 'wave' && b.afterWave) { const r = b.afterWave; b.afterWave = null; this._set(r, 2.5); return; }
                if (b.mode === 'rebel') { b.parked = true; this._set('stay'); this._say("Fine… I'll stay.", 1600); return; }
            }
            if (b.mode === 'doze' && b.actT - dt <= 0) this._say("Huh? I'm awake!", 1400);
            if (b.mode === 'tumble' && b.actT - dt <= 0) {
                // how it takes the fall: cry, get shy, laugh it off or get cross
                const r = b.forceReaction ?? Object.keys(REACTIONS)[Math.floor(Math.random() * 4)];
                b.forceReaction = null;
                this._set(r, 3.6); this._say(REACTIONS[r], 3400);
                if (r === 'cry') b.injury = {level: 1, until: Date.now() + 8000};
                return;
            }
            if (b.mode === 'broken' && b.actT - dt <= 0) {
                b.parts = null; this._say('All back together… ouch.', 2200); this._sound('boop');
                b.actT = 0; this._set('sit', 1.6);
                return;
            }
            if (b.mode === 'knocked' && b.actT - dt <= 0) {
                if (b.afterKnock) {
                    // came round after slipping on the peel: embarrassed
                    const r = b.afterKnock; b.afterKnock = null; b.forceReaction = null;
                    this._set(r, 3.6); this._say(REACTIONS[r], 3400);
                    return;
                }
                // gets back up, still wobbly
                b.stagger = Date.now() + 6000; this._say('Whoa… what happened?', 2200);
            }
            // Told to stay: waits, sits after 20 s, lies down to sleep after a minute.
            if (b.mode === 'stay' && Date.now() - (b.stayStart ?? Date.now()) > STAY_SLEEP_S * 1000) {
                b.home = false; this._set('sleep');
                return;
            }
            if (b.mode === 'sleep' && !b.parked && !b.held) {
                const hr = new Date().getHours();
                if ((hr >= 22 || hr < 6) && Math.random() < dt * 0.003) {
                    // gets up and sleepwalks for a while, then goes back to bed
                    b.sleepwalkUntil = Date.now() + 9000; b.home = false; this._set('walk');
                    return;
                }
            }
            if (b.mode === 'sleep' || b.mode === 'stay' || b.mode === 'typing') return;
            b.actT -= dt;
            if (b.actT <= 0) this._set('walk');
            return;
        }

        // Left alone: walk to the nearest bottom corner and nap there.
        const nowMs = Date.now();
        // Parked: after any interruption (a reminder, a meeting, a drop, a nap)
        // it returns to the waiting pose on its spot instead of wandering off.
        if (b.parked && !this._game) { this._set('stay'); return; }
        // Tiredness: rests when nearly flat, heads off to nap when empty.
        if ((b.energy ?? 100) < 5 && !b.home) { b.home = true; this._say('Battery empty… nap time.', 2400); }
        if ((b.energy ?? 100) < 12 && !b.home && b.mode === 'walk') {
            b.ride = null; b.runUntil = 0;
            this._set('sit', 8); this._say('So tired… need a rest.', 2400);
            return;
        }
        if (!b.home && nowMs - this._lastInteract > IDLE_MS) b.home = true;
        let homeX = null;
        if (b.home) {
            homeX = b.x < T.wa.x + T.wa.width / 2 ? T.wa.x + 40 : T.wa.x + T.wa.width - 40;
            b.dir = homeX > b.x ? 1 : -1;
            const onGround = this._below(T, b.x, b.y - 4)?.id === null && Math.abs(b.y - T.ground) < 1;
            if (!onGround && Math.abs(homeX - b.x) < 4) { b.vy = 0; b.vx = 0; this._set('fall'); return; }
            if (onGround && Math.abs(homeX - b.x) < 2) {
                b.x = homeX;
                const hr = new Date().getHours(), day = new Date().toDateString();
                if ((hr >= 22 || hr < 6) && this._bedDay !== day) {
                    // night: brush teeth, pyjamas and nightcap, blanket, then sleep
                    this._bedDay = day; this._set('bedtime', 6); this._say('Bedtime. Good night!', 1800);
                } else {
                    this._set('sleep');
                }
                return;
            }
        } else if (this._game) {
            // Playing: chase the ball, or follow the pointer.
            if (nowMs > this._game.until || (b.energy ?? 100) < 15) {
                this._stopGame(true);
                return;
            }
            const [px, py] = global.get_pointer();
            const tx = this._game.kind === 'ball' ? this._ball?.x : px;
            if (tx !== undefined) {
                const dx = tx - b.x;
                if (this._game.thief && Math.abs(dx) < 40) {
                    // Cursor thief: leaps straight at the pointer. The old fixed
                    // hop only rose ~50 px, so it never got near a pointer that
                    // sat higher up. Now the jump is sized to the pointer's
                    // height, capped at a third of the screen so the landing
                    // stays a bump and never an injury.
                    const wa = this._workArea();
                    const need = b.y - BH * S - py;            // head to pointer
                    const h = Math.max(30, Math.min(need + 10, wa.height * 0.33));
                    b.vy = -Math.sqrt(2 * GRAV * h);
                    b.vx = Math.max(-300, Math.min(300, dx / (-b.vy / GRAV)));
                    b.on = null; this._set('jump');
                    const caught = need + 10 <= wa.height * 0.33;
                    this._say(caught ? 'Got it!' : 'Too high! …nope.', 1400);
                    if (caught) this._sound('happy');
                    this._stats.cursor++; this._saveStats();
                    this._game = null;
                    return;
                }
                if (this._game.kind === 'follow' && Math.abs(dx) < 40) {
                    if (b.mode !== 'look') this._set('look', 0.6);
                    return;
                }
                if (Math.abs(dx) > 10) { b.dir = dx > 0 ? 1 : -1; b.runUntil = nowMs + 400; }
            }
        } else if (nowMs > this._nextAct && !(b.injury && b.injury.level === 2 && nowMs < b.injury.until)) {
            const range = ACTIVITY[this._prefs?.activity ?? 'normal'];
            this._nextAct = range ? nowMs + (this._lazy() ? Math.max(40000, (range[0] * (0.5 + Math.random()) + Math.random() * (range[1] - range[0])) * 4)   // lazy: at least 40 s apart, whatever the Activity level
                : range[0] * (0.5 + Math.random()) + Math.random() * (range[1] - range[0])) : nowMs + 60000;
            if (range) {
                this._pickActivity();
                return;
            }
        }

        // Wandering: instead of pacing edge to edge, it picks a random spot a
        // short or long way off, at its own pace; on arrival it may stop for a
        // look around, sit a moment, or just set off somewhere else. Now and
        // then it changes its mind halfway.
        if (!b.home && !this._game) {
            const arrived = b.wanderX !== undefined && Math.abs(b.wanderX - b.x) < 12;
            if (Date.now() < (b.wanderLock ?? 0)) {
                // a menu walk is on: keep going the chosen way
            } else if (b.wanderX === undefined || arrived || Math.random() < dt * (this._lazy() ? 0.02 : 0.07)) {
                const onRide = !!b.ride && Date.now() < b.ride.until;
                const lazy = this._lazy();
                if (arrived && !onRide && Math.random() < (lazy ? 0.85 : 0.55)) {
                    b.wanderX = undefined;
                    const r = Math.random();
                    if (lazy) {   // flops down for a good while
                        if (r < 0.45) this._set('sit', 8 + Math.random() * 12);
                        else if (r < 0.75) this._set('doze', 10 + Math.random() * 15);
                        else this._set('look', 3 + Math.random() * 4);
                        return;
                    }
                    if (r < 0.5) this._set('look', 0.6 + Math.random() * 2.6);
                    else if (r < 0.75) this._set('sit', 1 + Math.random() * 2.5);
                    else { b.dir *= -1; this._set('look', 0.4 + Math.random()); }
                    return;
                }
                if (lazy && !onRide && Math.random() < 0.7) {   // lazy: usually just stays where it is
                    b.wanderX = undefined;
                    const r2 = Math.random();
                    if (r2 < 0.5) this._set('sit', 8 + Math.random() * 12);
                    else if (r2 < 0.8) this._set('doze', 10 + Math.random() * 15);
                    else this._set('look', 3 + Math.random() * 4);
                    return;
                }
                const span = lazy ? 60 + Math.random() * 220 : 80 + Math.random() * (Math.random() < 0.7 ? 350 : 900);
                const side = Math.random() < 0.5 ? -1 : 1;
                b.wanderX = Math.max(T.ux0 + 40, Math.min(T.ux1 - 40, b.x + side * span));
                if (lazy && !onRide && b.on === null && Math.random() < 0.5) {   // too lazy to walk: rolls over and over to get there
                    b.rollTo = b.wanderX; b.rollAng = 0; b.wanderX = undefined;
                    this._set('roll', 30);
                    return;
                }
                b.speedMul = lazy ? 0.45 + Math.random() * 0.3 : 0.6 + Math.random() * 0.65;   // lazy: an amble
            }
            b.dir = b.wanderX > b.x ? 1 : -1;
        }

        // Turn at the edges of the work area.
        if (b.x <= T.ux0 + 24) b.dir = 1;
        if (b.x >= T.ux1 - 24) b.dir = -1;

        // Riding a skateboard or bike: at the end it either hops off or wipes out.
        const riding = !!b.ride && Date.now() < b.ride.until && !b.home;
        if (riding && b.ride.kind === 'skate' && b.mode === 'walk' && Math.random() < dt * 0.25) {
            b.kickflip = true; b.vy = -300; b.vx = b.dir * SPEED * 2; b.on = null;
            this._set('jump'); this._say('Kickflip!', 900);
            return;
        }
        if (b.ride && !riding) {
            if (!b.home && Math.random() < 0.45) { this._crash(); return; }
            b.ride = null;
            if (!b.home) this._say('Fun!', 1200);
        }

        const aheadX = b.x + b.dir * (half + 4);
        // A window edge ahead: climb it, fly up to it, or (very tall) walk on behind it.
        const wall = T.surfaces.find(s => aheadX >= s.x0 && aheadX <= s.x1 && !(b.x >= s.x0 && b.x <= s.x1) &&
            s.top < b.y - 6 && b.y - s.top <= MAX_FLY);
        if (wall && riding) { this._crash(); return; }   // rode straight into a window
        const sleepwalking = Date.now() < (b.sleepwalkUntil ?? 0);
        if (wall && sleepwalking) {
            // bumps into the window, turns round, sleeps on
            b.dir *= -1; b.wanderX = undefined; this._sound('thud'); this._say('Zzz… bonk.', 900);
            return;
        }
        if (b.sleepwalkWas && !sleepwalking) { b.sleepwalkWas = false; b.home = true; }
        if (sleepwalking) b.sleepwalkWas = true;
        if (wall && wall.icon && !b.home) {
            // A desktop icon ahead: crouch and try to jump onto it.
            b.iconTarget = wall; b.iconTries = (b.iconTries ?? 0) + 1;
            this._set('prejump', 0.45);
            return;
        }
        if (wall && !b.home) {
            b.target = wall.top;
            this._set(b.y - wall.top <= MAX_CLIMB ? 'climb' : 'fly');
            return;
        }
        const ahead = this._below(T, aheadX, b.y);
        if (ahead && ahead.top > b.y + 6 && (this._below(T, b.x + b.dir * 2, b.y)?.top ?? b.y) > b.y + 6) {
            if (riding) b.ride = null;  // rode off a ledge: lands without the ride
            // Jumping off a desktop icon uses the same height rules as your
            // drops: parachute from very high, otherwise injuries by height.
            const fromIcon = typeof b.on === 'string' && b.on.startsWith('icon:');
            const share = (ahead.top - b.y) / T.wa.height;
            b.vx = b.dir * SPEED * 0.7; b.vy = -140; b.on = null;
            if (fromIcon && share > CHUTE_FROM) {
                b.vy = 0; this._set('chute'); this._say('Geronimo! Parachute!', 1400);
            } else {
                if (fromIcon) {
                    b.dropFrom = b.y; b.dropH = T.wa.height;
                    if (share >= HURT_FROM) this._say("Uh oh, that's high…", 1200);
                }
                this._set('fall');
            }
            return;
        }
        // A window bottom hanging just above the head: duck under it.
        const bar = T.bars.find(r => b.x + half * 0.7 > r.x0 && b.x - half * 0.7 < r.x1 &&
            r.bottom < b.y - 4 && r.bottom > b.y - (BH + 10) * S);
        const room = bar ? (b.y - bar.bottom - 3) / S : Infinity;
        const want = Math.max(0.5, Math.min(1, room / BH));
        b.squash += (want - b.squash) * Math.min(1, dt * 10);
        this._set(want < 1 ? 'duck' : 'walk');
        // Ninja: runs, and now and then does a front flip.
        if (nowMs < (b.ninjaUntil ?? 0) && b.mode === 'walk' && !riding) {
            b.runUntil = nowMs + 300;
            if (Math.random() < dt * 0.5) {
                b.vy = -380; b.vx = b.dir * SPEED * 1.6; b.on = null; b.flip = true; b.flipStart = b.t;
                this._set('jump'); this._sound('chirp');
                return;
            }
        }
        const limping = b.injury && b.injury.level === 2 && nowMs < b.injury.until;
        const wobbly = Date.now() < (b.stagger ?? 0);
        const running = !limping && !wobbly && !b.home && Date.now() < (b.runUntil ?? 0);
        let dx = b.dir * SPEED * (want < 1 ? 0.6 : 1) * (limping ? 0.45 : 1) * (wobbly ? 0.6 + Math.sin(b.t * 6) * 0.5 : 1) *
            (running && !riding ? RUN_SPEED : 1) * (riding ? (b.ride.kind === 'bike' ? 3 : 2.6) : 1) *
            (running ? 1 : GAIT[this._gaitMood()].speed) *   // tired and hurt walk slowly too (see _gaitMood)
            (Date.now() < (b.moonUntil ?? 0) ? 0.7 : Date.now() < (b.backUntil ?? 0) ? 0.6 : 1) *
            (b.speedMul ?? 1) * (Date.now() < (b.sleepwalkUntil ?? 0) ? 0.4 : 1) * dt;
        if (homeX !== null && Math.abs(homeX - b.x) < Math.abs(dx)) dx = homeX - b.x;
        b.x += dx;
        b.dist = (b.dist ?? 0) + Math.abs(dx);
        const peel = this._peel;
        if (peel && !peel.flying && Math.abs(peel.y - b.y) < 6) {
            const side = Math.sign(b.x - peel.x) || peel.side;
            if (side !== peel.side) {
                peel.side = side;
                peel.passes++;
                // It gets away with it a couple of times, then slips: flat on its
                // back, and shy when it comes round.
                if (peel.passes >= peel.slipAfter) {
                    this._removePeel();
                    b.forceReaction = 'shy';
                    if (riding) { this._crash(); return; }
                    b.afterKnock = 'shy';
                    this._set('knocked', 2); this._sound('whoa'); this._say('Whoaaa—!', 900);
                    return;
                }
            }
        }
        const ball = this._ball;
        if (this._game?.kind === 'ball' && ball && !ball.held && !ball.carried && Math.abs(ball.x - b.x) < 24 &&
            Math.abs(ball.y - (b.y - 10)) < 34 && Date.now() - (ball.kickedAt ?? 0) > 600) {
            ball.kickedAt = Date.now();
            ball.vx = b.dir * (350 + Math.random() * 350); ball.vy = -(300 + Math.random() * 300);
            this._say(['Kick!', 'Goal!', 'Got it!', 'Wheee!'][Math.floor(Math.random() * 4)], 900);
            this._sound('chirp');
            b.energy = Math.max(0, (b.energy ?? 100) - 2);
        }
        const under = this._below(T, b.x, b.y);
        if (under) { b.y = under.top; b.on = under.id; }
    }

    _singleClick(head = false) {
        const b = this._b;
        if (!b) return;
        if (b.mode === 'hide') { this._set('dance', 2.2); this._say('Found me! 🎉', 1600); this._sound('happy'); return; }
        // Lounging and you poke it: often it lifts one finger and rolls away.
        if (this._wasLazy && Math.random() < 0.6 && b.on === null &&
            ['sit', 'doze', 'bellyup', 'clouds', 'pillownap', 'snore', 'sunbathe', 'daydream', 'charging', 'lean', 'remote', 'burrito'].includes(b.mode)) {
            this._set('fivemore', 1.8); this._say('Five more minutes…', 1600);
            return;
        }
        if (head && !['fall', 'jump', 'climb', 'fly', 'chute', 'emerge', 'thrown', 'sleep'].includes(b.mode)) {
            this._set('boing', 1.2); this._say('Boing!', 900); this._sound('boop');
            return;
        }
        if (b.mode !== 'stay' && b.mode !== 'rebel' && !b.parked && Math.random() < 0.08) {
            // a playful refusal; it always gives in
            this._set('rebel', 2.2); this._say('Nope. Not staying.', 1600);
            return;
        }
        // Parked stays parked through reminders, meetings, naps and drops; only
        // this click (or a menu walk or game) sends it off again.
        if (b.mode === 'hiccups') {
            this._set('poked', 1); this._say('Eek! …oh, they are gone. Thanks!', 1800);
            return;
        }
        if (b.mode === 'stay' || b.parked) {
            b.parked = false;
            this._set('wave', 1.2); this._say('Off I go!', 1400); this._sound('chirp');
        } else if (!['fall', 'jump', 'climb', 'fly', 'chute', 'emerge', 'knocked', 'broken', 'thrown'].includes(b.mode)) {
            b.home = false; b.parked = true; this._set('stay'); this._say('OK, staying here.', 1600);
        }
    }

    // --- productivity --------------------------------------------------------

    _setFocusDnd(on) {
        try {
            const marked = GLib.file_test(FOCUS_MARKER, GLib.FileTest.EXISTS);
            if (on && !marked && this._notif.get_boolean('show-banners')) {
                this._notif.set_boolean('show-banners', false);
                GLib.file_set_contents(FOCUS_MARKER, '1');
            } else if (!on && marked) {
                this._notif.set_boolean('show-banners', true);
                Gio.File.new_for_path(FOCUS_MARKER).delete(null);
            }
        } catch (e) {
            console.error(`desk-buddy: focus do not disturb: ${e.message}`);
        }
    }

    _toggleFocus(minutes = FOCUS_MIN) {
        if (this._focus) { this._endFocus(false); return; }
        this._stopGame(false);
        this._focus = {until: Date.now() + minutes * 60000};
        this._b.home = false;
        this._setFocusDnd(true);
        this._set('focus');
        this._note(`Focus mode on for ${minutes} minutes. I'll hold your notifications.`, 3000);
        this._syncMenu();
    }

    // --- scroll timer ------------------------------------------------------------

    // The wheel counts only over Tiko's body, so scrolling past it on the
    // desktop is left alone. Smooth (touchpad) scrolling adds up to notches.
    _scroll(ev) {
        const b = this._b;
        if (!b || b.held || !this._tickId) return Clutter.EVENT_PROPAGATE;
        const [px, py] = ev.get_coords();
        if (Math.abs(px - b.x) > BW * S * 0.7 || py < b.y - (BH + 24) * S || py > b.y + 6) return Clutter.EVENT_PROPAGATE;
        // Clutter can also send a made-up step for each smooth one; counting
        // both would add 10 min a notch.
        if (ev.get_flags() & Clutter.EventFlags.POINTER_EMULATED) return Clutter.EVENT_STOP;
        let d = 0;
        const sd = ev.get_scroll_direction();
        if (sd === Clutter.ScrollDirection.UP) d = 1;
        else if (sd === Clutter.ScrollDirection.DOWN) d = -1;
        else if (sd === Clutter.ScrollDirection.SMOOTH) {
            const [, dy] = ev.get_scroll_delta();
            this._scrollAcc = (this._scrollAcc ?? 0) - dy;
            if (Math.abs(this._scrollAcc) >= 1) { d = Math.sign(this._scrollAcc); this._scrollAcc = 0; }
        }
        // One wheel notch still arrived as two counted events (seen 19 Nov
        // 2026: one notch gave 10 min), so two notches within 25 ms count once.
        if (d && ev.get_time() - (this._notchAt ?? -1e9) >= 25) { this._notchAt = ev.get_time(); this._nudgeTimer(d); }
        return Clutter.EVENT_STOP;
    }

    _timerRound(m) { return m <= TIMER_FINE ? m : Math.ceil(m / TIMER_STEP) * TIMER_STEP; }

    _timerLive() { const tm = this._timer; return !!tm && !tm.done && !tm.gone; }

    // Each notch is ±1 min up to 5, then ±5; a running timer starts from its
    // time left, rounded up to the next step. It applies 2 s after the last notch.
    _nudgeTimer(d) {
        const live = this._timerLive();
        if (this._timerPending == null)
            this._timerPending = live ? this._timerRound(Math.ceil((this._timer.until - Date.now()) / 60000)) : 0;
        const p = this._timerPending, step = d > 0 ? (p < TIMER_FINE ? 1 : TIMER_STEP) : (p <= TIMER_FINE ? 1 : TIMER_STEP);
        this._timerPending = Math.max(0, Math.min(TIMER_MAX, this._timerRound(p + d * step)));
        this._sound('chirp');   // a tick per notch
        this._note(this._timerPending ? `⏱ ${this._timerPending} min` : live ? '⏱ 0 (cancel)' : '⏱ 0 min', 2400, false);
        if (this._timerIdleId) GLib.source_remove(this._timerIdleId);
        this._timerIdleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TIMER_IDLE_MS, () => {
            this._timerIdleId = 0;
            const mins = this._timerPending;
            this._timerPending = null;
            if (mins) this._startTimer(mins);
            else if (this._timerLive()) this._cancelTimer();
            return GLib.SOURCE_REMOVE;
        });
    }

    // A new timer picks an activity and lays the first piece at once. Changing
    // a running one keeps its activity and what is built, and spreads the
    // rest over the new time.
    _startTimer(min) {
        const now = Date.now(), b = this._b;
        let tm = this._timerLive() ? this._timer : null;
        if (!tm) {
            this._killTimer();
            const key = Object.keys(TIMER_ACTS)[Math.floor(Math.random() * Object.keys(TIMER_ACTS).length)];
            const actor = new St.DrawingArea({reactive: false});
            tm = {key, act: TIMER_ACTS[key], core: TIMER_ACTS[key].n(min), built: 0, placed: [], t: 0, level: 0, actor,
                job: {kind: 'work', t: 0}, carry: false, fetch: false, walking: false};
            actor.connect('repaint', a => {
                const cr = a.get_context();
                cr.setOperator(Cairo.Operator.CLEAR); cr.paint(); cr.setOperator(Cairo.Operator.OVER);
                cr.scale(S, S); cr.translate(-tm.left, 0);   // units from Tiko's build spot
                try { this._drawSite(cr, tm); } catch (e) { console.error(`desk-buddy: timer site: ${e.message}`); }
                cr.$dispose();
            });
            this._addToLayer(actor);
            this._fx.push({actor, step: dt => this._stepTimer(tm, dt)});
            this._timer = tm;
            this._layoutSite(tm);
            this._placePiece(tm);
            this._note(`${tm.act.intro} ${min} minutes.`, 2400);
            this._sound('happy');
        } else {
            this._note(`Okay, ${min} minutes now.`, 2000);
        }
        Object.assign(tm, {min, start: now, total: min * 60000, until: now + min * 60000, b0: tm.built, level: 0});
        // Main pieces plus a detail per 5 minutes; a change keeps what is built.
        const most = tm.core + TIMER_EXTRAS[tm.key].length;
        tm.n = Math.min(most, Math.max(tm.built + 1, tm.core + Math.floor(min / 5)));
        b.home = false;
        this._syncMenu();
    }

    // The menu's stop and scrolling to 0: the pieces tumble and fade.
    _cancelTimer() {
        const tm = this._timer;
        if (!tm) return;
        if (!tm.done) { this._note('Oops. Timer cancelled.', 2000); this._sound('thud'); }
        Object.assign(tm, {gone: true, goneT: 0, ringing: false, mishap: null, walking: false, carry: false});
        this._syncMenu();
    }

    // Switch-off and disable: no sources left behind; the _fx sweep that
    // follows destroys the site actor.
    _killTimer() {
        if (this._timerIdleId) GLib.source_remove(this._timerIdleId);
        this._timerIdleId = 0;
        this._timerPending = null;
        this._timer = null;
    }

    // The site stays where Tiko stood when it started (its build spot, u = 0):
    // the build on one side, the pile of pieces TIMER_PILE units behind it on
    // the other, whichever way fits on screen. The actor spans both so the
    // piece Tiko carries between them is drawn in it too.
    _layoutSite(tm) {
        const b = this._b, T = this._T;
        tm.x0 = b.x; tm.y0 = b.y;
        const fits = sd => !T || (b.x + sd * (TIMER_SITE_OFF + SITE_W) * S < T.ux1 - 10 && b.x + sd * (TIMER_SITE_OFF + SITE_W) * S > T.ux0 + 10 &&
            b.x - sd * (TIMER_PILE + 25) * S > T.ux0 + 10 && b.x - sd * (TIMER_PILE + 25) * S < T.ux1 - 10);
        tm.side = fits(1) || !fits(-1) ? 1 : -1;
        tm.siteL = tm.side > 0 ? TIMER_SITE_OFF : -TIMER_SITE_OFF - SITE_W;
        tm.pileU = -tm.side * TIMER_PILE;
        tm.left = tm.side > 0 ? -TIMER_PILE - 25 : tm.siteL;
        const right = tm.side > 0 ? TIMER_SITE_OFF + SITE_W : TIMER_PILE + 25;
        tm.actor.set_size(Math.round((right - tm.left) * S), Math.round(SITE_H * S));
        tm.actor.set_position(Math.round(b.x + tm.left * S), Math.round(b.y - SITE_H * S + 2));
        tm.job = {kind: 'work', t: 0}; tm.carry = false; tm.walking = false;
    }

    // What Tiko does between pieces: fetches the next one from the pile when
    // it is due and carries it over; otherwise works at the build, and now
    // and then steps back to admire it or wanders to the pile. Faster as it
    // panics. Called from _step while the timer runs.
    _timerWalk(dt) {
        const b = this._b, tm = this._timer, sp = [1, 1.3, 1.8, 2.6][tm.level];
        if (Math.abs(b.y - tm.y0) > 3) this._layoutSite(tm);   // carried or dropped elsewhere: builds there now
        const j = tm.job;
        j.t += dt;
        if (j.kind === 'go') {
            const tx = tm.x0 + j.to * S, dx = tx - b.x, stepPx = 70 * sp * dt;
            tm.walking = true;
            if (Math.abs(dx) > stepPx) { b.dir = Math.sign(dx); b.x += b.dir * stepPx; b.dist = (b.dist ?? 0) + stepPx; return; }
            b.x = tx; tm.walking = false;
            if (j.then === 'pick') tm.job = {kind: 'pick', t: 0, face: Math.sign(tm.pileU)};
            else if (j.then === 'place') this._timerPlace(tm);
            else if (j.then === 'work') tm.job = {kind: 'work', t: 0};
            else { tm.job = {kind: j.then, t: 0, dur: j.dur}; if (j.line) this._say(j.line, 1600); }
            return;
        }
        tm.walking = false;
        b.dir = j.face ?? tm.side;
        if (j.kind === 'pick') {
            if (j.t > 0.5 / sp) { tm.carry = true; tm.job = {kind: 'go', to: 0, then: 'place', t: 0}; }
        } else if (tm.fetch && !tm.carry) {
            if (j.kind === 'rest' || j.kind === 'drink') this._say('Oh! Back to work.', 1200);
            tm.job = {kind: 'go', to: tm.pileU, then: 'pick', t: 0};
        } else if (j.dur && j.t > j.dur) {
            tm.job = {kind: 'go', to: 0, then: 'work', t: 0};
        } else if (j.kind === 'work' && j.t > (j.idle ??= 4 + Math.random() * 5)) {
            // A break from building. Resting, water and stretching only while
            // calm; once it hurries there is only time to glance at the clock.
            const opts = TIMER_IDLE.filter(o => tm.level < 2 || !o.calm);
            const o = opts[Math.floor(Math.random() * opts.length)];
            const to = o.at === 'back' ? -tm.side * 28 : o.at === 'pile' ? tm.pileU * (0.4 + Math.random() * 0.5) : o.at === 'aside' ? -tm.side * 50 : 0;
            tm.job = {kind: 'go', to, then: o.kind, dur: o.dur, line: Math.random() < 0.6 ? o.line : null, t: 0};
        }
    }

    // At the build with a piece: it lands, or, more often the more it panics
    // (never the first piece), slips and rolls away, and Tiko goes back for
    // another.
    _timerPlace(tm) {
        tm.carry = false;
        tm.job = {kind: 'work', t: 0};
        if (tm.built >= 1 && Math.random() < 0.15 + 0.1 * tm.level) {
            tm.mishap = {t: 0}; this._sound('whoa'); this._say(tm.act.oops[1], 2000, false, true);
            return;   // still fetching: back to the pile
        }
        tm.fetch = false;
        this._placePiece(tm);
    }

    _placePiece(tm) { tm.placed[tm.built++] = tm.t; if (!tm.done) this._sound('pop'); }

    _stepTimer(tm, dt) {
        if (this._timer !== tm) return false;
        tm.t += dt;
        tm.actor.queue_repaint();
        if (tm.mishap && (tm.mishap.t += dt) > 1.8) tm.mishap = null;
        if (tm.gone) {
            tm.goneT += dt;
            tm.actor.opacity = Math.max(0, Math.round(255 * (1 - tm.goneT / 1.4)));
            if (tm.done && tm.ringing) this._timerRing(tm, dt);   // the ring outlasts the build, until a click
            if (tm.goneT < 1.4 || (tm.done && tm.ringing)) return true;
            this._timer = null;
            return false;
        }
        const now = Date.now();
        if (!tm.done) {
            const k = Math.min(1, (now - tm.start) / tm.total);
            const p = TIMER_PANIC.find(q => k >= q[0]);
            if (p && p[1] > tm.level) { tm.level = p[1]; this._say(p[3], 1800, true, true); }
            // The last piece only lands at zero.
            if (!tm.fetch && tm.built < Math.min(tm.n - 1, tm.b0 + Math.floor(k * (tm.n - tm.b0)))) tm.fetch = true;
            if (now >= tm.until) this._ringTimer(tm);
            return true;
        }
        this._timerRing(tm, dt);
        // The finished build tumbles away 5 s after time's up; it used to
        // stay 60 s, which read as left behind (user, 19 Nov 2026).
        if (tm.after > 5) { tm.gone = true; tm.goneT = 0; }
        return true;
    }

    _timerRing(tm, dt) {
        tm.after += dt;
        if (!tm.said2 && tm.after > 3.2) { tm.said2 = true; this._note(`Your ${tm.min}-minute timer is done! Yay!`, 4000); }
        if (tm.ringing && tm.after - tm.lastRing >= 4) {
            tm.lastRing = tm.after;
            if (++tm.rings > 7) tm.ringing = false; else this._sound('reminder', true);
        }
    }

    // Time's up: the last piece and the finish, normal eyes back, a hopping,
    // arm-flapping cheer with confetti, a notification, and a ring every 4 s
    // until you click Tiko (or 8 rings).
    _ringTimer(tm) {
        while (tm.built < tm.n) this._placePiece(tm);
        Object.assign(tm, {mishap: null, done: true, finT: tm.t, after: 0, lastRing: 0, rings: 0, ringing: true,
            walking: false, carry: false, fetch: false});
        const b = this._b;
        if (!b.held && (PRIORITY[b.mode] ?? 0) <= PRIORITY.timerdone) { b.home = false; this._set('timerdone', 6); }
        this._confetti();
        this._loud = true;
        try { this._note("Ta-da! Time's up! 🎉", 3000); this._sound('done', true); } finally { this._loud = false; }
        Main.notify('Tiko', `Your ${tm.min}-minute timer is done!`);
        this._syncMenu();
    }

    // Drawn in units from the build spot; the foot line is SITE_GY.
    _drawSite(cr, tm) {
        const A = tm.act, em = (ch, x, y, pt) => this._emoji(cr, ch, x, y, pt), item = TIMER_CARRY[tm.key];
        if (!tm.done) for (let i = 0; i < 3; i++) em(item, tm.pileU + (i - 1) * 9, GY - 6 - (i === 1 ? 9 : 0), 9);   // the pile
        const u = (this._b.x - tm.x0) / S;
        if (tm.carry) em(item, u + this._b.dir * 15, GY - 44, 10);   // in its hands
        if (tm.mishap) {   // slipped from its hands; rolls away from the build
            const q = tm.mishap.t;
            em(A.oops[0], u + tm.side * 15 - tm.side * q * 40, Math.min(GY - 6, GY - 44 + 200 * q * q), 10);
        }
        cr.save();
        cr.translate(tm.siteL, 0);
        A.base?.(cr, tm.core);
        if (tm.done && A.lift) cr.translate(0, -A.lift(tm.t - tm.finT));
        const lifted = tm.done && A.lift;
        for (let pass = 0; pass < 2; pass++) {   // main pieces (they lift off with the rocket), then the details
            if (pass === 1 && lifted) { cr.restore(); cr.save(); cr.translate(tm.siteL, 0); }
            for (let i = pass ? tm.core : 0; i < (pass ? tm.built : Math.min(tm.built, tm.core)); i++) {
                const k = Math.min(1, (tm.t - tm.placed[i]) / 0.45);
                let dx = 0, dy = -((1 - k) ** 2) * 40;   // drops into place
                if (tm.gone) { const g = tm.goneT; dx = (i % 2 ? 1 : -1) * g * 25; dy += g * g * 90; }   // tumbles down
                cr.save(); cr.translate(dx, dy);
                if (pass) { const [ch, x, y, pt] = TIMER_EXTRAS[tm.key][i - tm.core]; em(ch, x, y, pt); } else A.piece(cr, i, tm.core);
                cr.restore();
            }
            if (pass === 0 && tm.done && !tm.gone) A.fin(cr, tm.t - tm.finT, tm.core, em);
        }
        cr.restore();
    }

    // Colour emoji go through Pango; Cairo's toy text API draws them blank.
    _emoji(cr, ch, x, y, pt) {
        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(Pango.FontDescription.from_string(`Noto Color Emoji ${pt}`));
        layout.set_text(ch, -1);
        const [, lg] = layout.get_pixel_extents();
        cr.moveTo(x - lg.width / 2, y - lg.height / 2);
        PangoCairo.show_layout(cr, layout);
    }

    _confetti() {
        const b = this._b, W = 360, H = 320;
        const parts = Array.from({length: 70}, (_v, i) => ({x: W / 2 + (Math.random() - 0.5) * 60, y: H * 0.5,
            vx: (Math.random() - 0.5) * 260, vy: -180 - Math.random() * 240, r: Math.random() * 6, c: TP[i % 5]}));
        let life = 0;
        const actor = new St.DrawingArea({width: W, height: H, reactive: false});
        actor.connect('repaint', a => {
            const cr = a.get_context();
            cr.setOperator(Cairo.Operator.CLEAR); cr.paint(); cr.setOperator(Cairo.Operator.OVER);
            for (const p of parts) {
                cr.save(); cr.translate(p.x, p.y); cr.rotate(p.r + life * 6);
                cr.setSourceRGBA(...p.c, Math.max(0, 1 - Math.max(0, life - 2.2) / 0.8));
                cr.rectangle(-3, -1.5, 6, 3); cr.fill(); cr.restore();
            }
            cr.$dispose();
        });
        actor.set_position(Math.round(b.x - W / 2), Math.round(b.y - H * 0.8));
        this._addToLayer(actor);
        this._fx.push({actor, step: dt => {
            life += dt;
            for (const p of parts) { p.vy += 420 * dt; p.x += p.vx * dt; p.y += p.vy * dt; }
            actor.queue_repaint();
            return life < 3;
        }});
    }

    // --- tile menu -------------------------------------------------------------

    _wireMenu() {
        const ind = this._indicator;
        let prefs = {};
        try {
            const [ok, bytes] = GLib.file_get_contents(PREFS_PATH);
            if (ok) prefs = JSON.parse(new TextDecoder().decode(bytes));
        } catch {}
        this._prefs = Object.fromEntries(NUDGES.map(([k]) => [k, prefs[k] !== false]));
        for (const [key] of NUDGES) {
            ind.nudgeSwitches[key].setToggleState(this._prefs[key]);
            ind.nudgeSwitches[key].connect('toggled', (_i, state) => {
                this._prefs[key] = state;
                this._savePrefs();
            });
        }
        const act = fn => () => { if (this._tickId) { this._lastInteract = Date.now(); this._lastPlay = Date.now(); fn(); } };
        // Tricks from the menu only start when it is free: not held, not in a
        // meeting, a fall or a crisis, not running from the snake.
        const freeFor = () => { const b = this._b; if (b.held || (PRIORITY[b.mode] ?? 0) > 60 || b.fleeUntil) return false;
            b.home = false; b.parked = false; b.ride = null; b.runUntil = 0; this._nextAct = Date.now() + 10000; return true; };
        ind.focus25.connect('activate', act(() => this._toggleFocus(25)));
        ind.timerNow.connect('activate', act(() => this._timerLive() ? this._cancelTimer() : this._startTimer(10)));
        ind.standupNow.connect('activate', act(() => this._standup()));
        ind.wrapNow.connect('activate', act(() => this._dailyWrap(true)));
        ind.uncommittedNow.connect('activate', act(() => this._checkUncommitted(true)));
        ind.breakNow.connect('activate', act(() => {   // a second click cancels it
            if (this._breakAt) { this._breakAt = 0; this._note('Okay, break reminder cancelled.', 2000); }
            else { this._breakAt = Date.now() + 30 * 60000; this._note("Sure. I'll remind you to take a break in 30 minutes.", 2600); }
            this._syncMenu();
        }));
        ind.playBall.connect('activate', act(() => this._startGame('ball')));
        ind.followMe.connect('activate', act(() => this._startGame('follow')));
        ind.stopPlay.connect('activate', act(() => this._stopGame(true)));
        this._prefs.activity = ACTIVITY_ORDER.includes(prefs.activity) ? prefs.activity : 'normal';
        // Above windows by default, so it stays visible however many windows are open.
        this._prefs.onTop = prefs.onTop !== false;
        this._prefs.hideOnShare = prefs.hideOnShare !== false;
        this._prefs.chatty = prefs.chatty !== false;
        this._prefs.weather = prefs.weather !== false;
        this._prefs.weatherCity = typeof prefs.weatherCity === 'string' ? prefs.weatherCity.trim() : '';
        if (this._prefs.weatherCity) ind.weatherSwitch.label.text = `Dress for the weather (${this._prefs.weatherCity})`;
        this._prefs.petAlways = prefs.petAlways === true;
        this._prefs.projectsDir = typeof prefs.projectsDir === 'string' && prefs.projectsDir.trim()
            ? prefs.projectsDir.trim() : DEFAULT_PROJECTS;
        ind.petSwitch.setToggleState(this._prefs.petAlways);
        ind.petSwitch.connect('toggled', (_i, state) => {
            this._prefs.petAlways = state;
            this._savePrefs();
            if (!this._tickId) return;
            if (state) this._summonPet();
            else if (this._pet) this._pet.until = Date.now() + 1000;   // waves off
            this._syncMenu();
        });
        ind.weatherSwitch.setToggleState(this._prefs.weather);
        ind.weatherSwitch.connect('toggled', (_i, state) => {
            this._prefs.weather = state;
            this._savePrefs();
            this._lastWeather = 0; this._checkWeather();
        });
        ind.petNow.connect('activate', act(() => {
            if (this._pet) { this._pet.until = Date.now() + 1000; this._say('Off you go, boy!', 1400); }   // sends it home
            else this._summonPet();
            this._syncMenu();
        }));
        ind.watchNow.connect('activate', act(() => { if (freeFor()) this._startWatching(); }));
        ind.coffeeNow.connect('activate', act(() => { if (freeFor()) this._startCoffeeRun(); }));
        ind.magicNow.connect('activate', act(() => { if (freeFor()) this._startMagic(); }));
        ind.moonwalkNow.connect('activate', act(() => this._walkStyle('moonUntil', 'Hee-hee!')));
        ind.chattySwitch.setToggleState(this._prefs.chatty);
        ind.chattySwitch.connect('toggled', (_i, state) => {
            this._prefs.chatty = state;
            this._savePrefs();
        });
        ind.shareSwitch.setToggleState(this._prefs.hideOnShare);
        ind.shareSwitch.connect('toggled', (_i, state) => {
            this._prefs.hideOnShare = state;
            this._savePrefs();
            this._syncShare();
        });
        ind.onTopSwitch.setToggleState(this._prefs.onTop);
        ind.onTopSwitch.connect('toggled', (_i, state) => {
            this._prefs.onTop = state;
            this._savePrefs();
            if (this._area) this._setOnTop(state);
        });
        ind.surpriseNow.connect('activate', act(() => { if (freeFor()) this._surprise(); }));
        ind.hideNow.connect('activate', act(() => { if (freeFor()) this._startHide(); }));
        for (const [key, item] of Object.entries(ind.activityItems)) {
            item.connect('activate', () => {
                this._prefs.activity = key;
                this._savePrefs();
                // Picking a level counts as playing with it, so the new level shows
                // straight away instead of the automatic lazy mode.
                this._lastInteract = Date.now(); this._lastPlay = Date.now();
                this._nextAct = Date.now() + 3000;
                this._syncMenu();
            });
        }
        // Diagnostics: one line, refreshed whenever the menu opens.
        ind.statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        ind.statusItem.label.style = 'font-size: 0.85em; color: #9aa2b1;';
        ind.toggle.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        ind.toggle.menu.addMenuItem(ind.statusItem);
        ind.toggle.menu.connect('open-state-changed', (_m, open) => { if (open) this._syncMenu(); });
        this._syncMenu();
    }

    _savePrefs() {
        try { GLib.file_set_contents(PREFS_PATH, JSON.stringify(this._prefs)); } catch (e) { console.error(`desk-buddy: saving prefs: ${e.message}`); }
    }

    // Labels that change with state: time left on focus and the break
    // reminder, the pet item, the activity level, and the status line.
    _syncMenu() {
        const ind = this._indicator;
        if (!ind) return;
        const minsLeft = at => Math.max(1, Math.ceil((at - Date.now()) / 60000));
        ind.focus25.label.text = this._focus ? `Stop focus (${minsLeft(this._focus.until)} min left)` : 'Focus 25 min';
        ind.timerNow.label.text = this._timerLive() ? `Stop timer (${minsLeft(this._timer.until)} min left)` : 'Timer 10 min (or scroll over Tiko)';
        ind.breakNow.label.text = this._breakAt ? `Cancel break reminder (in ${minsLeft(this._breakAt)} min)` : 'Remind me to take a break in 30 min';
        ind.petNow.label.text = this._pet ? 'Send the robot pet home' : 'Call the robot pet';
        ind.petNow.visible = !this._prefs?.petAlways;
        const level = this._prefs?.activity ?? 'normal';
        const NO_DOT = PopupMenu.Ornament.NO_DOT ?? PopupMenu.Ornament.NONE;
        for (const [key, item] of Object.entries(ind.activityItems))
            item.setOrnament(key === level ? PopupMenu.Ornament.DOT : NO_DOT);
        ind.stopPlay.visible = !!this._game;
        const b = this._b;
        if (ind.statusItem && b) {
            const n = (this._T?.surfaces.length ?? 1) - 1;
            ind.statusItem.label.text = `Now: ${b.held ? 'held' : b.mode}${this._game ? `, playing ${this._game.kind}` : ''}${this._lazy() ? ' (lazy)' : ''} · ` +
                `energy ${Math.round(b.energy ?? 100)}% · ${n} ledges · last problem: ${this._lastError ?? 'none'}`;
        }
    }

    // Today's remaining meetings from the shell calendar (timed ones only).
    _todaysMeetings(from = new Date()) {
        const src = Main.panel.statusArea.dateMenu?._eventSource;
        const end = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
        return (src?.getEvents(from, end) ?? []).filter(e => e.end - e.date < 24 * 3600000 && e.end > from)
            .sort((a, b) => a.date - b.date);
    }

    // Morning briefing: once a day, the first time it sees you after 8 AM.
    _morningBrief(force = false) {
        const now = new Date(), day = now.toDateString();
        if (!force && (now.getHours() < 8 || this._briefDay === day)) return;
        this._briefDay = day;
        const fmt = d => GLib.DateTime.new_from_unix_local(Math.floor(d.getTime() / 1000)).format('%-l:%M %p');
        const meetings = this._todaysMeetings(now);
        const hour = now.getHours();
        const hello = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
        const parts = [`${hello}!`];
        parts.push(meetings.length
            ? `You have ${meetings.length} meeting${meetings.length === 1 ? '' : 's'} today; the first is ${meetings[0].summary} at ${fmt(meetings[0].date)}.`
            : 'Your calendar is clear today.');
        const jira = Main.extensionManager.lookup('jira-sprint@local')?.stateObj;
        const open = (jira?._issues ?? []).filter(i => i.fields?.status?.statusCategory?.key !== 'done');
        if (open.length) parts.push(`${open.length} sprint ticket${open.length === 1 ? ' is' : 's are'} still open.`);
        if (this._weather) parts.push(`Weather: ${this._weather.text}.`);
        const text = parts.join(' ');
        this._remind(text, 'wave', 12000);
    }

    // A small card next to the buddy before a meeting: title, start time and
    // Join (the link the meeting extension found), or just Dismiss.
    // manual: opened from the menu with no stand-up coming up, so ev is a
    // stand-in with no start time and the card stays until dismissed.
    _showMeetingCard(ev, standup = false, manual = false) {
        this._hideCard();
        const links = Main.extensionManager.lookup('meet-join@local')?.stateObj?._todayLinks;
        const url = links?.get(ev.summary) ?? null;
        const fmt = d => GLib.DateTime.new_from_unix_local(Math.floor(d.getTime() / 1000)).format('%-l:%M %p');
        const time = fmt(ev.date);
        // White card with an indigo accent, after the user's mock-up
        // (17 Nov 2026): tinted, collapsible Yesterday/Today panels, keys in
        // pills, filled or outlined status pills, a primary and a secondary
        // button.
        const card = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, reactive: true,
            style: `background-color: #ffffff; color: ${CARD.ink}; border-radius: 18px; padding: 14px 16px; spacing: 10px; ` +
                'border: 1px solid rgba(0,0,0,0.08); box-shadow: 0 6px 20px rgba(0,0,0,0.28); ' +
                (standup ? 'width: 440px;' : 'min-width: 240px;'),
        });
        const sub = manual ? `Updated today at ${fmt(new Date())}` : `Starts at ${time}`;
        if (standup) {
            const hl = new St.BoxLayout({style: 'spacing: 10px;'});
            hl.add_child(new St.Icon({icon_name: 'system-users-symbolic', icon_size: 22, y_align: Clutter.ActorAlign.CENTER,
                style: `color: ${CARD.accent};`}));
            const tl = new St.Label({text: manual ? 'Stand-up summary' : ev.summary, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
                style: 'font-weight: 800; font-size: 1.2em;'});
            tl.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            hl.add_child(tl);
            hl.add_child(new St.Icon({icon_name: manual ? 'view-refresh-symbolic' : 'alarm-symbolic', icon_size: 13,
                y_align: Clutter.ActorAlign.CENTER, style: `color: ${CARD.muted};`}));
            hl.add_child(new St.Label({text: sub, y_align: Clutter.ActorAlign.CENTER, style: `font-size: 0.8em; color: ${CARD.muted};`}));
            card.add_child(hl);
        } else {
            card.add_child(new St.Label({text: ev.summary, style: 'font-weight: bold; max-width: 280px;'}));
            card.add_child(new St.Label({text: sub, style: `font-size: 0.9em; color: ${CARD.muted};`}));
        }
        const divider = () => new St.Widget({style: 'height: 1px; background-color: rgba(0,0,0,0.09);', x_expand: true});
        card.add_child(divider());
        // Standup: the body appears at once with "Loading…" because the
        // Yesterday list needs a Jira search; the card must not wait for it.
        let body = null, bodyLine = null;
        if (standup) {
            body = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'spacing: 10px;'});
            body.add_child(new St.Label({text: 'Loading…', style: `font-size: 0.9em; color: ${CARD.muted};`}));
            card.add_child(body);
            bodyLine = divider();
            card.add_child(bodyLine);
        }
        const row = new St.BoxLayout({style: 'spacing: 10px;', x_expand: true});
        // primary: filled indigo; secondary: white with a border. Inline
        // styles can't use :hover, so the hover look is set by hand.
        const LOOK = {
            primary: [`background-color: ${CARD.accent}; color: #ffffff; border: 1px solid ${CARD.accent};`,
                `background-color: ${CARD.accentHot}; color: #ffffff; border: 1px solid ${CARD.accentHot};`],
            secondary: [`background-color: #ffffff; color: ${CARD.ink}; border: 1px solid rgba(0,0,0,0.18);`,
                `background-color: #eef0ff; color: ${CARD.ink}; border: 1px solid ${CARD.accent};`],
        };
        const btn = (label, icon, kind, fn, at = -1) => {
            const [idle, hot] = LOOK[kind].map(l => `border-radius: 10px; padding: 6px 14px; ${l}`);
            const bt = new St.Button({can_focus: true, reactive: true, track_hover: true, style: idle});
            const inner = new St.BoxLayout({style: 'spacing: 6px;'});
            inner.add_child(new St.Icon({icon_name: icon, icon_size: 14, y_align: Clutter.ActorAlign.CENTER}));
            const lab = new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER, style: 'font-weight: 600;'});
            inner.add_child(lab);
            bt.set_child(inner);
            bt._lab = lab;
            bt.connect('enter-event', () => { bt.style = hot; return Clutter.EVENT_PROPAGATE; });
            bt.connect('leave-event', () => { bt.style = idle; return Clutter.EVENT_PROPAGATE; });
            this._tap(bt, () => fn(bt));
            row.insert_child_at_index(bt, at);
        };
        if (url) btn('Join', 'go-next-symbolic', 'primary', () => { Gio.AppInfo.launch_default_for_uri(url, global.create_app_launch_context(0, -1)); this._hideCard(); });
        btn('Dismiss', 'window-close-symbolic', url ? 'secondary' : 'primary', () => this._hideCard());
        const left = new St.Label({text: '', x_expand: true, x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER, style: `font-size: 0.85em; color: ${CARD.muted};`});
        row.add_child(left);
        card.add_child(row);
        // Always above windows and above Tiko's own drawing area. That area is
        // 320x260 (room for the speech bubble over its head), so it overlaps
        // the bottom of the card, where the buttons are; with the card under
        // it (insert_child_above puts the newest actor lowest), every click
        // went to Tiko and the buttons did nothing (journal, 17 Nov 2026).
        if (this._sharing) card.hide();
        const ui = Main.layoutManager.uiGroup;
        ui.insert_child_above(card, global.top_window_group);
        if (this._area?.get_parent() === ui) ui.set_child_above_sibling(card, this._area);
        const mine = {actor: card, left, at: manual ? 0 : ev.date.getTime(),
            until: manual ? Infinity : ev.date.getTime() + 2 * 60000, hold: false, copiedUntil: 0};
        this._card = mine;
        if (standup) {
            const drop = () => { body.destroy(); bodyLine.destroy(); };
            // Jira lists and git commits arrive separately; the body fills once
            // both have answered. Without Jira (missing, older, failed) the card
            // still shows the commits; with neither it is a plain meeting card.
            let jiraData, commits;
            const fill = () => {
                if (this._card !== mine || jiraData === undefined || commits === undefined) return;
                if (!jiraData && !commits.rows.length) { drop(); return; }
                const data = {...(jiraData ?? {yesterday: [], today: [], blockers: []}), commits};
                this._fillStandup(body, data, text => btn('Copy update', 'edit-copy-symbolic', 'secondary', bt => {
                    // PRIMARY too, so middle-click paste works as well.
                    const cb = St.Clipboard.get_default();
                    cb.set_text(St.ClipboardType.CLIPBOARD, text);
                    cb.set_text(St.ClipboardType.PRIMARY, text);
                    if (this._card !== mine) return;
                    mine.copiedUntil = Date.now() + 4000;
                    mine.hold = true;   // keep it still for the paste
                    bt._lab.text = 'Copied';
                    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2000, () => {
                        if (this._card === mine) bt._lab.text = 'Copy update';
                        return GLib.SOURCE_REMOVE;
                    });
                }, 0));
            };
            this._standupCommits((rows, day) => { commits = {rows, day}; fill(); });
            const jira = Main.extensionManager.lookup('jira-sprint@local')?.stateObj;
            if (typeof jira?.standupData !== 'function') {
                jiraData = null;
            } else {
                try {
                    jira.standupData((data, err) => { jiraData = err || !data ? null : data; fill(); });
                } catch (e) {
                    console.error(`desk-buddy: standupData: ${e.message}`);
                    jiraData = null;
                }
            }
            fill();
        }
        // The card follows Tiko as it walks, which slid the buttons out from under
        // the pointer between press and release, so clicks never landed. It holds
        // still while the pointer is on it. Crossing events, as notify::hover is
        // unreliable here (the Jira menu saw the same); a leave into one of its
        // own children does not count as leaving.
        card.connect('enter-event', () => { if (this._card) this._card.hold = true; return Clutter.EVENT_PROPAGATE; });
        card.connect('leave-event', (_a, e) => {
            const to = e.get_related?.();
            if (this._card && !(to && card.contains(to))) this._card.hold = false;
            return Clutter.EVENT_PROPAGATE;
        });
        this._stepCard();
    }

    // Makes an actor clickable on the card: hand pointer, acts on press (the
    // card can shift a pixel between press and release as Tiko moves, and then
    // 'clicked' never fires), and runs after the event, because Join and
    // Dismiss destroy the card and destroying the pressed actor inside its own
    // handler is best avoided. Enter and space work too.
    _tap(actor, fn) {
        actor.reactive = true;
        actor.can_focus = true;
        actor.cursor_type = Clutter.CursorType.POINTER;
        const run = () => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try { fn(); } catch (e) { console.error(`desk-buddy: card button: ${e.message}`); }
            return GLib.SOURCE_REMOVE;
        });
        actor.connect('button-press-event', () => { run(); return Clutter.EVENT_STOP; });
        actor.connect('key-press-event', (_a, e) => {
            if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_space].includes(e.get_key_symbol())) { run(); return Clutter.EVENT_STOP; }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _stepCard() {
        const c = this._card, b = this._b;
        if (Date.now() > c.until) { this._hideCard(); return; }
        const mins = Math.round((c.at - Date.now()) / 60000);
        const left = Date.now() < c.copiedUntil ? 'Copied' : !c.at ? '' : mins > 0 ? `in ${mins} min` : 'now';
        if (c.left.text !== left) c.left.text = left;   // only on change: this runs every frame
        if (c.hold) return;
        const [w, h] = [c.actor.width || 240, c.actor.height || 100];
        const T = this._T;
        const x = Math.max((T?.ux0 ?? 0) + 8, Math.min((T?.ux1 ?? 1920) - w - 8, b.x - w / 2));
        c.actor.set_position(Math.round(x), Math.round(b.y - (BH + 40) * S - h - 30));
    }

    _hideCard() {
        this._card?.actor.destroy();
        this._card = null;
    }

    // Fills the standup card's body from the Jira extension's standupData()
    // and hands the plain-text update to addCopy, which adds the Copy button.
    _fillStandup(body, data, addCopy) {
        body.destroy_all_children();
        const groups = [['Yesterday', data.yesterday], ['Today', data.today], ['Blockers', data.blockers]]
            .map(([title, list]) => [title, Array.isArray(list) ? list.filter(i => i?.key) : []]);
        // Grouped by status within each heading, furthest along first, so the
        // card and the copied update read as "finished, in review, doing,
        // not started". sort is stable, so Jira's order holds inside a status.
        const RANK = {done: 0, review: 1, progress: 2, todo: 3};
        for (const [, list] of groups) list.sort((a, b) => (RANK[a.group] ?? 4) - (RANK[b.group] ?? 4));
        const TINT = {Yesterday: ['#16a34a', '#e8f6ee'], Today: ['#2563eb', '#e8f0fd'], Blockers: ['#dc2626', '#fdecec']};
        // Done is a filled pill with a tick; anything still open is outlined
        // with a clock, in its status colour.
        const statusPill = it => {
            const done = it.group === 'done';
            const c = {done: '#15803d', progress: '#1d4ed8', review: '#b45309', todo: '#57534e'}[it.group] ?? '#57534e';
            const pill = new St.BoxLayout({y_align: Clutter.ActorAlign.CENTER, style: done
                ? `spacing: 4px; background-color: #dcf5e4; color: ${c}; border-radius: 10px; padding: 2px 9px;`
                : `spacing: 4px; color: ${c}; border: 1px solid ${c}; border-radius: 10px; padding: 1px 8px;`});
            pill.add_child(new St.Icon({icon_name: done ? 'object-select-symbolic' : 'alarm-symbolic', icon_size: 11,
                y_align: Clutter.ActorAlign.CENTER, style: `color: ${c};`}));
            pill.add_child(new St.Label({text: it.status, y_align: Clutter.ActorAlign.CENTER, style: 'font-size: 0.75em; font-weight: 700;'}));
            return pill;
        };
        const ticketRow = it => {
            const r = new St.BoxLayout({style: 'spacing: 8px; padding: 4px 0;'});
            r.add_child(new St.Label({text: it.key, y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 0.82em; font-weight: 800; color: #1d4ed8; background-color: #e8f0fd; border-radius: 8px; padding: 2px 8px;'}));
            r.add_child(new St.Widget({y_align: Clutter.ActorAlign.CENTER, style: 'width: 1px; height: 14px; background-color: rgba(0,0,0,0.18);'}));
            const sum = new St.Label({text: String(it.summary ?? ''), x_expand: true, y_align: Clutter.ActorAlign.CENTER,
                style: 'font-size: 0.9em;'});
            sum.clutter_text.ellipsize = Pango.EllipsizeMode.END;   // one line each, whatever the title length
            r.add_child(sum);
            if (it.status) r.add_child(statusPill(it));
            return r;
        };
        const epicRow = epic => {
            const l = new St.Label({text: `✦ ${epic}`, style: 'font-size: 0.8em; color: #7c3aed; padding: 0 0 2px 4px;'});
            l.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            return l;
        };
        // A tinted header band (dot, title, count, chevron that folds it) over
        // the rows, with "View all N …" when more than STANDUP_MAX are hidden.
        const panel = (title, list) => {
            const [c, tint] = TINT[title];
            const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                style: 'border: 1px solid rgba(0,0,0,0.07); border-radius: 12px; background-color: #ffffff;'});
            const head = new St.BoxLayout({style: `spacing: 8px; background-color: ${tint}; border-radius: 11px 11px 0 0; padding: 6px 12px;`});
            head.add_child(new St.Widget({y_align: Clutter.ActorAlign.CENTER, style: `width: 10px; height: 10px; border-radius: 5px; background-color: ${c};`}));
            head.add_child(new St.Label({text: title, y_align: Clutter.ActorAlign.CENTER, style: 'font-weight: 800;'}));
            head.add_child(new St.Label({text: `(${list.length} item${list.length === 1 ? '' : 's'})`, x_expand: true,
                y_align: Clutter.ActorAlign.CENTER, style: `font-size: 0.85em; color: ${CARD.muted};`}));
            const chev = new St.Icon({icon_name: 'pan-down-symbolic', icon_size: 14, y_align: Clutter.ActorAlign.CENTER, style: `color: ${CARD.ink};`});
            head.add_child(chev);
            box.add_child(head);
            const rows = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style: 'padding: 2px 12px 4px 12px;'});
            box.add_child(rows);
            let all = false;
            const draw = () => {
                rows.destroy_all_children();
                if (!list.length) rows.add_child(new St.Label({text: 'Nothing here', style: `font-size: 0.85em; color: ${CARD.muted}; padding: 4px 0;`}));
                let lastEpic = null;
                const shown = all ? list : list.slice(0, STANDUP_MAX);
                shown.forEach((it, i) => {
                    if (i) rows.add_child(new St.Widget({style: 'height: 1px; background-color: rgba(0,0,0,0.06);', x_expand: true}));
                    rows.add_child(ticketRow(it));
                    // The epic only when it changes from the ticket above
                    // (sorted by status, so runs of one epic are common).
                    if (it.epic && it.epic !== lastEpic) rows.add_child(epicRow(it.epic));
                    lastEpic = it.epic ?? null;
                });
                if (list.length > STANDUP_MAX) {
                    const more = new St.Label({text: all ? 'Show less' : `View all ${list.length} ${title.toLowerCase()} items →`,
                        x_align: Clutter.ActorAlign.END, style: 'font-size: 0.8em; color: #1d4ed8; padding: 4px 0 2px 0;'});
                    this._tap(more, () => { all = !all; draw(); });
                    rows.add_child(more);
                }
            };
            draw();
            this._tap(head, () => {
                rows.visible = !rows.visible;
                chev.icon_name = rows.visible ? 'pan-down-symbolic' : 'pan-end-symbolic';
            });
            return box;
        };
        // Blockers and commits are one line each unless there is a blocker.
        const line = (iconActor, title, extra) => {
            const l = new St.BoxLayout({style: 'spacing: 10px; padding: 0 4px;'});
            l.add_child(iconActor);
            l.add_child(new St.Label({text: title, y_align: Clutter.ActorAlign.CENTER, style: 'font-weight: 800;'}));
            for (const e of extra) l.add_child(e);
            return l;
        };
        for (const [title, list] of groups) {
            if (title === 'Blockers' && !list.length) {
                const dot = new St.Label({text: '−', y_align: Clutter.ActorAlign.CENTER, x_align: Clutter.ActorAlign.CENTER,
                    style: 'color: #ffffff; background-color: #dc2626; border-radius: 9px; width: 18px; height: 18px; text-align: center; font-weight: 900;'});
                body.add_child(line(dot, 'Blockers', [new St.Label({text: 'None', y_align: Clutter.ActorAlign.CENTER, style: `color: ${CARD.muted};`})]));
            } else {
                body.add_child(panel(title, list));
            }
        }
        const cm = data.commits;
        if (cm?.rows?.length) {
            const chips = cm.rows.slice(0, 3).map(({repo, n}) => new St.Label({text: `${repo} ×${n}`, y_align: Clutter.ActorAlign.CENTER,
                style: `font-size: 0.85em; color: ${CARD.ink}; background-color: #eeeef2; border-radius: 10px; padding: 2px 10px;`}));
            if (cm.rows.length > 3)
                chips.push(new St.Label({text: `+${cm.rows.length - 3}`, y_align: Clutter.ActorAlign.CENTER, style: `font-size: 0.8em; color: ${CARD.muted};`}));
            body.add_child(line(new St.Icon({icon_name: 'x-office-calendar-symbolic', icon_size: 16, y_align: Clutter.ActorAlign.CENTER,
                style: `color: ${CARD.accent};`}), `Commits since ${cm.day}`, chips));
        }
        // The copy keeps every ticket, not just the ones that fit on the card.
        const text = groups.map(([title, list]) =>
            `${title}\n${list.length ? list.map(i => `• ${i.key} ${i.summary ?? ''}${i.status ? ` [${i.status}]` : ''}${i.epic ? ` (${i.epic})` : ''}`.trimEnd()).join('\n') : '• None'}`).join('\n');
        addCopy(cm?.rows?.length ? `${text}\nCommits since ${cm.day}\n${cm.rows.map(r => `• ${r.repo} ×${r.n}`).join('\n')}` : text);
    }

    // ------------------------------------------------------------ ticket delivery

    // Public: the Jira Sprint extension calls this right after you move a
    // ticket from its menu, so Tiko reacts at once rather than on the next
    // poll. summary is part of that contract but unused: the card in its
    // hand only has room for the key. status is {group, name}: group is
    // 'todo' | 'progress' | 'review' | 'done', name the Jira status name.
    // Older Jira extensions only called this for Done and passed no status,
    // so a missing one means Done.
    deliverTicket(key, _summary, status) {
        if (!this._b || typeof key !== 'string' || !key) return false;
        const group = Object.hasOwn(DELIVER_LINES, status?.group ?? '') ? status.group : 'done';
        // Switched off: left unrecorded, so the regular check announces a
        // Done once Tiko is back on, as it always has for moves made while
        // off (speaking now would only babble from an invisible Tiko). Other
        // moves are only ever seen here, so they are simply missed.
        if (!this._tickId) return false;
        // Recorded before anything else so the regular check of the Jira
        // item's _issues, which sees the same move on Jira's next poll, does
        // not announce it a second time. Only Done is tracked there, so the
        // other groups leave _jiraStatus alone.
        if (group === 'done') this._jiraStatus.set(key, 'done');
        if (this._prefs?.jira === false) return false;
        return this._announceDone(key, group, typeof status?.name === 'string' ? status.name : '');
    }

    // Every delivery path ends here (Done from either path, other moves only
    // from the Jira menu). Busy, or no Jira item to aim at: only the line,
    // exactly as before deliveries existed.
    // Returns true when Tiko walks the card over: the Jira menu then keeps the
    // ticket in its old column until the card lands (flashDone), so the board
    // changes when Tiko finishes, not before (user, 17 Nov 2026).
    _announceDone(key, group = 'done', name = '') {
        const line = DELIVER_LINES[group](key);
        if (this._freeToDeliver() && this._startDelivery(key, line, group, name))
            return true;
        this._remind(line, 'dance');
        return false;
    }

    // The bar a 'dance' reminder must clear in _remind (not held, current
    // mode's PRIORITY no higher than dance), plus everything _remind lets it
    // talk over but a walk across the screen must not: asleep, focus,
    // meetings or Do Not Disturb (same test as _step), hidden for a share or a
    // fullscreen video, switched off, a game, the movie sofa, fleeing, or a
    // delivery already under way.
    _freeToDeliver() {
        const b = this._b;
        if (!b || !this._tickId || this._sharing || this._fsHide || this._dv || this._game || this._focus || this._press0) return false;
        if (b.held || b.mode === 'sleep' || b.mode === 'movie' || b.fleeUntil) return false;
        const inMeeting = GLib.file_test(MEETING_MARKER, GLib.FileTest.EXISTS) ||
            (this._notif && !this._notif.get_boolean('show-banners'));
        if (inMeeting) return false;
        return (PRIORITY[b.mode] ?? 0) <= PRIORITY.dance;
    }

    // Centre of the Jira Sprint top-bar item on screen, or null when it is
    // not there to aim at (extension off, panel hidden).
    _jiraTarget() {
        const btn = Main.panel.statusArea['jira-sprint@local'];
        if (!btn || !btn.mapped) return null;
        const [x, y] = btn.get_transformed_position();
        const [w, h] = btn.get_transformed_size();
        if (!Number.isFinite(x) || !Number.isFinite(y) || !(w > 0)) return null;
        return {x: x + w / 2, y: y + h / 2};
    }

    // Builds the whole delivery as a list of timed steps (built once, then
    // run a step at a time by _stepDelivery), ported from the HTML mockup's
    // async throws. Offsets from the mockup are in Tiko's own units, hence * S.
    _startDelivery(key, line, group = 'done', name = '') {
        const b = this._b, T = this._T, tgt = this._jiraTarget();
        if (!tgt || !T) return false;
        const surf = this._below(T, b.x, b.y - 4);   // the floor or window top it stands on
        if (!surf || Math.abs(surf.top - b.y) > 2) return false;
        const monOf = x => Main.layoutManager.monitors.findIndex(m => x >= m.x && x < m.x + m.width);
        const lo = Math.max(surf.x0, T.ux0) + 40, hi = Math.min(surf.x1, T.ux1) - 40;
        const clampX = x => hi > lo ? Math.max(lo, Math.min(hi, x)) : b.x;
        // Stands just beside the item, on the side it comes from, facing it.
        // Under another monitor's bar, it throws from where it is.
        const side = b.x >= tgt.x ? 1 : -1;
        const spot = monOf(tgt.x) === monOf(b.x) ? clampX(tgt.x + side * 18 * S) : b.x;
        // Far away on the floor: it turns up closer, as 'watchingyou' does, so
        // the walk takes seconds rather than a trek across the monitors.
        if (b.on === null && Math.abs(spot - b.x) > 600) { b.x = spot + Math.sign(b.x - spot) * 500; this._terrainDirty = true; }
        const cw = Math.max(50, 8 + key.length * 5.6);   // card width in Tiko units, fits the key
        const p = {armA: 12, crouch: 0, jumpY: 0, shake: 0, face: 'norm', sweat: false, holding: true,
            walking: false, backT: null, plane: false, relax: false, bj: null};
        const d = {key, line, group, spot, tgt, face: -side, cw, pose: p, q: null, i: 0, begun: false, t: 0, dur: 0,
            card: null, scored: false, at: Date.now(), lo, hi};

        const ease = k => k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
        const wait = s => ({dur: s});
        const now = fn => ({start: () => { fn(); return 0; }});
        const say = (txt, ms = 1600) => now(() => this._say(txt, ms));
        const tween = (s, fn) => ({start: () => s, tick: fn});
        const arm = (to, s) => {
            let from = 12;
            return {start: () => { from = p.armA ?? 12; return s; }, tick: k => { p.armA = from + (to - from) * ease(k); }};
        };
        const crouch = (to, s) => {
            let from = 0;
            return {start: () => { from = p.crouch; p.relax = false; return s; }, tick: k => { p.crouch = from + (to - from) * ease(k); }};
        };
        const jump = (hgt, s) => tween(s, k => { p.jumpY = hgt * 4 * k * (1 - k); });
        const bgJump = (hgt, s) => now(() => { p.bj = {h: hgt, dur: s, t: 0}; });   // runs alongside the next steps
        const par = (...steps) => {   // steps side by side; ends with the longest
            const durs = new Array(steps.length).fill(0);
            let dur = 0;
            return {
                start: () => { dur = 0; for (let n = 0; n < steps.length; n++) { durs[n] = steps[n].start?.() ?? steps[n].dur ?? 0; dur = Math.max(dur, durs[n]); } return dur; },
                tick: k => { const t = k * dur; for (let n = 0; n < steps.length; n++) steps[n].tick?.(durs[n] > 0 ? Math.min(1, t / durs[n]) : 1); },
            };
        };
        // Walks along the surface it is on and never off its edge (the rule
        // _stepWatching's move() uses); blocked, it just stops short.
        const walkTo = (xFn, speed = 80) => {
            let x0 = 0, x1 = 0;
            return {
                start: () => {
                    x0 = b.x; x1 = clampX(xFn());
                    if (Math.abs(x1 - x0) < 2) return 0;
                    b.dir = x1 > x0 ? 1 : -1; p.walking = true;
                    return Math.abs(x1 - x0) / (speed * S);
                },
                tick: k => {
                    const nx = x0 + (x1 - x0) * k, s2 = this._T && this._below(this._T, nx, b.y - 4);
                    if (s2 && Math.abs(s2.top - b.y) < 2) { b.dist = (b.dist ?? 0) + Math.abs(nx - b.x); b.x = nx; }
                    if (k >= 1) p.walking = false;
                },
            };
        };
        const faceItem = now(() => { b.dir = d.face; });
        const release = () => now(() => this._releaseCard(d));
        const CARD_H = 14 * S;
        // Where a missed card comes to rest: on its own surface, within reach.
        const floorAt = x => [clampX(x), b.y - CARD_H / 2];
        const fly = (toFn, arc, s, spin = 360, wave = 0) => {
            let x0 = 0, y0 = 0, x1 = 0, y1 = 0, r0 = 0, A = 0, dur = 0;
            return {
                start: () => {
                    const c = d.card;
                    if (!c) return 0;
                    [x1, y1] = toFn();
                    x0 = c.x; y0 = c.y; r0 = c.rot;
                    // The mockup's desk was ~150 px tall; a real screen is far
                    // taller, so long throws get a little more time and height.
                    const sc = Math.max(1, Math.min(2.2, Math.sqrt(Math.hypot(x1 - x0, y1 - y0) / 150)));
                    A = arc * S * sc; dur = s * sc;
                    return dur;
                },
                tick: k => {
                    const c = d.card;
                    if (!c) return;
                    c.x = x0 + (x1 - x0) * k + (wave ? Math.sin(k * Math.PI * 5) * wave * S : 0);
                    c.y = y0 + (y1 - y0) * k - A * 4 * k * (1 - k);
                    c.rot = r0 + k * spin;
                    this._placeCard(c);
                },
            };
        };
        const toJira = (arc = 50, s = 0.65, spin = 360, wave = 0) =>
            fly(() => { const t = this._jiraTarget() ?? d.tgt; return [t.x, t.y]; }, arc, s, spin, wave);
        const thud = () => {
            let y0 = 0;
            return {
                start: () => { y0 = d.card?.y ?? 0; return 0.16; },
                tick: k => { const c = d.card; if (!c) return; c.y = y0 - 6 * S * Math.sin(k * Math.PI); if (k >= 1) c.rot = 0; this._placeCard(c); },
            };
        };
        const faceSet = f => now(() => { p.face = f; });
        const shake = (amt, s) => [now(() => { p.shake = amt; }), wait(s), now(() => { p.shake = 0; })];
        // Every throw shows effort: crouch, strained face, sweat, arm drawn
        // right back, a shaking hold, then the whip.
        const effort = power => [
            now(() => { p.face = 'strain'; p.sweat = true; }),
            par(crouch(0.5 + 0.3 * power, 0.26), arm(205, 0.42)),
            ...shake(0.8 * power, 0.26 * power),
            arm(-95, 0.11), release(), now(() => { p.sweat = false; p.relax = true; }),
        ];
        const strain = power => [now(() => { p.face = 'strain'; p.sweat = true; }), crouch(0.5, 0.2), ...shake(0.8 * power, 0.25)];
        const pickUp = () => [
            faceSet('sad'),
            walkTo(() => d.card ? d.card.x - (d.card.x > b.x ? 1 : -1) * 24 * S : b.x, 80),
            now(() => { if (d.card) b.dir = d.card.x > b.x ? 1 : -1; }), wait(0.15),
            crouch(1.2, 0.26), now(() => { p.armA = 70; }), wait(0.12),
            now(() => { this._dropCard(d); p.holding = true; }),
            crouch(0, 0.24), arm(12, 0.16), faceSet('norm'),
        ];
        const backToSpot = () => [walkTo(() => d.spot, 80), faceItem];
        const score = txt => [
            tween(0.18, k => { if (d.card) d.card.actor.opacity = Math.round(255 * (1 - k)); }),
            now(() => {
                this._dropCard(d); d.scored = true;
                // The Jira item lights up green as the card goes in.
                // The Jira item lights up (green for Done; blue, amber or grey otherwise) as the card goes in.
                try { Main.extensionManager.lookup('jira-sprint@local')?.stateObj?.flashDone?.(d.group); } catch {}
                p.armA = null; p.face = 'happy'; p.sweat = false; p.shake = 0;
                // "Done for real." would be wrong for a move to review or back to the pile.
                this._note(d.group !== 'done' && /done/i.test(txt) ? 'Delivered!' : txt, 2200); this._sound('happy');
            }),
            tween(1.3, k => { p.jumpY = Math.abs(Math.sin(k * 1.3 * 9)) * 9; }),
            now(() => { p.jumpY = 0; p.face = 'norm'; }),
        ];
        const missShort = power => [
            ...effort(power),
            fly(() => [b.x + d.face * 55 * S, b.y - 40 * S], 40, 0.42, 280),
            fly(() => floorAt(b.x + d.face * 60 * S), 0, 0.26, 80), thud(),
        ];
        const THROWS = [
            // 1 Clean toss
            () => [...effort(1), toJira(50, 0.65), ...score('Delivered!')],
            // 2 Windmill: the arm spins round twice before letting go
            () => [now(() => { p.face = 'strain'; p.sweat = true; }), crouch(0.5, 0.2), say('Wind it up…'),
                tween(1.1, k => { p.armA = 12 + ease(k) * (630 - 12); }), ...shake(0.8, 0.2),
                release(), now(() => { p.sweat = false; p.relax = true; }), toJira(40, 0.5, 540), ...score('Delivered!')],
            // 3 Falls short
            () => [...missShort(1), faceSet('shock'), say('Oops!'), wait(0.6), ...pickUp(), ...backToSpot(),
                say('Again!'), ...effort(1.6), toJira(60, 0.6), ...score('Got it!')],
            // 4 Overshoot: past the item, lands far, then a gentle lob
            () => [...effort(1.8), fly(() => [d.tgt.x + d.face * 110 * S, d.tgt.y + 30 * S], 40, 0.52, 420),
                fly(() => floorAt(d.tgt.x + d.face * 150 * S), 0, 0.52, 180), thud(), faceSet('shock'), say('Too much!'), wait(0.5),
                ...pickUp(), ...backToSpot(), say('Gently…'), ...strain(0.5), arm(-60, 0.26), release(),
                now(() => { p.sweat = false; p.relax = true; }), toJira(35, 0.7, 200), ...score('Delivered!')],
            // 5 Third time lucky: short, then wide, a stomp, then in
            () => [...missShort(0.8), faceSet('sad'), say('Hmph.'), wait(0.4), ...pickUp(), ...backToSpot(),
                ...effort(1.3), fly(() => [d.tgt.x + d.face * 150 * S, d.tgt.y + 40 * S], 30, 0.5, 420),
                fly(() => floorAt(d.tgt.x + d.face * 170 * S), 0, 0.45, 120), thud(),
                now(() => { p.face = 'strain'; p.shake = 2; }), jump(8, 0.22), jump(8, 0.22), now(() => { p.shake = 0; }), say('Grrr!'),
                ...pickUp(), ...backToSpot(), ...effort(2.2), toJira(70, 0.6), ...score('FINALLY!')],
            // 6 Hnnngh: a long shaking crouch, then a jump-throw
            () => [now(() => { p.face = 'strain'; p.sweat = true; }), say('Hnnnngh…', 1400), crouch(1.3, 0.35), arm(200, 0.3),
                ...shake(2, 1.3), bgJump(46, 0.7), wait(0.24), arm(-100, 0.1), release(),
                now(() => { p.sweat = false; p.relax = true; }), toJira(20, 0.42, 300), ...score('YES!')],
            // 7 Jump shot
            () => [say('Three… two…'), jump(10, 0.24), jump(10, 0.24), ...strain(0.6), arm(-80, 0.2),
                now(() => { p.relax = true; }), bgJump(36, 0.62), wait(0.3), release(), now(() => { p.sweat = false; }),
                toJira(80, 0.8, 0), ...score('Swish!')],
            // 8 Paper plane: the card drifts down, so it folds it and glides it in
            () => [...effort(0.7), fly(() => [b.x + d.face * 30 * S, d.tgt.y + 50 * S], 20, 0.42, 60),
                fly(() => floorAt(b.x + d.face * 70 * S), 0, 1.5, 40, 14), thud(), faceSet('sad'), say("Paper doesn't fly…"), wait(0.5),
                ...pickUp(), now(() => { p.plane = true; }), say('Folding it…'),
                arm(-10, 0.14), arm(30, 0.14), arm(-10, 0.14), arm(30, 0.14), arm(-10, 0.14), arm(30, 0.14),
                ...backToSpot(), ...strain(0.5), arm(-30, 0.2), release(), now(() => { p.sweat = false; p.relax = true; }),
                toJira(25, 1.3, 0, 9), ...score('Nailed the landing!')],
            // 9 Tired worker: wipes its brow, then an underhand throw
            () => [now(() => { p.face = 'sad'; p.sweat = true; }), say('Phew. Hard work, this.', 1800),
                tween(1.2, k => { p.backT = 2 + Math.sin(k * Math.PI * 4) * 7; }), now(() => { p.backT = null; }),
                ...strain(0.6), arm(100, 0.32), arm(-45, 0.21), release(), now(() => { p.sweat = false; p.relax = true; }),
                toJira(70, 0.95, 260), ...score('Done for real.')],
            // 10 Slam dunk: backs up, runs in, jumps and slams it home
            () => [walkTo(() => b.x - d.face * 90 * S, 90), say('Watch this!'), wait(0.3), walkTo(() => d.spot, 220), faceItem,
                ...strain(1), arm(-95, 0.12), now(() => { p.relax = true; }), bgJump(60, 0.72), wait(0.33), release(),
                toJira(0, 0.18, 0), ...shake(1.5, 0.42), ...score('SLAM!')],
        ];
        const pick = THROWS[Math.floor(Math.random() * THROWS.length)];
        d.q = [wait(0.4), ...backToSpot(), wait(0.25), ...pick()];

        this._dv = d;
        b.home = false; b.wanderX = undefined; b.ride = null; b.runUntil = 0; b.vx = 0;
        this._set('deliver');
        this._say(`${key}: ${group === 'done' ? 'Done' : name || DELIVER_LABEL[group]}!`, 1600);
        this._lastInteract = Date.now();
        return true;
    }

    // One frame of the delivery: advances the current step; zero-length
    // steps (say, release, set a pose) run back to back in the same frame.
    _stepDelivery(dt) {
        const d = this._dv, b = this._b;
        if (!d) { this._set('walk'); return; }
        if (Date.now() - d.at > 90000) { this._endDelivery(true); return; }   // safety net; no throw runs this long
        const p = d.pose;
        if (p.relax) { p.crouch = Math.max(0, p.crouch - dt * 4); if (!p.crouch) p.relax = false; }
        if (p.bj) {
            p.bj.t += dt;
            const k = Math.min(1, p.bj.t / p.bj.dur);
            p.jumpY = p.bj.h * 4 * k * (1 - k);
            if (k >= 1) { p.bj = null; p.jumpY = 0; }
        }
        let step = dt;
        for (let guard = 0; guard < 16; guard++) {
            const st = d.q[d.i];
            if (!st) { this._endDelivery(false); return; }
            if (!d.begun) {
                d.begun = true; d.t = 0;
                d.dur = st.start ? st.start() ?? 0 : st.dur ?? 0;
                if (this._dv !== d || b.mode !== 'deliver') return;
            }
            d.t += step; step = 0;
            const k = d.dur > 0 ? Math.min(1, d.t / d.dur) : 1;
            st.tick?.(k);
            if (k < 1) return;
            d.i++; d.begun = false;
        }
    }

    // Lets go of the card: from here it is its own small actor, in Tiko's
    // layer and in _fx, so layer moves, screen-share hiding and the
    // switch-off/disable sweeps all cover it.
    _releaseCard(d) {
        const b = this._b, p = d.pose;
        if (!p.holding) return;
        p.holding = false;
        const text = p.plane ? `✈ ${d.key}` : d.key;
        const cw = p.plane ? d.cw + 14 : d.cw;
        p.plane = false;
        // The hand, as _drawBuddy draws it standing (y = -BH - 8, shoulder at
        // half height, 15-unit forearm), then the card's centre beside it.
        const a = (p.armA ?? 12) * Math.PI / 180, dir = b.dir;
        const ex = dir * (BW / 2 + 2) + dir * 15 * Math.cos(a), ey = -BH - 8 + BH * 0.5 + 15 * Math.sin(a);
        const lx = (ex + dir * (1 + cw / 2)) * (1 + p.crouch * 0.06), ly = (ey - 5) * (1 - p.crouch * 0.14) - p.jumpY;
        const w = Math.round(cw * S), h = Math.round(14 * S);
        const actor = new St.Label({text, reactive: false, width: w, height: h,
            style: 'background-color: #ffffff; color: #222222; font-family: monospace; font-size: 11px; font-weight: bold; ' +
                'padding: 1px 5px; border-radius: 3px; border: 1px solid rgba(0,0,0,0.25);'});
        actor.set_pivot_point(0.5, 0.5);
        this._addToLayer(actor);
        const fx = {actor, gone: false, step: () => !fx.gone};
        this._fx.push(fx);
        d.card = {actor, fx, x: b.x + lx * S, y: b.y + ly * S, rot: 0, w, h};
        this._placeCard(d.card);
    }

    _placeCard(c) {
        c.actor.set_position(Math.round(c.x - c.w / 2), Math.round(c.y - c.h / 2));
        c.actor.rotation_angle_z = c.rot % 360;
    }

    // Never destroys the actor itself: the _fx sweep in _tick (or the
    // switch-off/disable sweeps) does, so it is destroyed exactly once.
    _dropCard(d) {
        if (!d.card) return;
        d.card.fx.gone = true;
        d.card.actor.hide();
        d.card = null;
    }

    // Ends a delivery, finished or not. tell: it was cut short, so the Done
    // line is still shown (the user would otherwise never hear about it).
    _endDelivery(tell) {
        const d = this._dv;
        if (!d) return;
        this._dv = null;
        this._dropCard(d);
        if (this._b?.mode === 'deliver') this._set('walk');
        if (tell && !d.scored) this._note(d.line, 9000, false);
    }

    // The daily wrap: today's meetings, commits, Jira tickets done and anything
    // uncommitted, as text you can paste into Slack (copied to the clipboard).
    _dailyWrap(_manual) {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
        const src = Main.panel.statusArea.dateMenu?._eventSource;
        const meetings = (src?.getEvents(start, now) ?? []).filter(e => e.end - e.date < 24 * 3600000 && e.date < now).map(e => e.summary);
        const jira = Main.extensionManager.lookup('jira-sprint@local')?.stateObj;
        // Tickets you moved to Done today, whoever they belong to, from the
        // Jira extension. An older Jira extension without doneTodayData falls
        // back to your own sprint tickets that are Done and were edited today
        // (which misses bugs closed for teammates and can count an old Done
        // ticket that was only commented on).
        if (typeof jira?.doneTodayData === 'function') {
            try {
                jira.doneTodayData((list, err) => {
                    if (err) console.error(`desk-buddy: doneTodayData: ${err}`);
                    this._dailyWrapGit(now, start, meetings, (list ?? []).map(i => `${i.key} ${i.summary}`));
                });
                return;
            } catch (e) {
                console.error(`desk-buddy: doneTodayData: ${e.message}`);
            }
        }
        const doneToday = (jira?._issues ?? []).filter(i => i.fields?.status?.statusCategory?.key === 'done' &&
            (i.fields?.updated ?? '').slice(0, 10) === iso(now)).map(i => `${i.key} ${i.fields.summary}`);
        this._dailyWrapGit(now, start, meetings, doneToday);
    }

    _dailyWrapGit(now, start, meetings, doneToday) {
        const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
        this._run('find "$1" -maxdepth 4 -name .git -type d 2>/dev/null | while read -r g; do r=$(dirname "$g"); ' +
            'n=$(git -C "$r" log --all --since="$2" --author="$(git -C "$r" config user.email)" --oneline 2>/dev/null | wc -l); ' +
            '[ "$n" -gt 0 ] && echo "C $(basename "$r") $n"; done; ' +
            'find "$1" -maxdepth 4 -name .git 2>/dev/null | while read -r g; do r=$(dirname "$g"); ' +
            '[ -n "$(git -C "$r" status --porcelain --untracked-files=no 2>/dev/null | head -1)" ] && echo "U $(basename "$r")"; done',
        [this._projectsDir(), iso(start)], out => {
            const lines = out.split('\n').filter(Boolean);
            const commits = lines.filter(l => l.startsWith('C ')).map(l => l.slice(2).replace(/ (\d+)$/, ' ×$1'));
            const dirty = [...new Set(lines.filter(l => l.startsWith('U ')).map(l => l.slice(2)))];
            const text = [`Wrap for ${now.toDateString()}`,
                `• Meetings (${meetings.length}): ${meetings.join(', ') || 'none'}`,
                `• Commits: ${commits.join(', ') || 'none'}`,
                `• Jira done today: ${doneToday.join('; ') || 'none'}`,
                `• Uncommitted: ${dirty.join(', ') || 'all clean'}`].join('\n');
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
            this._remind(`Here's your day: ${meetings.length} meeting${meetings.length === 1 ? '' : 's'}, commits in ${commits.length} repo${commits.length === 1 ? '' : 's'}, ` +
                `${doneToday.length} ticket${doneToday.length === 1 ? '' : 's'} done${dirty.length ? `, and ${dirty.length} repo${dirty.length === 1 ? ' has' : 's have'} uncommitted work` : ''}. ` +
                "I've copied the summary for Slack.",
                dirty.length ? 'alert' : 'dance', 9000);
        });
    }

    _projectsDir() {
        return expandHome(this._prefs?.projectsDir ?? DEFAULT_PROJECTS);
    }

    _checkUncommitted(always) {
        this._run('find "$1" -maxdepth 4 -name .git 2>/dev/null | while read -r g; do r=$(dirname "$g"); ' +
            '[ -n "$(git -C "$r" status --porcelain --untracked-files=no 2>/dev/null | head -1)" ] && basename "$r"; done',
        [this._projectsDir()], out => {
            const names = [...new Set(out.split('\n').filter(Boolean))];
            if (names.length)
                this._remind(`Before you head off: ${names.length} repo${names.length === 1 ? ' has' : 's have'} uncommitted work: ` +
                    `${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''}`, 'alert', 15000);
            else if (always)
                this._note("All clean. You've got nothing uncommitted.", 2800);
        });
    }

    _endFocus(done) {
        if (done) { this._stats.focus++; this._saveStats(); }
        this._focus = null;
        this._setFocusDnd(false);
        this._syncMenu();
        if (done) {
            this._set(this._unlocked('celebration') ? 'disco' : 'dance', 3.5); this._note("Focus session complete. Nice work. Take five, you've earned it.", 5000); this._sound('done', true);
        } else {
            this._set('wave', 1.2); this._note('Okay, focus ended early. Notifications are back on.', 2200);
        }
    }

    _everySecond() {
        // Lunch: once a day between 1 and 1:30 PM, when it is free, it eats
        // from a lunchbox, then naps off the food coma.
        {
            const lb = this._b, nd = new Date(), day = nd.toDateString();
            if (lb && nd.getHours() === 13 && nd.getMinutes() < 30 && this._lunchDay !== day && !this._focus && !lb.held &&
                !this._game && lb.mode !== 'meeting' && (PRIORITY[lb.mode] ?? 0) <= 20) {
                this._lunchDay = day; lb.home = false; lb.wanderX = undefined;
                this._set('lunch', 24); this._say('Lunch time! 🥪', 1800); this._sound('happy');
            }
            let idleS = 1e9;
            try { idleS = global.backend.get_core_idle_monitor().get_idletime(); } catch {}
            const free = lb && !lb.held && !this._game && !this._focus && lb.mode !== 'meeting' && lb.mode !== 'movie' && (PRIORITY[lb.mode] ?? 0) <= 20;
            // Coffee run: once on a weekday between 3 and 3:30 PM while you are
            // at it (tried in the walk lab first, user picked it 16 Nov 2026).
            if (free && nd.getDay() >= 1 && nd.getDay() <= 5 && nd.getHours() === 15 && nd.getMinutes() < 30 &&
                idleS < 60000 && this._coffeeDay !== day) {
                this._coffeeDay = day;
                this._startCoffeeRun();
            }
            // Morning stretch: the first time you are active each day (after 5 AM).
            // The day is kept in a small file so a re-login does not repeat it.
            if (free && nd.getHours() >= 5 && idleS < 5000 && this._stretchDay !== day) {
                const mark = GLib.build_filenamev([GLib.get_user_cache_dir(), 'desk-buddy-stretch']);
                let last = '';
                try { const [ok, bytes] = GLib.file_get_contents(mark); if (ok) last = new TextDecoder().decode(bytes).trim(); } catch {}
                this._stretchDay = day;
                if (last !== day) {
                    try { GLib.file_set_contents(mark, day); } catch {}
                    lb.jacksSaid = false; lb.home = false;
                    this._set('stretch', 5); this._say('*yaaawn* Morning stretch!', 1800);
                }
            }
            // Friday after 4 PM: shades on, a weekend dance (once that day).
            if (free && nd.getDay() === 5 && nd.getHours() >= 16 && this._fridayDay !== day && idleS < 60000) {
                this._fridayDay = day; this._set('weekend', 5); this._say('Weekend! 😎', 2000); this._sound('happy');
            }
            // Night owl: still at it after 11 PM, every 20 minutes it holds up a sign.
            if (free && (nd.getHours() >= 23 || nd.getHours() < 4) && idleS < 60000 && Date.now() > (this._owlNext ?? 0)) {
                this._owlNext = Date.now() + 20 * 60000; this._set('nightowl', 5); this._say('Go to bed! 😴', 2400);
            }
            // Screensaver: you have been away five minutes while it lounges; its
            // face becomes a slow bouncing logo until you come back.
            if (lb && !lb.held && lb.mode !== 'screensaver' && this._lazy() && idleS > 5 * 60000 &&
                (LAZY_ACTS.has(lb.mode) || LIE_MODES.has(lb.mode) || ['sleep', 'stay'].includes(lb.mode))) this._set('screensaver', 3600);
            if (lb?.mode === 'screensaver' && idleS < 3000) { this._set('wake', 1.2); this._say("Oh! You're back.", 1400); }
            if (lb?.soakSay && !['fall', 'chute', 'thrown', 'jump'].includes(lb.mode)) { lb.soakSay = false; this._say('Brrr! You got me soaked!', 2000); this._sound('whoa'); }
        }
        // After you hurt it badly: once the anger passes, it lets you know it is watching you.
        const wb = this._b;
        if (wb?.watchAfter && Date.now() > wb.watchAfter && !wb.held && (PRIORITY[wb.mode] ?? 0) <= 60) { wb.watchAfter = 0; this._startWatching(); }
        if (!this._focus) return;
        const left = this._focus.until - Date.now();
        if (left <= 0) { this._endFocus(true); return; }
        const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
        this._note(`Focus ${m}:${String(s).padStart(2, '0')}`, 1500, false);
    }

    // A nudge: a mood, a speech bubble and a sound. In meetings and focus it
    // only speaks.
    _remind(text, mode, ms = 9000) {
        const b = this._b;
        this._loud = true;   // a reminder is worth hearing: its sound and voice play
        try {
            if (b.mode === 'sleep') {
                b.home = false; this._set('wake', 1.2);
            } else if (!b.held && (PRIORITY[b.mode] ?? 0) <= (PRIORITY[mode] ?? 40)) {
                b.home = false; this._set(mode, 4);
            } else {
                this._sound('reminder');   // busy with something more important: just speak
            }
            this._note(text, ms);
        } finally {
            this._loud = false;
        }
        this._lastInteract = Date.now();
    }

    _run(script, args, cb) {
        try {
            const proc = Gio.Subprocess.new(['bash', '-c', script, 'desk-buddy', ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (pr, res) => {
                let out = '';
                try { [, out] = pr.communicate_utf8_finish(res); } catch {}
                if (this._b) cb(out ?? '');
            });
        } catch (e) {
            console.error(`desk-buddy: ${e.message}`);
        }
    }

    _every5s() {
        const now = new Date();
        const inMeeting = GLib.file_test(MEETING_MARKER, GLib.FileTest.EXISTS);

        // Meeting in a few minutes (and a stand-up summary before Daily Scrum).
        const src = Main.panel.statusArea.dateMenu?._eventSource;
        if (src && !src.isLoading && this._prefs?.meetings !== false) {
            for (const ev of src.getEvents(now, new Date(now.getTime() + (Math.max(MEETING_WARN_MIN, STANDUP_WARN_MIN) + 1) * 60000))) {
                if (ev.end - ev.date >= 24 * 3600000) continue;
                const standup = STANDUP_RE.test(ev.summary ?? '');
                const ms = ev.date - now;
                if (ms <= 0 || ms > ((standup ? STANDUP_WARN_MIN : MEETING_WARN_MIN) + 0.5) * 60000) continue;
                const key = `${ev.summary}@${ev.date.getTime()}`;
                if (this._reminded.has(key)) continue;
                this._reminded.add(key);
                const at = GLib.DateTime.new_from_unix_local(Math.floor(ev.date.getTime() / 1000)).format('%-l:%M %p');
                this._remind(`Heads up: ${ev.summary} starts in ${Math.max(1, Math.round(ms / 60000))} minutes, at ${at}. The join link is on the card.`, 'watch', 12000);
                this._showMeetingCard(ev, standup);
            }
        }

        // Break: 90 minutes of activity without 5 idle minutes.
        try {
            const idle = global.backend.get_core_idle_monitor().get_idletime();
            if (idle > BREAK_IDLE_RESET_MIN * 60000) this._activeSince = Date.now();
            if (this._breakAt && Date.now() > this._breakAt) {
                this._breakAt = 0; this._lastBreakNag = Date.now();
                this._remind("It's been 30 minutes, as you asked. Time for a quick break.", 'wake');
            }
            if (this._prefs?.breaks !== false && !this._focus && !inMeeting && Date.now() - this._activeSince > BREAK_AFTER_MIN * 60000 &&
                Date.now() - this._lastBreakNag > BREAK_NAG_EVERY_MIN * 60000) {
                this._lastBreakNag = Date.now();
                this._remind(`You've been at it for ${BREAK_AFTER_MIN} minutes straight. A five-minute stretch would do you good.`, 'wake');
            }
        } catch {}

        // Jira: a ticket reassigned away from you (read from the Jira Sprint item).
        const jira = Main.extensionManager.lookup('jira-sprint@local')?.stateObj;
        for (const [key, text] of this._prefs?.jira === false ? [] : jira?._warnings ?? []) {
            if (this._jiraSeen.has(key + text)) continue;
            this._jiraSeen.add(key + text);
            this._remind(`Just so you know: ${text}.`, 'alert');
        }

        this._checkMusic();
        try {
            const d0 = new Date(); d0.setHours(0, 0, 0, 0);
            const d1 = new Date(d0.getTime() + 24 * 3600000);
            const bday = (Main.panel.statusArea.dateMenu?._eventSource?.getEvents(d0, d1) ?? [])
                .find(e => /birthday/i.test(e.summary ?? ''));
            const was = this._birthday;
            this._birthday = bday?.summary ?? null;
            if (this._birthday && this._birthday !== was && (PRIORITY[this._b.mode] ?? 0) <= 20) this._startParty();
        } catch {}
        if (this._prefs?.petAlways && !this._pet && this._tickId) this._summonPet();
        try { if (global.backend.get_core_idle_monitor().get_idletime() < 60000) this._morningBrief(); } catch {}
        if (Date.now() - (this._lastWeather ?? 0) > WEATHER_EVERY_MS) { this._lastWeather = Date.now(); this._checkWeather(); }

        // Rare surprise: only while you are around and it is free.
        try {
            const idleMs = global.backend.get_core_idle_monitor().get_idletime();
            const b = this._b;
            if (!this._focus && !inMeeting && idleMs < 120000 &&
                b.mode === 'walk' && !b.held && !this._game && Date.now() > this._nextRare) {
                this._nextRare = Date.now() + (RARE_MIN + Math.random() * (RARE_MAX - RARE_MIN)) * 60000;
                this._surprise();
            }
        } catch {}

        // Jira: one of your sprint tickets just moved to Done.
        for (const is of jira?._issues ?? []) {
            const cat = is.fields?.status?.statusCategory?.key;
            const prev = this._jiraStatus.get(is.key);
            this._jiraStatus.set(is.key, cat);
            // Moves made elsewhere (the Jira site) land here; moves made from
            // the Jira menu already set 'done' through deliverTicket().
            if (this._prefs?.jira !== false && prev && prev !== 'done' && cat === 'done')
                this._announceDone(is.key);
        }

        // End of day: uncommitted work in your repos (worktrees included).
        const day = now.toDateString();
        if (this._prefs?.eod !== false && now.getHours() >= EOD_HOUR && this._eodDay !== day) {
            this._eodDay = day;
            this._dailyWrap(false);
        }
    }

    // Menu "Stand-up summary now": the stand-up card on demand. Today's next
    // stand-up is used when there is one, so the card keeps its Join link and
    // countdown; otherwise it is a card with no meeting behind it.
    _standup() {
        const now = new Date();
        const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        const src = Main.panel.statusArea.dateMenu?._eventSource;
        const ev = (src && !src.isLoading ? src.getEvents(now, end) : [])
            .find(e => e.date > now && e.end - e.date < 24 * 3600000 && STANDUP_RE.test(e.summary ?? ''));
        if (ev) this._showMeetingCard(ev, true);
        else this._showMeetingCard({summary: 'Stand-up summary', date: now}, true, true);
    }

    // Commits since the last working day, per repo, for the stand-up card.
    // cb(rows, day): rows is [{repo, n}], day 'Friday' or 'yesterday'.
    _standupCommits(cb) {
        const d = new Date();
        const back = d.getDay() === 1 ? 3 : 1;
        const since = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
        const until = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
        const day = back === 3 ? 'Friday' : 'yesterday';
        try {
            this._run('find "$1" -maxdepth 4 -name .git -type d 2>/dev/null | while read -r g; do r=$(dirname "$g"); ' +
                'n=$(git -C "$r" log --all --since="$2" --until="$3" --author="$(git -C "$r" config user.email)" --oneline 2>/dev/null | wc -l); ' +
                '[ "$n" -gt 0 ] && echo "$(basename "$r") $n"; done',
            [this._projectsDir(), iso(since), iso(until)], out => {
                const rows = String(out ?? '').split('\n').filter(Boolean).map(r => {
                    const i = r.lastIndexOf(' ');
                    return {repo: r.slice(0, i), n: Number(r.slice(i + 1)) || 0};
                }).sort((a, b) => b.n - a.n);
                cb(rows, day);
            });
        } catch (e) {
            console.error(`desk-buddy: standup commits: ${e.message}`);
            cb([], day);
        }
    }

    // Injury from a user drop, by the share of the screen it fell.
    _landed(share) {
        const b = this._b;
        if (share >= HURT_FROM) b.quakeUntil = Date.now() + 500;   // a heavy landing shakes the ground
        if (share >= BREAK_FROM) {
            this._breakApart();
            return;
        }
        if (share >= HURT_FROM) {
            b.injury = {level: 2, until: Date.now() + LIMP_SECS * 1000};
            this._set('dizzy', 2.2); this._say('Owww… that really hurt.', 2400);
        } else if (share >= BUMP_FROM) {
            b.injury = {level: 1, until: Date.now() + 8000};
            this._set('poked', 1.2); this._say('Ouch!', 1400);
        }
    }

    _breakApart() {
        const b = this._b;
        const part = (kind, hx, hy, side) => ({
            kind, side, homeX: hx, homeY: hy, x: hx, y: hy, rot: 0,
            vx: side * (60 + Math.random() * 90), vy: -(160 + Math.random() * 160), vr: side * (6 + Math.random() * 8),
        });
        b.parts = [
            part('arm', -26, -34, -1), part('arm', 26, -34, 1),
            part('leg', -8, -6, -1), part('leg', 8, -6, 1),
        ];
        b.pendingSpin = 0;
        b.injury = {level: 2, until: Date.now() + (BREAK_SECS + LIMP_SECS) * 1000};
        this._set('broken', BREAK_SECS); this._say('OUCH! My parts!', 2200);
        // (entering 'broken' already plays the "ouch" shout, even right after a drop)
    }

    // What spinning it while held does, by full turns.
    _afterSpin() {
        const b = this._b;
        const n = b.pendingSpin ?? 0;
        if (n > 0) { this._stats.spins += n; this._saveStats(); }
        b.pendingSpin = 0;
        if (n >= 3) {
            this._set('knocked', 5); this._say('x_x', 2500);
        } else if (n === 2) {
            this._set('dizzy', 3.2); this._say('Everything is spinning…', 2600);
            b.stagger = Date.now() + 9000;
        } else if (n === 1) {
            this._set('dizzy', 2.2); this._say('Wheee… dizzy.', 2000);
        }
    }

    _crash() {
        const b = this._b;
        const kind = b.ride?.kind ?? 'skate';
        b.ride = null; b.runUntil = 0;
        b.loose = {kind, x: 0, y: -4, vx: b.dir * 140, vy: -180, rot: 0, vr: b.dir * 9, until: Date.now() + 4600};
        this._set('tumble', 0.9); this._say(kind === 'bike' ? 'Whoaaa!' : 'Uh oh!', 900);
        this._sound('thud');
    }

    // The ride that flew off bounces to a stop next to it.
    _stepLoose(dt) {
        const q = this._b.loose;
        if (Date.now() > q.until) { this._b.loose = null; return; }
        q.vy += GRAV * 0.8 * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.rot += q.vr * dt;
        if (q.y > -2) { q.y = -2; q.vy *= -0.3; q.vx *= 0.75; q.vr *= 0.5; q.rot *= 0.8; }
        const lim = AW / 2 / S - 26;
        if (Math.abs(q.x) > lim) { q.x = Math.sign(q.x) * lim; q.vx *= -0.4; }
    }

    // Parts bounce on the ground line (local y = 0), then hop back home.
    _stepParts(dt) {
        const b = this._b;
        if (!b.parts) return;
        const rejoin = b.actT < REJOIN_SECS;
        for (const q of b.parts) {
            if (rejoin) {
                const k = Math.min(1, dt * 4);
                q.x += (q.homeX - q.x) * k; q.y += (q.homeY - q.y) * k - Math.sin(b.t * 10) * 0.6;
                q.rot += (0 - q.rot) * k;
                continue;
            }
            q.vy += GRAV * 0.8 * dt;
            q.x += q.vx * dt; q.y += q.vy * dt; q.rot += q.vr * dt;
            if (q.y > -3) { q.y = -3; q.vy *= -0.35; q.vx *= 0.7; q.vr *= 0.6; }
            const lim = AW / 2 / S - 10;
            if (Math.abs(q.x) > lim) { q.x = Math.sign(q.x) * lim; q.vx *= -0.5; }
        }
    }

    _fireBullet() {
        const b = this._b;
        const actor = new St.DrawingArea({width: 34, height: 8, reactive: false});
        const dir = b.dir;
        actor.connect('repaint', a => {
            const cr = a.get_context();
            cr.setOperator(Cairo.Operator.CLEAR); cr.paint(); cr.setOperator(Cairo.Operator.OVER);
            const nose = dir > 0 ? 30 : 4;
            const pat = new Cairo.LinearGradient(dir > 0 ? 0 : 34, 0, nose, 0);   // motion streak
            pat.addColorStopRGBA(0, 1, 1, 1, 0); pat.addColorStopRGBA(1, 1, 0.9, 0.6, 0.7);
            cr.setSource(pat); cr.rectangle(dir > 0 ? 0 : nose, 3, 26, 2); cr.fill();
            cr.setSourceRGBA(0.85, 0.65, 0.25, 1); rr(cr, nose - 4, 2, 8, 4, 2); cr.fill();
            cr.$dispose();
        });
        this._addToLayer(actor);
        const x = b.x + dir * 34 * S, y = b.y - 37 * S;
        this._bullets = (this._bullets ?? []).concat({x, y, vx: dir * 1500, actor});
    }

    _stepBullets(T, dt) {
        for (const q of this._bullets) {
            q.x += q.vx * dt;
            q.actor.set_position(Math.round(q.x - 17), Math.round(q.y - 4));
            if (q.x < T.ux0 - 40 || q.x > T.ux1 + 40) { q.actor.destroy(); q.gone = true; }
        }
        this._bullets = this._bullets.filter(q => !q.gone);
    }

    // Which layer it lives in: on the wallpaper (window_group), above windows
    // (top_window_group), or, while a fullscreen window is up and it is set
    // to show above windows, the shell's own top layer, since fullscreen
    // windows cover everything below that.
    // Above windows means the shell's uiGroup, just above top_window_group
    // (and so below the top bar and the overview). top_window_group itself is
    // off limits: GNOME's layout code expects every child there to be a
    // window and throws on anything else (seen 14 Nov 2026).
    _layer() {
        return this._onTop || this._fsMode ? Main.layoutManager.uiGroup : global.window_group;
    }

    _addToLayer(actor) {
        if (this._sharing) actor.hide();
        const layer = this._layer();
        if (layer === Main.layoutManager.uiGroup) {
            layer.insert_child_above(actor, global.top_window_group);
        } else {
            layer.add_child(actor);
            layer.set_child_above_sibling(actor, this._area);
        }
    }

    _moveActors() {
        const layer = this._layer();
        // The meeting card is not in this list: it always stays above windows.
        const actors = [this._area, this._ball?.actor, this._peel?.actor, this._pet?.actor,
            ...(this._bullets ?? []).map(q => q.actor), ...(this._fx ?? []).map(f => f.actor)].filter(Boolean);
        for (const a of actors) {
            if (a.get_parent() === layer) continue;
            a.get_parent()?.remove_child(a);
            if (layer === Main.layoutManager.uiGroup) layer.insert_child_above(a, global.top_window_group);
            else layer.add_child(a);
        }
        this._terrainDirty = true;
        this._placeInStack();
    }

    _setOnTop(onTop) {
        this._onTop = onTop;
        this._syncFullscreen();
        this._moveActors();
    }

    // While you share or record your screen: everything of the buddy's hides
    // and goes silent; it all comes back when the last share stops.
    _syncShare() {
        const sharing = (this._prefs?.hideOnShare ?? true) && (this._shares?.size ?? 0) > 0;
        if (sharing === !!this._sharing) return;
        this._sharing = sharing;
        const actors = [this._area, this._ball?.actor, this._peel?.actor, this._pet?.actor, this._card?.actor,
            ...(this._bullets ?? []).map(q => q.actor), ...(this._fx ?? []).map(f => f.actor)].filter(Boolean);
        for (const a of actors) {
            if (sharing) a.hide();
            else if (a !== this._area || this._tickId) a.show();
        }
    }

    // A fullscreen window (video, slides, F11): GNOME stops compositing over
    // it, so while it is up the buddy moves to the shell's top layer and asks
    // the compositor to keep drawing; afterwards it moves back.
    _syncFullscreen() {
        if (!this._area) return;
        const fs = this._onTop && Main.layoutManager.monitors.some((_m, i) => global.display.get_monitor_in_fullscreen(i));
        if (fs === !!this._fsMode) return;
        this._fsMode = fs;
        try {
            if (fs) global.compositor.disable_unredirect();
            else global.compositor.enable_unredirect();
        } catch (e) {
            console.error(`desk-buddy: unredirect: ${e.message}`);
        }
        this._moveActors();
    }

    // A banana peel left on the ground for a while: its own small actor.
    // Tosses the peel over its shoulder: it flies in an arc, tumbling, and
    // lands somewhere 1-3 body lengths away, where it stays for a few minutes.
    // Birthday party (a calendar event mentioning "birthday" today): party hat,
    // cake and confetti, sings Happy Birthday line by line with the name from
    // the event ("Asha's birthday", "Birthday: Asha"), then blows out the candles.
    _startParty() {
        const bd = this._birthday ?? '';
        const name = (bd.match(/^(.*?)['’]s birthday/i)?.[1] ?? bd.match(/birthday\s*[:\-–]\s*(.+)$/i)?.[1] ?? '').trim();
        this._b.party = {sung: 0, name: name || 'friend', blown: false};
        this._b.wanderX = undefined;
        this._set('party', 9.5);
        this._note('🎉 Party time!', 1800); this._sound('happy');
    }

    _stepParty() {
        const b = this._b, pt = b.party;
        if (!pt) return;
        const el = 9.5 - b.actT;
        const lines = [[1.6, '♪ Happy birthday to you ♪'], [3.6, '♪ Happy birthday to you ♪'],
            [5.6, `♪ Happy birthday dear ${pt.name} ♪`], [7.6, '♪ Happy birthday to you! ♪']];
        if (pt.sung < lines.length && el >= lines[pt.sung][0]) {
            this._say(lines[pt.sung][1], 1900, false, true); this._sound(pt.sung === 3 ? 'happy' : 'chirp'); pt.sung++;
        }
        if (!pt.blown && el >= 9) { pt.blown = true; this._say('*fwoo* 🎉', 900, false, true); this._sound('done'); }
    }

    // Dance-off (three quick clicks): you wiggle the mouse for 4.5 s, then it
    // dances your moves back (the recorded pointer path moves its body), and
    // calls the winner. Your score is how much you moved.
    _startDanceoff() {
        const b = this._b;
        if (this._focus || b.mode === 'meeting' || b.held) return;
        this._stopGame(false);
        b.parked = false; b.home = false; b.wanderX = undefined;
        const [px, py] = global.get_pointer();
        b.dof = {phase: 'you', el: 0, samples: [], last: [px, py], moved: 0, ox: 0, oy: 0};
        this._set('danceoff', 14);
        this._note('Dance-off! Your turn: wiggle the mouse!', 2600); this._sound('happy');
    }

    _stepDanceoff(dt) {
        const b = this._b, d = b.dof;
        if (!d) { this._set('walk'); return; }
        d.el += dt;
        if (d.phase === 'you') {
            const [px, py] = global.get_pointer();
            const dx = px - d.last[0], dy = py - d.last[1];
            d.last = [px, py]; d.samples.push([dx, dy]); d.moved += Math.hypot(dx, dy);
            if (d.el >= 4.5) { d.phase = 'me'; d.el = 0; this._say('My turn!', 1200); this._sound('chirp'); }
        } else if (d.phase === 'me') {
            const n = d.samples.length, i = Math.min(n - 1, Math.floor(d.el / 4.5 * n));
            const [dx, dy] = n ? d.samples[i] : [0, 0];
            d.ox = Math.max(-18, Math.min(18, d.ox * 0.9 + dx * 0.12));
            d.oy = Math.max(-14, Math.min(3, d.oy * 0.85 + dy * 0.08));
            d.cur = Math.min(1, Math.hypot(dx, dy) / 40);
            if (d.el >= 4.5) {
                d.phase = 'done'; d.ox = 0; d.oy = 0;
                if (d.moved < 400) { this._set('tease', 2.6); this._say('You barely moved! I win! 🏆', 2400); }
                else if (Math.random() < 0.5) { this._set('dance', 2.6); this._say('I win! Hehe. 🏆', 2200); }
                else { this._set('shy', 2.4); this._say('Okay… you win. This time.', 2400); }
                b.dof = null;
            }
        }
    }

    // Slow-motion mime: white gloves, its hands trace your pointer's moves a
    // beat late and in slow motion, and it drifts along after the pointer.
    _startMime() {
        const [px, py] = global.get_pointer();
        this._b.mime = {ox: px, oy: py, hx: 0, hy: 0};
        this._b.wanderX = undefined;
        this._set('mime', 8);
        this._say('Mime time… 🤫', 1400);
    }

    _stepMime(dt) {
        const b = this._b, mm = b.mime;
        if (!mm) return;
        const [px, py] = global.get_pointer();
        const tx = Math.max(-14, Math.min(14, (px - mm.ox) / 25)), ty = Math.max(-16, Math.min(10, (py - mm.oy) / 25));
        const k = 1 - Math.pow(0.12, dt);   // slow motion: catches up over a couple of seconds
        mm.hx += (tx - mm.hx) * k; mm.hy += (ty - mm.hy) * k;
        b.x += Math.max(-25, Math.min(25, px - b.x)) * 0.25 * dt;
        b.dir = px > b.x ? 1 : -1;
    }

    // Hide and seek: "Count to ten…", a puff, and it is crouched behind a bush
    // somewhere along the floor, peeking now and then. Click it to find it;
    // after a minute it gives up and gloats.
    _startHide() {
        const b = this._b, T = this._T;
        if (!T) return;
        this._say('Hide and seek! Count to ten…', 2000);
        b.x = T.ux0 + 60 + Math.random() * Math.max(1, T.ux1 - T.ux0 - 120);
        b.y = T.ground; b.on = null; b.vx = 0; b.vy = 0; b.parked = false; b.home = false;
        this._terrainDirty = true;
        this._set('hide', 60);
    }

    // Rolling sideways along the floor to where it wanted to go, then a sit.
    _stepRoll(dt) {
        const b = this._b, d = Math.sign((b.rollTo ?? b.x) - b.x);
        if (!d || Math.abs(b.rollTo - b.x) < 4 || b.on !== null) { this._set('sit', 5 + Math.random() * 5); return; }
        const sp = 45 * dt;
        b.x += d * sp; b.dir = d;
        b.rollAng = (b.rollAng ?? 0) + d * sp / (BW * S / 2);
    }

    // "I'm watching you", as a little scene: it stomps in heavily (thuds, a
    // shake on each step), stops and stares straight out at you with stern
    // brows, holds a V of two fingers to its eyes and jabs it out at you
    // (twice), then walks off leaning back with its eyes still on you,
    // pointing back over its shoulder.
    _startWatching() {
        const b = this._b, T = this._T;
        b.wanderX = undefined; b.runUntil = 0; b.ride = null;
        // It heads for the nearer side of the screen and will walk off that
        // edge at the end. Too far from it, it starts a little closer, so the
        // exit takes a few seconds rather than a long trek across the monitors.
        let sgn = 1, edge = b.x;
        const ground = !(typeof b.on === 'number');
        if (T && ground) {
            sgn = (T.ux1 - b.x) < (b.x - T.ux0) ? 1 : -1;
            edge = sgn > 0 ? T.ux1 : T.ux0;
            if (Math.abs(edge - b.x) > 520) { b.x = edge - sgn * 400; this._terrainDirty = true; }
        }
        b.dir = sgn;
        // On the floor it first steps off its nearer edge, so the scene can
        // open with a proper entrance from that edge.
        b.wy = {phase: ground ? 'leave' : 'scene', t: 0, pt: 0, step: 0, sgn, edge, ground, said: false};
        this._set('watchingyou', 120);   // ends itself; the long time is only a safety net
    }

    // Coffee run: off the nearer screen edge, a moment out of sight, back with
    // a steaming mug, a few sips standing ("Ahh. Coffee."), then it sits down
    // with the cup in the existing 'coffee' pose. On a window top (no edge to
    // walk off) it just has its coffee where it is.
    _startCoffeeRun() {
        const b = this._b, T = this._T;
        b.wanderX = undefined; b.runUntil = 0; b.ride = null; b.backUntil = 0; b.moonUntil = 0;
        if (!T || typeof b.on === 'number') { this._set('coffee', 6); this._say('Coffee time.', 1400); return; }
        const sgn = (T.ux1 - b.x) < (b.x - T.ux0) ? 1 : -1, edge = sgn > 0 ? T.ux1 : T.ux0;
        if (Math.abs(edge - b.x) > 520) { b.x = edge - sgn * 400; this._terrainDirty = true; }
        b.dir = sgn;
        b.cr = {phase: 'leave', pt: 0, sgn, edge, cup: false, offscreen: false, said: false};
        this._say('Coffee run!', 1200);
        this._set('coffeerun', 60);   // ends itself; the time is a safety net
    }

    _stepCoffeeRun(dt) {
        const b = this._b, c = b.cr;
        if (!c) { this._set('walk'); return; }
        c.pt += dt;
        const next = ph => { c.phase = ph; c.pt = 0; };
        switch (c.phase) {
        case 'leave':
            b.dir = c.sgn; c.offscreen = true;
            b.x += c.sgn * 90 * dt; b.dist = (b.dist ?? 0) + 90 * dt;
            if (c.sgn * (b.x - c.edge) > 45) next('gone');
            break;
        case 'gone':
            if (c.pt > 2) { c.cup = true; b.dir = -c.sgn; next('back'); }
            break;
        case 'back':
            b.dir = -c.sgn;
            b.x -= c.sgn * 70 * dt; b.dist = (b.dist ?? 0) + 70 * dt;
            if (c.sgn * (c.edge - b.x) > 40) c.offscreen = false;
            if (c.sgn * (c.edge - b.x) > 160) next('sip');
            break;
        case 'sip':
            if (!c.said && c.pt > 0.8) { c.said = true; this._say('Ahh. Coffee.', 1800); }
            if (c.pt > 3.5) { b.cr = null; this._set('coffee', 6); }
            break;
        }
    }

    _stepWatching(dt) {
        const b = this._b, wy = b.wy, T = this._T;
        if (!wy) { this._set('walk'); return; }
        wy.t += dt; wy.pt += dt;
        const move = sp => {   // walk along its surface, never off a ledge
            const nx = b.x + b.dir * sp * dt, s2 = T && this._below(T, nx, b.y - 4);
            if (s2 && Math.abs(s2.top - b.y) < 2 && nx > T.ux0 + 30 && nx < T.ux1 - 30) { b.x = nx; b.dist = (b.dist ?? 0) + sp * dt; }
        };
        const next = ph => { wy.phase = ph; wy.pt = 0; };
        switch (wy.phase) {
        case 'leave':   // a brisk walk off the edge, nothing dramatic yet
            b.dir = wy.sgn; wy.moving = true; wy.offscreen = true;
            b.x += wy.sgn * 120 * dt; b.dist = (b.dist ?? 0) + 120 * dt;
            if (wy.sgn * (b.x - wy.edge) > 45) { wy.t = 0; wy.step = 0; next('scene'); }
            break;
        case 'scene': {
            const el = wy.t;
            if (el < WATCH.in) {
                wy.moving = true;
                if (wy.ground) {   // marches in from beyond the edge, facing you-ward
                    b.dir = -wy.sgn; b.x -= wy.sgn * WATCH_IN_SPEED * dt; b.dist = (b.dist ?? 0) + WATCH_IN_SPEED * dt;
                } else {
                    b.dir = wy.sgn; move(34);
                }
                const step = Math.floor(el / 0.4);
                if (step > wy.step) { wy.step = step; this._sound('thud'); b.quakeUntil = Date.now() + 110; }
            } else {
                wy.moving = false;
                // Two-part line timed to the hands: "I'm watching…" at its eyes, "…YOU." as it points.
                if (!wy.said && el > WATCH.eyes) { wy.said = true; this._say("I'm watching…", 1200); }
                if (!wy.said2 && el > WATCH.eyes + 0.45 * WATCH_CYCLE) { wy.said2 = true; this._say('…YOU. 👉', 2000); }
            }
            if (el >= WATCH.gesture) next(wy.ground ? 'off' : 'done');
            break;
        }
        case 'off':   // backs out the way it came, still facing you (user, 16 Nov 2026)
            b.dir = -wy.sgn; wy.moving = true; wy.offscreen = true;
            b.x += wy.sgn * 55 * dt; b.dist = (b.dist ?? 0) + 55 * dt;
            if (wy.sgn * (b.x - wy.edge) > 45) next('gone');
            break;
        case 'gone':
            wy.moving = false;
            if (wy.pt > 0.8) { b.x = wy.edge + wy.sgn * 10; next('peek'); }   // mostly hidden; the lean brings its eyes on screen
            break;
        case 'peek':   // leans back in from the edge for one last glare
            if (wy.pt > 1.6) { b.x = wy.edge + wy.sgn * 45; next('gone2'); }
            break;
        case 'gone2':
            if (wy.pt > 1.5) { b.dir = -wy.sgn; next('back'); }
            break;
        case 'back':   // and strolls back in as if nothing happened
            b.dir = -wy.sgn; wy.moving = true;
            b.x -= wy.sgn * 50 * dt; b.dist = (b.dist ?? 0) + 50 * dt;
            if (wy.sgn * (wy.edge - b.x) > 60) next('done');
            break;
        }
        if (wy.phase === 'done') { b.wy = null; this._set('walk'); }
    }

    // Runs from the snake: flat out, screaming now and then, the other way.
    // If that side is nearly out of room it runs past the snake instead.
    _startFlee() {
        const b = this._b, T = this._T ?? {ux0: 0, ux1: global.stage.width};
        let away = Math.sign(b.x - (b.snakeAt?.x ?? b.x + b.dir)) || -b.dir;
        const room = s => s > 0 ? T.ux1 - 40 - b.x : b.x - (T.ux0 + 40);
        if (room(away) < 200 && room(-away) > room(away)) away = -away;
        const now = Date.now();
        b.dir = away;
        b.fleeUntil = now + 3500; b.fleeScream = now + 900;
        b.wanderX = Math.max(T.ux0 + 40, Math.min(T.ux1 - 40, b.x + away * (500 + Math.random() * 300)));
        b.wanderLock = b.fleeUntil; b.runUntil = b.fleeUntil; b.speedMul = 1.5;
        this._nextAct = Math.max(this._nextAct ?? 0, b.fleeUntil + 3000);   // no new trick mid-escape
        this._set('walk');
        this._say('AAAAAH!', 1100); this._sound('whoa');
    }

    _stepFlee() {
        const b = this._b, now = Date.now();
        if (!b.fleeUntil) {
            // the trick was cut short (picked up, etc.) before it ran: tidy up
            if (b.mode !== 'magic') { b.snakeAt = null; b.magicItem = null; }
            return;
        }
        if (now < b.fleeUntil) {
            b.runUntil = b.fleeUntil;
            if (now > b.fleeScream && b.mode === 'walk') {
                b.fleeScream = now + 1000 + Math.random() * 400;
                this._sound(Math.random() < 0.5 ? 'whoa' : 'ouch');
                this._say(['Aaah!', 'Nope nope nope!', 'Not today!'][Math.floor(Math.random() * 3)], 800);
            }
            return;
        }
        b.fleeUntil = 0; b.snakeAt = null; b.speedMul = 1; b.wanderX = undefined; b.wanderLock = 0;
        if (b.mode === 'walk') {   // still on its feet: catch its breath
            this._set('sit', 2.5); this._say('Phew… escaped!', 1600); this._sound('happy');
        }
    }

    _throwPeel() {
        this._removePeel();
        const b = this._b;
        const toss = Math.random() < 0.7 ? -b.dir : b.dir;   // usually over the shoulder
        const actor = new St.DrawingArea({width: 26, height: 26, reactive: false});
        const peel = {x: b.x + b.dir * 20, y: b.y - 50 * S, vx: toss * (220 + Math.random() * 240), vy: -(260 + Math.random() * 160),
            rot: 0, flying: true, at: Date.now(), passes: 0, slipAfter: 2 + Math.floor(Math.random() * 2), side: 0, actor};
        actor.connect('repaint', a => {
            const cr = a.get_context();
            cr.setOperator(Cairo.Operator.CLEAR); cr.paint(); cr.setOperator(Cairo.Operator.OVER);
            cr.translate(13, 19); cr.rotate(peel.rot);
            // an empty peel lying splayed: four yellow strips with brown tips
            // round a little stem, outlined so it reads at this size
            for (const [ex, ey] of [[-11, 4], [-5, -2], [5, -2], [11, 4]]) {
                cr.moveTo(-1.5, 3); cr.curveTo(ex * 0.3 - 1, 0, ex - 1, ey - 3, ex, ey);
                cr.lineTo(ex + Math.sign(ex) * 1.5, ey + 2); cr.curveTo(ex * 0.5, ey + 1, ex * 0.2 + 1, 3, 1.5, 4.5); cr.closePath();
                cr.setSourceRGBA(0.99, 0.84, 0.18, 1); cr.fillPreserve();
                cr.setSourceRGBA(0.72, 0.52, 0.08, 1); cr.setLineWidth(0.8); cr.stroke();
                cr.setSourceRGBA(0.4, 0.28, 0.1, 1); cr.newSubPath(); cr.arc(ex, ey + 0.8, 1, 0, 2 * Math.PI); cr.fill();
            }
            cr.setSourceRGBA(0.42, 0.3, 0.12, 1); rr(cr, -1.2, 2, 2.4, 4, 0.8); cr.fill();
            cr.$dispose();
        });
        this._addToLayer(actor);
        this._peel = peel;
        this._peelTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 240, () => { this._peelTimer = 0; this._removePeel(); return GLib.SOURCE_REMOVE; });
    }

    // A screenshot: strike a pose for it.
    _onScreenshot() {
        const b = this._b;
        if (!b || b.held || (PRIORITY[b.mode] ?? 0) > 30 || Date.now() - (this._lastPose ?? 0) < 5000) return;
        this._lastPose = Date.now();
        this._set('pose', 2.5); this._sound('shutter');
    }

    // A window dragged right up to it gets a high-five.
    _checkHighFive(T) {
        const b = this._b, now = Date.now();
        const seen = new Map();
        for (const r of T.rects) {
            seen.set(r.id, r);
            const prev = this._rectPrev.get(r.id);
            if (!prev || (prev.x0 === r.x0 && prev.top === r.top)) continue;
            if (now - this._lastHighFive < 15000 || b.held || !['walk', 'look', 'sit', 'stay', 'typing'].includes(b.mode)) continue;
            const near = Math.abs(r.x0 - b.x) < 45 ? r.x0 : Math.abs(r.x1 - b.x) < 45 ? r.x1 : null;
            if (near === null || r.top > b.y - 10 || r.bottom < b.y - BH * S) continue;
            this._lastHighFive = now;
            b.dir = near > b.x ? 1 : -1;
            this._set('highfive', 1.4); this._sound('chirp'); this._say('High five!', 1000);
        }
        this._rectPrev = seen;
    }

    // A paper plane glides across your screens, bobbing and sinking slowly.
    _throwPlane() {
        const b = this._b, dir = b.dir;
        const actor = new St.DrawingArea({width: 30, height: 18, reactive: false});
        actor.connect('repaint', a => {
            const cr = a.get_context();
            cr.setOperator(Cairo.Operator.CLEAR); cr.paint(); cr.setOperator(Cairo.Operator.OVER);
            cr.translate(15, 9); cr.scale(dir, 1);
            cr.setSourceRGBA(0.96, 0.96, 0.98, 1); cr.moveTo(12, 0); cr.lineTo(-12, -6); cr.lineTo(-6, 0); cr.lineTo(-12, 6); cr.closePath(); cr.fill();
            cr.setSourceRGBA(0.7, 0.72, 0.78, 1); cr.setLineWidth(0.8); cr.moveTo(12, 0); cr.lineTo(-6, 0); cr.stroke();
            cr.$dispose();
        });
        this._addToLayer(actor);
        const st = {x: b.x + dir * 30 * S, y: b.y - 45 * S, vx: dir * (260 + Math.random() * 120), t: 0};
        this._fx.push({actor, step: (dt, T) => {
            st.t += dt; st.x += st.vx * dt; st.y += (14 + Math.sin(st.t * 3) * 40) * dt;
            actor.set_position(Math.round(st.x - 15), Math.round(st.y - 9));
            return st.x > T.ux0 - 40 && st.x < T.ux1 + 40 && st.y < T.ground;
        }});
    }

    // Graffiti: sprays a small heart or smiley on the wallpaper next to it;
    // it fades away after a minute.
    _startGraffiti() {
        const b = this._b;
        const kind = Math.random() < 0.5 ? 'heart' : 'smiley';
        const size = 44, actor = new St.DrawingArea({width: size, height: size, reactive: false});
        const g = {k: 0, alpha: 1, kind};
        actor.connect('repaint', a => {
            const cr = a.get_context();
            cr.setOperator(Cairo.Operator.CLEAR); cr.paint(); cr.setOperator(Cairo.Operator.OVER);
            cr.translate(size / 2, size / 2); cr.setLineCap(Cairo.LineCap.ROUND); cr.setLineWidth(3);
            const k = Math.min(1, g.k);
            if (g.kind === 'heart') {
                cr.setSourceRGBA(1, 0.35, 0.55, 0.85 * g.alpha);
                cr.moveTo(0, 14); cr.curveTo(-22, -2, -10, -20, 0, -8); cr.curveTo(10, -20, 22, -2, 0, 14);
                cr.stroke();
            } else {
                cr.setSourceRGBA(1, 0.85, 0.25, 0.9 * g.alpha);
                cr.arc(0, 0, 15, 0, 2 * Math.PI * k); cr.stroke();
                if (k > 0.6) { cr.newSubPath(); cr.arc(-5, -4, 1.8, 0, 2 * Math.PI); cr.fill(); cr.newSubPath(); cr.arc(5, -4, 1.8, 0, 2 * Math.PI); cr.fill(); }
                if (k > 0.85) { cr.newSubPath(); cr.arc(0, 2, 8, 0.4, Math.PI - 0.4); cr.stroke(); }
            }
            cr.$dispose();
        });
        this._addToLayer(actor);
        const gx = b.x + b.dir * 44 * S, gy = b.y - 50 * S;
        actor.set_position(Math.round(gx - size / 2), Math.round(gy - size / 2));
        actor.opacity = 0;
        this._fx.push({actor, step: dt => {
            g.k += dt / 2.2;
            actor.opacity = Math.round(255 * Math.min(1, g.k * 1.5));
            if (g.k > 1) g.alpha = Math.max(0, 1 - (g.k - 1) / 27);   // fades over about a minute
            actor.queue_repaint();
            return g.alpha > 0;
        }});
        this._set('paint', 2.4);
    }

    // The robot pet: a small robo-dog that tags along for a few minutes and
    // fetches the ball during a game.
    _summonPet() {
        if (this._pet) return;
        const b = this._b;
        const actor = new St.DrawingArea({width: 44, height: 34, reactive: false});
        const pet = {x: b.x - b.dir * 300, y: b.y, dir: b.dir, t: 0, until: Date.now() + 180000, actor, moving: false};
        actor.connect('repaint', a => this._paintPet(a, pet));
        this._addToLayer(actor);
        this._pet = pet;
        this._say('Here, boy!', 1400); this._sound('happy');
    }

    _stepPet(T, dt) {
        const pet = this._pet, b = this._b;
        pet.t += dt;
        if (pet.trick) {
            pet.trick.k += dt;
            if (pet.trick.k > 4.2) pet.trick = null;
            else { pet.moving = false; pet.dir = b.x > pet.x ? 1 : -1; pet.actor.queue_repaint(); return; }
        }
        if (this._prefs?.petAlways) pet.until = Date.now() + 60000;   // kept around
        if (Date.now() > pet.until) { pet.actor.destroy(); this._pet = null; return; }
        const ball = this._ball;
        if (pet.carry && (!ball || ball.held || this._game?.kind !== 'ball')) { pet.carry = false; if (ball) ball.carried = false; }
        const tx = pet.carry ? b.x + (pet.x < b.x ? -26 : 26) : b.mode === 'petnap' ? b.x - b.dir * 46 : ball && this._game?.kind === 'ball' ? ball.x : b.x - b.dir * 50;
        pet.napping = b.mode === 'petnap';
        const dx = tx - pet.x;
        pet.moving = Math.abs(dx) > 8 && b.mode !== 'sleep';
        if (pet.moving) {
            pet.dir = dx > 0 ? 1 : -1;
            pet.x += pet.dir * Math.min(Math.abs(dx), (ball ? 230 : 120) * dt);
        }
        pet.y = this._below(T, pet.x, T.wa.y)?.top ?? T.ground;
        // Fetch: picks the ball up in its mouth, trots it back to Tiko and drops
        // it at its feet; Tiko pats it: "Good boy!"
        if (pet.carry) {
            ball.x = pet.x + pet.dir * 14; ball.y = pet.y - 12; ball.vx = 0; ball.vy = 0;
            if (Math.abs(pet.x - tx) < 8) {
                pet.carry = false; ball.carried = false; ball.vy = -140; ball.vx = Math.sign(b.x - ball.x) * 70;
                ball.kickedAt = Date.now(); pet.nextFetch = Date.now() + 2500;
                if (!b.held && (PRIORITY[b.mode] ?? 0) <= 20) { this._set('love', 1.4); this._say('Good boy!', 1400); this._sound('happy'); }
            }
        } else if (ball && !ball.held && this._game?.kind === 'ball' && Math.abs(ball.x - pet.x) < 18 && Math.abs(ball.y - pet.y) < 30 &&
            Date.now() - (ball.kickedAt ?? 0) > 700 && Date.now() > (pet.nextFetch ?? 0)) {
            pet.carry = true; ball.carried = true;
        }
        pet.actor.set_position(Math.round(pet.x - 22), Math.round(pet.y - 30));
        pet.actor.queue_repaint();
    }

    _paintPet(area, pet) {
        const cr = area.get_context();
        cr.setOperator(Cairo.Operator.CLEAR); cr.paint(); cr.setOperator(Cairo.Operator.OVER);
        cr.translate(22, 30); cr.scale(pet.dir, 1);
        let sit = !pet.moving;
        if (pet.trick) {
            const k = pet.trick.k;
            if (k > 1.3 && k < 2.6) { cr.translate(0, -12); cr.rotate((k - 1.3) / 1.3 * 2 * Math.PI); cr.translate(0, 12); }   // roll over
            else if (k >= 2.6) { cr.translate(0, -12); cr.rotate(Math.PI); cr.translate(0, 8); }                                    // play dead, legs up
            sit = true;
        }
        const step = pet.moving ? Math.sin(pet.t * 14) * 3 : 0;
        rgb(cr, C.limb); cr.setLineWidth(3.5); cr.setLineCap(Cairo.LineCap.ROUND);
        for (const [lx, ph] of [[-8, 0], [-4, Math.PI], [6, Math.PI], [10, 0]]) {
            cr.moveTo(lx, -9); cr.lineTo(lx + (pet.moving ? Math.sin(pet.t * 14 + ph) * 3 : 0), sit && lx < 0 ? -3 : -1); cr.stroke();
        }
        rgb(cr, C.shell); rr(cr, -13, -19 + (sit ? 3 : 0), 26, 12, 5); cr.fill();                      // body
        rgb(cr, C.shell); rr(cr, 8, -28 + (sit ? 3 : 0), 14, 12, 4); cr.fill();                        // head
        rgb(cr, C.screen); rr(cr, 10, -26 + (sit ? 3 : 0), 10, 8, 3); cr.fill();
        rgb(cr, C.glow); for (const ex of [13, 17]) { rr(cr, ex - 1, -24 + (sit ? 3 : 0), 2, 3, 1); cr.fill(); }
        rgb(cr, C.purple); cr.moveTo(10, -27 + (sit ? 3 : 0)); cr.lineTo(8, -33 + (sit ? 3 : 0)); cr.lineTo(13, -28 + (sit ? 3 : 0)); cr.closePath(); cr.fill();   // ear
        if (pet.napping && !pet.moving) {   // curled up asleep next to Tiko
            rgb(cr, C.glow); cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD); cr.setFontSize(7);
            cr.moveTo(16, -32 - ((pet.t * 6) % 6)); cr.showText('z');
        }
        rgb(cr, C.teal); cr.setLineWidth(2.5);                                                        // wagging tail
        const wag = pet.napping ? 0 : Math.sin(pet.t * (pet.moving ? 18 : 10)) * 5;
        cr.moveTo(-13, -16 + (sit ? 3 : 0)); cr.lineTo(-19, -23 + wag + (sit ? 3 : 0)); cr.stroke();
        void step;
        cr.$dispose();
    }

    // Media players (MPRIS). Music players make it dance and say the song.
    // Anything else (browsers, VLC, mpv, Videos) is taken to be a video, and
    // it settles in for movie night instead. Only the play state and the
    // title are read, never what is on screen.
    _checkMusic() {
        const bus = Gio.DBus.session;
        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', null, null,
            Gio.DBusCallFlags.NONE, -1, null, (_c, res) => {
                let names = [];
                try { names = bus.call_finish(res).deepUnpack()[0].filter(n => n.startsWith('org.mpris.MediaPlayer2.')); } catch {}
                if (!names.length) { this._music = null; this._setVideo(null); return; }
                let pending = names.length, found = null, video = null;
                for (const name of names) {
                    bus.call(name, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'GetAll',
                        new GLib.Variant('(s)', ['org.mpris.MediaPlayer2.Player']), null, Gio.DBusCallFlags.NONE, 1000, null, (_c2, r2) => {
                            try {
                                const props = bus.call_finish(r2).recursiveUnpack()[0];
                                const md = props.Metadata ?? {};
                                // Browsers do not say music or video, but music sites (Spotify,
                                // YouTube Music) send an album and videos do not.
                                const album = String(md['xesam:album'] ?? '').trim();
                                const isMusic = MUSIC_PLAYERS.test(name.slice('org.mpris.MediaPlayer2.'.length)) || album.length > 0;
                                if (isMusic && props.PlaybackStatus === 'Playing' && !found) {
                                    const artist = [].concat(md['xesam:artist'] ?? [])[0];
                                    found = {title: md['xesam:title'] ?? 'something good', artist};
                                } else if (!isMusic && ['Playing', 'Paused'].includes(props.PlaybackStatus) &&
                                    (!video || (video.status !== 'Playing' && props.PlaybackStatus === 'Playing'))) {
                                    video = {status: props.PlaybackStatus, title: md['xesam:title'] ?? '', player: name.slice('org.mpris.MediaPlayer2.'.length).split('.')[0]};
                                }
                            } catch {}
                            if (--pending === 0) {
                                const was = this._music?.title;
                                this._music = found;
                                this._setVideo(video);
                                if (found && found.title !== was && this._b && this._b.mode !== 'movie' && (PRIORITY[this._b.mode] ?? 0) <= 20) {
                                    this._set('dance', 4);
                                    this._say(`♪ ${found.title}${found.artist ? ` by ${found.artist}` : ''}`, 3000);
                                }
                            }
                        });
                }
            });
    }

    // One viewing session lasts while a video stays playing or paused; it
    // ends at the first check that finds none, which resets the doze clock.
    _setVideo(v) {
        if (v && !this._video) this._videoSince = Date.now();
        this._video = v;
    }

    // Called every second: joins a playing video on the sofa, and keeps it
    // out of the way of a fullscreen video.
    _syncMovie() {
        const b = this._b;
        if (!b) return;
        const now = Date.now();
        const playing = this._video?.status === 'Playing';
        // Pulled off the sofa (poked, dragged, a reminder) while the video
        // still plays: it waits 20 s before sitting back down.
        if (this._wasMovie && b.mode !== 'movie' && !this._movieEnded) this._movieBlock = now + 20000;
        this._wasMovie = b.mode === 'movie'; this._movieEnded = false;
        if (playing && b.mode !== 'movie' && !b.held && !b.parked && !this._game && !b.fleeUntil && !b.snakeAt &&
            now > (this._movieBlock ?? 0) && (PRIORITY[b.mode] ?? 0) <= 20) {
            b.movie = {phase: 'in', k: 0, munchAt: -9, nextMunch: b.t + 2, nextReact: b.t + 15 + Math.random() * 20, react: null};
            b.wanderX = undefined; b.runUntil = 0; b.ride = null;
            this._set('movie');
            this._say('Movie time!', 1400); this._sound('chirp');
        }
        if (b.mode === 'movie') this._findVideoWindow();
        if (b.mode === 'movie' && b.movie?.phase === 'watch' && playing && !b.movie.doze && !b.movie.away && !this._fsHide) this._sampleScene();
        // Listen to the loudness only while it sits watching a playing video.
        const listen = b.mode === 'movie' && b.movie?.phase === 'watch' && playing;
        if (listen && !this._lvlProc && !this._lvlOff) this._startLevel();
        else if (!listen && this._lvlProc) this._stopLevel();
        // Fullscreen video on its monitor: it moves to a monitor without one;
        // with nowhere to go it hides until fullscreen ends.
        const mons = Main.layoutManager.monitors;
        let mine = mons.findIndex(m => b.x >= m.x && b.x < m.x + m.width);
        if (mine < 0) mine = Main.layoutManager.primaryIndex;
        let hide = false;
        if (playing && global.display.get_monitor_in_fullscreen(mine)) {
            const other = mons.findIndex((_m, i) => i !== mine && !global.display.get_monitor_in_fullscreen(i));
            if (other >= 0 && !b.held) {
                const r = global.workspace_manager.get_active_workspace().get_work_area_for_monitor(other);
                b.x = r.x + r.width * 0.75; b.y = r.y + r.height; b.vx = 0; b.vy = 0; b.on = null;
                this._terrainDirty = true;
                this._say('Better seat over here.', 1600, false);
            } else {
                hide = true;
            }
        }
        if (hide !== !!this._fsHide) {
            this._fsHide = hide;
            if (this._area) { this._area.reactive = !hide; this._area.queue_repaint(); }
        }
    }

    // Where the video is, so its eyes can watch it even on another monitor:
    // the window whose title contains the video's title (browsers put the tab
    // title there), else the biggest window of the player's app. Window
    // titles are only compared, never stored or sent anywhere.
    _findVideoWindow() {
        const v = this._video;
        this._videoRect = null;
        if (!v) return;
        const want = (v.title ?? '').toLowerCase().slice(0, 24).trim();
        const app = /chrom/i.test(v.player) ? /chrom|brave|edge|vivaldi|opera/i : new RegExp(v.player.replace(/[^a-z0-9]/gi, ''), 'i');
        let best = null, bestScore = 0;
        for (const a of global.get_window_actors()) {
            const w = a.meta_window;
            if (!w || w.minimized || isDesktopWindow(w) || !w.showing_on_its_workspace?.()) continue;
            const r = w.get_frame_rect();
            const cls = `${w.get_wm_class() ?? ''} ${w.get_gtk_application_id?.() ?? ''}`;
            const title = (w.get_title() ?? '').toLowerCase();
            const score = (want && title.includes(want) ? 1e9 : 0) + (app.test(cls) ? r.width * r.height : 0);
            if (score > bestScore) { bestScore = score; best = r; }
        }
        this._videoBox = best ? {x: best.x, y: best.y, w: best.width, h: best.height} : null;
        if (best) this._videoRect = {x: best.x + best.width / 2, y: best.y + best.height / 2};
    }

    _startLevel() {
        try {
            this._lvlProc = Gio.Subprocess.new(LEVEL_CMD, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            // no pw-record (not PipeWire): movie night works without sound cues
            console.log(`desk-buddy: no sound level: ${e.message}`);
            this._lvlProc = null; this._lvlOff = true; return;
        }
        const proc = this._lvlProc, stream = proc.get_stdout_pipe(), cancel = new Gio.Cancellable();
        this._lvlCancel = cancel;
        this._lvl = {slow: 0, quietSince: Date.now(), nextJump: Date.now() + 5000};
        const read = () => stream.read_bytes_async(1600, GLib.PRIORITY_LOW, cancel, (st, res) => {
            let d;
            try { d = st.read_bytes_finish(res).toArray(); } catch { return; }
            if (this._lvlProc !== proc) return;
            if (!d.length) { this._stopLevel(); return; }
            const dv = new DataView(d.buffer, d.byteOffset, d.length - (d.length % 2));
            let sum = 0, n = 0;
            for (let i = 0; i + 1 < dv.byteLength; i += 8) { const v = dv.getInt16(i, true) / 32768; sum += v * v; n++; }
            this._onLevel(n ? Math.sqrt(sum / n) : 0);
            read();
        });
        read();
    }

    _stopLevel() {
        this._lvlCancel?.cancel(); this._lvlCancel = null;
        try { this._lvlProc?.force_exit(); } catch {}
        this._lvlProc = null; this._lvl = null;
        if (this._b?.movie) this._b.movie.drowsy = false;
    }

    _onLevel(rms) {
        const l = this._lvl, mv = this._b?.movie, now = Date.now();
        if (!l || !mv) return;
        if (rms > LOUD_JUMP && rms > l.slow * LOUD_RATIO && now > l.nextJump) { l.nextJump = now + 20000; mv.startle = true; }
        l.slow = l.slow * 0.97 + rms * 0.03;   // about a 3 s average
        l.long = (l.long ?? l.slow) * 0.997 + rms * 0.003;   // about 30 s, to tell a loud scene from a loud film
        if (rms > QUIET_LEVEL) l.quietSince = now;
        mv.drowsy = now - l.quietSince > QUIET_DROWSY_MS;
    }

    // Movie night, one step: the sofa slides in, it watches and munches
    // popcorn, reacts now and then, complains when you pause, and when the
    // video ends it brushes off the crumbs and the sofa slides away.
    // Reactions are silent so they never talk over the video.
    // Long sessions build up (see LW): episode tallies, a pile of empties,
    // stretches, a blanket, a bathroom break, glasses, pizza, cushions, a
    // badge, naps it wakes up from, and a tidy-up at the end.
    _stepMovie(dt) {
        const b = this._b, mv = b.movie, now = Date.now();
        if (!mv) { this._set('walk'); return; }
        const v = this._video;
        if (mv.phase === 'in') {
            mv.k = Math.min(1, mv.k + dt / 0.9);
            if (mv.k >= 1) { mv.phase = 'watch'; this._sound('boop'); }
            return;
        }
        if (mv.phase === 'out') {
            mv.outT -= dt;
            mv.k = Math.max(0, Math.min(1, mv.outT / 0.8));
            if (mv.outT <= 0) { const fl = mv.float; b.movie = null; this._movieEnded = true; b.vy = 0; this._set(fl ? 'fall' : 'walk'); }
            return;
        }
        const mins = (now - (this._videoSince ?? now)) / 60000;
        // a long session ends with a stretch and picking up the empties
        const leave = text => {
            mv.long = mins > LW.blanket && !mv.float;
            mv.phase = 'out'; mv.outT = mv.long ? 3.4 : 1.6; mv.k = 1; mv.paused = false; mv.away = null; mv.react = null;
            this._say(mv.long && !mv.doze ? `${text} Tidy-up time.` : text, 1600);
        };
        if (!v) { leave(mv.doze ? 'Huh? Did I miss the end?' : 'Good one!'); return; }
        if (v.status === 'Paused') {
            if (!mv.paused) {
                mv.paused = true; mv.pausedAt = now;
                if (!mv.doze && !mv.away) { this._say('Hey, I was watching that!', 1800); this._sound('boop'); }
            } else if (now - mv.pausedAt > 4 * 60000) {
                leave('Okay, show is over.'); return;
            }
            return;
        }
        if (mv.paused) {
            mv.paused = false;
            if (!mv.doze && !mv.away) this._say("Yay, it's back!", 1000, false);
        }
        // off the sofa: the bathroom, or the fridge after midnight
        if (mv.away) {
            mv.away.t += dt;
            if (mv.away.t > 8.2) {
                const fridge = mv.away.kind === 'fridge';
                mv.away = null;
                if (fridge) { mv.milkUntil = now + 5 * 60000; this._say('Milk and a cookie. Perfect.', 1600, false); }
                else this._say('Did I miss anything?', 1600, false);
            }
            return;
        }
        // naps: wakes after a while or at a loud moment, then watches on
        if (mv.doze) {
            if (mins < mv.dozeUntil && !mv.startle) return;
            mv.doze = false; mv.startle = false; mv.nextDoze = mins + MOVIE_REDOZE_MIN;
            mv.react = {kind: 'stretch', at: b.t, until: b.t + 2.5};
            this._say('Huh? What did I miss?', 1600, false);
            return;
        }
        if (mins > (mv.nextDoze ?? MOVIE_DOZE_MIN) && !mv.react) {
            mv.doze = true; mv.dozeUntil = mins + MOVIE_DOZE_LEN_MIN; this._say('Zzz…', 1400, false);
            return;
        }
        // a new episode: the tab title changes ("(1) " notification counts ignored)
        const title = (v.title ?? '').replace(/^\(\d+\)\s*/, '');
        if (title !== mv.title) {
            if (mv.title !== undefined && title) {
                mv.eps = (mv.eps ?? 0) + 1;
                this._say(mv.eps >= 3 ? 'One more? …okay, one more.' : 'Next episode!', 1600, false);
            }
            mv.title = title; mv.mood = MOVIE_MOODS.find(([, re]) => re.test(title))?.[0] ?? 'none';
        }
        if (mv.startle) {
            mv.startle = false; mv.drowsy = false;
            const kind = mv.mood === 'scary' ? 'hide' : 'gasp';
            mv.react = {kind, at: b.t, until: b.t + 2.2};
            this._say(kind === 'hide' ? 'EEK!' : 'Whoa!', 1000, false);
            return;
        }
        // long-watching stages
        if (mins > LW.blanket && !mv.blanket) { mv.blanket = true; this._say('Blanket time.', 1200, false); }
        mv.tired = mins > LW.tired;
        const cushions = mins < LW.cushionFrom ? 0 : Math.min(6, 1 + Math.floor((mins - LW.cushionFrom) / LW.cushionEvery));
        if (cushions > (mv.cushions ?? 0)) { mv.cushions = cushions; this._say(cushions === 1 ? 'Need a cushion.' : 'Fort upgrade.', 1200, false); }
        if (mins > LW.pizza && !mv.pizza) { mv.pizza = true; mv.pizzaAt = b.t; mv.pop = 1; this._say("Pizza's here!", 1500, false); }
        if (mins > LW.badge && !mv.badge) { mv.badge = true; this._say('Achievement: Couch Potato!', 1800, false); }
        const hour = new Date().getHours(), began = new Date(this._videoSince ?? now).getHours();
        if (!mv.dawnAt && hour >= 5 && hour < 9 && (began >= 22 || began < 5)) { mv.dawnAt = b.t; this._say("…it's morning.", 2000, false); }
        if (mv.tired && !mv.drowsy && b.t > (mv.nextYawn ?? 0)) { mv.nextYawn = b.t + 360 + Math.random() * 240; if (mv.saidTired) this._say('*yawn*', 1200, false); mv.saidTired = true; }
        if (mv.drowsy && !mv.saidDrowsy) { mv.saidDrowsy = true; this._say('*yawn*', 1200, false); }
        if (!mv.drowsy) mv.saidDrowsy = false;
        mv.beer ??= {left: 1, open: false};
        mv.pop ??= 1;
        if (b.t > mv.nextMunch) {
            mv.munchAt = b.t; mv.nextMunch = b.t + (mv.drowsy || mv.tired ? 9 : 3) + Math.random() * 4;
            mv.pop = Math.max(0, mv.pop - (mv.pizza ? 0.06 : 0.035));
            if (mv.pop <= 0) {
                mv.pop = 1; mv.tubs = (mv.tubs ?? 0) + 1;
                this._say(mv.pizza ? 'Last slice! …ordering another.' : 'Out of popcorn! …refill.', 1400, false);
            }
            if (Math.random() < 0.2) this._say(mv.pizza ? 'nom' : 'crunch', 600, false);
        }
        if (mv.react) {
            const r = mv.react;
            if (r.kind === 'dig' && !r.said && b.t - r.at > 2.6) { r.said = true; this._say({coin: 'Found a coin!', sock: 'A sock? Whose sock?', remote: 'The remote! There you are.'}[r.item], 1500, false); }
            if (b.t > r.until) {
                if (r.kind === 'open') mv.beer.open = true;
                if (r.kind === 'rub') { mv.glasses = true; this._say('Much better.', 1200, false); }
                if (r.kind === 'sip') {
                    mv.beer.left = Math.max(0, mv.beer.left - 0.25);
                    if (mv.beer.left <= 0) { mv.beer = {left: 1, open: false}; mv.cans = (mv.cans ?? 0) + 1; this._say('Empty! Another one.', 1400, false); }
                    else if (mv.burp) this._say('*burp* …excuse me.', 1400, false);
                }
                mv.react = null;
            }
            return;
        }
        const react = (kind, len, text) => { mv.react = {kind, at: b.t, until: b.t + len}; if (text) this._say(text, 1300, false); };
        if (mins > (mv.nextStretch ?? LW.stretch)) { mv.nextStretch = mins + LW.stretchEvery; react('stretch', 2.5, '*streeetch*'); return; }
        if (mins > LW.glasses && !mv.glasses) { react('rub', 2.5, 'My eyes…'); return; }
        if (mins > LW.loo && !mv.didLoo) { mv.didLoo = true; mv.away = {kind: 'loo', t: 0}; this._say('Bathroom break! Be right back.', 1500, false); return; }
        if (hour < 4 && mins > 10 && !mv.didFridge) { mv.didFridge = true; mv.away = {kind: 'fridge', t: 0}; this._say('Midnight snack run!', 1500, false); return; }
        // now and then in a long session: hunt in the cushions, a leg cramp, the phone
        mv.nextExtra ??= b.t + 240 + Math.random() * 240;
        if (mins > LW.extrasFrom && b.t > mv.nextExtra && !mv.drowsy) {
            mv.nextExtra = b.t + 360 + Math.random() * 300;
            const pick = ['dig', 'cramp', 'phone'][Math.floor(Math.random() * 3)];
            if (pick === 'dig') { react('dig', 4.2, 'Hmm, what is down here?'); mv.react.item = ['coin', 'sock', 'remote'][Math.floor(Math.random() * 3)]; }
            else if (pick === 'cramp') react('cramp', 2.5, 'Ow, pins and needles!');
            else react('phone', 7, null);
            return;
        }
        if (mv.drowsy && b.t > (mv.nextPhone ?? 0)) { mv.nextPhone = b.t + 300; react('phone', 7, null); return; }   // a quiet stretch: it scrolls its phone
        if (b.t > mv.nextReact && !mv.drowsy) {
            const pool = MOVIE_REACTS[mv.mood ?? 'none'];
            let r = Math.random() * pool.reduce((a, [, wt]) => a + wt, 0), kind = pool[0][0];
            for (const [k, wt] of pool) { if ((r -= wt) < 0) { kind = k; break; } }
            if (kind === 'sip' && !mv.beer.open) kind = 'open';   // the first sip needs the cap off
            mv.burp = kind === 'sip' && Math.random() < 0.35;
            mv.nextReact = b.t + (mv.mood === 'none' ? 25 + Math.random() * 35 : 15 + Math.random() * 20);
            react(kind, kind === 'hide' ? 3 : 2.2, MOVIE_SAY[kind]);
        }
    }

    // What kind of scene is on: a few single pixels of the video window, read
    // about once a second (Shell.Screenshot.pick_color), give its brightness,
    // its main colour and how much the picture changed. Only those numbers are
    // kept, never an image, and nothing leaves the machine. Points under Tiko
    // itself are skipped.
    _sampleScene() {
        const box = this._videoBox, now = Date.now();
        if (!box || (this._sceneBusy && now - this._sceneBusy < 5000)) return;
        this._shot ??= new Shell.Screenshot();
        const [ax, ay] = this._area?.get_transformed_position() ?? [-1e5, -1e5];
        const pts = [];
        for (let j = 0; j < 2; j++) {
            for (let i = 0; i < 4; i++) {
                const px = Math.round(box.x + box.w * (0.15 + i * 0.7 / 3)), py = Math.round(box.y + box.h * (0.3 + j * 0.4));
                if (!(px >= ax && px < ax + AW && py >= ay && py < ay + AH)) pts.push([px, py]);
            }
        }
        if (pts.length < 6) return;
        this._sceneBusy = now;
        const out = new Array(pts.length).fill(null);
        let left = pts.length;
        pts.forEach(([px, py], i) => {
            this._shot.pick_color(px, py, (o, res) => {
                try { const [, c] = o.pick_color_finish(res); out[i] = [c.get_red(), c.get_green(), c.get_blue()]; } catch {}
                if (--left > 0) return;
                this._sceneBusy = 0;
                const got = out.filter(Boolean);
                if (got.length === pts.length) this._onScene(got);
            });
        });
    }

    // Turns the samples and the sound level into a scene guess and a reaction,
    // at most one every 20 s. Each guess needs to hold for a few samples so a
    // single odd frame does nothing.
    _onScene(px) {
        const b = this._b, mv = b?.movie;
        if (!mv || mv.phase !== 'watch' || mv.doze || mv.away || mv.paused) return;
        const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
        const lum = px.map(([r, g, bl]) => 0.3 * r + 0.59 * g + 0.11 * bl);
        const L = mean(lum), dark = lum.filter(q => q < 0.08).length / lum.length, bright = lum.filter(q => q > 0.5).length;
        const red = mean(px.map(([r, g, bl]) => r - (g + bl) / 2)), cool = mean(px.map(([r, g, bl]) => (g + bl) / 2 - r));
        const s = this._scene ??= {};
        const diff = s.lum?.length === lum.length ? mean(lum.map((q, i) => Math.abs(q - s.lum[i]))) : 0;
        const jump = s.L !== undefined ? L - s.L : 0;
        s.lum = lum; s.L = L;
        const lv = this._lvl, slow = lv?.slow ?? 0, long = lv?.long ?? slow;
        const loud = slow > 0.03 && slow > long * 1.4;
        (s.slowHist ??= []).push(slow); if (s.slowHist.length > 6) s.slowHist.shift();
        const swell = s.slowHist.length >= 6 && slow > 0.02 && slow > s.slowHist[0] * 1.6;
        (s.cuts ??= []).push(diff > 0.15); if (s.cuts.length > 3) s.cuts.shift();
        const hold = (key, on) => (s[key] = on ? (s[key] ?? 0) + 1 : 0);
        const credits = hold('credN', dark >= 0.6 && bright >= 1 && diff > 0.01);
        const darkN = hold('darkN', dark >= 0.75);
        const coolN = hold('coolN', cool > 0.1 && diff < 0.06 && !loud);
        const stillN = hold('stillN', diff < 0.03 && slow < QUIET_LEVEL * 2);
        if (mv.react || b.t < (mv.sceneNext ?? 0)) return;
        const mins = (Date.now() - (this._videoSince ?? Date.now())) / 60000;
        let kind = null;
        if (credits >= 5 && mins > 20 && mv.clappedFor !== mv.title) { kind = 'clap'; mv.clappedFor = mv.title; }
        else if (jump > 0.3) kind = 'squint';
        else if (s.cuts.filter(Boolean).length >= 2 && loud) kind = 'action';
        else if (red > 0.18 && loud) kind = 'grit';
        else if (darkN >= 4) kind = 'cold';
        else if (swell && diff < 0.05) kind = 'heart';
        else if (coolN >= 4) kind = 'calm';
        else if (stillN >= 20) { kind = 'bored'; s.stillN = 0; }
        if (!kind) return;
        mv.react = {kind, at: b.t, until: b.t + (kind === 'clap' ? 3 : 2.4)};
        mv.sceneNext = b.t + 20;
        this._say(MOVIE_SAY[kind], 1200, false);
    }

    // Weather for its outfit: an umbrella in rain, shades in the sun, a scarf in the cold.
    _checkWeather() {
        if (this._prefs?.weather === false) { this._weather = null; return; }
        this._http ??= new Soup.Session({timeout: 15, user_agent: 'desk-buddy'});
        const msg = Soup.Message.new('GET', weatherUrl(this._prefs?.weatherCity));
        if (!msg) return;
        this._http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() !== 200) return;
                const [cond = '', temp = '', wind = ''] = new TextDecoder().decode(bytes.get_data()).trim().split('|');
                const c = Number.parseInt(temp.replace(/[^-\d]/g, ''), 10);
                const hour = new Date().getHours();
                this._weather = {
                    text: `${cond.trim()} ${temp.trim()}`,
                    // "Patchy rain nearby" is not rain here: no umbrella for that
                    rain: /rain|drizzle|shower|thunder|sleet/i.test(cond) && !/nearby|possible/i.test(cond),
                    sun: /sun|clear/i.test(cond) && hour >= 7 && hour < 18,
                    cold: Number.isFinite(c) && c < 12,
                    tempC: Number.isFinite(c) ? c : null,
                    snow: /snow|blizzard|sleet/i.test(cond) && !/nearby|possible/i.test(cond),
                    windy: (Number.parseInt(wind.replace(/[^\d]/g, ''), 10) || 0) >= 15,
                    // wind speed and which way it blows across the screen, from the arrow (→ 11km/h)
                    windKmh: Number.parseInt(wind.replace(/[^\d]/g, ''), 10) || 0,
                    windDir: /[↗→↘]/.test(wind) ? 1 : /[↖←↙]/.test(wind) ? -1 : 0,
                };
            } catch {}
        });
    }

    _stepPeel(T, dt) {
        const q = this._peel;
        if (q.flying) {
            const prevY = q.y;
            q.vy += GRAV * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.rot += q.vx * dt * 0.03;
            q.x = Math.max(T.ux0 + 15, Math.min(T.ux1 - 15, q.x));
            const s = this._below(T, q.x, prevY);
            if (s && q.y >= s.top && q.vy > 0) { q.y = s.top; q.flying = false; q.rot = 0; q.side = Math.sign(this._b.x - q.x) || 1; }
            q.actor.queue_repaint();
        }
        q.actor.set_position(Math.round(q.x - 13), Math.round(q.y - 19));
    }

    _removePeel() {
        if (this._peelTimer) { GLib.source_remove(this._peelTimer); this._peelTimer = 0; }
        this._peel?.actor.destroy();
        this._peel = null;
    }

    // The magic-show snake as its own small sprite: it tumbles out of the hat
    // onto the floor, then slithers off the other way from Tiko, wiggling,
    // until it leaves the screen (or after 9 s).
    _spawnSnake() {
        const b = this._b, at = b.snakeAt;
        if (!at || this._snake) return;
        const actor = new St.DrawingArea({width: 150, height: 80, reactive: false});
        const sn = {x: at.x, y: at.y, top: at.y - 42 * S, dir: Math.sign(at.x - b.x) || 1, t: 0, actor};
        actor.connect('repaint', a => this._paintSnake(a, sn));
        this._addToLayer(actor);
        this._snake = sn;
    }

    _stepSnake(T, dt) {
        const sn = this._snake;
        sn.t += dt;
        if (sn.t > 0.45) sn.x += sn.dir * 85 * dt;   // slithering
        if (sn.t > 9 || sn.x < T.ux0 - 60 || sn.x > T.ux1 + 60) { sn.actor.destroy(); this._snake = null; return; }
        sn.actor.set_position(Math.round(sn.x - 75), Math.round(sn.y - 66));
        sn.actor.queue_repaint();
    }

    _paintSnake(area, sn) {
        const cr = area.get_context();
        cr.setOperator(Cairo.Operator.CLEAR); cr.paint(); cr.setOperator(Cairo.Operator.OVER);
        cr.translate(75, 66); cr.scale(S, S);
        cr.setLineCap(Cairo.LineCap.ROUND); cr.setLineJoin(Cairo.LineJoin.ROUND);
        const d = sn.dir, t = sn.t;
        let pts;
        if (t < 0.45) {
            // tumbling out of the hat: drops from hat height, curled, spinning
            const q = t / 0.45, hy = -(1 - q * q) * 34 - 3;
            cr.translate(0, hy); cr.rotate(q * 4 * d);
            pts = []; for (let k = 0; k <= 10; k++) { const a = k / 10 * Math.PI * 1.6; pts.push([Math.cos(a) * (9 - k * 0.4), Math.sin(a) * (9 - k * 0.4)]); }
            pts.reverse();
        } else {
            // flat on the floor, an S-curve wave travelling down its body
            pts = []; for (let k = 0; k <= 12; k++) { const bx = -d * k * 3.2; pts.push([bx, -3 + Math.sin(t * 10 - k * 0.7) * 3 * Math.min(1, k / 3)]); }
        }
        cr.setSourceRGBA(0.28, 0.66, 0.3, 1); cr.setLineWidth(6);
        cr.moveTo(pts[0][0], pts[0][1]); for (const [px, py] of pts.slice(1)) cr.lineTo(px, py); cr.stroke();
        cr.setSourceRGBA(0.85, 0.75, 0.25, 1); cr.setLineWidth(1.3);   // belly stripes
        for (let k = 2; k < pts.length - 1; k += 2) { cr.moveTo(pts[k][0] - 1, pts[k][1] - 1.5); cr.lineTo(pts[k][0] + 1, pts[k][1] + 1.5); }
        cr.stroke();
        const [hx, hy] = pts[0];
        cr.save(); cr.translate(hx + d * 3, hy); cr.scale(d, 1);
        cr.setSourceRGBA(0.28, 0.66, 0.3, 1); cr.save(); cr.scale(1.4, 1); cr.newSubPath(); cr.arc(0, 0, 4.2, 0, 2 * Math.PI); cr.restore(); cr.fill();
        cr.setSourceRGBA(1, 1, 1, 1); cr.newSubPath(); cr.arc(1.5, -1.8, 1.5, 0, 2 * Math.PI); cr.fill();
        cr.setSourceRGBA(0, 0, 0, 1); cr.newSubPath(); cr.arc(2, -1.8, 0.7, 0, 2 * Math.PI); cr.fill();
        if (Math.sin(t * 14) > 0) {
            cr.setSourceRGBA(0.9, 0.15, 0.2, 1); cr.setLineWidth(0.9);
            cr.moveTo(5.5, 0.8); cr.lineTo(9, 0.8); cr.lineTo(10.5, -0.6); cr.moveTo(9, 0.8); cr.lineTo(10.5, 2); cr.stroke();
        }
        cr.restore();
        cr.$dispose();
    }

    // A window side within reach ahead, tall enough to be worth running up.
    _startWallRun() {
        const b = this._b, T = this._T;
        const r = T?.rects.find(q => {
            const side = b.dir > 0 ? q.x0 : q.x1, dist = (side - b.x) * b.dir;
            return dist > 40 && dist < 260 && q.top < b.y - 70 && q.top > b.y - 380 && q.bottom >= b.y - 20;
        });
        if (!r) return;
        b.wr = {phase: 0, k: 0, wallX: b.dir > 0 ? r.x0 : r.x1, top: r.top, id: r.id};
        b.on = null;
        this._set('wallrun'); this._say('Parkour time!', 1000);
    }

    // Snowballs lobbed at your pointer (they splat and vanish; nothing is hit).
    _throwSnowball() {
        const b = this._b, [px, py] = global.get_pointer();
        const actor = new St.DrawingArea({width: 14, height: 14, reactive: false});
        actor.connect('repaint', a => {
            const cr = a.get_context();
            cr.setOperator(Cairo.Operator.CLEAR); cr.paint(); cr.setOperator(Cairo.Operator.OVER);
            cr.setSourceRGBA(1, 1, 1, 0.95); cr.arc(7, 7, 5, 0, 2 * Math.PI); cr.fill();
            cr.$dispose();
        });
        this._addToLayer(actor);
        const x0 = b.x + b.dir * 20 * S, y0 = b.y - 50 * S, T = 0.9;
        const st = {x: x0, y: y0, vx: (px - x0) / T, vy: (py - y0) / T - GRAV * 0.5 * T, t: 0};
        this._fx.push({actor, step: dt => {
            st.t += dt; st.vy += GRAV * dt; st.x += st.vx * dt; st.y += st.vy * dt;
            actor.set_position(Math.round(st.x - 7), Math.round(st.y - 7));
            return st.t < T + 0.05;
        }});
    }

    // Right-click: the same menu, popped up right next to Tiko. Every entry
    // mirrors its Quick Settings item (activating or toggling that item), so
    // the two menus can never disagree. Rebuilt each time it opens.
    _openMenu() {
        const ind = this._indicator;
        if (!ind) return;
        this._syncMenu();   // fresh labels (focus and break time left, pet, activity) before mirroring
        // Anchor the menu to a 1-px point just above Tiko's head: the drawing
        // area itself is much taller (room for speech bubbles), so attaching to
        // it left a big gap above Tiko.
        if (!this._menuAnchor) {
            this._menuAnchor = new St.Widget({width: 1, height: 1, reactive: false});
            Main.uiGroup.add_child(this._menuAnchor);
        }
        const b = this._b;
        this._menuAnchor.set_position(Math.round(b.x), Math.round(b.y - (BH + 14) * S));
        if (!this._popup) {
            this._popup = new PopupMenu.PopupMenu(this._menuAnchor, 0.5, St.Side.BOTTOM);
            this._popupMgr = new PopupMenu.PopupMenuManager(this._area);
            this._popupMgr.addMenu(this._popup);
            Main.uiGroup.add_child(this._popup.actor);
            this._popup.actor.hide();
        }
        const menu = this._popup;
        menu.removeAll();
        const mirror = (target, into) => {
            if (!target.visible) return;
            if (target instanceof PopupMenu.PopupSeparatorMenuItem) {
                into.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(target.label.text));
                return;
            }
            if (target instanceof PopupMenu.PopupSwitchMenuItem) {
                const sw = new PopupMenu.PopupSwitchMenuItem(target.label.text, target.state);
                sw.connect('toggled', () => target.toggle());
                into.addMenuItem(sw);
            } else {
                const it = new PopupMenu.PopupMenuItem(target.label.text);
                if (target._actKey) it.setOrnament(target._actKey === (this._prefs?.activity ?? 'normal')
                    ? PopupMenu.Ornament.DOT : (PopupMenu.Ornament.NO_DOT ?? PopupMenu.Ornament.NONE));
                it.connect('activate', () => target.emit('activate', null));
                into.addMenuItem(it);
            }
        };
        mirror(ind.soundSwitch, menu);
        for (const [title, items] of ind.sections) {
            const sub = new PopupMenu.PopupSubMenuMenuItem(title);
            for (const target of items.filter(Boolean)) mirror(target, sub.menu);
            menu.addMenuItem(sub);
        }
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const off = new PopupMenu.PopupMenuItem('Turn Tiko off');
        off.connect('activate', () => { ind.toggle.checked = false; });
        menu.addMenuItem(off);
        this._syncMenu();
        menu.open();
    }

    // Start a walking style from the menu: gets it walking, with somewhere to go.
    // Magic show: what comes out of the hat is a surprise, and it reacts to each.
    _startMagic() {
        const b = this._b;
        const pool = [['rabbit', 30], ['snake', 18], ['dove', 14], ['flowers', 12], ['bomb', 10], ['empty', 9], ['confetti', 7]];
        let r = Math.random() * pool.reduce((a, [, wgt]) => a + wgt, 0);
        b.magicItem = pool.find(([, wgt]) => (r -= wgt) < 0)?.[0] ?? 'rabbit';
        this._set('magic', 4.5); this._say('Ta-da… magic!', 1400);
    }

    _walkStyle(key, line) {
        const b = this._b;
        if (b.held || (PRIORITY[b.mode] ?? 0) > 60) return;
        b.home = false; b.parked = false; b.ride = null; b.runUntil = 0; b.moonUntil = 0; b.backUntil = 0;
        if (b.mode !== 'walk') this._set('walk');
        b[key] = Date.now() + 5000;
        this._nextAct = Date.now() + 7000;   // no random trick cutting in
        b.wanderLock = Date.now() + 5000;    // and no wandering change of mind
        const T = this._T;
        const span = 350;
        const room = T ? (b.dir > 0 ? T.ux1 - 40 - b.x : b.x - (T.ux0 + 40)) : span;
        if (room < span) b.dir *= -1;   // not enough room ahead: go the other way
        b.wanderX = b.x + b.dir * span; b.speedMul = 1;
        this._say(line, 1200);
        if (key === 'moonUntil') this._sound('happy');
    }

    // --- section 17 tricks ---------------------------------------------------

    _startSlide() {
        const b = this._b, T = this._T;
        const s = T?.surfaces.find(q => q.id === b.on);
        if (!s) return;
        const edge = b.dir > 0 ? s.x1 : s.x0;
        const x1 = edge + b.dir * 90;
        const land = this._below(T, x1, s.top + 2);
        if (!land) return;
        b.slide = {x0: b.x, y0: b.y, x1, y1: land.top, k: 0}; b.on = null;
        this._set('slide'); this._say('Wheee, slide!', 1200);
    }

    _startHang() {
        const b = this._b, T = this._T;
        const s = T?.surfaces.find(q => q.id === b.on);
        if (!s) return;
        b.x = b.dir > 0 ? s.x1 - 6 : s.x0 + 6;
        b.hangTop = s.top; b.y = s.top + (BH + 8) * S; b.on = null;
        this._set('hang', 4); this._say('Hanging around.', 1600);
    }

    _startTarzan() {
        const b = this._b, L = 120;
        b.tz = {ax: b.x + b.dir * L * Math.sin(0.9), ay: b.y - 12 - L, L, k: 0, y0: b.y};
        b.on = null;
        this._set('tarzan'); this._say('Aaah-ee-aaaah!', 1600);
    }

    // Rare surprises: a UFO abduction, a clone army or a disco.
    _surprise(kind) {
        const b = this._b;
        if (b.held || this._focus) return;
        kind ??= ['ufo', 'army', 'disco', 'rocket'][Math.floor(Math.random() * 4)];
        b.home = false;
        if (kind === 'ufo') { b.ufo = {k: 0}; this._set('ufo'); this._say('What is that?!', 1400); }
        else if (kind === 'army') { this._set('army', 4); this._say('Assemble, clones!', 1600); }
        else if (kind === 'rocket') { b.rocket = {k: 0, said: 0}; b.on = null; this._set('rocket'); this._say('Building a rocket!', 1600); }
        else { this._set('disco', 5); this._say('Disco time!', 1400); this._sound('happy'); }
    }

    _stepTrick(T, dt) {
        const b = this._b;
        switch (b.mode) {
        case 'handstand': {
            b.actT -= dt;
            const ahead = this._below(T, b.x + b.dir * 30, b.y);
            if (ahead && Math.abs(ahead.top - b.y) < 4) { b.x += b.dir * SPEED * 0.45 * dt; b.dist = (b.dist ?? 0) + SPEED * 0.45 * dt; }
            else b.dir *= -1;
            if (b.actT <= 0) { this._set('walk'); this._say('Ta-da!', 1000); }
            break;
        }
        case 'slide': {
            const s = b.slide;
            s.k = Math.min(1, s.k + dt / 1.3);
            b.x = s.x0 + (s.x1 - s.x0) * s.k;
            b.y = s.y0 + (s.y1 - s.y0) * s.k * s.k;
            if (s.k >= 1) { b.y = s.y1; this._set('laugh', 1.5); this._say('Again!', 1000); }
            break;
        }
        case 'hang':
            b.actT -= dt;
            if (b.actT <= 0) { b.vy = 0; b.vx = 0; this._set('fall'); }
            break;
        case 'jetfail':
            b.actT -= dt;
            b.y -= 160 * dt;
            if (b.actT <= 0) {
                b.vx = (Math.random() - 0.5) * 300; b.vy = -80;
                b.dropFrom = b.y; b.dropH = T.wa.height;
                this._set('fall'); this._say('Uh oh, out of fuel!', 1400); this._sound('whoa');
            }
            break;
        case 'tarzan': {
            const z = b.tz;
            z.k = Math.min(1, z.k + dt / 2.2);
            const th = (-0.9 + 1.8 * z.k) * b.dir;
            const tx = z.ax + Math.sin(th) * z.L, ty = z.ay + Math.cos(th) * z.L;
            const k0 = Math.min(1, z.k / 0.12);   // the first moment: leap up to the rope
            b.x = tx; b.y = z.y0 + (ty - z.y0) * k0;
            if (z.k >= 1) { b.vx = b.dir * 90; b.vy = -60; this._set('fall'); }
            break;
        }
        case 'ufo': {
            const u = b.ufo;
            u.k += dt;
            if (u.k > 4) {
                b.y = T.wa.y + T.wa.height * 0.12; b.vy = 0; b.ufo = null; b.on = null;
                this._set('chute'); this._say('They gave me back!', 1800);
            }
            break;
        }
        case 'teleport': {
            const e = b.tele;
            e.k += dt / 1.2;
            if (e.k >= 0.5 && !e.moved) {
                e.moved = true;
                const left = b.x > (T.ux0 + T.ux1) / 2;
                b.x = left ? T.ux0 + 60 : T.ux1 - 60;
                b.y = this._below(T, b.x, T.wa.y)?.top ?? T.ground; b.on = null;
            }
            if (e.k >= 1) { b.tele = null; this._set('wave', 1.2); this._say('Ta-da!', 1000); }
            break;
        }
        case 'bugchase': {
            // creeps after a bug on the ground with a net, then swipes
            const g = b.bug;
            g.k += dt;
            if (g.k < 4.5) { b.x += b.dir * 35 * dt; b.dist = (b.dist ?? 0) + 35 * dt; }
            if (g.k > 4.6 && !g.swung) {   // the net comes down
                g.swung = true; this._sound('thud'); this._say(g.caught ? 'Swoosh! Gotcha!' : 'Swoosh!', 900);
            }
            if (g.k > 5.4) {
                b.bug = null;
                if (g.caught) { this._set('dance', 2); this._say('Got it! (setting it free)', 1600); this._sound('happy'); }
                else { this._set('angry', 1.6); this._say('It got away!', 1200); this._sound('ouch'); }
            }
            break;
        }
        case 'wallrun': {
            // runs to a window side, up it, then a backflip onto the top
            const w = b.wr;
            w.k += dt;
            if (w.phase === 0) {
                b.x += b.dir * 160 * dt; b.dist = (b.dist ?? 0) + 160 * dt;
                if ((b.dir > 0 && b.x >= w.wallX - 18) || (b.dir < 0 && b.x <= w.wallX + 18)) { w.phase = 1; b.x = w.wallX - b.dir * 18; }
            } else if (w.phase === 1) {
                b.y -= 260 * dt; b.dist = (b.dist ?? 0) + 260 * dt;
                if (b.y <= w.top + 10) { w.phase = 2; w.flip = 0; }
            } else {
                w.flip += dt / 0.6;
                b.x += b.dir * 70 * dt; b.y = w.top - Math.sin(Math.min(1, w.flip) * Math.PI) * 40;
                if (w.flip >= 1) { b.y = w.top; b.on = w.id; b.wr = null; this._set('tease', 1.5); this._say('Parkour!', 1000); }
            }
            break;
        }
        case 'mirror': {
            // copies your pointer like a mime: moves the way it moves
            const m = b.mirror, [px] = global.get_pointer();
            m.k += dt;
            b.x += Math.max(-8, Math.min(8, (px - m.px) * 0.6)); m.px = px;
            b.y = this._below(T, b.x, b.y - 4)?.top ?? b.y;
            if (m.k > 7) { b.mirror = null; this._set('wave', 1.2); this._say('Mime show over!', 1200); }
            break;
        }
        case 'rocket': {
            const r = b.rocket;
            r.k += dt;
            // 0-1.2 s hammering it together, then 3… 2… 1…, then lift-off
            const count = Math.floor(r.k - 1.2) + 1;
            if (r.k > 1.2 && r.k < 4.2 && count > r.said) { r.said = count; this._say(String(4 - count), 800); this._sound('beep'); }
            if (r.k > 4.2) {
                if (!r.lift) { r.lift = true; this._say('Blast off!', 1200); this._sound('whoa'); }
                r.v = (r.v ?? 0) + 900 * dt;
                b.y -= r.v * dt;
                if (b.y < T.wa.y - 40) {
                    b.y = T.wa.y + T.wa.height * 0.15; b.vy = 0; b.rocket = null;
                    this._set('chute'); this._say('Space was cold.', 1600);
                }
            }
            break;
        }
        case 'stuck': {
            // Magnet losing its grip: it slides down the window side, faster
            // as it goes, and once it is a short drop above whatever is below
            // it pushes off the wall with a flip and lands on its feet. It
            // used to slide 2.5 s and then flop off from wherever it was
            // (user asked for the parkour exit, 16 Nov 2026).
            b.slideV = Math.min(PARKOUR_SLIDE_MAX, (b.slideV ?? 30) + 220 * dt);
            b.y += b.slideV * dt;
            const s = this._below(T, b.x - b.stuckSide * 40, b.y);
            const ground = s ? s.top : T.ground, h = ground - b.y;
            // Jump off near the ground, or when it slides past the window's bottom corner.
            if (h <= PARKOUR_FROM * S || b.y - STUCK_REACH * S >= (b.stuckBottom ?? Infinity))
                this._startParkour();
            break;
        }
        case 'parkour':
            this._stepParkour(T, dt);
            break;
        }
    }


    // --- magnet-mode parkour exits ------------------------------------------
    // Fifteen ways off a window side (ten clean, five that go wrong), tried
    // out in the walk lab first and picked at random. Each exit is a list of
    // beats run one after another: say a line, fly (ballistic, spinning to an
    // end angle, landing on whatever is below), land (a crouch and a dust
    // puff), hold a pose, a custom tween, or get up. No landing here counts as
    // a fall: no injuries, no _landed().

    _startParkour() {
        const b = this._b, side = b.stuckSide, away = -side, TAU = 2 * Math.PI;
        const fly = (vx, vy, rEnd, extra = {}) => ({k: 'fly', vx: vx * away, vy, rEnd, look: 'fall', ...extra});
        const land = (depth = 0.6, extra = {}) => ({k: 'land', depth, ms: 0.26, ...extra});
        const say = (text, ms = 1300) => ({k: 'say', text, ms});
        const hold = (ms, look, extra = {}) => ({k: 'hold', ms, look, ...extra});
        const tween = (ms, look, fn, extra = {}) => ({k: 'tween', ms, look, fn, ...extra});
        const flip = n => side * n * TAU;
        const rot0 = -side * Math.PI / 2;
        const exits = [
            ['backflip', () => [say('Parkour!'), fly(170, -330, flip(1)), land(), hold(0.7, 'dance'), say('Nailed it.')]],
            ['double', () => [say('Double!'), fly(150, -440, flip(2), {tuck: true}), land(0.7), say('Two whole turns!'), hold(0.8, 'dance')]],
            ['wallrun', () => [say('Wall run!'), tween(0.6, 'walk', (k, s0, p) => { b.y = s0.y + 50 * k; b.dist = (b.dist ?? 0) + 4; }),
                fly(190, -260, flip(1)), land(), hold(0.6, 'dance')]],
            ['diveroll', () => [say('Hup!'), fly(200, -200, flip(1)),
                tween(0.52, 'roll', (k, s0, p) => { p.tuck = 1; p.rot = side * TAU * k; b.x = s0.x + away * 70 * k; }),
                tween(0.01, 'walk', (k, s0, p) => { p.tuck = 0; p.rot = 0; }), land(0.3), say('Smooth.')]],
            ['corkscrew', () => [say('Corkscrew!'), fly(170, -360, flip(1), {twist: true, look: 'roll'}), land(), hold(0.6, 'dance')]],
            ['hero', () => [fly(150, -380, flip(1)), land(1.1, {ms: 0.16, keep: true, big: true}),
                say('Hero landing.', 1600), hold(1.1, 'sit'), tween(0.26, 'sit', (k, s0, p) => { p.crouch = 1.1 * (1 - k); })]],
            ['tictac', () => [say('Tic… tac!'), tween(0.48, 'fall', (k, s0, p) => {
                b.x = s0.x + away * 70 * Math.sin(k * Math.PI); b.y = s0.y - 40 * Math.sin(k * Math.PI * 0.7) + 15 * k;
                p.rot = rot0 * (1 - Math.sin(k * Math.PI));
            }), fly(210, -280, flip(1)), land(), hold(0.6, 'dance')]],
            ['lazy', () => [say('…meh.'), tween(0.3, 'poked', (k, s0, p) => { p.rot = rot0 * (1 - k); }),
                fly(15, 0, 0, {look: 'poked'}), land(0.8, {ms: 0.42}), say("Floor's fine.")]],
            ['cannonball', () => [say('CANNONBALL!'), fly(160, -300, flip(2), {tuckAll: true, look: 'roll'}),
                tween(0.22, 'roll', (k, s0, p) => { p.tuck = 1 - k; }), land(0.5), hold(0.6, 'dance')]],
            ['tada', () => [fly(170, -340, flip(1)), land(), say('Ta-da!', 1500), hold(1, 'wake')]],
        ];
        const fails = [
            ['faceplant', () => [say('Parkour!'), fly(170, -260, side * 1.5 * Math.PI), land(0, {big: true, keep: true}),
                say('Ow…', 1200), hold(0.9, 'emerge'), {k: 'getup'}, say("I'm fine. Totally fine.")]],
            ['butt', () => [fly(160, -300, flip(1)), land(1.2, {ms: 0.14, keep: true}), say('Oof.'), hold(0.9, 'sit'),
                tween(0.3, 'sit', (k, s0, p) => { p.crouch = 1.2 * (1 - k); })]],
            ['slipped', () => [say('Whoa—', 900), tween(0.5, 'fall', (k, s0, p) => { p.rot = rot0 * (1 - 0.5 * k); p.shake = 1.5; }),
                fly(40, 0, side * Math.PI / 2), land(0, {big: true, keep: true}), say('Slipped!', 1200), hold(0.8, 'emerge'), {k: 'getup'}]],
            ['pulled', () => [say('Parkour!'),
                tween(0.42, 'fall', (k, s0, p) => { b.x = s0.x + away * 90 * Math.sin(k * Math.PI / 2); b.y = s0.y - 45 * Math.sin(k * Math.PI); p.rot = rot0 * (1 - k); }),
                say('Huh?!', 900),
                tween(0.7, 'emerge', (k, s0, p) => { b.x = s0.x - away * 14 * k + Math.sin(k * 40) * 2; b.y = s0.y + 6 * k; p.rot = 0.15 * Math.sin(k * 30); }),
                say('Nooo, the magnet!', 1400),
                tween(0.26, 'fall', (k, s0, p) => { const e = k * k * k; b.x = s0.x + (p.wallX - s0.x) * e; b.y = s0.y + (p.wallY + 25 - s0.y) * e; p.rot = rot0 * e; }),
                {k: 'clang'}, say('*CLANG*', 900), hold(0.9, 'poked'),
                tween(0.35, 'stuck', (k, s0, p) => { b.y = s0.y + 20 * k * k; }), say('Again!', 900),
                fly(220, -360, flip(1)), land(), say('Second try.'), hold(0.6, 'dance')]],
            ['head', () => [say('Parkour!'), fly(170, -330, side * Math.PI, {yOff: 8 * S}), hold(0.8, 'held'),
                tween(0.42, 'held', (k, s0, p) => { p.rot = side * Math.PI * (1 + 0.5 * k); b.y = s0.y + 8 * S * k; }),
                {k: 'clang'}, say('I meant that.', 1400), hold(0.7, 'poked'), {k: 'getup'}]],
        ];
        const pool = Math.random() < PARKOUR_FAIL_CHANCE ? fails : exits;
        const [name, make] = pool[Math.floor(Math.random() * pool.length)];
        b.pk = {name, steps: make(), i: 0, st: null, look: 'stuck', rot: rot0, tuck: 0, sx: 1, crouch: 0, shake: 0,
            wallX: b.x, wallY: b.y, groundTop: b.y};
        b.slideV = 0; b.vx = 0; b.vy = 0; b.on = null;
        this._set('parkour', 30);   // ends itself; the time is a safety net
        this._sound('whoa');
    }

    _stepParkour(T, dt) {
        const b = this._b, p = b.pk, TAU = 2 * Math.PI;
        if (!p) { this._set('walk'); return; }
        const st = p.steps[p.i];
        if (!st) { b.pk = null; b.on = this._below(T, b.x, b.y - 4)?.id ?? null; this._set('walk'); return; }
        if (!p.st) {   // entering the beat
            p.st = {t: 0, x: b.x, y: b.y, rot: p.rot, crouch: p.crouch};
            if (st.look) p.look = st.look;
            p.shake = 0;
            if (st.k === 'fly') {
                b.vx = st.vx; b.vy = st.vy; p.sx = 1;
                const s2 = this._below(T, b.x + st.vx * 0.4, b.y);
                const h = Math.max(0, (s2 ? s2.top : T.ground) - b.y);
                p.st.T = (-st.vy + Math.sqrt(st.vy * st.vy + 2 * GRAV * h)) / GRAV;   // predicted air time, for the spin
            }
        }
        const q = p.st;
        q.t += dt;
        let done = false;
        switch (st.k) {
        case 'say': this._say(st.text, st.ms); done = true; break;
        case 'clang': b.quakeUntil = Date.now() + 260; this._sound('thud'); done = true; break;
        case 'fly': {
            const prevY = b.y;
            b.vy += GRAV * dt; b.x += b.vx * dt; b.y += b.vy * dt;
            const k = Math.min(1, q.t / Math.max(0.15, q.T));
            p.rot = q.rot + (st.rEnd - q.rot) * k;
            if (st.tuck) p.tuck = k > 0.15 && k < 0.85 ? 1 : 0;
            if (st.tuckAll) p.tuck = 1;
            if (st.twist) p.sx = 0.25 + 0.75 * Math.abs(Math.cos(k * 3 * Math.PI));
            if (T) b.x = Math.max(T.ux0 + 30, Math.min(T.ux1 - 30, b.x));
            const s2 = this._below(T, b.x, prevY);
            const top = (s2 ? s2.top : T.ground) - (st.yOff ?? 0);
            if (b.vy > 0 && b.y >= top) {
                b.y = top; b.vx = 0; b.vy = 0; b.on = s2?.id ?? null;
                p.groundTop = s2 ? s2.top : T.ground;
                p.rot = Math.abs(st.rEnd % TAU) < 1e-6 ? 0 : st.rEnd;
                p.sx = 1; if (!st.tuckAll) p.tuck = 0;
                done = true;
            }
            break;
        }
        case 'land': {
            if (q.t <= dt) {   // touchdown: dust, a thud, a shake if it was hard
                b.chuteDustUntil = Date.now() + 500; this._sound('thud');
                if (st.big) b.quakeUntil = Date.now() + 220;
            }
            const k = Math.min(1, q.t / st.ms);
            p.crouch = st.keep ? st.depth * Math.min(1, k * 2.5) : st.depth * Math.sin(k * Math.PI);
            done = k >= 1;
            if (done && !st.keep) p.crouch = 0;
            break;
        }
        case 'hold':
            if (st.shake) p.shake = st.shake;
            done = q.t >= st.ms;
            break;
        case 'tween': {
            const k = Math.min(1, q.t / st.ms);
            st.fn(k, q, p);
            done = k >= 1;
            break;
        }
        case 'getup': {   // back onto its feet from lying down or a headstand
            const k = Math.min(1, q.t / 0.5), up = Math.round(q.rot / TAU) * TAU;
            p.rot = q.rot + (up - q.rot) * k; b.y = q.y + (p.groundTop - q.y) * k; p.look = 'wake';
            done = k >= 1;
            if (done) p.rot = 0;
            break;
        }
        }
        if (done) { p.i++; p.st = null; }
    }

    // --- secret tricks (local counters only) --------------------------------

    _loadStats() {
        let s = {};
        try {
            const [ok, bytes] = GLib.file_get_contents(STATS_PATH);
            if (ok) s = JSON.parse(new TextDecoder().decode(bytes));
        } catch {}
        this._stats = {spins: s.spins ?? 0, focus: s.focus ?? 0, cursor: s.cursor ?? 0, days: s.days ?? [],
            landings: s.landings ?? 0, games: s.games ?? 0, unlocked: s.unlocked ?? []};
    }

    _saveStats() {
        for (const [id, name, cond] of UNLOCKS) {
            if (!this._stats.unlocked.includes(id) && cond(this._stats)) {
                this._stats.unlocked.push(id);
                if (this._b && !this._b.held) { this._set('dance', 2.5); this._note(`Unlocked: ${name}!`, 3000); this._sound('done'); }
            }
        }
        try { GLib.file_set_contents(STATS_PATH, JSON.stringify(this._stats)); } catch {}
    }

    _unlocked(id) { return this._stats?.unlocked.includes(id) ?? false; }

    // Picks a trick: weighted, never one of the last three, and each has its
    // own cooldown. A tired buddy only picks quiet things.
    _pickActivity() {
        const b = this._b;
        const ride = kind => () => {
            b.ride = {kind, until: Date.now() + 4000 + Math.random() * 3500};
            this._say(kind === 'skate' ? 'Skate time!' : 'Ring ring!', 1200);
            this._sound(kind === 'skate' ? 'chirp' : 'beep');
        };
        const all = [
            // [name, weight, cooldown s, tired-ok, action]
            ['skate', 4, 40, false, ride('skate')],
            ['bike', 4, 40, false, ride('bike')],
            ['run', 2, 25, false, () => { b.runUntil = Date.now() + 2500 + Math.random() * 2500; this._say('Zoom!', 1000); this._sound('chirp'); }],
            ['dance', 2, 30, false, () => { this._set('dance', 3.2); this._say('♪ ♫'); }],
            ['jump', 1, 20, false, () => { b.vy = -380; b.vx = b.dir * 40; b.on = null; this._set('jump'); }],
            ['coffee', 2, 90, true, () => { this._set('coffee', 5); this._say('Coffee break.', 1600); }],
            ['book', 2, 90, true, () => { this._set('book', 6); this._say('Reading…', 1400); }],
            ['polish', 2, 60, false, () => { this._set('polish', 3); this._say('Polishing my screen.', 1600); }],
            ['phones', 2, 45, false, () => { this._set('phones', 3); this._say('♪ good song', 1400); }],
            ['doze', 1, 120, true, () => { this._set('doze', 4); }],
            ['wave', 2, 20, true, () => { this._set('wave', 2); this._say('Hi!'); }],
            ['look', 2, 15, true, () => this._set('look', 2.5)],
            ['sit', 2, 25, true, () => { this._set('sit', 3); this._say('Ahh.'); }],
            ['love', 1, 60, false, () => { this._set('love', 2.6); this._say('I like it here with you.', 2400); }],
            ['turn', 1, 10, false, () => { b.dir *= -1; }],
            ['yawn', 1, 30, true, () => { this._set('wake', 1.4); this._say('*yaaawn*', 1400); }],
            // section 17 tricks
            ['detective', 1, 90, true, () => { this._set('detective', 3); this._say('Hmm… suspicious pointer.', 1800); }],
            ['fakesleep', 1, 120, true, () => { this._set('fakesleep', 5); this._say('Zzz… (not really)', 1600, false); }],
            ['selfie', 1, 90, false, () => { this._set('selfie', 2.5); this._say('Selfie time!', 1400); }],
            ['peek', 1, 90, true, () => { this._set('peek', 3); }],
            ['laughattack', 1, 150, false, () => { this._set('laughattack', 4); this._say('HAHAHAHA', 1500); }],
            ['freeze', 1, 120, false, () => { this._set('freeze', 3); b.freezeT = b.t; }],
            ['ghost', 1, 150, false, () => { this._set('ghost', 3); this._say('Boo!', 1000); }],
            ['clones', 1, 180, false, () => { this._set('clones', 2.2); this._say('Clone jutsu!', 1200); }],
            ['trampoline', 1, 120, false, () => { this._set('trampoline', 4); this._say('Boing boing!', 1200); }],
            ['handstand', 1, 120, false, () => { this._set('handstand', 3.5); this._say('Look, no feet!', 1400); }],
            ['jetfail', 1, 150, false, () => { b.on = null; this._set('jetfail', 0.9); this._say('Jetpack test!', 1000); }],
            ['tarzan', 1, 150, false, () => this._startTarzan()],
            ['teleport', 1, 150, false, () => { b.tele = {k: 0, moved: false}; this._set('teleport', 1.2); this._say('Poof!', 900); }],
            ['thief', this._unlocked('hunter') ? 3 : 1, 90, false, () => {
                this._game = {kind: 'follow', until: Date.now() + 15000, thief: true}; this._say('Your pointer is mine!', 1400);
            }],
            ['backwards', 2, 40, true, () => { b.backUntil = Date.now() + 3500; this._say('Beep beep, reversing.', 1400); }],
            ['moonwalk', 2, 60, false, () => { b.moonUntil = Date.now() + 3500; this._say('Hee-hee!', 1200); this._sound('happy'); }],
            ['ninja', 1, 150, false, () => { b.ninjaUntil = Date.now() + 9000; b.runUntil = Date.now() + 2500; this._say('Ninja mode. Shh.', 1600, false); }],
            ['smoke', 1, 300, true, () => { this._set('smoke', 6); this._say('Just a quick smoke break.', 1800); }],
            ['banana', 2, 180, true, () => { this._set('banana', 4.5); this._say('BA-NA-NAAA! 🍌', 1600, false); this._sound('banana'); }],   // sounds/banana.wav: its own synthesised squeak
            ['clean', 1, 120, false, () => { this._set('clean', 3.5); this._say('Cleaning your screen.', 1600); }],
            ['gum', 1, 150, true, () => { b.popped = false; this._set('gum', 4.5); }],
            ['plane', 1, 150, false, () => { b.planeThrown = false; this._set('plane', 2.4); }],
            ['sneeze', 1, 180, false, () => { this._set('sneeze', 1.8); this._say('Ah… ah…', 1200); }],
            ['fish', typeof b.on === 'number' ? 4 : 1, 180, true, () => { b.caught = false; b.catch = null; this._set('fish', 6); this._say('Gone fishing.', 1400); }],   // likelier from a window ledge
            ['paint', 1, 180, false, () => this._startGraffiti()],
            ['petcall', 1, 600, false, () => this._summonPet()],
            ['shoot', 1, 120, false, () => { b.fired = false; b.bangFlag = false; this._set('shoot', 1.8); }],
        ];
        const wx = this._weather ?? {}, month = new Date().getMonth();
        if (wx.snow || (wx.cold && (month === 11 || month <= 1)))
            all.push(['snowball', 3, 90, false, () => { b.throws = 0; this._set('snowball', 4.2); this._say('Snowball fight!', 1200); }]);
        if (wx.windy) all.push(['kite', 3, 120, false, () => { this._set('kite', 6); this._say('Perfect kite weather!', 1400); }]);
        // lazy lounging (lazy mode picks only from these and the other calm ones)
        all.push(['hammock', 1, 240, true, () => { this._set('hammock', 18); this._say('Hammock time.', 1400, false); }]);
        all.push(['bellyup', 1, 180, true, () => this._set('bellyup', 14)]);
        all.push(['clouds', 1, 200, true, () => { this._set('clouds', 15); this._say('That one looks like a sheep.', 1800, false); }]);
        all.push(['snackbed', 1, 240, true, () => { this._set('snackbed', 14); this._say('Just one cookie…', 1400, false); }]);
        all.push(['yawnflop', 1, 150, true, () => { this._set('yawnflop', 2.4); this._say('*yaaawn*', 1400, false); }]);
        all.push(['remote', 1, 200, true, () => { this._set('remote', 14); this._say('Nothing good on.', 1600, false); }]);
        all.push(['sunbathe', wx.sun ? 4 : 1, 300, true, () => { this._set('sunbathe', 16); this._say('Working on my tan. 😎', 1600, false); }]);
        all.push(['drape', typeof b.on === 'number' ? 4 : 0, 240, true, () => { this._set('drape', 16); this._say('Comfy up here.', 1400, false); }]);   // window ledges only
        if (b.on === null) all.push(['edgeblanket', 1, 300, true, () => { this._set('edgeblanket', 16); this._say('Under the covers.', 1400, false); }]);
        all.push(['slowwalk', 1, 120, true, () => { b.wanderX = undefined; this._set('slowwalk', 3.5); }]);
        all.push(['pizza', 1, 400, true, () => { b.pizzaT = 0; this._set('pizza', 16); this._say('Pizza delivery! 🍕', 1600, false); }]);
        if (this._music) all.push(['lazydance', 6, 60, true, () => this._set('lazydance', 12)]);
        all.push(['coffeedrip', 1, 300, true, () => { this._set('coffeedrip', 12); this._say('Drip… drip…', 1400, false); }]);
        all.push(['sheep', 1, 300, true, () => { b.sheepT = 0; b.sheepN = 0; this._set('sheep', 16); }]);
        all.push(['rocking', 1, 240, true, () => { this._set('rocking', 16); this._say('Ahh, tea.', 1200, false); }]);
        if (this._pet) all.push(['petnap', 4, 240, true, () => { this._set('petnap', 18); this._say('Nap time, boy.', 1400, false); }]);
        all.push(['pillownap', 1, 240, true, () => { this._set('pillownap', 16); this._say('*fluff fluff*', 1200, false); }]);
        all.push(['burrito', 1, 240, true, () => { this._set('burrito', 16); this._say('Blanket burrito.', 1400, false); }]);
        all.push(['lazyfish', 1, 240, true, () => { b.caught = false; this._set('lazyfish', 16); this._say('Fishing… zzz', 1400, false); }]);
        all.push(['lean', 1, 180, true, () => { this._set('lean', 12); this._say('…', 1200, false); }]);
        all.push(['charging', (b.energy ?? 100) < 50 ? 4 : 1, 240, true, () => { this._set('charging', 16); this._say('Plugging in. 🔌', 1400, false); }]);
        all.push(['sleepyread', 1, 240, true, () => { b.readDur = 0; this._set('sleepyread', 14); this._say('Just one more page…', 1600, false); }]);
        all.push(['bubbles', 1, 200, true, () => this._set('bubbles', 14)]);
        all.push(['snore', 1, 200, true, () => this._set('snore', 16)]);
        if ((wx.tempC ?? 0) >= 30) all.push(['pool', 4, 240, true, () => { this._set('pool', 18); this._say('Too hot. Pool time.', 1600, false); }]);   // very hot days only
        all.push(['daydream', 2, 150, true, () => { b.dream = ['pizza', 'beach', 'battery'][Math.floor(Math.random() * 3)]; this._set('daydream', 9); }]);
        if (wx.rain) all.push(['splash', 3, 90, false, () => { this._set('splash', 3.6); this._say('Puddle!', 1000); }]);
        if (wx.rain) all.push(['raindance', 3, 120, false, () => { this._set('raindance', 4.5); this._say('Rain dance!', 1200); }]);
        if (this._birthday) all.push(['party', 4, 120, false, () => this._startParty()]);
        if (this._pet) all.push(['pettricks', 3, 90, false, () => { this._pet.trick = {k: 0}; this._set('command', 4.2); this._say('Sit! Roll over! Play dead!', 2000); }]);
        // Dumb things
        all.push(['trip', 2, 60, false, () => { b.forceReaction = 'shy'; this._set('tumble', 0.9); this._sound('whoa'); }]);
        all.push(['tailchase', 1, 120, false, () => { b.flipT = 0; this._set('tailchase', 3.2); }]);
        all.push(['mimewall', 1, 120, false, () => { this._set('mimewall', 3.5); this._sound('thud'); this._say('Bonk! A wall?', 1200); }]);
        all.push(['derp', 1, 90, true, () => { this._set('derp', 2.5); }]);
        all.push(['wavenobody', 1, 120, true, () => { b.afterWave = 'shy'; this._set('wave', 1.6); this._say('Hi!… oh. Nobody.', 1600); }]);
        all.push(['magic', 1, 150, false, () => this._startMagic()]);
        all.push(['watchingyou', 2, 120, true, () => this._startWatching()]);
        all.push(['mime', 1, 180, true, () => this._startMime()]);
        all.push(['hide', 1, 240, false, () => this._startHide()]);
        if (new Date().getDay() === 5 && new Date().getHours() >= 16) all.push(['weekend', 3, 120, false, () => { this._set('weekend', 4); this._say('Weekend! 😎', 1600); }]);
        all.push(['fort', 1, 180, false, () => { this._set('fort', 6.5); }]);
        all.push(['hiccups', 1, 180, true, () => { b.hicT = 0; this._set('hiccups', 7); }]);
        all.push(['bugchase', 1, 150, false, () => { b.bug = {k: 0, caught: Math.random() < 0.5}; b.on = null; this._set('bugchase'); this._say('A bug!', 1000); }]);
        all.push(['wallrun', 2, 120, false, () => this._startWallRun()]);
        all.push(['mirror', 1, 150, false, () => { b.mirror = {k: 0, px: global.get_pointer()[0]}; this._set('mirror'); this._say('I am your mirror.', 1400); }]);
        all.push(['juggle', 2, 120, false, () => { b.dropBall = Math.random() < 0.3; b.dropHit = false; this._set('juggle', 4.5); }]);
        if (this._music)
            all.push(['guitar', 4, 60, false, () => { this._set('guitar', 4.5); this._say('Guitar solo!', 1200); }]);
        if (this._music) {
            all.push(['musicdance', 6, 15, true, () => { this._set('dance', 4 + Math.random() * 3); }]);
        }
        const onLedge = b.on !== null && b.on !== undefined;
        if (onLedge) {
            all.push(['slide', 3, 60, false, () => this._startSlide()]);
            all.push(['hang', 3, 60, false, () => this._startHang()]);
        }
        if (this._unlocked('dizzydance'))
            all.push(['dizzydance', 1, 120, false, () => { this._set('dizzydance', 3); this._say('Dizzy dance!', 1400); }]);
        const tired = (b.energy ?? 100) < 40, now = Date.now();
        const lazy = this._lazy() && Math.random() > 0.06;   // now and then a real trick, to stay alive
        const ok = all.filter(([name, , cd, tiredOk]) => (!tired || tiredOk) && !this._recent.includes(name) &&
            now - (this._cooldown[name] ?? 0) > cd * 1000 && (!lazy || LAZY_ACTS.has(name)));
        const pool = ok.length ? ok : all.filter(a => (!tired || a[3]) && (!lazy || LAZY_ACTS.has(a[0])));
        let r = Math.random() * pool.reduce((s, a) => s + a[1], 0);
        const pick = pool.find(a => (r -= a[1]) <= 0) ?? pool[0];
        this._recent = [pick[0], ...this._recent].slice(0, 3);
        this._cooldown[pick[0]] = now;
        if (Math.random() < 0.3) { b.dir *= -1; b.wanderX = undefined; }
        pick[4]();
        if (b.actT > 0) b.actT *= (0.7 + Math.random() * 0.6) * (lazy ? 1.8 : 1);   // never quite the same length twice; lazier, longer
        for (const k of ['runUntil', 'backUntil', 'moonUntil', 'ninjaUntil']) {
            if ((b[k] ?? 0) > now) b[k] = now + (b[k] - now) * (0.6 + Math.random() * 0.8);
        }
        if (b.ride && b.ride.until > now) b.ride.until = now + (b.ride.until - now) * (0.6 + Math.random() * 0.9);
    }

    // --- toys --------------------------------------------------------------

    _startGame(kind) {
        const b = this._b;
        if (this._focus || b.mode === 'meeting') { this._note('Not now, we are busy.', 1800); return; }
        this._stopGame(false);
        b.home = false; b.parked = false;
        if (b.mode === 'sleep' || b.mode === 'stay') this._set('wake', 1);
        if (kind === 'ball') {
            this._game = {kind, until: Date.now() + 60000};
            this._makeBall(b.x + b.dir * 80, b.y - 140, b.dir * 220, -120);
            this._note('Ball! Throw it to me!', 2000);
        } else {
            this._game = {kind, until: Date.now() + 20000};
            this._note('Right behind you!', 1600);
        }
        this._sound('happy');
    }

    _stopGame(cheer) {
        if (this._ball) { this._ball.actor.destroy(); this._ball = null; }
        const was = this._game;
        this._game = null;
        if (cheer && was && this._b) { this._set('dance', 2); this._say('Good game!', 1800); }
        if (was && was.kind === 'ball') { this._stats.games++; this._saveStats(); }
    }

    // The ball is its own small actor next to the buddy, so it can roll
    // anywhere. You can pick it up and throw it too.
    _makeBall(x, y, vx, vy) {
        const R = 9, size = 30;
        const actor = new St.DrawingArea({width: size, height: size, reactive: true});
        const ball = {x, y, vx, vy, rot: 0, held: false, actor, R, size};
        actor.connect('repaint', a => {
            const cr = a.get_context();
            cr.setOperator(Cairo.Operator.CLEAR); cr.paint(); cr.setOperator(Cairo.Operator.OVER);
            cr.translate(size / 2, size / 2); cr.rotate(ball.rot);
            if (this._unlocked('goldball')) cr.setSourceRGBA(1, 0.82, 0.25, 1); else cr.setSourceRGBA(0.95, 0.42, 0.3, 1);
            cr.arc(0, 0, R, 0, 2 * Math.PI); cr.fill();
            cr.setSourceRGBA(1, 1, 1, 0.9); cr.setLineWidth(2.5);
            cr.arc(0, 0, R - 2, -0.6, 0.6); cr.stroke(); cr.arc(0, 0, R - 2, Math.PI - 0.6, Math.PI + 0.6); cr.stroke();
            cr.$dispose();
        });
        actor.connect('button-press-event', (_a, ev) => {
            const [px, py] = ev.get_coords();
            ball.held = true; ball.samples = [{x: px, y: py, t: Date.now()}];
            this._ballGrab = global.stage.grab(actor);
            return Clutter.EVENT_STOP;
        });
        actor.connect('motion-event', (_a, ev) => {
            if (!ball.held) return Clutter.EVENT_PROPAGATE;
            const [px, py] = ev.get_coords();
            ball.x = px; ball.y = py;
            ball.samples = ball.samples.concat({x: px, y: py, t: Date.now()}).slice(-6);
            return Clutter.EVENT_STOP;
        });
        actor.connect('button-release-event', () => {
            if (!ball.held) return Clutter.EVENT_PROPAGATE;
            ball.held = false; this._ballGrab?.dismiss(); this._ballGrab = null;
            const s = ball.samples.filter(q => Date.now() - q.t < 120);
            if (s.length >= 2) {
                const ms = Math.max(16, s[s.length - 1].t - s[0].t);
                ball.vx = (s[s.length - 1].x - s[0].x) / ms * 1000 * 0.8;
                ball.vy = (s[s.length - 1].y - s[0].y) / ms * 1000 * 0.8;
            }
            if (this._game) { this._game.until = Math.max(this._game.until, Date.now() + 20000); this._note('Fetch!', 900); }
            this._lastInteract = Date.now();
            return Clutter.EVENT_STOP;
        });
        this._addToLayer(actor);
        this._ball = ball;
    }

    _stepBall(T, dt) {
        const ball = this._ball;
        if (!ball.held && !ball.carried) {   // carried: the pet holds it in its mouth
            const prevY = ball.y;
            ball.vy += GRAV * dt; ball.x += ball.vx * dt; ball.y += ball.vy * dt;
            const s = this._below(T, ball.x, prevY + ball.R);
            if (s && ball.y + ball.R >= s.top && ball.vy > 0) {
                ball.y = s.top - ball.R;
                ball.vy = Math.abs(ball.vy) > 90 ? -ball.vy * 0.55 : 0;
                ball.vx *= Math.pow(0.5, dt);   // rolling friction
            }
            const left = T.ux0 + ball.R, right = T.ux1 - ball.R;
            if (ball.x < left || ball.x > right) { ball.x = ball.x < left ? left : right; ball.vx = -ball.vx * 0.6; }
            if (ball.y - ball.R < T.wa.y) { ball.y = T.wa.y + ball.R; ball.vy = Math.abs(ball.vy) * 0.5; }
            if (ball.y > T.ground + 60) { ball.y = T.ground - 200; ball.vy = 0; }   // lost below: drop it back in
            ball.rot += ball.vx * dt / ball.R;
        }
        ball.actor.set_position(Math.round(ball.x - ball.size / 2), Math.round(ball.y - ball.size / 2));
        ball.actor.queue_repaint();
    }

    // Energy: spent by moving, earned back by sitting and sleeping.
    _updateEnergy(dt) {
        const b = this._b;
        const running = Date.now() < (b.runUntil ?? 0), riding = b.ride && Date.now() < b.ride.until;
        const rate = {
            walk: running ? -1.0 : riding ? -0.6 : -0.22, duck: -0.3, climb: -0.9, fly: -0.5, dance: -0.9,
            sit: 2.5, sleep: 5, stay: 0.6, meeting: 0.5, focus: 0.5, love: 0.5,
            coffee: 3, book: 2, doze: 4, polish: -0.2, phones: -0.2, charging: 8, pillownap: 5, snore: 5, burrito: 4,
        }[b.mode] ?? 0;
        b.energy = Math.max(0, Math.min(100, (b.energy ?? 100) + rate * dt));
    }

    // --- input ---------------------------------------------------------------

    _lazy() { return this._prefs?.activity === 'lazy' || Date.now() - (this._lastPlay ?? 0) > LAZY_AFTER_MS; }

    // Which GAIT it walks with. Off and the chosen level set the baseline; being
    // lazy, badly hurt or tired (energy < 40) makes it drag along, and a light
    // bump or a low battery (energy < 60) slows it to the Low walk.
    _gaitMood() {
        const b = this._b, act = this._prefs?.activity ?? 'normal';
        if (act === 'off') return 'off';
        const inj = b?.injury && Date.now() < b.injury.until ? b.injury.level : 0, en = b?.energy ?? 100;
        if (inj === 2 || en < 40 || this._lazy()) return 'lazy';
        if (inj === 1 || en < 60 || act === 'low') return 'low';
        return act === 'high' ? 'high' : 'normal';
    }

    _press(ev) {
        this._wasLazy = this._lazy();   // remembered for the click: was it lounging when you poked it?
        this._lastPlay = Date.now();
        const [px, py] = ev.get_coords();
        if (ev.get_button() === Clutter.BUTTON_SECONDARY) {
            this._openMenu();
            return Clutter.EVENT_STOP;
        }
        if (this._timer?.ringing) this._timer.ringing = false;   // a click stops the timer's ringing
        this._lastTouch = Date.now();
        this._press0 = {x: px, y: py, at: Date.now(), dragging: false, dx: this._b.x - px, dy: this._b.y - py,
            lx: px, ly: py, lastV: null, angle: 0, head: py < this._b.y - BH * S * 0.55};
        const today = new Date().toDateString();
        if (!this._stats.days.includes(today)) { this._stats.days = [...this._stats.days, today].slice(-60); this._saveStats(); }
        this._b.spin = 0; this._b.spinAngle = 0;
        const b = this._b;
        if (['walk', 'stay', 'sit', 'look', 'wave', 'dance', 'love', 'tease', 'focus', 'meeting', 'snapback'].includes(b.mode)) {
            for (const [key, L] of Object.entries(LIMBS)) {
                const stayFor = (Date.now() - (b.stayStart ?? Date.now())) / 1000;
                const pose = b.mode === 'stay' ? LIMB_POSES[stayFor >= STAY_SIT_S ? 'sitting' : 'waiting'] : null;
                const rest = pose?.[key] ?? L.rest;
                const wx = b.x + rest[0] * S, wy = b.y + rest[1] * S;
                if (Math.hypot(px - wx, py - wy) < 11 * S) {
                    // Only a candidate: the first drag decides. Pulling outward,
                    // away from its middle, stretches the limb; any other drag
                    // lifts the whole buddy (its hands cross its chest when parked).
                    this._press0.limbCand = {key, rest: [...rest]};
                    break;
                }
            }
        }
        this._lastInteract = Date.now();
        this._grab = global.stage.grab(this._area);
        return Clutter.EVENT_STOP;
    }

    _motion(ev) {
        if (!this._press0)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = ev.get_coords();
        const p = this._press0;
        this._lastTouch = Date.now();
        if (p.limbCand && !p.limb && !p.dragging && Math.hypot(px - p.x, py - p.y) > 6) {
            const c = p.limbCand, out = [c.rest[0], c.rest[1] + 30];          // from its middle to the hand/foot
            const mv = [px - p.x, py - p.y];
            const dot = (out[0] * mv[0] + out[1] * mv[1]) / (Math.hypot(...out) * Math.hypot(...mv) || 1);
            p.limbCand = null;
            if (dot > 0.3) {
                const b = this._b;
                p.limb = c.key;
                b.limb = {key: c.key, rest: c.rest, tip: [...c.rest], v: [0, 0], max: 0, prevMode: b.mode, parked: b.parked};
                b.stretchFace = 'laugh';
                this._set('stretched');
            }
        }
        if (p.limb && this._b.limb) {
            const b = this._b, L = LIMBS[p.limb];
            const limX = AW / 2 / S - 6, limTop = -(AH - FOOT) / S + 6, limBottom = FOOT / S - 2;
            const tx = Math.max(-limX, Math.min(limX, (px - b.x) / S));
            const ty = Math.max(limTop, Math.min(limBottom, (py - b.y) / S));
            b.limb.tip = [tx, ty];
            const rest = b.limb.rest ?? L.rest;
            const stretch = Math.hypot(tx - rest[0], ty - rest[1]);
            b.limb.max = Math.max(b.limb.max, stretch);
            const feel = STRETCH_FEEL.find(f => stretch <= f[0]);
            b.cryK = Math.max(0, Math.min(1, (stretch - CRY_FROM) / (CRY_FULL - CRY_FROM)));
            const band = feel[1] === 'cry' ? Math.min(2, Math.floor(b.cryK * 3)) : -1;
            if (b.stretchFace !== feel[1] || (feel[1] === 'cry' && band !== b.cryBand)) {
                const first = b.stretchFace !== feel[1];
                b.stretchFace = feel[1]; b.cryBand = band;
                this._say(feel[1] === 'cry' ? CRY_LINES[band] : feel[2], 1800);
                if (first && feel[1] !== 'cry') this._sound({laugh: 'boop', emerge: 'chirp'}[feel[1]]);
                if (feel[1] === 'cry' && band !== -1) b.sobT = 0;   // a louder band: cry out right away
            }
            return Clutter.EVENT_STOP;
        }
        if (!p.dragging && Math.hypot(px - p.x, py - p.y) > 6) {
            p.dragging = true; this._b.held = true; this._b.home = false; this._b.on = null;
            // On the sofa: you carry the sofa along and can set it down anywhere.
            this._b.movieCarry = this._b.mode === 'movie' && this._b.movie?.phase === 'watch';
            this._say(this._b.movieCarry ? 'Careful with my popcorn!' : 'Wheee!', 1500);
        }
        if (this._b.held && this._b.movieCarry) {
            this._b.x = px + p.dx; this._b.y = py + p.dy;
            this._area.set_position(Math.round(this._b.x - AW / 2), Math.round(this._b.y - (AH - FOOT)));
            return Clutter.EVENT_STOP;
        }
        if (this._b.held) {
            const wa = this._workArea();
            const wasScared = this._b.scared;
            // Fear grows with height: from a third of the way up (0) to near the top (1).
            const up = (wa.y + wa.height - this._b.y) / wa.height;
            this._b.fearK = Math.max(0, Math.min(1, (up - 0.3) / 0.55));
            this._b.scared = this._b.fearK > 0;
            if (this._b.scared && !wasScared && (this._b.spin ?? 0) < 1) this._say('Eek, going up…', 1200);
            // Spinning it around: add up how far the drag direction turns.
            const vx = px - p.lx, vy = py - p.ly;
            if (Math.hypot(vx, vy) > 4) {
                if (p.lastV) {
                    const [ux, uy] = p.lastV;
                    p.angle += Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
                }
                p.lastV = [vx, vy]; p.lx = px; p.ly = py;
                this._b.spinAngle = p.angle;
                this._b.spin = Math.abs(p.angle) / (2 * Math.PI);
                if (this._b.spin >= 1 && !p.saidDizzy) { p.saidDizzy = true; this._say('Stop spinning meee!', 1500); }
            }
            p.samples = (p.samples ?? []).concat({x: px, y: py, t: Date.now()}).slice(-8);
            this._b.x = px + p.dx;
            this._b.y = py + p.dy;
            this._area.set_position(Math.round(this._b.x - AW / 2), Math.round(this._b.y - (AH - FOOT)));
        }
        return Clutter.EVENT_STOP;
    }

    _release() {
        this._lastTouch = Date.now();
        const p = this._press0;
        this._press0 = null;
        this._grab?.dismiss();
        this._grab = null;
        if (!p)
            return Clutter.EVENT_PROPAGATE;
        const b = this._b;
        this._lastInteract = Date.now();
        b.cryK = 0; b.cryBand = -1;
        if (p.limb && b.limb) {
            this._set('snapback', 0.7); this._sound('boop');
            return Clutter.EVENT_STOP;
        }
        if (p.dragging && b.movieCarry) {
            // set down right there, sofa and all, and goes on watching
            b.held = false; b.movieCarry = false; b.vx = 0; b.vy = 0; b.on = null; b.spin = 0; b.spinAngle = 0;
            if (b.movie) b.movie.float = true;
            this._say('Ahh, nice spot.', 1200, false);
            return Clutter.EVENT_STOP;
        }
        b.fearK = 0; b.fearLvl = 0; b.fearSobT = 0;
        this._stopCrying();   // let go of: the height-fear sobbing stops at once
        if (p.dragging && this._weather?.rain) { b.soakedUntil = Date.now() + 15000; b.soakSay = true; }   // pulled out from under its umbrella
        if (p.dragging) {
            b.pendingSpin = Math.floor(b.spin ?? 0); b.spin = 0; b.spinAngle = 0;
            b.held = false; b.vy = 0; b.vx = 0; b.squash = 1;
            const wa = this._workArea();
            // Swing and let go: the speed of the last ~100 ms of the drag.
            const sm = (p.samples ?? []).filter(s => Date.now() - s.t < 120);
            if (sm.length >= 2) {
                const a0 = sm[0], a1 = sm[sm.length - 1], ms = Math.max(16, a1.t - a0.t);
                const vx = (a1.x - a0.x) / ms * 1000, vy = (a1.y - a0.y) / ms * 1000;
                const sp = Math.hypot(vx, vy);
                if (sp > THROW_MIN_SPEED) {
                    const k = Math.min(1, THROW_MAX_SPEED / sp);
                    b.vx = vx * k; b.vy = vy * k; b.apex = b.y; b.spinAngle = 0; b.chuteTried = false;
                    this._set('thrown'); this._say(sp > 1800 ? 'AAAAAH!' : 'Wheeee!', 1400); this._sound('whoa');
                    return Clutter.EVENT_STOP;
                }
            }
            const T = this._T;
            const side = T?.rects.find(r => b.y > r.top + 20 && b.y < r.bottom && (Math.abs(b.x - r.x0) < 26 || Math.abs(b.x - r.x1) < 26));
            if (side) {
                b.stuckSide = Math.abs(b.x - side.x0) < 26 ? 1 : -1;   // 1: the window is to its right
                // It is drawn turned 90° about a point 30 px above its feet, so
                // its soles sit 30*S from b.x; place it so they touch the edge
                // (12 px left them sunk into the window).
                b.x = b.stuckSide > 0 ? side.x0 - STUCK_REACH * S : side.x1 + STUCK_REACH * S;
                b.stuckBottom = side.bottom;
                this._set('stuck', 2.5); this._say('Magnet mode! Stuck!', 1600);
                return Clutter.EVENT_STOP;
            }
            if (wa.y + wa.height - b.y > wa.height * CHUTE_FROM) {
                this._set('chute'); this._say('Wheee!', 1200);
            } else {
                b.dropFrom = b.y; b.dropH = wa.height;
                this._set('fall'); this._say('Whoa!');
                if (wa.y + wa.height - b.y > 40) this._sound('whoa');   // a real drop, not a nudge at floor level
            }
            return Clutter.EVENT_STOP;
        }
        if (b.mode === 'sleep') {
            b.home = false; b.nightcap = false; this._set('wake', 1.6); this._say('*yawn* Morning!', 1600);
            this._nextAct = Date.now() + 5000;
            return Clutter.EVENT_STOP;
        }
        if (b.mode === 'meeting') {
            this._set('wave', 1.6); this._say('Hi! In a meeting.', 1600);
            return Clutter.EVENT_STOP;
        }
        // Hold the click for a second (without moving) to start or stop a
        // focus block; a double click was too easy to hit by accident.
        // A quick click parks it, or lets it go again.
        if (Date.now() - p.at >= FOCUS_HOLD_MS) {
            this._toggleFocus();
            return Clutter.EVENT_STOP;
        }
        const nowC = Date.now();
        this._clickTimes = (this._clickTimes ?? []).filter(c => nowC - c < 900).concat(nowC);
        if (this._clickTimes.length >= 3) { this._clickTimes = []; this._startDanceoff(); return Clutter.EVENT_STOP; }
        this._singleClick(p.head);
        return Clutter.EVENT_STOP;
    }

    // --- drawing -------------------------------------------------------------

    _paint(area) {
        const cr = area.get_context();
        const b = this._b;
        cr.setOperator(Cairo.Operator.CLEAR); cr.paint(); cr.setOperator(Cairo.Operator.OVER);
        if (this._fsHide) { cr.$dispose(); return; }   // out of the way of a fullscreen video
        if (b.mode === 'watchingyou' && ['gone', 'gone2'].includes(b.wy?.phase)) { cr.$dispose(); return; }   // off the screen edge
        cr.translate(AW / 2, AH - FOOT);
        cr.save();
        if (b.mode === 'emerge') {
            // Only the part above the ground line shows, so it climbs up out of it.
            // Just before it appears, two hands grab the edge.
            if (b.wait > 0) {
                if (b.wait < 1) {
                    for (const hx of [-22, 22]) {
                        rgb(cr, C.hand); cr.newSubPath();
                        cr.arc(hx * S, -3, 5 * S, Math.PI, 2 * Math.PI); cr.fill();
                    }
                }
                cr.rectangle(0, 0, 0, 0); cr.clip();  // hidden below ground
            } else {
                cr.rectangle(-AW / 2, -AH, AW, AH); cr.clip();
                cr.translate(0, b.rise * (BH + 24) * S);
                cr.rotate(Math.sin(b.t * 12) * 0.07);
            }
        }
        cr.scale(S, S);
        const nowP = Date.now(), mode = b.mode;
        this._drawBackdrop(cr, b);   // disco lights, UFO, trampoline, cracks, smoke puffs
        if (nowP < (b.quakeUntil ?? 0))
            cr.translate((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 2);   // heavy landing shake
        if (mode === 'trampoline')
            cr.translate(0, -Math.abs(Math.sin(b.t * 6)) * 30);
        if (mode === 'ufo' && b.ufo) {
            const k = b.ufo.k;
            if (k > 1) cr.translate(0, -Math.min(1, (k - 1) / 1.6) * 70);   // lifted by the beam
            if (k > 2.6) { const s = Math.max(0.01, 1 - (k - 2.6) / 0.6); cr.translate(0, -30); cr.scale(s, s); cr.translate(0, 30); }
        }
        if (mode === 'teleport' && b.tele) {
            const s = Math.max(0.01, Math.abs(1 - b.tele.k * 2));
            cr.translate(0, -30); cr.scale(s, s); cr.translate(0, 30);
        }
        if (mode === 'handstand') { cr.translate(0, -37); cr.rotate(Math.PI); cr.translate(0, 37); }
        if (mode === 'hang') { cr.translate(0, -30); cr.rotate(Math.PI + Math.sin(b.t * 2) * 0.08); cr.translate(0, 30); }
        if (mode === 'stuck') { cr.translate(0, -30); cr.rotate(-b.stuckSide * Math.PI / 2); cr.translate(0, 30); }
        if (mode === 'parkour' && b.pk) {   // same pivot as 'stuck', plus tuck, twist, crouch and shake
            const p = b.pk, tk = 1 - 0.18 * p.tuck;
            if (p.shake) cr.translate((Math.random() - 0.5) * 2 * p.shake, 0);
            cr.translate(0, -30); cr.rotate(p.rot); cr.scale(tk * p.sx, tk); cr.translate(0, 30);
            if (p.crouch) cr.scale(1 + 0.1 * p.crouch, 1 - 0.22 * p.crouch);
        }
        if (mode === 'acrobat') { cr.translate(0, -30); cr.rotate(2 * Math.PI * Math.min(1, (1 - b.actT) * 1.5) * b.dir); cr.translate(0, 30); }
        if (mode === 'jump' && b.flip) { cr.translate(0, -30); cr.rotate((b.t - (b.flipStart ?? b.t)) * 12 * b.dir); cr.translate(0, 30); }
        if (mode === 'boing') { const s = 1 + Math.sin(b.actT * 20) * 0.25 * b.actT; cr.scale(1 / Math.sqrt(s), s); }
        if (mode === 'laughattack') cr.rotate(Math.sin(b.t * 30) * 0.05 * b.actT / 4);
        if (mode === 'guitar') cr.rotate(Math.sin(b.t * 9) * 0.1);   // head-banging
        if (mode === 'stretched' && b.stretchFace === 'cry')
            cr.rotate(Math.sin(b.t * (14 + 20 * (b.cryK ?? 0))) * 0.06 * (b.cryK ?? 0));   // sobbing, harder as you pull
        if (mode === 'wallrun' && b.wr) {
            if (b.wr.phase === 1) { cr.translate(0, -30); cr.rotate(-b.dir * Math.PI / 2); cr.translate(0, 30); }
            if (b.wr.phase === 2) { cr.translate(0, -30); cr.rotate(-b.dir * 2 * Math.PI * Math.min(1, b.wr.flip)); cr.translate(0, 30); }
        }
        if (mode === 'hiccups' && b.t - (b.hicAt ?? -9) < 0.25) cr.translate(0, -Math.sin((b.t - b.hicAt) / 0.25 * Math.PI) * 10);
        if (b.injury && b.injury.level === 2 && Date.now() < b.injury.until && b.mode === 'walk')
            cr.rotate(Math.sin(b.t * 5) * 0.08);  // limping sway
        // Mood posture while walking: lean forward, rock, or nod with each stride.
        // Pivots at the feet; not while running, riding or moonwalking, which have their own poses.
        if (b.mode === 'walk' && !b.held && Date.now() > (b.runUntil ?? 0) && Date.now() > (b.moonUntil ?? 0) &&
            !(b.ride && Date.now() < b.ride.until)) {
            const g = GAIT[this._gaitMood()], gph = (b.dist ?? 0) / S / 3.6;
            const lean = g.slouch + g.sway * Math.sin(gph) + g.nod * Math.sin(gph * 2);
            if (lean) cr.rotate(lean * b.dir);
        }
        if ((b.held || b.mode === 'thrown') && b.spinAngle) {
            // turns with the swing, around its middle
            cr.translate(0, -36); cr.rotate(b.spinAngle); cr.translate(0, 36);
        }
        if (b.mode === 'tumble') {
            const k = Math.min(1, (0.9 - b.actT) / 0.5);
            cr.translate(0, -BW / 2 * k); cr.rotate(b.dir * Math.PI / 2 * k);
        }
        if (b.mode === 'doze')
            cr.rotate(Math.sin(b.t * 1.3) * 0.07);   // nodding off
        if (mode === 'splash') cr.translate(0, -Math.abs(Math.sin(b.t * 5)) * 16);   // hopping in the puddle
        if (mode === 'stretch' && b.actT < 3.4) cr.translate(0, -Math.abs(Math.sin((3.4 - b.actT) * Math.PI * 1.5)) * 9);   // jumping jacks
        if (mode === 'hide') cr.translate(0, Math.sin(b.t * 0.9) > 0.55 ? 18 : 6);   // crouched; ducks right down now and then
        if (mode === 'nightowl') cr.rotate(Math.sin(b.t * 1.2) * 0.04);
        if (mode === 'watchingyou' && b.wy) {
            const el = b.wy.phase === 'scene' ? b.wy.t : 99, ph = b.wy.phase;
            if (ph === 'off') {
                cr.rotate(-b.dir * 0.1 * Math.min(1, b.wy.pt / 0.5));   // backing out, leaning back a little, away from you
            } else if (ph === 'peek') {
                // leaning in from beyond the edge, top first, then a hard stare
                const k = Math.min(1, b.wy.pt / 0.35);
                cr.rotate(-b.wy.sgn * 0.55 * k);
            } else if (el < WATCH.in) {   // heavy steps: rises and drops, squashes on each footfall
                const ph = (el % 0.4) / 0.4;
                cr.translate(0, -Math.sin(ph * Math.PI) * 4);
                if (ph < 0.15) { cr.translate(0, 0); cr.scale(1.04, 0.96); }
            } else if (el >= WATCH.eyes && el < WATCH.gesture && b.wyPoint) {
                const c = ((el - WATCH.eyes) % WATCH_CYCLE) / WATCH_CYCLE;
                const jab = 1.04 + 0.08 * Math.min(1, Math.max(0, (c - 0.45) / 0.18));   // leans in with the jab
                cr.scale(jab, jab);
            }
        }
        if (nowP < (b.soakedUntil ?? 0)) cr.translate(Math.sin(b.t * 45) * 0.8, 0);   // shivering, wet
        if (mode === 'danceoff' && b.dof?.phase === 'me') { cr.translate(b.dof.ox, b.dof.oy); cr.rotate(b.dof.ox * 0.008); }
        if (mode === 'walk' && nowP < (b.backUntil ?? 0) && !(nowP < (b.moonUntil ?? 0))) {
            cr.translate(0, -30); cr.rotate(-b.dir * 0.06); cr.translate(0, 30);   // backing up: leans a touch away from where it's going
        }
        if (mode === 'chute') {
            // swings like a pendulum under the canopy once it is open
            const since = b.t - (b.chuteAt ?? b.t), open = Math.min(1, Math.max(0, (since - CHUTE_UNFURL) / 0.6));
            const lean = (this._weather?.windKmh ?? 0) >= 8 ? (this._weather.windDir ?? 0) * 0.14 * open : 0;   // tilted by the wind
            const bank = (b.chuteSteer ?? 0) * 0.16 * open;   // banks into a turn
            const swingK = 1 - 0.7 * (b.chuteFlare ?? 0);       // a flare steadies the swing
            cr.translate(0, -98); cr.rotate(lean + bank - Math.sin(since * CHUTE_SWING) * 0.13 * open * swingK * (this._weather?.windy ? 1.6 : 1)); cr.translate(0, 98);
        }
        if (mode === 'movie' && b.movie?.phase === 'watch') {
            const r = b.movie.react;
            const aw = b.movie.away;
            if (aw) {   // hops off and walks out of sight, then comes back
                const k = aw.t < 1.2 ? aw.t / 1.2 : aw.t < 7 ? 1 : Math.max(0, 1 - (aw.t - 7) / 1.2);
                cr.translate(k >= 1 ? b.dir * 5000 : b.dir * k * 240, -12 * (1 - Math.min(1, k * 4)) - Math.abs(Math.sin(b.t * 12)) * 3 * Math.min(1, k * 4));
            } else cr.translate(0, -12);   // up on the sofa seat
            if (!aw && b.movie.doze) { cr.translate(0, -30); cr.rotate(Math.sin(b.t * 1.1) * 0.05 - b.dir * 0.08); cr.translate(0, 30); }
            else if (r?.kind === 'laugh') cr.rotate(Math.sin(b.t * 25) * 0.04);
            else if (r?.kind === 'hide') cr.translate(Math.sin(b.t * 50) * 1.2, 0);   // trembling
            else if (r?.kind === 'gasp' && b.t - r.at < 0.35) cr.translate(0, -Math.sin((b.t - r.at) / 0.35 * Math.PI) * 6);
            else if (r?.kind === 'cramp') cr.translate(Math.sin(b.t * 40) * 1, 0);
            else if (r?.kind === 'action') { cr.translate(0, -30); cr.rotate(b.dir * 0.07); cr.translate(0, 30); }   // on the edge of its seat
            else if (r?.kind === 'clap' || r?.kind === 'stretch') cr.translate(0, -Math.abs(Math.sin(b.t * 7)) * 1.5);
        }
        if (b.mode === 'cry' || b.mode === 'laugh')
            cr.rotate(Math.sin(b.t * 25) * 0.03);
        if (b.mode === 'shy')
            cr.rotate(Math.sin(b.t * 3) * 0.07);
        if (b.held && b.scared)
            cr.translate(Math.sin(b.t * 60) * (1.5 + 2.5 * (b.fearK ?? 0)), 0);   // trembling, harder up high
        if (b.mode === 'pool') cr.translate(0, -5 + Math.sin(b.t * 1.5) * 1.5);   // bobbing on its ring
        if (b.mode === 'lean') cr.rotate(b.dir * 0.16);   // leaning on the post
        if (b.mode === 'rocking') { cr.translate(0, -8); cr.rotate(Math.sin(b.t * 1.4) * 0.07); }   // up in the chair, rocking
        if (isLying(b)) {
            if (b.mode === 'hammock') { cr.translate(0, -24); cr.translate(0, -26); cr.rotate(Math.sin(b.t * 1.2) * 0.08); cr.translate(0, 26); }   // up in the hammock, swaying
            cr.translate(0, -BW / 2); cr.rotate(-Math.PI / 2 * b.dir);   // flat on its back
            if (b.mode === 'bellyup' || b.mode === 'snore') cr.translate(0, Math.sin(b.t * 1.6) * 0.8);   // breathing
        }
        if (b.mode === 'yawnflop') {
            const q = Math.max(0, Math.min(1, (1.0 - b.actT) / 0.4));   // the flop
            if (q === 0) cr.scale(0.95, 1.1);   // the big stretch
            cr.translate(0, -BW / 2 * q); cr.rotate(-Math.PI / 2 * b.dir * q);
        }
        if (b.mode === 'roll') { cr.translate(0, -30); cr.rotate(b.rollAng ?? 0); cr.translate(0, 30); }
        if (b.mode === 'knocked') {
            // flat on its side on the ground
            cr.translate(0, -BW / 2); cr.rotate(-Math.PI / 2 * b.dir);
        }
        if ((b.mode === 'walk' || b.mode === 'duck') && !(b.ride && Date.now() < b.ride.until) && !(Date.now() < (b.moonUntil ?? 0))) {
            const run = Date.now() < (b.runUntil ?? 0);
            cr.rotate(Math.sin((b.dist ?? 0) / S / (run ? 6 : 3.6)) * (run ? 0.05 : 0.08));  // waddle
        }
        if (Date.now() < (b.runUntil ?? 0) && b.mode === 'walk')
            cr.rotate(0.12 * b.dir);  // leans into a run
        if (Date.now() < (b.stagger ?? 0) && b.mode === 'walk')
            cr.rotate(Math.sin(b.t * 4) * 0.14);
        if (mode === 'deliver' && this._dv) {
            // Effort, hops and crouches are drawn, not simulated: its feet stay
            // on the surface, so physics and terrain never see them.
            const p = this._dv.pose;
            cr.translate(p.shake ? (Math.random() - 0.5) * 2 * p.shake : 0, -p.jumpY);
            if (p.crouch) cr.scale(1 + p.crouch * 0.06, 1 - p.crouch * 0.14);   // pivots at the feet
        }
        const ghost = mode === 'ghost' || (mode === 'ufo' && b.ufo?.k > 3.2);
        if (ghost) cr.pushGroup();
        this._drawBuddy(cr, b);
        // Clone illusion: two copies run off in opposite directions and fade.
        // Clone army: two copies beside it, one copying, one doing the opposite.
        if (mode === 'clones' || mode === 'army') {
            const copies = mode === 'clones'
                ? [[-(1 - b.actT / 2.2) * 110, b.actT / 2.2, false], [(1 - b.actT / 2.2) * 110, b.actT / 2.2, false]]
                : [[-55, 0.7, false], [55, 0.7, true]];
            for (const [off, alpha, mirror] of copies) {
                cr.save(); cr.translate(off, 0); if (mirror) cr.scale(-1, 1);
                cr.pushGroup(); this._drawBuddy(cr, b); cr.popGroupToSource(); cr.paintWithAlpha(Math.max(0, alpha));
                cr.restore();
            }
        }
        if (ghost) {
            cr.popGroupToSource();
            cr.paintWithAlpha(mode === 'ghost' ? 0.3 + Math.sin(b.t * 6) * 0.12 : 0);
        }
        cr.restore();
        this._drawBubble(cr, b);
        cr.$dispose();
    }

    _drawBuddy(cr, b) {
        let m = (b.held && !b.movieCarry) || b.mode === 'thrown' ? 'held' : b.mode;
        // Parkour borrows existing poses and faces (fall, roll, dance, sit...)
        // per beat, so the exits need no drawing of their own.
        if (m === 'parkour') m = b.pk?.look ?? 'fall';
        if (m === 'coffeerun') m = 'walk';   // walks (or stands) like 'walk'; the cup is added in the arms
        if (m === 'timer' && this._timer?.walking) m = 'walk';   // to and from the pile; the site draws what it carries
        // Timer breaks borrow existing poses: sitting, sipping (a glass of
        // water, see the cup), arms up, tapping its watch.
        else if (m === 'timer') m = {rest: 'sit', drink: 'coffee', stretch: 'wake', watch: 'watch'}[this._timer?.job?.kind] ?? m;
        const sleepwalk = m === 'walk' && Date.now() < (b.sleepwalkUntil ?? 0);
        const t = b.mode === 'freeze' ? (b.freezeT ?? b.t) : b.t;
        const stayFor = b.mode === 'stay' ? (Date.now() - (b.stayStart ?? Date.now())) / 1000 : 0;
        const staySit = b.mode === 'stay' && stayFor >= STAY_SIT_S;
        const sleeping = m === 'sleep', sitting = sleeping || staySit || m === 'sit' || m === 'meeting' || m === 'knocked' || m === 'broken' || m === 'focus' ||
            (m === 'chuteland' && b.actT > 0.85) ||   // knees bend for a moment on touchdown
            m === 'cry' || m === 'laugh' || m === 'tumble' || m === 'prejump' || m === 'coffee' || m === 'book' || m === 'doze' ||
            m === 'fakesleep' || m === 'smoke' || m === 'slide' || m === 'typing' || m === 'fish' || m === 'bedtime' ||
            (m === 'movie' && b.movie?.phase === 'watch') || m === 'lunch' || LIE_MODES.has(m) || m === 'daydream' || m === 'lazywave' ||
            ['lazyfish', 'charging', 'sleepyread', 'fivemore', 'coffeedrip', 'rocking', 'screensaver', 'pizza'].includes(m);
        const ride = b.ride && Date.now() < b.ride.until && (m === 'walk' || m === 'duck' || (m === 'jump' && b.kickflip)) ? b.ride.kind : null;
        // Gait: the phase follows distance walked, so feet never slide.
        const running = Date.now() < (b.runUntil ?? 0) && m === 'walk' && !ride;
        const ph = (b.dist ?? 0) / S / (running ? 6 : 3.6);
        const moonNow = Date.now() < (b.moonUntil ?? 0) && m === 'walk';   // a smooth glide, no bob
        const gait = GAIT[this._gaitMood()];
        const dvWalk = m === 'deliver' && !!this._dv?.pose.walking;   // carrying a ticket: walks like 'walk'
        const bounce = m === 'dance' || m === 'timerdone' ? -Math.abs(Math.sin(t * 9)) * 8
            : (m === 'walk' || m === 'duck' || dvWalk) && !moonNow ? -Math.abs(Math.sin(ph)) * (running ? 2 : m === 'walk' || dvWalk ? gait.bob : 0.8) : 0;
        const breathe = sleeping ? Math.sin(t * 2) * 1.5 : 0;
        const h = BH * (m === 'duck' ? b.squash : sitting ? 0.85 : 1) + breathe;
        const w = BW * (m === 'duck' ? 1 + (1 - b.squash) * 0.5 : 1);
        const fy = ride === 'skate' ? -7 + Math.sin(t * 6) * 0.5 : ride === 'bike' ? -18 + Math.abs(Math.sin(ph)) * 0.8 : bounce;
        const x = -w / 2, y = fy - h - (sitting ? 2 : moonNow ? 14 : 8);   // moonwalk: stands tall so the legs show
        // Walking backwards or moonwalking: it faces the other way.
        const nowD = Date.now();
        const moon = nowD < (b.moonUntil ?? 0) && m === 'walk';
        const dir = (moon || (nowD < (b.backUntil ?? 0) && m === 'walk')) ? -b.dir : b.dir;
        // Walking backwards: the step cycle runs in reverse, so the foot on the
        // ground pushes forward under it as it backs up. With the cycle running
        // forwards (as before) it looked like walking ahead while sliding back.
        const backwards = !moon && nowD < (b.backUntil ?? 0) && m === 'walk';
        // Backwards it also takes short, high, careful steps (more of them per
        // px), holds its arms out for balance, glances over its shoulder and
        // blinks its rings amber like a reversing light: with only the step
        // cycle reversed it looked almost the same as walking forwards (user,
        // 16 Nov 2026; tried in the walk lab first).
        const pw = backwards ? -ph * 1.6 : ph;
        const swing = (m === 'walk' || m === 'duck') ? Math.sin(t * 14) * 4 : 0;
        cr.setLineCap(Cairo.LineCap.ROUND);

        // ride shapes (origin on the ground, x mirrored by direction)
        const drawSkate = () => {
            rgb(cr, C.foot); rr(cr, -20, -8, 40, 4, 2); cr.fill();
            cr.setLineWidth(3); cr.moveTo(-20, -7); cr.lineTo(-24, -11); cr.moveTo(20, -7); cr.lineTo(24, -11); cr.stroke();
            rgb(cr, C.stripe); rr(cr, -17, -8, 34, 1.5, 1); cr.fill();
            rgb(cr, C.teal); for (const wx of [-13, 13]) { cr.newSubPath(); cr.arc(wx, -2.5, 2.6, 0, 2 * Math.PI); cr.fill(); }
        };
        const drawBike = ang => {
            cr.setLineWidth(2); cr.setSourceRGBA(0.6, 0.62, 0.68, 1);
            for (const hx of [-16, 16]) {
                cr.newSubPath(); cr.arc(hx * dir, -10, 9.5, 0, 2 * Math.PI); cr.stroke();
                for (let k = 0; k < 3; k++) {
                    const a = ang + (k * Math.PI) / 3;
                    cr.moveTo(hx * dir - Math.cos(a) * 9, -10 - Math.sin(a) * 9); cr.lineTo(hx * dir + Math.cos(a) * 9, -10 + Math.sin(a) * 9);
                }
                cr.stroke();
            }
            rgb(cr, C.purple); cr.setLineWidth(3);
            cr.moveTo(-16 * dir, -10); cr.lineTo(0, -10); cr.lineTo(-5 * dir, -27); cr.closePath();
            cr.moveTo(0, -10); cr.lineTo(12 * dir, -26); cr.lineTo(16 * dir, -10);
            cr.moveTo(-5 * dir, -27); cr.lineTo(12 * dir, -26); cr.stroke();
            cr.moveTo(12 * dir, -26); cr.lineTo(10 * dir, -32); cr.stroke();
            rgb(cr, C.foot); rr(cr, -9 * dir - 4, -30, 9, 3, 1.5); cr.fill();
            rgb(cr, C.teal); rr(cr, 10 * dir - 3, -33, 6, 2.5, 1); cr.fill();
        };
        // Chunky EMO-like shoe: a rounded block on a coloured sole. y0 is the
        // ground line under the sole; rot tilts it (moonwalk heel-up).
        const shoe = (fx, y0, rot = 0, pivot = 0) => {   // pivot: x offset of the rotation point
            cr.save(); cr.translate(fx + dir * 2 + pivot, y0); if (rot) cr.rotate(rot); if (pivot) cr.translate(-pivot, 0);
            rgb(cr, C.foot); rr(cr, -8, -10, 16, 9, 4); cr.fill();
            rgb(cr, C.stripe); rr(cr, -9, -3, 18, 3, 1.5); cr.fill();
            rr(cr, -1, -8, 2, 3, 1); cr.fill();
            cr.setSourceRGBA(1, 1, 1, 0.16); rr(cr, -5.5, -9, 5, 2, 1); cr.fill();
            cr.restore();
        };
        const legIK = (hx, hy, fx, footY, L) => {
            const dxl = fx - hx, dyl = footY - 3 - hy;
            const d = Math.min(Math.hypot(dxl, dyl), 2 * L - 0.01);
            const ka = Math.atan2(dyl, dxl) - dir * Math.acos(d / (2 * L));
            const kx = hx + Math.cos(ka) * L, ky = hy + Math.sin(ka) * L;
            rgb(cr, C.limb); cr.setLineWidth(10); cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.moveTo(hx, hy); cr.lineTo(kx, ky); cr.lineTo(fx, footY - 3); cr.stroke();
            shoe(fx, footY + 1);
        };
        if (ride === 'skate') {
            if (b.kickflip && m === 'jump') { cr.save(); cr.translate(0, -4); cr.rotate(t * 18); cr.translate(0, 4); drawSkate(); cr.restore(); }
            else drawSkate();
        }
        if (ride === 'bike') drawBike((b.dist ?? 0) / S / 9.5);

        // legs
        const leg = (hx, fx, footY) => {
            hx *= 1.4; fx *= 1.4;   // wider stance for the chunky shoes
            rgb(cr, C.limb); cr.setLineWidth(11);
            cr.moveTo(hx, y + h * 0.76); cr.lineTo(fx, footY - 6); cr.stroke();
            shoe(fx, footY + 2);
        };
        if (m === 'stay' && !staySit) {
            // waiting: one foot tapping
            const tap = Math.max(0, Math.sin(t * 7)) * 3;
            leg(-8, -8, fy); leg(8, 8 + dir * 2, fy - tap);
        } else if (m === 'slowwalk') {
            const ph2 = (b.dist ?? 0) / S / 3.2, s2 = Math.sin(ph2) * 6;
            leg(-8, -8 + s2, fy - Math.max(0, Math.cos(ph2)) * 2); leg(8, 8 - s2, fy - Math.max(0, -Math.cos(ph2)) * 2);
        } else if (m === 'lazydance') {   // lying there, feet wiggling to the beat
            const wg = Math.sin(t * 10) * 3;
            shoe(-12 - dir * 2 + wg, fy + 1); shoe(12 - dir * 2 - wg, fy + 1);
        } else if (m === 'watchingyou' && b.wy?.moving) {
            const back = b.wy.phase === 'off';   // backing out: steps run in reverse
            const ph2 = (back ? -1 : 1) * (b.dist ?? 0) / S / 3.2, s2 = Math.sin(ph2) * 7;   // big, slow strides
            leg(-8, -8 + s2, fy - Math.max(0, Math.cos(ph2)) * 3); leg(8, 8 - s2, fy - Math.max(0, -Math.cos(ph2)) * 3);
        } else if (m === 'stretched' || m === 'snapback') {
            for (const key of ['legL', 'legR']) {
                const L = LIMBS[key];
                if (b.limb?.key === key) {
                    this._rubberLimb(cr, L, b.limb.tip, b.limb.rest);
                } else {
                    rgb(cr, C.limb); cr.setLineWidth(L.width); cr.moveTo(L.base[0], L.base[1]); cr.lineTo(L.rest[0], L.rest[1]); cr.stroke();
                    shoe(L.rest[0] - dir * 2, 0);
                }
            }
        } else if (ride === 'skate') {
            // stance on the board; now and then the back foot pushes off the ground
            const push = Math.max(0, Math.sin(t * 3));
            legIK(dir * 7, y + h * 0.76, dir * 10, fy, 11);
            legIK(-dir * 7, y + h * 0.76, -dir * (9 + push * 9), fy + push * 7, 11);
        } else if (ride === 'bike') {
            const ang = (b.dist ?? 0) / S / 5;
            for (const off of [0, Math.PI]) {
                const px = Math.cos(ang + off) * 5 * dir, py = -10 + Math.sin(ang + off) * 5;
                legIK(-dir * 3, y + h * 0.76, px, py + 3, 13);
            }
        } else if (m === 'broken') {
            // legs are off; the body sits on the ground
        } else if (sitting) {
            shoe(-12 - dir * 2, fy + 1); shoe(12 - dir * 2, fy + 1);
        } else if (m === 'held') {
            const fk = b.scared ? (b.fearK ?? 0) : 0;   // kicks faster and wider the higher it is
            const s = Math.sin(t * (18 + 22 * fk)) * (5 + 7 * fk);
            leg(-8, -10 + s, fy + 8); leg(8, 10 - s, fy + 8);
        } else if (m === 'fly' || m === 'fall' || m === 'jump' || m === 'jetfail' || m === 'ufo' || m === 'tarzan' || m === 'stuck') {
            leg(-8, -11, fy + 4); leg(8, 11, fy + 4);
        } else if (m === 'chute') {
            const k = Math.sin(t * 3) * 3;
            leg(-8, -9 + k, fy + 6); leg(8, 9 + k, fy + 6);
        } else if (m === 'climb') {
            const k = Math.sin(t * 10) * 5;
            leg(-8, -8 + dir * 6, fy - 2 + k); leg(8, 8 + dir * 6, fy - 2 - k);
        } else if (m === 'dance') {
            const k = Math.sin(t * 9) * 6;
            leg(-8, -10 + k, fy); leg(8, 10 + k, fy);
        } else if (moon) {
            // Moonwalk, done properly: one foot is up on its toes and stays put
            // on the floor while the other, flat, glides backwards under the
            // body; at the end of each glide they swap with a quick heel drop.
            // Positions are linear in distance (not a sine), with the glide
            // length matched to how far the body moves, so the planted toe
            // never slides.
            // The hips sit close together and the glide is long, so the sliding
            // foot passes right by the planted one (with the hips 22 apart, as
            // in the waddle, the feet never crossed and the illusion was lost).
            // The far leg is drawn first and a shade darker.
            const L = 24, u = ((b.dist ?? 0) / S / (2 * L)) % 1;
            for (const [side, off] of [[-1, 0], [1, 0.5]]) {
                const v = (u + off) % 1, onToes = v < 0.5;
                const rel = onToes ? -L / 2 + L * (v / 0.5) : L / 2 - L * ((v - 0.5) / 0.5);
                const hx = side * 3, hy = y + h * 0.74, fx = hx + dir * rel;
                // quick heel pop right after the swap, then held on the toes
                const tilt = onToes ? 0.5 * Math.min(1, v / 0.08) : 0;
                const toe = dir * 8, cx0 = fx + dir * 2;
                // ankle: the shoe top, rotated about the toe
                const ax = cx0 + toe + (-toe) * Math.cos(dir * tilt) - (-7) * Math.sin(dir * tilt);
                const ay = fy + 0.5 + (-toe) * Math.sin(dir * tilt) + (-7) * Math.cos(dir * tilt);
                // on its toes the knee bends forward; flat, the leg is straight
                const kx = (hx + ax) / 2 + dir * 6 * (tilt / 0.5), ky = (hy + ay) / 2;
                const shade = side < 0 ? 0.8 : 1;
                cr.setSourceRGB(C.limb[0] * shade, C.limb[1] * shade, C.limb[2] * shade);
                cr.setLineWidth(11); cr.setLineCap(Cairo.LineCap.ROUND); cr.setLineJoin(Cairo.LineJoin.ROUND);
                cr.moveTo(hx, hy); cr.lineTo(kx, ky); cr.lineTo(ax, ay); cr.stroke();
                shoe(fx, fy + 0.5, dir * tilt, toe);
            }
        } else {
            // EMO-style waddle: short, chunky legs that stay straight, small
            // flat-footed steps; the lifted foot rises only a little.
            const stride = backwards ? 5 : running ? 12 : m === 'walk' || dvWalk ? gait.stride : 6;
            const lift = backwards ? 6 : running ? 5 : m === 'walk' || dvWalk ? gait.lift : 2.5;
            for (const [side, off] of [[-1, 0], [1, Math.PI]]) {
                const s = Math.sin(pw + off), c = Math.cos(pw + off);
                const hx = side * 11, hy = y + h * 0.74;
                const fx = hx + dir * s * stride / 2, footY = fy - Math.max(0, c) * lift;
                rgb(cr, C.limb); cr.setLineWidth(12); cr.setLineCap(Cairo.LineCap.ROUND);
                cr.moveTo(hx, hy); cr.lineTo(fx, footY - 7); cr.stroke();
                shoe(fx, footY + 0.5);
            }
        }

        // jets
        if (m === 'fly' || (m === 'jetfail' && Math.random() > 0.35)) {   // the failing jetpack sputters
            cr.setSourceRGBA(1, Math.sin(t * 30) > 0 ? 0.72 : 0.42, 0.3, 1);
            for (const jx of [-6, 8]) {
                cr.moveTo(jx - 6, fy - 6); cr.lineTo(jx, fy + 10 + Math.random() * 6); cr.lineTo(jx + 6, fy - 6); cr.fill();
            }
        }

        // head: silver bezel, shell, screen
        const hh = h * 0.78;
        const pat = new Cairo.LinearGradient(0, y, 0, y + hh);
        pat.addColorStopRGB(0, 0.87, 0.88, 0.91); pat.addColorStopRGB(1, 0.42, 0.44, 0.49);
        cr.setSource(pat); rr(cr, x - 2, y - 2, w + 4, hh + 4, 14); cr.fill();
        rgb(cr, C.shell); rr(cr, x + 1, y + 1, w - 2, hh - 2, 12); cr.fill();
        rgb(cr, C.screen); rr(cr, x + 5, y + 6, w - 10, h * 0.62, 9); cr.fill();

        // headphones
        rgb(cr, C.purple); cr.setLineWidth(5);
        cr.moveTo(x - 1, y + h * 0.35); cr.curveTo(x + w * 0.1, y - 18, x + w * 0.9, y - 18, x + w + 1, y + h * 0.35); cr.stroke();
        rr(cr, x - 6, y + h * 0.2, 8, h * 0.34, 4); cr.fill(); rr(cr, x + w - 2, y + h * 0.2, 8, h * 0.34, 4); cr.fill();
        const ringGlow = m === 'meeting' || m === 'focus' || m === 'phones';
        // Rings show the mood (GAIT colours); meetings, focus and headphones keep their glow.
        if (ringGlow) rgb(cr, C.glow);
        else if (backwards && Math.floor(t * 3) % 2 === 0) cr.setSourceRGBA(1, 0.66, 0.15, 1);   // reversing light
        else cr.setSourceRGBA(...gait.ring, gait.pulse ? 0.55 + 0.45 * Math.sin(t * gait.pulse) : 1);
        rr(cr, x - 4, y + h * 0.27, ringGlow ? 4 : 3, h * 0.2, 2); cr.fill();
        rr(cr, x + w + 1, y + h * 0.27, ringGlow ? 4 : 3, h * 0.2, 2); cr.fill();

        // Dressed for the weather (wttr.in, checked every 30 min).
        const wx = this._weather;
        const outfitOk = !['hang', 'handstand', 'knocked', 'broken', 'held', 'thrown', 'tumble'].includes(m) && !b.held;
        if (wx && outfitOk) {
            if (wx.cold) {
                cr.setSourceRGBA(0.85, 0.25, 0.3, 1); rr(cr, x - 1, y + hh - 4, w + 2, 6, 3); cr.fill();
                cr.moveTo(x + w * 0.7, y + hh); cr.lineTo(x + w * 0.66 - dir * 3, y + hh + 10 + Math.sin(t * 6) * 1.5);
                cr.lineTo(x + w * 0.78 - dir * 3, y + hh + 10); cr.closePath(); cr.fill();
            }
            if (wx.rain && ['walk', 'duck', 'look', 'stay', 'sit', 'splash'].includes(m)) {
                cr.setSourceRGBA(0.3, 0.25, 0.6, 1); cr.setLineWidth(1.5);
                cr.moveTo(-dir * 6, y + h * 0.5); cr.lineTo(-dir * 6, y - 24); cr.stroke();
                cr.setSourceRGBA(0.35, 0.3, 0.75, 0.95);
                cr.newSubPath(); cr.arc(-dir * 6, y - 22, 26, Math.PI, 2 * Math.PI); cr.closePath(); cr.fill();
                cr.setSourceRGBA(0.6, 0.8, 1, 0.6);
                for (let k = 0; k < 4; k++) { const q = (t * 1.6 + k / 4) % 1; cr.newSubPath(); cr.arc(-dir * 6 + (k - 1.5) * 16, y - 50 + q * 26, 1, 0, 2 * Math.PI); cr.fill(); }
            }
        }

        if (nowD < (b.soakedUntil ?? 0)) {
            cr.setSourceRGBA(0.35, 0.55, 0.95, 0.16); rr(cr, x, y, w, h, 12); cr.fill();   // wet sheen
            cr.setSourceRGBA(0.55, 0.78, 1, 0.9);
            for (let k = 0; k < 3; k++) { const q = (t * 1.8 + k / 3) % 1; cr.newSubPath(); cr.arc(x + 8 + k * 15, y + h + q * 14, 1.4, 0, 2 * Math.PI); cr.fill(); }
        }
        if (b.held && wx?.rain) {   // out in the rain, no umbrella
            cr.setSourceRGBA(0.6, 0.8, 1, 0.7); cr.setLineWidth(1);
            for (let k = 0; k < 8; k++) { const q = (t * 2.2 + k / 8) % 1, rx2 = -36 + k * 10; cr.moveTo(rx2, y - 40 + q * 80); cr.lineTo(rx2 - 1.5, y - 34 + q * 80); }
            cr.stroke();
        }

        // Ninja: a black headband with red tails fluttering behind.
        if (nowD < (b.ninjaUntil ?? 0)) {
            cr.setSourceRGBA(0.08, 0.08, 0.1, 1); rr(cr, x - 1, y + 3, w + 2, 6, 2); cr.fill();
            cr.setSourceRGBA(0.9, 0.2, 0.25, 1); cr.setLineWidth(2.2);
            const bx = dir > 0 ? x : x + w, fl = Math.sin(t * 14) * 3;
            cr.moveTo(bx, y + 6); cr.lineTo(bx - dir * 12, y + 3 + fl); cr.moveTo(bx, y + 6); cr.lineTo(bx - dir * 11, y + 9 - fl); cr.stroke();
        }
        // Secret costume: a party hat.
        if ((this._unlocked('costume') || m === 'party') && !['knocked', 'broken', 'hang', 'handstand'].includes(m)) {
            cr.setSourceRGBA(0.95, 0.4, 0.6, 1);
            cr.moveTo(-8, y - 1); cr.lineTo(0, y - 18); cr.lineTo(8, y - 1); cr.closePath(); cr.fill();
            cr.setSourceRGBA(1, 0.9, 0.3, 1); cr.newSubPath(); cr.arc(0, y - 18, 2.4, 0, 2 * Math.PI); cr.fill();
        }

        // arms
        const arm = (sx, sy, ex, ey) => {
            rgb(cr, C.limb); cr.setLineWidth(5);
            cr.moveTo(sx, sy); cr.lineTo(ex, ey); cr.stroke();
            rgb(cr, C.hand); cr.arc(ex, ey, 4, 0, 2 * Math.PI); cr.fill();
        };
        const shY = y + h * 0.5, lx = x - 2, rx = x + w + 2;
        switch (m) {
        case 'climb': {
            const reach = Math.sin(t * 10) * 7, fx = dir > 0 ? rx : lx;
            arm(fx, shY, fx + dir * 9, y - 2 + reach); arm(fx, shY + 6, fx + dir * 9, y + 8 - reach); break;
        }
        case 'detective': {
            const eyeY = y + 6 + h * 0.62 * 0.42;
            arm(lx, shY, -12, eyeY + 3); arm(rx, shY, 12, eyeY + 3); break;   // holding binoculars
        }
        case 'fakesleep': arm(lx, shY, lx + 6, shY + 14); arm(rx, shY, rx - 6, shY + 14); break;
        case 'selfie': {
            arm(rx, shY, rx + 14, y - 12); arm(lx, shY, lx - 8, y + 2);
            rgb(cr, C.hand); cr.setLineWidth(2);   // peace sign
            cr.moveTo(lx - 8, y + 2); cr.lineTo(lx - 11, y - 5); cr.moveTo(lx - 8, y + 2); cr.lineTo(lx - 5, y - 5); cr.stroke();
            b._prop = {kind: 'phone', x: rx + 14, y: y - 12};
            break;
        }
        case 'peek': {
            const hide = Math.floor(b.actT / 0.75) % 2 === 0, eyeY = y + 6 + h * 0.62 * 0.42;
            if (hide) { arm(lx, shY, -9, eyeY); arm(rx, shY, 9, eyeY); }
            else { arm(lx, shY, lx - 14, shY - 8); arm(rx, shY, rx + 14, shY - 8); }
            break;
        }
        case 'laughattack': arm(lx, shY, x + 8, y + h * 0.72); arm(rx, shY, x + w - 8, y + h * 0.72); break;
        case 'handstand': {
            const sw = Math.sin((b.dist ?? 0) / S / 3) * 3;   // walking on its hands
            arm(lx, shY, lx + 2, y - 14 + sw); arm(rx, shY, rx - 2, y - 14 - sw); break;
        }
        case 'hang': arm(lx, shY, lx - 4, y - 12); arm(rx, shY, rx + 4, y - 12); break;   // dangling (it is upside down)
        case 'slide': arm(lx, shY, lx - 6, y - 16); arm(rx, shY, rx + 6, y - 16); break;
        case 'tarzan': {
            arm(lx, shY, -3, y - 16); arm(rx, shY, 3, y - 16);
            if (b.tz) {
                cr.setSourceRGBA(0.55, 0.42, 0.25, 1); cr.setLineWidth(2);
                cr.moveTo(0, y - 16); cr.lineTo((b.tz.ax - b.x) / S, (b.tz.ay - b.y) / S); cr.stroke();
            }
            break;
        }
        case 'ufo': { const s = Math.sin(t * 16) * 5; arm(lx, shY, lx - 8 + s, y - 10); arm(rx, shY, rx + 8 - s, y - 10); break; }
        case 'stuck': arm(lx, shY, lx - 12, shY - 6); arm(rx, shY, rx + 12, shY - 6); break;
        case 'rebel': arm(lx, shY, 8, shY + 6); arm(rx, shY, -8, shY + 3); break;   // arms crossed
        case 'stay':
            if (!staySit) { arm(lx, shY, 8, shY + 6); arm(rx, shY, -8, shY + 3); }    // arms crossed, waiting
            else { arm(lx, shY, lx - 5, fy - 6); arm(rx, shY, rx + 5, fy - 6); }      // sitting, hands down
            break;
        case 'freeze': arm(lx, shY, lx - 10, shY - 10); arm(rx, shY, rx + 12, shY + 4); break;   // statue pose
        case 'clean': {
            // a squeegee sweeping up and down the glass in front of you
            const sy2 = y + h * 0.2 + (Math.sin(t * 4) + 1) * h * 0.35, sx2 = dir * (w / 2 + 16);
            arm(lx, shY, lx - 3, shY + 15); arm(rx, shY, sx2, sy2);
            cr.setSourceRGBA(0.2, 0.21, 0.25, 1); cr.setLineWidth(2); cr.moveTo(sx2, sy2); cr.lineTo(sx2 + dir * 5, sy2); cr.stroke();
            rgb(cr, C.teal); rr(cr, sx2 + dir * 5 - 1.5, sy2 - 7, 3, 14, 1); cr.fill();
            cr.setSourceRGBA(1, 1, 1, 0.7);   // clean streaks and sparkles behind it
            for (let k = 0; k < 3; k++) { const q = (t * 1.3 + k / 3) % 1; cr.newSubPath(); cr.arc(sx2 + dir * 9, y + q * h * 0.9, 1.2, 0, 2 * Math.PI); cr.fill(); }
            break;
        }
        case 'gum': arm(lx, shY, lx - 3, shY + 15); arm(rx, shY, rx + 3, shY + 15); break;
        case 'plane': {
            if (!b.planeThrown) {   // folding it, then the throw
                const fold = Math.sin(t * 10) * 2;
                arm(lx, shY, -6, shY + 2 + fold); arm(rx, shY, 6, shY + 2 - fold);
                cr.setSourceRGBA(0.96, 0.96, 0.98, 1); cr.moveTo(-6, shY - 2); cr.lineTo(8, shY + 2); cr.lineTo(-6, shY + 6); cr.closePath(); cr.fill();
            } else {
                arm(lx, shY, lx - 3, shY + 15); arm(rx, shY, rx + dir * 16, shY - 10);
            }
            break;
        }
        case 'sneeze': { const k = Math.min(1, (1.8 - b.actT) / 1.6); arm(lx, shY, -6, y + 10 - k * 4); arm(rx, shY, 6, y + 10 - k * 4); break; }
        case 'lazyfish':
        case 'fish': {
            // rod out over a little puddle; near the end up comes a boot
            // On a window ledge the line drops over the edge instead of into a puddle.
            const tipX = dir * 34, tipY = y - 8, ledge = typeof b.on === 'number';
            arm(lx, shY, dir * 10, shY + 4); arm(rx, shY, dir * 14, shY + 2);
            cr.setSourceRGBA(0.45, 0.32, 0.18, 1); cr.setLineWidth(2); cr.moveTo(dir * 12, shY + 3); cr.lineTo(tipX, tipY); cr.stroke();
            if (!ledge) { cr.setSourceRGBA(0.4, 0.65, 0.95, 0.6); cr.save(); cr.translate(dir * 40, -1); cr.scale(2.2, 0.45); cr.newSubPath(); cr.arc(0, 0, 9, 0, 2 * Math.PI); cr.restore(); cr.fill(); }
            const nibble = m === 'lazyfish' && Math.sin(t * 0.7) > 0.75;   // a bite it sleeps right through
            const hookY = b.caught ? tipY + 18 : (ledge ? 9 : -2) + Math.sin(t * 2) * 1.5 + (nibble ? Math.sin(t * 30) * 2.5 : 0);
            if (nibble) { cr.setSourceRGBA(1, 0.85, 0.3, 1); cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD); cr.setFontSize(10); cr.moveTo(dir * 36, -14); cr.showText('!'); }
            cr.setSourceRGBA(0.85, 0.87, 0.9, 0.8); cr.setLineWidth(0.8); cr.moveTo(tipX, tipY); cr.lineTo(dir * 38, hookY); cr.stroke();
            if (b.caught && b.catch === 'fish') {
                cr.save(); cr.translate(dir * 38, hookY + 7); cr.rotate(Math.PI / 2 + Math.sin(t * 14) * 0.3);   // wriggling
                cr.setSourceRGBA(1, 0.55, 0.2, 1); cr.save(); cr.scale(1.6, 1); cr.newSubPath(); cr.arc(0, 0, 4, 0, 2 * Math.PI); cr.restore(); cr.fill();
                cr.moveTo(-6, 0); cr.lineTo(-10, -3.5); cr.lineTo(-10, 3.5); cr.closePath(); cr.fill();
                cr.setSourceRGBA(0.05, 0.05, 0.08, 1); cr.newSubPath(); cr.arc(3.5, -1, 0.9, 0, 2 * Math.PI); cr.fill();
                cr.restore();
            } else if (b.caught && b.catch === 'star') {
                cr.save(); cr.translate(dir * 38, hookY + 7); cr.rotate(t * 2);
                cr.setSourceRGBA(1, 0.85, 0.2, 1); cr.moveTo(0, -7);
                for (let k = 1; k < 10; k++) { const a = -Math.PI / 2 + k * Math.PI / 5, rk = k % 2 ? 3 : 7; cr.lineTo(Math.cos(a) * rk, Math.sin(a) * rk); }
                cr.closePath(); cr.fill(); cr.restore();
                cr.setSourceRGBA(1, 1, 0.7, 0.7); cr.newSubPath(); cr.arc(dir * 46, hookY + 2, 1, 0, 2 * Math.PI); cr.fill();
            } else if (b.caught) {
                cr.setSourceRGBA(0.35, 0.24, 0.14, 1);
                cr.moveTo(dir * 35, hookY); cr.lineTo(dir * 41, hookY); cr.lineTo(dir * 41, hookY + 8); cr.lineTo(dir * 47, hookY + 8);
                cr.lineTo(dir * 47, hookY + 12); cr.lineTo(dir * 35, hookY + 12); cr.closePath(); cr.fill();
                cr.setSourceRGBA(0.4, 0.65, 0.95, 0.8); cr.newSubPath(); cr.arc(dir * 44, hookY + 14 + ((t * 30) % 6), 1, 0, 2 * Math.PI); cr.fill();
            }
            break;
        }
        case 'paint': {
            const sp = Math.sin(t * 12) * 3, cx2 = dir * (w / 2 + 14), cy2 = shY - 14 + sp;
            arm(lx, shY, lx - 3, shY + 15); arm(rx, shY, cx2, cy2);
            cr.setSourceRGBA(0.85, 0.2, 0.35, 1); rr(cr, cx2 - 2.5, cy2 - 6, 5, 9, 1.5); cr.fill();   // spray can
            cr.setSourceRGBA(1, 0.4, 0.6, 0.4); cr.newSubPath(); cr.arc(cx2 + dir * 9, cy2 - 5, 4 + Math.random() * 2, 0, 2 * Math.PI); cr.fill();
            break;
        }
        case 'highfive': { const k = Math.sin(t * 10) * 2; arm(lx, shY, lx - 3, shY + 15); arm(rx, shY, dir * (w / 2 + 12), y - 6 + k); break; }
        case 'pose': {
            // peace sign and a hand on the hip for the camera
            arm(rx, shY, rx + 6, y - 6); arm(lx, shY, lx - 8, shY + 10);
            rgb(cr, C.hand); cr.setLineWidth(2);
            cr.moveTo(rx + 6, y - 6); cr.lineTo(rx + 3, y - 13); cr.moveTo(rx + 6, y - 6); cr.lineTo(rx + 9, y - 13); cr.stroke();
            break;
        }
        case 'rocket': {
            const r = b.rocket ?? {k: 0};
            if (r.k < 1.2) {   // hammering it together
                const hm = Math.sin(t * 16) * 5;
                arm(lx, shY, lx - 3, shY + 15); arm(rx, shY, dir * 22, fy - 18 + hm);
                cr.setSourceRGBA(0.5, 0.52, 0.58, 1); rr(cr, dir * 22 - 2, fy - 22 + hm, 6, 4, 1); cr.fill();
            } else {
                arm(lx, shY, lx - 6, y - 14); arm(rx, shY, rx + 6, y - 14);
            }
            break;
        }
        case 'mimewall': {
            // palms flat on an invisible wall, feeling along it
            const s = Math.sin(t * 3) * 4, wx2 = dir * (w / 2 + 10);
            arm(lx, shY, wx2, shY - 10 + s); arm(rx, shY, wx2, shY + 4 - s);
            cr.setSourceRGBA(1, 1, 1, 0.12); cr.rectangle(wx2 + dir * 3 - 1, y - 20, 2, h + 20); cr.fill();
            break;
        }
        case 'tailchase': { const s = Math.sin(t * 20) * 8; arm(lx, shY, lx - 10, shY + s); arm(rx, shY, rx + 10, shY - s); break; }
        case 'snowball': {
            const wind = Math.sin(t * 8) > 0;
            arm(lx, shY, lx - 3, shY + 14); arm(rx, shY, wind ? rx - 4 : rx + 14, wind ? shY - 12 : shY - 4);
            cr.setSourceRGBA(1, 1, 1, 0.95); cr.newSubPath(); cr.arc(wind ? rx - 4 : rx + 14, wind ? shY - 12 : shY - 4, 3.5, 0, 2 * Math.PI); cr.fill();
            break;
        }
        case 'magic': {
            // top hat on the floor, a wand, sparkles, and at the end a rabbit pops out
            const hx = dir * 26, wave = Math.sin(t * 10) * 6;
            arm(lx, shY, lx - 3, shY + 14); arm(rx, shY, hx - dir * 4, y + 6 + wave);
            cr.setSourceRGBA(0.1, 0.1, 0.12, 1); cr.setLineWidth(2); cr.moveTo(hx - dir * 4, y + 6 + wave); cr.lineTo(hx + dir * 6, y - 4 + wave); cr.stroke();
            cr.setSourceRGBA(1, 1, 1, 1); cr.newSubPath(); cr.arc(hx + dir * 6, y - 4 + wave, 1.6, 0, 2 * Math.PI); cr.fill();
            if (!b.snakeAt) {
                cr.setSourceRGBA(0.1, 0.1, 0.12, 1); rr(cr, hx - 8, fy - 14, 16, 14, 2); cr.fill(); rr(cr, hx - 11, fy - 3, 22, 3, 1); cr.fill();
                cr.setSourceRGBA(0.85, 0.2, 0.3, 1); cr.rectangle(hx - 8, fy - 8, 16, 2); cr.fill();
            }
            const p = 1.2 - b.actT;   // seconds since the item appeared
            if (b.rabbit && b.magicItem === 'dove') {
                const by = fy - 18 - Math.max(0, p - 0.2) * 70, bx = hx + Math.sin(p * 7) * 5, flap = Math.sin(t * 30) > 0 ? -5 : 3;
                cr.setSourceRGBA(0.97, 0.97, 0.97, 1);
                cr.save(); cr.translate(bx, by); cr.scale(1.5, 1); cr.newSubPath(); cr.arc(0, 0, 3.5, 0, 2 * Math.PI); cr.restore(); cr.fill();
                cr.moveTo(bx - 2, by); cr.lineTo(bx - 9, by + flap); cr.lineTo(bx + 1, by + 1); cr.closePath(); cr.fill();
                cr.moveTo(bx + 1, by); cr.lineTo(bx + 7, by + flap); cr.lineTo(bx + 3, by + 1); cr.closePath(); cr.fill();
                cr.setSourceRGBA(1, 0.6, 0.2, 1); cr.moveTo(bx + dir * 5, by - 1); cr.lineTo(bx + dir * 7.5, by); cr.lineTo(bx + dir * 5, by + 1); cr.fill();
            } else if (b.rabbit && b.magicItem === 'flowers') {
                const up = Math.min(1, p / 0.4) * 14;
                cr.setSourceRGBA(0.3, 0.65, 0.3, 1); cr.setLineWidth(1.5);
                for (const sx of [-4, 0, 4]) { cr.moveTo(hx, fy - 13); cr.lineTo(hx + sx * 1.4, fy - 16 - up + Math.abs(sx)); }
                cr.stroke();
                for (const [sx, c] of [[-4, [0.95, 0.3, 0.35]], [0, [1, 0.85, 0.2]], [4, [0.95, 0.5, 0.8]]]) {
                    cr.setSourceRGBA(c[0], c[1], c[2], 1); cr.newSubPath(); cr.arc(hx + sx * 1.4, fy - 17 - up + Math.abs(sx), 2.8, 0, 2 * Math.PI); cr.fill();
                }
            } else if (b.rabbit && b.magicItem === 'bomb') {
                const up = Math.min(1, p / 0.3) * 8, by = fy - 19 - up;
                if (b.actT > 0.25) {
                    cr.setSourceRGBA(0.12, 0.12, 0.14, 1); cr.newSubPath(); cr.arc(hx, by, 6, 0, 2 * Math.PI); cr.fill();
                    cr.setSourceRGBA(1, 1, 1, 0.35); cr.newSubPath(); cr.arc(hx - 2, by - 2, 1.5, 0, 2 * Math.PI); cr.fill();
                    cr.setSourceRGBA(0.6, 0.45, 0.3, 1); cr.setLineWidth(1.2); cr.moveTo(hx + 3, by - 5); cr.curveTo(hx + 5, by - 9, hx + 8, by - 8, hx + 8, by - 11); cr.stroke();
                    cr.setSourceRGBA(1, 0.8 * Math.random() + 0.2, 0.2, 1); cr.newSubPath(); cr.arc(hx + 8, by - 11, 1.5 + Math.random(), 0, 2 * Math.PI); cr.fill();
                } else {   // BOOM: a flash and a smoke ball
                    const k = 1 - b.actT / 0.25;
                    cr.setSourceRGBA(1, 0.6, 0.15, 0.8 * (1 - k)); cr.newSubPath(); cr.arc(hx, by, 8 + k * 22, 0, 2 * Math.PI); cr.fill();
                    cr.setSourceRGBA(0.45, 0.45, 0.48, 0.7); cr.newSubPath(); cr.arc(hx, by - k * 6, 6 + k * 14, 0, 2 * Math.PI); cr.fill();
                }
            } else if (b.rabbit && b.magicItem === 'empty') {
                for (let k = 0; k < 3; k++) {   // just a sad little puff of smoke
                    const q = Math.min(1, p / 1.1);
                    cr.setSourceRGBA(0.75, 0.76, 0.8, 0.6 * (1 - q));
                    cr.newSubPath(); cr.arc(hx + (k - 1) * 3, fy - 16 - q * 14 - k * 2, 2 + q * 3, 0, 2 * Math.PI); cr.fill();
                }
            } else if (b.rabbit && b.magicItem === 'confetti') {
                const cols = [[0.95, 0.3, 0.35], [1, 0.85, 0.2], [0.3, 0.75, 0.95], [0.5, 0.85, 0.4], [0.85, 0.5, 0.95]];
                for (let k = 0; k < 14; k++) {
                    const a = -Math.PI / 2 + (k / 13 - 0.5) * 2.2, v = 40 + (k * 37) % 25;
                    const cx2 = hx + Math.cos(a) * v * p, cy2 = fy - 14 + Math.sin(a) * v * p + 45 * p * p;
                    const c = cols[k % cols.length]; cr.setSourceRGBA(c[0], c[1], c[2], 1);
                    cr.save(); cr.translate(cx2, cy2); cr.rotate(t * 8 + k); cr.rectangle(-1.5, -0.8, 3, 1.6); cr.restore(); cr.fill();
                }
            }
            if (b.rabbit && !b.snakeAt && (b.magicItem ?? 'rabbit') === 'rabbit') {
                const up = Math.min(1, (1.2 - b.actT) / 0.4) * 12;
                cr.setSourceRGBA(0.97, 0.97, 0.97, 1); cr.newSubPath(); cr.arc(hx, fy - 14 - up, 5, 0, 2 * Math.PI); cr.fill();
                rr(cr, hx - 4, fy - 30 - up, 3, 10, 1.5); cr.fill(); rr(cr, hx + 1, fy - 30 - up, 3, 10, 1.5); cr.fill();
                cr.setSourceRGBA(1, 0.5, 0.6, 1); cr.newSubPath(); cr.arc(hx, fy - 13 - up, 1, 0, 2 * Math.PI); cr.fill();
            }
            for (let k = 0; k < 4; k++) {
                const a = t * 5 + k * 1.6; cr.setSourceRGBA(1, 0.9, 0.4, 0.8);
                cr.newSubPath(); cr.arc(hx + Math.cos(a) * 12, y - 6 + Math.sin(a) * 6, 1.2, 0, 2 * Math.PI); cr.fill();
            }
            break;
        }
        case 'kite': {
            // holding a string up to a diamond kite looping overhead
            const kx = dir * 30 + Math.sin(t * 1.3) * 26, ky = -125 + Math.cos(t * 1.7) * 12;
            arm(lx, shY, lx - 3, shY + 14); arm(rx, shY, rx + dir * 6, y - 8);
            cr.setSourceRGBA(0.9, 0.9, 0.92, 0.7); cr.setLineWidth(0.8); cr.moveTo(rx + dir * 6, y - 8); cr.curveTo(kx * 0.3, y - 50, kx * 0.8, ky + 30, kx, ky + 10); cr.stroke();
            cr.setSourceRGBA(0.95, 0.35, 0.45, 1); cr.moveTo(kx, ky - 12); cr.lineTo(kx + 9, ky); cr.lineTo(kx, ky + 12); cr.lineTo(kx - 9, ky); cr.closePath(); cr.fill();
            rgb(cr, C.teal); cr.moveTo(kx, ky - 12); cr.lineTo(kx + 9, ky); cr.lineTo(kx, ky); cr.closePath(); cr.fill();
            cr.setSourceRGBA(1, 0.85, 0.3, 1); cr.setLineWidth(1.2);
            cr.moveTo(kx, ky + 12); cr.curveTo(kx - 6, ky + 20, kx + 6, ky + 26, kx, ky + 34 + Math.sin(t * 6) * 3); cr.stroke();
            break;
        }
        case 'command': arm(lx, shY, lx - 3, shY + 14); arm(rx, shY, dir * (w / 2 + 18), shY - 6); break;   // pointing at the dog
        case 'fort': {
            // stacks blocks, hides behind them, then knocks them over
            const n = Math.min(6, Math.floor((6.5 - b.actT) / 0.5)), fx2 = dir * 30;
            const knocked = b.actT < 0.6;
            for (let i = 0; i < n; i++) {
                const col2 = [[0.95, 0.5, 0.4], [0.4, 0.75, 1], [1, 0.85, 0.35]][i % 3];
                let bx = fx2 + ((i % 2) - 0.5) * 12, by = fy - 9 - Math.floor(i / 2) * 9;
                if (knocked) { const k = (0.6 - b.actT) / 0.6; bx += dir * k * (20 + i * 8); by += k * k * 9 * (i + 1); }
                cr.setSourceRGBA(col2[0], col2[1], col2[2], 1); rr(cr, bx - 6, by, 12, 9, 1.5); cr.fill();
            }
            if (b.actT > 3) { arm(lx, shY, fx2 - dir * 6, fy - 12); arm(rx, shY, fx2, fy - 20); }
            else { arm(lx, shY, lx - 3, shY + 12); arm(rx, shY, rx + 3, shY + 12); }
            break;
        }
        case 'hiccups': arm(lx, shY, -4, y + h * 0.66); arm(rx, shY, 4, y + h * 0.66); break;   // hand over mouth-ish
        case 'hammock': case 'clouds': case 'sunbathe':   // hands behind its head
            arm(lx, shY, -12, y + 3); arm(rx, shY, 12, y + 3); break;
        case 'bellyup': case 'pillownap': case 'snore': case 'pool': arm(lx, shY, lx - 10, shY + 4); arm(rx, shY, rx + 10, shY + 4); break;
        case 'burrito': case 'drape': break;   // arms inside the blanket / dangling over the edge (backdrop)
        case 'edgeblanket': case 'sheep': case 'petnap': case 'lazydance': arm(lx, shY, lx - 10, shY + 4); arm(rx, shY, rx + 10, shY + 4); break;
        case 'slowwalk': { const s2 = Math.sin((b.dist ?? 0) / S / 3.2) * 4; arm(lx, shY, lx - 3 + s2, shY + 15); arm(rx, shY, rx + 3 - s2, shY + 15); break; }
        case 'coffeedrip': arm(lx, shY, lx - 6, fy - 6); arm(rx, shY, rx + 6, fy - 6); break;
        case 'screensaver': arm(lx, shY, lx - 6, fy - 6); arm(rx, shY, rx + 6, fy - 6); break;
        case 'rocking': {   // a cup of tea in hand
            arm(lx, shY, lx - 6, fy - 6);
            const hx2 = rx + 5, hy2 = shY + 8; arm(rx, shY, hx2, hy2);
            cr.setSourceRGBA(0.93, 0.94, 0.96, 1); rr(cr, hx2 - 4, hy2 - 6, 8, 7, 2); cr.fill();
            cr.setSourceRGBA(0.9, 0.92, 0.95, 0.5); cr.setLineWidth(1); const k3 = (t * 1.2) % 1;
            cr.moveTo(hx2, hy2 - 8 - k3 * 5); cr.curveTo(hx2 + 2, hy2 - 10 - k3 * 5, hx2 - 2, hy2 - 13 - k3 * 5, hx2 + 1, hy2 - 16 - k3 * 5); cr.stroke();
            break;
        }
        case 'pizza': {
            if ((b.pizzaT ?? 0) <= 2.4) { arm(lx, shY, lx - 6, fy - 6); arm(rx, shY, rx + 6, fy - 6); break; }   // watching the drone
            const bite = Math.sin(t * 1.5) > 0.3, hx2 = bite ? dir * 6 : rx + 4, hy2 = bite ? y + h * 0.62 : shY + 6;
            arm(lx, shY, lx - 10, shY + 4); arm(rx, shY, hx2, hy2);
            cr.setSourceRGBA(0.95, 0.75, 0.3, 1); cr.moveTo(hx2, hy2 - 8); cr.lineTo(hx2 + 6, hy2 + 4); cr.lineTo(hx2 - 6, hy2 + 4); cr.closePath(); cr.fill();
            cr.setSourceRGBA(0.85, 0.2, 0.2, 1); cr.newSubPath(); cr.arc(hx2, hy2, 1.4, 0, 2 * Math.PI); cr.fill();
            break;
        }
        case 'lean': {   // elbow on the post, chin in its other hand, staring into space
            const fx2 = dir > 0 ? rx : lx, bx2 = dir > 0 ? lx : rx;
            arm(fx2, shY, dir * (w / 2 + 8), shY - 4); arm(bx2, shY, dir * 2, y + h * 0.66);
            break;
        }
        case 'charging': arm(lx, shY, lx - 6, fy - 6); arm(rx, shY, rx + 6, fy - 6); break;
        case 'sleepyread': {   // the book creeps up until it rests on its face
            const k2 = Math.min(1, Math.max(0, 1 - b.actT / (b.readDur || b.actT || 1)));
            const by2 = y + h * (0.8 - 0.45 * Math.min(1, k2 / 0.7)), tilt = -dir * 0.4 * Math.min(1, k2 / 0.7);
            arm(lx, shY, -10, by2); arm(rx, shY, 10, by2);
            cr.save(); cr.translate(0, by2); cr.rotate(tilt);
            rgb(cr, C.purple); rr(cr, -14, -9, 28, 14, 2); cr.fill();
            cr.setSourceRGBA(0.96, 0.96, 0.93, 1); cr.rectangle(-12, -8, 11, 11); cr.fill(); cr.rectangle(1, -8, 11, 11); cr.fill();
            cr.restore();
            b.readK = k2;
            break;
        }
        case 'bubbles': {   // a bubble wand at its mouth
            arm(lx, shY, lx - 10, shY + 4);
            const hx2 = dir * 8, hy2 = y + h * 0.62; arm(rx, shY, hx2, hy2);
            cr.setSourceRGBA(0.95, 0.5, 0.75, 1); cr.setLineWidth(1.4); cr.moveTo(hx2, hy2); cr.lineTo(hx2 + dir * 6, hy2 - 8); cr.stroke();
            cr.newSubPath(); cr.arc(hx2 + dir * 8, hy2 - 11, 3, 0, 2 * Math.PI); cr.stroke();
            break;
        }
        case 'fivemore': {   // one finger up: "five more minutes"
            arm(lx, shY, lx - 6, fy - 6); arm(rx, shY, rx + 6, y - 4);
            rgb(cr, C.hand); cr.setLineWidth(2.2); cr.moveTo(rx + 6, y - 6); cr.lineTo(rx + 6, y - 13); cr.stroke();
            break;
        }
        case 'snackbed': {
            const cx2 = dir * 4, cy2 = y + h * 0.62;   // a cookie held at its mouth, crumbs on its face
            arm(lx, shY, lx - 10, shY + 4); arm(rx, shY, cx2 + 4, cy2 + 2);
            cr.setSourceRGBA(0.75, 0.5, 0.25, 1); cr.newSubPath(); cr.arc(cx2, cy2, 5, 0, 2 * Math.PI); cr.fill();
            cr.setSourceRGBA(0.35, 0.2, 0.1, 1); for (const [px2, py2] of [[-2, -1], [2, 1], [0, 2.5]]) { cr.newSubPath(); cr.arc(cx2 + px2, cy2 + py2, 0.9, 0, 2 * Math.PI); cr.fill(); }
            cr.setSourceRGBA(0.75, 0.5, 0.25, 1); for (const [px2, py2] of [[-8, -6], [5, -9], [-3, -12]]) { cr.newSubPath(); cr.arc(px2, y + h * 0.4 + py2, 0.9, 0, 2 * Math.PI); cr.fill(); }
            break;
        }
        case 'yawnflop': arm(lx, shY, lx - 10, y - 16); arm(rx, shY, rx + 10, y - 16); break;
        case 'remote': {
            arm(lx, shY, lx - 10, shY + 4);
            const hx2 = rx + 10, hy2 = shY - 8; arm(rx, shY, hx2, hy2);
            cr.setSourceRGBA(0.08, 0.08, 0.1, 1); rr(cr, hx2 - 2, hy2 - 8, 4, 9, 1.2); cr.fill();
            cr.setSourceRGBA(0.95, 0.2, 0.2, Math.sin(t * 4) > 0 ? 1 : 0.4); cr.newSubPath(); cr.arc(hx2, hy2 - 6, 0.9, 0, 2 * Math.PI); cr.fill();   // clicking
            break;
        }
        case 'daydream': arm(lx, shY, lx - 6, fy - 6); arm(rx, shY, rx + 6, fy - 6); break;
        case 'lazywave': { const s2 = Math.sin(t * 3) * 4; arm(lx, shY, lx - 6, fy - 6); arm(rx, shY, rx + 6 + s2, y - 6); break; }
        case 'roll': arm(lx, shY, lx + 4, shY + 10); arm(rx, shY, rx - 4, shY + 10); break;
        case 'lunch': {
            // sitting at an open lunchbox, taking bites of a sandwich that shrinks
            const bite = Math.sin(t * 1.6) > 0.35, left = Math.max(0.15, b.actT / 24);
            const boxX = x + w * 0.28, boxY = y + h + 1;
            const mouthX = dir * 4, mouthY = y + 6 + h * 0.62 * 0.82;
            const hx2 = bite ? mouthX + 3 : rx + 4, hy2 = bite ? mouthY + 2 : shY + 12;
            cr.setSourceRGBA(0.25, 0.55, 0.9, 1); rr(cr, boxX - 9, boxY - 7, 18, 7, 2); cr.fill();          // box
            cr.setSourceRGBA(0.2, 0.45, 0.78, 1); cr.save(); cr.translate(boxX - 9, boxY - 7); cr.rotate(-1.1); rr(cr, 0, -2, 18, 2.5, 1); cr.fill(); cr.restore();   // open lid
            cr.setSourceRGBA(0.95, 0.35, 0.3, 1); cr.newSubPath(); cr.arc(boxX + 4, boxY - 7, 2.5, 0, 2 * Math.PI); cr.fill();   // an apple
            arm(lx, shY, boxX - 4, boxY - 7); arm(rx, shY, hx2, hy2);
            cr.save(); cr.translate(hx2, hy2 - 3); cr.scale(left * 0.6 + 0.4, 1);   // the sandwich
            cr.setSourceRGBA(0.95, 0.82, 0.55, 1); cr.moveTo(-6, 3); cr.lineTo(6, 3); cr.lineTo(0, -6); cr.closePath(); cr.fill();
            cr.setSourceRGBA(0.4, 0.75, 0.3, 1); cr.setLineWidth(1.4); cr.moveTo(-5, 1.5); cr.lineTo(5, 1.5); cr.stroke();
            cr.restore();
            break;
        }
        case 'stretch': {
            if (b.actT > 3.4) { arm(lx, shY, lx - 10, y - 16); arm(rx, shY, rx + 10, y - 16); }   // big yawn, arms up wide
            else {
                const up = Math.sin((3.4 - b.actT) * Math.PI * 1.5) > 0;
                if (up) { arm(lx, shY, lx - 6, y - 16); arm(rx, shY, rx + 6, y - 16); }
                else { arm(lx, shY, lx - 12, shY + 12); arm(rx, shY, rx + 12, shY + 12); }
            }
            break;
        }
        case 'weekend': { const s = Math.sin(t * 9); arm(lx, shY, lx - 12, shY - 14 * s); arm(rx, shY, rx + 12, shY + 14 * s); break; }
        case 'mime': {
            const mm = b.mime ?? {hx: 0, hy: 0};
            const gl = (sx, ex, ey) => {   // white mime gloves
                rgb(cr, C.limb); cr.setLineWidth(5); cr.moveTo(sx, shY); cr.lineTo(ex, ey); cr.stroke();
                cr.setSourceRGBA(0.97, 0.97, 0.97, 1); cr.newSubPath(); cr.arc(ex, ey, 4.5, 0, 2 * Math.PI); cr.fill();
            };
            gl(lx, lx - 8 + mm.hx, shY - 6 + mm.hy); gl(rx, rx + 8 + mm.hx, shY - 6 + mm.hy);
            break;
        }
        case 'hide': arm(lx, shY, lx + 4, shY + 12); arm(rx, shY, rx - 4, shY + 12); break;
        case 'nightowl': {
            // holding a sign up over its head
            const sy2 = y - 30;
            arm(lx, shY, -14, sy2 + 10); arm(rx, shY, 14, sy2 + 10);
            cr.setSourceRGBA(0.55, 0.4, 0.25, 1); cr.setLineWidth(2); cr.moveTo(0, sy2 + 12); cr.lineTo(0, y + 2); cr.stroke();
            cr.setSourceRGBA(0.98, 0.97, 0.93, 1); rr(cr, -26, sy2 - 8, 52, 18, 3); cr.fill();
            cr.setSourceRGBA(0.85, 0.2, 0.25, 1); cr.setLineWidth(1); rr(cr, -26, sy2 - 8, 52, 18, 3); cr.stroke();
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD); cr.setFontSize(8);
            cr.moveTo(-22, sy2 + 4); cr.showText('Go to bed!');
            break;
        }
        case 'splash': { const s = Math.sin(t * 10); arm(lx, shY, lx - 12, shY - 10 - 4 * s); arm(rx, shY, rx + 12, shY - 10 + 4 * s); break; }
        case 'danceoff': {
            const d = b.dof;
            if (d?.phase === 'me') {
                const s = Math.sin(t * (8 + 8 * (d.cur ?? 0))), a = 10 + 6 * (d.cur ?? 0);
                arm(lx, shY, lx - 12, shY - a * s); arm(rx, shY, rx + 12, shY + a * s);
            } else {   // arms crossed, judging you
                arm(lx, shY, x + w * 0.7, shY + 6); arm(rx, shY, x + w * 0.3, shY + 8);
            }
            break;
        }
        case 'party':
        case 'cake': {
            // holding up a cake with flickering candles; confetti falls
            const cy = shY - 4;
            arm(lx, shY, dir * 10 - 8, cy); arm(rx, shY, dir * 10 + 8, cy);
            cr.setSourceRGBA(0.98, 0.85, 0.7, 1); rr(cr, dir * 10 - 11, cy - 10, 22, 10, 2); cr.fill();
            cr.setSourceRGBA(1, 0.55, 0.7, 1); rr(cr, dir * 10 - 11, cy - 11, 22, 3, 1.5); cr.fill();
            for (const cxk of [-6, 0, 6]) {
                cr.setSourceRGBA(0.6, 0.8, 1, 1); cr.rectangle(dir * 10 + cxk - 0.8, cy - 17, 1.6, 6); cr.fill();
                if (m === 'party' && b.party?.blown) {   // blown out: a wisp of smoke
                    cr.setSourceRGBA(0.75, 0.77, 0.8, 0.6); cr.setLineWidth(1); cr.moveTo(dir * 10 + cxk, cy - 18);
                    cr.curveTo(dir * 10 + cxk + 2, cy - 21, dir * 10 + cxk - 2, cy - 24, dir * 10 + cxk + 1, cy - 27); cr.stroke();
                } else {
                    cr.setSourceRGBA(1, 0.7 + Math.random() * 0.3, 0.2, 1); cr.newSubPath(); cr.arc(dir * 10 + cxk, cy - 19, 1.6, 0, 2 * Math.PI); cr.fill();
                }
            }
            for (let k = 0; k < 10; k++) {
                const q = (t * 0.6 + k / 10) % 1, cc = [[1, 0.4, 0.5], [0.4, 0.8, 1], [1, 0.85, 0.3], [0.6, 1, 0.5]][k % 4];
                cr.setSourceRGBA(cc[0], cc[1], cc[2], 1 - q); cr.rectangle(-50 + k * 11 + Math.sin(q * 8 + k) * 4, -140 + q * 140, 2.5, 2.5); cr.fill();
            }
            break;
        }
        case 'raindance': {
            const s = Math.sin(t * 9);
            arm(lx, shY, lx - 12, shY - 14 * s); arm(rx, shY, rx + 12, shY + 14 * s);
            cr.setSourceRGBA(0.8, 0.82, 0.88, 0.95);   // its own little cloud
            for (const [ox, r] of [[-10, 8], [0, 11], [11, 8]]) { cr.newSubPath(); cr.arc(ox, y - 30, r, 0, 2 * Math.PI); cr.fill(); }
            cr.setSourceRGBA(0.5, 0.75, 1, 0.8);
            for (let k = 0; k < 5; k++) { const q = (t * 2 + k / 5) % 1; cr.newSubPath(); cr.arc(-12 + k * 6, y - 20 + q * 22, 1, 0, 2 * Math.PI); cr.fill(); }
            break;
        }
        case 'bugchase': {
            const g = b.bug ?? {k: 0}, swipe = g.k > 4.6 && g.k < 5.2;
            const nx = swipe ? dir * (w / 2 + 6) : dir * (w / 2 + 14), ny = swipe ? fy - 6 : y + 4;
            arm(lx, shY, lx - 3, shY + 14); arm(rx, shY, nx, ny);
            cr.setSourceRGBA(0.45, 0.32, 0.18, 1); cr.setLineWidth(1.6); cr.moveTo(nx, ny); cr.lineTo(nx + dir * 14, ny + (swipe ? 4 : -10)); cr.stroke();
            cr.setSourceRGBA(1, 1, 1, 0.5); cr.newSubPath(); cr.arc(nx + dir * 18, ny + (swipe ? 6 : -13), 5, 0, 2 * Math.PI); cr.fill();
            if (g.k < 5.2 || g.caught === false) {   // the bug, scurrying ahead (or flying off)
                const bxb = dir * (40 + Math.sin(t * 5) * 6) + (g.k > 5.2 ? dir * (g.k - 5.2) * 60 : 0);
                const byb = g.k > 5.2 ? fy - 3 - (g.k - 5.2) * 40 : fy - 3;
                cr.setSourceRGBA(0.2, 0.6, 0.25, 1); cr.newSubPath(); cr.arc(bxb, byb, 2.4, 0, 2 * Math.PI); cr.fill();
                cr.setSourceRGBA(0.1, 0.1, 0.1, 1); cr.setLineWidth(0.6);
                for (const s of [-1, 1]) { cr.moveTo(bxb, byb); cr.lineTo(bxb + s * 3, byb + 2 + Math.sin(t * 30) * 1); cr.stroke(); }
            }
            break;
        }
        case 'wallrun': {
            const pump = Math.sin(t * 16) * 8;
            arm(lx, shY, lx - 6 + pump, shY + 10); arm(rx, shY, rx + 6 - pump, shY + 10); break;
        }
        case 'mirror': {
            // arms copy how high your pointer is
            const [, py] = global.get_pointer();
            const lift = Math.max(-1, Math.min(1, (b.y - 40 * S - py) / 200));
            arm(lx, shY, lx - 10, shY + 12 - lift * 26); arm(rx, shY, rx + 10, shY + 12 - lift * 26);
            break;
        }
        case 'juggle': {
            // A three-ball cascade: one throw per beat, alternating hands; each
            // ball flies two beats from the inside of one hand to the outside
            // of the other, then is carried one beat in a scoop to the throw
            // point, so the balls trace a figure 8 and the hands really catch.
            const beat = 0.3, p = t / beat, handY = shY + 6, H = 52, IN = 8, OUT = 22;   // arcs clear its head
            const cols = [[1, 0.45, 0.35], [0.4, 0.8, 1], [1, 0.85, 0.3]];
            const hands = {[-1]: null, [1]: null};
            const balls = [];
            for (let i = 0; i < 3; i++) {
                const rel = p - i, n = Math.floor(rel / 3) * 3 + i, local = rel - Math.floor(rel / 3) * 3;
                const side = ((n % 2) + 2) % 2 === 0 ? -1 : 1;   // the hand that threw it
                let bx, by;
                if (local < 2) {
                    const q = local / 2;
                    bx = side * IN + (-side * OUT - side * IN) * q; by = handY - 4 * H * q * (1 - q);
                } else {
                    const q = local - 2, hs = -side;   // held by the catching hand, scooped inwards
                    bx = hs * OUT + (hs * IN - hs * OUT) * q; by = handY + Math.sin(Math.PI * q) * 5;
                    hands[hs] = [bx, by];
                }
                balls.push([bx, by, cols[i]]);
            }
            if (b.dropBall && b.actT < JUGGLE_DROP_S) {
                // the miss: it holds two balls while the third comes down on its head and bounces off
                const q = 1 - b.actT / JUGGLE_DROP_S, top = y - 3.5;
                hands[-1] = [-IN - 4, handY]; hands[1] = [IN + 4, handY];
                balls[1][0] = hands[-1][0]; balls[1][1] = handY - 4; balls[2][0] = hands[1][0]; balls[2][1] = handY - 4;
                if (q < 0.6) {   // up high, then straight down onto its head
                    const k = q / 0.6;
                    const p0 = [0, handY - 6], p1 = [0, y - 95], u = 1 - k;   // a too-high throw from between its hands
                    balls[0][0] = 0; balls[0][1] = u * u * p0[1] + 2 * k * u * p1[1] + k * k * top;
                } else {         // bounced off to the side and down to the floor
                    const k = (q - 0.6) / 0.4;
                    balls[0][0] = dir * 30 * k; balls[0][1] = top + (fy - 3.5 - top) * k - Math.sin(Math.PI * k) * 14;
                }
                if (q >= 0.6 && q < 0.85) {   // little stars where it hit
                    cr.setSourceRGBA(1, 0.85, 0.3, 1);
                    for (let k = 0; k < 3; k++) { const a = t * 6 + k * 2.1; cr.newSubPath(); cr.arc(Math.cos(a) * 12, y - 6 + Math.sin(a) * 3, 1.6, 0, 2 * Math.PI); cr.fill(); }
                }
            }
            for (const hs of [-1, 1]) {
                if (!hands[hs]) {   // empty: swinging back out from the throw to the catch point
                    const q = p - Math.floor(p);
                    hands[hs] = [hs * IN + (hs * OUT - hs * IN) * q, handY - Math.sin(Math.PI * q) * 3];
                }
            }
            arm(lx, shY, hands[-1][0], hands[-1][1] + 3); arm(rx, shY, hands[1][0], hands[1][1] + 3);
            for (const [bx, by, c] of balls) { cr.setSourceRGBA(c[0], c[1], c[2], 1); cr.newSubPath(); cr.arc(bx, by, 3.5, 0, 2 * Math.PI); cr.fill(); }
            break;
        }
        case 'guitar': {
            // a little guitar slung across, strumming hand, fretting hand
            const strum = Math.sin(t * 22) * 4, gy = y + h * 0.78;
            cr.save(); cr.translate(-dir * 2, gy); cr.rotate(-dir * 0.5);
            cr.setSourceRGBA(0.85, 0.3, 0.25, 1); cr.save(); cr.scale(1.3, 1); cr.newSubPath(); cr.arc(0, 0, 8, 0, 2 * Math.PI); cr.restore(); cr.fill();
            cr.setSourceRGBA(0.15, 0.1, 0.08, 1); cr.newSubPath(); cr.arc(0, 0, 2.5, 0, 2 * Math.PI); cr.fill();
            cr.setSourceRGBA(0.45, 0.3, 0.18, 1); rr(cr, 8 * dir > 0 ? 8 : -30, -1.8, 22, 3.6, 1); cr.fill();
            cr.restore();
            arm(lx, shY, dir > 0 ? -4 : 4, gy + strum * 0.5); arm(rx, shY, dir * 22, gy - 10);
            break;
        }
        case 'bedtime': {
            if (b.actT > 4) {   // brushing teeth
                const k = Math.sin(t * 18) * 3, my = y + 6 + h * 0.62 * 0.8;
                arm(lx, shY, lx - 3, shY + 15); arm(rx, shY, 6 + k, my);
                cr.setSourceRGBA(0.3, 0.75, 1, 1); rr(cr, 6 + k, my - 1, 9, 2.5, 1); cr.fill();
                cr.setSourceRGBA(1, 1, 1, 0.9);
                for (let i = 0; i < 3; i++) { cr.newSubPath(); cr.arc(2 + i * 3, my + 2 + Math.sin(t * 9 + i) * 1.5, 1.4, 0, 2 * Math.PI); cr.fill(); }
            } else if (b.actT > 2) {   // pyjamas on, a big stretch
                arm(lx, shY, lx - 6, y - 16); arm(rx, shY, rx + 6, y - 16);
            } else {   // pulling up the blanket
                arm(lx, shY, -6, shY + 4); arm(rx, shY, 6, shY + 4);
            }
            break;
        }
        case 'typing': {
            const ky = y + h * 0.9, fast = (this._typeScore ?? 0) >= 8;
            const hacker = Date.now() - (b.typingSince ?? Date.now()) > 20000;
            const onFire = b.fastSince && Date.now() - b.fastSince > 3000;
            if (hacker) {
                // green code raining down around it
                cr.selectFontFace('Monospace', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD); cr.setFontSize(7);
                const glyphs = '01アイウエカキ{}<>/';
                for (let col = 0; col < 9; col++) {
                    const cx2 = -64 + col * 16, speed = 18 + (col * 7) % 13;
                    for (let k = 0; k < 4; k++) {
                        const yy = -130 + ((t * speed + col * 23 + k * 11) % 130);
                        cr.setSourceRGBA(0.3, 1, 0.45, 0.15 + 0.2 * (k / 3));
                        cr.moveTo(cx2, yy); cr.showText(glyphs[(Math.floor(t * 4) + col + k * 3) % glyphs.length]);
                    }
                }
            }
            cr.setSourceRGBA(0.25, 0.27, 0.32, 1);
            cr.moveTo(-13, ky - 1); cr.lineTo(13, ky - 1); cr.lineTo(9, ky - 15); cr.lineTo(-9, ky - 15); cr.closePath(); cr.fill();   // lid
            const scr = hacker ? [0.3, 1, 0.45] : [0.49, 0.94, 0.83];
            cr.setSourceRGBA(scr[0], scr[1], scr[2], 0.35); cr.moveTo(-10, ky - 3); cr.lineTo(10, ky - 3); cr.lineTo(7, ky - 13); cr.lineTo(-7, ky - 13); cr.closePath(); cr.fill();
            cr.setSourceRGBA(scr[0], scr[1], scr[2], 0.8); cr.setLineWidth(0.8);
            for (let k = 0; k < 3; k++) { const len = 4 + ((Math.floor(t * 3) + k * 5) % 9); cr.moveTo(-6, ky - 11 + k * 3); cr.lineTo(-6 + len, ky - 11 + k * 3); }
            cr.stroke();
            cr.setSourceRGBA(0.35, 0.37, 0.43, 1); rr(cr, -16, ky - 1, 32, 4, 1.5); cr.fill();   // keyboard base
            const speed = fast ? 26 : 16;
            const tl = Math.max(0, Math.sin(t * speed)) * 3, tr = Math.max(0, Math.sin(t * speed + Math.PI)) * 3;
            arm(lx, shY, -7, ky - 1 - tl); arm(rx, shY, 7, ky - 1 - tr);
            if (onFire) {
                // flames licking up off the keys
                for (let k = 0; k < 5; k++) {
                    const fx = -12 + k * 6, fh = 6 + Math.abs(Math.sin(t * 15 + k * 1.7)) * 9;
                    cr.setSourceRGBA(1, 0.35 + 0.3 * Math.abs(Math.sin(t * 9 + k)), 0.1, 0.85);
                    cr.moveTo(fx - 3, ky - 1); cr.curveTo(fx - 3, ky - fh * 0.6, fx, ky - fh * 0.8, fx, ky - fh);
                    cr.curveTo(fx, ky - fh * 0.8, fx + 3, ky - fh * 0.6, fx + 3, ky - 1); cr.closePath(); cr.fill();
                }
            } else if (fast) {
                cr.setSourceRGBA(1, 0.85, 0.3, 0.9);
                for (let k = 0; k < 3; k++) {
                    const q = (t * 2 + k / 3) % 1;
                    cr.newSubPath(); cr.arc(-10 + k * 10 + Math.sin(q * 9) * 3, ky - 4 - q * 14, 1.2, 0, 2 * Math.PI); cr.fill();
                }
            }
            break;
        }
        case 'shoot': {
            const kick = b.fired ? Math.max(0, b.actT - 0.75) * 0.9 : 0;   // recoil just after firing
            const gx = dir * (w / 2 + 14), gy = shY - 2 - kick * 8;
            arm(lx, shY, dir > 0 ? gx - 6 : gx + 6, gy + 2); arm(rx, shY, gx, gy);
            cr.save(); cr.translate(gx, gy); cr.rotate(-dir * kick); cr.scale(dir, 1);
            cr.setSourceRGBA(0.2, 0.21, 0.25, 1); rr(cr, -2, -4, 14, 5, 1.5); cr.fill();   // slide and barrel
            rr(cr, -2, -1, 5, 8, 1.5); cr.fill();                                          // grip
            rgb(cr, C.teal); cr.rectangle(0, -3, 8, 1); cr.fill();
            if (b.fired && !b.bangFlag && b.actT > 0.95) {                                // muzzle flash
                cr.setSourceRGBA(1, 0.85, 0.3, 0.95); cr.newSubPath(); cr.arc(15, -1.5, 4, 0, 2 * Math.PI); cr.fill();
            }
            if (b.bangFlag) {                                                              // the joke flag
                cr.setSourceRGBA(0.5, 0.5, 0.55, 1); cr.setLineWidth(1); cr.moveTo(12, -1.5); cr.lineTo(20, -1.5); cr.lineTo(20, -14); cr.stroke();
                cr.setSourceRGBA(1, 1, 1, 1); cr.rectangle(20, -14, 22, 9); cr.fill();
                cr.setSourceRGBA(0.85, 0.15, 0.2, 1); cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
                cr.setFontSize(6); cr.moveTo(21.5, -7.5); cr.showText('BANG!');
            }
            cr.restore();
            break;
        }
        case 'watchingyou': {
            // The gesture is made beside its head, not over its dark face, so
            // the two fingers stand out against whatever is behind it.
            const ph = b.wy?.phase ?? 'scene', el = ph === 'scene' ? (b.wy?.t ?? 0) : 99, eyeY = y + 6 + h * 0.62 * 0.42;
            const fs = dir, fx0 = fs > 0 ? rx : lx, bx0 = fs > 0 ? lx : rx;   // front (gesturing) arm, other arm
            b.wyPoint = false;
            const toEyes = () => {   // a V under its eyes: one fingertip right at each eye
                arm(bx0, shY, bx0 - fs * 9, shY + 10);
                const hx2 = 0, hy2 = eyeY + 18;
                arm(fx0, shY, hx2 + fs * 4, hy2 + 3);
                b._prop = {kind: 'vfingers', base: [hx2, hy2], rot: 0, spread: 0.62, flen: 19};   // a fingertip at each eye, long enough to read
            };
            if (el < WATCH.in) {   // stomping: arms swinging stiffly
                const s2 = Math.sin(el / 0.4 * Math.PI) * 5;
                arm(lx, shY, lx - 3 + s2, shY + 15); arm(rx, shY, rx + 3 - s2, shY + 15);
                b._prop = null;
            } else if (el < WATCH.stare) {   // stops dead, hands on hips, staring
                arm(lx, shY, lx - 9, shY + 10); arm(rx, shY, rx + 9, shY + 10);
                b._prop = null;
            } else if (el < WATCH.gesture && ((el - WATCH.eyes) % WATCH_CYCLE) / WATCH_CYCLE < 0.45) {
                toEyes();
            } else if (el < WATCH.gesture) {
                // points straight out of the screen at you: the glove front-on, close and big
                b.wyPoint = true;
                arm(bx0, shY, bx0 - fs * 9, shY + 10);
                // The 🫵 emoji (index finger at the viewer) held out beside its
                // face. The user tried several drawn hands, front-on and in
                // profile, and picked the emoji: none of the drawings read as
                // pointing at them (16 Nov 2026).
                const c2 = ((el - WATCH.eyes) % WATCH_CYCLE) / WATCH_CYCLE;
                const k = Math.min(1, Math.max(0, (c2 - 0.45) / 0.18));
                const hx2 = fx0 + fs * (6 + 6 * k), hy2 = shY - 4;
                arm(fx0, shY, hx2, hy2 + 4);
                b._prop = {kind: 'vfingers', front: true, base: [hx2, hy2], k};
            } else if (ph === 'off' && (b.wy.pt % 1.4) < 0.6) {   // backing out: two fingers back to its eyes now and then
                toEyes();
            } else if (ph === 'peek') {
                // Peeking back in: one last two-finger flick to its eyes once the
                // lean has brought its face on screen (the lean takes 0.35 s),
                // hands on hips either side of it (user asked, 16 Nov 2026).
                if (b.wy.pt > 0.45 && b.wy.pt < 1.25) toEyes();
                else { arm(lx, shY, lx - 9, shY + 10); arm(rx, shY, rx + 9, shY + 10); b._prop = null; }
            } else {   // walking off, peeking or coming back: stiff arm swing
                const s2 = Math.sin((b.dist ?? 0) / S / 6) * 5;
                arm(lx, shY, lx - 3 + s2, shY + 15); arm(rx, shY, rx + 3 - s2, shY + 15);
                b._prop = null;
            }
            break;
        }
        case 'movie': {
            const mv = b.movie ?? {};
            if (mv.phase !== 'watch') {
                if (mv.phase === 'out' && mv.long && mv.outT > 2.4) { arm(lx, shY, lx - 6, y - 14); arm(rx, shY, rx + 6, y - 14); }   // a big stretch
                else if (mv.phase === 'out' && mv.long && mv.outT > 1.6) {   // picking up the empties beside the sofa
                    const s = Math.abs(Math.sin(t * 9)) * 6;
                    arm(lx, shY, lx - 2, shY + 15); arm(rx, shY, rx + 16, fy - 4 - s);
                } else if (mv.phase === 'out' && mv.outT > 0.8) {   // brushing off the crumbs
                    const s = Math.sin(t * 16) * 7;
                    arm(lx, shY, x + w * 0.35 + s, y + h * 0.72); arm(rx, shY, x + w * 0.65 - s, y + h * 0.6);
                } else { arm(lx, shY, lx - 3, shY + 15); arm(rx, shY, rx + 3, shY + 15); }
                b._prop = null;
                break;
            }
            const bagX = x + w * 0.27, bagY = y + h + 5;   // low in its lap, clear of its face
            const mouthX = dir * 4, mouthY = y + 6 + h * 0.62 * 0.82;
            const restX = rx + 5, restY = shY + 12;
            let hx = restX, hy = restY, chip = false, crunch = false, sip = false;
            const r = mv.react;
            if (mv.doze) {
                arm(lx, shY, lx - 2, shY + 16); arm(rx, shY, rx + 2, shY + 16);
                b._prop = {kind: 'snack', bagX: bagX + 4, bagY: bagY + 2, tipped: true, pull: true};
                break;
            }
            const eyeY = y + 6 + h * 0.62 * 0.42;
            const snack = extra => { b._prop = {kind: 'snack', bagX, bagY, ...extra}; };
            if (mv.away) {   // walking: arms swing, the popcorn waits on the seat
                const s = Math.sin(t * 12) * 4 * dir;
                arm(lx, shY, lx - 3 + s, shY + 15); arm(rx, shY, rx + 3 - s, shY + 15);
                b._prop = {kind: 'snack', away: true, milk: mv.away.t > 7 && mv.away.kind === 'fridge', hx: rx + 4, hy: shY + 14};
                break;
            }
            const sway = Math.sin(t * 9);
            const poses = {
                stretch: () => { arm(lx, shY, lx - 6, y - 14); arm(rx, shY, rx + 6, y - 14); },
                rub: () => { arm(lx, shY, -9 + sway * 2, eyeY + 2); arm(rx, shY, 9 - sway * 2, eyeY + 2); },
                squint: () => { arm(lx, shY, bagX - 8, bagY - 8); arm(rx, shY, dir * 4, eyeY - 7); },   // hand shading its eyes
                action: () => { arm(lx, shY, lx + 3, shY - 9 + sway * 2); arm(rx, shY, rx - 3, shY - 9 - sway * 2); },   // fists up
                grit: () => { arm(lx, shY, lx + 5, shY + 5); arm(rx, shY, rx - 5, shY + 5); },
                cold: () => { arm(lx, shY, -5, shY + 3); arm(rx, shY, 5, shY + 3); },   // hugging the blanket up to its chin
                heart: () => { arm(lx, shY, bagX - 8, bagY - 8); arm(rx, shY, -dir * 2, shY + 7); },
                calm: () => { arm(lx, shY, lx + 3, y - 2); arm(rx, shY, rx - 3, y - 2); },   // hands behind its head
                bored: () => { arm(lx, shY, bagX - 8, bagY - 8); arm(rx, shY, bagX + 7, bagY - 17); },   // peering into the bucket
                clap: () => { const c = Math.abs(Math.sin(t * 14)) * 5; arm(lx, shY, -c - 1, shY + 3); arm(rx, shY, c + 1, shY + 3); },
                cramp: () => { arm(lx, shY, bagX - 8, bagY - 8); arm(rx, shY, x + w * 0.72 + sway * 3, y + h + 5); },
                phone: () => { arm(lx, shY, dir * 2 - 4, y + h * 0.72); arm(rx, shY, dir * 2 + 4, y + h * 0.72); },
                dig: () => {
                    const found = t - r.at > 2.6;
                    arm(lx, shY, bagX - 8, bagY - 8);
                    if (found) arm(rx, shY, rx + 4, shY - 3);
                    else arm(rx, shY, rx + 13, y + h + 3 + Math.abs(sway) * 3);
                },
            };
            if (r && poses[r.kind]) {
                poses[r.kind]();
                snack({phone: r.kind === 'phone' ? [dir * 2, y + h * 0.72] : null, item: r.kind === 'dig' && t - r.at > 2.6 ? [r.item, rx + 4, shY - 4] : null, pull: r.kind === 'cold'});
                break;
            }
            if (r?.kind === 'hide') {   // both hands over its eyes, bag left in its lap
                arm(lx, shY, -9, eyeY + 2); arm(rx, shY, 9, eyeY + 2);
                b._prop = {kind: 'snack', bagX, bagY: bagY + 2};
                break;
            }
            if (r?.kind === 'open') {   // both hands at its chest, twisting the cap off
                const bx = dir * 6, by = y + h * 0.72;
                arm(lx, shY, bx - 4, by - 4); arm(rx, shY, bx + 1, by - 16);
                b._prop = {kind: 'snack', bagX, bagY, beerAt: [bx, by], fizz: Math.max(0, 1 - (t - r.at) / 1.4), capT: t - r.at};
                break;
            }
            if (mv.paused) { hx = rx + 3; hy = shY - 4; chip = true; }   // frozen mid-kernel
            else if (r?.kind === 'sniffle') { hx = 10; hy = eyeY + 5; }   // wiping an eye
            else if (r?.kind === 'shh') {   // finger to its mouth
                arm(lx, shY, bagX - 8, bagY - 8); arm(rx, shY, mouthX + 1, mouthY + 4);
                rgb(cr, C.hand); cr.setLineWidth(2.2); cr.moveTo(mouthX + 1, mouthY + 3); cr.lineTo(mouthX + 1, mouthY - 5); cr.stroke();
                b._prop = {kind: 'snack', bagX, bagY};
                break;
            }
            else if (r?.kind === 'sip') { hx = mouthX + 2; hy = mouthY + 2; sip = true; }
            else if (r?.kind === 'laugh') { hx = x + w * 0.7; hy = y + h * 0.75; }   // holding its belly
            else if (r?.kind === 'gasp') { hx = mouthX + 3; hy = mouthY + 1; }   // hand to its mouth
            else {
                const p = (t - (mv.munchAt ?? -9)) / 1.4;
                const lerp = (a, c, k) => a + (c - a) * Math.max(0, Math.min(1, k));
                if (p < 0.25) { hx = lerp(restX, bagX + 3, p / 0.25); hy = lerp(restY, bagY - 15, p / 0.25); }
                else if (p < 0.55) { hx = lerp(bagX + 3, mouthX + 3, (p - 0.25) / 0.3); hy = lerp(bagY - 15, mouthY + 1, (p - 0.25) / 0.3); chip = true; }
                else if (p < 0.8) { hx = mouthX + 3; hy = mouthY + 1; crunch = true; }
                else if (p < 1) { hx = lerp(mouthX + 3, restX, (p - 0.8) / 0.2); hy = lerp(mouthY + 1, restY, (p - 0.8) / 0.2); }
            }
            arm(lx, shY, bagX - 8, bagY - 8); arm(rx, shY, hx, hy);
            b._prop = {kind: 'snack', bagX, bagY, hx, hy, chip, crunch, sip, crunchT: t - (mv.munchAt ?? 0)};
            break;
        }
        case 'banana': {
            const bite = Math.sin(t * 2.2) > 0.3;
            const hx = bite ? x + w * 0.62 : rx + 5, hy = bite ? y + 6 + h * 0.62 * 0.82 : shY + 9;
            arm(lx, shY, lx - 4, shY + 14); arm(rx, shY, hx, hy);
            b._prop = {kind: 'banana', x: hx, y: hy, left: Math.max(0.15, b.actT / 4.5), bite};
            break;
        }
        case 'smoke': {
            const puff = Math.sin(t * 0.9) > 0.3;
            const hx = puff ? x + w * 0.66 : rx + 5, hy = puff ? y + 6 + h * 0.62 * 0.8 : shY + 11;
            arm(lx, shY, lx - 4, fy - 6); arm(rx, shY, hx, hy);
            b._prop = {kind: 'cig', x: hx, y: hy, puff};
            break;
        }
        case 'boing': case 'acrobat': case 'trampoline': case 'teleport': case 'clones': case 'army': case 'disco': case 'dizzydance': {
            const s = Math.sin(t * 9);
            arm(lx, shY, lx - 12, shY - 14 * s); arm(rx, shY, rx + 12, shY + 14 * s); break;
        }
        case 'held': { const s = Math.sin(t * 16) * 5; arm(lx, shY, lx - 8 + s, y - 10); arm(rx, shY, rx + 8 - s, y - 10); break; }
        case 'jetfail': case 'ghost':
        case 'fly': arm(lx, shY, lx - 16, shY - 4 + Math.sin(t * 12) * 3); arm(rx, shY, rx + 16, shY - 4 - Math.sin(t * 12) * 3); break;
        case 'duck': arm(lx, shY, lx - 4, fy - 10); arm(rx, shY, rx + 4, fy - 10); break;
        case 'fall': case 'jump': case 'poked': arm(lx, shY, lx - 12, shY - 14); arm(rx, shY, rx + 12, shY - 14); break;
        case 'wake': arm(lx, shY, lx - 6, y - 16); arm(rx, shY, rx + 6, y - 16); break;
        case 'dance': { const s = Math.sin(t * 9); arm(lx, shY, lx - 12, shY - 14 * s); arm(rx, shY, rx + 12, shY + 14 * s); break; }
        case 'wave': { const s = Math.sin(t * 14) * 6; arm(lx, shY, lx - 3, shY + 16); arm(rx, shY, rx + 10 + s, y - 12); break; }
        case 'dizzy': { const s = Math.sin(t * 20) * 10; arm(lx, shY, lx - 12, shY + s); arm(rx, shY, rx + 12, shY - s); break; }
        case 'sleep': case 'meeting': arm(lx, shY, lx + 6, shY + 14); arm(rx, shY, rx - 6, shY + 14); break;
        case 'sit': arm(lx, shY, lx - 6, fy - 6); arm(rx, shY, rx + 6, fy - 6); break;
        case 'broken': break;  // arms are off
        case 'stretched': case 'snapback':
            for (const key of ['armL', 'armR']) {
                const L = LIMBS[key];
                if (b.limb?.key === key) this._rubberLimb(cr, L, b.limb.tip, b.limb.rest);
                else arm(L.base[0], L.base[1], L.rest[0], L.rest[1]);
            }
            break;
        case 'chute': {   // hands on the toggles: one pulled down to turn, both for the flare
            const fl = (b.chuteFlare ?? 0) * 16, st = b.chuteSteer ?? 0;
            arm(lx, shY, lx - 4, y - 14 + Math.max(0, -st) * 12 + fl); arm(rx, shY, rx + 4, y - 14 + Math.max(0, st) * 12 + fl); break;
        }
        case 'emerge': {
            const gy = -(b.rise ?? 0) * (BH + 24) - 2, g = Math.sin(t * 8) * 2;
            arm(lx, shY, lx - 10, gy + g); arm(rx, shY, rx + 10, gy - g); break;
        }
        case 'tease': arm(lx, shY, lx - 9, shY + 10); arm(rx, shY, rx + 9, shY + 10); break;  // hands on hips
        case 'focus': arm(lx, shY, lx + 6, shY + 14); arm(rx, shY, rx - 6, shY + 14); break;
        case 'timer': {   // hands busy at the build site, faster as it panics
            const job = this._timer?.job?.kind;
            if (job === 'look') { arm(lx, shY, lx - 9, shY + 10); arm(rx, shY, rx + 9, shY + 10); break; }   // hands on hips, admiring
            if (job === 'pick') { arm(lx, shY, lx - 4, fy - 8); arm(rx, shY, rx + 4, fy - 8); break; }   // reaching down to the pile
            if (job === 'wipe') { arm(lx, shY, lx - 4, shY + 14); arm(rx, shY, x + w * 0.75 + Math.sin(t * 10) * 3, y + 4); break; }   // wiping its brow
            const sp = [1, 1.3, 1.8, 2.6][this._timer?.level ?? 0], s2 = Math.sin(t * 5 * sp);
            arm(lx, shY, lx - 8, shY + 8 + 6 * s2); arm(rx, shY, rx + 10, shY + 6 - 6 * s2); break;
        }
        case 'timerdone': { const s2 = Math.sin(t * 14); arm(lx, shY, lx - 14, shY - 10 - 8 * s2); arm(rx, shY, rx + 14, shY - 10 - 8 * s2); break; }   // flapping
        case 'watch': {
            // looks at a watch on the left wrist and taps it
            const tap = Math.sin(t * 14) * 2;
            arm(lx, shY, x + w * 0.25, shY - 4); arm(rx, shY, x + w * 0.32, shY - 8 + tap); break;
        }
        case 'alert': arm(lx, shY, lx - 9, shY + 10); arm(rx, shY, rx + 9, shY + 10); break;
        case 'coffee': {
            // sips now and then; the cup goes to its mouth
            const sip = Math.sin(t * 1.8) > 0.4;
            const hx = sip ? x + w * 0.62 : rx + 6, hy = sip ? y + 6 + h * 0.62 * 0.85 : shY + 10;
            arm(lx, shY, lx - 4, fy - 6); arm(rx, shY, hx, hy);
            b._prop = {kind: 'cup', x: hx, y: hy, sip};
            break;
        }
        case 'book': {
            const by2 = y + h * 0.8;
            arm(lx, shY, -9, by2); arm(rx, shY, 9, by2);
            b._prop = {kind: 'book', x: 0, y: by2, page: Math.sin(t * 0.8) > 0.9};
            break;
        }
        case 'polish': {
            const px2 = 4 + Math.cos(t * 8) * 7, py2 = y + 6 + h * 0.62 * 0.5 + Math.sin(t * 8) * 5;
            arm(lx, shY, lx - 3, shY + 15); arm(rx, shY, px2, py2);
            b._prop = {kind: 'cloth', x: px2, y: py2};
            break;
        }
        case 'doze': arm(lx, shY, lx + 6, shY + 14); arm(rx, shY, rx - 6, shY + 14); break;
        case 'phones': {
            const k = Math.sin(t * 6) * 2;
            arm(lx, shY, x - 3, y + h * 0.36 + k); arm(rx, shY, x + w + 3, y + h * 0.36 - k); break;
        }
        case 'cry': {
            // rubbing its eyes
            const eyeY = y + 6 + h * 0.62 * 0.42, r = Math.sin(t * 12) * 2;
            arm(lx, shY, x + 9 + r, eyeY + 3); arm(rx, shY, x + w - 9 - r, eyeY + 3); break;
        }
        case 'shy': {
            // hands at the cheeks, half hiding the face
            const cheekY = y + 6 + h * 0.62 * 0.7;
            arm(lx, shY, x + 6, cheekY); arm(rx, shY, x + w - 6, cheekY); break;
        }
        case 'laugh': arm(lx, shY, x + 8, y + h * 0.72); arm(rx, shY, x + w - 8, y + h * 0.72); break;  // holding its belly
        case 'angry': arm(lx, shY, lx - 9, shY + 10); arm(rx, shY, rx + 9, shY + 10); break;
        case 'deliver': {   // the Done ticket in its front hand (see _startDelivery)
            const p = this._dv?.pose;
            const front = dir > 0 ? rx : lx, back = dir > 0 ? lx : rx;
            const sw = dvWalk ? Math.sin(ph) * 4 * dir : 0;
            if (p?.backT !== null && p?.backT !== undefined) arm(back, shY, dir * p.backT, y + 8);   // wiping its brow
            else arm(back, shY, back - dir * 3 + sw, shY + 13);
            if (!p || (!p.holding && p.armA === null)) { arm(front, shY, front + dir * 3 - sw, shY + 15); break; }
            const a = (p.armA ?? 12) * Math.PI / 180;
            const ex = front + dir * 15 * Math.cos(a), ey = shY + 15 * Math.sin(a);
            rgb(cr, C.limb); cr.setLineWidth(5); cr.moveTo(front, shY); cr.lineTo(ex, ey); cr.stroke();
            if (p.holding) {
                cr.save(); cr.translate(ex + dir, ey - 3);
                if (dvWalk) cr.rotate(Math.sin(ph * 2) * 0.05);   // swings a little with each step
                const cw = this._dv.cw;
                if (p.plane) {   // folded into a paper plane
                    cr.setSourceRGBA(1, 1, 1, 1);
                    cr.moveTo(0, -9); cr.lineTo(dir * 30, -3); cr.lineTo(0, 3); cr.closePath(); cr.fill();
                    cr.setSourceRGBA(0.6, 0.62, 0.68, 1); cr.setLineWidth(0.8); cr.moveTo(0, -3); cr.lineTo(dir * 30, -3); cr.stroke();
                } else {
                    const cx0 = dir > 0 ? 0 : -cw;
                    cr.setSourceRGBA(1, 1, 1, 1); rr(cr, cx0, -9, cw, 14, 2.5); cr.fill();
                    cr.setSourceRGBA(0, 0, 0, 0.25); cr.setLineWidth(0.6); rr(cr, cx0, -9, cw, 14, 2.5); cr.stroke();
                    cr.setSourceRGBA(0.13, 0.13, 0.13, 1);
                    cr.selectFontFace('Monospace', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD); cr.setFontSize(8.5);
                    cr.moveTo(cx0 + 4, 1.5); cr.showText(this._dv.key);
                }
                cr.restore();
            }
            rgb(cr, C.hand); cr.newSubPath(); cr.arc(ex, ey, 4, 0, 2 * Math.PI); cr.fill();
            if (p.sweat) {   // a drop running down the back of its head
                cr.setSourceRGBA(0.55, 0.8, 1, 0.9); cr.newSubPath();
                cr.arc(-dir * (w / 2 + 3), y + 2 + (t * 14) % 12, 2.2, 0, 2 * Math.PI); cr.fill();
            }
            break;
        }
        case 'love': arm(lx, shY, -3, y + h * 0.66); arm(rx, shY, 3, y + h * 0.66); break;  // hands clasped
        case 'tumble': { const s = Math.sin(t * 22) * 10; arm(lx, shY, lx - 12, shY - s); arm(rx, shY, rx + 12, shY + s); break; }
        default: {
            if (b.mode === 'coffeerun' && b.cr?.cup) {   // carrying the mug back, sipping once it stops
                const sip = b.cr.phase === 'sip' && (b.cr.pt % 1.6) < 0.6;
                const hx = sip ? x + w * 0.62 : rx + 6, hy = sip ? y + 6 + h * 0.62 * 0.85 : shY + 10;
                const sw = b.cr.phase === 'back' ? Math.sin(pw) * 4 * dir : 0;
                arm(lx, shY, lx - 3 + sw, shY + 15); arm(rx, shY, hx, hy);
                b._prop = {kind: 'cup', x: hx, y: hy, sip};
                break;
            }
            if (b.mode === 'coffeerun') b._prop = null;
            if (Date.now() < (b.fleeUntil ?? 0)) {   // fleeing the snake: arms flailing overhead
                const f = Math.sin(t * 22) * 7;
                arm(lx, shY, lx - 10, y - 10 + f); arm(rx, shY, rx + 10, y - 10 - f);
                break;
            }
            if (sleepwalk) {
                arm(lx, shY, dir * (w / 2 + 14), shY - 2); arm(rx, shY, dir * (w / 2 + 16), shY + 2);   // arms out in front
                break;
            }
            if (moon) {
                // moonwalk pose: one hand up by the head, the other low and loose
                arm(lx, shY, dir > 0 ? lx - 2 : lx - 10, dir > 0 ? y - 4 : shY + 14);
                arm(rx, shY, dir > 0 ? rx + 10 : rx + 2, dir > 0 ? shY + 14 : y - 4);
                break;
            }
            if (ride === 'skate') {
                const s = Math.sin(t * 3) * 3;
                arm(lx, shY, lx - 13, shY - 2 + s); arm(rx, shY, rx + 13, shY - 2 - s); break;
            }
            if (ride === 'bike') {
                arm(lx, shY, 9 * dir, -32); arm(rx, shY, 11 * dir, -32); break;
            }
            // opposite to the legs; running pumps shorter and harder
            if (backwards) {   // arms out a little for balance
                const sw = Math.sin(pw) * 2 * dir;
                arm(lx, shY, lx - 9 + sw, shY + 11); arm(rx, shY, rx + 9 - sw, shY + 11);
                break;
            }
            const sw = Math.sin(pw) * (running ? 9 : 4) * dir;
            const reach = running ? 12 : 15;
            arm(lx, shY, lx - 3 + sw, shY + reach); arm(rx, shY, rx + 3 - sw, shY + reach);
        }
        }

        // While a limb is pulled, the face shows how much it hurts.
        const FACE = {
            selfie: 'tease', laughattack: 'laugh', handstand: 'wave', slide: 'laugh', hang: 'wave', tarzan: 'wave',
            trampoline: 'dance', teleport: 'wave', clones: 'dance', army: 'dance', disco: 'dance', dizzydance: 'dizzy',
            ufo: 'held', ghost: 'poked', rebel: 'angry', stuck: 'poked', boing: 'laugh', acrobat: 'dance', jetfail: 'fly',
            peek: Math.floor(b.actT / 0.75) % 2 === 0 ? 'peekhide' : 'laugh',
            shoot: b.bangFlag ? 'laugh' : 'tease',
            typing: 'book',   // eyes down on its screen
            stay: staySit ? 'staybored' : 'waitlook',   // eyes follow your pointer; half-lids once it sits
            clean: 'polish', plane: 'tease', fish: 'book', paint: 'tease', highfive: 'laugh', pose: 'tease',
            sneeze: 'emerge', rocket: b.rocket?.lift ? 'held' : 'polish',
            gum: b.popped ? 'shy' : 'gumchew',
            juggle: b.dropHit ? 'poked' : 'dance', guitar: 'dance', snowball: 'tease', magic: b.rabbit && ['snake', 'bomb'].includes(b.magicItem) ? 'fear' : b.rabbit && b.magicItem === 'flowers' ? 'love' : 'tease', kite: 'dance', command: 'wave',
            fort: b.actT > 3 ? 'polish' : 'book', cake: 'dance', raindance: 'dance', bugchase: 'detective',
            wallrun: 'emerge', mirror: 'waitlook', tailchase: 'laugh', mimewall: 'poked', derp: 'derp',
            hiccups: b.t - (b.hicAt ?? -9) < 0.25 ? 'poked' : 'gumchew',
            bedtime: b.actT > 4 ? 'gumchew' : b.actT > 2 ? 'smoke' : 'sleep',
            drape: 'doze', edgeblanket: 'waitlook', slowwalk: 'smoke', lazydance: 'polish', coffeedrip: 'book', rocking: 'smoke',
            screensaver: 'saver', petnap: 'doze', sheep: (b.sheepN ?? 0) >= 5 ? 'doze' : 'smoke',
            pizza: (b.pizzaT ?? 0) > 2.4 ? (Math.sin(t * 1.5) > 0.3 ? 'gumchew' : 'polish') : 'look',
            pillownap: 'doze', burrito: 'waitlook', lazyfish: 'doze', lean: 'smoke', charging: 'doze', fivemore: 'smoke',
            sleepyread: (b.readK ?? 0) > 0.6 ? 'doze' : 'book', bubbles: 'polish', snore: 'doze', pool: 'smoke',
            hammock: 'doze', bellyup: 'doze', snackbed: 'doze', remote: 'remotetv', daydream: 'smoke', lazywave: 'smoke', roll: 'dizzy',
            yawnflop: b.actT > 1 ? 'wake' : 'doze',
            deliver: DELIVER_FACE[this._dv?.pose.face] ?? (dvWalk ? 'walk' : 'look'),
            watchingyou: 'stare', party: 'dance', splash: 'dance', weekend: 'dance', mime: 'waitlook',
            stretch: b.actT > 3.4 ? 'wake' : 'dance', hide: 'waitlook', nightowl: Math.sin(t * 0.7) > 0.6 ? 'wake' : 'staybored',
            lunch: Math.sin(t * 1.6) > 0.35 ? 'gumchew' : 'polish',
            danceoff: b.dof?.phase === 'me' ? 'dance' : 'waitlook',
            movie: b.movie?.doze ? 'doze' : b.movie?.away ? 'look' : b.movie?.paused ? 'look'
                : b.movie?.react?.kind === 'phone' && Math.sin(t * 1.6) > 0.75 ? 'movie'   // glancing up from the phone
                : MOVIE_FACE[b.movie?.react?.kind] ?? (b.movie?.drowsy || (b.movie?.tired && Math.sin(t * 0.5) > 0.6) ? 'smoke'
                : b._prop?.crunch ? 'gumchew' : b.movie?.phase === 'out' ? (b.movie.long && b.movie.outT > 2.4 ? 'wake' : 'polish') : 'movie'),
        };
        if (FACE[m]) m = FACE[m];
        if (m === 'walk' && Date.now() < (b.fleeUntil ?? 0)) m = 'fear';
        if (m === 'stretched') m = b.stretchFace ?? 'laugh';
        else if (m === 'snapback') m = 'poked';

        // face, eyes following the pointer while it walks, waves or watches
        const sy = y + 6, sh = h * 0.62;
        let lookX = dir * 3, lookY = 0;
        if (m === 'walk' || m === 'look' || m === 'wave' || m === 'stay' || m === 'waitlook' || m === 'staybored') {
            const [px, py] = global.get_pointer();
            lookX = Math.max(-6, Math.min(6, (px - b.x) / 60));
            lookY = Math.max(-3, Math.min(3, (py - (b.y - h * S)) / 90));
            if (backwards && (t % 2.2) < 0.7) { lookX = -dir * 6; lookY = 0; }   // glance over its shoulder, where it's going
        }
        if (m === 'movie' || (b.mode === 'movie' && m === 'look' && !b.movie?.paused)) {
            // at the video's window (found every second), else the middle of its monitor
            const mon = Main.layoutManager.monitors.find(q => b.x >= q.x && b.x < q.x + q.width) ?? Main.layoutManager.primaryMonitor;
            const tgt = this._videoRect ?? {x: mon.x + mon.width / 2, y: mon.y + mon.height / 2};
            const tdx = tgt.x - b.x, tdy = tgt.y - (b.y - h * S), td = Math.max(1, Math.hypot(tdx, tdy));
            // direction only, so a far-away screen still gets a clear sideways look
            let wx = 5.5 * tdx / td * Math.min(1, td / 300), wy = 4 * tdy / td * Math.min(1, td / 300);
            lookX = wx; lookY = wy;
        }
        if (m === 'stare') {   // straight out at you; walking off, it looks back over its shoulder
            const ph = b.wy?.phase, el = ph === 'scene' ? b.wy.t : 99;
            lookX = ph === 'off' ? b.dir * 2 : ph === 'peek' ? -b.wy.sgn * 5 : ph === 'back' ? dir * 2 : el < WATCH.in ? dir * 2 : 0; lookY = 0;
        }
        const cx = lookX, ey = sy + sh * 0.42 + lookY;
        const col = m === 'alert' || m === 'angry' ? C.alert : m === 'love' ? [1, 0.49, 0.71] : m === 'held' || m === 'dizzy' ? C.warn : (m === 'fly' || m === 'dance') ? C.happy : C.glow;
        rgb(cr, col); cr.setLineWidth(2.5);
        const tmF = this._timer;
        if (b.mode === 'timer' && tmF && !tmF.done && !tmF.gone) {
            // The countdown takes the eyes' place: amber when hurrying, red and
            // blinking in the last tenth, with a sweat drop.
            const left = Math.ceil(Math.max(0, tmF.until - Date.now()) / 1000);
            const pad = v => String(v).padStart(2, '0');
            const txt = left >= 3600 ? `${Math.floor(left / 3600)}:${pad(Math.floor(left % 3600 / 60))}` : `${Math.floor(left / 60)}:${pad(left % 60)}`;
            if (tmF.level >= 3) cr.setSourceRGBA(...C.alert, Math.floor(t * 4) % 2 ? 1 : 0.35);
            else rgb(cr, tmF.level >= 1 ? C.warn : C.glow);
            cr.selectFontFace('Monospace', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD); cr.setFontSize(txt.length > 4 ? 10 : 12);
            const ext = cr.textExtents(txt);
            cr.moveTo(x + w / 2 - ext.width / 2, sy + sh / 2 + 4); cr.showText(txt);
            if (tmF.level >= 2) {
                cr.setSourceRGBA(0.55, 0.8, 1, 0.9); cr.newSubPath();
                cr.arc(-dir * (w / 2 + 3), y + 2 + (t * 14) % 12, 2.2, 0, 2 * Math.PI); cr.fill();
            }
            rgb(cr, col);
        } else if (m === 'derp') {
            // cross-eyed with its tongue out
            for (const [ex, dx2] of [[-9, 4], [9, -4]]) { rr(cr, cx + ex - 4, ey - 6, 8, 12, 3); cr.fill(); cr.setSourceRGBA(0.02, 0.03, 0.04, 1); cr.newSubPath(); cr.arc(cx + ex + dx2 * 0.6, ey, 2, 0, 2 * Math.PI); cr.fill(); rgb(cr, col); }
            cr.setSourceRGBA(1, 0.5, 0.65, 1); rr(cr, cx - 3, sy + sh * 0.78, 6, 7 + Math.sin(t * 6), 3); cr.fill(); rgb(cr, col);
        } else if (sleepwalk) {
            for (const ex of [-9, 9]) { cr.moveTo(cx + ex - 4, ey + 2); cr.curveTo(cx + ex - 2, ey + 5, cx + ex + 2, ey + 5, cx + ex + 4, ey + 2); cr.stroke(); }
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD); cr.setFontSize(9);
            cr.moveTo(14, y - 2 - ((t * 8) % 8)); cr.showText('z');
        } else if (m.startsWith('mv_')) {
            // Movie reaction faces, each with its own eyes and mouth so they read at a glance.
            const my = sy + sh * 0.8, dark = () => cr.setSourceRGBA(0.02, 0.03, 0.04, 1);
            const chevrons = (tight = 1) => {   // > <  squeezed shut
                for (const sd of [-1, 1]) { const ex = cx + sd * 9; cr.moveTo(ex + sd * 4, ey - 4 * tight); cr.lineTo(ex - sd * 3, ey); cr.lineTo(ex + sd * 4, ey + 4 * tight); }
                cr.stroke();
            };
            const round = (r, pr2, px2 = 0, py2 = 0) => {   // big round eyes with small pupils
                for (const ex of [-9, 9]) { cr.newSubPath(); cr.arc(cx + ex, ey, r, 0, 2 * Math.PI); cr.fill(); }
                dark(); for (const ex of [-9, 9]) { cr.newSubPath(); cr.arc(cx + ex + px2, ey + py2, pr2, 0, 2 * Math.PI); cr.fill(); }
                rgb(cr, col);
            };
            const kind = m.slice(3);
            if (kind === 'squint' || kind === 'rub') {
                chevrons(kind === 'rub' ? 0.7 : 1);
                cr.moveTo(cx - 5, my); cr.lineTo(cx - 2, my - 1.5); cr.lineTo(cx + 1, my); cr.lineTo(cx + 4, my - 1.5); cr.stroke();   // wince
            } else if (kind === 'stretch') {
                chevrons();
                cr.save(); cr.translate(cx, my - 1); cr.scale(1, 1.3); cr.newSubPath(); cr.arc(0, 0, 3.6, 0, 2 * Math.PI); cr.restore(); cr.fill();   // big yawn
            } else if (kind === 'action') {
                round(6.2, 2.2, 0, -0.5);
                cr.moveTo(cx - 6, my - 2); cr.lineTo(cx + 6, my - 2); cr.arc(cx, my - 2, 6, 0, Math.PI); cr.closePath(); cr.fill();   // open grin
            } else if (kind === 'cold') {
                const j = Math.sin(t * 45) * 0.8;
                round(5.6, 2, j, 0);
                rr(cr, cx - 6 + j, my - 3, 12, 5, 1.5); cr.fill();   // chattering teeth
                dark(); cr.setLineWidth(0.9); for (const tx of [-3, 0, 3]) { cr.moveTo(cx + tx + j, my - 3); cr.lineTo(cx + tx + j, my + 2); } cr.moveTo(cx - 6 + j, my - 0.5); cr.lineTo(cx + 6 + j, my - 0.5); cr.stroke();
                rgb(cr, col); cr.setLineWidth(2.5);
            } else if (kind === 'grit') {
                for (const sd of [-1, 1]) {   // narrowed under a frowning brow
                    const ex = cx + sd * 9;
                    rr(cr, ex - 5, ey - 2, 10, 6, 2); cr.fill();
                    cr.moveTo(ex + sd * 5, ey - 7); cr.lineTo(ex - sd * 5, ey - 4); cr.stroke();
                }
                rr(cr, cx - 7, my - 3, 14, 5, 1); cr.fill();   // clenched teeth
                dark(); cr.setLineWidth(0.9); for (const tx of [-3.5, 0, 3.5]) { cr.moveTo(cx + tx, my - 3); cr.lineTo(cx + tx, my + 2); } cr.stroke();
                rgb(cr, col); cr.setLineWidth(2.5);
            } else if (kind === 'calm') {
                for (const ex of [-9, 9]) { cr.moveTo(cx + ex - 5, ey); cr.curveTo(cx + ex - 2, ey + 4, cx + ex + 2, ey + 4, cx + ex + 5, ey); }   // closed, content
                cr.moveTo(cx - 4, my - 1); cr.curveTo(cx - 1, my + 2, cx + 1, my + 2, cx + 4, my - 1); cr.stroke();
            } else if (kind === 'bored') {
                for (const ex of [-9, 9]) { rr(cr, cx + ex - 5, ey - 1, 10, 6, 2); cr.fill(); }   // heavy lids
                dark(); for (const ex of [-9, 9]) { cr.newSubPath(); cr.arc(cx + ex + 1, ey + 3, 1.6, 0, 2 * Math.PI); cr.fill(); }
                rgb(cr, col); for (const ex of [-9, 9]) { cr.moveTo(cx + ex - 6, ey - 2.5); cr.lineTo(cx + ex + 6, ey - 2.5); } cr.stroke();
                cr.moveTo(cx - 2, my); cr.lineTo(cx + 5, my - 1); cr.stroke();   // flat, lopsided mouth
            } else if (kind === 'cramp') {
                const ex = cx - 9; cr.moveTo(ex - 4, ey - 4); cr.lineTo(ex + 3, ey); cr.lineTo(ex - 4, ey + 4); cr.stroke();   // one eye screwed shut
                cr.newSubPath(); cr.arc(cx + 9, ey, 5.5, 0, 2 * Math.PI); cr.fill();
                dark(); cr.newSubPath(); cr.arc(cx + 9, ey, 1.8, 0, 2 * Math.PI); cr.fill(); rgb(cr, col);
                cr.moveTo(cx - 6, my); for (let k = 1; k <= 4; k++) cr.lineTo(cx - 6 + k * 3, my + (k % 2 ? -2 : 1)); cr.stroke();   // wobbly ouch
            } else if (kind === 'phone') {
                cr.setSourceRGBA(0.55, 0.8, 1, 0.16); rr(cr, x + 7, sy + sh * 0.55, w - 14, sh * 0.42, 5); cr.fill(); rgb(cr, col);   // the phone's glow
                for (const ex of [-9, 9]) { rr(cr, cx + ex - 4.5, ey + 2, 9, 5, 2); cr.fill(); }   // eyes down on the screen
                cr.moveTo(cx - 2, my + 1); cr.lineTo(cx + 2, my + 1); cr.stroke();
            }
        } else if (m === 'waitlook') {
            // waiting: eyes follow your pointer
            const blink = Math.sin(t * 2.3) > 0.985 ? 0.1 : 1;
            for (const ex of [-9, 9]) { rr(cr, cx + ex - 5, ey - 7 * blink, 10, Math.max(2, 14 * blink), 3); cr.fill(); }
        } else if (m === 'saver') {
            // screensaver: a small logo drifting and bouncing around its dark screen
            cr.save(); rr(cr, x + 6, sy + 1, w - 12, sh - 2, 7); cr.clip();
            const W2 = w - 30, H2 = sh - 10, pxs = (t * 9) % (2 * W2), pys = (t * 6) % (2 * H2);
            const lxs = x + 8 + (pxs < W2 ? pxs : 2 * W2 - pxs), lys = sy + 8 + (pys < H2 ? pys : 2 * H2 - pys);
            const hue = (t * 0.2) % 1, c3 = [0.5 + 0.5 * Math.sin(hue * 6.28), 0.5 + 0.5 * Math.sin(hue * 6.28 + 2), 0.5 + 0.5 * Math.sin(hue * 6.28 + 4)];
            cr.setSourceRGBA(c3[0], c3[1], c3[2], 1); cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD); cr.setFontSize(6);
            cr.moveTo(lxs, lys); cr.showText('TIKO');
            cr.restore(); rgb(cr, col);
        } else if (m === 'remotetv') {
            // its screen shows whatever channel it is flicking through
            const ch = Math.floor(t / 1.4) % 3;
            cr.save(); rr(cr, x + 6, sy + 1, w - 12, sh - 2, 7); cr.clip();
            if (ch === 0) { cr.setSourceRGBA(0.45, 0.7, 1, 1); cr.paint(); cr.setSourceRGBA(0.35, 0.75, 0.35, 1); cr.rectangle(x, sy + sh * 0.6, w, sh); cr.fill(); }
            else if (ch === 1) { const cols = [[1, 1, 1], [1, 0.9, 0.2], [0.2, 0.9, 0.9], [0.3, 0.9, 0.3], [0.9, 0.3, 0.9], [0.9, 0.2, 0.2]]; cols.forEach((c2, k) => { cr.setSourceRGBA(c2[0], c2[1], c2[2], 1); cr.rectangle(x + 6 + k * (w - 12) / 6, sy, (w - 12) / 6 + 0.5, sh); cr.fill(); }); }
            else { cr.setSourceRGBA(0.1, 0.1, 0.15, 1); cr.paint(); cr.setSourceRGBA(1, 1, 1, 0.9); cr.newSubPath(); cr.arc(cx + Math.sin(t * 3) * 8, ey, 3, 0, 2 * Math.PI); cr.fill(); }
            cr.restore(); rgb(cr, col);
        } else if (m === 'stare') {
            // An angry glare in hot orange: each eye cut on a slant (high outside,
            // low inside) under a heavy brow dipping to the middle, and a frown.
            // Narrower while it points at you.
            const narrow = b.wyPoint ? 0.5 : 1;
            cr.setSourceRGBA(1, 0.45, 0.3, 1);
            for (const sd of [-1, 1]) {
                const ex = cx + sd * 9, o = ex + sd * 5, i2 = ex - sd * 5;
                cr.newPath(); cr.moveTo(o, ey - 4 * narrow); cr.lineTo(i2, ey + 0.5); cr.lineTo(i2, ey + 3.5);
                cr.curveTo(i2, ey + 5.5, i2, ey + 5.5, i2 + sd * 2, ey + 5.5); cr.lineTo(o - sd * 2, ey + 5.5);
                cr.curveTo(o, ey + 5.5, o, ey + 5.5, o, ey + 3.5); cr.closePath(); cr.fill();
                cr.setLineWidth(3); cr.moveTo(ex + sd * 7, ey - 9); cr.lineTo(ex - sd * 5.5, ey - 3); cr.stroke();
            }
            cr.setLineWidth(2.2);
            cr.moveTo(cx - 6, sy + sh * 0.88); cr.curveTo(cx - 3, sy + sh * 0.8, cx + 3, sy + sh * 0.8, cx + 6, sy + sh * 0.88); cr.stroke();
            rgb(cr, col); cr.setLineWidth(2.5);
        } else if (m === 'staybored') {
            // sitting, bored: half-lidded, still following your pointer
            for (const ex of [-9, 9]) { rr(cr, cx + ex - 5, ey - 1, 10, 5, 2); cr.fill(); }
        } else if (m === 'gumchew') {
            for (const ex of [-9, 9]) { rr(cr, cx + ex - 5, ey - 2, 10, 5, 2); cr.fill(); }
        } else if (m === 'dance' && this._music && b.mode === 'dance') {
            // ^ ^ eyes, and the song scrolling along the bottom of its screen
            for (const ex of [-9, 9]) { cr.moveTo(cx + ex - 4, ey + 2); cr.lineTo(cx + ex, ey - 3); cr.lineTo(cx + ex + 4, ey + 2); cr.stroke(); }
            cr.save(); rr(cr, x + 5, y + 6, w - 10, h * 0.62, 9); cr.clip();
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD); cr.setFontSize(6);
            const text = `♪ ${this._music.title}${this._music.artist ? ` - ${this._music.artist}` : ''}   `;
            const tw = cr.textExtents(text).width;
            const off = (t * 20) % tw;
            cr.setSourceRGBA(0.61, 0.94, 0.42, 1);
            for (const k of [0, 1]) { cr.moveTo(x + 7 - off + k * tw, sy + sh * 0.92); cr.showText(text); }
            cr.restore(); rgb(cr, col); cr.setLineWidth(2.5);
        } else if (m === 'peekhide') {
            // eyes hidden behind its hands
        } else if (m === 'fakesleep') {
            // one eye shut, the other sneaks a look now and then
            cr.moveTo(cx - 13, ey + 2); cr.curveTo(cx - 11, ey + 5, cx - 7, ey + 5, cx - 5, ey + 2); cr.stroke();
            if (Math.sin(t * 1.5) > 0.6) { rr(cr, cx + 5, ey - 3, 9, 7, 3); cr.fill(); }
            else { cr.moveTo(cx + 5, ey + 2); cr.curveTo(cx + 7, ey + 5, cx + 11, ey + 5, cx + 13, ey + 2); cr.stroke(); }
        } else if (m === 'detective') {
            for (const ex of [-9, 9]) {
                cr.setSourceRGBA(0.1, 0.1, 0.12, 1); cr.newSubPath(); cr.arc(cx + ex, ey, 6, 0, 2 * Math.PI); cr.fill();
                rgb(cr, C.teal); cr.setLineWidth(1.5); cr.newSubPath(); cr.arc(cx + ex, ey, 6, 0, 2 * Math.PI); cr.stroke();
                cr.setSourceRGBA(1, 1, 1, 0.8); cr.newSubPath(); cr.arc(cx + ex - 2, ey - 2, 1.4, 0, 2 * Math.PI); cr.fill();
            }
            rgb(cr, col); cr.setLineWidth(2.5);
        } else if (m === 'smoke') {
            for (const ex of [-9, 9]) { rr(cr, cx + ex - 5, ey - 1, 10, 4, 2); cr.fill(); }   // relaxed, half-lidded
        } else if (m === 'doze' || (m === 'coffee' && b._prop?.sip)) {
            for (const ex of [-9, 9]) { cr.moveTo(cx + ex - 4, ey + 2); cr.curveTo(cx + ex - 2, ey + 5, cx + ex + 2, ey + 5, cx + ex + 4, ey + 2); cr.stroke(); }
        } else if (m === 'book') {
            for (const ex of [-9, 9]) { rr(cr, cx + ex - 4, ey + 3, 8, 4, 2); cr.fill(); }
        } else if (m === 'polish' || m === 'phones') {
            for (const ex of [-9, 9]) { cr.moveTo(cx + ex - 4, ey + 2); cr.lineTo(cx + ex, ey - 3); cr.lineTo(cx + ex + 4, ey + 2); cr.stroke(); }
        } else if (m === 'cry') {
            for (const ex of [-9, 9]) { cr.moveTo(cx + ex - 5, ey + 2); cr.curveTo(cx + ex - 3, ey - 4, cx + ex + 3, ey - 4, cx + ex + 5, ey + 2); cr.stroke(); }
        } else if (m === 'shy') {
            for (const ex of [-9, 9]) { rr(cr, cx + ex - 3 - dir * 3, ey + 1, 6, 5, 2); cr.fill(); }
        } else if (m === 'laugh') {
            for (const ex of [-9, 9]) { cr.moveTo(cx + ex - 4, ey + 2); cr.lineTo(cx + ex, ey - 3); cr.lineTo(cx + ex + 4, ey + 2); cr.stroke(); }
        } else if (m === 'love') {
            for (const ex of [-9, 9]) {
                const hx = cx + ex, hy = ey + 4;
                cr.moveTo(hx, hy); cr.curveTo(hx - 8, hy - 5, hx - 4, hy - 11, hx, hy - 6);
                cr.curveTo(hx + 4, hy - 11, hx + 8, hy - 5, hx, hy); cr.fill();
            }
        } else if ((m === 'held' && b.scared && (b.spin ?? 0) < 1) || m === 'fear') {
            const fk = m === 'held' ? (b.fearK ?? 0) : 0.5;
            for (const ex of [-9, 9]) {
                rr(cr, cx + ex - 4 - 2 * fk, ey - 9 - 3 * fk, 8 + 4 * fk, 16 + 6 * fk, 3); cr.fill();
                cr.setSourceRGBA(0.02, 0.03, 0.04, 1); cr.newSubPath(); cr.arc(cx + ex, ey - 1, 2.2 - fk, 0, 2 * Math.PI); cr.fill();   // pinpoint pupils
                rgb(cr, col);
            }
            if (m === 'held' && fk > 0.45) {   // tears streaming
                cr.setSourceRGBA(0.55, 0.8, 1, 0.95);
                for (const ex of [-9, 9]) for (let k = 0; k < 2; k++) {
                    const q = (t * (1.5 + fk) + k * 0.5) % 1;
                    cr.newSubPath(); cr.arc(cx + ex + (ex < 0 ? -6 : 6), ey + 8 + q * 16, 1.6, 0, 2 * Math.PI); cr.fill();
                }
                rgb(cr, col);
            }
        } else if (m === 'tease') {
            // Wink on the left, a sly narrowed eye glancing right with a raised brow.
            cr.moveTo(cx - 13, ey + 1); cr.curveTo(cx - 11, ey - 4, cx - 7, ey - 4, cx - 5, ey + 1); cr.stroke();
            rr(cr, cx + 5, ey - 2, 10, 5, 2); cr.fill();
            cr.moveTo(cx + 4, ey - 8); cr.lineTo(cx + 15, ey - 11); cr.stroke();
        } else if (m === 'chute') {
            for (const ex of [-9, 9]) { rr(cr, cx + ex - 5, ey - 7, 10, 10, 3); cr.fill(); }
        } else if (sleeping || m === 'meeting') {
            for (const ex of [-9, 9]) { cr.moveTo(cx + ex - 4, ey + 2); cr.curveTo(cx + ex - 2, ey + 5, cx + ex + 2, ey + 5, cx + ex + 4, ey + 2); cr.stroke(); }
        } else if (m === 'emerge') {
            // squeezed eyes: > <
            cr.moveTo(cx - 13, ey - 3); cr.lineTo(cx - 6, ey); cr.lineTo(cx - 13, ey + 3); cr.stroke();
            cr.moveTo(cx + 13, ey - 3); cr.lineTo(cx + 6, ey); cr.lineTo(cx + 13, ey + 3); cr.stroke();
        } else if (m === 'knocked' || m === 'broken') {
            for (const ex of [-9, 9]) {
                cr.moveTo(cx + ex - 4, ey - 4); cr.lineTo(cx + ex + 4, ey + 4); cr.stroke();
                cr.moveTo(cx + ex + 4, ey - 4); cr.lineTo(cx + ex - 4, ey + 4); cr.stroke();
            }
        } else if (m === 'dizzy' || (m === 'held' && (b.spin ?? 0) >= 1)) {
            for (const ex of [-9, 9]) { cr.newSubPath(); cr.arc(cx + ex, ey, 4, t * 8, t * 8 + 5); cr.stroke(); }
        } else if (m === 'dance' || m === 'wave') {
            for (const ex of [-9, 9]) { cr.moveTo(cx + ex - 4, ey + 2); cr.lineTo(cx + ex, ey - 3); cr.lineTo(cx + ex + 4, ey + 2); cr.stroke(); }
        } else {
            const eh = m === 'held' || m === 'poked' ? sh * 0.5 : m === 'duck' ? sh * 0.2 : m === 'climb' ? sh * 0.3
                : m === 'fly' ? sh * 0.18 : m === 'wake' ? sh * 0.14 : sh * ((b.energy ?? 100) < 40 ? 0.24 : 0.42);
            const blink = Math.sin(t * 2.3) > 0.985 ? 0.1 : 1;
            for (const ex of [-9, 9]) { rr(cr, cx + ex - 5, ey - eh * blink / 2, 10, Math.max(2, eh * blink), 3); cr.fill(); }
        }

        if (m === 'cry') {
            // how hard: from the pull while stretched, otherwise a normal cry
            const k = b.mode === 'stretched' ? (b.cryK ?? 0) : 0.5;
            const open = 2 + k * 6;
            cr.moveTo(cx - 6 - k * 2, sy + sh * 0.88); cr.curveTo(cx - 3, sy + sh * 0.72 - open * 0.3, cx + 3, sy + sh * 0.72 - open * 0.3, cx + 6 + k * 2, sy + sh * 0.88); cr.stroke();
            if (k > 0.5) { cr.newSubPath(); cr.save(); cr.translate(cx, sy + sh * 0.84); cr.scale(1, 0.5 + k * 0.4); cr.arc(0, 0, 2 + k * 3, 0, 2 * Math.PI); cr.restore(); cr.fill(); }   // wailing
            cr.setSourceRGBA(0.55, 0.8, 1, 0.95);
            const drops = 2 + Math.round(k * 4), speed = 30 + k * 70, size = 1.5 + k * 1.3;
            for (const ex of [-9, 9]) for (let n = 0; n < drops; n++) {
                const d = (t * speed + n * (26 / drops)) % 26;
                const spray = k > 0.7 ? (ex < 0 ? -1 : 1) * d * 0.35 : 0;   // tears fly sideways when it wails
                cr.newSubPath(); cr.arc(cx + ex + (ex < 0 ? -4 : 4) - (ex < 0 ? d * 0.15 : -d * 0.15) + spray, ey + 4 + d, size, 0, 2 * Math.PI); cr.fill();
            }
            rgb(cr, col);
        } else if (m === 'shy') {
            cr.setSourceRGBA(1, 0.45, 0.6, 0.55);
            for (const ex of [-12, 12]) { cr.save(); cr.translate(cx + ex, ey + 8); cr.scale(1.6, 1); cr.newSubPath(); cr.arc(0, 0, 3, 0, 2 * Math.PI); cr.restore(); cr.fill(); }
            rgb(cr, col);
            cr.moveTo(cx - 4, sy + sh * 0.82); cr.curveTo(cx - 2, sy + sh * 0.76, cx, sy + sh * 0.88, cx + 2, sy + sh * 0.8); cr.lineTo(cx + 4, sy + sh * 0.8); cr.stroke();
        } else if (m === 'laugh') {
            cr.newSubPath(); cr.arc(cx, sy + sh * 0.68, 6, 0, Math.PI); cr.closePath(); cr.fill();
        } else if (m === 'love') {
            cr.newSubPath(); cr.arc(cx, sy + sh * 0.7, 5, 0.2, Math.PI - 0.2); cr.stroke();
            cr.setSourceRGBA(1, 0.49, 0.71, 1 - ((t * 0.8) % 1));
            const hy = y - 6 - ((t * 0.8) % 1) * 22;
            cr.moveTo(10, hy); cr.curveTo(4, hy - 4, 7, hy - 9, 10, hy - 5); cr.curveTo(13, hy - 9, 16, hy - 4, 10, hy); cr.fill();
            rgb(cr, col);
        } else if (m === 'angry') {
            cr.moveTo(cx - 14, ey - 9); cr.lineTo(cx - 5, ey - 5); cr.stroke();
            cr.moveTo(cx + 14, ey - 9); cr.lineTo(cx + 5, ey - 5); cr.stroke();
            cr.moveTo(cx - 6, sy + sh * 0.84);
            for (let k = 1; k <= 4; k++) cr.lineTo(cx - 6 + k * 3, sy + sh * (k % 2 ? 0.78 : 0.84));
            cr.stroke();
            // steam puffs from the top of the head
            cr.setSourceRGBA(0.9, 0.92, 0.95, 0.8);
            for (const sx of [x + 4, x + w - 4]) {
                const k = (t * 1.5) % 1;
                cr.newSubPath(); cr.arc(sx + (sx < 0 ? -k * 6 : k * 6), y - 4 - k * 16, 2 + k * 3, 0, 2 * Math.PI); cr.fill();
            }
            rgb(cr, col);
        } else if ((m === 'held' && b.scared && (b.spin ?? 0) < 1) || m === 'fear') {
            if (m === 'fear' || (m === 'held' && (b.fearK ?? 0) > 0.2)) {   // sweat drops flying off behind it
                cr.setSourceRGBA(0.55, 0.8, 1, 0.9);
                for (let k = 0; k < 2; k++) {
                    const q = (t * 3 + k * 0.5) % 1;
                    cr.newSubPath(); cr.arc(-dir * (w / 2 + 4 + q * 14), y + 6 - q * 8 + k * 6, 2, 0, 2 * Math.PI); cr.fill();
                }
                rgb(cr, col);
            }
            cr.moveTo(cx - 6, sy + sh * 0.84);
            for (let k = 1; k <= 4; k++) cr.lineTo(cx - 6 + k * 3, sy + sh * (k % 2 ? 0.8 : 0.86));
            cr.stroke();
        } else if (m === 'alert') {
            // frown: brows slanting in, mouth turned down
            cr.moveTo(cx - 14, ey - 9); cr.lineTo(cx - 5, ey - 6); cr.stroke();
            cr.moveTo(cx + 14, ey - 9); cr.lineTo(cx + 5, ey - 6); cr.stroke();
            cr.moveTo(cx - 5, sy + sh * 0.84); cr.curveTo(cx - 2, sy + sh * 0.76, cx + 2, sy + sh * 0.76, cx + 5, sy + sh * 0.84); cr.stroke();
        } else if (m === 'emerge') {
            // gritted teeth and a sweat drop
            cr.moveTo(cx - 6, sy + sh * 0.8);
            for (let k = 1; k <= 4; k++) cr.lineTo(cx - 6 + k * 3, sy + sh * (k % 2 ? 0.74 : 0.8));
            cr.stroke();
            cr.setSourceRGBA(0.55, 0.8, 1, 0.9);
            const dy = (t * 14) % 8;
            cr.newSubPath(); cr.arc(x + w - 2, y + 4 + dy, 2.2, 0, 2 * Math.PI); cr.fill();
            rgb(cr, col);
        } else if (m === 'tease') {
            // smirk: flat on the left, curling up on the right
            cr.moveTo(cx - 6, sy + sh * 0.8); cr.curveTo(cx - 1, sy + sh * 0.84, cx + 4, sy + sh * 0.82, cx + 8, sy + sh * 0.7); cr.stroke();
        } else if (m === 'chute') {
            cr.newSubPath(); cr.arc(cx, sy + sh * 0.78, 3, 0, 2 * Math.PI); cr.stroke();
        }

        // injuries: a plaster on the head; badly hurt also gets a tear
        const inj = b.injury && Date.now() < b.injury.until ? b.injury.level : 0;
        if (inj) {
            cr.save();
            cr.translate(x + w * 0.72, y + 3); cr.rotate(-0.5);
            cr.setSourceRGBA(0.96, 0.87, 0.74, 1); rr(cr, -9, -3, 18, 6, 2); cr.fill();
            cr.setSourceRGBA(0.85, 0.45, 0.5, 1); rr(cr, -3, -3, 6, 6, 1); cr.fill();
            if (inj === 2) {
                cr.rotate(1.0);
                cr.setSourceRGBA(0.96, 0.87, 0.74, 1); rr(cr, -9, -3, 18, 6, 2); cr.fill();
                cr.setSourceRGBA(0.85, 0.45, 0.5, 1); rr(cr, -3, -3, 6, 6, 1); cr.fill();
            }
            cr.restore();
            if (inj === 2 && Date.now() < b.injury.until - (LIMP_SECS - 6) * 1000) {
                cr.setSourceRGBA(0.55, 0.8, 1, 0.9);
                const ty = ey + 6 + ((t * 20) % 10);
                cr.newSubPath(); cr.arc(cx - 12, ty, 2, 0, 2 * Math.PI); cr.fill();
            }
            rgb(cr, col);
        }

        // Parachute: unfurls from a bundle with a little overshoot, then
        // breathes gently; lines run from every gore seam to the hands.
        if (m === 'chute') {
            const since = t - (b.chuteAt ?? t), hemY = y - 34;
            const k = Math.min(1, since / CHUTE_UNFURL);
            const pop = k < 1 ? 0.15 + 0.85 * (1 + 2.2 * Math.pow(k - 1, 3) + 1.2 * Math.pow(k - 1, 2)) : 1;   // ease out with overshoot
            const breathe = k < 1 ? 1 : 1 + Math.sin(t * 3.2) * 0.025;
            const sx = pop * breathe, sy = (k < 1 ? 0.3 + 0.7 * k : 1) * (2 - breathe) * (1 - 0.15 * (b.chuteFlare ?? 0));   // flaring flattens it
            cr.setSourceRGBA(0.85, 0.87, 0.9, 0.85); cr.setLineWidth(0.8);
            for (let i = 0; i <= CANOPY_GORES; i++) {
                const ex = (-CANOPY_R + (2 * CANOPY_R * i) / CANOPY_GORES) * sx;
                const pull = (b.chuteFlare ?? 0) * 16 + Math.max(0, (ex < 0 ? -1 : 1) * (b.chuteSteer ?? 0)) * 12;
                cr.moveTo(ex, hemY); cr.lineTo(ex < 0 ? x - 6 : x + w + 6, y - 14 + pull); cr.stroke();
            }
            cr.save(); cr.translate(0, hemY); drawCanopy(cr, sx, sy); cr.restore();
            cr.setLineWidth(2.5);
        }
        // Touched down: the canopy sinks and drapes down behind it, then goes.
        if (b.mode === 'chuteland') {
            const q = Math.min(1, 1 - b.actT / 1.1);
            const ease = q * q * (3 - 2 * q);
            cr.save(); cr.translate(-dir * ease * 34, y - 34 + ease * (fy - y + 30));
            cr.rotate(-dir * ease * 0.5);
            drawCanopy(cr, 1 + ease * 0.35, Math.max(0.12, 1 - ease * 0.88), q > 0.75 ? 1 - (q - 0.75) / 0.25 : 1);
            cr.restore();
            if (q < 0.5) {   // lines going slack
                cr.setSourceRGBA(0.85, 0.87, 0.9, 0.6 * (1 - q * 2)); cr.setLineWidth(0.8);
                cr.moveTo(x - 6, shY); cr.curveTo(x - 20 * dir, shY - 20, -dir * 30, y - 20, -dir * ease * 34, y - 34 + ease * (fy - y + 30)); cr.stroke();
                cr.setLineWidth(2.5);
            }
            rgb(cr, col);
        }

        if (m === 'knocked' || m === 'broken' || (m === 'dizzy' && b.actT > 1)) {
            rgb(cr, C.warn);
            for (let i = 0; i < 3; i++) {
                const a = t * 4 + (i * 2 * Math.PI) / 3;
                const sx = Math.cos(a) * 20, sy2 = y - 8 + Math.sin(a) * 6;
                cr.newSubPath();
                for (let k = 0; k < 10; k++) {
                    const r = k % 2 ? 1.6 : 4, ang = (k * Math.PI) / 5 - Math.PI / 2;
                    const px = sx + Math.cos(ang) * r, py = sy2 + Math.sin(ang) * r;
                    if (k === 0) cr.moveTo(px, py); else cr.lineTo(px, py);
                }
                cr.closePath(); cr.fill();
            }
            rgb(cr, col);
        }

        if (b.loose) {
            cr.save(); cr.translate(b.loose.x, b.loose.y + 2); cr.rotate(b.loose.rot);
            if (b.loose.kind === 'skate') drawSkate(); else drawBike(b.loose.rot);
            cr.restore(); rgb(cr, col); cr.setLineWidth(2.5);
        }
        if (m === 'broken' && b.parts) {
            for (const q of b.parts) {
                cr.save(); cr.translate(q.x, q.y); cr.rotate(q.rot);
                if (q.kind === 'arm') {
                    rgb(cr, C.limb); cr.setLineWidth(5);
                    cr.moveTo(0, -8); cr.lineTo(0, 8); cr.stroke();
                    rgb(cr, C.hand); cr.newSubPath(); cr.arc(0, 10, 4, 0, 2 * Math.PI); cr.fill();
                } else {
                    rgb(cr, C.limb); cr.setLineWidth(8);
                    cr.moveTo(0, -10); cr.lineTo(0, 4); cr.stroke();
                    rgb(cr, C.foot); rr(cr, -7, 3, 14, 6, 2); cr.fill();
                    rgb(cr, C.stripe); rr(cr, -6, 8, 12, 2, 1); cr.fill();
                }
                cr.restore();
            }
            // sparks at the empty joints for the first moments
            if (b.actT > BREAK_SECS - 1.2) {
                cr.setSourceRGBA(1, 0.85, 0.3, 0.9); cr.setLineWidth(1.5);
                for (const [jx, jy] of [[x - 2, y + h * 0.5], [x + w + 2, y + h * 0.5], [-8, y + h * 0.8], [8, y + h * 0.8]]) {
                    for (let k = 0; k < 3; k++) {
                        const a2 = t * 9 + k * 2.1;
                        cr.moveTo(jx, jy); cr.lineTo(jx + Math.cos(a2) * 6, jy + Math.sin(a2) * 6); cr.stroke();
                    }
                }
            }
            rgb(cr, col); cr.setLineWidth(2.5);
        }

        if (b.mode === 'rocket' && b.rocket) {
            const r = b.rocket, rx0 = r.k < 1.2 ? dir * 30 : 0, ry0 = r.k < 1.2 ? 0 : fy;
            const built = Math.min(1, r.k / 1.2);
            cr.save(); cr.translate(rx0, ry0);
            cr.setSourceRGBA(0.92, 0.93, 0.95, 1); rr(cr, -7, -30 * built, 14, 30 * built, 4); cr.fill();
            cr.setSourceRGBA(0.85, 0.2, 0.3, 1);
            cr.moveTo(-7, -30 * built); cr.lineTo(0, -30 * built - 9 * built); cr.lineTo(7, -30 * built); cr.closePath(); cr.fill();
            cr.moveTo(-7, -2); cr.lineTo(-12, 4); cr.lineTo(-7, -8); cr.closePath(); cr.fill();
            cr.moveTo(7, -2); cr.lineTo(12, 4); cr.lineTo(7, -8); cr.closePath(); cr.fill();
            rgb(cr, C.teal); cr.newSubPath(); cr.arc(0, -18 * built, 3 * built, 0, 2 * Math.PI); cr.fill();
            if (r.lift) {
                for (let k = 0; k < 3; k++) {
                    cr.setSourceRGBA(1, 0.5 + 0.3 * Math.random(), 0.1, 0.9);
                    cr.moveTo(-5 + k * 5, 0); cr.lineTo(-3 + k * 5 + (Math.random() - 0.5) * 3, 10 + Math.random() * 10); cr.lineTo(-1 + k * 5, 0); cr.fill();
                }
            }
            cr.restore();
            rgb(cr, col); cr.setLineWidth(2.5);
        }
        if (b.mode === 'gum') {
            const mx = cx + dir * 2, my = sy + sh * 0.82;
            if (!b.popped) {
                const r0 = 2 + Math.max(0, (4.5 - b.actT) / 3.4) * 13;
                cr.setSourceRGBA(1, 0.55, 0.75, 0.85); cr.newSubPath(); cr.arc(mx, my, r0, 0, 2 * Math.PI); cr.fill();
                cr.setSourceRGBA(1, 1, 1, 0.5); cr.newSubPath(); cr.arc(mx - r0 * 0.35, my - r0 * 0.35, r0 * 0.2, 0, 2 * Math.PI); cr.fill();
            } else {
                cr.setSourceRGBA(1, 0.55, 0.75, 0.9);   // popped: gum all over its face
                for (const [gx, gy, gr] of [[-10, -4, 4], [8, -6, 3.5], [0, 4, 5], [-4, 8, 3], [12, 4, 3]]) {
                    cr.newSubPath(); cr.arc(cx + gx, ey + gy, gr, 0, 2 * Math.PI); cr.fill();
                }
            }
            rgb(cr, col); cr.setLineWidth(2.5);
        }

        const inPyjamas = (b.mode === 'bedtime' && b.actT <= 4) || (b.mode === 'sleep' && b.nightcap);
        if (inPyjamas) {
            // blue-striped pyjamas and a floppy nightcap with a bobble
            cr.setSourceRGBA(0.45, 0.6, 1, 0.35);
            for (let k = 0; k < 3; k++) { cr.rectangle(x, y + hh + 2 + k * 4, w, 1.6); cr.fill(); }
            cr.setSourceRGBA(0.35, 0.45, 0.85, 1);
            cr.moveTo(x + 4, y + 2); cr.curveTo(x + w * 0.3, y - 16, x + w * 0.9, y - 14, x + w + 6, y + 4); cr.lineTo(x + w - 4, y + 2); cr.closePath(); cr.fill();
            cr.setSourceRGBA(1, 1, 1, 1); cr.newSubPath(); cr.arc(x + w + 6, y + 5, 3, 0, 2 * Math.PI); cr.fill();
            rgb(cr, col); cr.setLineWidth(2.5);
        }
        if ((b.mode === 'bedtime' && b.actT <= 2) || (b.mode === 'sleep' && b.nightcap)) {
            // the blanket, pulled up to its chin
            const k = b.mode === 'bedtime' ? Math.min(1, (2 - b.actT) / 1.5) : 1;
            cr.setSourceRGBA(0.95, 0.6, 0.7, 0.95);
            rr(cr, x - 8, fy - (h * 0.55) * k, w + 16, (h * 0.55) * k + 2, 6); cr.fill();
            cr.setSourceRGBA(1, 1, 1, 0.5);
            for (let i = 0; i < 4; i++) { cr.newSubPath(); cr.arc(x - 2 + i * 14, fy - (h * 0.3) * k, 1.6, 0, 2 * Math.PI); cr.fill(); }
            rgb(cr, col); cr.setLineWidth(2.5);
        }

        // Hacker mode, or a sunny day: dark shades with a glint.
        const sunny = this._weather?.sun && ['walk', 'look', 'stay', 'sit', 'dance', 'wave', 'coffee', 'book'].includes(b.mode);
        if (sunny || b.mode === 'weekend' || b.mode === 'sunbathe' || (b.mode === 'typing' && Date.now() - (b.typingSince ?? Date.now()) > 20000)) {
            cr.setSourceRGBA(0.05, 0.05, 0.07, 1);
            for (const ex of [-9, 9]) { rr(cr, cx + ex - 7, ey - 5, 14, 9, 3); cr.fill(); }
            cr.setLineWidth(2); cr.moveTo(cx - 2, ey - 2); cr.lineTo(cx + 2, ey - 2); cr.stroke();
            cr.setSourceRGBA(1, 1, 1, 0.7); cr.setLineWidth(1.2);
            for (const ex of [-9, 9]) { cr.moveTo(cx + ex - 4, ey - 3); cr.lineTo(cx + ex - 1, ey - 3); cr.stroke(); }
            rgb(cr, col); cr.setLineWidth(2.5);
        }

        // props for everyday activities
        const pr = b._prop;
        if (pr && pr.kind === 'phone' && b.mode === 'selfie') {
            cr.setSourceRGBA(0.12, 0.12, 0.15, 1); rr(cr, pr.x - 5, pr.y - 8, 10, 16, 2); cr.fill();
            rgb(cr, C.teal); cr.newSubPath(); cr.arc(pr.x, pr.y - 4, 1.4, 0, 2 * Math.PI); cr.fill();
            if (b.actT < 1.4 && b.actT > 1.15) {   // the flash
                cr.setSourceRGBA(1, 1, 1, 0.8); cr.newSubPath(); cr.arc(pr.x, pr.y - 4, 14, 0, 2 * Math.PI); cr.fill();
                if (!b.shot) { b.shot = true; this._sound('shutter'); }
            }
            if (b.actT > 1.5) b.shot = false;
            rgb(cr, col); cr.setLineWidth(2.5);
        }
        if (b.snakeAt) {
            // The hat and its snake stay where the trick went wrong, fading as
            // Tiko runs off (this drawing area only reaches ~120 px each side).
            const hx = (b.snakeAt.x - b.x) / S, gy = (b.snakeAt.y - b.y) / S;
            const alpha = Math.max(0, Math.min(1, 1 - (Math.abs(hx) - 60) / 55));
            if (alpha > 0) {
                cr.pushGroup();
                cr.setSourceRGBA(0.1, 0.1, 0.12, 1); rr(cr, hx - 8, gy - 14, 16, 14, 2); cr.fill(); rr(cr, hx - 11, gy - 3, 22, 3, 1); cr.fill();
                cr.setSourceRGBA(0.85, 0.2, 0.3, 1); cr.rectangle(hx - 8, gy - 8, 16, 2); cr.fill();
                const rise = Math.min(1, (b.t - b.snakeAt.at) / 0.35), top = gy - 14 - 28 * rise;
                if (!this._snake) {   // once it drops out it is its own sprite (_stepSnake)
                const face = Math.sign(-hx) || -dir, wig = Math.sin(t * 9) * 4;
                cr.setLineCap(Cairo.LineCap.ROUND);
                cr.setSourceRGBA(0.28, 0.66, 0.3, 1); cr.setLineWidth(6);
                cr.moveTo(hx, gy - 12); cr.curveTo(hx - 7 + wig, gy - 18, hx + 7 - wig, top + 10, hx + face * 2, top + 2); cr.stroke();
                cr.setSourceRGBA(0.85, 0.75, 0.25, 1); cr.setLineWidth(1.4);   // yellow belly stripes
                for (let k = 1; k <= 3; k++) { const q = gy - 12 - (gy - 12 - top) * k / 4; cr.moveTo(hx - 2, q); cr.lineTo(hx + 2, q); }
                cr.stroke();
                cr.save(); cr.translate(hx + face * 4, top); cr.scale(face, 1);   // head facing Tiko
                cr.setSourceRGBA(0.28, 0.66, 0.3, 1); cr.save(); cr.scale(1.4, 1); cr.newSubPath(); cr.arc(0, 0, 4.2, 0, 2 * Math.PI); cr.restore(); cr.fill();
                cr.setSourceRGBA(1, 1, 1, 1); cr.newSubPath(); cr.arc(1.5, -1.8, 1.5, 0, 2 * Math.PI); cr.fill();
                cr.setSourceRGBA(0, 0, 0, 1); cr.newSubPath(); cr.arc(2, -1.8, 0.7, 0, 2 * Math.PI); cr.fill();
                if (Math.sin(t * 14) > 0) {   // flicking tongue
                    cr.setSourceRGBA(0.9, 0.15, 0.2, 1); cr.setLineWidth(0.9);
                    cr.moveTo(5.5, 0.8); cr.lineTo(9, 0.8); cr.lineTo(10.5, -0.6); cr.moveTo(9, 0.8); cr.lineTo(10.5, 2); cr.stroke();
                }
                cr.restore();
                }
                cr.popGroupToSource(); cr.paintWithAlpha(alpha);
            }
            rgb(cr, col); cr.setLineWidth(2.5);
        }
        if (pr && pr.kind === 'vfingers' && b.mode === 'watchingyou') {
            if (pr.front) this._drawPointEmoji(cr, pr.base[0], pr.base[1], pr.k ?? 1);   // 🫵, jabbed at you
            else drawGlove(cr, pr.base[0], pr.base[1], pr.rot, pr.spread, pr.flen);
            rgb(cr, col); cr.setLineWidth(2.5);
        }
        if (b.mode === 'edgeblanket') {   // the bottom edge of the screen pulled up over it like a blanket
            cr.setSourceRGBA(0.2, 0.21, 0.25, 0.95); rr(cr, x - 6, y + h * 0.5, w + 12, h * 0.5 + 16, 3); cr.fill();
            cr.setSourceRGBA(0.35, 0.36, 0.42, 1); cr.moveTo(x + w + 6, y + h * 0.5); cr.lineTo(x + w - 6, y + h * 0.5); cr.lineTo(x + w + 6, y + h * 0.5 + 12); cr.closePath(); cr.fill();   // turned-down corner
            cr.setSourceRGBA(1, 1, 1, 0.15); cr.rectangle(x - 6, y + h * 0.5, w + 12, 2); cr.fill();
            rgb(cr, col);
        }
        if (b.mode === 'burrito') {   // wrapped up in a blanket, only its eyes showing
            cr.setSourceRGBA(0.95, 0.6, 0.35, 1); rr(cr, x - 4, y + h * 0.48, w + 8, h * 0.52 + 14, 10); cr.fill();
            cr.setSourceRGBA(1, 0.85, 0.55, 1); cr.setLineWidth(2);
            for (let k = 0; k < 4; k++) { cr.moveTo(x - 2, y + h * 0.58 + k * 7); cr.lineTo(x + w + 2, y + h * 0.58 + k * 7); } cr.stroke();
            cr.setSourceRGBA(0.85, 0.45, 0.25, 1); rr(cr, x - 6, y + h * 0.44, w + 12, 6, 3); cr.fill();   // the folded edge
            rgb(cr, col);
        }
        if (b.mode === 'sleepyread' && (b.readK ?? 0) > 0.6) {   // the book has slid onto its face
            cr.save(); cr.translate(0, y + h * 0.35); cr.rotate(-dir * 0.4);
            rgb(cr, C.purple); rr(cr, -14, -9, 28, 14, 2); cr.fill();
            cr.setSourceRGBA(1, 1, 1, 0.3); cr.rectangle(-1, -9, 2, 14); cr.fill();
            cr.restore(); rgb(cr, col);
        }
        if (b.mode === 'bellyup') {   // a bubble going in and out as it snoozes
            const r2 = 1.5 + Math.abs(Math.sin(t * 0.9)) * 3.5;
            cr.setSourceRGBA(0.75, 0.88, 1, 0.55); cr.newSubPath(); cr.arc(dir * 10, y + 6 + h * 0.62 * 0.85, r2, 0, 2 * Math.PI); cr.fill();
            cr.setSourceRGBA(1, 1, 1, 0.7); cr.newSubPath(); cr.arc(dir * 10 - r2 * 0.3, y + 6 + h * 0.62 * 0.85 - r2 * 0.3, r2 * 0.25, 0, 2 * Math.PI); cr.fill();
            rgb(cr, col);
        }
        if (b.mode === 'hide') {
            // a leafy bush in front; the crouch translate in _paint moves it too, so undo that
            cr.save(); cr.translate(0, -(Math.sin(t * 0.9) > 0.55 ? 18 : 6));
            const leaf = [[-26, -10, 13], [-12, -18, 15], [4, -20, 16], [20, -14, 14], [30, -6, 10], [-32, -4, 10], [-4, -6, 16], [14, -4, 14]];
            cr.setSourceRGBA(0.2, 0.5, 0.25, 1);
            for (const [lx2, ly2, r2] of leaf) { cr.newSubPath(); cr.arc(lx2, ly2 + fy, r2, 0, 2 * Math.PI); cr.fill(); }
            cr.setSourceRGBA(0.3, 0.65, 0.32, 1);
            for (const [lx2, ly2, r2] of leaf) { cr.newSubPath(); cr.arc(lx2 - 2, ly2 + fy - 3, r2 * 0.6, 0, 2 * Math.PI); cr.fill(); }
            cr.restore();
            rgb(cr, col); cr.setLineWidth(2.5);
        }
        if (pr && pr.kind === 'snack' && b.mode === 'movie' && pr.away) {
            if (pr.milk) { cr.save(); cr.translate(pr.hx, pr.hy + 4); drawMilk(cr); cr.restore(); cr.save(); cr.translate(pr.hx - dir * 6, pr.hy); drawCookie(cr); cr.restore(); }   // back from the fridge
        } else if (pr && pr.kind === 'snack' && b.mode === 'movie') {
            // a popcorn bucket (later a pizza box) in its lap, over the blanket;
            // tipped over, spilling, once it dozes
            const mvp = b.movie ?? {}, beer = mvp.beer ?? {left: 1, open: false};
            const sy0 = y + 6, sh0 = h * 0.62;
            if (mvp.blanket) {
                const top = pr.pull ? shY + 2 : y + h * 0.74;
                drawBlanket(cr, x - 6, top, w + 12, fy + 7);   // hangs over the seat front
            }
            const cookie = Date.now() < (mvp.milkUntil ?? 0);
            if (mvp.pizza) {   // slides in along the floor, then into its lap
                const k = Math.min(1, (b.t - (mvp.pizzaAt ?? -9)) / 1.4);
                cr.save(); cr.translate(pr.bagX + dir * (1 - k) * 120, pr.bagY + (1 - k) * 14);
                if (pr.tipped) cr.rotate(-dir * 0.5);
                drawPizzaBox(cr, mvp.pop ?? 1); cr.restore();
            } else {
                cr.save(); cr.translate(pr.bagX, pr.bagY);
                if (pr.tipped) cr.rotate(-dir * 1.25);
                cr.scale(0.85, 0.85); drawPopcorn(cr, mvp.pop ?? 1);
                cr.restore();
            }
            if (pr.tipped && !mvp.pizza) { drawKernel(cr, pr.bagX + dir * 14, pr.bagY + 3); drawKernel(cr, pr.bagX + dir * 20, pr.bagY + 5, 1.3); drawKernel(cr, pr.bagX + dir * 9, pr.bagY + 6, 1.4); }
            if (pr.chip) {
                if (cookie) { cr.save(); cr.translate(pr.hx, pr.hy - 4); drawCookie(cr); cr.restore(); }
                else if (mvp.pizza) { cr.save(); cr.translate(pr.hx, pr.hy - 6); drawSlice(cr); cr.restore(); }
                else drawKernel(cr, pr.hx, pr.hy - 4, 1.5);
            }
            if (pr.crunch && mvp.pizza && !cookie) { cr.save(); cr.translate(pr.hx, pr.hy - 6); cr.scale(0.8, 0.6); drawSlice(cr); cr.restore(); }   // half eaten
            else if (pr.crunch && Math.floor(pr.crunchT * 3) % 3 === 0) drawKernel(cr, pr.hx - 1, pr.hy + 3 + ((pr.crunchT * 1.6) % 1) * 18, 1.1);   // one drops
            if (pr.phone) { cr.save(); cr.translate(pr.phone[0], pr.phone[1]); drawPhone(cr, b.t); cr.restore(); }
            if (pr.item) { cr.save(); cr.translate(pr.item[1], pr.item[2]); drawFound(cr, pr.item[0]); cr.restore(); }
            if (mvp.glasses) {   // round reading glasses over its screen-eyes
                const gy = sy0 + sh0 * 0.42;
                cr.setSourceRGBA(0.15, 0.12, 0.1, 1); cr.setLineWidth(1.6);
                for (const ex of [-9, 9]) { cr.newSubPath(); cr.arc(ex, gy, 7, 0, 2 * Math.PI); cr.stroke(); }
                cr.moveTo(-2, gy - 1); cr.curveTo(-1, gy - 3, 1, gy - 3, 2, gy - 1); cr.stroke();
                cr.setSourceRGBA(1, 1, 1, 0.18); for (const ex of [-9, 9]) { cr.newSubPath(); cr.arc(ex, gy, 6.2, 0, 2 * Math.PI); cr.fill(); }
            }
            if (mvp.badge) {   // the Couch Potato medal on its chest
                const mx = 11, my = y + h * 0.8;   // clear of the bucket
                cr.setSourceRGBA(0.2, 0.45, 0.85, 1); cr.moveTo(mx - 3, my - 7); cr.lineTo(mx, my - 2); cr.lineTo(mx + 3, my - 7); cr.closePath(); cr.fill();
                cr.setSourceRGBA(0.95, 0.75, 0.2, 1); cr.newSubPath(); cr.arc(mx, my, 3.6, 0, 2 * Math.PI); cr.fill();
                cr.setSourceRGBA(0.6, 0.42, 0.2, 1); cr.save(); cr.translate(mx, my); cr.scale(1, 0.7); cr.newSubPath(); cr.arc(0, 0, 1.8, 0, 2 * Math.PI); cr.restore(); cr.fill();   // a tiny potato
            }
            if (pr.sip) {   // the beer, tipped up to its mouth
                cr.save(); cr.translate(pr.hx, pr.hy); cr.rotate(-dir * 0.9);
                drawBeer(cr, beer.left, true); cr.restore();
            }
            if (pr.beerAt) {   // opening: the cap flies off with a pop and it fizzes
                cr.save(); cr.translate(pr.beerAt[0], pr.beerAt[1]); drawBeer(cr, beer.left, pr.capT > 0.5, pr.capT > 0.5 ? pr.fizz : 0); cr.restore();
                if (pr.capT > 0.5 && pr.capT < 1.4) {
                    const q = (pr.capT - 0.5) / 0.9;
                    cr.setSourceRGBA(0.85, 0.7, 0.2, 1);
                    rr(cr, pr.beerAt[0] + dir * q * 16 - 1.8, pr.beerAt[1] - 20 - Math.sin(q * Math.PI) * 14, 3.6, 2, 0.6); cr.fill();
                }
            }
            rgb(cr, col); cr.setLineWidth(2.5);
        }
        if (pr && pr.kind === 'banana' && b.mode === 'banana') {
            // A curved, tapering banana held by its stem. Before the first bite
            // it is whole (green-brown tip); then the top is peeled, the flaps
            // hang down over the hand and the cream fruit shrinks bite by bite.
            const L = 20;
            cr.save(); cr.translate(pr.x, pr.y + 2); cr.scale(dir, 1);
            const yellow = () => cr.setSourceRGBA(0.99, 0.84, 0.18, 1);
            const edge = () => { cr.setSourceRGBA(0.72, 0.52, 0.08, 1); cr.setLineWidth(0.8); cr.stroke(); };
            const body = len => {   // crescent from the stem (0,0) curving up and forward
                cr.moveTo(-1.6, 0);
                cr.curveTo(-7, -len * 0.4, -4, -len * 0.85, 4, -len);
                cr.lineTo(5.5, -len + 2);
                cr.curveTo(0.5, -len * 0.78, -1, -len * 0.4, 1.6, 0);
                cr.closePath();
            };
            if (pr.left > 0.8) {   // whole for the first second, then peeled
                body(L); yellow(); cr.fillPreserve(); edge();
                cr.setSourceRGBA(0.35, 0.25, 0.1, 1); cr.newSubPath(); cr.arc(4.8, -L + 1, 1.1, 0, 2 * Math.PI); cr.fill();
            } else {
                const cut = L * 0.45, fruit = cut + (L - cut) * Math.min(1, (pr.left - 0.15) / 0.65 + 0.15);
                // cream fruit above the peel line, rounded where it was bitten
                cr.setSourceRGBA(0.99, 0.95, 0.78, 1);
                cr.moveTo(-3.2, -cut); cr.curveTo(-4.5, -fruit * 0.8, -1, -fruit, 1.5, -fruit);
                cr.curveTo(3.5, -fruit, 2, -fruit * 0.8, 0.6, -cut); cr.closePath(); cr.fillPreserve();
                cr.setSourceRGBA(0.85, 0.78, 0.55, 1); cr.setLineWidth(0.6); cr.stroke();
                // lower half still in its peel
                body(cut); yellow(); cr.fillPreserve(); edge();
                // three peel flaps flopping down and out
                for (const [ex, ey] of [[-8, -cut + 9], [1, -cut + 11], [8, -cut + 8]]) {
                    cr.moveTo(-2.5, -cut); cr.curveTo(ex * 0.4 - 1, -cut - 3, ex, ey - 8, ex, ey);
                    cr.lineTo(ex + 2, ey - 1); cr.curveTo(ex * 0.6 + 2, -cut - 1, 1, -cut - 2, 1.5, -cut); cr.closePath();
                    yellow(); cr.fillPreserve(); edge();
                    cr.setSourceRGBA(0.4, 0.28, 0.1, 1); cr.newSubPath(); cr.arc(ex + 1, ey - 0.5, 0.9, 0, 2 * Math.PI); cr.fill();
                }
            }
            cr.setSourceRGBA(0.42, 0.3, 0.12, 1); rr(cr, -1, -0.5, 2, 3.5, 0.8); cr.fill();   // stem
            cr.restore();
            rgb(cr, col); cr.setLineWidth(2.5);
        }
        if (pr && pr.kind === 'cig' && b.mode === 'smoke') {
            const tipX = pr.x + dir * 8, tipY = pr.y - 1;
            cr.setSourceRGBA(0.95, 0.95, 0.92, 1); cr.setLineWidth(2.2); cr.moveTo(pr.x, pr.y); cr.lineTo(tipX, tipY); cr.stroke();
            const glow = pr.puff ? 1 : 0.6;
            cr.setSourceRGBA(1, 0.45 * glow + 0.2, 0.15, 1); cr.newSubPath(); cr.arc(tipX, tipY, 1.4, 0, 2 * Math.PI); cr.fill();
            for (let k = 0; k < 3; k++) {   // smoke curling up
                const q = (t * 0.5 + k / 3) % 1;
                cr.setSourceRGBA(0.8, 0.82, 0.86, 0.45 * (1 - q));
                cr.newSubPath(); cr.arc(tipX + Math.sin(q * 6 + k) * 4, tipY - 4 - q * 26, 1.5 + q * 4, 0, 2 * Math.PI); cr.fill();
            }
            rgb(cr, col); cr.setLineWidth(2.5);
        }
        // The coffee run is drawn as 'walk' (m is remapped above), so it is
        // let in by its real mode, or the mug it carries back never showed.
        if (pr && (['coffee', 'book', 'polish'].includes(m) || (b.mode === 'coffeerun' && pr.kind === 'cup'))) {
            if (pr.kind === 'cup' && b.mode === 'timer') {   // a timer break: a glass of water
                cr.setSourceRGBA(0.85, 0.93, 1, 0.55); rr(cr, pr.x - 4, pr.y - 5, 8, 10, 1.5); cr.fill();
                cr.setSourceRGBA(0.45, 0.72, 1, 0.9); rr(cr, pr.x - 3.5, pr.y - 1, 7, 5.5, 1.5); cr.fill();
            } else if (pr.kind === 'cup') {
                cr.setSourceRGBA(0.93, 0.94, 0.96, 1); rr(cr, pr.x - 4, pr.y - 4, 8, 9, 2); cr.fill();
                rgb(cr, C.teal); cr.rectangle(pr.x - 4, pr.y - 1, 8, 2); cr.fill();
                cr.setSourceRGBA(0.93, 0.94, 0.96, 1); cr.setLineWidth(1.3);
                cr.newSubPath(); cr.arc(pr.x + 5, pr.y + 1, 2.4, -1.4, 1.4); cr.stroke();
                cr.setSourceRGBA(0.9, 0.92, 0.95, 0.5);
                const k = (t * 1.2) % 1;
                cr.moveTo(pr.x - 1, pr.y - 6 - k * 6); cr.curveTo(pr.x + 2, pr.y - 9 - k * 6, pr.x - 2, pr.y - 12 - k * 6, pr.x + 1, pr.y - 15 - k * 6);
                cr.stroke();
            } else if (pr.kind === 'book') {
                rgb(cr, C.purple); rr(cr, pr.x - 14, pr.y - 9, 28, 14, 2); cr.fill();
                cr.setSourceRGBA(0.96, 0.96, 0.93, 1); cr.rectangle(pr.x - 12, pr.y - 8, 11, 11); cr.fill(); cr.rectangle(pr.x + 1, pr.y - 8, 11, 11); cr.fill();
                cr.setSourceRGBA(0.6, 0.62, 0.68, 1); cr.setLineWidth(0.8);
                for (let k = 0; k < 3; k++) { cr.moveTo(pr.x - 10, pr.y - 5 + k * 3); cr.lineTo(pr.x - 3, pr.y - 5 + k * 3); cr.moveTo(pr.x + 3, pr.y - 5 + k * 3); cr.lineTo(pr.x + 10, pr.y - 5 + k * 3); }
                cr.stroke();
                if (pr.page) { cr.setSourceRGBA(0.96, 0.96, 0.93, 1); cr.moveTo(pr.x, pr.y - 8); cr.lineTo(pr.x + 8, pr.y - 13); cr.lineTo(pr.x + 9, pr.y - 2); cr.closePath(); cr.fill(); }
            } else if (pr.kind === 'cloth') {
                rgb(cr, C.teal); cr.newSubPath(); cr.arc(pr.x, pr.y, 4, 0, 2 * Math.PI); cr.fill();
                cr.setSourceRGBA(1, 1, 1, 0.8);
                const k = Math.sin(t * 8);
                cr.newSubPath(); cr.arc(pr.x + 8, pr.y - 6 + k * 2, 1.2, 0, 2 * Math.PI); cr.fill();   // sparkle
            }
            rgb(cr, col); cr.setLineWidth(2.5);
        }
        if (m === 'doze') {
            rgb(cr, C.glow); cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(9); cr.moveTo(14, y - 2 - ((t * 8) % 8)); cr.showText('z');
            rgb(cr, col);
        }
        if (m === 'phones') {
            rgb(cr, C.happy); cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            cr.setFontSize(14); cr.moveTo(-30 + Math.sin(t * 4) * 3, y - 6); cr.showText('♪');
            rgb(cr, col);
        }

        // battery: shows when tired, and charges while it sleeps
        const en = b.energy ?? 100;
        if ((en < 40 || (sleeping && en < 99)) && m !== 'held') {
            const bx = x + w + 4, by = y - 10;
            cr.setSourceRGBA(0.85, 0.87, 0.9, 0.9); cr.setLineWidth(1.2);
            rr(cr, bx, by, 14, 7, 1.5); cr.stroke(); cr.rectangle(bx + 14, by + 2, 1.6, 3); cr.fill();
            const lvl = en < 15 ? [1, 0.35, 0.35] : en < 40 ? [1, 0.72, 0.3] : [0.45, 0.9, 0.5];
            cr.setSourceRGBA(lvl[0], lvl[1], lvl[2], 1); cr.rectangle(bx + 1.5, by + 1.5, 11 * en / 100, 4); cr.fill();
            if (sleeping) {
                cr.setSourceRGBA(1, 0.9, 0.3, 1);
                cr.moveTo(bx + 8, by - 6); cr.lineTo(bx + 5, by - 1); cr.lineTo(bx + 8, by - 1); cr.lineTo(bx + 6, by + 3);
                cr.lineTo(bx + 10, by - 2); cr.lineTo(bx + 7, by - 2); cr.closePath(); cr.fill();
            }
            rgb(cr, col); cr.setLineWidth(2.5);
        }

        // extras
        if (sleeping) {
            rgb(cr, C.glow);
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            for (let i = 0; i < 3; i++) {
                const p = (t * 0.5 + i / 3) % 1;
                cr.setSourceRGBA(C.glow[0], C.glow[1], C.glow[2], 1 - p);
                cr.setFontSize(10 + i * 4);
                cr.moveTo(14 + p * 16, y - 4 - p * 28); cr.showText('z');
            }
        }
        if (m === 'dance') {
            rgb(cr, C.happy);
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD); cr.setFontSize(16);
            cr.moveTo(-34, y - 4 + Math.sin(t * 6) * 4); cr.showText('♪');
            cr.moveTo(24, y - 8 - Math.sin(t * 6) * 4); cr.showText('♫');
        }
    }

    // Effects drawn behind the buddy, unaffected by its pose.
    _drawBackdrop(cr, b) {
        const t = b.t, m = b.mode;
        if (m === 'hammock') {
            cr.setSourceRGBA(0.45, 0.32, 0.2, 1); cr.setLineWidth(3);
            for (const px2 of [-58, 58]) { cr.moveTo(px2, 0); cr.lineTo(px2, -62); cr.stroke(); }   // posts
            const sw = Math.sin(t * 1.2) * 4;
            cr.setSourceRGBA(0.85, 0.55, 0.3, 1); cr.setLineWidth(5);
            cr.moveTo(-58, -58); cr.curveTo(-30 + sw, -10, 30 + sw, -10, 58, -58); cr.stroke();   // the net
            cr.setSourceRGBA(0.95, 0.8, 0.5, 0.8); cr.setLineWidth(1);
            for (let k = -2; k <= 2; k++) { cr.moveTo(k * 14 + sw, -18); cr.lineTo(k * 18, -50); } cr.stroke();
        }
        if (m === 'clouds') {
            cr.setSourceRGBA(1, 1, 1, 0.9);
            for (let k = 0; k < 3; k++) {
                const cx2 = ((t * 7 + k * 75) % 230) - 115, cy2 = -110 - k * 14;
                for (const [ox, r2] of [[-7, 6], [0, 8], [8, 6]]) { cr.newSubPath(); cr.arc(cx2 + ox, cy2, r2, 0, 2 * Math.PI); cr.fill(); }
            }
        }
        if (m === 'sunbathe') {
            for (let k = 0; k < 6; k++) {   // a striped beach towel
                if (k % 2) cr.setSourceRGBA(0.98, 0.98, 0.95, 1); else cr.setSourceRGBA(0.95, 0.4, 0.45, 1);
                cr.rectangle(-48 + k * 16, -3, 16, 4); cr.fill();
            }
            cr.setSourceRGBA(1, 0.85, 0.3, 0.9); cr.newSubPath(); cr.arc(70, -110, 9, 0, 2 * Math.PI); cr.fill();   // the sun
        }
        if (m === 'drape') {   // arms dangling down over the front of the window it lies on
            cr.setSourceRGBA(0.184, 0.196, 0.231, 1); cr.setLineWidth(5); cr.setLineCap(Cairo.LineCap.ROUND);
            for (const ax of [-b.dir * 26, -b.dir * 12]) { cr.moveTo(ax, -6); cr.lineTo(ax + Math.sin(t * 1.3 + ax) * 1.5, 9); cr.stroke(); }
            rgb(cr, C.hand); for (const ax of [-b.dir * 26, -b.dir * 12]) { cr.newSubPath(); cr.arc(ax + Math.sin(t * 1.3 + ax) * 1.5, 10, 3.5, 0, 2 * Math.PI); cr.fill(); }
        }
        if (m === 'pizza') {
            const pt2 = b.pizzaT ?? 0, bx2 = b.dir * 34;
            if (pt2 < 3.2) {   // the delivery drone: flies down, drops the box, flies off
                const dy2 = pt2 < 1.6 ? -150 + pt2 / 1.6 * 110 : -40 - (pt2 - 1.6) * 90, dx2 = bx2 + (pt2 > 1.6 ? (pt2 - 1.6) * 60 * b.dir : 0);
                cr.setSourceRGBA(0.35, 0.37, 0.42, 1); rr(cr, dx2 - 9, dy2 - 3, 18, 6, 2); cr.fill();
                cr.setSourceRGBA(0.6, 0.62, 0.68, 0.8);
                for (const rx2 of [-11, 11]) { cr.save(); cr.translate(dx2 + rx2, dy2 - 5); cr.scale(1, 0.25); cr.newSubPath(); cr.arc(0, 0, 6 + Math.sin(t * 40) * 1, 0, 2 * Math.PI); cr.restore(); cr.fill(); }
                if (pt2 < 1.6) { cr.setSourceRGBA(0.75, 0.55, 0.3, 1); cr.rectangle(dx2 - 7, dy2 + 3, 14, 4); cr.fill(); }
            }
            if (pt2 >= 1.6) {   // the box on the floor, lid open once it is eating
                cr.setSourceRGBA(0.75, 0.55, 0.3, 1); cr.rectangle(bx2 - 9, -5, 18, 5); cr.fill();
                if (pt2 > 2.4) { cr.save(); cr.translate(bx2 - 9, -5); cr.rotate(-1.2); cr.rectangle(0, -1, 18, 2); cr.restore(); cr.fill();
                    cr.setSourceRGBA(0.95, 0.75, 0.3, 1); cr.rectangle(bx2 - 7, -6, 14, 2); cr.fill(); }
            }
        }
        if (m === 'coffeedrip') {   // a slow drip coffee maker, one drop at a time
            const cx2 = b.dir * 36;
            cr.setSourceRGBA(0.8, 0.82, 0.86, 1); cr.moveTo(cx2 - 8, -30); cr.lineTo(cx2 + 8, -30); cr.lineTo(cx2 + 2, -22); cr.lineTo(cx2 - 2, -22); cr.closePath(); cr.fill();
            cr.setSourceRGBA(0.5, 0.52, 0.56, 1); cr.rectangle(cx2 - 1, -36, 2, 6); cr.fill(); cr.rectangle(cx2 - 9, -36, 18, 2); cr.fill();
            cr.setSourceRGBA(0.93, 0.94, 0.96, 1); rr(cr, cx2 - 5, -10, 10, 10, 2); cr.fill();
            cr.setSourceRGBA(0.4, 0.25, 0.12, 1); cr.rectangle(cx2 - 4, -10 + 9 * (1 - Math.min(1, (12 - b.actT) / 12)), 8, 9 * Math.min(1, (12 - b.actT) / 12)); cr.fill();
            const q = (t * 0.6) % 1; cr.newSubPath(); cr.arc(cx2, -22 + q * 12, 1.2, 0, 2 * Math.PI); cr.fill();
        }
        if (m === 'sheep') {   // sheep hopping over a fence above its head
            const fx2 = -b.dir * 10, fy2 = -70;
            cr.setSourceRGBA(0.6, 0.45, 0.3, 1); cr.setLineWidth(1.5);
            cr.moveTo(fx2 - 8, fy2); cr.lineTo(fx2 + 8, fy2); cr.moveTo(fx2 - 8, fy2 - 5); cr.lineTo(fx2 + 8, fy2 - 5);
            cr.moveTo(fx2 - 6, fy2 + 2); cr.lineTo(fx2 - 6, fy2 - 9); cr.moveTo(fx2 + 6, fy2 + 2); cr.lineTo(fx2 + 6, fy2 - 9); cr.stroke();
            const q = ((b.sheepT ?? 0) % 2.6) / 2.6;
            if ((b.sheepN ?? 0) < 5) {
                const sx2 = fx2 - 30 + q * 60, sy2 = fy2 - 2 - Math.sin(q * Math.PI) * 18;
                cr.setSourceRGBA(1, 1, 1, 1); for (const [ox, oy] of [[-3, 0], [0, -2], [3, 0], [0, 1.5]]) { cr.newSubPath(); cr.arc(sx2 + ox, sy2 + oy, 3, 0, 2 * Math.PI); cr.fill(); }
                cr.setSourceRGBA(0.2, 0.2, 0.22, 1); cr.newSubPath(); cr.arc(sx2 + 5, sy2 - 1, 1.8, 0, 2 * Math.PI); cr.fill();
            }
        }
        if (m === 'rocking') {   // the rocking chair, rocking with it
            cr.save(); cr.translate(0, -8 * 0); cr.rotate(Math.sin(t * 1.4) * 0.07);
            cr.setSourceRGBA(0.5, 0.33, 0.2, 1); cr.setLineWidth(3);
            cr.moveTo(-34, -2); cr.curveTo(-15, 4, 15, 4, 34, -2); cr.stroke();               // rocker
            cr.rectangle(-28, -16, 56, 4); cr.fill();                                         // seat
            cr.moveTo(-24, -2); cr.lineTo(-24, -14); cr.moveTo(24, -2); cr.lineTo(24, -14); cr.stroke();
            const bk = -b.dir * 28; cr.moveTo(bk, -14); cr.lineTo(bk - b.dir * 4, -62); cr.stroke();   // back
            cr.restore();
        }
        if (m === 'pillownap') {   // a pillow under its head
            const px2 = -b.dir * 46;
            cr.setSourceRGBA(0.96, 0.96, 1, 1); rr(cr, px2 - 13, -12, 26, 11, 5); cr.fill();
            cr.setSourceRGBA(0.75, 0.78, 0.9, 1); cr.setLineWidth(0.8); rr(cr, px2 - 13, -12, 26, 11, 5); cr.stroke();
        }
        if (m === 'charging') {   // plugged into a little socket, battery filling
            const sx2 = -b.dir * 48;
            cr.setSourceRGBA(0.9, 0.9, 0.92, 1); rr(cr, sx2 - 6, -16, 12, 14, 2); cr.fill();
            cr.setSourceRGBA(0.2, 0.2, 0.25, 1); cr.rectangle(sx2 - 2.5, -11, 1.5, 4); cr.rectangle(sx2 + 1, -11, 1.5, 4); cr.fill();
            cr.setSourceRGBA(0.15, 0.15, 0.18, 1); cr.setLineWidth(1.6);
            cr.moveTo(-b.dir * 24, -20); cr.curveTo(-b.dir * 34, -2, sx2 + b.dir * 8, 0, sx2, -9); cr.stroke();
            const k2 = (t * 0.15) % 1;
            cr.setSourceRGBA(0.3, 0.3, 0.35, 1); cr.setLineWidth(1.4); rr(cr, -10, -84, 18, 9, 2); cr.stroke(); cr.rectangle(8, -81.5, 2, 4); cr.fill();
            cr.setSourceRGBA(0.4, 0.85, 0.4, 1); cr.rectangle(-8.5, -82.5, 15 * k2, 6); cr.fill();
        }
        if (m === 'lean') {   // a fence post to lean on
            const px2 = b.dir * 34;
            cr.setSourceRGBA(0.55, 0.38, 0.22, 1); rr(cr, px2 - 3, -46, 6, 46, 1.5); cr.fill();
            cr.setSourceRGBA(0.45, 0.3, 0.17, 1); cr.rectangle(px2 - 5, -47, 10, 3); cr.fill();
        }
        if (m === 'bubbles') {   // soap bubbles floating up from its face, popping
            for (let k = 0; k < 6; k++) {
                const q = (t * 0.35 + k / 6) % 1, bx2 = -b.dir * 42 + Math.sin(q * 6 + k) * 10 + b.dir * q * 30, by2 = -24 - q * 110, r2 = 2 + q * 4;
                if (q > 0.92) continue;   // popped
                cr.setSourceRGBA(0.7, 0.85, 1, 0.35); cr.newSubPath(); cr.arc(bx2, by2, r2, 0, 2 * Math.PI); cr.fill();
                cr.setSourceRGBA(1, 0.7, 0.9, 0.7); cr.setLineWidth(0.7); cr.newSubPath(); cr.arc(bx2, by2, r2, 0, 2 * Math.PI); cr.stroke();
            }
        }
        if (m === 'snore') {   // Zzz getting bigger as they float up, and a little whistle
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
            for (let k = 0; k < 3; k++) {
                const q = (t * 0.3 + k / 3) % 1;
                cr.setSourceRGBA(0.49, 0.94, 0.83, 1 - q); cr.setFontSize(7 + q * 12);
                cr.moveTo(-b.dir * 40 + b.dir * q * 26, -26 - q * 70); cr.showText('Z');
            }
            if (Math.sin(t * 1.6) > 0.6) { cr.setSourceRGBA(0.6, 0.62, 0.7, 0.8); cr.setFontSize(9); cr.moveTo(-b.dir * 62, -22); cr.showText('~'); }
        }
        if (m === 'pool') {   // a puddle pool and an inflatable ring
            cr.setSourceRGBA(0.35, 0.65, 0.95, 0.6); cr.save(); cr.scale(1, 0.18); cr.newSubPath(); cr.arc(0, -10, 62, 0, 2 * Math.PI); cr.restore(); cr.fill();
            cr.setSourceRGBA(1, 1, 1, 0.5); cr.setLineWidth(0.8);
            for (let k = 0; k < 3; k++) { const q = (t * 0.5 + k / 3) % 1; cr.save(); cr.scale(1, 0.18); cr.newSubPath(); cr.arc(0, -10, 30 + q * 30, 0, 2 * Math.PI); cr.restore(); cr.stroke(); }
            for (let k = 0; k < 8; k++) {
                if (k % 2) cr.setSourceRGBA(1, 1, 1, 1); else cr.setSourceRGBA(0.95, 0.3, 0.3, 1);
                cr.save(); cr.translate(0, -5); cr.scale(1, 0.35); cr.newSubPath(); cr.arc(0, 0, 40, k * Math.PI / 4, (k + 1) * Math.PI / 4); cr.restore(); cr.setLineWidth(7); cr.stroke();
            }
        }
        if (m === 'daydream') {
            const d2 = b.dir, bx2 = d2 * 40, by2 = -100;
            cr.setSourceRGBA(1, 1, 1, 0.95);
            cr.newSubPath(); cr.arc(d2 * 16, -66, 2.5, 0, 2 * Math.PI); cr.fill();
            cr.newSubPath(); cr.arc(d2 * 24, -76, 4, 0, 2 * Math.PI); cr.fill();
            for (const [ox, oy, r2] of [[-12, 0, 11], [0, -6, 13], [13, 0, 11], [0, 6, 11]]) { cr.newSubPath(); cr.arc(bx2 + ox, by2 + oy, r2, 0, 2 * Math.PI); cr.fill(); }
            if (b.dream === 'pizza') {
                cr.setSourceRGBA(0.95, 0.75, 0.3, 1); cr.moveTo(bx2 - 8, by2 - 6); cr.lineTo(bx2 + 8, by2 - 6); cr.lineTo(bx2, by2 + 9); cr.closePath(); cr.fill();
                cr.setSourceRGBA(0.85, 0.2, 0.2, 1); for (const [px2, py2] of [[-3, -3], [3, -2], [0, 3]]) { cr.newSubPath(); cr.arc(bx2 + px2, by2 + py2, 1.5, 0, 2 * Math.PI); cr.fill(); }
            } else if (b.dream === 'beach') {
                cr.setSourceRGBA(1, 0.8, 0.2, 1); cr.newSubPath(); cr.arc(bx2 + 5, by2 - 4, 4, 0, 2 * Math.PI); cr.fill();
                cr.setSourceRGBA(0.3, 0.6, 0.95, 1); cr.setLineWidth(2);
                cr.moveTo(bx2 - 10, by2 + 5); cr.curveTo(bx2 - 5, by2 + 2, bx2, by2 + 8, bx2 + 10, by2 + 4); cr.stroke();
            } else {
                cr.setSourceRGBA(0.3, 0.3, 0.35, 1); cr.setLineWidth(1.4); rr(cr, bx2 - 9, by2 - 5, 16, 10, 2); cr.stroke(); cr.rectangle(bx2 + 7, by2 - 2, 2, 4); cr.fill();
                cr.setSourceRGBA(0.4, 0.85, 0.4, 1); cr.rectangle(bx2 - 7, by2 - 3, 12 * ((t * 0.4) % 1), 6); cr.fill();   // charging
            }
        }
        if (m === 'splash') {
            cr.setSourceRGBA(0.45, 0.65, 0.95, 0.55); cr.save(); cr.scale(1, 0.12); cr.newSubPath(); cr.arc(0, -4, 38, 0, 2 * Math.PI); cr.restore(); cr.fill();
            const q = ((t * 5) % Math.PI) / Math.PI;   // 0 at each landing
            if (q < 0.4) {
                cr.setSourceRGBA(0.55, 0.75, 1, 0.9 * (1 - q / 0.4));
                for (let k = 0; k < 7; k++) {
                    const a = Math.PI * (0.1 + 0.8 * k / 6), dd = 8 + q * 60;
                    cr.newSubPath(); cr.arc(Math.cos(a) * dd * (k % 2 ? 1 : -1) * 0.9, -Math.sin(a) * dd * 0.6 + q * q * 40, 1.6, 0, 2 * Math.PI); cr.fill();
                }
            }
        }
        if (m === 'movie' && b.movie) {
            // the sofa, dragged in from behind it and slid away afterwards
            const mv = b.movie;
            cr.save(); cr.translate(-b.dir * (1 - mv.k) * 160, 0);
            if (mv.dawnAt !== undefined && b.t - mv.dawnAt < 40) {   // the sun coming up behind the sofa
                const k = Math.min(1, (b.t - mv.dawnAt) / 6), sy2 = -10 - k * 62;
                cr.setSourceRGBA(1, 0.75, 0.3, 0.35 * k);
                for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + b.t * 0.3; cr.moveTo(-75 + Math.cos(a) * 14, sy2 + Math.sin(a) * 14); cr.lineTo(-75 + Math.cos(a) * 22, sy2 + Math.sin(a) * 22); }
                cr.setLineWidth(2.5); cr.stroke();
                cr.setSourceRGBA(1, 0.78, 0.3, 0.9); cr.newSubPath(); cr.arc(-75, sy2, 11, 0, 2 * Math.PI); cr.fill();
            }
            cr.setSourceRGBA(0.28, 0.2, 0.16, 1); for (const fx of [-42, 38]) { rr(cr, fx, -5, 4, 5, 1); cr.fill(); }
            cr.setSourceRGBA(0.47, 0.22, 0.26, 1); rr(cr, -38, -52, 76, 42, 10); cr.fill();      // backrest
            cr.setSourceRGBA(0.6, 0.29, 0.33, 1); rr(cr, -43, -19, 86, 15, 5); cr.fill();        // seat
            cr.setSourceRGBA(0, 0, 0, 0.15); cr.setLineWidth(1); cr.moveTo(0, -18); cr.lineTo(0, -5); cr.stroke();
            cr.setSourceRGBA(0.6, 0.29, 0.33, 1); rr(cr, -49, -33, 13, 29, 6); cr.fill(); rr(cr, 36, -33, 13, 29, 6); cr.fill();   // arms
            cr.setSourceRGBA(1, 1, 1, 0.12); rr(cr, -47, -32, 9, 3, 1.5); cr.fill(); rr(cr, 38, -32, 9, 3, 1.5); cr.fill(); rr(cr, -34, -50, 68, 3, 1.5); cr.fill();
            if (b.movie.phase === 'watch' && !['sip', 'open'].includes(b.movie.react?.kind)) { const bb = b.movie.beer ?? {left: 1, open: false}; cr.save(); cr.translate(43, -33); drawBeer(cr, bb.left, bb.open); cr.restore(); }   // its beer on the armrest
            // episode tally chalked on the seat front, in fives, either side of its legs
            cr.setSourceRGBA(1, 0.95, 0.85, 0.85); cr.setLineWidth(1.3);
            for (let i = 0; i < Math.min(20, mv.eps ?? 0); i++) {
                const g = Math.floor(i / 5), j = i % 5, gx = [-41, 27, -41, 27][g], gy = g < 2 ? 0 : -9;
                if (j < 4) { cr.moveTo(gx + j * 3, gy - 15); cr.lineTo(gx + j * 3, gy - 9); } else { cr.moveTo(gx - 1.5, gy - 10); cr.lineTo(gx + 10.5, gy - 14); }
            }
            cr.stroke();
            // the pillow fort: cushions pile up as the hours go by
            const CUSH = [[-28, -54, 0.2, [0.95, 0.75, 0.3]], [24, -54, -0.25, [0.4, 0.7, 0.9]], [-41, -36, 0.5, [0.85, 0.45, 0.6]], [41, -40, -0.5, [0.55, 0.8, 0.5]], [-6, -58, 0.05, [0.9, 0.6, 0.35]], [12, -62, -0.15, [0.7, 0.55, 0.9]]];
            for (const [cx2, cy2, rot, c] of CUSH.slice(0, mv.cushions ?? 0)) {
                cr.save(); cr.translate(cx2, cy2); cr.rotate(rot);
                cr.setSourceRGBA(c[0], c[1], c[2], 1); rr(cr, -9, -6, 18, 12, 4); cr.fill();
                cr.setSourceRGBA(1, 1, 1, 0.25); cr.newSubPath(); cr.arc(0, 0, 1.4, 0, 2 * Math.PI); cr.fill();
                cr.restore();
            }
            if (mv.away) { cr.save(); cr.translate(-14, -19); cr.scale(0.75, 0.75); if (mv.pizza) drawPizzaBox(cr, mv.pop ?? 1); else drawPopcorn(cr, mv.pop ?? 1); cr.restore(); }   // left on the seat
            if (Date.now() < (mv.milkUntil ?? 0)) { cr.save(); cr.translate(-43, -33); drawMilk(cr); cr.restore(); }
            // the empties pile up on the floor; picked up when a long session ends
            const pk = mv.phase === 'out' && mv.long ? Math.max(0, Math.min(1, (mv.outT - 1.6) / 0.8)) : 1;
            const cans = Math.round(Math.min(5, mv.cans ?? 0) * pk), tubs = Math.round(Math.min(5, mv.tubs ?? 0) * pk);
            for (let i = 0; i < cans; i++) { cr.save(); cr.translate(56 + i * 6, -2 - (i % 2) * 3); cr.rotate(Math.PI / 2 + (i % 2 ? 0.3 : -0.2)); drawBeer(cr, 0, true); cr.restore(); }
            for (let i = 0; i < tubs; i++) {
                cr.save(); cr.translate(-60 - (i % 3) * 9, -Math.floor(i / 3) * 9); cr.rotate((i % 2 ? 0.25 : -0.15)); cr.scale(0.55, 0.55);
                if (mv.pizza && i === tubs - 1) drawPizzaBox(cr, 0); else drawPopcorn(cr, 0);
                cr.restore();
            }
            cr.restore();
        }
        if (m === 'disco') {
            const cols = [[1, 0.3, 0.5], [0.3, 0.8, 1], [1, 0.85, 0.3], [0.6, 1, 0.4]];
            for (let i = 0; i < 4; i++) {
                const a = t * 2 + i * Math.PI / 2, c = cols[i];
                cr.setSourceRGBA(c[0], c[1], c[2], 0.22);
                cr.moveTo(0, -118); cr.lineTo(Math.cos(a) * 90 - 10, 0); cr.lineTo(Math.cos(a) * 90 + 10, 0); cr.closePath(); cr.fill();
                cr.setSourceRGBA(c[0], c[1], c[2], 0.5);
                cr.save(); cr.translate(Math.cos(a) * 90, -2); cr.scale(2.4, 0.6); cr.newSubPath(); cr.arc(0, 0, 6, 0, 2 * Math.PI); cr.restore(); cr.fill();
            }
            cr.setSourceRGBA(0.8, 0.82, 0.88, 1); cr.newSubPath(); cr.arc(0, -118, 8, 0, 2 * Math.PI); cr.fill();
            cr.setSourceRGBA(1, 1, 1, 0.9);
            for (let k = 0; k < 5; k++) { const a = t * 3 + k; cr.newSubPath(); cr.arc(Math.cos(a) * 5, -118 + Math.sin(a) * 5, 1, 0, 2 * Math.PI); cr.fill(); }
        }
        if (m === 'trampoline') {
            const low = 1 - Math.abs(Math.sin(t * 6));
            cr.setSourceRGBA(0.2, 0.21, 0.25, 1); cr.setLineWidth(2.5);
            cr.moveTo(-22, -10); cr.lineTo(-26, 0); cr.moveTo(22, -10); cr.lineTo(26, 0); cr.stroke();
            rgb(cr, C.purple); cr.save(); cr.translate(0, -10 + low * 4); cr.scale(1, 0.18 + low * 0.15);
            cr.newSubPath(); cr.arc(0, 0, 26, 0, 2 * Math.PI); cr.restore(); cr.fill();
        }
        if (m === 'ufo' && b.ufo) {
            const k = b.ufo.k;
            const uy = k < 1 ? -170 + k * 40 : k < 3.2 ? -130 : -130 - (k - 3.2) * 120;
            const ux = k > 3.2 ? (k - 3.2) * 160 : 0;
            if (k > 1 && k < 3.2) {
                cr.setSourceRGBA(0.6, 1, 0.6, 0.22);
                cr.moveTo(ux - 9, uy + 6); cr.lineTo(ux + 9, uy + 6); cr.lineTo(ux + 30, 0); cr.lineTo(ux - 30, 0); cr.closePath(); cr.fill();
            }
            cr.setSourceRGBA(0.55, 0.85, 0.95, 0.9); cr.newSubPath(); cr.arc(ux, uy - 3, 8, Math.PI, 2 * Math.PI); cr.fill();
            cr.setSourceRGBA(0.6, 0.62, 0.68, 1); cr.save(); cr.translate(ux, uy); cr.scale(1, 0.28); cr.newSubPath(); cr.arc(0, 0, 28, 0, 2 * Math.PI); cr.restore(); cr.fill();
            for (let i = -2; i <= 2; i++) {
                const on = Math.floor(t * 6 + i) % 2 === 0;
                cr.setSourceRGBA(1, on ? 0.9 : 0.4, 0.3, 1); cr.newSubPath(); cr.arc(ux + i * 10, uy + 2, 1.6, 0, 2 * Math.PI); cr.fill();
            }
        }
        if (m === 'teleport' && b.tele) {
            for (let i = 0; i < 6; i++) {
                const a = i * 1.05, r = 10 + b.tele.k * 30;
                cr.setSourceRGBA(0.85, 0.86, 0.9, 0.5 * (1 - Math.abs(b.tele.k - 0.5) * 2));
                cr.newSubPath(); cr.arc(Math.cos(a) * r, -30 + Math.sin(a) * r * 0.6, 7, 0, 2 * Math.PI); cr.fill();
            }
        }
        if (Date.now() < (b.chuteDustUntil ?? 0)) {   // parachute touchdown: dust puffs rolling outwards
            const q = 1 - (b.chuteDustUntil - Date.now()) / 500;
            cr.setSourceRGBA(0.82, 0.78, 0.7, 0.55 * (1 - q));
            for (const s of [-1, 1]) for (const k of [0, 1]) {
                cr.newSubPath(); cr.arc(s * (14 + q * 22 + k * 8), -4 - k * 3 - q * 3, 4 + q * 5 - k, 0, 2 * Math.PI); cr.fill();
            }
        }
        if (Date.now() < (b.quakeUntil ?? 0)) {
            cr.setSourceRGBA(0.3, 0.25, 0.2, 0.8); cr.setLineWidth(1.4);   // cracks and dust at its feet
            for (const s of [-1, 1]) { cr.moveTo(s * 6, 0); cr.lineTo(s * 16, -3); cr.lineTo(s * 26, 1); cr.stroke(); }
            cr.setSourceRGBA(0.8, 0.75, 0.65, 0.5);
            for (const s of [-1, 1]) { cr.newSubPath(); cr.arc(s * 22, -5, 5, 0, 2 * Math.PI); cr.fill(); }
        }
    }

    // A pulled limb: thins as it stretches and sags a little, like rubber.
    _rubberLimb(cr, L, tip, rest = L.rest) {
        const [bx, by] = L.base, [tx, ty] = tip;
        const stretch = Math.hypot(tx - rest[0], ty - rest[1]);
        const width = L.width * Math.max(0.35, 1 / (1 + stretch / 80));
        const mx = (bx + tx) / 2, my = (by + ty) / 2 + Math.min(10, stretch / 10);
        rgb(cr, C.limb); cr.setLineWidth(width); cr.setLineCap(Cairo.LineCap.ROUND);
        cr.moveTo(bx, by); cr.curveTo(mx, my, mx, my, tx, ty); cr.stroke();
        if (L.kind === 'arm') {
            rgb(cr, C.hand); cr.newSubPath(); cr.arc(tx, ty, 4.5, 0, 2 * Math.PI); cr.fill();
        } else {
            rgb(cr, C.foot); rr(cr, tx - 9, ty - 4, 18, 7, 3); cr.fill();
            rgb(cr, C.stripe); rr(cr, tx - 8, ty + 1.5, 16, 2, 1); cr.fill();
        }
    }

    _drawBubble(cr, b) {
        if (!this._bubble.text || Date.now() > this._bubble.until || b.mode === 'sleep' || b.mode === 'emerge' ||
            !/[\p{L}\p{N}♥♪♫]/u.test(this._bubble.text))
            return;
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(13);
        // Wrap to lines no wider than the actor allows.
        const maxW = AW - 30, lines = [];
        let line = '';
        for (const word of this._bubble.text.split(' ')) {
            const tryLine = line ? `${line} ${word}` : word;
            if (line && cr.textExtents(tryLine).width > maxW) { lines.push(line); line = word; } else line = tryLine;
        }
        if (line) lines.push(line);
        const shown = lines.slice(0, 6);
        if (lines.length > 6) shown[5] = `${shown[5].replace(/[\s.,;:]*$/, '')}…`;
        const tw = Math.max(...shown.map(l => cr.textExtents(l).width)) + 16;
        const th = 8 + shown.length * 16;
        const bx = Math.max(-AW / 2 + 2, Math.min(AW / 2 - tw - 2, -tw / 2));
        const by = -(BH + 32) * S - th;
        cr.setSourceRGBA(0.93, 0.94, 0.96, 0.95); rr(cr, bx, by, tw, th, 8); cr.fill();
        cr.setSourceRGBA(0.07, 0.08, 0.1, 1);
        shown.forEach((l, k) => { cr.moveTo(bx + 8, by + 17 + k * 16); cr.showText(l); });
    }
}
