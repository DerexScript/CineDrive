import type { ApiErrorResponse } from '@cinedrive/shared';
import { t } from '../i18n';

/**
 * A thin `fetch` wrapper standing in for axios, which was 11% of the initial
 * JavaScript bundle for a feature set this app never used: no interceptors or
 * transforms, just JSON in, JSON out, cookies, timeouts and request cancellation.
 *
 * The `{ data }` return shape is deliberate, so every call site and the
 * `vi.spyOn(apiClient, 'get')` in the tests stay unchanged.
 */

const baseURL = import.meta.env.VITE_API_URL || '/api';

/** Matches the timeout axios was configured with. */
const REQUEST_TIMEOUT_MS = 15_000;

export class ApiRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiErrorResponse | null,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

type ApiErrorCopyKey = keyof typeof t.errors.api;

const API_ERROR_CODE_MESSAGES: Record<string, ApiErrorCopyKey> = {
  INTERNAL_SERVER_ERROR: 'server',
  VALIDATION_ERROR: 'validation',
  BAD_REQUEST: 'validation',
  INVALID_NUMERIC_VALUES: 'validation',
  INVALID_EPISODE: 'validation',
  INVALID_AUDIO_TRACK: 'validation',
  INVALID_HLS_START: 'validation',
  INVALID_HLS_SESSION: 'validation',
  UNAUTHORIZED: 'unauthenticated',
  GOOGLE_AUTH_REQUIRED: 'unauthenticated',
  FORBIDDEN: 'forbidden',
  ADMIN_REQUIRED: 'forbidden',
  LIBRARY_OWNER_REQUIRED: 'forbidden',
  INVALID_CREDENTIALS: 'invalidCredentials',
  ACCOUNT_DISABLED: 'accountDisabled',
  MULTI_USER_DISABLED: 'multiUserDisabled',
  INVALID_CURRENT_PASSWORD: 'invalidCurrentPassword',
  EMAIL_IN_USE: 'emailInUse',
  LOCAL_FOLDER_UNAVAILABLE: 'localFolderUnavailable',
  GOOGLE_CONNECTION_NOT_FOUND: 'googleAccountMissing',
  GOOGLE_ACCOUNT_NOT_CONNECTED: 'googleAccountMissing',
  LIBRARY_NOT_FOUND: 'libraryNotFound',
  LIBRARY_CREATE_FAILED: 'libraryCreateFailed',
  SCAN_ALREADY_IN_PROGRESS: 'scanInProgress',
  LIBRARY_OPERATION_IN_PROGRESS: 'scanInProgress',
  LOCAL_SCAN_FAILED: 'scanFailed',
  SCAN_FAILED: 'scanFailed',
  MEDIA_ANALYSIS_IN_PROGRESS: 'mediaAnalysisInProgress',
  MEDIA_ANALYSIS_FAILED: 'mediaAnalysisFailed',
  AUDIO_TRACK_NOT_FOUND: 'audioTrackNotFound',
  AUDIO_TRACK_DISCOVERY_FAILED: 'audioTracksUnavailable',
  AUDIO_TRACK_SELECTION_FAILED: 'audioTracksUnavailable',
  HLS_PREPARATION_FAILED: 'hlsPreparationFailed',
  HLS_PREPARATION_SUPERSEDED: 'conflict',
  PREVIEW_BUSY: 'conflict',
  SUBTITLE_NOT_FOUND: 'subtitleUnavailable',
  NO_SUBTITLE_FOUND: 'subtitleUnavailable',
  OPENSUBTITLES_DOWNLOAD_ERROR: 'subtitleUnavailable',
  CONNECT_POLL_LIMIT: 'rateLimited',
  STUDIO_ERROR: 'server',
  CLIENT_ABORTED: 'requestCancelled',
  MUSIC_AI_UNAVAILABLE: 'musicAiUnavailable',
  REFINEMENT_ERROR: 'musicAiUnavailable',
  INSUFFICIENT_METADATA: 'metadataInsufficient',
  LISTEN_THRESHOLD_NOT_MET: 'listenThresholdNotMet',
  TRANSLATION_UNAVAILABLE: 'translationUnavailable',
  DEVICE_CONTROL_DISABLED: 'deviceControlDisabled',
  DEVICE_OFFLINE: 'deviceOffline',
  SOURCE_NOT_PLAYING: 'playbackStateChanged',
  PLAYBACK_ITEM_CHANGED: 'playbackStateChanged',
  INVALID_CURRENT_QUEUE_ITEM: 'playbackStateChanged',
  CONDITIONAL_SEEK_UNSUPPORTED: 'seekUnsupported',
  LOCAL_FILE_REQUIRED: 'localFileRequired',
  UPSTREAM_STREAM_ERROR: 'streamInterrupted',
  RANGE_NOT_SUPPORTED: 'mediaRangeUnsupported',
  MULTI_RANGE_NOT_SUPPORTED: 'mediaRangeUnsupported',
  RANGE_NOT_SATISFIABLE: 'mediaRangeUnsupported',
  MUSIC_TRANSFER_CAPACITY_REACHED: 'capacityReached',
  TRANSCODE_CAPACITY_REACHED: 'capacityReached',
  LIBRARY_DELETE_NOT_ALLOWED: 'forbidden',
  OWNER_MEMBERSHIP_IMMUTABLE: 'conflict',
  COMMAND_ID_CONFLICT: 'conflict',
  INVALID_PLAYBACK_CLIENT: 'validation',
  INVALID_PLAYBACK_COMMAND: 'validation',
  INVALID_COMMAND_ACK: 'validation',
  INVALID_QUEUE_ORDER: 'validation',
  INVALID_PLAYLIST_ORDER: 'validation',
  INVALID_CONNECT_HEARTBEAT: 'validation',
  INVALID_SYNC_CURSOR: 'validation',
  INVALID_DOWNLOAD_FORMAT: 'validation',
  INVALID_MEDIA_TYPE: 'validation',
  INVALID_TRANSFER_SOURCE: 'validation',
  INVALID_TRANSCODE_SESSION: 'validation',
  INVALID_TRANSCODE_START: 'validation',
  INVALID_TRANSCODE_QUALITY: 'validation',
  INVALID_PREVIEW_TIME: 'validation',
  DURATION_REQUIRED: 'validation',
  LISTEN_SESSION: 'validation',
  FILE_TOO_LARGE: 'tooLarge',
  SUBTITLE_FILE_TOO_LARGE: 'tooLarge',
  REVISION_CONFLICT: 'conflict',
  PLAYBACK_REVISION_CONFLICT: 'conflict',
  COMMAND_ACK_CONFLICT: 'conflict',
  EMAIL_ALREADY_IN_USE: 'emailInUse',
};

const API_ERROR_STATUS_MESSAGES: Partial<Record<number, ApiErrorCopyKey>> = {
  400: 'validation',
  401: 'unauthenticated',
  403: 'forbidden',
  404: 'notFound',
  409: 'conflict',
  413: 'tooLarge',
  429: 'rateLimited',
};

const getApiErrorCopyKey = (code: string, status: number): ApiErrorCopyKey => {
  const normalizedCode = code.trim().toUpperCase();
  const knownKey = API_ERROR_CODE_MESSAGES[normalizedCode];
  if (knownKey) return knownKey;
  if (normalizedCode.endsWith('_NOT_FOUND') || normalizedCode === 'NOT_FOUND') return 'notFound';
  if (normalizedCode.startsWith('INVALID_')) return 'validation';
  if (normalizedCode.endsWith('_CONFLICT')) return 'conflict';
  if (status >= 500) return 'server';
  return API_ERROR_STATUS_MESSAGES[status] ?? 'requestFailed';
};

export const hasSpecificApiErrorMessage = (code: string, status?: number) => {
  const normalizedCode = code.trim().toUpperCase();
  if (normalizedCode === 'INTERNAL_SERVER_ERROR' || normalizedCode === 'UNKNOWN_ERROR') return false;
  return (
    Object.prototype.hasOwnProperty.call(API_ERROR_CODE_MESSAGES, normalizedCode) ||
    normalizedCode.endsWith('_NOT_FOUND') ||
    normalizedCode === 'NOT_FOUND' ||
    normalizedCode.startsWith('INVALID_') ||
    normalizedCode.endsWith('_CONFLICT') ||
    (status !== undefined && API_ERROR_STATUS_MESSAGES[status] !== undefined)
  );
};

const getLocalizedApiErrorMessage = (code: string, status: number) => {
  const key = getApiErrorCopyKey(code, status);
  return key === 'requestFailed' ? t.errors.api.requestFailed(status) : t.errors.api[key];
};

/** A 204 and an empty error body both have to survive `JSON.parse`. */
const readBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface RequestConfig {
  params?: QueryParams;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Same rule axios applied: `undefined` and `null` values are left out. */
const buildQuery = (params?: QueryParams) => {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.append(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

const request = async <T>(
  method: string,
  path: string,
  body?: unknown,
  config?: RequestConfig,
): Promise<{ data: T }> => {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(config?.signal?.reason);
  if (config?.signal?.aborted) abortFromCaller();
  else config?.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Request timed out', 'TimeoutError')),
    config?.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`${baseURL}${path}${buildQuery(config?.params)}`, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const payload = await readBody(response);

    if (!response.ok) {
      const errorBody = (payload ?? null) as ApiErrorResponse | null;
      const code = errorBody?.error?.code || 'UNKNOWN_ERROR';
      throw new ApiRequestError(
        response.status,
        errorBody,
        getLocalizedApiErrorMessage(code, response.status),
      );
    }

    return { data: payload as T };
  } catch (error) {
    // Preserve TanStack Query cancellation, but translate our own timeout into
    // the normal API network error even when fetch rejects with TimeoutError.
    if (controller.signal.aborted) {
      if (config?.signal?.aborted) throw error;
      throw new ApiRequestError(0, null, t.errors.networkError);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    config?.signal?.removeEventListener('abort', abortFromCaller);
  }
};

export const apiClient = {
  get: <T = unknown>(path: string, config?: RequestConfig) =>
    request<T>('GET', path, undefined, config),
  post: <T = unknown>(path: string, body?: unknown, config?: RequestConfig) =>
    request<T>('POST', path, body, config),
  put: <T = unknown>(path: string, body?: unknown, config?: RequestConfig) =>
    request<T>('PUT', path, body, config),
  patch: <T = unknown>(path: string, body?: unknown, config?: RequestConfig) =>
    request<T>('PATCH', path, body, config),
  delete: <T = unknown>(path: string, config?: RequestConfig) =>
    request<T>('DELETE', path, undefined, config),
};

export interface FormattedApiError {
  code: string;
  message: string;
  requestId?: string;
  status: number;
}

export function parseApiError(error: unknown): FormattedApiError {
  if (error instanceof ApiRequestError) {
    const errorData = error.body?.error;
    const code = errorData?.code || 'UNKNOWN_ERROR';

    return {
      code,
      message:
        error.status === 0
          ? t.errors.networkError
          : getLocalizedApiErrorMessage(code, error.status || 500),
      requestId: errorData?.requestId,
      status: error.status,
    };
  }

  // Mutations already normalize errors before throwing them. Toasts and pages
  // can normalize again without replacing the server's message/code with a
  // generic error; accept only the complete, well-typed internal shape.
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const candidate = error as Partial<FormattedApiError>;
    if (
      typeof candidate.code === 'string' &&
      candidate.code.trim().length > 0 &&
      typeof candidate.message === 'string' &&
      candidate.message.trim().length > 0 &&
      typeof candidate.status === 'number' &&
      Number.isInteger(candidate.status) &&
      candidate.status >= 0 &&
      candidate.status <= 599 &&
      (candidate.requestId === undefined || typeof candidate.requestId === 'string')
    )
      return {
        code: candidate.code,
        message:
          candidate.status === 0
            ? t.errors.networkError
            : getLocalizedApiErrorMessage(candidate.code, candidate.status),
        status: candidate.status,
        ...(candidate.requestId === undefined ? {} : { requestId: candidate.requestId }),
      };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: error instanceof TypeError ? t.errors.networkError : t.errors.unexpected,
    status: 500,
  };
}
