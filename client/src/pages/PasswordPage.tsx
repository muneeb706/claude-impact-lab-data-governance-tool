import { useState, type FormEvent } from 'react';
import { MIN_PASSWORD_LENGTH } from '../../../shared/types';
import { api, ApiRequestError, errorMessage } from '../api';
import { ErrorBanner, Field, PageHeader } from '../components/ui';

export default function PasswordPage() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (newPassword !== confirm) return setError({ message: 'Passwords do not match', field: 'confirm' });
    setSaving(true);
    setError(null);
    try {
      await api.post('/auth/password', { currentPassword, newPassword });
      setDone(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
    } catch (err) {
      setError({ message: errorMessage(err), field: err instanceof ApiRequestError ? err.field : undefined });
    } finally {
      setSaving(false);
    }
  }

  const fieldError = (field: string) => (error?.field === field ? error.message : null);

  return (
    <>
      <PageHeader title="Change password" description="Changing your password signs you out of every other browser." />
      {done && <div className="banner banner-success">Password changed. Your other sessions have been signed out.</div>}
      <form className="card form-card narrow" onSubmit={submit}>
        <Field label="Current password" error={fieldError('currentPassword')}>
          <input
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
          />
        </Field>
        <Field label="New password" hint={`At least ${MIN_PASSWORD_LENGTH} characters`} error={fieldError('newPassword')}>
          <input
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            minLength={MIN_PASSWORD_LENGTH}
          />
        </Field>
        <Field label="Confirm new password" error={fieldError('confirm')}>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </Field>
        {error && !['currentPassword', 'newPassword', 'confirm'].includes(error.field ?? '') && (
          <ErrorBanner message={error.message} />
        )}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Change password'}
          </button>
        </div>
      </form>
    </>
  );
}
