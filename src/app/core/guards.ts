import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Auth } from './auth';
import type { Permission } from './models';

/** Requires a signed-in session. Remembers the requested URL so the user returns to it after sign-in. */
export const authGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(Auth);
  const router = inject(Router);
  const user = await auth.load();
  if (user) return true;
  return router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } });
};

/** Route-level permission check, used for navigation only. The API is the actual enforcement point. */
export const permissionGuard = (...required: Permission[]): CanActivateFn => async () => {
  const auth = inject(Auth);
  const router = inject(Router);
  await auth.load();
  return required.every((p) => auth.has(p)) ? true : router.createUrlTree(['/dashboard']);
};

/** Keeps signed-in users out of the sign-in pages. */
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(Auth);
  const router = inject(Router);
  const user = await auth.load();
  return user ? router.createUrlTree(['/dashboard']) : true;
};
