 # Implementation Plan: Hardening Admin and Super Admin Security

## Goals
Hardening the administrative access of Campus Print to prevent session fixation, insecure logouts, and unauthorized concurrent access, while strengthening RLS and session configurations.

## 1. Hardened Sessions
### Changes to 
- **Secret Hardening**: Remove the fallback . The server should throw an error and fail to start if  is missing in production.
- **Cookie Security**:
    - Add .
    - Update .
    - Update .
- **Timeout**:
    - Change  to  (30 minutes).
    - Note:  handles the sliding window via  and  if the session is modified. To ensure a true sliding window for inactivity, we may need to touch the session in a middleware.

## 2. Concurrent Session Limit (Max 2)
### Database Schema ( or new migration)
Create a session registry table:
```sql
CREATE TABLE IF NOT EXISTS admin_sessions (
    sid VARCHAR PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revocation_status BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user ON admin_sessions(user_id);
```

### Logic Changes
- **Login Flow ( and )**:
    - **Session Regeneration**: Call  before setting session variables to prevent session fixation.
    - **Limit Check**: Before finalizing login, query  for the . If $\ge 2$ active sessions (where  is false) exist, block login with a  and a message about concurrent sessions.
    - **Registry Entry**: After successful regeneration and limit check, insert the new  into .
- **Logout Flow**:
    - Replace nullifying session variables with .
    - Add a DB call to mark the session as revoked in  or delete the row.
- **Middleware Guard ()**:
    - Update  and  to verify that the current  exists and is not revoked in the  table.

## 3. RLS Hardening
### SQL Migration
Provide a migration script to formally define policies for  and  roles on admin tables.
- Ensure , , , etc., have restrictive policies.
- Verify that the server-side role (which bypasses RLS) is the only one with full access to administrative tables.
- Example: 

## 4. Regression Testing
###  Updates
- **Session Fixation Test**: Verify that session ID changes after login.
- **Concurrent Limit Test**: Attempt to log in 3 times with the same account and verify the 3rd is blocked.
- **Timeout Test**: Mock session expiration and verify access is denied.
- **Role Isolation**: (Existing) Ensure  cannot access  routes.

## Step-by-Step Execution Sequence
1. **Database**: Create  table and apply RLS hardening.
2. **Server Config**: Update  for secrets and cookie security.
3. **Auth Logic**: 
    - Update Admin login/logout.
    - Update Super Admin login/logout.
4. **Middleware**: Implement session registry verification in .
5. **Testing**: Update and run .
