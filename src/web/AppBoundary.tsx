import { Component, type ReactNode } from 'react';
import { Brand } from '../ui/Brand';
import './App.css';

/** A failed client module or render must leave a usable route back into the workspace. */
export class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="entry">
        <div className="entry-brand">
          <Brand />
        </div>
        <section className="entry-paper" aria-labelledby="app-recovery-title">
          <h1 id="app-recovery-title">let’s open your workspace again.</h1>
          <p>
            this screen could not load. reload lanes, then check operations before retrying an
            interrupted change.
          </p>
          <button className="entry-primary" onClick={() => window.location.reload()}>
            reload lanes
          </button>
        </section>
      </main>
    );
  }
}
