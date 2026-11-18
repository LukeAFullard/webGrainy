/** Photo list summary ("8 photos · 6 analysed · 2 not calibrated · 1 failed") and filters. */
import type { PhotoRecord } from '../modules/projectStorage.js';
import type { AppState } from './state.js';

export type PhotoFilter = 'all' | 'analysed' | 'pending' | 'uncalibrated' | 'failed' | 'excluded';

type PhotoStatus = 'pending' | 'running' | 'done' | 'error';

export function photoMatchesFilter(photo: PhotoRecord, status: PhotoStatus | undefined, filter: PhotoFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'analysed':
      return status === 'done';
    case 'pending':
      return status === undefined || status === 'pending' || status === 'running';
    case 'uncalibrated':
      return !photo.calibration;
    case 'failed':
      return status === 'error';
    case 'excluded':
      return !photo.included;
  }
}

export interface PhotoSummaryPart {
  filter: PhotoFilter;
  count: number;
  label: string;
}

/** The non-empty parts of the summary line, each of which filters the list when clicked. */
export function photoSummary(state: Pick<AppState, 'photos' | 'photoStatuses'>): PhotoSummaryPart[] {
  const count = (f: PhotoFilter): number =>
    state.photos.filter((p) => photoMatchesFilter(p, state.photoStatuses.get(p.photoId), f)).length;
  const parts: PhotoSummaryPart[] = [
    { filter: 'all', count: state.photos.length, label: `${state.photos.length} photo${state.photos.length === 1 ? '' : 's'}` },
    { filter: 'analysed', count: count('analysed'), label: `${count('analysed')} analysed` },
    { filter: 'pending', count: count('pending'), label: `${count('pending')} not analysed` },
    { filter: 'uncalibrated', count: count('uncalibrated'), label: `${count('uncalibrated')} not calibrated` },
    { filter: 'failed', count: count('failed'), label: `${count('failed')} failed` },
    { filter: 'excluded', count: count('excluded'), label: `${count('excluded')} left out of the site` },
  ];
  return parts.filter((p) => p.filter === 'all' || p.count > 0);
}

export function visiblePhotos(state: Pick<AppState, 'photos' | 'photoStatuses' | 'photoFilter'>): PhotoRecord[] {
  return state.photos.filter((p) => photoMatchesFilter(p, state.photoStatuses.get(p.photoId), state.photoFilter));
}
