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
const CHUTE_SPEED = 140;
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
// A drop this high (but below the parachute line) knocks its arms and legs
// off. Cartoon style: they bounce away, then hop back and snap on again.
const BREAK_FROM = 0.55, BREAK_SECS = 6, REJOIN_SECS = 2.2;
const LIMP_SECS = 20;
const MAX_CLIMB = 220, MAX_FLY = 520; // taller than MAX_FLY: walks on behind the window
const IDLE_MS = 90 * 1000;
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
const POMO_FOCUS = 25, POMO_SHORT = 5, POMO_LONG = 15, POMO_ROUNDS = 4;   // Pomodoro cycle
const FOCUS_HOLD_MS = 1000;           // press and hold this long to start or stop focus
const MEETING_WARN_MIN = 5;
const BREAK_AFTER_MIN = 90, BREAK_IDLE_RESET_MIN = 5, BREAK_NAG_EVERY_MIN = 10;
const EOD_HOUR = 19;
const PROJECTS = GLib.build_filenamev([GLib.get_home_dir(), 'msquaredclub', 'Projects']);
const RUN_SPEED = 2.3;
const TOUCH_QUIET_MS = 4000;   // no sound effects this long after you touch or throw it
const STAY_SIT_S = 20, STAY_SLEEP_S = 60;   // staying: waits, then sits, then sleeps

// Who may interrupt whom. A nudge or trick only takes over when the current
// mode's priority is not higher than its own; physics and your hands always win.
const PRIORITY = {
    held: 100, thrown: 100, stretched: 100, snapback: 95,
    fall: 90, jump: 90, chute: 90, emerge: 90, tumble: 90, broken: 90, knocked: 90,
    climb: 85, fly: 85, prejump: 85,
    cry: 80, angry: 80, dizzy: 80, laugh: 75, shy: 75,
    meeting: 70, focus: 70,
    stay: 60, poked: 60, wake: 60, tease: 60,
    watch: 40, alert: 40,
    play: 30,
    dance: 20, wave: 20, sit: 20, love: 20, look: 20, coffee: 20, book: 20, polish: 20, doze: 20, phones: 20,
    // tricks from section 17 of the upgrade suggestions
    smoke: 20, banana: 20, shoot: 20, typing: 20, clean: 20, gum: 20, plane: 20, sneeze: 20, fish: 20, paint: 20,
    highfive: 30, pose: 30, rocket: 88, juggle: 20, guitar: 25, bedtime: 15,
    tailchase: 20, mimewall: 20, derp: 20,
    snowball: 20, magic: 20, kite: 20, command: 20, fort: 20, hiccups: 25, cake: 20, raindance: 20,
    bugchase: 85, wallrun: 85, mirror: 30, hang: 85, slide: 85, jetfail: 85, tarzan: 85, ufo: 88, teleport: 85, stuck: 90, handstand: 25,
    detective: 20, fakesleep: 20, selfie: 20, peek: 20, laughattack: 25, freeze: 20, ghost: 20,
    clones: 25, army: 25, disco: 25, rebel: 60, boing: 60, trampoline: 25, dizzydance: 20, acrobat: 90,
    sleep: 15, walk: 10, duck: 10,
};
// Calm modes redraw at a third of the rate.
const CALM = new Set(['sleep', 'stay', 'meeting', 'focus', 'sit', 'coffee', 'book', 'doze', 'smoke', 'banana']);
// How often it does a trick on its own, by the activity level in the tile menu.
const ACTIVITY = {off: null, low: [20000, 35000], normal: [8000, 16000], high: [4000, 8000]};
const ACTIVITY_ORDER = ['low', 'normal', 'high', 'off'];
// Tricks that move it along a path; they run their own step.
const MOVING_TRICKS = new Set(['handstand', 'slide', 'hang', 'jetfail', 'tarzan', 'ufo', 'teleport', 'stuck', 'rocket',
    'bugchase', 'wallrun', 'mirror']);
// Weather for its outfit. wttr.in works out the place from the connection;
// nothing about you is sent. Checked every 30 minutes; switch off in the menu.
const WEATHER_URL = 'https://wttr.in/?format=%C|%t|%w';
const WEATHER_EVERY_MS = 30 * 60000;
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
            this.focus50 = new PopupMenu.PopupMenuItem('Focus 50 min');
            this.standupNow = new PopupMenu.PopupMenuItem('Stand-up summary now');
            this.uncommittedNow = new PopupMenu.PopupMenuItem('Check uncommitted work now');
            this.breakNow = new PopupMenu.PopupMenuItem('Remind me to take a break in 30 min');
            this.pomoItem = new PopupMenu.PopupMenuItem('Pomodoro (4 × 25 min)');
            this.wrapNow = new PopupMenu.PopupMenuItem('Daily wrap now (copies it)');
            this.nextNow = new PopupMenu.PopupMenuItem("What's next?");
            this.briefNow = new PopupMenu.PopupMenuItem('Brief me on today');
            this.playBall = new PopupMenu.PopupMenuItem('Play ball');
            this.followMe = new PopupMenu.PopupMenuItem('Follow me');
            this.stopPlay = new PopupMenu.PopupMenuItem('Stop playing');
            this.petNow = new PopupMenu.PopupMenuItem('Call the robot pet');
            this.surpriseNow = new PopupMenu.PopupMenuItem('Surprise me now');
            this.moonwalkNow = new PopupMenu.PopupMenuItem('Moonwalk');
            this.backwardsNow = new PopupMenu.PopupMenuItem('Walk backwards');
            this.onTopSwitch = new PopupMenu.PopupSwitchMenuItem('Show above windows', true);
            this.chattySwitch = new PopupMenu.PopupSwitchMenuItem('Chatty (talks about everything)', true);
            this.weatherSwitch = new PopupMenu.PopupSwitchMenuItem('Dress for the weather (wttr.in)', true);
            this.petSwitch = new PopupMenu.PopupSwitchMenuItem('Keep the robot pet around', false);
            this.surpriseSwitch = new PopupMenu.PopupSwitchMenuItem('Rare surprises', true);
            this.activityItem = new PopupMenu.PopupMenuItem('Activity: normal');
            this.achievements = new PopupMenu.PopupMenuItem('Secret tricks: 0 of 6');
            this.resetAchievements = new PopupMenu.PopupMenuItem('Reset secret tricks');
            this.nudgeSwitches = {};
            for (const [key, label] of NUDGES)
                this.nudgeSwitches[key] = new PopupMenu.PopupSwitchMenuItem(label, true);

            section('Productivity', [this.nextNow, this.briefNow, this.focus25, this.focus50, this.pomoItem, this.standupNow,
                this.wrapNow, this.uncommittedNow, this.breakNow]);
            section('Play', [this.moonwalkNow, this.backwardsNow, this.playBall, this.followMe, this.stopPlay, this.petNow, this.surpriseNow]);
            section('Settings', [this.onTopSwitch, this.chattySwitch, this.weatherSwitch, this.petSwitch, this.surpriseSwitch, this.activityItem]);
            section('Nudges', Object.values(this.nudgeSwitches));
            section('Secret tricks', [this.achievements, this.resetAchievements]);
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
            this._shares.add(handle);
            handle.connect('stopped', () => { this._shares.delete(handle); this._syncShare(); });
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
        this._lastInteract = Date.now();
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
    // planes, graffiti, the meeting card), and no game or Pomodoro carries on.
    _clearExtras() {
        this._ballGrab?.dismiss(); this._ballGrab = null;
        this._stopGame(false);
        this._removePeel();
        this._pet?.actor.destroy(); this._pet = null;
        for (const q of this._bullets ?? []) q.actor.destroy();
        this._bullets = [];
        for (const f of this._fx ?? []) f.actor.destroy();
        this._fx = [];
        this._hideCard();
    }

    disable() {
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
        for (const f of this._fx ?? []) f.actor.destroy();
        this._fx = [];
        this._hideCard();
        this._pomo = null;
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
        if (this._b.mode !== mode && MODE_SOUND[mode]) this._sound(MODE_SOUND[mode]);
        if (mode === 'stay' && this._b.mode !== 'stay') this._b.stayStart = Date.now();
        this._b.mode = mode; this._b.actT = secs;
    }

    // Robot sounds. Off with the Buddy sounds toggle, and quiet while Do Not
    // Disturb is on (meetings, focus), except the focus-done chime.
    _sound(name) {
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
            global.display.get_sound_player().play_from_file(f, 'Tiko', null);
        } catch {}
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
            if (!b.held)
                this._step(T, dt);
            if (this._ball)
                this._stepBall(T, dt);
            if (this._card)
                this._stepCard();
            if (this._bullets?.length)
                this._stepBullets(T, dt);
            if (this._peel)
                this._stepPeel(T, dt);
            if (this._fx.length)
                this._fx = this._fx.filter(f => { const alive = f.step(dt, T); if (!alive) f.actor.destroy(); return alive; });
            if (this._pet)
                this._stepPet(T, dt);
            if (this._T === T && ms - (this._tHigh ?? 0) >= 250) { this._tHigh = ms; this._checkHighFive(T); }
            if (!Number.isFinite(b.x) || !Number.isFinite(b.y))
                throw new Error('position became invalid');
            b.x = Math.max(T.ux0 + 20, Math.min(T.ux1 - 20, b.x));
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
            if (ms - (this._tSec ?? 0) >= 1000) { this._tSec = ms; this._everySecond(); }
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
        this._lastPtr = [px, py];
        const score = this._typeScore ?? 0;
        this._typeScore = idle < 350 && still ? Math.min(10, score + 1) : Math.max(0, score - (still ? 0.5 : 2));
        const b = this._b;
        const now = Date.now();
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
            else { this._set('angry', 3); this._say('Never do that again!', 2600); b.injury = {level: 2, until: Date.now() + 15000}; }
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
        if (b.on !== null && !['fall', 'jump', 'fly', 'climb', 'chute', 'thrown'].includes(b.mode)) {
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
                this._set('chute'); this._say('Phew, parachute!', 1400);
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
            const prevY = b.y;
            b.vy = Math.min(CHUTE_SPEED, b.vy + GRAV * dt);
            b.y += b.vy * dt;
            b.x += Math.cos(b.t * 1.4) * 22 * dt;
            const s = this._below(T, b.x, prevY);
            if (s && b.y >= s.top) {
                b.y = s.top; b.vy = 0; b.on = s.id;
                this._set('tease', 2.6); this._say('Nailed it. Hehe.', 2400);
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
            'raindance', 'tailchase', 'mimewall', 'derp'].includes(b.mode)) {
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
            if (b.mode === 'magic' && b.actT < 1.2 && !b.rabbit) { b.rabbit = true; this._sound('done'); }
            if (b.mode !== 'magic') b.rabbit = false;
            if (b.mode === 'juggle' && b.actT - dt <= 0 && b.dropBall) {
                // one ball comes down on its head
                b.dropBall = false; this._set('poked', 1); this._sound('thud'); this._say('Ow, my head!', 1200);
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
            if (b.mode === 'fish' && !b.caught && b.actT < 1.6) { b.caught = true; this._say('…a boot.', 1500); this._sound('boop'); }
            if (b.mode === 'gum' && !b.popped && b.actT < 1.1) { b.popped = true; this._sound('thud'); }
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
            const tx = this._game.kind === 'ball' ? this._ball?.x : global.get_pointer()[0];
            if (tx !== undefined) {
                const dx = tx - b.x;
                if (this._game.thief && Math.abs(dx) < 40) {
                    // Cursor thief: lunges at the pointer, misses
                    b.vy = -330; b.vx = 0; b.on = null; this._set('jump');
                    this._say('Got it! …nope.', 1400);
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
            this._nextAct = range ? nowMs + range[0] * (0.5 + Math.random()) + Math.random() * (range[1] - range[0]) : nowMs + 60000;
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
            } else if (b.wanderX === undefined || arrived || Math.random() < dt * 0.07) {
                const onRide = !!b.ride && Date.now() < b.ride.until;
                if (arrived && !onRide && Math.random() < 0.55) {
                    b.wanderX = undefined;
                    const r = Math.random();
                    if (r < 0.5) this._set('look', 0.6 + Math.random() * 2.6);
                    else if (r < 0.75) this._set('sit', 1 + Math.random() * 2.5);
                    else { b.dir *= -1; this._set('look', 0.4 + Math.random()); }
                    return;
                }
                const span = 80 + Math.random() * (Math.random() < 0.7 ? 350 : 900);
                const side = Math.random() < 0.5 ? -1 : 1;
                b.wanderX = Math.max(T.ux0 + 40, Math.min(T.ux1 - 40, b.x + side * span));
                b.speedMul = 0.6 + Math.random() * 0.65;
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
            ((b.energy ?? 100) < 40 ? 0.7 : 1) *
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
        if (this._game?.kind === 'ball' && ball && !ball.held && Math.abs(ball.x - b.x) < 24 &&
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

    _toggleFocus(minutes = FOCUS_MIN, fromPomo = false) {
        if (this._focus) { this._endFocus(false); return; }
        if (!fromPomo) this._pomo = null;
        this._stopGame(false);
        this._focus = {until: Date.now() + minutes * 60000};
        this._b.home = false;
        this._setFocusDnd(true);
        this._set('focus');
        this._note(`Focus mode on for ${minutes} minutes. I'll hold your notifications.`, 3000);
        this._syncMenu();
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
                try { GLib.file_set_contents(PREFS_PATH, JSON.stringify(this._prefs)); } catch {}
            });
        }
        const act = fn => () => { if (this._tickId) { this._lastInteract = Date.now(); fn(); } };
        ind.focus25.connect('activate', act(() => this._toggleFocus(25)));
        ind.focus50.connect('activate', act(() => this._toggleFocus(50)));
        ind.standupNow.connect('activate', act(() => this._standup()));
        ind.pomoItem.connect('activate', act(() => {
            if (this._pomo) {
                if (this._focus) this._endFocus(false);
                this._pomo = null; this._syncMenu(); this._note('Okay, Pomodoro stopped.', 1800);
                return;
            }
            this._pomo = {round: 1, breakUntil: 0};
            if (this._focus) this._endFocus(false);
            this._pomo = {round: 1, breakUntil: 0};
            this._toggleFocus(POMO_FOCUS, true);
            this._note(`Starting your Pomodoro: round 1 of ${POMO_ROUNDS}, ${POMO_FOCUS} minutes. I'll keep things quiet.`, 3500);
        }));
        ind.wrapNow.connect('activate', act(() => this._dailyWrap(true)));
        ind.nextNow.connect('activate', act(() => this._whatsNext()));
        ind.briefNow.connect('activate', act(() => this._morningBrief(true)));
        ind.uncommittedNow.connect('activate', act(() => this._checkUncommitted(true)));
        ind.breakNow.connect('activate', act(() => {
            this._breakAt = Date.now() + 30 * 60000;
            this._note("Sure. I'll remind you to take a break in 30 minutes.", 2600);
        }));
        ind.playBall.connect('activate', act(() => this._startGame('ball')));
        ind.followMe.connect('activate', act(() => this._startGame('follow')));
        ind.stopPlay.connect('activate', act(() => this._stopGame(true)));
        this._prefs.activity = ACTIVITY_ORDER.includes(prefs.activity) ? prefs.activity : 'normal';
        this._prefs.surprises = prefs.surprises !== false;
        // Above windows by default, so it stays visible however many windows are open.
        this._prefs.onTop = prefs.onTop !== false;
        this._prefs.chatty = prefs.chatty !== false;
        this._prefs.weather = prefs.weather !== false;
        this._prefs.petAlways = prefs.petAlways === true;
        ind.petSwitch.setToggleState(this._prefs.petAlways);
        ind.petSwitch.connect('toggled', (_i, state) => {
            this._prefs.petAlways = state;
            try { GLib.file_set_contents(PREFS_PATH, JSON.stringify(this._prefs)); } catch {}
            if (!this._tickId) return;
            if (state) this._summonPet();
            else if (this._pet) this._pet.until = Date.now() + 1000;   // waves off
        });
        ind.weatherSwitch.setToggleState(this._prefs.weather);
        ind.weatherSwitch.connect('toggled', (_i, state) => {
            this._prefs.weather = state;
            try { GLib.file_set_contents(PREFS_PATH, JSON.stringify(this._prefs)); } catch {}
            this._lastWeather = 0; this._checkWeather();
        });
        ind.petNow.connect('activate', act(() => this._summonPet()));
        ind.moonwalkNow.connect('activate', act(() => this._walkStyle('moonUntil', 'Hee-hee!')));
        ind.backwardsNow.connect('activate', act(() => this._walkStyle('backUntil', 'Beep beep, reversing.')));
        ind.chattySwitch.setToggleState(this._prefs.chatty);
        ind.chattySwitch.connect('toggled', (_i, state) => {
            this._prefs.chatty = state;
            try { GLib.file_set_contents(PREFS_PATH, JSON.stringify(this._prefs)); } catch {}
        });
        ind.onTopSwitch.setToggleState(this._prefs.onTop);
        ind.onTopSwitch.connect('toggled', (_i, state) => {
            this._prefs.onTop = state;
            try { GLib.file_set_contents(PREFS_PATH, JSON.stringify(this._prefs)); } catch {}
            if (this._area) this._setOnTop(state);
        });
        ind.surpriseSwitch.setToggleState(this._prefs.surprises);
        ind.surpriseSwitch.connect('toggled', (_i, state) => {
            this._prefs.surprises = state;
            try { GLib.file_set_contents(PREFS_PATH, JSON.stringify(this._prefs)); } catch {}
        });
        ind.surpriseNow.connect('activate', act(() => this._surprise()));
        ind.achievements.connect('activate', act(() => {
            const got = UNLOCKS.filter(u => this._unlocked(u[0])).map(u => u[1]);
            this._note(got.length ? `Unlocked: ${got.join(', ')}` : 'No secret tricks yet. Keep playing!', 4000);
        }));
        ind.resetAchievements.connect('activate', act(() => {
            this._stats = {spins: 0, focus: 0, cursor: 0, days: [], landings: 0, games: 0, unlocked: []};
            this._saveStats(); this._note('Secret tricks reset.', 1800);
        }));
        ind.activityItem.connect('activate', () => {
            const i = ACTIVITY_ORDER.indexOf(this._prefs.activity);
            this._prefs.activity = ACTIVITY_ORDER[(i + 1) % ACTIVITY_ORDER.length];
            try { GLib.file_set_contents(PREFS_PATH, JSON.stringify(this._prefs)); } catch {}
            this._nextAct = Date.now() + 3000;
            this._syncMenu();
        });
        // Diagnostics: one line, refreshed whenever the menu opens.
        ind.statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        ind.statusItem.label.style = 'font-size: 0.85em; color: #9aa2b1;';
        ind.toggle.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        ind.toggle.menu.addMenuItem(ind.statusItem);
        ind.toggle.menu.connect('open-state-changed', (_m, open) => { if (open) this._syncMenu(); });
        this._syncMenu();
    }

    // While focus runs, both focus items read "Stop focus".
    _syncMenu() {
        const ind = this._indicator;
        if (!ind) return;
        ind.focus25.label.text = this._focus ? 'Stop focus' : 'Focus 25 min';
        ind.pomoItem.label.text = this._pomo ? `Stop Pomodoro (round ${this._pomo.round} of ${POMO_ROUNDS})` : `Pomodoro (${POMO_ROUNDS} × ${POMO_FOCUS} min)`;
        ind.focus50.visible = !this._focus;
        ind.activityItem.label.text = `Activity: ${this._prefs?.activity ?? 'normal'} (click to change)`;
        ind.stopPlay.visible = !!this._game;
        const b = this._b;
        if (ind.statusItem && b) {
            ind.achievements.label.text = `Secret tricks: ${this._stats?.unlocked.length ?? 0} of ${UNLOCKS.length} (click to list)`;
        const n = (this._T?.surfaces.length ?? 1) - 1;
            ind.statusItem.label.text = `Now: ${b.held ? 'held' : b.mode}${this._game ? `, playing ${this._game.kind}` : ''} · ` +
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

    // "What's next?": the next meeting, and what is on your plate.
    _whatsNext() {
        const now = new Date(), next = this._todaysMeetings(now)[0];
        const fmt = d => GLib.DateTime.new_from_unix_local(Math.floor(d.getTime() / 1000)).format('%-l:%M %p');
        let text;
        if (next && next.date <= now) text = `You're in ${next.summary} until ${fmt(next.end)}.`;
        else if (next) {
            const mins = Math.round((next.date - now) / 60000);
            text = `Next up: ${next.summary} at ${fmt(next.date)}, in ${mins < 60 ? `${mins} minutes` : `about ${Math.round(mins / 60)} hours`}.`;
        } else text = 'No more meetings today. Your calendar is clear.';
        const jira = Main.extensionManager.lookup('jira-sprint@local')?.stateObj;
        const open = (jira?._issues ?? []).filter(i => i.fields?.status?.statusCategory?.key !== 'done');
        if (open.length) text += ` You have ${open.length} open ticket${open.length === 1 ? '' : 's'} this sprint.`;
        if (this._focus) text += ' Focus mode is on.';
        this._note(text, 8000);
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
    _showMeetingCard(ev) {
        this._hideCard();
        const links = Main.extensionManager.lookup('meet-join@local')?.stateObj?._todayLinks;
        const url = links?.get(ev.summary) ?? null;
        const time = GLib.DateTime.new_from_unix_local(Math.floor(ev.date.getTime() / 1000)).format('%-l:%M %p');
        const card = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL, reactive: true,
            style: 'background-color: rgba(30,32,40,0.96); border-radius: 12px; padding: 10px 12px; spacing: 6px; ' +
                'border: 1px solid rgba(124,240,212,0.5);',
        });
        card.add_child(new St.Label({text: ev.summary, style: 'font-weight: bold; color: #eef0f4; max-width: 240px;'}));
        card.add_child(new St.Label({text: `Starts at ${time}`, style: 'color: #9aa2b1; font-size: 0.9em;'}));
        const row = new St.BoxLayout({style: 'spacing: 8px;'});
        const btn = (label, primary, fn) => {
            const bt = new St.Button({label, can_focus: true, reactive: true,
                style: `padding: 4px 12px; border-radius: 9px; font-weight: bold; ${primary
                    ? 'background-color: #3584e4; color: white;' : 'background-color: rgba(255,255,255,0.1); color: #eef0f4;'}`});
            bt.connect('clicked', fn);
            row.add_child(bt);
        };
        if (url) btn('Join', true, () => { Gio.AppInfo.launch_default_for_uri(url, global.create_app_launch_context(0, -1)); this._hideCard(); });
        btn('Dismiss', !url, () => this._hideCard());
        card.add_child(row);
        this._addToLayer(card);
        this._card = {actor: card, until: ev.date.getTime() + 2 * 60000};
        this._stepCard();
    }

    _stepCard() {
        const c = this._card, b = this._b;
        if (Date.now() > c.until) { this._hideCard(); return; }
        const [w, h] = [c.actor.width || 220, c.actor.height || 90];
        const T = this._T;
        const x = Math.max((T?.ux0 ?? 0) + 8, Math.min((T?.ux1 ?? 1920) - w - 8, b.x - w / 2));
        c.actor.set_position(Math.round(x), Math.round(b.y - (BH + 40) * S - h - 30));
    }

    _hideCard() {
        this._card?.actor.destroy();
        this._card = null;
    }

    // The daily wrap: today's meetings, commits, Jira tickets done and anything
    // uncommitted, as text you can paste into Slack (copied to the clipboard).
    _dailyWrap(manual) {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
        const src = Main.panel.statusArea.dateMenu?._eventSource;
        const meetings = (src?.getEvents(start, now) ?? []).filter(e => e.end - e.date < 24 * 3600000 && e.date < now).map(e => e.summary);
        const jira = Main.extensionManager.lookup('jira-sprint@local')?.stateObj;
        const doneToday = (jira?._issues ?? []).filter(i => i.fields?.status?.statusCategory?.key === 'done' &&
            (i.fields?.updated ?? '').slice(0, 10) === iso(now)).map(i => `${i.key} ${i.fields.summary}`);
        this._run('find "$1" -maxdepth 4 -name .git -type d 2>/dev/null | while read -r g; do r=$(dirname "$g"); ' +
            'n=$(git -C "$r" log --all --since="$2" --author="$(git -C "$r" config user.email)" --oneline 2>/dev/null | wc -l); ' +
            '[ "$n" -gt 0 ] && echo "C $(basename "$r") $n"; done; ' +
            'find "$1" -maxdepth 4 -name .git 2>/dev/null | while read -r g; do r=$(dirname "$g"); ' +
            '[ -n "$(git -C "$r" status --porcelain --untracked-files=no 2>/dev/null | head -1)" ] && echo "U $(basename "$r")"; done',
        [PROJECTS, iso(start)], out => {
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
            void manual;
        });
    }

    _checkUncommitted(always) {
        this._run('find "$1" -maxdepth 4 -name .git 2>/dev/null | while read -r g; do r=$(dirname "$g"); ' +
            '[ -n "$(git -C "$r" status --porcelain --untracked-files=no 2>/dev/null | head -1)" ] && basename "$r"; done',
        [PROJECTS], out => {
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
        if (!done && this._pomo) this._pomo = null;   // stopping focus stops the whole Pomodoro
        if (done && this._pomo) {
            const p = this._pomo, long = p.round >= POMO_ROUNDS;
            p.breakUntil = Date.now() + (long ? POMO_LONG : POMO_SHORT) * 60000;
            this._syncMenu();
            this._set('dance', 2.5); this._sound('done');
            this._note(long ? `That's all ${POMO_ROUNDS} rounds. Brilliant work. Enjoy a ${POMO_LONG}-minute break.`
                : `Round ${p.round} of ${POMO_ROUNDS} done. Take ${POMO_SHORT} minutes; I'll call you back.`, 6000);
            return;
        }
        this._syncMenu();
        if (done) {
            this._set(this._unlocked('celebration') ? 'disco' : 'dance', 3.5); this._note("Focus session complete. Nice work. Take five, you've earned it.", 5000); this._sound('done');
        } else {
            this._set('wave', 1.2); this._note('Okay, focus ended early. Notifications are back on.', 2200);
        }
    }

    _everySecond() {
        // Pomodoro break: count it down, then start the next round (or finish).
        const p = this._pomo;
        if (p && !this._focus && p.breakUntil) {
            const left = p.breakUntil - Date.now();
            if (left <= 0) {
                p.breakUntil = 0;
                if (p.round >= POMO_ROUNDS) {
                    this._pomo = null; this._syncMenu();
                    this._set('dance', 3); this._note('Pomodoro complete. That was a productive stretch.', 5000); this._sound('done');
                } else {
                    p.round++;
                    this._toggleFocus(POMO_FOCUS, true);
                    this._note(`Break's over. Round ${p.round} of ${POMO_ROUNDS}, let's focus.`, 3000);
                }
            } else {
                const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
                this._say(`Break ${m}:${String(s).padStart(2, '0')}`, 1500, false, true);
            }
            return;
        }
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
        if (b.mode === 'sleep') {
            b.home = false; this._set('wake', 1.2);
        } else if (!b.held && (PRIORITY[b.mode] ?? 0) <= (PRIORITY[mode] ?? 40)) {
            b.home = false; this._set(mode, 4);
        } else {
            this._sound('reminder');   // busy with something more important: just speak
        }
        this._note(text, ms);
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
            for (const ev of src.getEvents(now, new Date(now.getTime() + (MEETING_WARN_MIN + 1) * 60000))) {
                if (ev.end - ev.date >= 24 * 3600000) continue;
                const ms = ev.date - now;
                if (ms <= 0 || ms > (MEETING_WARN_MIN + 0.5) * 60000) continue;
                const key = `${ev.summary}@${ev.date.getTime()}`;
                if (this._reminded.has(key)) continue;
                this._reminded.add(key);
                const at = GLib.DateTime.new_from_unix_local(Math.floor(ev.date.getTime() / 1000)).format('%-l:%M %p');
                this._remind(`Heads up: ${ev.summary} starts in ${Math.max(1, Math.round(ms / 60000))} minutes, at ${at}. The join link is on the card.`, 'watch', 12000);
                this._showMeetingCard(ev);
                if (/scrum|stand.?up/i.test(ev.summary)) this._standup();
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
            if (this._birthday && this._birthday !== was && (PRIORITY[this._b.mode] ?? 0) <= 20) {
                this._set('cake', 5); this._note(`🎂 ${this._birthday}!`, 4000); this._sound('done');
            }
        } catch {}
        if (this._prefs?.petAlways && !this._pet && this._tickId) this._summonPet();
        try { if (global.backend.get_core_idle_monitor().get_idletime() < 60000) this._morningBrief(); } catch {}
        if (Date.now() - (this._lastWeather ?? 0) > WEATHER_EVERY_MS) { this._lastWeather = Date.now(); this._checkWeather(); }

        // Rare surprise: only while you are around and it is free.
        try {
            const idleMs = global.backend.get_core_idle_monitor().get_idletime();
            const b = this._b;
            if (this._prefs?.surprises !== false && !this._focus && !inMeeting && idleMs < 120000 &&
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
            if (this._prefs?.jira !== false && prev && prev !== 'done' && cat === 'done')
                this._remind(`${is.key} just moved to Done. Well done!`, 'dance');
        }

        // End of day: uncommitted work in your repos (worktrees included).
        const day = now.toDateString();
        if (this._prefs?.eod !== false && now.getHours() >= EOD_HOUR && this._eodDay !== day) {
            this._eodDay = day;
            this._dailyWrap(false);
        }
    }

    // Commits since the last working day, per repo, for the stand-up.
    _standup() {
        const d = new Date();
        const back = d.getDay() === 1 ? 3 : 1;
        const since = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
        const until = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
        this._run('find "$1" -maxdepth 4 -name .git -type d 2>/dev/null | while read -r g; do r=$(dirname "$g"); ' +
            'n=$(git -C "$r" log --all --since="$2" --until="$3" --author="$(git -C "$r" config user.email)" --oneline 2>/dev/null | wc -l); ' +
            '[ "$n" -gt 0 ] && echo "$(basename "$r") $n"; done',
        [PROJECTS, iso(since), iso(until)], out => {
            const rows = out.split('\n').filter(Boolean);
            const day = back === 3 ? 'Friday' : 'yesterday';
            const text = rows.length ? `For your stand-up: since ${day} you committed to ${rows.map(r => r.replace(' ', ' ×')).join(', ')}.`
                : `For your stand-up: no commits since ${day}. Maybe mention reviews or meetings?`;
            this._note(text, 15000);
        });
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
        const sharing = (this._shares?.size ?? 0) > 0;
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
            cr.setSourceRGBA(0.98, 0.85, 0.25, 1);
            for (const s of [-1, 0, 1]) {   // three floppy strips
                cr.moveTo(0, 4); cr.curveTo(s * 6, 1, s * 10, -1, s * 11, 3); cr.lineTo(s * 8, 4); cr.closePath(); cr.fill();
            }
            cr.setSourceRGBA(0.45, 0.32, 0.12, 1); cr.rectangle(-1, 2, 2, 3); cr.fill();
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
        const tx = ball && this._game?.kind === 'ball' ? ball.x : b.x - b.dir * 50;
        const dx = tx - pet.x;
        pet.moving = Math.abs(dx) > 8 && b.mode !== 'sleep';
        if (pet.moving) {
            pet.dir = dx > 0 ? 1 : -1;
            pet.x += pet.dir * Math.min(Math.abs(dx), (ball ? 230 : 120) * dt);
        }
        pet.y = this._below(T, pet.x, T.wa.y)?.top ?? T.ground;
        if (ball && !ball.held && Math.abs(ball.x - pet.x) < 18 && Math.abs(ball.y - pet.y) < 30 && Date.now() - (ball.kickedAt ?? 0) > 700) {
            ball.kickedAt = Date.now();   // fetched: nudges it back to the buddy
            ball.vx = Math.sign(b.x - ball.x) * 300; ball.vy = -250;
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
        rgb(cr, C.teal); cr.setLineWidth(2.5);                                                        // wagging tail
        const wag = Math.sin(pet.t * (pet.moving ? 18 : 10)) * 5;
        cr.moveTo(-13, -16 + (sit ? 3 : 0)); cr.lineTo(-19, -23 + wag + (sit ? 3 : 0)); cr.stroke();
        void step;
        cr.$dispose();
    }

    // Music playing in any media player (MPRIS): it dances more, and says the song.
    _checkMusic() {
        const bus = Gio.DBus.session;
        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames', null, null,
            Gio.DBusCallFlags.NONE, -1, null, (_c, res) => {
                let names = [];
                try { names = bus.call_finish(res).deepUnpack()[0].filter(n => n.startsWith('org.mpris.MediaPlayer2.')); } catch {}
                if (!names.length) { this._music = null; return; }
                let pending = names.length, found = null;
                for (const name of names) {
                    bus.call(name, '/org/mpris/MediaPlayer2', 'org.freedesktop.DBus.Properties', 'GetAll',
                        new GLib.Variant('(s)', ['org.mpris.MediaPlayer2.Player']), null, Gio.DBusCallFlags.NONE, 1000, null, (_c2, r2) => {
                            try {
                                const props = bus.call_finish(r2).recursiveUnpack()[0];
                                if (props.PlaybackStatus === 'Playing' && !found) {
                                    const md = props.Metadata ?? {};
                                    const artist = [].concat(md['xesam:artist'] ?? [])[0];
                                    found = {title: md['xesam:title'] ?? 'something good', artist};
                                }
                            } catch {}
                            if (--pending === 0) {
                                const was = this._music?.title;
                                this._music = found;
                                if (found && found.title !== was && this._b && (PRIORITY[this._b.mode] ?? 0) <= 20) {
                                    this._set('dance', 4);
                                    this._say(`♪ ${found.title}${found.artist ? ` by ${found.artist}` : ''}`, 3000);
                                }
                            }
                        });
                }
            });
    }

    // Weather for its outfit: an umbrella in rain, shades in the sun, a scarf in the cold.
    _checkWeather() {
        if (this._prefs?.weather === false) { this._weather = null; return; }
        this._http ??= new Soup.Session({timeout: 15, user_agent: 'desk-buddy'});
        const msg = Soup.Message.new('GET', WEATHER_URL);
        this._http.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (s, res) => {
            try {
                const bytes = s.send_and_read_finish(res);
                if (msg.get_status() !== 200) return;
                const [cond = '', temp = '', wind = ''] = new TextDecoder().decode(bytes.get_data()).trim().split('|');
                const c = Number.parseInt(temp.replace(/[^-\d]/g, ''), 10);
                const hour = new Date().getHours();
                this._weather = {
                    text: `${cond.trim()} ${temp.trim()}`,
                    rain: /rain|drizzle|shower|thunder|sleet/i.test(cond),
                    sun: /sun|clear/i.test(cond) && hour >= 7 && hour < 18,
                    cold: Number.isFinite(c) && c < 12,
                    snow: /snow|blizzard|sleet/i.test(cond),
                    windy: (Number.parseInt(wind.replace(/[^\d]/g, ''), 10) || 0) >= 15,
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
            if (target instanceof PopupMenu.PopupSwitchMenuItem) {
                const sw = new PopupMenu.PopupSwitchMenuItem(target.label.text, target.state);
                sw.connect('toggled', () => target.toggle());
                into.addMenuItem(sw);
            } else {
                const it = new PopupMenu.PopupMenuItem(target.label.text);
                it.connect('activate', () => target.emit('activate', null));
                into.addMenuItem(it);
            }
        };
        mirror(ind.soundSwitch, menu);
        for (const [title, items] of [
            ['Productivity', [ind.nextNow, ind.briefNow, ind.focus25, ind.focus50, ind.pomoItem, ind.standupNow, ind.wrapNow,
                ind.uncommittedNow, ind.breakNow]],
            ['Play', [ind.moonwalkNow, ind.backwardsNow, ind.playBall, ind.followMe, ind.stopPlay, ind.petNow, ind.surpriseNow]],
            ['Settings', [ind.onTopSwitch, ind.chattySwitch, ind.weatherSwitch, ind.petSwitch, ind.surpriseSwitch, ind.activityItem]],
            ['Nudges', Object.values(ind.nudgeSwitches)],
            ['Secret tricks', [ind.achievements, ind.resetAchievements]],
        ]) {
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
            if (g.k > 5.4) {
                b.bug = null;
                if (g.caught) { this._set('dance', 2); this._say('Got it! (setting it free)', 1600); this._sound('happy'); }
                else { this._set('angry', 1.6); this._say('It got away!', 1200); }
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
        case 'stuck':
            b.actT -= dt;
            b.y += 18 * dt;   // slowly sliding down the window side
            if (b.actT <= 0) { b.vx = -b.stuckSide * 60; b.vy = -60; this._set('fall'); }
            break;
        }
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
                this._game = {kind: 'follow', until: Date.now() + 6000, thief: true}; this._say('Your pointer is mine!', 1400);
            }],
            ['backwards', 2, 40, true, () => { b.backUntil = Date.now() + 3500; this._say('Beep beep, reversing.', 1400); }],
            ['moonwalk', 2, 60, false, () => { b.moonUntil = Date.now() + 3500; this._say('Hee-hee!', 1200); this._sound('happy'); }],
            ['ninja', 1, 150, false, () => { b.ninjaUntil = Date.now() + 9000; b.runUntil = Date.now() + 2500; this._say('Ninja mode. Shh.', 1600, false); }],
            ['smoke', 1, 300, true, () => { this._set('smoke', 6); this._say('Just a quick smoke break.', 1800); }],
            ['banana', 2, 180, true, () => { this._set('banana', 4.5); }],
            ['clean', 1, 120, false, () => { this._set('clean', 3.5); this._say('Cleaning your screen.', 1600); }],
            ['gum', 1, 150, true, () => { b.popped = false; this._set('gum', 4.5); }],
            ['plane', 1, 150, false, () => { b.planeThrown = false; this._set('plane', 2.4); }],
            ['sneeze', 1, 180, false, () => { this._set('sneeze', 1.8); this._say('Ah… ah…', 1200); }],
            ['fish', 1, 180, true, () => { b.caught = false; this._set('fish', 6); this._say('Gone fishing.', 1400); }],
            ['paint', 1, 180, false, () => this._startGraffiti()],
            ['petcall', 1, 600, false, () => this._summonPet()],
            ['shoot', 1, 120, false, () => { b.fired = false; b.bangFlag = false; this._set('shoot', 1.8); }],
        ];
        const wx = this._weather ?? {}, month = new Date().getMonth();
        if (wx.snow || (wx.cold && (month === 11 || month <= 1)))
            all.push(['snowball', 3, 90, false, () => { b.throws = 0; this._set('snowball', 4.2); this._say('Snowball fight!', 1200); }]);
        if (wx.windy) all.push(['kite', 3, 120, false, () => { this._set('kite', 6); this._say('Perfect kite weather!', 1400); }]);
        if (wx.rain) all.push(['raindance', 3, 120, false, () => { this._set('raindance', 4.5); this._say('Rain dance!', 1200); }]);
        if (this._birthday) all.push(['cake', 4, 90, false, () => { this._set('cake', 5); this._say(`🎂 ${this._birthday}`, 3000); }]);
        if (this._pet) all.push(['pettricks', 3, 90, false, () => { this._pet.trick = {k: 0}; this._set('command', 4.2); this._say('Sit! Roll over! Play dead!', 2000); }]);
        // Dumb things
        all.push(['trip', 2, 60, false, () => { b.forceReaction = 'shy'; this._set('tumble', 0.9); this._sound('whoa'); }]);
        all.push(['tailchase', 1, 120, false, () => { b.flipT = 0; this._set('tailchase', 3.2); }]);
        all.push(['mimewall', 1, 120, false, () => { this._set('mimewall', 3.5); this._sound('thud'); this._say('Bonk! A wall?', 1200); }]);
        all.push(['derp', 1, 90, true, () => { this._set('derp', 2.5); }]);
        all.push(['wavenobody', 1, 120, true, () => { b.afterWave = 'shy'; this._set('wave', 1.6); this._say('Hi!… oh. Nobody.', 1600); }]);
        all.push(['magic', 1, 150, false, () => { this._set('magic', 4.5); this._say('Ta-da… magic!', 1400); }]);
        all.push(['fort', 1, 180, false, () => { this._set('fort', 6.5); }]);
        all.push(['hiccups', 1, 180, true, () => { b.hicT = 0; this._set('hiccups', 7); }]);
        all.push(['bugchase', 1, 150, false, () => { b.bug = {k: 0, caught: Math.random() < 0.5}; b.on = null; this._set('bugchase'); this._say('A bug!', 1000); }]);
        all.push(['wallrun', 2, 120, false, () => this._startWallRun()]);
        all.push(['mirror', 1, 150, false, () => { b.mirror = {k: 0, px: global.get_pointer()[0]}; this._set('mirror'); this._say('I am your mirror.', 1400); }]);
        all.push(['juggle', 2, 120, false, () => { b.dropBall = Math.random() < 0.3; this._set('juggle', 4.5); }]);
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
        const ok = all.filter(([name, , cd, tiredOk]) => (!tired || tiredOk) && !this._recent.includes(name) &&
            now - (this._cooldown[name] ?? 0) > cd * 1000);
        const pool = ok.length ? ok : all.filter(a => !tired || a[3]);
        let r = Math.random() * pool.reduce((s, a) => s + a[1], 0);
        const pick = pool.find(a => (r -= a[1]) <= 0) ?? pool[0];
        this._recent = [pick[0], ...this._recent].slice(0, 3);
        this._cooldown[pick[0]] = now;
        if (Math.random() < 0.3) { b.dir *= -1; b.wanderX = undefined; }
        pick[4]();
        if (b.actT > 0) b.actT *= 0.7 + Math.random() * 0.6;   // never quite the same length twice
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
        if (!ball.held) {
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
            coffee: 3, book: 2, doze: 4, polish: -0.2, phones: -0.2,
        }[b.mode] ?? 0;
        b.energy = Math.max(0, Math.min(100, (b.energy ?? 100) + rate * dt));
    }

    // --- input ---------------------------------------------------------------

    _press(ev) {
        const [px, py] = ev.get_coords();
        if (ev.get_button() === Clutter.BUTTON_SECONDARY) {
            this._openMenu();
            return Clutter.EVENT_STOP;
        }
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
            this._say('Wheee!', 1500);
        }
        if (this._b.held) {
            const wa = this._workArea();
            const wasScared = this._b.scared;
            this._b.scared = this._b.y < wa.y + wa.height * 0.4;
            if (this._b.scared && !wasScared && (this._b.spin ?? 0) < 1) { this._say('Too high! Put me down!!', 1600); this._sound('whoa'); }
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
                b.x = b.stuckSide > 0 ? side.x0 - 12 : side.x1 + 12;
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
        this._singleClick(p.head);
        return Clutter.EVENT_STOP;
    }

    // --- drawing -------------------------------------------------------------

    _paint(area) {
        const cr = area.get_context();
        const b = this._b;
        cr.setOperator(Cairo.Operator.CLEAR); cr.paint(); cr.setOperator(Cairo.Operator.OVER);
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
        if (b.mode === 'cry' || b.mode === 'laugh')
            cr.rotate(Math.sin(b.t * 25) * 0.03);
        if (b.mode === 'shy')
            cr.rotate(Math.sin(b.t * 3) * 0.07);
        if (b.held && b.scared)
            cr.translate(Math.sin(b.t * 60) * 1.5, 0);   // trembling
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
        if (Date.now() < (b.moonUntil ?? 0) && b.mode === 'walk')
            cr.rotate(0.07 * b.dir);  // moonwalk: leaning back against the glide
        if (Date.now() < (b.stagger ?? 0) && b.mode === 'walk')
            cr.rotate(Math.sin(b.t * 4) * 0.14);
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
        let m = b.held || b.mode === 'thrown' ? 'held' : b.mode;
        const sleepwalk = m === 'walk' && Date.now() < (b.sleepwalkUntil ?? 0);
        const t = b.mode === 'freeze' ? (b.freezeT ?? b.t) : b.t;
        const stayFor = b.mode === 'stay' ? (Date.now() - (b.stayStart ?? Date.now())) / 1000 : 0;
        const staySit = b.mode === 'stay' && stayFor >= STAY_SIT_S;
        const sleeping = m === 'sleep', sitting = sleeping || staySit || m === 'sit' || m === 'meeting' || m === 'knocked' || m === 'broken' || m === 'focus' ||
            m === 'cry' || m === 'laugh' || m === 'tumble' || m === 'prejump' || m === 'coffee' || m === 'book' || m === 'doze' ||
            m === 'fakesleep' || m === 'smoke' || m === 'slide' || m === 'typing' || m === 'fish' || m === 'bedtime';
        const ride = b.ride && Date.now() < b.ride.until && (m === 'walk' || m === 'duck' || (m === 'jump' && b.kickflip)) ? b.ride.kind : null;
        // Gait: the phase follows distance walked, so feet never slide.
        const running = Date.now() < (b.runUntil ?? 0) && m === 'walk' && !ride;
        const ph = (b.dist ?? 0) / S / (running ? 6 : 3.6);
        const bounce = m === 'dance' ? -Math.abs(Math.sin(t * 9)) * 8
            : (m === 'walk' || m === 'duck') ? -Math.abs(Math.sin(ph)) * (running ? 2 : 0.8) : 0;
        const breathe = sleeping ? Math.sin(t * 2) * 1.5 : 0;
        const h = BH * (m === 'duck' ? b.squash : sitting ? 0.85 : 1) + breathe;
        const w = BW * (m === 'duck' ? 1 + (1 - b.squash) * 0.5 : 1);
        const fy = ride === 'skate' ? -7 + Math.sin(t * 6) * 0.5 : ride === 'bike' ? -18 + Math.abs(Math.sin(ph)) * 0.8 : bounce;
        const x = -w / 2, y = fy - h - (sitting ? 2 : 8);
        // Walking backwards or moonwalking: it faces the other way.
        const nowD = Date.now();
        const moon = nowD < (b.moonUntil ?? 0) && m === 'walk';
        const dir = (moon || (nowD < (b.backUntil ?? 0) && m === 'walk')) ? -b.dir : b.dir;
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
        const legIK = (hx, hy, fx, footY, L) => {
            const dxl = fx - hx, dyl = footY - 3 - hy;
            const d = Math.min(Math.hypot(dxl, dyl), 2 * L - 0.01);
            const ka = Math.atan2(dyl, dxl) - dir * Math.acos(d / (2 * L));
            const kx = hx + Math.cos(ka) * L, ky = hy + Math.sin(ka) * L;
            rgb(cr, C.limb); cr.setLineWidth(7); cr.setLineJoin(Cairo.LineJoin.ROUND);
            cr.moveTo(hx, hy); cr.lineTo(kx, ky); cr.lineTo(fx, footY - 3); cr.stroke();
            rgb(cr, C.foot); rr(cr, fx - 7 + dir * 2, footY - 5, 14, 6, 2); cr.fill();
        };
        if (ride === 'skate') {
            if (b.kickflip && m === 'jump') { cr.save(); cr.translate(0, -4); cr.rotate(t * 18); cr.translate(0, 4); drawSkate(); cr.restore(); }
            else drawSkate();
        }
        if (ride === 'bike') drawBike((b.dist ?? 0) / S / 9.5);

        // legs
        const leg = (hx, fx, footY) => {
            rgb(cr, C.limb); cr.setLineWidth(8);
            cr.moveTo(hx, y + h * 0.76); cr.lineTo(fx, footY - 3); cr.stroke();
            rgb(cr, C.foot); rr(cr, fx - 7 + dir * 2, footY - 5, 14, 6, 2); cr.fill();
            rgb(cr, C.stripe); rr(cr, fx - 6 + dir * 2, footY, 12, 2, 1); cr.fill();
        };
        if (m === 'stay' && !staySit) {
            // waiting: one foot tapping
            const tap = Math.max(0, Math.sin(t * 7)) * 3;
            leg(-8, -8, fy); leg(8, 8 + dir * 2, fy - tap);
        } else if (m === 'stretched' || m === 'snapback') {
            for (const key of ['legL', 'legR']) {
                const L = LIMBS[key];
                if (b.limb?.key === key) {
                    this._rubberLimb(cr, L, b.limb.tip, b.limb.rest);
                } else {
                    rgb(cr, C.limb); cr.setLineWidth(L.width); cr.moveTo(L.base[0], L.base[1]); cr.lineTo(L.rest[0], L.rest[1]); cr.stroke();
                    rgb(cr, C.foot); rr(cr, L.rest[0] - 9, -7, 18, 7, 3); cr.fill();
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
            rgb(cr, C.foot); rr(cr, -18, fy - 5, 14, 5, 2); cr.fill(); rr(cr, 4, fy - 5, 14, 5, 2); cr.fill();
        } else if (m === 'held') {
            const s = Math.sin(t * 18) * 5;
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
        } else {
            // EMO-style waddle: short, chunky legs that stay straight, small
            // flat-footed steps; the lifted foot rises only a little.
            const stride = moon ? 14 : running ? 12 : 6, lift = moon ? 0 : running ? 5 : 2.5;
            for (const [side, off] of [[-1, 0], [1, Math.PI]]) {
                const s = Math.sin(ph + off), c = Math.cos(ph + off);
                const hx = side * 8, hy = y + h * 0.74;
                const fx = hx + dir * s * stride / 2, footY = fy - Math.max(0, c) * lift;
                rgb(cr, C.limb); cr.setLineWidth(11); cr.setLineCap(Cairo.LineCap.ROUND);
                cr.moveTo(hx, hy); cr.lineTo(fx, footY - 5); cr.stroke();
                rgb(cr, C.foot);
                if (moon && c > 0) {
                    // moonwalk: this foot slides back on its toes, heel up
                    cr.save(); cr.translate(fx, footY - 4); cr.rotate(-dir * 0.5); rr(cr, -9, -3, 18, 7, 3); cr.fill(); cr.restore();
                } else {
                    rr(cr, fx - 9 + dir * 2, footY - 7, 18, 7, 3); cr.fill();
                }
                rgb(cr, C.stripe); rr(cr, fx - 8 + dir * 2, footY - 1.5, 16, 2, 1); cr.fill();
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
        rgb(cr, ringGlow ? C.glow : C.teal);
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
            if (wx.rain && ['walk', 'duck', 'look', 'stay', 'sit'].includes(m)) {
                cr.setSourceRGBA(0.3, 0.25, 0.6, 1); cr.setLineWidth(1.5);
                cr.moveTo(-dir * 6, y + h * 0.5); cr.lineTo(-dir * 6, y - 24); cr.stroke();
                cr.setSourceRGBA(0.35, 0.3, 0.75, 0.95);
                cr.newSubPath(); cr.arc(-dir * 6, y - 22, 26, Math.PI, 2 * Math.PI); cr.closePath(); cr.fill();
                cr.setSourceRGBA(0.6, 0.8, 1, 0.6);
                for (let k = 0; k < 4; k++) { const q = (t * 1.6 + k / 4) % 1; cr.newSubPath(); cr.arc(-dir * 6 + (k - 1.5) * 16, y - 50 + q * 26, 1, 0, 2 * Math.PI); cr.fill(); }
            }
        }

        // Ninja: a black headband with red tails fluttering behind.
        if (nowD < (b.ninjaUntil ?? 0)) {
            cr.setSourceRGBA(0.08, 0.08, 0.1, 1); rr(cr, x - 1, y + 3, w + 2, 6, 2); cr.fill();
            cr.setSourceRGBA(0.9, 0.2, 0.25, 1); cr.setLineWidth(2.2);
            const bx = dir > 0 ? x : x + w, fl = Math.sin(t * 14) * 3;
            cr.moveTo(bx, y + 6); cr.lineTo(bx - dir * 12, y + 3 + fl); cr.moveTo(bx, y + 6); cr.lineTo(bx - dir * 11, y + 9 - fl); cr.stroke();
        }
        // Secret costume: a party hat.
        if (this._unlocked('costume') && !['knocked', 'broken', 'hang', 'handstand'].includes(m)) {
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
        case 'fish': {
            // rod out over a little puddle; near the end up comes a boot
            const tipX = dir * 34, tipY = y - 8;
            arm(lx, shY, dir * 10, shY + 4); arm(rx, shY, dir * 14, shY + 2);
            cr.setSourceRGBA(0.45, 0.32, 0.18, 1); cr.setLineWidth(2); cr.moveTo(dir * 12, shY + 3); cr.lineTo(tipX, tipY); cr.stroke();
            cr.setSourceRGBA(0.4, 0.65, 0.95, 0.6); cr.save(); cr.translate(dir * 40, -1); cr.scale(2.2, 0.45); cr.newSubPath(); cr.arc(0, 0, 9, 0, 2 * Math.PI); cr.restore(); cr.fill();
            const hookY = b.caught ? tipY + 18 : -2 + Math.sin(t * 2) * 1.5;
            cr.setSourceRGBA(0.85, 0.87, 0.9, 0.8); cr.setLineWidth(0.8); cr.moveTo(tipX, tipY); cr.lineTo(dir * 38, hookY); cr.stroke();
            if (b.caught) {
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
            cr.setSourceRGBA(0.1, 0.1, 0.12, 1); rr(cr, hx - 8, fy - 14, 16, 14, 2); cr.fill(); rr(cr, hx - 11, fy - 3, 22, 3, 1); cr.fill();
            cr.setSourceRGBA(0.85, 0.2, 0.3, 1); cr.rectangle(hx - 8, fy - 8, 16, 2); cr.fill();
            if (b.rabbit) {
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
        case 'cake': {
            // holding up a cake with flickering candles; confetti falls
            const cy = shY - 4;
            arm(lx, shY, dir * 10 - 8, cy); arm(rx, shY, dir * 10 + 8, cy);
            cr.setSourceRGBA(0.98, 0.85, 0.7, 1); rr(cr, dir * 10 - 11, cy - 10, 22, 10, 2); cr.fill();
            cr.setSourceRGBA(1, 0.55, 0.7, 1); rr(cr, dir * 10 - 11, cy - 11, 22, 3, 1.5); cr.fill();
            for (const cxk of [-6, 0, 6]) {
                cr.setSourceRGBA(0.6, 0.8, 1, 1); cr.rectangle(dir * 10 + cxk - 0.8, cy - 17, 1.6, 6); cr.fill();
                cr.setSourceRGBA(1, 0.7 + Math.random() * 0.3, 0.2, 1); cr.newSubPath(); cr.arc(dir * 10 + cxk, cy - 19, 1.6, 0, 2 * Math.PI); cr.fill();
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
            // three balls looping over its head, hands tossing in turn
            const sp = 6, up = Math.sin(t * sp) > 0;
            arm(lx, shY, lx - 4, up ? shY - 6 : shY + 4); arm(rx, shY, rx + 4, up ? shY + 4 : shY - 6);
            const cols = [[1, 0.45, 0.35], [0.4, 0.8, 1], [1, 0.85, 0.3]];
            for (let i = 0; i < 3; i++) {
                const a = t * sp + (i * 2 * Math.PI) / 3;
                let bx = Math.cos(a) * 16, by = y - 6 - Math.abs(Math.sin(a)) * 26;
                if (b.dropBall && i === 0 && b.actT < 0.8) { bx = 0; by = y - 6 - (b.actT / 0.8) * 30; }   // falling onto its head
                cr.setSourceRGBA(cols[i][0], cols[i][1], cols[i][2], 1); cr.newSubPath(); cr.arc(bx, by, 3.5, 0, 2 * Math.PI); cr.fill();
            }
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
        case 'chute': arm(lx, shY, lx - 4, y - 14); arm(rx, shY, rx + 4, y - 14); break;
        case 'emerge': {
            const gy = -(b.rise ?? 0) * (BH + 24) - 2, g = Math.sin(t * 8) * 2;
            arm(lx, shY, lx - 10, gy + g); arm(rx, shY, rx + 10, gy - g); break;
        }
        case 'tease': arm(lx, shY, lx - 9, shY + 10); arm(rx, shY, rx + 9, shY + 10); break;  // hands on hips
        case 'focus': arm(lx, shY, lx + 6, shY + 14); arm(rx, shY, rx - 6, shY + 14); break;
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
        case 'love': arm(lx, shY, -3, y + h * 0.66); arm(rx, shY, 3, y + h * 0.66); break;  // hands clasped
        case 'tumble': { const s = Math.sin(t * 22) * 10; arm(lx, shY, lx - 12, shY - s); arm(rx, shY, rx + 12, shY + s); break; }
        default: {
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
            const sw = Math.sin(ph) * (running ? 9 : 4) * dir;
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
            juggle: 'dance', guitar: 'dance', snowball: 'tease', magic: 'tease', kite: 'dance', command: 'wave',
            fort: b.actT > 3 ? 'polish' : 'book', cake: 'dance', raindance: 'dance', bugchase: 'detective',
            wallrun: 'emerge', mirror: 'waitlook', tailchase: 'laugh', mimewall: 'poked', derp: 'derp',
            hiccups: b.t - (b.hicAt ?? -9) < 0.25 ? 'poked' : 'gumchew',
            bedtime: b.actT > 4 ? 'gumchew' : b.actT > 2 ? 'smoke' : 'sleep',
        };
        if (FACE[m]) m = FACE[m];
        if (m === 'stretched') m = b.stretchFace ?? 'laugh';
        else if (m === 'snapback') m = 'poked';

        // face, eyes following the pointer while it walks, waves or watches
        const sy = y + 6, sh = h * 0.62;
        let lookX = dir * 3, lookY = 0;
        if (m === 'walk' || m === 'look' || m === 'wave' || m === 'stay' || m === 'waitlook' || m === 'staybored') {
            const [px, py] = global.get_pointer();
            lookX = Math.max(-6, Math.min(6, (px - b.x) / 60));
            lookY = Math.max(-3, Math.min(3, (py - (b.y - h * S)) / 90));
        }
        const cx = lookX, ey = sy + sh * 0.42 + lookY;
        const col = m === 'alert' || m === 'angry' ? C.alert : m === 'love' ? [1, 0.49, 0.71] : m === 'held' || m === 'dizzy' ? C.warn : (m === 'fly' || m === 'dance') ? C.happy : C.glow;
        rgb(cr, col); cr.setLineWidth(2.5);
        if (m === 'derp') {
            // cross-eyed with its tongue out
            for (const [ex, dx2] of [[-9, 4], [9, -4]]) { rr(cr, cx + ex - 4, ey - 6, 8, 12, 3); cr.fill(); cr.setSourceRGBA(0.02, 0.03, 0.04, 1); cr.newSubPath(); cr.arc(cx + ex + dx2 * 0.6, ey, 2, 0, 2 * Math.PI); cr.fill(); rgb(cr, col); }
            cr.setSourceRGBA(1, 0.5, 0.65, 1); rr(cr, cx - 3, sy + sh * 0.78, 6, 7 + Math.sin(t * 6), 3); cr.fill(); rgb(cr, col);
        } else if (sleepwalk) {
            for (const ex of [-9, 9]) { cr.moveTo(cx + ex - 4, ey + 2); cr.curveTo(cx + ex - 2, ey + 5, cx + ex + 2, ey + 5, cx + ex + 4, ey + 2); cr.stroke(); }
            cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD); cr.setFontSize(9);
            cr.moveTo(14, y - 2 - ((t * 8) % 8)); cr.showText('z');
        } else if (m === 'waitlook') {
            // waiting: eyes follow your pointer
            const blink = Math.sin(t * 2.3) > 0.985 ? 0.1 : 1;
            for (const ex of [-9, 9]) { rr(cr, cx + ex - 5, ey - 7 * blink, 10, Math.max(2, 14 * blink), 3); cr.fill(); }
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
        } else if (m === 'held' && b.scared && (b.spin ?? 0) < 1) {
            for (const ex of [-9, 9]) { rr(cr, cx + ex - 4, ey - 9, 8, 16, 3); cr.fill(); }
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
        } else if (m === 'held' && b.scared && (b.spin ?? 0) < 1) {
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

        // parachute canopy, striped purple and teal, with strings to the hands
        if (m === 'chute') {
            const top = y - 62, R = 44, cy0 = top + R;
            const n = 6;
            for (let i = 0; i < n; i++) {
                const a0 = Math.PI + (Math.PI * i) / n, a1 = Math.PI + (Math.PI * (i + 1)) / n;
                rgb(cr, i % 2 ? C.teal : C.purple);
                cr.moveTo(0, cy0); cr.arc(0, cy0, R, a0, a1); cr.closePath(); cr.fill();
            }
            cr.setSourceRGBA(1, 1, 1, 0.12); cr.rectangle(-R, cy0 - 3, 2 * R, 3); cr.fill();
            cr.setSourceRGBA(0.85, 0.87, 0.9, 0.8); cr.setLineWidth(1);
            for (const [sx, hx] of [[-R, x - 6], [-R / 2, x - 6], [R / 2, x + w + 6], [R, x + w + 6]]) {
                cr.moveTo(sx, cy0); cr.lineTo(hx, y - 14); cr.stroke();
            }
            cr.setLineWidth(2.5);
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
        if (sunny || (b.mode === 'typing' && Date.now() - (b.typingSince ?? Date.now()) > 20000)) {
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
        if (pr && pr.kind === 'banana' && b.mode === 'banana') {
            const L = 14 * pr.left;
            cr.setSourceRGBA(0.98, 0.85, 0.25, 1); cr.setLineWidth(4.5);
            cr.moveTo(pr.x, pr.y + 3); cr.curveTo(pr.x + dir * L * 0.3, pr.y - L * 0.6, pr.x + dir * L * 0.8, pr.y - L * 0.8, pr.x + dir * L, pr.y - L * 0.5);
            cr.stroke();
            cr.setSourceRGBA(0.98, 0.85, 0.25, 1); cr.setLineWidth(2);   // the peel flaps below the hand
            for (const s of [-1, 1]) { cr.moveTo(pr.x, pr.y + 2); cr.lineTo(pr.x + s * 5, pr.y + 8); }
            cr.stroke();
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
        if (pr && ['coffee', 'book', 'polish'].includes(m)) {
            if (pr.kind === 'cup') {
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
