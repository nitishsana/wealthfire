// 'Test user: <name> · Switch user' above the app, only for a localkyc test user (?persona=).
import { LOCAL_HOME_URL, personaBarText, SWITCH_USER_TEXT } from '@wealthfire/core';
import { testPersona } from '../localTest';

export function TestUserBar() {
  if (!testPersona) return null;
  return (
    <div className="test-user-bar" role="region" aria-label="Local test user">
      <span>{personaBarText(testPersona)}</span>
      <span aria-hidden="true"> · </span>
      <a href={LOCAL_HOME_URL}>{SWITCH_USER_TEXT}</a>
    </div>
  );
}
