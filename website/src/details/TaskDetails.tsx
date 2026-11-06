import './TaskDetails.css';

export function TaskDetails() {
  return (
    <section className="details-section container" aria-labelledby="details-title">
      <div className="details-copy">
        <h2 id="details-title">a task is rarely just a title.</h2>
        <p>keep the details with your google tasks.</p>
        <dl>
          <div>
            <dt>plan it</dt>
            <dd>dates and repeat rules.</dd>
          </div>
          <div>
            <dt>find it</dt>
            <dd>search and filters.</dd>
          </div>
        </dl>
      </div>
      <figure className="details-figure">
        <article className="details-sample" aria-label="sample lanes task details">
          <p className="details-sample__context">side project</p>
          <h3>build the website</h3>
          <p className="details-sample__note">for the side project.</p>
          <div className="details-sample__properties">
            <span className="details-sample__label">website</span>
            <span>medium priority</span>
          </div>
          <fieldset className="details-checklist">
            <legend>subtasks</legend>
            {['write copy', 'build demo', 'finishing touches'].map((title, index) => (
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
              thu, nov 12 <span className="details-sample__time">10:00</span>
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
              every week
            </span>
          </div>
        </article>
        <figcaption>sample task.</figcaption>
      </figure>
    </section>
  );
}
