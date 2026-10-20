import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface FieldError {
  field: string;
  message: string;
}

/** Error shape shared by every failed API call, mapped from the server's { error: { code, message, details } }. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: FieldError[] = [],
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Params = Record<string, string | number | boolean | null | undefined>;

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof HttpErrorResponse) {
    const body = err.error?.error as { code?: string; message?: string; details?: unknown } | undefined;
    if (err.status === 0) {
      return new ApiError(0, 'NETWORK', 'Cannot reach the server. Check your connection and try again.');
    }
    const details = body?.details;
    const fields = Array.isArray(details) ? (details as FieldError[]).filter((d) => d && typeof d.field === 'string') : [];
    return new ApiError(err.status, body?.code ?? 'UNKNOWN', body?.message ?? 'Something went wrong. Please try again.', fields, details ?? null);
  }
  return new ApiError(0, 'UNKNOWN', 'Something went wrong. Please try again.');
}

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);
  private readonly base = '/api';

  get<T>(path: string, params?: Params): Promise<T> {
    return this.send<T>('GET', path, undefined, params);
  }
  post<T>(path: string, body?: unknown): Promise<T> {
    return this.send<T>('POST', path, body ?? {});
  }
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>('PATCH', path, body);
  }
  put<T>(path: string, body: unknown): Promise<T> {
    return this.send<T>('PUT', path, body);
  }
  delete<T = void>(path: string): Promise<T> {
    return this.send<T>('DELETE', path);
  }

  /** Fetches a text file (CSV export). The browser's session cookie is sent automatically. */
  async downloadText(path: string, params?: Params): Promise<string> {
    try {
      return await firstValueFrom(this.http.get(`${this.base}${path}`, { params: toHttpParams(params), responseType: 'text' }));
    } catch (err) {
      throw toApiError(err);
    }
  }

  private async send<T>(method: string, path: string, body?: unknown, params?: Params): Promise<T> {
    try {
      return await firstValueFrom(
        this.http.request<T>(method, `${this.base}${path}`, { body, params: toHttpParams(params) }),
      );
    } catch (err) {
      throw toApiError(err);
    }
  }
}

function toHttpParams(params?: Params): HttpParams | undefined {
  if (!params) return undefined;
  let httpParams = new HttpParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue;
    httpParams = httpParams.set(key, String(value));
  }
  return httpParams;
}
