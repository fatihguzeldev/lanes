import { useState } from 'react';
import './AccountStory.css';

const accounts = {
  personal: {
    name: 'personal',
    tasks: [
      ['find a trail for saturday', 'weekend plans'],
      ['book a table for two', 'weekend plans'],
      ['pick up the library books', 'life admin'],
      ['plan the week over coffee', 'life admin'],
    ],
  },
  work: {
    name: 'work',
    tasks: [
      ['polish the welcome screen', 'product launch'],
      ['write the launch notes', 'product launch'],
      ['follow up on feedback', 'notes to follow up'],
      ['review the next small thing', 'notes to follow up'],
    ],
  },
} as const;

export function AccountStory() {
  const [selected, setSelected] = useState<keyof typeof accounts>('personal');
  const account = accounts[selected];

  return (
    <section className="account-story container" aria-labelledby="accounts-title">
      <div className="account-story__intro">
        <h2 id="accounts-title">each account in its own lane.</h2>
        <p>switch between your google accounts. keep their tasks and organization separate.</p>
      </div>
      <div className="account-story__workspace">
        <div className="account-story__switcher" role="group" aria-label="sample accounts">
          {(['personal', 'work'] as const).map((key) => (
            <button
              key={key}
              type="button"
              className="account-story__account"
              aria-pressed={selected === key}
              onClick={() => setSelected(key)}
            >
              <span className="account-story__avatar" aria-hidden="true">
                {accounts[key].name[0]}
              </span>
              <span>
                <strong>{accounts[key].name}</strong>
              </span>
              <span className="account-story__selection" aria-hidden="true">
                {selected === key ? 'selected' : 'switch account'}
              </span>
            </button>
          ))}
        </div>
        <div className="account-story__lists" aria-live="polite" aria-atomic="true">
          <ul key={selected} aria-label={`${account.name} sample tasks`}>
            {account.tasks.map(([title, list]) => (
              <li key={title}>
                <span className="account-story__circle" aria-hidden="true" />
                <span>{title}</span>
                <span className="account-story__list-name">{list}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <p className="account-story__caption">sample accounts.</p>
    </section>
  );
}
