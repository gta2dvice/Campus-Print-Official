# Canonical Ticket Retrieval and Authorization Architecture

## Problem Statement
There is a discrepancy between how orders are found in history and how they are authorized for retrieval. Specifically, legacy orders where `guest_email` and `customer_email` are NULL but `user_id` is present are found by `Order.getOrdersByVerifiedEmail` (via join on `users`) but are denied by `isAuthorizedForOrder` if the user is only in a recovery session (not fully logged in).

## Proposed Architecture

### 1. Canonical Ownership Logic: `canAccessOrder`
We will introduce a pure logic function that defines ownership.

**Signature**: `canAccessOrder(identity, order)`
- `identity`: `{ sessionEmail?: string, sessionUserId?: number }`
- `order`: Order record (including `customer_email` from the join).

**Logic**:
An identity can access an order if:
1. **Direct Email Match**: `identity.sessionEmail` matches `order.guest_email` or `order.customer_email`.
2. **Identity Mapping**: `identity.sessionEmail` belongs to a user whose `userId` matches `order.user_id`.
3. **Authenticated Match**: `identity.sessionUserId` matches `order.user_id`.

### 2. Canonical Resolver: `resolveTicketAccess`
A higher-level function used by routes to determine if a request is authorized.

**Signature**: `async resolveTicketAccess(req, order)`
**Flow**:
1. **Token Check**: If `x-ticket-token` or `?token=` is present and valid for the order, return `AUTHORIZED`.
2. **Identity Construction**: 
   - `sessionEmail` = `activeRecoveryEmail(req)`
   - `sessionUserId` = `req.session?.userId`
3. **Ownership Check**: Call `canAccessOrder({ sessionEmail, sessionUserId }, order)`.
4. **Result**: Return `AUTHORIZED` or throw a structured `AuthorizationError`.

### 3. Unified History Query
Update `Order.getOrdersByVerifiedEmail` to ensure the set of orders it returns is exactly the set that `canAccessOrder` would authorize for a `sessionEmail`.

The current query already joins `users`, which effectively implements the "Identity Mapping" rule. We will ensure the logic remains consistent.

## Implementation Plan

### Step 1: Create Ownership Utility
Create `server/services/authService.js` (or add to `recoveryAuth.js`) to house `canAccessOrder`.

### Step 2: Update `recoveryAuth.js`
- Replace `isAuthorizedForOrder` with a call to `resolveTicketAccess`.
- Implement `resolveTicketAccess` utilizing the new ownership rules.

### Step 3: Refactor `server/routes/orders.js`
- Update `GET /api/orders/:id`, `POST /api/orders/:id/retry-email`, and `GET /api/orders/:id/payment-status` to use the new resolver.
- Replace generic 404s with structured error responses.

### Step 4: Structured Error Format
Instead of generic 404s, use:
```json
{
  "message": "...",
  "code": "NOT_AUTHORIZED" | "ORDER_NOT_FOUND" | "SESSION_EXPIRED"
}
```

## Legacy Case Trace
**Scenario**: Order has `guest_email = NULL`, `customer_email = NULL`, `user_id = 123`. User has verified email `student@example.com` via OTP (Recovery Session).

1. `Order.getOrdersByVerifiedEmail('student@example.com')`:
   - Joins `orders` with `users` where `users.email = 'student@example.com'`.
   - Finds User 123 $\rightarrow$ Finds Order.
   - **Result**: Order appears in history. ✅

2. `GET /api/orders/:id`:
   - `resolveTicketAccess(req, order)` is called.
   - `identity` = `{ sessionEmail: 'student@example.com', sessionUserId: undefined }`.
   - `canAccessOrder`:
     - Email Match: `student@example.com` vs `NULL`/`NULL` $\rightarrow$ Fail.
     - Identity Mapping: `student@example.com` $\rightarrow$ `userId: 123`. `123` matches `order.user_id` (123) $\rightarrow$ **Success**. ✅
   - **Result**: Authorized. ✅

## Critical Files for Implementation
- `server/middleware/recoveryAuth.js`
- `server/routes/orders.js`
- `server/models/Order.js`
EOF`
