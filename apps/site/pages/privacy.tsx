import { LegalPage } from '~/sections/LegalPage';

const REPO = 'https://github.com/AbdelrhmanX7/syllabi';

export default function Privacy() {
  return (
    <LegalPage path='/privacy/' title='Privacy policy' updated='7 November 2026'>
      <p>
        This policy covers the hosted Syllabi service at app.syllabi.studio and api.syllabi.studio. If you run your own
        Syllabi server, your data stays on that server and this policy does not apply to it.
      </p>
      <h2>What we store</h2>
      <ul>
        <li>Your account: name, email address, a hashed password (if you set one) and how you sign in.</li>
        <li>
          If you sign in with Google: your Google account&apos;s name, email address and account id. We ask Google for
          nothing else and never see your Google password.
        </li>
        <li>Your study data: classes, notebooks and ink, questions, flashcards, lectures, concept maps and files you upload.</li>
      </ul>
      <h2>How we use it</h2>
      <ul>
        <li>To run the app: sign you in and sync your data between your devices.</li>
        <li>To send account emails: verification, sign-in links and password resets.</li>
        <li>
          AI features send the text or images you ask about to an AI model provider to produce the answer. Nothing is
          sent until you use an AI feature.
        </li>
        <li>
          To count how many people download and use the app: the app sends a random number once a day when it opens,
          and the download button counts a press. No name, email or account is attached to these counts.
        </li>
      </ul>
      <p>We do not sell your data, show ads or use your data to track you across other sites.</p>
      <h2>Where it lives</h2>
      <p>
        Data is stored on our own server. Account emails are sent through an email delivery provider. Both only
        process data to provide the service.
      </p>
      <h2>Your choices</h2>
      <p>
        You can change or delete your data in the app, and delete your account in Settings → Account. Deleting your
        account removes your account, your study data and your files from the server.
      </p>
      <h2>Contact</h2>
      <p>
        Questions about privacy: open an issue at <a href={`${REPO}/issues`}>github.com/AbdelrhmanX7/syllabi</a>, or
        report something sensitive privately as described in <a href={`${REPO}/blob/master/SECURITY.md`}>SECURITY.md</a>.
      </p>
    </LegalPage>
  );
}
