/* The studio assistant, on the public website.

   One file, dropped onto a page with a single <script> tag. It adds a small
   glass pill in the bottom-right corner; opening it gives a visitor a chat box
   that answers from the studio's live data — real prices, real packages, real
   availability — and hands anything it cannot answer to Liberty.

   Four decisions worth knowing before changing this file:

   1. It fails CLOSED. If the assistant is not switched on, or the API cannot be
      reached, the pill removes itself and the page carries on exactly as it did
      before. A chat box that opens onto an error is worse than no chat box.

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

   The API base is hardcoded rather than read from the page, because each page
   defines its own constant in its own scope and this file cannot see them. The
   branded hostname is the stable one; it is what every page already calls. */

(function () {
    'use strict';

    var API = 'https://api.libertymusa.com';
    var ENDPOINT = API + '/api/assistant/public';
    var MAX_HISTORY = 8;

    var SUGGESTIONS = [
        'How much is a portrait session?',
        'What do your packages include?',
        'Do you shoot weddings?'
    ];

    // Do not run twice, and do not run inside someone else's preview harness.
    if (window.__lpAssistantLoaded) return;
    window.__lpAssistantLoaded = true;

    var panel = null;
    var logEl = null;
    var inputEl = null;
    var launcher = null;
    var noticeEl = null;
    var history = [];
    var busy = false;
    var greetingShown = false;
    var whatsapp = null;   // filled from /api/settings so the fallback is real
    var savedContact = null;  // who this browser said it was, if anyone

    /* ------------------------------------------------------------------ */
    /* Styles — injected once, scoped by the lpa- prefix so nothing here
       can reach the page. Colours come from the site's own tokens with a
       fallback, so this works on every page and in both colour schemes. */
    /* ------------------------------------------------------------------ */

    var CSS = [
        '.lpa-launch{position:fixed;right:18px;bottom:16px;z-index:88;display:inline-flex;align-items:center;gap:8px;padding:11px 17px;',
        'font-family:inherit;font-size:10px;font-weight:600;line-height:1;text-transform:uppercase;letter-spacing:1.6px;',
        'color:#1a1815;background:rgba(255,252,248,0.55);border:none;border-radius:999px;cursor:pointer;',
        'backdrop-filter:blur(18px) saturate(180%);-webkit-backdrop-filter:blur(18px) saturate(180%);',
        'box-shadow:inset 0 1px 0 rgba(255,255,255,0.7),0 8px 24px rgba(26,24,21,0.14);',
        'transition:transform .35s cubic-bezier(.16,1,.3,1),background-color .3s ease}',
        // The hidden attribute has to be addressed explicitly: the rule above
        // sets display, and a set display beats the [hidden] UA default, so
        // without this line hiding the launcher silently does nothing.
        '.lpa-launch[hidden]{display:none}',
        '.lpa-launch:hover{transform:translateY(-2px)}',
        '.lpa-launch:focus-visible{outline:2px solid var(--accent,#8a7355);outline-offset:2px}',
        '.lpa-launch svg{width:14px;height:14px;flex:none}',
        '@media (prefers-color-scheme:dark){.lpa-launch{color:#f3f0ea;background:rgba(40,38,34,0.55);',
        'box-shadow:inset 0 1px 0 rgba(255,255,255,0.12),0 8px 24px rgba(0,0,0,0.5)}}',

        '.lpa-panel{position:fixed;right:18px;bottom:16px;z-index:89;width:min(370px,calc(100vw - 28px));',
        'max-height:min(74vh,620px);display:flex;flex-direction:column;',
        'background:var(--bg-container,#fff);color:var(--text-primary,#1a1815);',
        'border:1px solid var(--border-color,#e8e3d9);border-radius:4px;overflow:hidden;',
        'box-shadow:0 24px 60px rgba(26,24,21,0.24);',
        'font-family:inherit;font-size:14px;line-height:1.6}',
        '.lpa-panel[hidden]{display:none}',

        '.lpa-head{display:flex;align-items:center;justify-content:space-between;gap:10px;',
        'padding:14px 15px;border-bottom:1px solid var(--border-color,#e8e3d9)}',
        '.lpa-title{font-family:"Fraunces",Georgia,serif;font-size:15px;letter-spacing:.2px}',
        '.lpa-sub{font-size:11px;color:var(--text-secondary,#6b6459);margin-top:2px}',
        '.lpa-close{background:none;border:none;color:inherit;font-size:20px;line-height:1;cursor:pointer;',
        'padding:2px 6px;opacity:.65;font-family:inherit}',
        '.lpa-close:hover{opacity:1}',

        '.lpa-log{flex:1;overflow-y:auto;padding:14px 15px;display:flex;flex-direction:column;gap:11px}',
        '.lpa-row{display:flex}.lpa-row.lpa-user{justify-content:flex-end}',
        '.lpa-bubble{max-width:88%;padding:10px 13px;border-radius:3px;white-space:pre-wrap;word-break:break-word}',
        '.lpa-row.lpa-user .lpa-bubble{background:var(--highlight-bg,#f8f4ec)}',
        '.lpa-row.lpa-bot .lpa-bubble{background:var(--bg-card,#fefdfb);border-left:2px solid var(--accent,#8a7355)}',
        '.lpa-row.lpa-note .lpa-bubble{background:transparent;border:1px dashed var(--border-dashed,#d8d1c2);',
        'font-size:13px;color:var(--text-secondary,#6b6459)}',
        '.lpa-meta{font-size:11px;color:var(--text-secondary,#6b6459);margin-top:5px;opacity:.85}',

        '.lpa-chips{display:flex;flex-wrap:wrap;gap:7px;padding:0 15px 12px}',
        '.lpa-chip{padding:7px 12px;border-radius:999px;border:1px solid var(--border-color,#e8e3d9);',
        'background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}',
        '.lpa-chip:hover{background:var(--highlight-bg,#f8f4ec)}',

        '.lpa-compose{display:flex;gap:8px;align-items:flex-end;padding:12px 15px;',
        'border-top:1px solid var(--border-color,#e8e3d9)}',
        '.lpa-input{flex:1;resize:none;min-height:42px;max-height:116px;padding:11px 12px;border-radius:3px;',
        'border:1px solid var(--border-color,#e8e3d9);background:transparent;color:inherit;font:inherit;font-size:14px}',
        '.lpa-send{padding:11px 16px;border:none;border-radius:999px;cursor:pointer;font:inherit;font-size:12px;',
        'font-weight:600;letter-spacing:.4px;background:var(--btn-primary-bg,#1a1815);color:var(--btn-primary-text,#fff)}',
        '.lpa-send[disabled]{opacity:.55;cursor:default}',
        '.lpa-wa{display:inline-block;margin-top:8px;padding:9px 15px;border-radius:999px;text-decoration:none;',
        'font-size:12px;font-weight:600;background:var(--btn-primary-bg,#1a1815);color:var(--btn-primary-text,#fff)}',

        // The callback form: shown only when the assistant has handed a
        // question over. Two fields, both optional, and the client can ignore
        // the whole thing and use the WhatsApp button instead.
        //
        // It lives INSIDE the conversation log rather than under the panel,
        // because that is where the visitor is looking when they are told the
        // question is being passed on. Appended to the panel it appeared below
        // the message box, detached from the sentence that asked for it.
        '.lpa-form{display:flex;flex-direction:column;gap:7px;margin:2px 0 0}',
        '.lpa-field{padding:9px 11px;border-radius:3px;border:1px solid var(--border-color,#e8e3d9);',
        'background:transparent;color:inherit;font:inherit;font-size:13px}',
        '.lpa-form .lpa-send{align-self:flex-start;margin-top:2px}',
        '.lpa-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}',
        '@media (max-width:420px){.lpa-panel{right:10px;left:10px;bottom:10px;width:auto;max-height:82vh}}'
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

    function say(kind, text) {
        var row = el('div', 'lpa-row lpa-' + kind);
        var bubble = el('div', 'lpa-bubble', text);
        row.appendChild(bubble);
        logEl.appendChild(row);
        logEl.scrollTop = logEl.scrollHeight;
        return bubble;
    }

    function note(text) {
        var row = el('div', 'lpa-row lpa-note');
        row.appendChild(el('div', 'lpa-bubble', text));
        logEl.appendChild(row);
        logEl.scrollTop = logEl.scrollHeight;
    }

    /** Close the widget for good — used when the assistant is not available. */
    function removeWidget() {
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
        if (launcher && launcher.parentNode) launcher.parentNode.removeChild(launcher);
        window.__lpAssistantLoaded = false;
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

    /** A WhatsApp button carrying the visitor's own words, so nothing is lost. */
    function whatsappButton(label, question) {
        var href = whatsappLink(question
            ? 'Hi — I asked on your website: ' + question
            : 'Hi — I was on your website and had a question.');
        if (!href) return;
        var row = el('div', 'lpa-row lpa-note');
        var bubble = el('div', 'lpa-bubble');
        var a = el('a', 'lpa-wa', label);
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        bubble.appendChild(a);
        row.appendChild(bubble);
        logEl.appendChild(row);
        logEl.scrollTop = logEl.scrollHeight;
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

        note('If you leave an email or a WhatsApp number, Liberty can reply to you directly.');

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

        var submit = el('button', 'lpa-send', 'Send to Liberty');
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
                        if (form.parentNode) form.parentNode.removeChild(form);
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

        logEl.appendChild(form);
        logEl.scrollTop = logEl.scrollHeight;
        contactInput.focus();
    }

    /** Every dead end ends the same way: WhatsApp, never a phone number. */
    function fallback(text) {
        note(text);
        var href = whatsappLink('Hi — I was on your website and had a question.');
        if (!href) return;
        var row = el('div', 'lpa-row lpa-note');
        var bubble = el('div', 'lpa-bubble');
        var a = el('a', 'lpa-wa', 'Message the studio on WhatsApp');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener';
        bubble.appendChild(a);
        row.appendChild(bubble);
        logEl.appendChild(row);
        logEl.scrollTop = logEl.scrollHeight;
    }

    function setBusy(v) {
        busy = v;
        if (inputEl) inputEl.disabled = v;
        var btn = panel.querySelector('.lpa-send');
        if (btn) btn.disabled = v;
    }

    async function send(text) {
        if (busy) return;
        var question = String(text || (inputEl ? inputEl.value : '') || '').trim();
        if (!question) return;

        say('user', question);
        if (inputEl) { inputEl.value = ''; inputEl.style.height = 'auto'; }
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
                say('bot', data.reply);
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
            if (inputEl && !inputEl.disabled) inputEl.focus();
        }
    }

    function buildPanel() {
        panel = el('div', 'lpa-panel');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Ask the studio a question');
        panel.hidden = true;

        var head = el('div', 'lpa-head');
        var titles = el('div');
        titles.appendChild(el('div', 'lpa-title', 'Ask about a session'));
        titles.appendChild(el('div', 'lpa-sub', 'Real prices and dates, straight from the studio.'));
        head.appendChild(titles);

        var close = el('button', 'lpa-close', '\u00d7');
        close.type = 'button';
        close.setAttribute('aria-label', 'Close');
        close.addEventListener('click', function () { hide(); });
        head.appendChild(close);
        panel.appendChild(head);

        logEl = el('div', 'lpa-log');
        logEl.setAttribute('aria-live', 'polite');
        panel.appendChild(logEl);

        var chips = el('div', 'lpa-chips');
        SUGGESTIONS.forEach(function (q) {
            var c = el('button', 'lpa-chip', q);
            c.type = 'button';
            c.addEventListener('click', function () { send(q); });
            chips.appendChild(c);
        });
        panel.appendChild(chips);

        var compose = el('div', 'lpa-compose');
        inputEl = el('textarea', 'lpa-input');
        inputEl.rows = 1;
        inputEl.placeholder = 'Ask a question\u2026';
        inputEl.setAttribute('aria-label', 'Your question');
        inputEl.addEventListener('keydown', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
        });
        inputEl.addEventListener('input', function () {
            inputEl.style.height = 'auto';
            inputEl.style.height = Math.min(inputEl.scrollHeight, 116) + 'px';
        });
        compose.appendChild(inputEl);

        var sendBtn = el('button', 'lpa-send', 'Send');
        sendBtn.type = 'button';
        sendBtn.addEventListener('click', function () { send(); });
        compose.appendChild(sendBtn);
        panel.appendChild(compose);

        document.body.appendChild(panel);
    }

    function show() {
        if (!panel) buildPanel();
        panel.hidden = false;
        if (launcher) launcher.hidden = true;
        if (!greetingShown) {
            greetingShown = true;
            say('bot', 'Hello — I can tell you about sessions, prices and open dates, and pass anything else to Liberty. What would you like to know?');
        }
        // Only focus on a real pointer/keyboard screen: on a phone, focusing the
        // field throws the keyboard over the page before it has been read.
        if (window.matchMedia && window.matchMedia('(min-width: 640px)').matches) {
            setTimeout(function () { if (inputEl) inputEl.focus(); }, 0);
        }
    }

    function hide() {
        if (panel) panel.hidden = true;
        if (launcher) launcher.hidden = false;
        if (launcher) launcher.focus();
    }

    function buildLauncher() {
        launcher = el('button', 'lpa-launch');
        launcher.type = 'button';
        launcher.setAttribute('aria-label', 'Ask the studio a question');
        launcher.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
        launcher.appendChild(el('span', null, 'Ask a question'));
        launcher.addEventListener('click', show);
        document.body.appendChild(launcher);
    }

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && panel && !panel.hidden) hide();
    });

    /* The WhatsApp fallback needs the studio's real number, and the same
       endpoint the page already uses for it. If this fails, the fallback simply
       has no link — which is a worse fallback, not a broken widget. */
    function loadContact() {
        fetch(API + '/api/settings')
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
                if (d && d.settings && d.settings.whatsapp_number) whatsapp = d.settings.whatsapp_number;
            })
            .catch(function () {});
    }

    function start() {
        injectStyles();
        buildLauncher();
        loadContact();
        savedContact = loadSaved();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
