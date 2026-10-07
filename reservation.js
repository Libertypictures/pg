/* A DATE THAT IS HELD, AND NOT YET BOOKED — the one place a client is told what
   just happened and what to do next.

   WHY THIS FILE EXISTS. On 28 September 2026 the owner made a booking on his own
   phone and photographed the card the page handed back:

     Request Received
     Your session request for September 28 at 3:00 PM has been received.
     We'll confirm within 24 hours — check hello@libertymusa.com.

   Every sentence of it was wrong about the process that page is running. The
   reservation had ALREADY been saved before the card appeared — that is what the
   card is celebrating — and saving it is what starts the worker's hold, which
   runs out by itself and lets the date go to anyone. The page's own step header,
   one screen above, says 03 SECURE WITH RETAINER. And no email was coming: the
   worker sends a client nothing at reservation, and the first receipt it sends
   goes out only AFTER the retainer is paid. So the card asked a client to wait
   for a confirmation nobody was preparing, while the one act that actually
   secures the date — the retainer, two sections below a "Custom Additions" panel
   — went unmentioned. A client who believed it closed the tab and lost the date.

   WHAT IT IS NOW. A heading that says where the date stands, one fact per line
   for what cannot change, and a closing sentence that says what happens next and
   where the receipt goes. The shape and the words live in one file because the
   two booking pages both show this card, and because a card whose wording is
   spelled inline in a page cannot be run: the only check possible against a
   string written inside a render function is a search for words someone already
   knew about, which is exactly how "we'll confirm within 24 hours" survived a
   whole sweep of the notification copy.

   ── why there is NO FIGURE and NO BUTTON (docs/decisions/0080) ───────────────

   This card used to carry four facts — the last two being the hold and the
   receipt address — and end in a button that took the client down to the
   retainer, reading "Pay the ₦70,000 retainer".

   Both halves of that were wrong in the same way. The extras panel, the summary
   and the policy checkbox sit BETWEEN this card and the retainer, and an extra
   ticked after the date is held changes the amount: the summary recomputes, the
   client is charged from it, and the card — drawn once, at the moment of booking
   — keeps the figure the worker decided that instant. The button then moved them
   PAST the very steps that decide what they pay. So the amount is no longer on
   the card at all, and `heldNotice` is not even given a money formatter: a
   sentence here cannot print a stale number because it cannot print a number.
   The figure lives where it is kept true — the summary's own RETAINER TODAY line
   and the receipt that repeats it — and the closing sends the client down the
   page instead of over it.

   ── where every value comes from ─────────────────────────────────────────────

   Nothing here reads the cart, the clock, or the form. `heldNotice` is handed the
   worker's answer to POST /book and prints it:

     · the session — the worker's own label for the time it just stored
       (formatSessionLabel, the same string the bell and the reminder email use);
     · whether a retainer is due at all — the amount the WORKER decided (it falls
       back to the 70% split if the page sends none). The card says the retainer
       is due and sends the client to the figure, because only the summary and the
       receipt are kept current;
     · the hold — the row's own expiry stamp, turned into words by the worker
       (`holdUntil`, holdMomentLabel in lib/bookingMoney.js). This file never
       dates a hold: a page that does arithmetic on a duration is how a client
       ends up reading "held until 29 September" in October;
     · the address the receipt goes to — the field the client typed, shown back as
       text, never as markup.

   A reservation with no price is a real state, not ₦0: the wedding page posts a
   name, an email and a time before any package is chosen, and printing "₦0 due
   now" beside a real client reads as a free session. So the retainer fact and the
   closing's next step follow the worker's own answer about whether there is money
   on the booking at all — the same rule the studio's own panel follows (see
   apps/api/src/lib/bookingMoney.js).

   Guarded by tools/test-reservation-copy.js and
   apps/api/test/reservation-email.test.js in the studio repository, which run
   this file's own composer, provoke the old card against the same checkers, and
   fail if either booking page ever writes these words for itself again.
*/
(function () {
    'use strict';

    var DASH = '\u2014';   /* the em dash every fact is built with */

    /* ONE FACT: a named subject, a dash, the fact, a full stop — the shape every
       notice in this product has, so a list of them can be counted by eye. */
    function fact(label, value) {
        var text = String(value == null ? '' : value).trim();
        if (!text) return '';
        /* A value that is already its own sentence keeps its own ending; an
           ellipsis means the worker clipped it deliberately. */
        if (!/[.!?\u2026]$/.test(text)) text += '.';
        return label + ' ' + DASH + ' ' + text;
    }

    /* WHAT A CLIENT IS TOLD THE MOMENT THEIR RESERVATION IS SAVED.

       `reservation` is the worker's answer: { sessionLabel, retainerAmount,
       holdExpiresAt, holdUntil } — see routes/bookings.js. `email` is where the
       receipt goes. There is no formatter argument on purpose: whether the client
       reads a figure here is the one thing this card must not do, because the
       figure that matters is settled below it (see the note at the top). */
    function heldNotice(reservation, email) {
        var r = reservation || {};
        var hasPrice = Number(r.retainerAmount || 0) > 0;
        var addr = String(email == null ? '' : email).trim();
        var until = String(r.holdUntil == null ? '' : r.holdUntil).trim();
        /* A hold is only claimed when the worker recorded one AND said when it
           ends: "held" with no deadline is the half-sentence the studio was
           photographed reading. */
        var held = !!(r.holdExpiresAt && until);

        var facts = [
            fact('Session', r.sessionLabel),
            /* No price is a real state, not ₦0 of money: the wedding page can take
               a consultation before any package is chosen. Naming what is missing
               is the honest half — and where there IS a price this sends the
               client to the one line that is recomputed every time they choose
               something, rather than printing the figure from the moment of
               booking. The wording is deliberately layout-free: the same line is
               built by the worker for the client's reservation email
               (apps/api/src/lib/reservationEmail.js), and "below" is true on this
               card and meaningless in an inbox. A test runs both composers over
               one booking and refuses any difference in the words they share. */
            fact('Retainer', hasPrice
                ? 'due before the date, and your summary below shows the amount'
                : 'none is set yet, so choose a package to set it')
        ].filter(function (line) { return line !== ''; });

        /* THE CLOSING SENTENCE — where the date stands, what to do next, and
           where the receipt goes. Not a fact, and not a bullet: it is the line a
           client reads last, and it points at the step below rather than jumping
           to it. Its first half is the hold in the worker's own words, which is
           the same sentence the reservation email carries as its own line. */
        var closing = (held
            ? 'The date is held for you until ' + until + '.'
            : 'No hold is recorded on this date, so it can be taken.') + ' ' +
            (hasPrice
                ? 'Continue to secure it with the retainer'
                : 'Continue to secure it by choosing a package') +
            (addr
                ? ', and your receipt goes to ' + addr +
                    (hasPrice ? ' once it arrives.' : ' once a package is paid for.')
                : '.');

        return {
            title: held
                ? 'Date held ' + DASH + ' not booked yet'
                : 'Request received ' + DASH + ' not booked yet',
            facts: facts,
            closing: closing
        };
    }

    /* DRAWING IT IS PART OF THE SAME PROMISE. A heading, a list of facts and one
       closing sentence is the shape; leaving that to each page is how one of them
       ends up drawing a paragraph again. Text nodes only — the receipt address in
       that sentence is something a client typed, and innerHTML is how a page
       starts executing what it was given. */
    function draw(card, notice) {
        if (!card || !notice) return false;
        var titleEl = card.querySelector('[data-held-title]');
        var linesEl = card.querySelector('[data-held-lines]');
        var closingEl = card.querySelector('[data-held-closing]');

        if (titleEl) titleEl.textContent = notice.title;
        if (linesEl) {
            linesEl.innerHTML = '';   /* the list itself, never a fact: see below */
            (notice.facts || []).forEach(function (line) {
                var li = document.createElement('li');
                li.textContent = line;
                linesEl.appendChild(li);
            });
        }
        if (closingEl) closingEl.textContent = notice.closing || '';
        return true;
    }

    window.LPReservation = { heldNotice: heldNotice, draw: draw, fact: fact };
})();
