import './TaskDetails.css';

export function TaskDetails() {
  return (
    <section className="details-section container" aria-labelledby="details-title">
      <div className="details-copy">
        <h2 id="details-title">A task is rarely just a title.</h2>
        <p>Keep the details with your Google Tasks.</p>
        <dl>
          <div>
            <dt>Plan it</dt>
            <dd>Dates and repeat rules.</dd>
          </div>
          <div>
            <dt>Find it</dt>
            <dd>Search and filters.</dd>
          </div>
        </dl>
      </div>
      <figure className="details-figure">
        <article className="details-sample" aria-label="Sample Lanes task details">
          <p className="details-sample__context">Side project</p>
          <h3>Build the website</h3>
          <p className="details-sample__note">For the side project.</p>
          <div className="details-sample__properties">
            <span className="details-sample__label">Website</span>
            <span>Medium priority</span>
          </div>
          <fieldset className="details-checklist">
            <legend>Subtasks</legend>
            {['Write copy', 'Build demo', 'Finishing touches'].map((title, index) => (
              <label className="details-check" key={title}>
                <input type="checkbox" defaultChecked={index === 0} />
                <span className="details-check__box" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="m3.5 8 3 3 6-6" />
                  </svg>
                </span>
                <span>{title}</span>
              </label>
            ))}
          </fieldset>
          <div className="details-sample__planning">
            <span>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <rect x="3" y="5" width="18" height="16" rx="2" />
                <path d="M8 3v4m8-4v4M3 11h18" />
              </svg>
              Thu, Nov 12 <span className="details-sample__time">10:00</span>
            </span>
            <span>
              <svg
                aria-hidden="true"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="m17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3" />
              </svg>
              Every week
            </span>
          </div>
        </article>
        <figcaption>Sample task.</figcaption>
      </figure>
    </section>
  );
}
