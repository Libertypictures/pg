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

   The API base is hardcoded rather than read from the page, because each page
   defines its own constant in its own scope and this file cannot see them. The
   branded hostname is the stable one; it is what every page already calls. */

(function () {
    'use strict';

    var API = 'https://api.libertymusa.com';
    var ENDPOINT = API + '/api/assistant/public';
    var MAX_HISTORY = 8;

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
            sub: 'Ask about any of the work you see.',
            ask: [
                'What kind of work do you shoot?',
                'Can I book a session like these?',
                'How much is a portrait session?'
            ]
        },
        gallery: {
            sub: 'Ask about the work, or about your own gallery.',
            ask: [
                'What kind of work do you shoot?',
                'How do I get my own gallery?',
                'How much is a portrait session?'
            ]
        },
        book: {
            sub: 'Real prices and real dates, straight from the studio.',
            ask: [
                'How far ahead should I book?',
                'How much is a portrait session?',
                'What do your packages include?'
            ]
        },
        'wedding-book': {
            sub: 'Real prices and real dates for Beloved Imprint.',
            ask: [
                "What's included in a wedding package?",
                'How much do wedding packages cost?',
                'Do you shoot pre-weddings?'
            ]
        },
        wedding: {
            sub: 'Beloved Imprint \u2014 the studio\u2019s wedding side.',
            ask: [
                "What's included in a wedding package?",
                'How much do wedding packages cost?',
                'Do you shoot pre-weddings?'
            ]
        },
        review: {
            sub: 'What clients have said, in their own words.',
            ask: [
                'What do clients say about the studio?',
                'How much is a portrait session?',
                'Can I book a session like these?'
            ]
        }
    };

    // Do not run twice, and do not run inside someone else's preview harness.
    if (window.__lpAssistantLoaded) return;
    window.__lpAssistantLoaded = true;

    var dock = null;
    var lobeAsk = null;
    var lobeBook = null;
    var neck = null;
    var sheet = null;
    var scrim = null;
    var logEl = null;
    var inputEl = null;
    var chipsEl = null;
    var sendBtn = null;
    var typingEl = null;
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

        '.lpa-dock{position:fixed;left:50%;bottom:calc(14px + env(safe-area-inset-bottom,0px) + var(--lpa-lift,0px));z-index:88;',
        'display:flex;align-items:center;justify-content:center;gap:0;',
        'transform:translateX(-50%) translateY(calc(100% + 34px)) scale(.94);opacity:0;pointer-events:none;',
        'transition:transform .66s ' + SPRING + ',opacity .44s ease,gap .52s ' + SPRING + ';will-change:transform,opacity}',
        '.lpa-dock.is-in{opacity:1;transform:translateX(-50%) translateY(0) scale(1);pointer-events:auto}',

        /* One recipe for both lobes and the neck between them, so the three read
           as a single piece of glass rather than three things that match. */
        '.lpa-lobe,.lpa-neck{background:rgba(255,252,248,.62);',
        'backdrop-filter:blur(20px) saturate(190%);-webkit-backdrop-filter:blur(20px) saturate(190%);',
        'box-shadow:inset 0 1px 0 rgba(255,255,255,.72),0 10px 30px rgba(26,24,21,.16);',
        'color:#1a1815;font-family:inherit;font-size:10px;font-weight:600;line-height:1;',
        // No wrapping, ever: a two-line label turns the capsule into a stack of
        // words and doubles its height, which is what it did on a 390px screen.
        'text-transform:uppercase;letter-spacing:1.6px;white-space:nowrap;border:none;cursor:pointer;text-decoration:none;',
        'display:inline-flex;align-items:center;gap:8px;height:42px;padding:0 18px;',
        'transition:background-color .32s ease,color .32s ease,padding .5s ' + SPRING + ',gap .5s ' + SPRING + ',',
        'border-radius .5s ' + SPRING + ',transform .5s ' + SPRING + ',box-shadow .4s ease}',
        '.lpa-lobe svg{width:14px;height:14px;flex:none}',
        '.lpa-lobe:focus-visible{outline:2px solid var(--accent,#8a7355);outline-offset:3px}',

        /* Flush neighbours with a pinched inner corner: two halves of one
           capsule, not two buttons that happen to be near each other. */
        '.lpa-lobe-book{border-radius:999px 3px 3px 999px;padding-right:15px;transform-origin:left center}',
        '.lpa-lobe-ask{border-radius:3px 999px 999px 3px;padding-left:15px;transform-origin:right center}',
        '.lpa-dock.is-single .lpa-lobe-book{display:none}',
        '.lpa-dock.is-single .lpa-lobe-ask{border-radius:999px;padding:0 20px}',

        /* Apart: round again, and the pinched joint is gone. */
        '.lpa-dock.is-open{gap:11px}',
        '.lpa-dock.is-open .lpa-lobe-book{border-radius:999px;padding:0 16px}',
        '.lpa-dock.is-open .lpa-lobe-ask{border-radius:999px;padding:0 16px}',
        '.lpa-dock.is-open .lpa-lobe-ask{background:rgba(26,24,21,.9);color:#f7f4ef;',
        'box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 12px 32px rgba(26,24,21,.28)}',

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
        /* The sheet's own height is the thing that put its title bar above the
           top of an iPhone screen: `vh` on iOS means the LARGE viewport, i.e.
           the one that assumes the URL bar has gone, so 72vh of it reached
           higher than the screen. It is capped against the height that is
           definitely on screen (svh), and it gives back whatever the keyboard
           has taken (--lpa-lift) instead of only sliding up under it. */
        '.lpa-sheet{position:fixed;left:50%;bottom:calc(var(--lpa-foot,68px) + env(safe-area-inset-bottom,0px) + var(--lpa-lift,0px));',
        'z-index:90;width:min(420px,calc(100vw - 22px));',
        'max-height:min(calc(100vh - var(--lpa-lift,0px) - var(--lpa-foot,68px) - 12px),620px);',
        'max-height:min(calc(100svh - var(--lpa-lift,0px) - var(--lpa-foot,68px) - 12px),620px);',
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

        '.lpa-head{position:relative;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;',
        'padding:16px 15px 13px;border-bottom:1px solid var(--border-color,#e8e3d9)}',
        '.lpa-title{font-family:"Fraunces",Georgia,serif;font-size:16.5px;line-height:1.25;letter-spacing:.2px}',
        '.lpa-sub{font-size:11.5px;color:var(--text-secondary,#6b6459);margin-top:3px;letter-spacing:.2px}',
        '.lpa-close{flex:none;width:30px;height:30px;border-radius:50%;border:none;background:transparent;color:inherit;',
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

        '.lpa-log{flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;',
        'padding:16px 15px 6px;display:flex;flex-direction:column;gap:13px}',
        /* The studio answers as plain text, the way a person writes: no bubble,
           no border, nothing to click. The visitor's own words get the pill. */
        '.lpa-bot{font-size:15px;line-height:1.72;color:var(--text-primary,#1a1815);max-width:94%;white-space:pre-wrap;word-break:break-word}',
        '.lpa-me{align-self:flex-end;max-width:86%;padding:9px 14px;border-radius:15px 15px 4px 15px;',
        'background:var(--highlight-bg,#f8f4ec);font-size:14.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word}',
        '.lpa-note{display:flex;gap:9px;align-items:flex-start;font-size:12.5px;line-height:1.6;',
        'color:var(--text-secondary,#6b6459);max-width:96%}',
        '.lpa-note::before{content:"";flex:none;width:4px;height:4px;border-radius:50%;margin-top:7px;',
        'background:var(--accent,#8a7355);opacity:.8}',
        '.lpa-card{border-radius:16px;padding:13px;background:var(--highlight-bg,#f8f4ec);',
        'display:flex;flex-direction:column;gap:8px;max-width:100%}',
        '.lpa-card p{font-size:13px;color:var(--text-secondary,#6b6459);line-height:1.6;margin:0}',
        '.lpa-typing{display:flex;gap:4px;align-items:center;padding:3px 0}',
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
        '.lpa-chips{display:flex;flex-wrap:nowrap;gap:8px;padding:4px 15px 13px;overflow-x:auto;',
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

        '.lpa-compose{padding:11px 13px 13px}',
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
        'html.lpa-keys .lpa-dock{opacity:0;pointer-events:none;transform:translateX(-50%) translateY(calc(100% + 34px))}',

        '@media (max-width:430px){',
        '.lpa-lobe{font-size:9px;letter-spacing:1.2px;gap:7px;height:40px;padding:0 14px}',
        '.lpa-lobe-book{padding-right:12px}.lpa-lobe-ask{padding-left:12px}',
        '.lpa-dock.is-open .lpa-lobe-book{padding:0 13px}.lpa-dock.is-open .lpa-lobe-ask{padding:0 13px}}',

        '@media (prefers-color-scheme:dark){',
        '.lpa-lobe,.lpa-neck{color:#f3f0ea;background:rgba(38,36,32,.6);',
        'box-shadow:inset 0 1px 0 rgba(255,255,255,.12),0 10px 30px rgba(0,0,0,.5)}',
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
        '.lpa-dock,.lpa-sheet,.lpa-in,.lpa-neck,.lpa-lobe,.lpa-chip,.lpa-send,.lpa-btn{transition:none!important;animation:none!important}}'
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

    function atBottom() {
        return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
    }

    function toBottom() {
        logEl.scrollTop = logEl.scrollHeight;
    }

    /** The studio's words: plain text, no bubble. */
    function say(text) {
        var stick = atBottom();
        var row = el('div', 'lpa-row');
        row.appendChild(el('div', 'lpa-bot', text));
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
        if (on) {
            if (typingEl) return;
            var row = el('div', 'lpa-row');
            var t = el('div', 'lpa-typing');
            t.appendChild(el('i'));
            t.appendChild(el('i'));
            t.appendChild(el('i'));
            row.appendChild(t);
            logEl.appendChild(row);
            toBottom();
            typingEl = row;
            return;
        }
        if (typingEl && typingEl.parentNode) typingEl.parentNode.removeChild(typingEl);
        typingEl = null;
    }

    /** Close the widget for good — used when the assistant is not available. */
    function removeWidget() {
        if (dock && dock.parentNode) dock.parentNode.removeChild(dock);
        if (sheet && sheet.parentNode) sheet.parentNode.removeChild(sheet);
        if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim);
        // Hand the page's own floating button back before leaving: the class
        // below is the only thing that hid it, and the page still works.
        document.documentElement.classList.remove('lpa-dock-alive');
        window.__lpAssistantLoaded = false;
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
                    note('Liberty already has your details from before, so she can reply to you directly.');
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
                        note('Thank you — Liberty has that, and she will come back to you.');
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
        said(question);
        if (inputEl) { inputEl.value = ''; grow(); }
        setBusy(true);

        try {
            var res = await fetch(ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
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
                note('Let me pass that to Liberty — she will come back to you personally.');
            }
            if (data && data.handedOver) {
                note('That one is beyond me, so Liberty has been told about it and will answer you herself.');
                offerCallback(data.handoverToken, question);
            }
        } catch (err) {
            // A network failure is not a reason to leave a broken box on screen
            // for the rest of the visit.
            fallback('I could not reach the studio just now.');
        } finally {
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

    /** The questions for this page, falling back to the ones that fit anywhere. */
    function askForPage() {
        var here = PAGE[pageKey()];
        return (here && here.ask) || DEFAULT_ASK;
    }

    /** The line under the sheet's title, said in this page's terms. */
    function subForPage() {
        var here = PAGE[pageKey()];
        return (here && here.sub) || 'Real prices and real dates, straight from the studio.';
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
        lobeAsk.appendChild(icon('M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'));
        lobeAsk.appendChild(el('span', null, 'Ask a question'));
        lobeAsk.addEventListener('click', function () { open ? close() : openSheet(); });
        dock.appendChild(lobeAsk);

        document.body.appendChild(dock);
        ownTheFooter(true);
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
        var titles = el('div');
        titles.appendChild(el('div', 'lpa-title', 'Ask about a session'));
        titles.appendChild(el('div', 'lpa-sub', subForPage()));
        head.appendChild(titles);

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
        askForPage().forEach(function (q) {
            var c = el('button', 'lpa-chip', q);
            c.type = 'button';
            c.addEventListener('click', function () { send(q); });
            chipsEl.appendChild(c);
        });
        sheet.appendChild(chipsEl);

        var compose = el('div', 'lpa-compose lpa-in');
        var ring = el('div', 'lpa-ring');
        inputEl = el('textarea', 'lpa-input');
        inputEl.rows = 1;
        inputEl.placeholder = 'Ask a question\u2026';
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

        liquify();
        dock.classList.add('is-open');
        lobeAsk.setAttribute('aria-expanded', 'true');

        if (!greetingShown) {
            greetingShown = true;
            say('Hello — I can tell you about sessions, prices and open dates, and pass anything else to Liberty. What would you like to know?');
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

    function wireReveal() {
        function update() {
            var past = window.scrollY > (window.innerHeight * 0.55);
            if (past === revealed) return;
            revealed = past;
            if (open) return;
            dock.classList.toggle('is-in', past);
        }
        window.addEventListener('scroll', update, { passive: true });
        window.addEventListener('resize', update);
        update();
    }

    /* The WhatsApp fallback needs the studio's real number, and the same
       endpoint the page already uses for it. If this fails, the fallback simply
       has no link — which is a worse fallback, not a broken widget. */
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
            })
            .catch(function () {});
    }

    function start() {
        injectStyles();
        adoptSiteCta();
        buildDock();
        buildSheet();
        wireReveal();
        wireKeyboard();
        loadSettings();
        savedContact = loadSaved();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
