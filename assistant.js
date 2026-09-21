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
      The links page is a list of doors, so one of them is the assistant itself —
      a card a visitor taps — and that page gets in through `window.lpAssistant`
      rather than by copying this file's opening code. Its card carries
      `data-lp-face` and is filled from the same drawing the dock uses, on the
      same principle as the dashboard: one character, one drawing. The dock also
      shows itself on a page too short to scroll past the reveal, because the
      link-in-bio page is exactly that and the assistant was invisible on it.

   The API base is hardcoded rather than read from the page, because each page
   defines its own constant in its own scope and this file cannot see them. The
   branded hostname is the stable one; it is what every page already calls. */

(function () {
    'use strict';

    var API = 'https://api.libertymusa.com';
    var ENDPOINT = API + '/api/assistant/public';
    var MAX_HISTORY = 8;

    /* How long a question may go unanswered before the widget starts explaining
       itself, and how long before it gives up and offers somewhere else to go.
       Both are generous: the worker may legitimately spend several model rounds
       on one question, and cutting a slow-but-correct answer short would be its
       own kind of wrong. See the note in send(). */
    var SLOW_AFTER = 12000;
    var GIVE_UP_AFTER = 50000;

    /* The questions offered depend on the page the visitor is standing on.

       Somebody reading the portfolio wants to ask about the work they are
       looking at; somebody on the booking page wants to ask about dates; and
       somebody on the wedding page is asking about Beloved Imprint, not about
       the price of a portrait session. One set of three questions for the whole
       site made the widget look like it was bolted on rather than part of the
       page.

       Every question below is one the assistant has been *driven* with against
       the live API and answered from the studio's own data — that is the bar,
       because a suggestion is a promise. A tap on a question the assistant
       cannot answer does not fail quietly: it creates a handover, and the studio
       gets woken up for something nobody asked.

       The keys are the last segment of the path, so `/book` and `/book.html`
       are the same page and `/pay/` is the pay page. Anything not named here —
       the home page, the links page, a 404, a page added next year — gets
       DEFAULT_ASK, which is why that list is the safest one rather than the
       shortest. */
    var DEFAULT_ASK = [
        'How much is a portrait session?',
        'What do your packages include?',
        'Do you shoot weddings?'
    ];

    var PAGE = {
        portfolio: {
            ask: [
                'What kind of work do you shoot?',
                'Can I book a session like these?',
                'How much is a portrait session?'
            ]
        },
        gallery: {
            ask: [
                'What kind of work do you shoot?',
                'How do I get my own gallery?',
                'How much is a portrait session?'
            ]
        },
        book: {
            ask: [
                'How far ahead should I book?',
                'How much is a portrait session?',
                'What do your packages include?'
            ]
        },
        'wedding-book': {
            ask: [
                "What's included in a wedding package?",
                'How much do wedding packages cost?',
                'Do you shoot pre-weddings?'
            ]
        },
        wedding: {
            ask: [
                "What's included in a wedding package?",
                'How much do wedding packages cost?',
                'Do you shoot pre-weddings?'
            ]
        },
        review: {
            ask: [
                'What do clients say about the studio?',
                'How much is a portrait session?',
                'Can I book a session like these?'
            ]
        },
        /* The link-in-bio page, which is where everybody arriving from Instagram
           lands first. That arrival is the only thing true of these visitors and
           nobody else on the site: they have seen a grid of photographs and
           nothing else, and the page under them is four doors.

           So the three are the two questions a stranger actually has — what it
           costs, and how to get one — plus where the studio even is, which only
           a visitor who has seen no page yet needs to ask.

           These USED to be the default three, word for word, on the reasoning
           that the traffic is the same person. It is the same person, and the
           set was still wrong: a named set that is a subset of the fallback is
           not an adaptation at all, it is the fallback spelled twice, and the
           suite refuses it for exactly that reason (every named page must offer
           at least one question no unnamed page offers). The first version of
           this comment argued the rule away instead of meeting it. */
        links: {
            ask: [
                'How much is a portrait session?',
                'How do I book a session?',
                'Where are you based?'
            ]
        }
    };

    /* The studio's own words for this widget.

       Every value here is a default with a Settings field behind it, so Liberty
       can change what the widget says without anybody opening this file — and
       an unset setting means "use what is written here", never a blank. See
       loadSettings(), which only ever writes over these when the studio has
       actually said something. */
    var SAY = {
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
        suggestions: null,   // null means "use this page's own three"
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
    var chipsEl = null;
    var sendBtn = null;
    var typingEl = null;
    var typingDots = null;
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

        /* ── the mouth, and the three things this face does ──────────────── */

        /* Every mouth the face owns is drawn, stacked, and exactly one of them is
           showing. Crossfading rather than interpolating the path: a shape that
           has to morph between a straight line and an arc has to keep the same
           SVG commands, and the moment it cannot, the mouth snaps between them.

             straight   the resting face — nobody is talking to it
             smile      a pointer is on it, or the chat is open
             open       an answer is on its way

           The last one wins over the other two, on purpose: a face that keeps
           smiling through four seconds of thinking is a face that does not look
           like it is listening, and being busy is the one moment the face has
           something true to say. */
        '.lpa-face .lpa-mouth{opacity:0;transition:opacity .26s ease}',
        '.lpa-face .lpa-mouth.is-on{opacity:1}',
        '.lpa-lobe-ask:hover .lpa-mouth.is-on,.lpa-dock.is-open .lpa-mouth.is-on{opacity:0}',
        '.lpa-lobe-ask:hover .lpa-mouth.is-smile,.lpa-dock.is-open .lpa-mouth.is-smile{opacity:1}',
        /* Written against the lobe inside the dock rather than the dock alone,
           so it ties on specificity with the hover rule above and wins by being
           later — otherwise a hovered face would smile while it was working. */
        '.lpa-dock.is-busy .lpa-lobe-ask .lpa-mouth{opacity:0}',
        '.lpa-dock.is-busy .lpa-lobe-ask .lpa-mouth.is-open{opacity:1}',
        '.lpa-lobe-ask:hover .lpa-face,.lpa-dock.is-open .lpa-face,.lpa-dock.is-busy .lpa-face{transform:scale(1.06)}',

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
        '.lpa-sheet{position:fixed;left:50%;',
        '--lpa-safe:env(safe-area-inset-bottom,0px);--lpa-top-gap:10px;',
        'bottom:calc(var(--lpa-foot,68px) + var(--lpa-safe) + var(--lpa-lift,0px));',
        'z-index:90;width:min(420px,calc(100vw - 22px));',
        'max-height:min(calc(100svh - var(--lpa-foot,68px) - var(--lpa-safe) - var(--lpa-lift,0px) - var(--lpa-top-gap)),620px);',
        'display:flex;flex-direction:column;overflow:hidden;transform-origin:50% 118%;',
        'background:var(--bg-container,#fff);color:var(--text-primary,#1a1815);',
        'border:1px solid var(--border-color,#e8e3d9);border-radius:30px;',
        'box-shadow:0 30px 80px rgba(26,24,21,.28),0 1px 0 rgba(255,255,255,.35) inset;',
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
        '.lpa-head{position:relative;flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;',
        'padding:14px 13px 13px 17px;border-bottom:1px solid var(--border-color,#e8e3d9)}',
        '.lpa-title{font-family:"Fraunces",Georgia,serif;font-size:16px;line-height:1.25;letter-spacing:.2px}',
        '.lpa-close{flex:none;width:32px;height:32px;border-radius:50%;border:none;background:transparent;color:inherit;',
        'cursor:pointer;display:grid;place-items:center;opacity:.6;transition:opacity .25s ease,background-color .25s ease,transform .4s ' + SPRING + '}',
        '.lpa-close:hover{opacity:1;background:var(--highlight-bg,#f8f4ec)}',
        '.lpa-close:active{transform:scale(.92)}',
        '.lpa-close svg{width:13px;height:13px}',
        /* A phone-shaped grab handle: the sheet answers a downward drag, and
           saying so with a handle is the whole point of a handle. */
        '.lpa-grab{position:absolute;top:6px;left:50%;transform:translateX(-50%);width:40px;height:4px;',
        'border-radius:999px;background:var(--border-color,#e8e3d9);opacity:.9}',
        '@media (min-width:641px){.lpa-grab{display:none}}',

        /* ── the conversation ─────────────────────────────────────────────── */

        '.lpa-log{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;',
        'padding:16px 15px 6px;display:flex;flex-direction:column;gap:13px}',
        /* The studio answers as plain text, the way a person writes: no bubble,
           no border, nothing to click. The visitor's own words get the pill. */
        '.lpa-bot{font-size:15px;line-height:1.72;color:var(--text-primary,#1a1815);max-width:94%;white-space:pre-wrap;word-break:break-word}',
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
        '@keyframes lpa-dot{0%,100%{opacity:.22;transform:translateY(0)}50%{opacity:.85;transform:translateY(-2px)}}',

        /* ── the suggested questions ──────────────────────────────────────── */

        /* One scrollable row rather than three stacked lines: on a phone the
           wrapped version ate a third of the sheet before a word was typed.
           They leave as soon as the visitor asks something of their own. */
        /* The right edge fades rather than cutting a word in half: it says
           "there is more" without an arrow, a dot row or a scrollbar. */
        '.lpa-chips{flex:none;display:flex;flex-wrap:nowrap;gap:8px;padding:4px 15px 13px;overflow-x:auto;',
        'max-height:64px;scrollbar-width:none;',
        'transition:opacity .34s ease,transform .4s ' + SPRING + ',max-height .44s ' + SPRING + ',padding .44s ' + SPRING + ';',
        'mask-image:linear-gradient(to right,#000 calc(100% - 34px),transparent);',
        '-webkit-mask-image:linear-gradient(to right,#000 calc(100% - 34px),transparent)}',
        '.lpa-chips::-webkit-scrollbar{display:none}',
        /* The row they leave is space the conversation can use, so it collapses
           as it fades rather than sitting there empty. The selector is written
           out with the sheet's own entry rule on purpose: `.lpa-sheet.is-on
           .lpa-in` is more specific than `.lpa-chips.is-gone`, and the first
           version of this simply never faded anything. */
        '.lpa-chips.is-gone,.lpa-sheet.is-on .lpa-chips.is-gone{opacity:0;transform:translateY(8px);',
        'max-height:0;padding-top:0;padding-bottom:0;pointer-events:none}',
        '.lpa-chip{flex:none;padding:8px 14px;border-radius:999px;border:1px solid var(--border-color,#e8e3d9);',
        'background:transparent;color:inherit;font:inherit;font-size:12.5px;letter-spacing:.1px;cursor:pointer;',
        'white-space:nowrap;transition:background-color .25s ease,color .25s ease,transform .4s ' + SPRING + '}',
        '.lpa-chip:hover{background:var(--highlight-bg,#f8f4ec)}',
        '.lpa-chip:active{transform:scale(.97)}',

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
        '.lpa-dock,.lpa-sheet,.lpa-in,.lpa-neck,.lpa-lobe,.lpa-chip,.lpa-send,.lpa-btn,',
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

        /* Straight: the line every mouth is measured from. */
        mouth('M' + at(left) + ' ' + at(MOUTH_Y) + 'h' + size(width), 'is-neutral', true);

        /* A smile whose ends sit ON that line, so the face does not jump when
           the mouth changes — the middle dips instead. The radii are chosen for
           the dip, not for a circle: a semicircle here is a grin with nothing
           behind it. */
        mouth('M' + at(left) + ' ' + at(MOUTH_Y) + 'a' + size(3.8) + ' ' + size(3.4) +
            ' 0 0 0 ' + size(width) + ' 0', 'is-smile');

        /* Open, while an answer is being composed. Drawn rather than typed, and
           it is the only mouth that is not a line. */
        var open = document.createElementNS(SVG_NS, 'ellipse');
        open.setAttribute('cx', String(FACE_MID));
        open.setAttribute('cy', String(at(MOUTH_Y + 0.9)));
        open.setAttribute('rx', String(size(1.3)));
        open.setAttribute('ry', String(size(1.5)));
        open.setAttribute('class', 'lpa-mouth is-open');
        svg.appendChild(open);

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

    /** The studio's words: plain text, no bubble — except that a destination it
        names is tappable. See the note on LINK_SPLIT. */
    function say(text) {
        var stick = atBottom();
        var row = el('div', 'lpa-row');
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
        row.appendChild(box);
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
        /* The face knows when it is working: `is-busy` on the dock is what the
           CSS hangs the open mouth on. Toggled here rather than where the
           request is made, because this function is the one place that already
           knows whether a reply is still coming — including every path that ends
           in an error or a timeout. */
        if (dock) dock.classList.toggle('is-busy', !!on);
        if (on) {
            if (typingEl) return;
            var row = el('div', 'lpa-row');
            // The row is what gets added and removed; the dots inside it are what
            // grows the "still checking" line, so both are kept. Confusing the
            // two is how the caption would end up on the wrong element.
            var t = el('div', 'lpa-typing');
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

        // The suggestions have done their job the moment a visitor asks
        // something of their own, and from then on they are only clutter.
        if (chipsEl) chipsEl.classList.add('is-gone');
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
                body: JSON.stringify({ message: question, history: history.slice(-MAX_HISTORY), contact: savedContact })
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

    /** The questions to offer, in order of who knows best: the studio's own list
        from Settings if it wrote one, then this page's, then the safe three. */
    function suggestionsForPage() {
        if (SAY.suggestions && SAY.suggestions.length) return SAY.suggestions;
        var here = PAGE[pageKey()];
        return (here && here.ask) || DEFAULT_ASK;
    }

    /** (Re)draw the suggested questions. Separate from buildSheet because the
        studio's own list can arrive after the sheet was built. */
    function renderChips() {
        if (!chipsEl) return;
        chipsEl.textContent = '';
        suggestionsForPage().forEach(function (q) {
            var c = el('button', 'lpa-chip', q);
            c.type = 'button';
            c.addEventListener('click', function () { send(q); });
            chipsEl.appendChild(c);
        });
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
        if (!neck) return;
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
        sheet.setAttribute('aria-label', 'Ask the studio a question');
        sheet.hidden = true;

        var head = el('div', 'lpa-head lpa-in');
        head.appendChild(el('span', 'lpa-grab'));
        /* One line and nothing under it. The old header was a title plus a
           sentence explaining the title plus a close button — and on a phone
           that is most of the height of the sheet before the conversation has
           started. "Ask about a session" was also narrower than the thing it
           described: it answers questions about sessions, rates, dates and the
           studio itself. */
        head.appendChild(el('div', 'lpa-title', SAY.title));

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

        chipsEl = el('div', 'lpa-chips lpa-in');
        sheet.appendChild(chipsEl);
        renderChips();

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

    function openSheet() {
        if (open) return;
        open = true;

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
        dock.classList.add('is-open');
        liquify();
        lobeAsk.setAttribute('aria-expanded', 'true');
        settleInvites();

        if (!greetingShown) {
            greetingShown = true;
            say(SAY.greeting);
        }

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
        dock.classList.remove('is-open');
        lobeAsk.setAttribute('aria-expanded', 'false');
        if (inputEl) inputEl.blur();
        if (lobeAsk) lobeAsk.focus();

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
            var t = sheet && sheet.querySelector('.lpa-title');
            if (t) t.textContent = title;
        }

        // Only matters if the sheet has not been opened yet — after the first
        // hello the greeting is history, and rewriting history is not a thing.
        var greeting = str(s.assistant_greeting);
        if (greeting) SAY.greeting = greeting;

        var askLabel = str(s.assistant_ask_label);
        if (askLabel) SAY.ask = askLabel;

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

        var questions = lines(s.assistant_suggestions);
        if (questions.length) {
            SAY.suggestions = questions;
            renderChips();
        }

        /* The look, named. The old on/off setting still works — "off" was the
           bubble and anything else was the smiley, which is exactly what those
           two names mean now, so nothing already saved changes meaning. */
        var look = resolveLook(s);
        if (look && look !== SAY.look) { SAY.look = look; swapFaceIcon(); }
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

    function start() {
        injectStyles();
        adoptSiteCta();
        invites = SAY.invites.slice();
        buildDock();
        buildSheet();
        // The one way in a page owns, published only once there is a sheet to
        // open — see publish().
        publish();
        fillFaceSlots(false);
        wireReveal();
        wireKeyboard();
        // The words are on screen before the settings have answered; whatever
        // the studio has written lands on top of these a moment later. The
        // widget never waits on a request to become usable.
        startInvites();
        loadSettings();
        savedContact = loadSaved();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
