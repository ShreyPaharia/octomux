// Barrel: UniversalSidebar was decomposed into `./sidebar/*` (SHR-182). This
// file preserves the original import path + named exports for App.tsx and the
// existing integration test, which stay byte-unchanged.
export { UniversalSidebar } from './sidebar/universal-sidebar';
export { forkDisabledReason } from './sidebar/nav-items';
export { useConnectionStatus, type ConnectionStatus } from './sidebar/footer';
