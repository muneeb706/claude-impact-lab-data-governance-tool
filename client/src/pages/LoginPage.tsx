import { useState, type FormEvent } from 'react';
import { MIN_PASSWORD_LENGTH, type Manager } from '../../../shared/types';
import { api, ApiRequestError, errorMessage } from '../api';
import { useAuth } from '../auth';
import { ErrorBanner, Field } from '../components/ui';

type FormError = { message: string; field?: string } | null;

const toFormError = (err: unknown): FormError => ({
  message: errorMessage(err),
  field: err instanceof ApiRequestError ? err.field : undefined,
});

export default function LoginPage({ needsSetup }: { needsSetup: boolean }) {
  return (
    <div className="auth-screen">
      <div className="auth-card card">
        <div className="brand auth-brand">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <div>
            <div className="brand-name">Data Governance</div>
            <div className="brand-sub">Account manager console</div>
          </div>
        </div>
        {needsSetup ? <SetupForm /> : <SignInForm />}
      </div>
    </div>
  );
}

function SignInForm() {
  const { signedIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<FormError>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      signedIn(await api.post<Manager>('/auth/login', { email, password }));
    } catch (err) {
      setError(toFormError(err));
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" onSubmit={submit}>
      <h1>Sign in</h1>
      <Field label="Email">
        <input type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
      </Field>
      <Field label="Password">
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
      </Field>
      <ErrorBanner message={error?.message} />
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="muted auth-footnote">Forgot your password? Ask another account manager to reset it.</p>
    </form>
  );
}

function SetupForm() {
  const { signedIn, refresh } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<FormError>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirm) return setError({ message: 'Passwords do not match', field: 'confirm' });
    setBusy(true);
    setError(null);
    try {
      signedIn(await api.post<Manager>('/auth/setup', { name, email, password }));
    } catch (err) {
      // Someone else finished setup first: show the sign-in form instead.
      if (err instanceof ApiRequestError && err.status === 409) return void refresh();
      setError(toFormError(err));
      setBusy(false);
    }
  }

  const fieldError = (field: string) => (error?.field === field ? error.message : null);

  return (
    <form className="auth-form" onSubmit={submit}>
      <h1>Set up the console</h1>
      <p className="muted">
        Create the first account manager. Once you are signed in you can add other managers. Every change is recorded
        under the name of the manager who made it.
      </p>
      <Field label="Your name" error={fieldError('name')}>
        <input autoComplete="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
      </Field>
      <Field label="Email" error={fieldError('email')}>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
      </Field>
      <Field label="Password" hint={`At least ${MIN_PASSWORD_LENGTH} characters`} error={fieldError('password')}>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={MIN_PASSWORD_LENGTH}
        />
      </Field>
      <Field label="Confirm password" error={fieldError('confirm')}>
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </Field>
      {error && !['name', 'email', 'password', 'confirm'].includes(error.field ?? '') && <ErrorBanner message={error.message} />}
      <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
        {busy ? 'Creating…' : 'Create account manager'}
      </button>
    </form>
  );
}
