export function parseUtcDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value;

  const raw = String(value).trim();
  const hasTimezone = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw);
  const timestamp = !hasTimezone && raw.includes(' ')
    ? `${raw.replace(' ', 'T')}Z`
    : !hasTimezone && raw.includes('T')
      ? `${raw}Z`
      : raw;
  return new Date(timestamp);
}

export function normalizeUtcTimestamp(value) {
  if (value == null || value === '') return null;
  const date = parseUtcDate(value);
  if (!date || Number.isNaN(date.getTime())) {
    throw new RangeError(`Horodatage de match invalide : ${value}`);
  }
  return date.toISOString();
}
