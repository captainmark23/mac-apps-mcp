# Contributing

## Testing

This project is macOS-native. Some modules include integration tests that call real macOS APIs (JXA / `osascript`) and require a GUI session with the relevant app running (Notes, Calendar, etc.).

**Before submitting a PR, run the full test suite locally on macOS:**

```bash
npm test
```

### CI vs local tests

Integration tests that require a macOS GUI session are skipped on CI (`process.env.CI`). Only unit tests and pure-function tests run in GitHub Actions.

If you add integration tests for a new module, guard them with:

```typescript
const isCI = !!process.env.CI;
describe("integration tests", { skip: isCI }, () => {
  // ...
});
```

This ensures CI stays green while real integration coverage is validated locally.
