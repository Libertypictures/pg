/* Money on its way out of a page — the one definition, loaded by every screen
   that charges a client.

   WHY THIS FILE EXISTS. On 19 September 2026 a client told the studio that the
   pay button on the pay page "was not working". It was working exactly as
   written and doing nothing at all, which is worse than an error.

   Her booking was stored with kobo in it: total ₦101,667.89, retainer
   ₦71,167.52. The page worked out the balance the only way it could —
   `101667.89 - 71167.52` — and JavaScript said `30500.369999999995`. It then
   asked Paystack for `30500.369999999995 * 100` kobo, i.e. 3050036.9999999995.
   Paystack's own inline library checks every amount with `parseInt(x) == x`,
   which is false for that number, so it threw "Attribute amount must be a valid
   integer". The click handler had no `try`, so the throw went nowhere, and the
   client saw a button labelled "Pay ₦30,500" that did nothing when she pressed
   it. Nothing on the page said anything was wrong.

   The same arithmetic was broken for a package on sale today: Two Looks is
   ₦180,000, and `180000 * 0.70` is `125999.99999999999` in JavaScript — so "Pay
   Retainer" on the booking page did nothing for that package either.

   Nothing about this is exotic. A percentage of a price is a float, and money
   is a whole number of the smallest unit. So:

     · every amount handed to Paystack goes through LPMoney.toKobo, and
     · the server stores whole naira whatever a page sends (apps/api/src/lib/
       money.js), so one bad number can never reach the database and sit there.

   Both rules are asserted by tools/test-money.js in the studio repository, which
   reads these pages and fails if a charge is built any other way. Adding a new
   payment screen means loading this file and using it — nothing else is needed,
   and nothing else is allowed.

   Deliberately NOT here: formatting. Every page already has its own
   `formatNaira` for display, and display was never the problem. This file is
   only about the number that leaves the browser. */
(function () {
    'use strict';

    /* Naira in, whole kobo out — the number Paystack will accept. */
    function toKobo(naira) {
        var n = Number(naira);
        return Number.isFinite(n) ? Math.round(n * 100) : 0;
    }

    /* Naira in, whole naira out — for a figure that is stored, sent as a
       payment amount, or shown beside another one. */
    function wholeNaira(naira) {
        var n = Number(naira);
        return Number.isFinite(n) ? Math.round(n) : 0;
    }

    /* The 70% / 30% split, worked out so that the two halves always add back to
       the total. Rounding each half separately is how a receipt ends up a naira
       short of itself: 30% of 180,000 rounds to 54,000 and 70% to 126,000, and
       those do add up — but 30% of 169,999 does not, and the difference lands on
       the client's balance. The balance is derived by subtraction, never by a
       second percentage. */
    function splitNaira(total) {
        var whole = wholeNaira(total);
        var retainer = wholeNaira(whole * 0.7);
        return { total: whole, retainer: retainer, balance: whole - retainer };
    }

    /* Why a charge could not be opened, in words a client can act on — or null
       when the amount is fine. Callers show this instead of throwing, because a
       silent throw is the fault this file was written to end. */
    function problemWith(kobo) {
        var k = Number(kobo);
        if (!Number.isFinite(k) || k !== Math.round(k)) return 'This amount could not be prepared for payment.';
        if (k <= 0) return 'This amount is not valid.';
        return null;
    }

    window.LPMoney = {
        toKobo: toKobo,
        wholeNaira: wholeNaira,
        splitNaira: splitNaira,
        problemWith: problemWith
    };
})();
