// Simplified admin workflow (Pending → Accept → Completed / Ready for Pickup):
// moves PAID orders left in a removed intermediate state (accepted / printing /
// ready) to 'completed' so they appear in Completed Orders. Data only; no schema
// change; payment, ticket and file data are untouched. Safe to re-run.
//   node server/migrate_simplify_workflow.js
require('./loadEnv');
const pool = require('./db');

async function migrate() {
    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required (set it in server/.env).');
    }
    try {
        const [rows] = await pool.query(
            `UPDATE orders SET status = 'completed'
             WHERE status IN ('accepted', 'printing', 'ready') AND payment_status = 'PAID'
             RETURNING id`
        );
        console.log(`✓ Moved ${rows.length} order(s) to completed${rows.length ? `: ${rows.map(r => r.id).join(', ')}` : ''}`);
        const [[left]] = await pool.query(
            `SELECT COUNT(*) AS n FROM orders WHERE status IN ('accepted', 'printing', 'ready')`
        );
        if (Number(left.n) > 0) {
            console.log(`ℹ️  ${left.n} unpaid order(s) are still in an intermediate state; they need payment confirmation first.`);
        }
    } finally {
        await pool.end();
    }
}

migrate().catch(err => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
});
We are NOT going to make another speculative fix.

The latest investigation confirmed that `normalizeEmail()` already safely handles null/undefined, so the previous theory that `customer_email = NULL` caused the 500 is incorrect.

Production evidence for Order 75 is:

- orders.id = 75
- payment_status = PAID
- ticket_status = READY
- ticket_number = CP-075
- user_id = NULL
- guest_email IS NOT NULL
- ticket_access_token_hash IS NOT NULL

Browser production request:

GET /api/orders/75 → HTTP 500
Response:
{
  "code": "TICKET_LOAD_FAILED",
  "message": "Unable to load this ticket right now. Please retry."
}

I want you to now find the ACTUAL exception causing this 500.

IMPORTANT:
1. Do NOT assume the cause.
2. Do NOT make another defensive/speculative fix.
3. Do NOT change payment verification.
4. Do NOT change database schema.
5. Do NOT rewrite recovery authorization.
6. Do NOT declare the issue fixed based on static analysis.

Trace the exact execution path:

GET /api/orders/75
→ Order.getOrderRecord(75)
→ resolveTicketAccess(req, order)
→ canAccessOrder(...)
→ buildTicketView(order)
→ response

For EVERY stage, inspect the actual current production-compatible code and identify every operation that can throw.

Specifically inspect:

A. `Order.getOrderRecord()`
- Show the exact SQL query currently used.
- Verify every selected column actually exists in production.
- Verify the LEFT JOIN users query.
- Verify the returned object shape.
- Check whether any referenced column is nonexistent.
- Check whether any database driver error can occur.

B. `resolveTicketAccess()`
- Trace every branch actually executed for a guest OTP recovery request.
- Identify exactly which authorization branch is selected.

C. `canAccessOrder()`
- Inspect the exact current implementation.
- Verify every property it accesses.
- Verify no null/undefined operation can throw.
- Do NOT assume normalizeEmail is the problem; we already verified it safely handles null/undefined.

D. `buildTicketView()`
- Inspect the exact implementation.
- Check every property/function it accesses.
- Check ticket token handling.
- Check ticket status handling.
- Check document/file lookup.
- Check any filesystem/storage/database operation.
- Identify anything that can throw a 500.

E. MOST IMPORTANT: ERROR STACK
Find the actual server-side exception corresponding to:
GET /api/orders/75 → 500

Do not infer it from the frontend.

I need the exact:
- error name
- error message
- stack trace
- file
- line number
- function
- SQL/query if applicable

If production logs are not accessible from the coding environment, explicitly say:
"Production runtime logs are required to identify the exact exception."

Do NOT claim the root cause without the actual exception.

Also temporarily improve the existing `[TICKET_LOAD_FAILED]` logging so that the server logs the real internal error safely, including:

{
  orderId,
  errorName,
  errorMessage,
  stack,
  stage
}

Do NOT expose stack traces to the frontend.

Use explicit stage markers such as:

[TICKET_TRACE] order_lookup_start
[TICKET_TRACE] order_lookup_success
[TICKET_TRACE] authorization_start
[TICKET_TRACE] authorization_success
[TICKET_TRACE] ticket_view_start
[TICKET_TRACE] ticket_view_success
[TICKET_TRACE] ticket_lookup_failed

Then reproduce GET /api/orders/75 and determine the EXACT stage where it fails.

Only after identifying the real exception should you propose a code fix.

Final response must contain:

1. EXACT ROOT CAUSE
2. EXACT FILE + LINE
3. EXACT FAILING OPERATION
4. WHY Order 75 triggers it
5. MINIMAL FIX
6. WHETHER THE CURRENT defensive normalizeEmail changes should remain or be reverted
7. WHETHER production redeployment is required
8. A precise verification test for `/api/orders/75`

Do not say "most likely", "probably", or "appears to be" as the final root cause.