import { EMAIL_MAX_LENGTH, PASSWORD_MIN_LENGTH, type LoginRequest } from '@finance/contracts';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState, type SyntheticEvent } from 'react';

import { login } from '../api/endpoints';
import { errorMessageOf } from '../api/errors';
import { ROUTE_PATHS } from './paths';

/**
 * Screen 1 of 2 (FR11): the login form.
 *
 * Failure handling is the point of case 37 — wrong credentials must render a
 * visible message. The submit handler hands the promise to TanStack Query's
 * `mutate`, which captures rejection in `mutation.error`; nothing floats, so
 * there is no unhandled rejection and no blank screen.
 */

const EMPTY_FIELD = '';
const SIGN_IN_LABEL = 'Sign in';
const SIGNING_IN_LABEL = 'Signing in…';
const GENERIC_FAILURE_MESSAGE = 'Sign in failed. Please try again.';

/** Styles shared by both inputs. */
const INPUT_CLASS =
  'w-full rounded-md border border-muted/40 bg-panel px-3 py-2 outline-none focus:border-brand';

export function LoginPage() {
  const navigate = useNavigate();
  const emailFieldId = useId();
  const passwordFieldId = useId();
  const [email, setEmail] = useState(EMPTY_FIELD);
  const [password, setPassword] = useState(EMPTY_FIELD);

  const signIn = useMutation({
    mutationFn: (credentials: LoginRequest) => login(credentials),
    onSuccess: () => {
      void navigate({ to: ROUTE_PATHS.ME });
    },
  });

  function handleSubmit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>): void {
    event.preventDefault();
    signIn.mutate({ email, password });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full max-w-sm space-y-4 rounded-xl bg-panel p-8 shadow-sm"
    >
      <h1 className="text-xl font-semibold">Sign in</h1>

      <div className="space-y-1">
        <label htmlFor={emailFieldId} className="block text-sm text-muted">
          Email
        </label>
        <input
          id={emailFieldId}
          name="email"
          type="email"
          autoComplete="username"
          required
          maxLength={EMAIL_MAX_LENGTH}
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          className={INPUT_CLASS}
        />
      </div>

      <div className="space-y-1">
        <label htmlFor={passwordFieldId} className="block text-sm text-muted">
          Password
        </label>
        <input
          id={passwordFieldId}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
          className={INPUT_CLASS}
        />
      </div>

      {signIn.isError ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {errorMessageOf(signIn.error, GENERIC_FAILURE_MESSAGE)}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={signIn.isPending}
        className="w-full rounded-md bg-brand px-3 py-2 font-medium text-white hover:bg-brand-strong disabled:opacity-60"
      >
        {signIn.isPending ? SIGNING_IN_LABEL : SIGN_IN_LABEL}
      </button>
    </form>
  );
}
