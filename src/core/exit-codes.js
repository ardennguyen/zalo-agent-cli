/** Exit codes a long-running command ends with when it must not be restarted blindly. */
export const EXIT_CODE = Object.freeze({
    /** Another session took the account. A supervisor must not restart this on its own. */
    KICKED: 3,
    /** The saved login was refused and logging in again did not help. */
    SESSION_REVOKED: 4,
});
