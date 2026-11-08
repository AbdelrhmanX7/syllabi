import { LegalPage } from '~/sections/LegalPage';

export default function Terms() {
  return (
    <LegalPage title='Terms of use' updated='7 November 2026'>
      <p>
        Syllabi is free, open-source software under the MIT license. These terms cover the hosted service at
        app.syllabi.studio.
      </p>
      <ul>
        <li>Use it for your own studying. Don&apos;t abuse the service, attack it or upload material you have no right to share.</li>
        <li>You own what you create and upload. We only store and process it to run the service for you.</li>
        <li>AI answers can be wrong. Check anything important.</li>
        <li>
          The service is provided as is, without warranty. We may change or stop it; you can always self-host your own
          server from the source code.
        </li>
        <li>We may suspend accounts that break these terms.</li>
      </ul>
      <p>
        How we handle your data is described in the <a href='/privacy/'>privacy policy</a>.
      </p>
    </LegalPage>
  );
}
