import { Route, Routes } from "react-router";

import { PORTAL_NAME } from "./app-meta";

function BootstrapHome() {
  return (
    <main className="shell">
      <p className="eyebrow">Phase 0</p>
      <h1>{PORTAL_NAME}</h1>
      <p>Minimal portal shell. Product surfaces remain intentionally deferred.</p>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="*" element={<BootstrapHome />} />
    </Routes>
  );
}
