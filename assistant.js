/* The studio assistant, on the public website.

   One file, dropped onto a page with a single <script> tag. It adds ONE glass
   control at the foot of the page — a two-part capsule that carries the studio's
   own booking action and the assistant — and opening the assistant splits that
   capsule apart rather than stacking a second floating button on top of the
   first. The page's own floating CTA (`.lp-float-book` on the home page) is
   adopted, not duplicated: its label, its destination and its place are read out
   of the page and then hidden, so two pills can never sit on top of each other
   on a phone. If this widget fails to start, the class it adds is never added
   and the page's own pill stays exactly where it was.

   Five decisions worth knowing before changing this file:

   1. It fails CLOSED. If the assistant is not switched on, or the API cannot be
      reached, the dock removes itself, the page's own pill comes back, and the
      page carries on exactly as it did before. A chat box that opens onto an
      error is worse than no chat box.

   2. It NEVER takes a booking. It can see which dates are free and will say so,
      but a free date is not a reservation and it is written not to pretend
      otherwise. Booking still happens on the booking page, where the money is.

   3. No phone number, ever. The studio's rule is WhatsApp and email only, and
      this widget is written to obey it — including in the fallback, which sends
      people to WhatsApp rather than showing a number that does not exist.

   4. The conversation is never stored, anywhere. It lives in this page's memory
      and is gone on reload. The ONE thing kept is the email address or WhatsApp
      number a visitor chooses to leave when the assistant hands their question
      over — because a notification nobody can answer is not much use. That
      detail goes to the studio's own database (table `assistant_contacts`, and
      no conversation with it) and is remembered in this browser's localStorage
      so a returning client is greeted rather than treated as a stranger. If a
      future change wants to keep what people ASKED, that is a privacy decision
      rather than a feature, and it needs the ADR changed first.

   5. Nothing here may need a 16px font to be typed into. iOS Safari zooms the
      whole page when a focused field is smaller than that, and it does not zoom
      back out — which turned a tap into a page-wide zoom every single time. Every
      field below is 16px for that reason, and the comment is here so nobody
      "tidies" it back down.

   6. A PAGE MAY OWN A DOOR AND A SLOT FOR THE FACE, but never a copy of either.
      `data-lp-door` is an EMPTY element a page puts where it wants the
      assistant to be — the links page has one, first above its destinations —
      and this file builds the field, the face and the button inside it. The page
      owns a place rather than a second version of the behaviour: it cannot open
      a box, send a question or read a reply. A page that owns a door gets no
      dock (the owner's word for the links page was "cluttered"), and a page that
      does not gets the dock, including on a page too short to scroll past the
      reveal. `window.lpAssistant` remains the way in for a page that would
      rather have a plain button of its own.

   7. IT KNOWS WHICH PAGE IT IS STANDING ON, and says so. The last segment of
      the path travels with every question as `page`, and the worker matches it
      against a fixed table of page descriptions before any of it can reach the
      prompt — which is how "how do I book", asked while standing ON the booking
      page, stopped being answered with a link to the booking page. A key nobody
      has described is silent, so a page added next year changes nothing until
      somebody writes it down in `grounding.js`.

   The API base is hardcoded rather than read from the page, because each page
   defines its own constant in its own scope and this file cannot see them. The
   branded hostname is the stable one; it is what every page already calls. */

(function () {
    'use strict';

    var API = 'https://api.libertymusa.com';
    var ENDPOINT = API + '/api/assistant/public';
    /* How much of the conversation travels back with the next question.

       Doubled, from four exchanges to six, after the owner reported that the
       assistant "gives up after a few messages". Part of what it was doing was
       forgetting: this is the ONLY memory the widget has — the studio stores no
       transcript — so a question asked five turns in arrived at the model with
       the first four exchanges, including the visitor's own name and package,
       already gone. A conversation that forgets what it just said does not sound
       confused, it sounds like a stranger, and the model's answer to that is
       either a re-ask or a handover.

       Bounded on purpose, and still small: the worker re-validates every entry
       and caps the COUNT as well as the length, because this is untrusted input
       coming back through a public endpoint. */
    var MAX_HISTORY = 12;

    /* How long a question may go unanswered before the widget starts explaining
       itself, and how long before it gives up and offers somewhere else to go.
       Both are generous: the worker may legitimately spend several model rounds
       on one question, and cutting a slow-but-correct answer short would be its
       own kind of wrong. See the note in send(). */
    var SLOW_AFTER = 12000;
    var GIVE_UP_AFTER = 50000;

    /* THE SUGGESTED QUESTIONS ARE GONE, ALL OF THEM.

       A per-page table of two questions (three on a page nobody named) used to
       stand here, drawn as a scrollable row of chips above the composer. The
       owner asked for it to go: "can we remove all suggestions from the chat?"

       Why the TABLE went with the chips rather than staying behind as data.
       Every question in it had been driven against the live API and answered
       before it was written down, and the suite enforced that, because a
       suggestion is a promise: a tap on a question the assistant cannot answer
       does not fail quietly, it wakes Liberty up for something nobody asked.
       Left as data with nothing drawing it, that promise would still have to be
       kept by hand — by whoever added the next question, for no reader at all.
       A table nobody draws is a rule that only exists to be missed.

       What a visitor gets instead is the greeting and an empty composer: one
       invitation to type, and nothing put into their mouth. The guard that
       replaces this section asserts the chips cannot come back — see
       tools/test-assistant-widget.js. */

    /* The studio's own words for this widget.

       Every value here is a default with a Settings field behind it, so Liberty
       can change what the widget says without anybody opening this file — and
       an unset setting means "use what is written here", never a blank. See
       loadSettings(), which only ever writes over these when the studio has
       actually said something. */
    var SAY = {
        /* The box's NAME, not a heading: it is what the dialog is called — the
           words a screen reader announces when it opens — and it is no longer
           drawn at the top of the chat. See the note on `.lpa-head` in the
           stylesheet, and the studio's Heading field in Settings, which still
           decides this string. */
        title: 'Ask about anything',
        // Shorter and warmer than "Hello — I can tell you about sessions, prices
        // and open dates...", which was both long AND said nothing about who is
        // speaking. This one is a person, it names what it knows, and it sets up
        // the handover before the visitor needs it.
        greeting: "I\u2019m Liberty\u2019s assistant. Ask me about sessions, rates " +
            "or open dates \u2014 and anything I can\u2019t answer, I\u2019ll pass straight to the studio.",
        ask: 'Ask a question',
        placeholder: 'Ask a question\u2026',
        invites: [
            'Hi \u2014 let me help',
            'Ask me anything',
            'Let me help you book',
            'I can answer for you'
        ],
        look: 'smile'        // smile | strokes | bubble — see applyLook/swaps
    };

    /* The speech-bubble glyph, used only when the studio turns the face off. */
    var BUBBLE_PATH = 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z';

    // Do not run twice, and do not run inside someone else's preview harness.
    if (window.__lpAssistantLoaded) return;
    window.__lpAssistantLoaded = true;

    var dock = null;
    var lobeAsk = null;
    var lobeBook = null;
    var wordEl = null;        // the ask lobe's label, and the thing that cycles
    var neck = null;
    var sheet = null;
    var scrim = null;
    var logEl = null;
    var inputEl = null;
    var sendBtn = null;
    var typingEl = null;
    var typingDots = null;
    var avatarEl = null;      // the one face in the log, always on the newest reply
    var sheetOpener = null;   // what opened the sheet, so closing it can put focus back
    var history = [];
    var busy = false;
    var open = false;
    var greetingShown = false;
    var revealed = false;
    var whatsapp = null;      // filled from /api/settings so the fallback is real
    var savedContact = null;  // who this browser said it was, if anyone

    /* ------------------------------------------------------------------ */
    /* Styles — injected once, scoped by the lpa- prefix so nothing here
       can reach the page. Colours come from the site's own tokens with a
       fallback, so this works on every page and in both colour schemes.

       The two floating controls at the foot of a phone were fighting for the
       same strip of screen, so this file now owns that strip: the page's own
       pill is hidden while the dock is alive (see `ownTheFooter`), and the dock
       carries the same action it did. The class that does it is added by
       JavaScript AFTER the dock is built, so a widget that fails to start
       leaves the page's own button exactly where it was. */
    /* ------------------------------------------------------------------ */

    /* One spring, used everywhere. Out-back would overshoot past the target and
       read as bouncy; this eases hard and settles, which is what "expensive"
       looks like. */
    var SPRING = 'cubic-bezier(.16,1,.3,1)';

    var CSS = [
        /* ── the dock ─────────────────────────────────────────────────────── */

        /* ONE piece of glass, not two that match.

           The two halves used to each carry their own glass and meet at a
           pinched corner. Where two translucent surfaces abut, the join shows:
           a hairline of page colour straight down the middle of the capsule,
           which is the "visible space/line between both buttons" that a visitor
           photographed. The glass now belongs to the DOCK, so while it is one
           capsule there is no join inside it to see. A half only takes a
           surface of its own once it has actually come apart — the split, said
           in materials rather than in motion.

           The recipes are variables so the dark-mode block below changes what
           the glass IS rather than repeating every rule that uses it. */
        '.lpa-dock{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom,0px) + var(--lpa-lift,0px));z-index:88;',
        '--lpa-glass:rgba(255,252,248,.62);--lpa-ink:#1a1815;',
        '--lpa-lip:inset 0 1px 0 rgba(255,255,255,.72),0 1px 2px rgba(26,24,21,.07),0 6px 14px rgba(26,24,21,.07);',
        'display:flex;align-items:center;justify-content:center;gap:0;border-radius:999px;',
        'background:var(--lpa-glass);',
        'backdrop-filter:blur(20px) saturate(190%);-webkit-backdrop-filter:blur(20px) saturate(190%);',
        'box-shadow:var(--lpa-lip);',
        'transform:translateX(-50%) translateY(calc(100% + 34px)) scale(.94);opacity:0;pointer-events:none;',
        'transition:transform .66s ' + SPRING + ',opacity .44s ease,gap .52s ' + SPRING + ',',
        'background-color .34s ease,box-shadow .34s ease;will-change:transform,opacity}',
        '.lpa-dock.is-in{opacity:1;transform:translateX(-50%) translateY(0) scale(1);pointer-events:auto}',
        /* Apart: the single surface gives way to two. Transitioned rather than
           switched, so the capsule never blinks as it comes apart. */
        '.lpa-dock.is-open{background:rgba(255,252,248,0);backdrop-filter:none;-webkit-backdrop-filter:none;',
        'box-shadow:inset 0 1px 0 rgba(255,255,255,0),0 10px 30px rgba(26,24,21,0)}',

        '.lpa-lobe,.lpa-neck{background:transparent;color:var(--lpa-ink,#1a1815);',
        'font-family:inherit;font-size:10px;font-weight:600;line-height:1;',
        // No wrapping, ever: a two-line label turns the capsule into a stack of
        // words and doubles its height, which is what it did on a 390px screen.
        'text-transform:uppercase;letter-spacing:1.6px;white-space:nowrap;border:none;cursor:pointer;text-decoration:none;',
        'display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 18px;border-radius:999px;',
        'transition:background-color .34s ease,box-shadow .34s ease,color .32s ease,padding .5s ' + SPRING + ',gap .5s ' + SPRING + ',',
        'border-radius .5s ' + SPRING + ',transform .5s ' + SPRING + '}',
        /* Only a half that has come apart owns a surface, and then it owns the
           same one the dock had — so the split reads as one thing dividing. */
        '.lpa-dock.is-open .lpa-lobe{background:var(--lpa-glass);',
        'backdrop-filter:blur(20px) saturate(190%);-webkit-backdrop-filter:blur(20px) saturate(190%);box-shadow:var(--lpa-lip)}',
        '.lpa-lobe svg{width:14px;height:14px;flex:none}',
        '.lpa-lobe:focus-visible{outline:2px solid var(--accent,#8a7355);outline-offset:3px}',

        /* Flush: the two halves sit edge to edge inside the dock's own surface,
           so there is nothing between them to see. */
        '.lpa-lobe-book{border-radius:999px 0 0 999px;padding-right:15px;transform-origin:left center}',
        '.lpa-lobe-ask{border-radius:0 999px 999px 0;padding-left:15px;transform-origin:right center}',

        /* ── the face ─────────────────────────────────────────────────────── */

        /* One face, drawn in the same 1.9px stroke as every other glyph in the
           site's icon set so it belongs to the family rather than looking like a
           mascot bolted on: two eyes and a mouth, and it blinks. A small sign of
           life, and deliberately the only thing on this page that moves without
           being asked. Breathing, not waving.

           The eyes are short strokes because a blink is a compression: a dot eye
           can only vanish, which reads as a glitch, while a stroke eye closes.
           See the lpa-blink keyframes. */
        '.lpa-face{overflow:visible;transition:transform .4s ' + SPRING + '}',
        '.lpa-face .lpa-eye{transform-box:fill-box;transform-origin:center;animation:lpa-blink 3.4s infinite}',
        /* Faster than it was. A blink that lands every 6.4s is a metronome — you
           notice the interval rather than the face. At 3.4s it reads as
           breathing, which is the whole point of it being the only thing on the
           page that moves unasked. */
        '@keyframes lpa-blink{0%,92%,100%{transform:scaleY(1)}94%,96%{transform:scaleY(.06)}',
        '98%{transform:scaleY(1)}}',

        /* ── the mouth, and the two things this face does ─────────────────── */

        /* Every mouth the face owns is drawn, stacked, and exactly one of them is
           showing. Crossfading rather than interpolating the path: a shape that
           has to morph between a straight line and an arc has to keep the same
           SVG commands, and the moment it cannot, the mouth snaps between them.

             the outline   the resting mouth — one closed shape, rewritten every
                           frame by the engine below. It is the only mouth the
                           face moves, and it is never crossfaded.
             smile         a pointer is on it, or the chat is open

           THE OPEN MOUTH IS A POSE OF THAT OUTLINE, NOT A THIRD DRAWING, and it
           happens only while an answer is on its way. Asked for on 22 September
           2026: "the default state of the assistant face should be the shrinking
           and extending line, the mouth opening should only ever happen when
           replying". Until then it opened at rest, passing through ) and 0 while
           nothing was happening — a face rehearsing rather than listening. */
        '.lpa-face .lpa-mouth{opacity:0;transition:opacity .26s ease}',
        '.lpa-face .lpa-mouth.is-on{opacity:1}',
        '.lpa-lobe-ask:hover .lpa-mouth.is-on,.lpa-dock.is-open .lpa-mouth.is-on{opacity:0}',
        '.lpa-lobe-ask:hover .lpa-mouth.is-smile,.lpa-dock.is-open .lpa-mouth.is-smile{opacity:1}',
        /* While it is answering, the mouth that MOVES is the one to show. The
           sheet being open is exactly when the answer is coming, and without
           this the smile above would be the visible mouth through the whole
           wait. Written against the lobe inside the dock rather than the dock
           alone, so it ties on specificity with the hover rule above and wins by
           being later — otherwise a hovered face would smile while it worked. */
        '.lpa-dock.is-busy .lpa-lobe-ask .lpa-mouth{opacity:0}',
        '.lpa-dock.is-busy .lpa-lobe-ask .lpa-mouth.is-on{opacity:1}',
        '.lpa-lobe-ask:hover .lpa-face,.lpa-dock.is-open .lpa-face,.lpa-dock.is-busy .lpa-face{transform:scale(1.06)}',

        /* ── the resting mouth, and the two movements it has ──────────────── */

        /* The mouth is ONE closed outline whose `d` is rewritten every frame by
           the engine below: its top and bottom edges are both flat when it is
           shut, which IS the straight line the owner asked for, and both bow
           outward as it opens. One element covers every pose, so there is exactly
           one neutral mouth and nothing to keep in step. Nothing here is inside
           the SVG's own markup, so it works in every browser that can set an
           attribute, and it needs no polyfill.

           The owner's own words for the opening: "id like if it can go from -
           to ) to 0". That is the mouth passing THROUGH shapes, and neither a
           transform nor a crossfade can do it: scaling a line only makes a longer
           line, and crossfading stacked mouths can only ever be one of them at a
           time, never between them.

           BOTH MOVEMENTS GO THROUGH THAT ONE ENGINE, which is the correction.
           The resting one used to be a CSS keyframe on a class while the opening
           one was driven from script, so neither could run in the other's state
           and the opening could not be moved onto the answer without a second
           mechanism to keep in step.

             at rest          the line, shrinking and extending
             while answering  the same line, passing through ) and the round 0

           What the studio's setting chooses is the second of those — whether the
           mouth speaks while it answers, only ever breathes, or is still. The
           rest is the line in all three, because that is the face he asked to
           keep. Under prefers-reduced-motion the loop does not run at all — see
           the block at the foot of this stylesheet, which names the eyes and the
           mouths together. */

        /* ── the words it says instead of "ask a question" ─────────────────── */

        /* A few invitations, cycled slowly. Kept quiet on purpose: it swaps at
           a walking pace, it stops for good the moment the visitor opens the
           chat or types, and the capsule's width is pinned to its longest line
           so the dock never twitches as the words change. */
        '.lpa-word{display:inline-block;transition:opacity .34s ease,transform .36s ' + SPRING + '}',
        '.lpa-word.is-swap{opacity:0;transform:translateY(-5px)}',
        '.lpa-dock.is-single .lpa-lobe-book{display:none}',
        '.lpa-dock.is-single .lpa-lobe-ask{border-radius:999px;padding:0 20px}',

        /* Apart: round again, and the pinched joint is gone. */
        '.lpa-dock.is-open{gap:11px}',
        '.lpa-dock.is-open .lpa-lobe-book{border-radius:999px;padding:0 16px}',
        '.lpa-dock.is-open .lpa-lobe-ask{border-radius:999px;padding:0 16px}',
        '.lpa-dock.is-open .lpa-lobe-ask{background:rgba(26,24,21,.9);color:#f7f4ef;',
        'box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 2px 6px rgba(26,24,21,.16)}',

        /* The bridge. It exists only while the two halves are coming apart or
           going back together, which is what makes the split read as liquid
           rather than as a gap opening. */
        '.lpa-neck{width:0;padding:0;opacity:0;pointer-events:none;border-radius:999px}',
        '.lpa-neck.is-live{animation:lpa-bridge .56s ' + SPRING + '}',
        '@keyframes lpa-bridge{0%{width:0;opacity:0}38%{width:22px;opacity:1}100%{width:0;opacity:0}}',
        /* …and each half leans toward the other before it lets go. */
        '.lpa-dock.is-stretching .lpa-lobe{animation:lpa-liquify .56s ' + SPRING + '}',
        '@keyframes lpa-liquify{0%{transform:scale(1,1)}44%{transform:scaleX(1.16) scaleY(.88)}100%{transform:scale(1,1)}}',

        /* ── the scrim ────────────────────────────────────────────────────── */

        '.lpa-scrim{position:fixed;inset:0;z-index:89;background:rgba(20,18,16,.26);',
        'backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);opacity:0;pointer-events:none;',
        'transition:opacity .42s ease}',
        '.lpa-scrim.is-on{opacity:1;pointer-events:auto}',

        /* ── the sheet ────────────────────────────────────────────────────── */

        /* It grows out of the capsule: the transform origin is the dock's own
           centre, so the first frames look like the lobe opening rather than a
           window appearing. The radius starts round and tightens as it settles,
           which is the liquid part of the motion. */
        /* The sheet's own height is what put its title bar above the top of an
           iPhone screen — and it did it twice, for two different reasons.

           First, `vh` on iOS means the LARGE viewport, the one that assumes the
           URL bar has gone, so any vh-based height reaches higher than the
           screen; that is why it is capped against `svh`, the height that is
           definitely there.

           Second, and this is the one a visitor photographed: the sheet sits
           `bottom: foot + safe-area + lift`, but its height only subtracted
           `foot` and `lift`. That leaves exactly the safe-area inset (34px on a
           notched iPhone) sticking out past the top of the screen — so the
           moment the keyboard came up, the title and the close button went off
           the top and there was no way out of the chat but to reload the page.

           So every part of `bottom` is now also subtracted from the height, plus
           a small gap so the head can never touch the top edge, and the whole
           sum lives in ONE custom property that `bottom` and `max-height` both
           read. There is no longer a term that can be added to one and
           forgotten in the other.

           (`--lpa-safe` is the safe-area inset, and the keyboard state zeroes
           it: with the keys up the home-indicator strip is behind the keyboard,
           so reserving for it would only push the sheet off the top again.) */
        /* ── the sheet's own surface, and why it is a FALLBACK ───────────────

           The sheet takes its colours from the page when the page names them:
           `--bg-container`, `--text-primary` and `--border-color` are the
           studio's token names, and most pages map them onto their own palette.
           Four do not — links, gallery, wedding and pay are all missing the first
           two — so the sheet fell straight through to a literal `#fff` and opened
           as a WHITE PANEL ON A DARK PAGE.

           Found on 22 September 2026 by opening the links page in dark mode and
           looking at it, having been live for as long as the sheet has existed.
           It is worth naming why nothing caught it: every screenshot anybody had
           taken of this widget was taken in light mode, and in light mode the
           literal and the page's own token are the same colour to within a shade.

           So the defaults are NAMED and SCHEME-AWARE — the dark block further down
           swaps them — which means a page that forgets gets a sheet belonging to
           the scheme its visitor is actually in. A page that names them still
           wins, which is the whole point of a fallback. */
        '.lpa-sheet{position:fixed;left:50%;',
        '--lpa-safe:env(safe-area-inset-bottom,0px);--lpa-top-gap:10px;',
        '--lpa-sheet-bg:#fff;--lpa-sheet-ink:#1a1815;--lpa-sheet-line:#e8e3d9;',
        '--lpa-sheet-rim:rgba(255,255,255,.35);',
        'bottom:calc(var(--lpa-foot,68px) + var(--lpa-safe) + var(--lpa-lift,0px));',
        'z-index:90;width:min(420px,calc(100vw - 22px));',
        'max-height:min(calc(100svh - var(--lpa-foot,68px) - var(--lpa-safe) - var(--lpa-lift,0px) - var(--lpa-top-gap)),620px);',
        'display:flex;flex-direction:column;overflow:hidden;transform-origin:50% 118%;',
        'background:var(--bg-container,var(--lpa-sheet-bg));color:var(--text-primary,var(--lpa-sheet-ink));',
        'border:1px solid var(--border-color,var(--lpa-sheet-line));border-radius:30px;',
        'box-shadow:0 30px 80px rgba(26,24,21,.28),0 1px 0 var(--lpa-sheet-rim) inset;',
        'font-family:inherit;font-size:14px;line-height:1.6;',
        'opacity:0;pointer-events:none;transform:translateX(-50%) translateY(22px) scale(.38);',
        'transition:transform .6s ' + SPRING + ',opacity .36s ease,border-radius .6s ' + SPRING + ',max-height .4s ease;',
        'will-change:transform,opacity}',
        '.lpa-sheet.is-on{opacity:1;pointer-events:auto;transform:translateX(-50%) translateY(0) scale(1);border-radius:24px}',
        /* The content waits for the shell to arrive, so nothing is stretched on
           the way in. */
        '.lpa-in{opacity:0;transform:translateY(10px);transition:opacity .3s ease,transform .42s ' + SPRING + '}',
        '.lpa-sheet.is-on .lpa-in{opacity:1;transform:none;transition-delay:.1s}',

        /* `flex:none` on every fixed row is not decoration: in a flex column
           with a height cap, anything without it is squeezed when the content
           grows, and the header — the row holding the only way out of this
           sheet — is the first thing to be crushed. The log absorbs the shrink
           instead, because it is the only row that can. */
        '.lpa-head{position:relative;flex:none;display:flex;align-items:center;justify-content:flex-end;gap:12px;',
        'padding:9px 9px 0}',
        '.lpa-close{flex:none;width:32px;height:32px;border-radius:50%;border:none;background:transparent;color:inherit;',
        'cursor:pointer;display:grid;place-items:center;opacity:.55;transition:opacity .25s ease,background-color .25s ease,transform .4s ' + SPRING + '}',
        '.lpa-close:hover{opacity:1;background:var(--highlight-bg,#f8f4ec)}',
        '.lpa-close:active{transform:scale(.92)}',
        '.lpa-close svg{width:13px;height:13px}',
        /* THE HEAD IS A CLOSE BUTTON AND NOTHING ELSE.

           It used to be three things: a grab handle, a heading reading "Ask
           about anything", and the ×. On a phone that is a title bar's worth of
           height over a conversation, and the heading said the same generic
           thing on every page of the site — the one line in the sheet that could
           have been any studio's. The visitor can see what this is: the face is
           on the newest reply and the first words are the assistant introducing
           itself.

           Both are gone as DRAWN things, which is not the same as gone as
           behaviour, so the two halves are worth stating separately:

           * the handle was only ever decoration. The gesture it advertised still
             works — the head is still the sheet's drag surface — and a sheet is
             dragged by its top edge by everyone who has ever used one.
           * the heading is still the box's NAME. It is on the dialog as its
             accessible name, so a screen reader still announces it, and the
             studio's own heading setting still decides what that name is. The
             field is not a lie; it is simply no longer printed on screen. */

        /* ── the conversation ─────────────────────────────────────────────── */

        '.lpa-log{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;',
        'padding:14px 15px 6px;display:flex;flex-direction:column;gap:13px}',
        /* The studio answers as plain text, the way a person writes: no bubble,
           no border, nothing to click. The visitor's own words get the pill. */
        '.lpa-bot{font-size:15px;line-height:1.72;color:var(--text-primary,#1a1815);max-width:94%;white-space:pre-wrap;word-break:break-word}',
        /* THE LATEST REPLY WEARS THE FACE, AND ONLY THE LATEST ONE.

           A conversation with no speaker is a wall of italic-free text: the
           visitor's own words are a pill, and everything else is a paragraph
           nobody is visibly saying. One face — the same drawing as the dock's,
           moved rather than copied — sits on the newest reply and travels down
           as the conversation grows. It is the assistant's turn to speak that
           it marks, so it lives on the newest line and never accumulates: an
           avatar on every reply is a wall of faces, and a face on the FIRST
           reply is a face that is no longer talking. */
        '.lpa-said{display:flex;gap:10px;align-items:flex-start}',
        '.lpa-avatar{flex:none;width:15px;height:15px;margin-top:5px;color:var(--accent,#8a7355)}',
        '.lpa-avatar svg{width:100%;height:100%;display:block}',
        '.lpa-me{align-self:flex-end;max-width:86%;padding:9px 14px;border-radius:15px 15px 4px 15px;',
        'background:var(--highlight-bg,#f8f4ec);font-size:14.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
        /* A destination the assistant named, made tappable — a URL in a
           paragraph is not something anyone can use on a phone. Marked with an
           underline rather than a button: it is part of the sentence it is in,
           not a second call to action competing with the visitors own words. */
        '.lpa-link{color:inherit;text-decoration:underline;text-decoration-color:var(--accent,#8a7355);',
        'text-underline-offset:2.5px;text-decoration-thickness:1px;font-weight:500}',
        '.lpa-link:hover{text-decoration-thickness:2px}',
        '.lpa-note{display:flex;gap:9px;align-items:flex-start;font-size:12.5px;line-height:1.6;',
        'color:var(--text-secondary,#6b6459);max-width:96%}',
        '.lpa-note::before{content:"";flex:none;width:4px;height:4px;border-radius:50%;margin-top:7px;',
        'background:var(--accent,#8a7355);opacity:.8}',
        '.lpa-card{border-radius:16px;padding:13px;background:var(--highlight-bg,#f8f4ec);',
        'display:flex;flex-direction:column;gap:8px;max-width:100%}',
        '.lpa-card p{font-size:13px;color:var(--text-secondary,#6b6459);line-height:1.6;margin:0}',
        '.lpa-typing{display:flex;gap:4px;align-items:center;padding:3px 0}',
        /* Three dots with no explanation is what "it just kept loading" looks
           like from the other side. Once a wait passes the point where silence
           starts to read as broken, the dots say what they are doing. */
        '.lpa-typing.is-slow::after{content:"Still checking the studio\u2019s records\u2026";',
        'font-size:12px;color:var(--text-secondary,#6b6459);margin-left:7px;white-space:nowrap}',
        '.lpa-typing i{width:5px;height:5px;border-radius:50%;background:var(--accent,#8a7355);opacity:.45;',
        'animation:lpa-dot 1.15s ease-in-out infinite}',
        '.lpa-typing i:nth-child(2){animation-delay:.16s}',
        '.lpa-typing i:nth-child(3){animation-delay:.32s}',
        /* The waiting row's own face, sized to sit in that row rather than in the
           conversation: the avatar's 5px top margin exists to drop it onto the
           first line of a paragraph, and in a row of dots it would only push the
           face off centre. */
        '.lpa-typing .lpa-avatar{width:15px;height:15px;margin-top:0;margin-right:1px}',
        '@keyframes lpa-dot{0%,100%{opacity:.22;transform:translateY(0)}50%{opacity:.85;transform:translateY(-2px)}}',


        /* ── the door a page owns ─────────────────────────────────────────── */

        /* The links page is a list of destinations, and the assistant is the
           only one of them that ANSWERS. So the page owns a PLACE and the
           widget builds the thing that stands in it.

           `data-lp-door` is that place: an empty element in the page's own
           markup, filled here with the same face the dock uses, shaped like the
           page's own cards so it belongs among them, and opening the same
           conversation.

           IT IS A CARD, NOT A FIELD, and that is the correction. The first
           version put a real text field on the page: the visitor typed their
           question there, and the answer — and a SECOND field — arrived in the
           sheet that opened over it. Two boxes for one conversation, and the
           one they had already typed into was the useless one, because a field
           on the page cannot show a reply, keep the history or hold the
           greeting; it existed only to be abandoned halfway. Tapping the card
           opens the assistant itself, which is the whole of what the visitor
           meant, and there is one place in the world to type: the composer, in
           the same box the answer will appear in.

           No field here also means no 16px rule to keep — there is no input in
           a door for iOS to zoom the page for. */
        '.lpa-door{display:flex;align-items:center;gap:13px;width:100%;box-sizing:border-box;text-align:left;',
        'padding:15px 16px;border:1px solid var(--border-color,#e8e3d9);border-radius:18px;',
        'background:var(--bg-card,#fefdfb);color:inherit;font:inherit;cursor:pointer;',
        'box-shadow:0 2px 8px rgba(26,24,21,.05);',
        'transition:border-color .25s ease,box-shadow .25s ease,transform .25s ease}',
        '@media (hover:hover){.lpa-door:hover{border-color:var(--accent,#8a7355);transform:translateY(-2px);',
        'box-shadow:0 10px 26px rgba(26,24,21,.12)}}',
        '.lpa-door:active{transform:translateY(0)}',
        '.lpa-door:focus-visible{outline:none;border-color:var(--accent,#8a7355);box-shadow:0 0 0 4px rgba(138,115,85,.14)}',
        '.lpa-door-face{flex:none;width:22px;height:22px;color:var(--accent,#8a7355)}',
        '.lpa-door-face svg{width:100%;height:100%;display:block}',
        '.lpa-door-copy{flex:1;min-width:0}',
        '.lpa-door-title{font-weight:600;font-size:13.5px;letter-spacing:.2px}',
        '.lpa-door-sub{font-size:11.5px;color:var(--text-secondary,#6b6459);margin-top:3px}',
        '.lpa-door-arrow{flex:none;color:var(--text-secondary,#6b6459);font-size:16px;opacity:.45}',

        /* ── the composer ─────────────────────────────────────────────────── */

        '.lpa-compose{flex:none;padding:11px 13px 13px}',
        /* The ring lives on the wrapper so the whole thing lights up on focus,
           and the field itself stays chrome-free. */
        '.lpa-ring{display:flex;align-items:flex-end;gap:8px;padding:5px 5px 5px 16px;',
        'border:1px solid var(--border-color,#e8e3d9);border-radius:26px;background:var(--bg-card,#fefdfb);',
        'transition:border-color .3s ease,box-shadow .3s ease}',
        '.lpa-ring:focus-within{border-color:var(--accent,#8a7355);box-shadow:0 0 0 4px rgba(138,115,85,.10)}',
        /* 16px, not 14. See decision 5 at the top of this file: anything smaller
           and iOS zooms the page on focus and never zooms back. */
        // box-sizing matters here: height is set from scrollHeight, which counts
        // the padding, so a content-box field would render 19px taller than the
        // number it was given and overrun its own max-height.
        '.lpa-input{flex:1;min-width:0;box-sizing:border-box;border:none;background:transparent;color:inherit;',
        'font:inherit;font-size:16px;line-height:1.5;resize:none;padding:9px 0 10px;max-height:132px;overflow-y:auto}',
        '.lpa-input:focus{outline:none}',
        '.lpa-input::placeholder{color:var(--text-secondary,#6b6459);opacity:.75}',
        '.lpa-send{flex:none;width:36px;height:36px;border-radius:50%;border:none;display:grid;place-items:center;',
        'background:var(--btn-primary-bg,#1a1815);color:var(--btn-primary-text,#fff);cursor:pointer;',
        'transition:transform .45s ' + SPRING + ',opacity .25s ease}',
        '.lpa-send svg{width:15px;height:15px}',
        '.lpa-send:disabled{opacity:.35;cursor:default}',
        '.lpa-send:not(:disabled):active{transform:scale(.9)}',

        '.lpa-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:11px 18px;',
        'border-radius:999px;text-decoration:none;border:none;cursor:pointer;font-family:inherit;font-size:12.5px;',
        'font-weight:600;letter-spacing:.2px;background:var(--btn-primary-bg,#1a1815);color:var(--btn-primary-text,#fff);',
        'transition:transform .45s ' + SPRING + ',opacity .25s ease}',
        '.lpa-btn:active{transform:scale(.98)}',
        '.lpa-btn.is-ghost{background:transparent;color:inherit;border:1px solid var(--border-color,#e8e3d9)}',
        '.lpa-btn.is-wide{width:100%;box-sizing:border-box}',
        '.lpa-btn svg{width:14px;height:14px}',
        '.lpa-form{display:flex;flex-direction:column;gap:8px}',
        /* 16px here too, for the same reason as the composer. */
        '.lpa-field{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:12px;',
        'border:1px solid var(--border-color,#e8e3d9);background:transparent;color:inherit;font:inherit;font-size:16px}',
        '.lpa-field:focus{outline:none;border-color:var(--accent,#8a7355);box-shadow:0 0 0 4px rgba(138,115,85,.10)}',
        '.lpa-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}',
        '.lpa-row{display:flex;flex-direction:column;gap:9px}',

        /* A 390px phone is the tightest case there is, and the dock is two
           labels and two glyphs wide: the tracking and the padding come down
           together so the capsule stays a capsule instead of a wrapped stack. */
        /* While the keyboard is up the capsule stands down and the sheet drops to
           the keys: the visitor is mid-sentence, and the dock is 110px of chrome
           they did not ask for. Both come back the moment the keyboard closes. */
        'html.lpa-keys{--lpa-foot:12px}',
        /* The sheet reads --lpa-safe off itself, so the override has to land on
           the sheet rather than on html — a value set on the element wins over
           anything inherited, which would have made this a no-op. */
        'html.lpa-keys .lpa-sheet{--lpa-safe:0px;--lpa-top-gap:8px}',
        'html.lpa-keys .lpa-dock{opacity:0;pointer-events:none;transform:translateX(-50%) translateY(calc(100% + 34px))}',

        '@media (max-width:430px){',
        '.lpa-lobe{font-size:9px;letter-spacing:1.2px;gap:7px;height:40px;padding:0 14px}',
        '.lpa-lobe-book{padding-right:12px}.lpa-lobe-ask{padding-left:12px}',
        '.lpa-dock.is-open .lpa-lobe-book{padding:0 13px}.lpa-dock.is-open .lpa-lobe-ask{padding:0 13px}}',

        '@media (prefers-color-scheme:dark){',
        '.lpa-dock{--lpa-glass:rgba(38,36,32,.6);--lpa-ink:#f3f0ea;',
        '--lpa-lip:inset 0 1px 0 rgba(255,255,255,.12),0 1px 2px rgba(0,0,0,.22),0 7px 16px rgba(0,0,0,.22)}',
        /* Every `--lpa-sheet-*` the rule above names, so a page that does not
           map the studio's own tokens gets a sheet belonging to the scheme its
           visitor is in. The suite asserts this list against that one: add a
           token up there and forget it here is exactly how the white panel
           happened the first time. */
        '.lpa-sheet{--lpa-sheet-bg:#201e1b;--lpa-sheet-ink:#f3f0ea;--lpa-sheet-line:#35332d;',
        '--lpa-sheet-rim:rgba(255,255,255,.06)}',
        '.lpa-dock.is-open .lpa-lobe-ask{background:rgba(243,240,234,.94);color:#1a1815}',
        '.lpa-scrim{background:rgba(0,0,0,.42)}}',

        /* The page's own floating pill, stood down. Two of them cannot share
           the foot of a phone: hers sat centred and collapsed to a circle while
           this one sat to its right, and on a 390px screen they landed on top of
           each other ("SEE PACKAGES" and "SK A QUESTION"). The dock IS that
           button now — same label, same destination, read out of the page — so
           the page's copy is hidden for as long as the dock is alive, and this
           class is only ever added after the dock has been built. `!important`
           because the page sets those properties itself and either one alone
           would leave a ghost behind. */
        'html.lpa-dock-alive .lp-float-book{display:none!important}',

        '@media (prefers-reduced-motion:reduce){',
        '.lpa-dock,.lpa-sheet,.lpa-in,.lpa-neck,.lpa-lobe,.lpa-send,.lpa-btn,.lpa-door,',
        '.lpa-word,.lpa-face,.lpa-face .lpa-eye,.lpa-face .lpa-mouth,',
        '.lpa-bare{transition:none!important;animation:none!important}}'
    ].join('');

    function injectStyles() {
        if (document.getElementById('lpa-styles')) return;
        var s = document.createElement('style');
        s.id = 'lpa-styles';
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    /* ------------------------------------------------------------------ */

    function el(tag, className, text) {
        var n = document.createElement(tag);
        if (className) n.className = className;
        if (text != null) n.textContent = text;
        return n;
    }

    function icon(path, size) {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', size || '1.9');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', path);
        svg.appendChild(p);
        return svg;
    }

    /* The face's geometry, in the 24-box every other icon on this site is drawn
       in. ONE definition for both looks — the circle is the only thing that
       changes between them, because the bare look is this face with the head
       taken off, not a second icon that has to be kept in step with the first.

       The gap between the eyes and the mouth is what makes a face read as a face
       instead of a diagram, and it was got wrong the first time: the eyes ended
       at 11.3 and the mouth began at 13.2, which with a 1.9px stroke means the
       edges were TOUCHING — the smile appeared to sit on the eyes. The eyes now
       end at 10.8 and every mouth is built around a line at 14.8, which leaves
       about two stroke-widths of air between them.

       The mouth that is `is-on` is the resting one; the CSS overrides it for
       hover, for an open chat and for a request in flight. */
    var SVG_NS = 'http://www.w3.org/2000/svg';
    var EYE_TOP = 8.5, EYE_LEN = 2.3, EYE_LEFT = 9.3, EYE_RIGHT = 14.7;
    var MOUTH_Y = 14.8, MOUTH_HALF = 3.3;
    var FACE_MID = 12;

    /* The bare look is drawn a little LARGER than the head look, and this is the
       one place the two looks differ in more than their silhouette.

       Taking the head away takes the ink with it: the circle reaches 9.1 units
       from the centre while the bare face's own drawing only reaches 6.2, so at
       the same size the bare face sits in its button looking 30% lighter and
       smaller than the face it replaced — two looks that are meant to be the
       same character reading as two different weights. Compensated optically,
       not geometrically: the ink is scaled about the centre of the box, so the
       face stays symmetrical and the eye/mouth spacing keeps its proportions
       instead of needing a second set of numbers nobody would remember to
       change together.

       1.32 is the number the two looks were compared at, side by side, in the
       sizes the dock uses: below about 1.25 the bare face still reads as the
       smaller of the two, and by 1.4 the mouth has stretched long enough to be a
       wider character rather than the same one. */
    var BARE_SCALE = 1.32;

    /* ── THE MOUTH'S OWN LIFE ────────────────────────────────────────────────

       The owner asked for the mouth to pass through three shapes rather than
       only widen: "id like if it can go from - to ) to 0". A day later he
       corrected WHERE that belongs: "the default state of the assistant face
       should be the shrinking and extending line, the mouth opening should only
       ever happen when replying". So there are two movements on one outline —
       the line at rest, and that same line opening while an answer is on its way
       — and this walks one number round whichever of them is in force.

       BOTH ARE HERE, and that is the fix rather than a tidy-up: the resting
       movement used to be a CSS keyframe on a class while the opening one was
       driven from script, so neither could run in the other's state.

       WHY A FUNCTION AND NOT A KEYFRAME. CSS cannot interpolate an SVG path in
       every browser the site supports (animating `d` works in Chrome and very
       recent Safari and not in Firefox), and a browser that cannot is a browser
       where the face is motionless with nothing saying so. Setting an attribute
       from requestAnimationFrame works everywhere, and it is what lets the shape
       be a real shape: the shut pose, the small bottom-heavy `)` and the round
       `0` are three points on one continuous curve rather than three drawings
       cut together.

       WHAT IT COSTS, MEASURED RATHER THAN ASSUMED. One attribute write, at 24
       frames a second, on one element that is a few dozen bytes — chosen against
       a full 60 because the movement is slow enough that 24 is indistinguishable
       and it is a third of the writes. The loop does NOT run while the tab is in
       the background, does not run at all for anyone who has asked for less
       motion, and does not run in the two settings that are not "talk". A
       forever-animation that keeps painting behind a hidden tab is how a site
       quietly eats a phone battery, and the whole point of this face is that it
       should cost a visitor nothing to have on the page. */
    var NEUTRAL_MOUTHS = [];

    /* THE SPOKEN CYCLE. The three poses, as fractions of one cycle: shut, the
       small opening that reads as `)`, and the round one that reads as `0` —
       then back, with a beat of stillness at each end so it reads as somebody
       speaking rather than as a machine looping. It runs ONLY while an answer is
       on its way. */
    var MOUTH_SPOKEN = [
        //  t     top   bot   grow
        [0.00, 0, 0, 0],
        [0.24, 0, 0, 0],
        [0.38, 0.55, 1.5, 0.02],
        [0.52, 1.9, 2.6, 0.10],
        [0.66, 1.65, 2.35, 0.08],
        [0.80, 0.5, 1.2, 0.02],
        [1.00, 0, 0, 0]
    ];

    /* THE RESTING MOVEMENT, as one number: the line's half-width, as a fraction
       of itself, at the widest point of the breath. It was a CSS keyframe
       scaling between .86 and 1.16 — the same movement, asymmetrically
       eyeballed — and its shape is the same here: a full cycle in, wider, out,
       narrower, back. Both ends of it pass through the shut line, which is why
       switching between resting and speaking cannot produce a jump worth
       smoothing: the two differ by at most this fraction of a 6.6-unit mouth,
       which is half a pixel at the size the dock draws it. */
    var MOUTH_BREATH = 0.15;

    /* One full cycle at each pace, for BOTH movements. "lively" is the default
       and is deliberately quicker than the 5.2s the resting movement used to
       take — that is the other half of what was asked for. None is a multiple of
       the blink's 3.4s: two cycles that stay in step become a metronome. */
    var MOUTH_MS = { calm: 4800, lively: 3200, quick: 2200 };

    /* What the studio's setting chooses — and it is a choice about ANSWERING now,
       not about resting, because the rest is the line in every one of them:

         talk     the line, then ), then the round 0, while it answers
         line     the line while it answers, never opening
         still    nothing moves at all

       THREE behaviours, not four, and the difference matters: the dashboard's
       dropdown has to offer one option per behaviour, because two names for one
       movement in a list of choices is a list that lies. So the names this row
       has held BEFORE are not in here. They are in MOUTH_ALIAS below, one line
       each, which is the only place a legacy value is allowed to live. */
    var MOUTH_STYLES = { talk: 1, line: 1, still: 1 };
    /* Names this setting held while it meant something else, and what they mean
       now. One entry today:

         breathe   "widens and narrows slowly" — a RESTING movement, which is
                   what the rest used to be. The rest is the line in every
                   setting now, so the only question left is what happens while
                   it answers, and somebody who chose a slow widening chose a
                   movement rather than a mouth that never opens. It resolves to
                   the opening, not to silence: the owner's words for the
                   opening were "the mouth opening should only ever happen when
                   replying", and the live studio's row still reads `breathe`.
                   Left unhandled, that row would give the face that never once
                   opened while it answered — the opposite of what was asked.

       A legacy name is resolved BEFORE the lookup, so the value the studio's
       row holds and the value the dropdown offers are the same behaviour — and
       `test-assistant-widget.js` checks that every name in here is one the
       dropdown can actually reach. */
    var MOUTH_ALIAS = { breathe: 'talk' };
    /* Which of those open the mouth while a reply is on its way. */
    var MOUTH_OPENS = { talk: 1 };
    var MOUTH_STYLE = 'talk';
    var MOUTH_PACE = 'lively';
    var MOUTH_FRAME_MS = 1000 / 24;

    /* True only while a reply is being waited for. Set by typing(), read every
       frame, so EVERY face on the page speaks together — the dock's, the newest
       reply's, and the one on a page that owns a door and has no dock at all. */
    var MOUTH_SPEAKING = false;

    var mouthFrame = 0;    // the pending requestAnimationFrame, 0 when stopped
    var mouthClock = 0;    // when this run started, in the frame's own clock
    var mouthDrawn = 0;    // the elapsed time the last path write happened at

    /* The outline of the mouth for one pose, in the 24-box every other icon on
       this site is drawn in. `at` is the face's own box transform, passed in
       because the bare look is the same face at a different scale and a path
       built for one is wrong for the other.

       `top`, `bot` and `grow` are CONTROL-POINT offsets rather than the visible
       depth of the opening: a cubic's middle sits about three quarters of the
       way to its controls, so `bot` 2.6 opens the mouth about 1.95 units below
       the line it rests on. Named for what they are so nobody has to reverse the
       factor to change one.

       The ends never move: they are the same two points the smile's ends sit on,
       so the face does not jump when the mouth changes state. */
    function mouthPath(at, top, bot, grow) {
        var half = MOUTH_HALF * (1 + grow);
        var bend = half * 0.55;
        var y = at(MOUTH_Y);
        var l = at(FACE_MID - half), r = at(FACE_MID + half);
        var lc = at(FACE_MID - half + bend), rc = at(FACE_MID + half - bend);
        return 'M' + l + ' ' + y +
            'C' + lc + ' ' + at(MOUTH_Y - top) + ' ' + rc + ' ' + at(MOUTH_Y - top) +
            ' ' + r + ' ' + y +
            'C' + rc + ' ' + at(MOUTH_Y + bot) + ' ' + lc + ' ' + at(MOUTH_Y + bot) +
            ' ' + l + ' ' + y + 'Z';
    }

    /** Ease in and out of each pose, so nothing arrives at a corner. */
    function mouthEase(t) {
        return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    }

    /** The pose at a point in the spoken cycle, interpolated between the poses
        above. */
    function spokenPose(t) {
        for (var i = 1; i < MOUTH_SPOKEN.length; i++) {
            var a = MOUTH_SPOKEN[i - 1], b = MOUTH_SPOKEN[i];
            if (t > b[0]) continue;
            var span = b[0] - a[0];
            var f = span > 0 ? mouthEase(Math.max(0, Math.min(1, (t - a[0]) / span))) : 0;
            return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
        }
        return [0, 0, 0];
    }

    /** The resting pose at a point in the cycle: the shut line, widened and
        narrowed. A sine rather than a table of poses, because it is ONE movement
        and a three-point table would round its ends off into a crawl, pause,
        crawl. `top` and `bot` are zero throughout: at rest the mouth is a line,
        and a line that opens is the other cycle. */
    function restPose(t) {
        return [0, 0, MOUTH_BREATH * Math.sin(Math.PI * 2 * t)];
    }

    /** Write one pose to every live resting mouth. */
    function paintMouth(top, bot, grow) {
        var live = [];
        for (var i = 0; i < NEUTRAL_MOUTHS.length; i++) {
            var m = NEUTRAL_MOUTHS[i];
            // A swapped look or a redrawn face slot leaves its old path behind,
            // and it is dropped here rather than at the moment it is orphaned:
            // the list would otherwise grow for the life of the page.
            if (!m.el.isConnected) continue;
            live.push(m);
            m.el.setAttribute('d', mouthPath(m.at, top, bot, grow));
        }
        if (live.length !== NEUTRAL_MOUTHS.length) NEUTRAL_MOUTHS = live;
    }

    /** Say that an answer is on its way, or that it has arrived. THE ONLY thing
        that opens the mouth, and the reason the face has no `is-open` element
        left in it: opening is a pose of the one outline, so this flag is all a
        face has to be given. Nothing restarts and nothing is rebuilt — the next
        frame reads the new value, which is what makes the change invisible. */
    function speak(on) {
        MOUTH_SPEAKING = !!on;
    }

    function stopMouth() {
        if (mouthFrame) window.cancelAnimationFrame(mouthFrame);
        mouthFrame = 0;
        mouthClock = 0;
    }

    function mouthTick(stamp) {
        mouthFrame = 0;
        // Checked every frame rather than once at the start: a visitor can hide
        // the tab, can change their motion preference, and an answer can arrive,
        // while this is running.
        if (MOUTH_STYLE === 'still' || document.hidden || reducedMotion()) return;
        var now = typeof stamp === 'number' ? stamp : Date.now();
        if (!mouthClock) { mouthClock = now; mouthDrawn = now - MOUTH_FRAME_MS; }
        var elapsed = now - mouthClock;
        if (elapsed - mouthDrawn >= MOUTH_FRAME_MS) {
            mouthDrawn = elapsed;
            var t = (elapsed % MOUTH_MS[MOUTH_PACE]) / MOUTH_MS[MOUTH_PACE];
            /* WHICH CYCLE IS IN FORCE is read here, every frame, rather than set
               wherever an answer is asked for: an answer is asked for from three
               places (the sheet, a door, a retry after a slow reply) and a mouth
               each of them had to remember to tell is a mouth that keeps opening
               on a page somebody forgot to update. */
            var pose = (MOUTH_SPEAKING && MOUTH_OPENS[MOUTH_STYLE]) ? spokenPose(t) : restPose(t);
            paintMouth(pose[0], pose[1], pose[2]);
        }
        mouthFrame = window.requestAnimationFrame(mouthTick);
    }

    /** (Re)start the mouth from the settings that are in force right now. Safe to
        call as often as the settings change, and the only way anything starts it.

        The loop now runs for the RESTING movement too, in every setting but
        "still": the line shrinking and extending IS the resting face, so a
        setting can no longer be the thing that switches the idle movement off. */
    function startMouth() {
        stopMouth();
        // A visitor who asked for less motion gets the shut mouth and no loop at
        // all — not a loop that draws the same shape, which is still a wake-up.
        if (reducedMotion() || MOUTH_STYLE === 'still') {
            paintMouth(0, 0, 0);
            return;
        }
        mouthFrame = window.requestAnimationFrame(mouthTick);
    }

    /* A tab that goes away stops the mouth and a tab that comes back restarts it,
       so a page left open in a background tab is not quietly animating. */
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) stopMouth(); else startMouth();
    });

    function faceSVG(bare) {
        var svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        /* Everything below is written in the head look's coordinates and passed
           through this, so the bare look cannot drift from the face. */
        var k = bare ? BARE_SCALE : 1;
        function at(v) { return Math.round((FACE_MID + (v - FACE_MID) * k) * 100) / 100; }
        function size(v) { return Math.round(v * k * 100) / 100; }
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.9');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('class', bare ? 'lpa-face lpa-bare' : 'lpa-face');

        if (!bare) {
            var head = document.createElementNS(SVG_NS, 'circle');
            head.setAttribute('cx', '12');
            head.setAttribute('cy', '12');
            head.setAttribute('r', '9.1');
            svg.appendChild(head);
        }

        [EYE_LEFT, EYE_RIGHT].forEach(function (x) {
            var eye = document.createElementNS(SVG_NS, 'path');
            eye.setAttribute('d', 'M' + at(x) + ' ' + at(EYE_TOP) + 'v' + size(EYE_LEN));
            eye.setAttribute('class', 'lpa-eye');
            svg.appendChild(eye);
        });

        var left = FACE_MID - MOUTH_HALF, width = MOUTH_HALF * 2;

        /* The resting mouth: one closed outline, drawn SHUT here and rewritten
           every frame by the engine above. `at` travels with it because the bare
           look is the same face at a different scale, and the engine needs the
           transform this particular face was drawn with. */
        var rest = document.createElementNS(SVG_NS, 'path');
        rest.setAttribute('d', mouthPath(at, 0, 0, 0));
        rest.setAttribute('class', 'lpa-mouth is-neutral is-on');
        svg.appendChild(rest);
        NEUTRAL_MOUTHS.push({ el: rest, at: at });

        /* A smile whose ends sit ON that line, so the face does not jump when
           the mouth changes — the middle dips instead. The radii are chosen for
           the dip, not for a circle: a semicircle here is a grin with nothing
           behind it. */
        mouth('M' + at(left) + ' ' + at(MOUTH_Y) + 'a' + size(3.8) + ' ' + size(3.4) +
            ' 0 0 0 ' + size(width) + ' 0', 'is-smile');

        /* THERE IS NO SEPARATE OPEN MOUTH ANY MORE. It was an ellipse stacked
           under the line and crossfaded in while an answer was being composed;
           now the line OPENS — see the engine — so the face keeps one mouth and
           the opening is the same drawing at a different pose. A face with a
           second mouth is a face with two mouths to keep in step, and the second
           one is exactly what was opening while nothing was happening. */

        return svg;

        function mouth(d, cls, on) {
            var p = document.createElementNS(SVG_NS, 'path');
            p.setAttribute('d', d);
            p.setAttribute('class', 'lpa-mouth ' + cls + (on ? ' is-on' : ''));
            svg.appendChild(p);
        }
    }

    /* The two looks this face has. The second is the same face with the head
       taken off — the two eyes and the mouth, and nothing around them. */
    function faceIcon() { return faceSVG(false); }
    function strokesIcon() { return faceSVG(true); }

    /* ------------------------------------------------------------------ */
    /* A destination the assistant named, made tappable.

       The assistant is told to hand out /book and /wedding rather than to
       describe them, but a path in a paragraph is dead text: on a phone there
       is nothing to tap. So the destinations it is allowed to give become real
       links — and only those.

       This is a SPLIT on a fixed list, never a markup parse, so the model
       cannot introduce a link nobody wrote: it can only choose to mention one
       of the studio's own pages. Nothing here goes near innerHTML — a reply is
       text, and this builds text nodes and anchors. A reply that mentions no
       destination comes out as exactly the plain text it was. */

    var LINK_SET = {
        '/book': 1, '/wedding': 1, '/wedding-book': 1,
        '/portfolio': 1, '/gallery': 1, '/links': 1, '/review': 1
    };

    var LINK_SPLIT = /(\/(?:wedding-book|wedding|portfolio|gallery|book|links|review)(?![\w-]))/g;

    function atBottom() {
        return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
    }

    function toBottom() {
        logEl.scrollTop = logEl.scrollHeight;
    }

    /* THE ONE FACE IN THE CONVERSATION.

       Built once, on the first reply, and MOVED onto every reply after it —
       appendChild moves a node rather than cloning it, so "the newest reply
       wears the face" is expressed by putting the same element in a new parent
       and letting the old parent lose it. Copied instead, the log would fill up
       with faces and every one of them would have to be kept in step.

       It is a slot like any other the page might own (`data-lp-face`), so the
       studio's own choice of look reaches it through the same fillFaceSlots()
       call, rather than through a second drawing that could drift. */
    function avatar() {
        if (!avatarEl) {
            avatarEl = el('span', 'lpa-avatar');
            avatarEl.setAttribute('data-lp-face', '');
            avatarEl.appendChild(iconForLook(SAY.look));
        }
        return avatarEl;
    }

    /** The studio's words: plain text, no bubble — except that a destination it
        names is tappable. See the note on LINK_SPLIT. */
    function say(text) {
        var stick = atBottom();
        var row = el('div', 'lpa-row');
        var line = el('div', 'lpa-said');
        var box = el('div', 'lpa-bot');
        String(text == null ? '' : text).split(LINK_SPLIT).forEach(function (part) {
            if (!part) return;
            if (LINK_SET[part]) {
                var a = el('a', 'lpa-link', part);
                a.href = part;
                a.rel = 'noopener';
                box.appendChild(a);
            } else {
                box.appendChild(document.createTextNode(part));
            }
        });
        // The face first, so the words are indented beside it, and only after
        // the reply has been built — a reply that is somehow empty is not worth
        // a face of its own.
        line.appendChild(avatar());
        line.appendChild(box);
        row.appendChild(line);
        logEl.appendChild(row);
        if (stick) toBottom();
        return row;
    }

    /** The visitor's words, right-aligned in the one filled shape in the log. */
    function said(text) {
        var row = el('div', 'lpa-row');
        row.appendChild(el('div', 'lpa-me', text));
        logEl.appendChild(row);
        toBottom();
        return row;
    }

    /** A quiet aside. Everything the widget needs to explain is a note. */
    function note(text) {
        var stick = atBottom();
        var row = el('div', 'lpa-row');
        var n = el('div', 'lpa-note');
        n.appendChild(el('span', null, text));
        row.appendChild(n);
        logEl.appendChild(row);
        if (stick) toBottom();
        return row;
    }

    function card() {
        var row = el('div', 'lpa-row');
        var c = el('div', 'lpa-card');
        row.appendChild(c);
        logEl.appendChild(row);
        toBottom();
        return { row: row, box: c };
    }

    function typing(on) {
        /* THE FACE KNOWS WHEN IT IS WORKING, and it says so here rather than
           where the request is made, because this function is the one place that
           already knows whether a reply is still coming — including every path
           that ends in an error or a timeout. `speak()` opens the mouth on every
           face on the page at once; `is-busy` on the dock is only what keeps the
           mouth that MOVES the visible one while the sheet is open. */
        // The dock is optional now: a page that owns a door has no dock, and a
        // face that cannot be shown is not a reason to fail a reply.
        if (dock) dock.classList.toggle('is-busy', !!on);
        speak(on);
        if (on) {
            if (typingEl) return;
            var row = el('div', 'lpa-row');
            // The row is what gets added and removed; the dots inside it are what
            // grows the "still checking" line, so both are kept. Confusing the
            // two is how the caption would end up on the wrong element.
            var t = el('div', 'lpa-typing');
            /* THE WAITING ROW WEARS THE FACE, because this is the one moment the
               visitor is looking at the assistant and it has something true to
               say — asked for in as many words: "the interractive faces are
               nowhere to be found when typing". It is a `data-lp-face` slot like
               every other face on a page, so it is the same drawing, it is
               redrawn if the studio changes the look, and it speaks with the
               rest: the mouth here is open for exactly as long as the answer is
               coming. */
            var waiting = el('span', 'lpa-avatar');
            waiting.setAttribute('data-lp-face', '');
            waiting.appendChild(iconForLook(SAY.look));
            t.appendChild(waiting);
            t.appendChild(el('i'));
            t.appendChild(el('i'));
            t.appendChild(el('i'));
            row.appendChild(t);
            logEl.appendChild(row);
            toBottom();
            typingEl = row;
            typingDots = t;
            return;
        }
        if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
        typingEl = null;
        typingDots = null;
    }

    /** Close the widget for good — used when the assistant is not available. */
    function removeWidget() {
        if (dock && dock.parentNode) dock.parentNode.removeChild(dock);
        if (sheet && sheet.parentNode) sheet.parentNode.removeChild(sheet);
        if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim);
        /* And the doors, which live in the PAGE's markup rather than in this
           file's own. A form left standing here would be a field that swallows
           what a visitor types: the sheet it opens has just been taken off the
           page, so the submit would do nothing visible at all — which is the
           dead button every rule about doors exists to prevent. */
        var doors = document.querySelectorAll('[data-lp-door]');
        for (var i = 0; i < doors.length; i++) {
            while (doors[i].firstChild) doors[i].removeChild(doors[i].firstChild);
        }
        // Hand the page's own floating button back before leaving: the class
        // below is the only thing that hid it, and the page still works.
        document.documentElement.classList.remove('lpa-dock-alive');
        /* And the way in, because a page must not be able to open a chat box
           that has just removed itself from the page. A page holding the
           reference and calling it would get a sheet with no parent: no visible
           failure and nothing on screen, which is the worst of both. */
        try { delete window.lpAssistant; } catch (err) { window.lpAssistant = null; }
        window.__lpAssistantLoaded = false;
    }

    /* A PAGE MAY OPEN THE ASSISTANT ITSELF.

       The links page is a list of doors, and one of them should be the
       assistant: a card a visitor taps to ask a question, rather than a floating
       pill they have to notice at the bottom of a screen. That page needs a way
       in, and the alternative was copying the widget's opening code into the
       page — which is how two versions of one behaviour begin to disagree.

       Deliberately three read-only functions and nothing else. There is no way
       in here to reach the page, to send a message as the visitor, or to read
       the conversation; a door does not need any of that, and every one of those
       would be a promise about a stranger's privacy that this file makes
       nowhere else.

       Published from start(), so it exists only when the widget does, and
       removed in removeWidget() with it. */
    function publish() {
        window.lpAssistant = {
            open: function () { openSheet(); },
            close: function () { closeSheet(); },
            isOpen: function () { return open; }
        };
    }

    function ownTheFooter(on) {
        document.documentElement.classList[on ? 'add' : 'remove']('lpa-dock-alive');
    }

    /* wa.me only opens a chat for an INTERNATIONAL number. The studio's setting
       is stored in local form ("09075170240"), and a link built from that
       verbatim does not work — so a leading zero is swapped for the country
       code. 234 is not a guess: it is what every hand-written link on the site
       already uses, and what the page's own structured data declares. */
    var COUNTRY_CODE = '234';

    function whatsappLink(message) {
        if (!whatsapp) return null;
        var digits = String(whatsapp).replace(/[^0-9]/g, '');
        if (!digits) return null;
        if (digits.charAt(0) === '0') digits = COUNTRY_CODE + digits.slice(1);
        else if (digits.length === 10) digits = COUNTRY_CODE + digits;   // national form, no trunk zero
        if (digits.length < 12) return null;
        return 'https://wa.me/' + digits + '?text=' + encodeURIComponent(message || '');
    }

    /* ------------------------------------------------------------------ */
    /* Leaving a way to be answered.

       The handover used to end in a promise nobody could keep: the assistant
       said a person would come back to the visitor, the studio got a
       notification carrying no name and no number, and there was no route back
       to the person who asked. Now the visitor is offered somewhere to leave an
       email or a WhatsApp number — optional, two fields, and they can ignore it
       — and the notification stops being a dead end.
       ------------------------------------------------------------------ */

    /* localStorage, guarded: it throws in some private modes, and a visitor
       whose browser refuses it simply gets asked again rather than seeing a
       broken box. This is the ONLY thing this file keeps between visits. */
    var STORE_KEY = 'lp_assistant_contact';

    function loadSaved() {
        try {
            var raw = window.localStorage.getItem(STORE_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (!parsed || (parsed.kind !== 'email' && parsed.kind !== 'phone')) return null;
            if (typeof parsed.contact !== 'string' || !parsed.contact) return null;
            return { kind: parsed.kind, contact: parsed.contact };
        } catch (err) {
            return null;
        }
    }

    function saveContact(contact) {
        savedContact = contact;
        try { window.localStorage.setItem(STORE_KEY, JSON.stringify(contact)); } catch (err) {}
    }

    /** Attach details to the handover that just happened. */
    function attachContact(token, payload) {
        return fetch(API + '/api/assistant/contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ token: token }, payload))
        });
    }

    /* ------------------------------------------------------------------ */
    /* THE VISITOR'S WAY BACK TO THE STUDIO'S REPLY.

       WHY THIS IS HERE AT ALL. The handover used to be a one-way door: the
       visitor asked something the assistant could not answer, the question
       appeared in the studio's bell, the studio wrote a real reply — and the
       visitor was never told. They had closed the tab by then, and the next
       time they opened the assistant it knew nothing about the question it had
       passed on, so the studio's answer reached nobody and the work of writing
       it looked, from both ends, like nothing had happened.

       WHAT IS KEPT, AND WHY IT IS THIS AND NOTHING MORE. One capability: the
       token the worker gave this browser when it handed the question over. That
       token can do exactly one thing — read the studio's reply to that ONE
       question — and the worker will not use it to name a notification, reveal a
       contact, or confirm that a token is real. It expires at the worker's
       fourteen days regardless of what is stored here, and it is never sent
       anywhere except back to the studio's own API.

       It is NOT a conversation. Nothing the visitor typed is kept beside it, so
       a browser holding this token can re-read one reply and nothing else — and
       the reply is the one thing a person came back for. */
    var ASK_KEY = 'lp_assistant_asked';
    var sweptReply = false;

    function loadAsked() {
        try {
            var raw = window.localStorage.getItem(ASK_KEY);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            if (!parsed || typeof parsed.token !== 'string' || !/^[a-f0-9]{32}$/.test(parsed.token)) return null;
            return { token: parsed.token, question: typeof parsed.question === 'string' ? parsed.question : '' };
        } catch (err) {
            return null;
        }
    }

    function saveAsked(token, question) {
        if (!token) return;
        try {
            window.localStorage.setItem(ASK_KEY, JSON.stringify({
                token: String(token),
                // The visitor's own words, so the studio's reply can be shown
                // under the question it answers rather than as a paragraph out
                // of nowhere. Truncated: this is a label, not a transcript.
                question: String(question || '').slice(0, 140)
            }));
        } catch (err) { /* a browser that refuses storage simply asks again */ }
    }

    /* NOTHING HERE EVER CLEARS THE TOKEN, and that is deliberate rather than
       unfinished. There is no way for this file to tell "they have not replied
       yet" from "that is more than fourteen days old", because the worker answers
       both the same way ON PURPOSE — an endpoint that says which tokens are real
       is an endpoint that answers a stranger's guesses. So the only thing that
       can make this token worthless is the worker's own clock, and it is already
       the thing that decides. Deleting it locally on a guess would throw away the
       studio's reply because a phone was in a lift. */

    /**
     * The studio answered? Show it — once per visit, at the top of the log.
     *
     * Three outcomes and they must not be confused, which is this project's
     * most expensive recurring fault: the studio HAS answered (draw it, wearing
     * the face, with the question above it); the studio has not answered YET
     * (say nothing at all — an "awaiting reply" line on every visit turns a
     * slow answer into nagging); and the token is no longer good for anything
     * (fourteen days old, or the row is gone) — the honest end of the promise,
     * and the one case that clears the token, because a dead capability kept in
     * a browser is a thing that will be asked about forever.
     *
     * Nothing here can break the assistant: every path is swallowed, because a
     * visitor opening the box must get the box. */
    async function sweepStudioReply() {
        if (sweptReply) return;
        sweptReply = true;
        var asked = loadAsked();
        if (!asked) return;
        var data = null;
        try {
            var res = await fetch(API + '/api/assistant/answer?token=' + encodeURIComponent(asked.token));
            data = await res.json();
        } catch (err) {
            // A network that cannot answer is NOT the end of the token: leave it
            // and try again next visit. Clearing here would throw away the
            // studio's reply because a phone was in a lift.
            sweptReply = false;
            return;
        }
        if (!data || data.status !== 'ok') return;
        if (!data.answered) return;   // not yet, or long past — see the note above

        var answer = String(data.answer || '').trim();
        if (!answer) return;

        if (asked.question) {
            // The visitor's own words, in the shape their words always take, so
            // the reply visibly belongs to the question under it.
            var q = el('div', 'lpa-row');
            q.appendChild(el('div', 'lpa-me', asked.question));
            logEl.appendChild(q);
        }
        note('Liberty read your question and wrote back' +
            (asked.question ? ' about the above' : '') +
            '. This is their own reply, not the assistant\u2019s:');
        say(answer);
        toBottom();
    }

    /** A button in the log that goes somewhere — used for WhatsApp, and only
        ever WhatsApp. */
    function actionButton(label, href, ghost) {
        var a = el('a', 'lpa-btn' + (ghost ? ' is-ghost' : ''));
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        a.appendChild(el('span', null, label));
        return a;
    }

    /** A WhatsApp button carrying the visitor's own words, so nothing is lost. */
    function whatsappButton(label, question) {
        var href = whatsappLink(question
            ? 'Hi — I asked on your website: ' + question
            : 'Hi — I was on your website and had a question.');
        if (!href) return;
        // No card around it: the one action in this reply is the action, and a
        // box drawn round a button is a box drawn round nothing.
        var row = el('div', 'lpa-row');
        row.appendChild(actionButton(label, href));
        logEl.appendChild(row);
        toBottom();
    }

    function offerCallback(token, question) {
        whatsappButton('Continue on WhatsApp', question);
        if (!token) return;
        // Kept BEFORE anything is asked of the visitor, because the reply is
        // theirs whether or not they choose to leave an email address. See the
        // note above ASK_KEY.
        saveAsked(token, question);

        // If this browser has already told the studio who it is, there is
        // nothing to ask: attach it to the new handover so the notification in
        // the bell is answerable, and say so.
        if (savedContact) {
            attachContact(token, { kind: savedContact.kind, contact: savedContact.contact })
                .then(function () {
                    note('Liberty already has your details from before, so they can reply to you directly.');
                })
                .catch(function () {});
            return;
        }

        var c = card();
        c.box.appendChild(el('p', null, 'Prefer to wait? Leave an email or a WhatsApp number and Liberty will reply to you directly.'));

        var form = el('form', 'lpa-form');
        var nameInput = el('input', 'lpa-field');
        nameInput.type = 'text';
        nameInput.name = 'name';
        nameInput.placeholder = 'Your name (optional)';
        nameInput.autocomplete = 'name';
        nameInput.setAttribute('aria-label', 'Your name');
        form.appendChild(nameInput);

        var contactInput = el('input', 'lpa-field');
        contactInput.type = 'text';
        contactInput.name = 'contact';
        contactInput.placeholder = 'Email or WhatsApp number';
        // No `autocomplete=email`: the field takes either, and a phone keyboard
        // for somebody typing an address is worse than a neutral one.
        contactInput.setAttribute('aria-label', 'Your email address or WhatsApp number');
        form.appendChild(contactInput);

        var submit = el('button', 'lpa-btn is-ghost is-wide', 'Send to Liberty');
        submit.type = 'submit';
        form.appendChild(submit);

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            var value = contactInput.value.trim();
            if (!value) {
                contactInput.focus();
                return;
            }
            // One field, two kinds: an address contains @, everything else is
            // treated as a number. The worker validates and normalises it, so a
            // typo comes back as a plain "check that" rather than a bad row.
            var payload = value.indexOf('@') !== -1 ? { email: value } : { phone: value };
            if (nameInput.value.trim()) payload.name = nameInput.value.trim();

            submit.disabled = true;
            attachContact(token, payload)
                .then(function (res) {
                    return res.json().then(function (d) { return { ok: res.ok, data: d }; });
                })
                .then(function (out) {
                    if (out.ok && out.data && out.data.stored) {
                        saveContact({ kind: out.data.kind, contact: value });
                        if (c.row.parentNode) c.row.parentNode.removeChild(c.row);
                        note('Thank you — Liberty has that, and they will come back to you.');
                        return;
                    }
                    submit.disabled = false;
                    note((out.data && out.data.message) || 'That did not go through — please try again, or use WhatsApp.');
                })
                .catch(function () {
                    submit.disabled = false;
                    note('I could not send that just now — please try again, or use WhatsApp.');
                });
        });

        c.box.appendChild(form);
        // Only on a real pointer screen: on a phone this would throw the
        // keyboard over the sentence the visitor has not read yet.
        if (desktop()) setTimeout(function () { contactInput.focus(); }, 60);
    }

    /** Every dead end ends the same way: WhatsApp, never a phone number. */
    function fallback(text) {
        note(text);
        var href = whatsappLink('Hi — I was on your website and had a question.');
        if (!href) return;
        var c = card();
        c.box.appendChild(actionButton('Message the studio on WhatsApp', href));
    }

    function desktop() {
        return !!(window.matchMedia && window.matchMedia('(min-width: 641px)').matches);
    }

    function setBusy(v) {
        busy = v;
        if (inputEl) inputEl.disabled = v;
        if (sendBtn) sendBtn.disabled = v;
        typing(v);
    }

    async function send(text) {
        if (busy) return;
        var question = String(text || (inputEl ? inputEl.value : '') || '').trim();
        if (!question) return;

        settleInvites();
        said(question);
        if (inputEl) { inputEl.value = ''; grow(); }
        setBusy(true);

        /* A wait with no end is worse than bad news.

           The worker can spend up to four model rounds on one question, and if
           the model or the network stalls there was nothing on this side to
           stop the visitor watching three dots for as long as they were willing
           to — which is exactly what they photographed and described as "it just
           kept loading". Two bounds now exist: past the point where silence
           stops reading as thinking, the dots say what they are doing; and past
           the point where no answer is worth waiting for, the request is
           abandoned and the visitor is given somewhere to go instead. */
        var slowTimer = window.setTimeout(function () {
            if (typingDots) typingDots.classList.add('is-slow');
        }, SLOW_AFTER);
        var control = typeof AbortController === 'function' ? new AbortController() : null;
        var giveUpTimer = window.setTimeout(function () {
            if (control) control.abort();
        }, GIVE_UP_AFTER);

        try {
            var res = await fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: control ? control.signal : undefined,
                // The saved contact is how a returning client is recognised. It
                // is only ever looked up, never trusted as an identity, and an
                // unrecognised one simply means a normal first-time answer.
                // `page` is the last segment of the path, and it is the ONE
                // thing the widget knows that the worker cannot: which page the
                // visitor is standing on. The worker checks it against a fixed
                // list before it reaches the prompt, so a page added tomorrow
                // sends nothing and changes nothing.
                body: JSON.stringify({
                    message: question,
                    history: history.slice(-MAX_HISTORY),
                    contact: savedContact,
                    page: pageKey()
                })
            });

            if (res.status === 503) {   // not switched on, or a deploy without the model
                removeWidget();
                return;
            }
            if (res.status === 429) {
                var limited = 'That is a lot of questions at once —';
                try { var d = await res.json(); if (d && d.message) limited = d.message; } catch (e) {}
                fallback(limited);
                return;
            }
            if (!res.ok) {
                fallback('Sorry — I could not answer that just now.');
                return;
            }

            var data = await res.json();
            if (data && data.reply) {
                say(data.reply);
                history.push({ role: 'user', content: question });
                history.push({ role: 'assistant', content: data.reply });
                history = history.slice(-MAX_HISTORY);
            } else {
                note('Let me pass that to the studio — they will come back to you personally.');
            }
            if (data && data.handedOver) {
                note('That one is beyond me, so the studio has been told about it and will answer you personally.');
                offerCallback(data.handoverToken, question);
            }
        } catch (err) {
            // A network failure is not a reason to leave a broken box on screen
            // for the rest of the visit — and neither is a request that never
            // came back, which used to leave the dots turning forever.
            if (err && err.name === 'AbortError') {
                fallback('That is taking longer than it should. Message the studio on WhatsApp and Liberty will answer you directly.');
            } else {
                fallback('I could not reach the studio just now.');
            }
        } finally {
            window.clearTimeout(slowTimer);
            window.clearTimeout(giveUpTimer);
            setBusy(false);
            if (inputEl && !inputEl.disabled && desktop()) inputEl.focus();
        }
    }

    function grow() {
        if (!inputEl) return;
        inputEl.style.height = 'auto';
        inputEl.style.height = Math.min(inputEl.scrollHeight, 132) + 'px';
    }

    /* ------------------------------------------------------------------ */
    /* The dock: the page's own booking pill and the assistant, in one piece.
       Which action the left half carries is read OUT of the page rather than
       hardcoded, so the widget can never send a visitor somewhere the page
       was not already sending them — and if the page has no pill at all, the
       studio's own Settings label is used, then a plain default.
       ------------------------------------------------------------------ */

    var book = { href: '/book', label: '', adopted: false };

    function adoptSiteCta() {
        var own = document.querySelector('.lp-float-book');
        if (!own) return;
        var href = own.getAttribute('href');
        if (href) book.href = href;
        var label = own.querySelector('.lp-float-book-label');
        if (label && label.textContent.trim()) book.label = label.textContent.trim();
        book.adopted = true;
    }

    /* Which page of the site this widget is standing on: the last segment of the
       path, without an extension. The site serves extensionless URLs, but a page
       also opens as `/book.html` from a saved link or a preview, and both forms
       have to resolve to the same page — a visitor is not on a different page
       because of the way they arrived. `/pay/` therefore resolves to `pay`, not
       to an empty key, and the home page resolves to an empty key on purpose. */
    function pageKey() {
        var path = (location.pathname || '').replace(/\/+$/, '');
        var last = path.split('/').pop() || '';
        return last.replace(/\.html$/i, '').toLowerCase();
    }

    /* The booking pages ARE the booking, so a "book" half there is noise: the
       dock is a single pill, and the split has nothing to split from. */
    function onBookingPage() {
        var here = pageKey();
        return here === 'book' || here === 'wedding-book';
    }

    function buildDock() {
        dock = el('div', 'lpa-dock');
        if (onBookingPage()) dock.classList.add('is-single');

        lobeBook = el('a', 'lpa-lobe lpa-lobe-book');
        lobeBook.href = book.href;
        lobeBook.appendChild(icon('M3 4h18v18H3zM16 2v4M8 2v4M3 10h18', '1.8'));
        lobeBook.appendChild(el('span', null, book.label || 'Book a session'));
        dock.appendChild(lobeBook);

        neck = el('span', 'lpa-neck');
        dock.appendChild(neck);

        lobeAsk = el('button', 'lpa-lobe lpa-lobe-ask');
        lobeAsk.type = 'button';
        lobeAsk.setAttribute('aria-expanded', 'false');
        // The look the studio chose — the smiley unless they asked for the
        // strokes or the plain bubble. Without an icon the lobe is a word and
        // nothing else, which is a smaller thing than this widget is trying to
        // be.
        lobeAsk.appendChild(iconForLook(SAY.look));
        wordEl = el('span', 'lpa-word', SAY.ask);
        lobeAsk.appendChild(wordEl);
        // This used to call a bare `close` rather than closeSheet — and a bare
        // `close` is not a function in this file, so it resolved to the one on
        // window: tapping the lobe while the chat was open did nothing at all.
        // The × in the sheet was therefore the only way out, which is precisely
        // why losing it on a phone was such a trap.
        lobeAsk.addEventListener('click', function () { open ? closeSheet() : openSheet(); });
        dock.appendChild(lobeAsk);

        document.body.appendChild(dock);
        pinInviteWidth();
        ownTheFooter(true);
    }

    /* ------------------------------------------------------------------ */
    /* The words the dock says instead of one fixed label.

       A few invitations, cycling at a walking pace. Three rules keep it from
       becoming the thing everybody turns off:

       1. the capsule's width is pinned to its LONGEST line first, so the dock
          never twitches as the words change — an animating width is what makes
          a rotating label feel cheap;
       2. it stops for good the moment the visitor opens the chat or asks
          something, because after that they are in a conversation, not being
          sold to;
       3. nothing cycles at all under prefers-reduced-motion.
       ------------------------------------------------------------------ */

    var invites = [];
    var inviteIndex = 0;
    var inviteTimer = null;
    var swapTimer = null;   // a half-finished swap, so it can be called off

    function reducedMotion() {
        return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    /** Widen the ask lobe to its longest invitation before anything animates. */
    function pinInviteWidth() {
        if (!lobeAsk || !wordEl || invites.length < 2) return;
        var was = wordEl.textContent;
        var widest = 0;
        invites.concat([SAY.ask]).forEach(function (line) {
            wordEl.textContent = line;
            widest = Math.max(widest, Math.ceil(lobeAsk.getBoundingClientRect().width));
        });
        wordEl.textContent = was;
        if (widest) lobeAsk.style.minWidth = widest + 'px';
    }

    function stepInvite() {
        // No dock means no label to rotate — a page with its own door renders
        // the same settings, and every one of them has to survive being applied
        // to a widget without one.
        if (!wordEl) return;
        // Never mid-conversation, never while the sheet is open, and never
        // while the dock is off screen where nobody can see it change.
        if (open || busy || !invites.length || document.hidden) return;
        wordEl.classList.add('is-swap');
        swapTimer = window.setTimeout(function () {
            swapTimer = null;
            if (open) { wordEl.classList.remove('is-swap'); return; }
            inviteIndex = (inviteIndex + 1) % invites.length;
            wordEl.textContent = invites[inviteIndex];
            wordEl.classList.remove('is-swap');
        }, 340);
    }

    function startInvites() {
        if (!wordEl) return;
        if (inviteTimer || reducedMotion() || invites.length < 2) return;
        /* Two seconds, not five. The invitations are three or four words each
           and the old gap left the button sitting on one line long enough to
           read as a label rather than as an offer. */
        inviteTimer = window.setInterval(stepInvite, 2000);
    }

    /** Back to the plain label, and quiet. Called the first time the visitor
        actually engages, because from then on it is a conversation.

        The pending swap matters: clearing the interval alone still let a swap
        that was already half-done land 340ms later, so the label would settle on
        whichever invitation happened to be mid-flight rather than on the plain
        one. A half-finished animation is still an animation. */
    function settleInvites() {
        if (inviteTimer) { window.clearInterval(inviteTimer); inviteTimer = null; }
        if (swapTimer) { window.clearTimeout(swapTimer); swapTimer = null; }
        if (wordEl) {
            wordEl.classList.remove('is-swap');
            wordEl.textContent = SAY.ask;
        }
    }

    /** The bridge, and the lean toward each other, while the halves split or
        merge. Timed to the dock's own gap transition, not a fixed guess. */
    function liquify() {
        if (!neck || !dock) return;
        neck.classList.remove('is-live');
        dock.classList.remove('is-stretching');
        // Reading offsetWidth restarts the animation instead of coalescing it.
        void neck.offsetWidth;
        neck.classList.add('is-live');
        dock.classList.add('is-stretching');
        window.setTimeout(function () {
            neck.classList.remove('is-live');
            dock.classList.remove('is-stretching');
        }, 620);
    }

    /* ------------------------------------------------------------------ */
    /* The sheet.
       ------------------------------------------------------------------ */

    function buildSheet() {
        sheet = el('div', 'lpa-sheet');
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        /* The box's NAME, which is the studio's heading if they wrote one — set
           again in applyAssistantSettings() when the settings land, because the
           sheet is built before anything has been fetched. It is announced and
           not drawn; see the note on `.lpa-head`. */
        sheet.setAttribute('aria-label', SAY.title);
        sheet.hidden = true;

        /* A row with the way out on it and nothing else. The title and the grab
           handle that used to live here are explained, and gone, in the
           stylesheet beside `.lpa-head` — but the head element itself stays,
           because it is also the sheet's drag surface and the drag is still
           there: it was only the decoration that was removed. */
        var head = el('div', 'lpa-head lpa-in');

        var close = el('button', 'lpa-close');
        close.type = 'button';
        close.setAttribute('aria-label', 'Close');
        close.appendChild(icon('M5 5l14 14M19 5L5 19', '1.9'));
        close.addEventListener('click', function () { closeSheet(); });
        head.appendChild(close);
        sheet.appendChild(head);

        logEl = el('div', 'lpa-log lpa-in');
        logEl.setAttribute('aria-live', 'polite');
        sheet.appendChild(logEl);

        var compose = el('div', 'lpa-compose lpa-in');
        var ring = el('div', 'lpa-ring');
        inputEl = el('textarea', 'lpa-input');
        inputEl.rows = 1;
        inputEl.placeholder = SAY.placeholder;
        inputEl.setAttribute('aria-label', 'Your question');
        inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
        });
        inputEl.addEventListener('input', grow);
        ring.appendChild(inputEl);

        sendBtn = el('button', 'lpa-send');
        sendBtn.type = 'button';
        sendBtn.setAttribute('aria-label', 'Send');
        sendBtn.appendChild(icon('M12 19V5M5 12l7-7 7 7', '2.1'));
        sendBtn.addEventListener('click', function () { send(); });
        ring.appendChild(sendBtn);
        compose.appendChild(ring);
        sheet.appendChild(compose);

        scrim = el('div', 'lpa-scrim');
        scrim.addEventListener('click', function () { closeSheet(); });

        document.body.appendChild(scrim);
        document.body.appendChild(sheet);

        wireDragToDismiss(head);
    }

    /* Drag the sheet down to dismiss, the way a phone user already expects a
       sheet to behave. Only for touch and pen: a mouse drag on a header should
       still select text. */
    function wireDragToDismiss(head) {
        var startY = null;
        var moved = 0;

        head.addEventListener('pointerdown', function (e) {
            if (e.pointerType === 'mouse') return;
            startY = e.clientY;
            moved = 0;
            sheet.style.transition = 'none';
        });

        head.addEventListener('pointermove', function (e) {
            if (startY === null) return;
            moved = e.clientY - startY;
            if (moved <= 0) return;
            sheet.style.transform = 'translateX(-50%) translateY(' + moved + 'px) scale(' + (1 - Math.min(moved / 900, 0.06)) + ')';
        });

        function end() {
            if (startY === null) return;
            startY = null;
            sheet.style.transition = '';
            sheet.style.transform = '';
            if (moved > 90) closeSheet();
        }

        head.addEventListener('pointerup', end);
        head.addEventListener('pointercancel', end);
    }

    /* The iPhone keyboard covers the bottom of the viewport, and `position:
       fixed` follows the layout viewport rather than the visible one — so the
       composer ends up underneath the keys. visualViewport is the browser
       telling us what is actually on screen; the dock and the sheet are lifted
       by exactly that much, and dropped back when the keyboard closes. */
    function wireKeyboard() {
        var vv = window.visualViewport;
        if (!vv) return;
        function update() {
            var hidden = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
            var keys = hidden > 60;
            document.documentElement.style.setProperty('--lpa-lift', keys ? Math.round(hidden) + 'px' : '0px');
            document.documentElement.classList[keys ? 'add' : 'remove']('lpa-keys');
        }
        vv.addEventListener('resize', update);
        vv.addEventListener('scroll', update);
        update();
    }

    function openSheet(from) {
        if (open) return;
        open = true;
        /* WHAT OPENED THIS, so closeSheet() can put focus back where it was.
           Passed in rather than read from document.activeElement, because
           Safari does not reliably focus a button on click — reading it would
           have silently aimed the focus at the document body instead. */
        if (from && typeof from.focus === 'function') sheetOpener = from;

        if (sheet.hidden) {
            sheet.hidden = false;
            // A long conversation reopened: the newest words are what matter.
            toBottom();
        }
        // Two frames: one for the element to be laid out at its start state,
        // one to move it. Without the second, the browser coalesces both and the
        // sheet simply appears.
        requestAnimationFrame(function () {
            requestAnimationFrame(function () {
                sheet.classList.add('is-on');
                scrim.classList.add('is-on');
            });
        });

        /* The surface has to change BEFORE the halves move. The glass belongs to
           the dock while it is one capsule and to each half once they are apart,
           so switching it after the move would leave the capsule briefly hollow
           with a hole where the join used to be. */
        if (dock) dock.classList.add('is-open');
        liquify();
        if (lobeAsk) lobeAsk.setAttribute('aria-expanded', 'true');
        settleInvites();

        if (!greetingShown) {
            greetingShown = true;
            say(SAY.greeting);
        }

        /* Did the studio reply to something this visitor handed over? Asked on
           OPEN rather than at load, so nothing is fetched for the many visitors
           who never open the box — and asked here rather than anywhere else
           because this is the first moment there is a log to draw into. Guarded
           like every other promise in this file: a reply we cannot fetch is not
           a reason for the box to fail to open. */
        var swept = sweepStudioReply();
        if (swept && swept.catch) swept.catch(function () {});

        // Never on a phone: focusing throws the keyboard over the greeting
        // before it has been read.
        if (desktop()) setTimeout(function () { if (inputEl) inputEl.focus(); }, 260);
    }

    function closeSheet() {
        if (!open) return;
        open = false;

        sheet.classList.remove('is-on');
        scrim.classList.remove('is-on');
        liquify();
        if (dock) dock.classList.remove('is-open');
        if (lobeAsk) lobeAsk.setAttribute('aria-expanded', 'false');
        if (inputEl) inputEl.blur();
        /* WHERE THE FOCUS GOES BACK.

           The dock's lobe when the dock opened it, and the page's own door when
           that opened it. On the links page there is no lobe at all — the dock
           stands down where a page owns a door — so the old `if (lobeAsk)` alone
           left the visitor's focus nowhere after they closed the chat. */
        if (sheetOpener && document.contains(sheetOpener)) sheetOpener.focus();
        else if (lobeAsk) lobeAsk.focus();
        sheetOpener = null;

        window.setTimeout(function () {
            if (!open && sheet) sheet.hidden = true;
        }, 620);
    }

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && open) closeSheet();
    });

    /* ------------------------------------------------------------------ */
    /* When the dock is worth showing.

       At the very top of the page the hero is the whole point, and the home
       page's own pill behaves the same way. Past it, the dock is there for the
       rest of the visit — including while the sheet is open, because it is the
       sheet's anchor.
       ------------------------------------------------------------------ */

    /* AND WHEN IT MUST SHOW ITSELF ANYWAY.

       That rule has a hole in it, and the links page was standing in the hole:
       the dock is revealed once the visitor has scrolled past 55% of the
       viewport, and a page too short to scroll that far NEVER reveals it. The
       link-in-bio page is five cards — on a phone it does not scroll at all — so
       the assistant was loaded, built, correct, and permanently invisible on the
       one page that is nothing but a list of doors. Nobody would have reported
       it as a bug either; it would have read as "the assistant is not on that
       page".

       So the reveal is skipped where it cannot happen: if the page cannot be
       scrolled past the threshold there is no hero to protect, and the dock is
       simply shown. `load` is listened for as well as resize, because
       scrollHeight grows when the page's images arrive — on a long page that can
       briefly look short, and the correction should not have to wait for the
       next scroll. */
    function revealThreshold() { return window.innerHeight * 0.55; }

    function wireReveal() {
        function update() {
            var maxScroll = Math.max(0, (document.documentElement.scrollHeight || 0) - window.innerHeight);
            var reachable = maxScroll > revealThreshold();
            var past = !reachable || window.scrollY > revealThreshold();
            if (past === revealed) return;
            revealed = past;
            if (open) return;
            dock.classList.toggle('is-in', past);
        }
        window.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        window.addEventListener('load', update);
        update();
    }

    /* The WhatsApp fallback needs the studio's real number, and the same
       endpoint the page already uses for it. If this fails, the fallback simply
       has no link — which is a worse fallback, not a broken widget. */

    /** A settings value as usable text, or ''. "Unset" has to be distinguishable
        from "deliberately empty", and every field below is optional. */
    function str(value) {
        return value == null ? '' : String(value).trim();
    }

    /** One per line, at most six. Past six it stops being help and becomes a
        menu, and on a phone the row is scrollable but nobody scrolls it. */
    function lines(value) {
        return str(value).split('\n').map(function (x) { return x.trim(); })
            .filter(Boolean).slice(0, 6);
    }

    /** Swap the lobe's glyph, if the studio turned the face on or off. Kept
        first-child so the label stays after it. */
    /* Which look the studio asked for, or null when they have not said.

       `assistant_mascot` is the named setting. `assistant_face` is what came
       before it, and it is still honoured rather than migrated: "off" meant the
       bubble and anything else meant the smiley, so an old value maps onto a
       new name one-for-one and nothing already saved changes what a visitor
       sees. Null means "leave the button as the file shipped it". */
    function resolveLook(s) {
        var named = str(s.assistant_mascot).toLowerCase();
        if (named === 'smile' || named === 'strokes' || named === 'bubble') return named;
        var legacy = str(s.assistant_face).toLowerCase();
        if (!legacy) return null;
        var on = legacy !== 'off' && legacy !== 'false' && legacy !== 'no' && legacy !== '0';
        return on ? 'smile' : 'bubble';
    }

    /* The three looks, and the button drawn for each. Anything the assistant
       cannot recognise in the setting falls back to the smiley, because a
       half-read setting must never leave the button with no icon at all. */
    function iconForLook(look) {
        if (look === 'bubble') return icon(BUBBLE_PATH);
        if (look === 'strokes') return strokesIcon();
        return faceIcon();
    }

    function swapFaceIcon() {
        if (!lobeAsk) return;
        var old = lobeAsk.querySelector('svg');
        var next = iconForLook(SAY.look);
        if (old) lobeAsk.replaceChild(next, old);
        else lobeAsk.insertBefore(next, lobeAsk.firstChild);
    }

    /* Every word this widget says that the studio might want to change, applied
       only when they have actually said something.

       The guards are the point. A naive `SAY.title = s.assistant_title` reads an
       unset field as an empty string, and an empty string here is a sheet with
       no title and a dock with no words on it — a worse widget than the one
       nobody configured. So: empty means "use what this file already says". */
    function applyAssistantSettings(s) {
        /* The heading, or the studio's own name for their assistant when they
           have not written a heading. Naming it in Settings is then enough on
           its own — there is no second field to remember to fill in, and no way
           for the two to disagree.

           A written heading still wins, because it is the more specific
           instruction: somebody who typed both meant the heading. */
        var title = str(s.assistant_title) || str(s.assistant_name);
        if (title) {
            SAY.title = title;
            /* Applied to the dialog's NAME rather than to a heading, because
               the chat box no longer draws one. The setting still does
               something real — it is what the box is called out loud — and the
               dashboard's hint for the field says so. See the note on
               `.lpa-head` in the stylesheet. */
            if (sheet) sheet.setAttribute('aria-label', title);
        }

        // Only matters if the sheet has not been opened yet — after the first
        // hello the greeting is history, and rewriting history is not a thing.
        var greeting = str(s.assistant_greeting);
        if (greeting) SAY.greeting = greeting;

        var askLabel = str(s.assistant_ask_label);
        if (askLabel) {
            SAY.ask = askLabel;
            /* Any door already on the page says what the studio calls asking.
               Read out of the document rather than held in a register, so this
               cannot become a second thing to remember whenever a door exists. */
            var doorTitles = document.querySelectorAll('.lpa-door-title');
            for (var dt = 0; dt < doorTitles.length; dt++) doorTitles[dt].textContent = askLabel;
        }

        var placeholder = str(s.assistant_placeholder);
        if (placeholder) {
            SAY.placeholder = placeholder;
            if (inputEl) inputEl.placeholder = placeholder;
        }

        var invites = lines(s.assistant_invites);
        if (invites.length) {
            SAY.invites = invites;
            // A first invitation the visitor can read while the dock is still
            // arriving, rather than a label that changes a beat later.
            if (wordEl && !open) wordEl.textContent = invites[0];
            if (lobeAsk) lobeAsk.style.minWidth = '';   // remeasure against the new longest
            pinInviteWidth();
            startInvites();
        }

        /* The look, named. The old on/off setting still works — "off" was the
           bubble and anything else was the smiley, which is exactly what those
           two names mean now, so nothing already saved changes meaning. */
        var look = resolveLook(s);
        if (look && look !== SAY.look) { SAY.look = look; swapFaceIcon(); }

        /* How the mouth moves while it answers, and how quickly — the rest is the
           line in every one of them. Both are validated against the set of names
           that exist rather than trusted: a setting is text in a database, and a
           value nobody recognises has to mean "leave it alone" rather than
           "stop moving". */
        var mouthStyle = str(s.assistant_mouth).toLowerCase();
        if (MOUTH_ALIAS[mouthStyle]) mouthStyle = MOUTH_ALIAS[mouthStyle];
        if (MOUTH_STYLES[mouthStyle]) MOUTH_STYLE = mouthStyle;
        var mouthPace = str(s.assistant_mouth_pace).toLowerCase();
        if (MOUTH_MS[mouthPace]) MOUTH_PACE = mouthPace;
        startMouth();
    }

    function loadSettings() {
        fetch(API + '/api/settings')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                var s = (d && d.settings) || {};
                if (s.whatsapp_number) whatsapp = s.whatsapp_number;
                // Where the page had no pill of its own, the studio's own
                // Settings label is the honest default — it is the same word the
                // closing call-to-action already uses.
                if (!book.label && s.cta_studio_btn) {
                    book.label = String(s.cta_studio_btn);
                    var span = lobeBook && lobeBook.querySelector('span');
                    if (span) span.textContent = book.label;
                }
                applyAssistantSettings(s);
                // The look is the studio's to choose, so the page's own face slots
                // are redrawn once that choice is known — see fillFaceSlots.
                fillFaceSlots(true);
            })
            .catch(function () {});
    }

    /* PAGE-OWNED SLOTS FOR THE FACE.

       A page can own a piece of the assistant's identity — the links page's ask
       card is one — without copying the drawing, which is how two copies of a
       face begin to drift out of step. Anything carrying `data-lp-face` is
       filled from the same faceSVG() the dock uses.

       Filled twice on purpose: once immediately, so the page is never briefly
       missing its mark, and again when the studio's settings land, because the
       look it was drawn in is the studio's to choose and the first pass can only
       use the default. `replace` is what makes the second pass a repair rather
       than a second face. */
    function fillFaceSlots(replace) {
        var slots = document.querySelectorAll('[data-lp-face]');
        for (var i = 0; i < slots.length; i++) {
            var next = iconForLook(SAY.look);
            if (slots[i].firstChild) {
                if (replace) slots[i].replaceChild(next, slots[i].firstChild);
            } else {
                slots[i].appendChild(next);
            }
        }
    }

    /* PAGE-OWNED DOORS.

       A page may put the assistant itself on the page — the links page does,
       because a list of four destinations and no way to ask a question is a page
       that makes you guess. The page owns an EMPTY element carrying
       `data-lp-door`; this fills it.

       Which way round that runs matters, and it is the whole reason this is a
       slot rather than a second published function. The page cannot send as the
       visitor and cannot open a box of its own: it holds a place, the widget
       builds what stands in it, and the conversation it opens is the same one
       the chat box uses — same history, same rate limit. There is one way to
       ask, and this is another door onto it, not another room. */
    function askDoor() {
        /* A DOOR, NOT A FIELD.

           The first version of this put a real text field on the page and sent
           whatever was typed there into the sheet. The owner's read of it was
           exact: "the first assistant chat box is useless and its awkward to
           click th box, type in a question, then the assistant answer comes with
           another chat box". Two boxes for one conversation — and the one they
           had already typed into could not show a reply, keep the history or
           hold the greeting, so it existed only to be abandoned halfway.

           Now the card IS the door: one tap opens the assistant itself, and the
           only place to type is the composer, in the box the answer arrives in.
           A button rather than a div, so it is focusable, announced as an
           action, and reachable with Enter and Space for free. */
        var card = el('button', 'lpa-door');
        card.type = 'button';

        var face = el('span', 'lpa-door-face');
        face.setAttribute('data-lp-face', '');
        face.appendChild(iconForLook(SAY.look));
        card.appendChild(face);

        var copy = el('div', 'lpa-door-copy');
        // The studio's own label for asking, so a rename in Settings renames the
        // door too: applyAssistantSettings() updates the cards already built.
        copy.appendChild(el('div', 'lpa-door-title', SAY.ask));
        copy.appendChild(el('div', 'lpa-door-sub',
            'Rates, dates and what is included \u2014 answered right here.'));
        card.appendChild(copy);

        // Decorative, and hidden from the name a screen reader reads out: the
        // card's name is its title and its line, not "... right here. ›".
        var arrow = el('span', 'lpa-door-arrow', '\u203a');
        arrow.setAttribute('aria-hidden', 'true');
        card.appendChild(arrow);

        card.addEventListener('click', function () {
            /* The same sheet, the same conversation. The card is handed over so
               the sheet can give focus back here when it closes: a page that
               owns a door has no dock lobe to return to, and a door must not
               drop the keyboard user at the top of the document.
               removeWidget() takes this card away with the rest of the widget,
               which is why there is no liveness check on the handler. */
            openSheet(card);
        });
        return card;
    }

    /** Fill every door slot, and say how many were filled. Never twice: a page
        that carries two slots gets two doors, and one that is somehow visited
        twice keeps the one field it was given. */
    function fillDoorSlots() {
        var slots = document.querySelectorAll('[data-lp-door]');
        var filled = 0;
        for (var i = 0; i < slots.length; i++) {
            if (slots[i].firstChild) continue;
            slots[i].appendChild(askDoor());
            filled += 1;
        }
        return filled;
    }

    function start() {
        injectStyles();
        adoptSiteCta();
        invites = SAY.invites.slice();
        /* THE DOCK STANDS DOWN WHERE THE PAGE OWNS A DOOR.

           The links page is short and is nothing but doors, so a floating
           capsule over it is a second way in for a page that already has one —
           and the owner's note on it was blunt: "the links page is currently
           cluttered". A page that owns a door gets no dock.

           Decided from whether a door was actually BUILT rather than from
           whether the page asked for one. A slot this file failed to fill — a
           page with the attribute and a script that threw — would otherwise
           leave the visitor with no way into the assistant at all, which is the
           worst of both. So it fails OPEN: no door, and the dock is there. */
        var doorOwned = fillDoorSlots() > 0;
        if (!doorOwned) buildDock();
        buildSheet();
        // The one way in a page owns, published only once there is a sheet to
        // open — see publish().
        publish();
        fillFaceSlots(false);
        if (!doorOwned) {
            wireReveal();
            // The words are on screen before the settings have answered; whatever
            // the studio has written lands on top of these a moment later. The
            // widget never waits on a request to become usable.
            startInvites();
        }
        wireKeyboard();
        /* The mouth starts here rather than when the settings land, so the face
           is alive in the first frame it is on screen; the settings only ever
           change WHICH movement it is. */
        startMouth();
        loadSettings();
        savedContact = loadSaved();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
