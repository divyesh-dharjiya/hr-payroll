import { HttpErrorResponse, HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { from, map } from 'rxjs';
import type { LocalApi } from '../local-api';

// Answers every `/api/...` request from the in-browser API (src/app/local-api), so the app runs without a server.
// The API code and its demo data load on the first request, in their own chunk, so the landing page stays light.
// Remove this interceptor to send the same requests to a real backend instead.

let instance: Promise<LocalApi> | null = null;

function localApi(): Promise<LocalApi> {
  instance ??= import('../local-api').then((m) => m.createBrowserApi());
  return instance;
}

export const localApiInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith('/api/')) return next(req);
  return from(localApi().then((api) => api.handle({ method: req.method, url: req.urlWithParams, body: req.body }))).pipe(
    map((res) => {
      if (res.status >= 400) {
        throw new HttpErrorResponse({ status: res.status, statusText: 'Error', error: res.body, url: req.url });
      }
      return new HttpResponse({ status: res.status, body: res.body, url: req.url });
    }),
  );
};
