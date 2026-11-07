import { Brand } from './Brand';
import { GitHubStars } from './github/GitHubStars';
import { GITHUB_URL } from './github/github-stars';
import { WorkspaceDemo } from './demo/WorkspaceDemo';
import { TaskDetails } from './details/TaskDetails';
import { AccountStory } from './accounts/AccountStory';
import { SelfHosting } from './install/SelfHosting';

export function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        skip to content
      </a>
      <div className="site-header-field brand-field">
        <header className="site-header container">
          <a className="brand-link" href="#" aria-label="lanes home">
            <Brand />
          </a>
          <GitHubStars />
        </header>
      </div>
      <main id="main">
        <section className="hero brand-field" aria-labelledby="hero-title">
          <div className="hero__intro container">
            <h1 id="hero-title">
              <span>google tasks.</span>
              <span>a little more room.</span>
            </h1>
            <div className="hero__summary">
              <p className="hero__description">a self-hosted workspace for your google tasks</p>
              <a className="button button--primary" href="#self-host">
                make it yours
              </a>
            </div>
          </div>
          <div
            className="workspace-section container"
            id="workspace"
            aria-label="explore the lanes workspace"
          >
            <h2 className="visually-hidden">explore the workspace</h2>
            <WorkspaceDemo />
          </div>
        </section>
        <TaskDetails />
        <AccountStory />
        <SelfHosting />
      </main>
      <footer className="site-footer container">
        <a className="brand-link" href="#" aria-label="lanes home">
          <Brand />
        </a>
        <a className="site-footer__credit" href="https://fatihguzel.dev">
          made by fatih güzel.
        </a>
        <a className="site-footer__source" href={GITHUB_URL}>
          source on github
        </a>
      </footer>
    </>
  );
}
