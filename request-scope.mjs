// Ignore stale replies after a new request, account change, or panel change.
// This is a UI privacy guard, not a substitute for server-side authorization.
export function createRequestScope() {
  let revision = 0;
  return {
    invalidate() { revision++; },
    begin() {
      const current = ++revision;
      return () => current === revision;
    },
    capture() {
      const current = revision;
      return () => current === revision;
    }
  };
}
